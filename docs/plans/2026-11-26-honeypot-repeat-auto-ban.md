# 蜜罐连续命中 → 自动封禁 30 天 + admin/ip-ban 溯源

> 触发背景：`/admin/account-risk` 的「账户风险与信号」里能看到 `HONEYPOT_HIT`（风险分 80、
> `kind=path_prefix`、`GET /api/v1/models`、`User-Agent: KimiBot/1.0`）这类事件，
> 但它们**只留痕、不处置**。owner 要求：同一 IP 在 **2 小时内连续命中 2 次**即自动封禁 **30 天**，
> 并在 `admin/ip-ban` 能看到「为什么被封」（判据 + 命中证据 + 管理操作）并支持手动解封。

## 一、被本次推翻的旧裁决

`docs/audit/10-10.md` RC-42 当时写明「**不自动封禁**（管理员工具与旧客户端可能误入 `/api/debug/*`）」，
`src/security/honeypot.ts` 的注释也是同一口径。本次 owner 明确要求自动处置，因此：

- 旧口径作废，新判据写进 `src/security/honeypot.ts` 与 `src/services/turnstile/honeypotBan.ts` 的注释；
- 误伤兜底不靠「不处置」，靠四件事：**阈值 ≥2 次**、**私网/回环地址永不自动封**、
  **只统计匿名命中**（`SecurityEvent.userId` 存在的命中不计入阈值：带令牌访问 `/api/debug/*`
  的管理员工具/旧客户端属「已知主体」，归账户风险处置）、
  **`/admin/ip-ban` 可溯源 + 一键解封**（`ipban.unban` 已有审计）；
- `RC-42` 担心的正是「管理员自己被封」，因此自动处置同时调用 `services/riskExemption.ts`
  的统一豁免判据（RC-44 的跨批次不变量：所有自动强制类风控只走同一个判据源）。

## 二、判据（唯一实现源）

| 项 | 值 | 常量 |
| --- | --- | --- |
| 统计窗口 | 2 小时 | `HONEYPOT_REPEAT_WINDOW_MS` |
| 命中阈值 | 2 次（含本次） | `HONEYPOT_REPEAT_THRESHOLD` |
| 封禁时长 | 30 天 | `HONEYPOT_BAN_DURATION_MINUTES` |
| 封禁来源 | `source: "auto"` | `ManualBanIpOptions.source` |
| 原因前缀 | `蜜罐连续命中` | `HONEYPOT_BAN_REASON_PREFIX` |
| 豁免 | 回环 / 私网 / 链路本地（`isLocalIP`） | — |
| 豁免 | 超管（`shouldExemptFromRiskControl(..., "honeypot")`，RC-44） | — |
| 计入范围 | 仅匿名命中（`userId: null`），已登录命中只留痕 | `buildHoneypotRepeatQuery` |
| 幂等 | 已有生效封禁（无论手工/自动）时不再改写 | — |

判据只看 `SecurityEvent`（`eventType: "HONEYPOT_HIT"` + `ipAddress` + `createdAt` + `userId: null`），
事件本身就是证据来源，因此「命中 → 封禁 → 溯源」三段用的是同一份数据，不会出现
「封了但说不清为什么」。

## 三、改动清单

| # | 文件 | 改动 |
| --- | --- | --- |
| 1 | `src/services/turnstile/constants.ts` | 新增窗口/阈值/时长/原因前缀常量；把封禁时长硬顶从 24h 提到 30 天（`MAX_BAN_DURATION_MINUTES`） |
| 2 | `src/services/turnstile/honeypotBan.ts`（新） | `evaluateHoneypotRepeatBan()`：非法/私网/超管豁免 → 统计窗口内**匿名**命中数 → 已有生效封禁则跳过 → `manualBanIp(..., source:"auto")` → 写 `ipban.autoHoneypotBan` 审计 |
| 2b | `src/services/turnstile/honeypotQuery.ts`（新） | 判据查询条件 `buildHoneypotRepeatQuery()`（唯一源）。独立成文件是因为 `honeypotBan` 依赖 `ipBan.manualBanIp`，而溯源又要复用同一过滤器，放一起会形成循环依赖 |
| 3 | `src/security/honeypot.ts` | 命中事件改为 `await` 落库（否则统计漏掉本次），随后调用 `evaluateHoneypotRepeatBan()`；失败只降级不 5xx |
| 4 | `src/services/turnstile/ipBan.ts` | `manualBanIp` 用新硬顶；新增 `getIpBanTrace()`（封禁记录 + 蜜罐判据实时复核（匿名/全部两个计数）+ 近 7 天事件 + 近 60 天管理操作） |
| 5 | `src/controllers/turnstile/statsHandlers.ts` | 新增 `traceBannedIp` 处理器（`GET /ip-ban-trace?ip=`，单 IP 校验） |
| 6 | `src/routes/turnstileRoutes.ts` | 挂 `GET /ip-ban-trace`（`adminLimiter` + `authenticateAdmin` + `requireAdminScope`，与 `ip-ban-list` 同口径：读权限不下放写权限） |
| 7 | `src/models/securityEventModel.ts` | 补 `{ ipAddress: 1, createdAt: -1 }` 复合索引（按 IP 溯源与窗口计数都靠它，否则全表扫） |
| 8 | `frontend/src/api/turnstile.ts` | `getIPBanTrace()` + 溯源响应类型 |
| 9 | `frontend/src/components/ip-ban/BanTraceModal.tsx`（新） | 溯源弹窗：判据、命中证据、管理操作、解封入口 |
| 10 | `frontend/src/components/ip-ban/BanListPanel.tsx` | 每行加「溯源」按钮，打开弹窗；解封后刷新列表 |
| 11 | `frontend/src/components/IPBanManager.tsx` | 手工封禁时长上限 1440 分钟 → 43200 分钟（30 天），文案同步 |
| 12 | 测试 | 后端 `src/tests/honeypotRepeatBan.test.ts`（判据/豁免/幂等/审计）+ `honeypotAndRegion.test.ts` 补桩 |

## 四、风险与取舍

1. **误伤**：`/api/v1/*`、`/api/debug/*` 已核实不承载真实业务（RC-42 核过），但管理员脚本/旧客户端
   仍可能误入。缓解 = 阈值 2 次 + 私网豁免 + 已登录命中不计入 + 溯源可见 + 一键解封 + 解封有审计。
   残留边界（已知并接受）：**不带令牌**从公网 IP 访问 `/api/debug/*` 的管理员脚本与扫描器不可区分，
   会被判进阈值 —— 兜底是从别的网络/直连数据库解封，封禁 30 天不等于永久。
2. **写放大**：蜜罐命中频率低；每次命中多 1 次 `create` + 1 次 `countDocuments`（走复合索引），
   可接受。Tarpit 的并发硬顶仍然生效，自动封禁不引入新的阻塞路径。
3. **Redis 同步**：自动封禁复用 `manualBanIp`，因此 Mongo + Redis + 内存缓存清理三处口径一致；
   Redis 不可用时按既有降级语义只写 Mongo。
4. **时长硬顶提高**：手工封禁上限从 24h 提到 30 天，属行为变更，已在 UI 文案与本文件登记。
5. **隐私**：不新增采集字段（沿用 `SecurityEvent` 既有字段）；溯源只回既有事件与审计记录。

## 五、验证

- CI：`type-check`、后端 Jest、前端 Vitest、治理闸门（文件行数 / 设计语言 / 隐私契约 / openapi 漂移）。
- 静态自检：新接口无 `@openapi`（与同文件其它 turnstile 端点一致，避免进入公开 spec）；
  新前端文件只用 `studioTheme` / `studioFeedback` 原语与 slate/sky/rose/emerald/amber 语义色。
