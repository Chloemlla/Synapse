# 十月十七日功能 → 管理端覆盖对照与实施计划（2026-11-22）

> 状态：**只读核查完成，尚未改动任何代码**。本文是后续实施的唯一清单，实施时按 §8 批次推进并回填状态。
>
> 依据：
> - `F:\Repositories\GitHub\verified-methodology.md`（先落盘清单，再按清单实施）
> - `docs/audit/2026-10-17-*.md` 共 14 份 + `docs/audit/audit-2026-10-17-doctool.md`
> - 其上游条目表 `docs/audit/10-10.md`（RC-xx 编号来源）
> - `docs/plans/2026-10-16-geograba-gggggg-synapse-integration-prd-prompt.md`、`docs/plans/2026-10-17-ticket-system-ux-v2-prd.md`
>
> 口径：本机未构建 / 未跑测试 / 未装依赖（AGENTS.md §0）；所有「现状」均为静态读码结论，行号以核查时 HEAD `99866788` 为准。
>
> **用户正在并行改动的文件（本轮及后续实施都不得触碰；核查期间 `git status` 有增长）**：
> - `src/routes/auditLogRoutes.ts`、`src/services/auditLogService.ts`、`src/services/auditLogMetadata.ts`、`src/services/auditLogCatalog.ts`（M/??）
> - `frontend/src/api/auditLog.ts`、`frontend/src/components/AuditLogViewer.tsx`、`frontend/src/utils/auditLogPresets.ts`、`frontend/src/components/admin/audit-log/`（M/??）
> - `src/controllers/nexaiSecurityController.ts`、`src/routes/nexaiSecurityRoutes.ts`、`frontend/src/components/NexAISecurityDashboard.tsx`、`src/services/nexaiSecurityCatalog.ts`（M/??）
>
> 凡需要审计数据的面板，一律只读 `security_events` / 各自业务集合，不依赖上述文件的内部形状。

---

## 0. 一句话结论

十月十七日共有 **5 类交付会在管理端留下可操作的面**：

| 类别 | 条目 | 现状 |
| --- | --- | --- |
| 账户安全与风险 | RC-14/15/20/26/38/56/57、账户数据导出 | 后端齐备，**没有聚合管理页**（只有用户列表里的批量动作与安全态势小面板） |
| 成本与资源闸门 | RC-27/28/29/30/37/39 | 后端齐备，**完全没有管理页**（无 quota_events / 并发 / 占用 / 沙箱的任何读接口） |
| 业务域 | 工单 v2、GeoGebra、Pixel、邮件溯源、法律保全、政策同意 | 法律保全/政策同意/Pixel 达标；**工单没有管理页**；GeoGebra 仅单屏概览；邮件溯源缺总览；doc-tool 无跨用户运维面 |
| 治理接线 | RC-31/32/41 | 属后端门禁接线，**不需要独立页**；可选在政策同意页加「功能门禁」只读页签 |
| 非功能性 | CodeQL、设计语言 P3/P7/P8/P9/P10/P11/P12、conformance 报告 | 不产生管理功能，**不建页** |

**结论：新建 4 个管理页 + 扩展 5 个现有页（含可选的 GAP-13）+ 新增 27 个端点（写操作 2 个，其余只读）。**

> 2026-11-22 追加：§11 的默认裁决已获 owner 全部确认；GAP-13（政策同意页的「功能门禁」只读页签）由「可选」改为**纳入**。

---

## 1. 判定口径与「信息密度」基线

### 1.1 已有管理页的密度基线（以 `admin/ip-risk-logs` 为准）

参照文件：`frontend/src/components/admin/IpRiskLogPanel.tsx`（277 行）+ `ip-risk-log/*`（共 4,009 行）。

一个页面达到基线，必须同时具备：

1. `InfoQueryShell` + `InfoQueryHero`（eyebrow / 标题 / 说明 / 状态徽标 / 动作区）；
2. 顶部 4–6 张 `InfoMetricCard`（每张带 detail 文案，缺失数据写「等待概览」而不是空白）；
3. 页签化（≥3 个页签，按数据集合或问题域切分），页签按钮带 `title` 提示；
4. 每个页签各自四态：加载 / 失败 + 重试 / 空态 + 解释 / 完成；
5. 服务端筛选 + 分页（筛选下推到 Mongo，不整表拉取）+ 自动刷新（手动 / 15s / 1m / 5m）；
6. 行内可展开详情或抽屉，字段密度到「一眼能判断处置」的程度；
7. 「语义说明 / 口径说明」折叠块（避免管理员误读字段）；
8. 只读页显式标注「本页不修改任何数据」；有写操作时写清楚权限与二次确认；
9. 移动端 44px 触达高度、`min-w-0` 防溢出、四态原语全部来自 `studioTheme` / `studioFeedback`；
10. 导出（CSV/NDJSON）由服务端生成并写审计（超过行数硬顶直接拒绝，不截断）。

### 1.2 本轮纳入 / 不纳入

| 纳入 | 理由 |
| --- | --- |
| 2026-10-17 各文档中「产生了新集合、新端点、新治理开关」的条目 | 管理员需要可观测与可处置 |
| 10-10.md 中由 10-17 批次落地的 RC 条目 | 同上 |

| 不纳入 | 理由 |
| --- | --- |
| CodeQL 告警处置、设计语言批次、conformance 只读核查 | 无运行时功能面 |
| RC-31/32/41 的门禁接线本身 | 已有 policy-consents 页承载同意记录；门禁是中间件行为，不做单独页（可选页签见 GAP-13） |
| 上游「协调者接线」中未落地的项 | 未接线就做页面会展示永远为空的数据；按需在对应页面标注「后端未接线」 |

---

## 2. 逐条对照总表

图例：✅ 已达标 · 🟡 有实现但管理面不足 · ❌ 完全缺失 · — 不适用

### 2.1 账户安全与风险（来源：`2026-10-17-rc-b7.md`、`2026-10-17-admin-account-data-export.md`）

| 编号 | 功能 | 后端现状（证据） | 前端现状 | 判定 | 计划 |
| --- | --- | --- | --- | --- | --- |
| RC-14 | IDC 出口升档 + API Key 降速 | `services/accountRiskService.ts:1060 handleIdcEgressRisk`；事件 `ACCOUNT_ABUSE_IDC_EGRESS:1101` | 无 | ❌ | GAP-01 页「信号」页签可查；「配置与口径」显示开关 |
| RC-15 | `isGeoJump` 单一入口 + 属地跳变台账 | `services/geoRisk.ts`；事件 `ACCOUNT_ABUSE_GEO_JUMP:329` | 无 | ❌ | GAP-01「信号」页签 |
| RC-20 | 登录前验证失败按账户聚合（匿名半权重） | `recordAccountAbuseSignal`（`accountRiskService.ts:1282`） | 无 | ❌ | GAP-01「信号」页签（标 `anonymous`） |
| RC-26/56 | WebRTC/出口不一致作为账户信号 | `loadProbeRiskFacts`；`proxycheck_probe_reports` | 现有 ip-risk-logs 有「探测上报」页签 | 🟡 | 在 GAP-01 增加「账户归因」列与深链到 ip-risk-logs |
| RC-38 | 通道级受限映射（`ACCOUNT_RESTRICTED`） | `utils/accountRiskScoring.ts:426`、`accountRiskService.ts:1139` | 无（通道接线仍挂起） | 🟡 | GAP-01「通道映射」只读展示；未接线通道显式标注 |
| RC-57 | `navigator.webdriver` / UA-CH 痕迹 | 事件 `AUTOMATION_TRACE`；`recordAutomationTraceSignal:1183` | 用户侧指纹上报已接 | ❌ | GAP-01「信号」页签 |
| RC-07 | 统一处罚出口（`ACCOUNT_RISK_ACTION`） | `applyAccountRiskAction:801`；事件名见 `:721` | 仅用户列表批量动作（`POST /api/admin/users/bulk-action`） | 🟡 | GAP-01「处置记录」+ 用户页深链 |
| — | 账户数据导出 / 注销 | `routes/admin/userData.ts:21/50/85` | `UserManagement` + `UserDataDialog` | ✅ | 仅补用户页到风险页的互链 |

### 2.2 成本与资源闸门（来源：`2026-10-17-rc-b9.md`）

| 编号 | 功能 | 后端现状 | 前端现状 | 判定 | 计划 |
| --- | --- | --- | --- | --- | --- |
| RC-27 | 突发并发硬顶（TTS/转写/CDict） | `middleware/routeLimiters.ts:433-590`、`getBurstConcurrencySnapshot:490` | 无 | ❌ | GAP-02「在途并发」页签 |
| RC-28 | 80%/100% 预警 + 账户预算 + 上游额度信号 | `models/quotaEventModel.ts`（`quota_events`）、`services/quotaEventService.ts` | 无 | ❌ | GAP-02「配额事件」页签 |
| RC-29 | 通用配额阶梯引擎 | `services/quotaLadderService.ts` | 无 | ❌ | GAP-02「阶梯与封禁」页签（只读配置 + 用户状态） |
| RC-30 | TTS 每用户活跃上限 | `tts/tts.queue.ts:93 getOccupancyForUser`、`:99 getOccupancy` | 无 | ❌ | GAP-02「TTS 占用」页签（需新端点） |
| RC-37 | 累计违禁次数升级封禁 | `libreChatQuotaService` + `libreChatBanCount` 字段 | 无 | ❌ | GAP-02「阶梯与封禁」页签 |
| RC-39 | 文件沙箱四道硬顶 + 子进程看门狗 | `mediaTool/sandbox.ts`、`utils/processWatchdog.ts` | `MediaToolAdmin` 4 页签，无限制展示 | 🟡 | GAP-09 MediaTool 增加「限制与沙箱」页签 |
| RC-33 | 邮件 WAF 前缀豁免裁决 | 仅测试固化，无产品面 | — | — | 不建页；在 GAP-02 口径说明中提一句 |

### 2.3 业务域

| 编号 | 功能 | 后端现状 | 前端现状 | 判定 | 计划 |
| --- | --- | --- | --- | --- | --- |
| TUX-* | 工单 v2（分诊、SLA、满意度、批量） | `routes/ticketRoutes.ts:59-104` 管理端点齐全；`ticketWorkflowService` 统计字段齐全 | 只有 `/support`（`TicketSystem.tsx`），管理端组件存在但只在用户页里复用 | 🟡 | GAP-03 新建 `/admin/tickets` |
| GEO-11 | 云端版本保留上限 | `geogebra/projectService.ts`（env 钳制） | GeoGebra 页无展示 | 🟡 | GAP-05 展示保留上限与实际版本数 |
| GEO-16 | AI 概要写入评论 | 前端按钮，无管理面 | — | — | 不建页 |
| GEO-17 | embed URL / 嵌入壳 / 分享撤销 | `geogebra/shareService.ts`；`security/embedFramePolicy.ts` | 分享面板 | 🟡 | GAP-05「分享与嵌入」页签（含白名单实际值） |
| GEO-22 | 管理诊断 worker/队列/静态资源/最近资产 | `geogebra/adminDiagnosticsService.ts`；`routes/admin/geogebra.ts:29` | `GeoGebraAdminPanel.tsx` 246 行，**单屏无页签** | 🟡 | GAP-05 拆成 7 页签并补分页列表 |
| GEO-AI | AI 提供商在线配置 | `GET/PUT /api/admin/geogebra/ai/setting`（超管 + 安全会话） | 前端**只读展示来源**，没有编辑界面 | ❌ | GAP-05「AI 配置」页签 |
| PIX-13 | 运行时配置来源/覆盖/热更/恢复默认 | `pixel/integrationConfigService.ts`；`routes/admin/pixelRoutes.ts` | `PixelAdminPanel` 配置页 | ✅ | 复核字段（见 §4.2） |
| PIX-14 | 总览 proxy/worker/queue + errors/latency/size | `pixel/dashboardService.ts` | 总览页签 | ✅ | 复核 |
| — | 系统内部发信进入邮件溯源 | `services/emailTraceService.ts`；`GET /api/outemail/records?channel=` | `EmailTraceability.tsx` 有来源列/筛选 | 🟡 | GAP-07 增加总览页签 + 统计端点 |
| RC-22/35/58 | 法律保全与取证 | `routes/admin/legalHolds.ts`（8 端点） | `LegalHoldManager.tsx` 979 行 | ✅ | 不改 |
| RB-01…15 | Redis 在库浏览器 | `routes/admin/system.ts` | `RedisDataBrowser` | ✅ | 不改 |
| — | doc-tool（Markdown→Word） | `routes/docToolRoutes.ts` 全量 `authenticateAdmin` + **按用户目录隔离** | `DocConvertPage`（用户自助），无跨用户运维面 | ❌ | GAP-04 新建 `/admin/doc-tool`（超管） |
| — | 政策同意记录 | `routes/admin/policyConsents.ts` | `PolicyConsentPanel` 2 页签 | ✅ | 可选 GAP-13 |

### 2.4 本轮不建页的条目

| 条目 | 不建页理由 |
| --- | --- |
| CodeQL 1411/1412/1413/1425/1426 | 静态告警，无运行时数据 |
| 设计语言 P3/P7/P8/P9/P10/P11/P12 | UI 规范收尾；其成果直接体现在各页样式闸门里 |
| conformance 只读核查 | 文档核查产物 |
| RC-31/32/41 | 门禁中间件行为；记录面由 policy-consents + 既有审计页覆盖 |
| 「协调者接线」中未落地项 | 先接线再有面，否则页面恒空 |

---

## 3. 需要新建的管理页

> 统一的硬约束（2026-11-22 owner 裁决）：**所有新增端点的角色判定一律交给 `authenticateAdmin` + `requireAdminScope` 页面授权**，
> 不再在路由上硬编码 `authenticateSuperAdmin` —— 默认授权集合不含新页面，因此默认行为仍是「只有超管能用」（fail-closed），
> 需要下放给普通管理员时由超管在 `/admin/admin-scope` 里勾选页面即可。写端点在此基础上额外叠 `requireSecuritySession`（二次验证，不是角色）+ `auditLog`。所有列表分页下推 Mongo、上限 ≤200/页；不新增集合；不向前端下发密钥/密文/完整卡密；IP 与指纹默认打码，提供「显示完整值」需超管且逐次审计。

### GAP-01 `/admin/account-risk` — 账户风险与自动化信号

**页面文件**：`frontend/src/components/admin/AccountRiskPanel.tsx` + `account-risk/{OverviewTab,AccountsTab,SignalsTab,IpFactsTab,ActionsTab,ConfigTab,ui.tsx,format.ts}`
**页面 key**：`account-risk`；`apiPrefixes`：`["/api/admin/account-risk"]`
**权限**：读 = `admin` + 页面授权 `account-risk`（默认未授予任何普通管理员 → 只有超管）；写 = 页面授权 + 安全会话 + 审计（沿用 `applyAccountRiskAction`，**不新增第二出口**）

| 页签 | 数据 | 列 / 展示 | 交互 |
| --- | --- | --- | --- |
| 概览 | 用户风险档分布、封停数、24h 信号数、24h 自动化痕迹、24h IDC 命中、24h 属地跳变、待逐步验证数、Top 旗标 | 6 张 `InfoMetricCard` + 「风险档 × 旗标」矩阵 + 最近 10 条信号 | 点卡片直接切到对应筛选 |
| 账户风险 | `user_datas` 风险字段 | 用户名 / 角色 / 档位 / 分数 / 旗标 / 上次评估 / 状态 / 最近登录 IP（打码）/ 处置人 | 筛选档位/旗标/状态/关键词；排序分数；行内「处置」抽屉；深链 `/admin/users?focus=<id>`（用户页需补该参数，见 §4.4） |
| 滥用信号 | `security_events` | 时间 / eventType / 用户 / IP（打码）/ 指纹短哈希 / 分数 / `eventData` 摘要（`anonymous` 徽标） | 筛选类型/用户/IP/时间窗；展开原文（脱敏后）；CSV 导出（超管 + 审计） |
| 登录 IP 事实 | `account_ip_signals` | 用户 / IP / 属地 / 登录次数 / 风险分 / 等级 / 旗标 / 网络类型 / ASN / 组织 / 是否 IDC / 来源 / 首末次 | 筛选 IDC / 风险等级 / 用户；同 IP 跨账户反查；跳 ip-risk-logs 风险缓存 |
| 处置记录 | `security_events` 中 `ACCOUNT_RISK_ACTION` / `ACCOUNT_RISK_TIER_CHANGED` | 时间 / 操作者 / 目标 / 动作 / 前后档位 / 理由 / 是否自动 | 按动作/操作者筛选；与用户页动作口径一致 |
| 配置与口径 | `accountRisk` 运行时配置 + 评分权重表 + 通道映射表 | 开关（enabled / ipRecheckEnabled / stepUpEnabled / autoEscalationCap / 保留天数）、权重（匿名封顶、PROBE 10、AUTOMATION 8、GEO_JUMP 10）、`resolveAccountRiskChannelDecision` 四档 × 通道矩阵 | 只读；写配置仍走 `/admin/env` 或对应 setting（超管 + 安全会话） |

**新增端点（全部只读）**

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/admin/account-risk/overview` | 超管 | 分布、24h 计数、Top 旗标、最近动作 |
| GET | `/api/admin/account-risk/accounts` | 超管 | 用户风险列表；`tier/flag/status/q/sort/page/pageSize` |
| GET | `/api/admin/account-risk/signals` | 超管 | `security_events`；`eventType/userId/ip/since/until/anonymous/page` |
| GET | `/api/admin/account-risk/ip-facts` | 超管 | `account_ip_signals`；`userId/ip/datacenter/level/since/page` |
| GET | `/api/admin/account-risk/actions` | 超管 | 处置记录；`action/operatorId/userId/since/page` |
| GET | `/api/admin/account-risk/config` | 超管 | 运行时配置 + 权重/通道矩阵（脱敏） |

**实现要点**
- 新增 `src/controllers/accountRiskAdminController.ts` + `src/services/accountRiskAdminService.ts`，把查询与视图组装放在服务层，控制器只做参数解析（与 `ipRiskLogController` 同形）。
- 复用 `accountRiskService.getAccountRiskState` / `isRiskExempt` / `resolveAccountRiskChannelDecision`，**不复制评分逻辑**。
- 索引：`user_datas.riskTier` 已有单列索引；补 `{ riskTier: 1, riskUpdatedAt: -1 }` 供排序；`security_events` 已有 `(userId,createdAt)` / `(eventType,createdAt)` / `createdAt`；`account_ip_signals` 已有 `(userId,lastSeenAt)` / `(ipAddress,lastSeenAt)`。
- PII：IP 显示为 `1.2.3.x` 形式；指纹只给 SHA-256 前 12 位；`eventData` 递归脱敏（复用 `utils/auditRedaction.ts` 的 EXACT/SUBSTRING 表，**只读不改该文件**）。
- 该页端点只挂 `authenticateAdmin`（挂载层已含 `requireAdminScope`），`src/config/adminPages.ts` 登记 `account-risk` 与其 API 前缀；默认授权集合不含它，因此默认仅超管可见，后续可按页面下放。

### GAP-02 `/admin/rate-limits` — 限流、配额与资源闸门

**页面文件**：`frontend/src/components/admin/RateLimitPanel.tsx` + `rate-limits/{OverviewTab,BurstTab,QuotaEventsTab,LadderTab,TtsOccupancyTab,ResourcesTab,LimitersTab,ui.tsx,format.ts}`
**页面 key**：`rate-limits`；`apiPrefixes`：`["/api/admin/rate-limits"]`
**权限**：读 = `admin` + 页面授权 `rate-limits`（默认只有超管）；写 = 不提供（所有阈值仍为 env / 运行时配置，页面只读并给出「改哪里」）

| 页签 | 数据 | 展示 | 交互 |
| --- | --- | --- | --- |
| 概览 | `getBurstConcurrencySnapshot()`、`quota_events` 24h、LibreChat 封禁数、TTS 队列占用 | 6 张指标卡 + 「24h 配额事件趋势」 | 自动刷新（并发与占用必须短周期） |
| 在途并发 | `getBurstConcurrencySnapshot()` | 守卫名 / 在途 / 键数 / 上限 / 占用率进度条 | 手动/5s 刷新；超顶高亮 rose |
| 配额事件 | `quota_events` | 时间 / 范围（key/account/upstream）/ 用户 / keyId 短哈希 / 资源 / 阈值 / 账期 / cycle / code / detail 摘要 | 筛选范围/资源/阈值/时间；CSV |
| 阶梯与封禁 | `libreChatQuotaService` 视图 + `user_datas` 的 `libreChatDailyUsage/ViolationCount/BannedUntil/BanCount` | 用户 / 今日用量 / 违规次数 / 累计封禁次数 / 当前时长 / 解封时间 | 筛选「封禁中」；只读；解除封禁仍走现有管理动作并审计 |
| TTS 占用 | `ttsQueue.getOccupancy()` + 逐用户 `getOccupancyForUser` | 全局并发 / 每用户上限 / processing / 占用 Top N 用户 | 需要新增「占用 Top N」查询（见端点） |
| 资源沙箱 | `MEDIA_SANDBOX_DEFAULTS` / `resolveMediaSandboxLimits` / watchdog 解析值 / `docLimitsFromEnv` | 单文件 / 单任务 / 用户目录字节 / 文件数 / RSS / 时长 / 模式 | 显示「env 名 + 生效值 + 默认值」三列 |
| 限流器清单 | `LIMITER_DEFINITIONS` + 实际 profile | 名称 / 窗口 / 额度 / 类别 / 存储后端 | 搜索；标注 `static` 类走内存 |

**新增端点（全部只读）**

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/admin/rate-limits/overview` | 并发快照汇总 + quota_events 24h 汇总 + TTS 占用 + 封禁数 |
| GET | `/api/admin/rate-limits/burst` | 并发守卫快照（逐守卫/逐键） |
| GET | `/api/admin/rate-limits/quota-events` | `quota_events` 分页；`scope/resource/threshold/userId/since/page` |
| GET | `/api/admin/rate-limits/ladders` | 每用户阶梯视图；`state=banned/active/q` |
| GET | `/api/admin/rate-limits/tts-occupancy` | `getOccupancy()` + 活跃任务按用户聚合 Top N |
| GET | `/api/admin/rate-limits/resources` | 沙箱 + 看门狗 + doc-tool 限额的「值/来源/默认」 |
| GET | `/api/admin/rate-limits/limiters` | `LIMITER_DEFINITIONS` 派生清单 |

**实现要点**
- `LIMITER_DEFINITIONS` 目前未导出（`routeLimiters.ts` 内部 const）。新增只读导出 `getLimiterDefinitionSnapshot()`，**不改任何限流行为**；该文件不在用户 WIP 清单内。
- TTS 队列是 `TtsController` 内的私有静态实例（`tts/tts.controller.ts:21`），没有全局句柄。需要新增轻量注册表（`tts/tts.queueRegistry.ts`）或在控制器导出 `getTtsQueueOccupancy()`；**不得为了面板改变队列行为**。
- 逐用户活跃任务统计：`tts.storage.countActiveJobsForUser` 已有，新增 `listActiveJobOwners(limit)` 聚合即可（`status ∈ {queued,processing}`）。
- `quota_events` 已有 `(userId,createdAt)` 与 TTL 180 天索引；按 `scope/resource/createdAt` 查询补复合索引 `{ scope: 1, resource: 1, createdAt: -1 }`。
- 页面顶部固定一条「这些阈值在哪改」：`API_KEY_ACCOUNT_BUDGET_*`、`LIBRECHAT_BAN_HOURS_TABLE`、`BURST_*`、`TTS_PER_USER_MAX_ACTIVE`、`MEDIA_TOOL_*`、`PROCESS_WATCHDOG_*` → 指到 `/admin/env`。

### GAP-03 `/admin/tickets` — 工单管理（分诊工作台）

**页面文件**：`frontend/src/components/admin/TicketAdminPanel.tsx` + `ticket-admin/{StatsTab,ListTab,InsightsTab,AuditTab,ui.tsx}`
**复用**：`components/ticket/TicketFilters`、`TicketStatsBar`、`TicketBulkBar`、`TicketListItem`、`TicketConversation`、`TicketEventTimeline`、`TicketSatisfactionCard`、`TicketAttachmentSettingsCard`（这些组件已按管理端契约实现，见 `2026-10-17-ticket-ux-v2-worklist.md` §三）
**页面 key**：`tickets`（已存在，`apiPrefixes: []` → 改为 `["/api/tickets"]`）
**权限**：读 = admin（现有 `/admin/all`、`/admin/stats` 已是 `adminOnly + requireAdminScope`）；写 = 现有路由已要求 `authenticateSuperAdmin`，页面按角色隐藏

| 页签 | 数据 | 展示 | 交互 |
| --- | --- | --- | --- |
| 概览 | `GET /api/tickets/admin/stats` | 我的待办 / 待回复 / 逾期 / 未分配 / 今日新增 / 今日解决 / 平均首响 / 满意度 / 各状态计数 | 卡片点击即筛选；`ring-2` 高亮当前快捷视图 |
| 工单列表 | `GET /api/tickets/admin/all` | 状态/优先级/分类/类型/服务/受理人/CSAT 星级/未读/附件/SLA 剩余 | 快捷视图、多条件筛选、排序、分页、批量条（认领/取消分配/状态/优先级/分类）；URL 同步筛选 |
| 详情 | `GET /api/tickets/:id` | 会话、事件时间线、CSAT、附件设置、SLA、上/下一条 | 内部备注、编辑/删除消息（超管）、Markdown/纯文本切换 |
| 质量与 SLA | 新增 `GET /api/tickets/admin/insights` | 首响分位（P50/P90/P95）、解决时长、SLA 超时 Top、低满意度 Top、会话消息量 Top、按服务/分类分布、7/30 天趋势 | 时间窗切换；跳转到筛选后的列表；CSV |
| 客服工作量 | 同上（`assignee` 维度） | 受理人 / 待办 / 本周解决 / 平均首响 / 平均满意度 / 超时数 | 点击受理人筛选 |
| 口径说明 | 静态 | 状态机、SLA 小时数、CSAT 计算口径、脱敏规则（属主视角客服姓名被服务端脱敏） | 折叠 |

**新增端点**

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/tickets/admin/insights` | superadmin（与统计同级） | 趋势、分位、Top 列表、按受理人聚合；时间窗参数 |
| GET | `/api/tickets/admin/assignees` | admin | 可选：受理人清单。若已有用户搜索接口可复用，则不新增 |

**实现要点**
- `computeTicketStats` 已返回首响/CSAT 字段（`ticketWorkflowService.ts:585-716`），概览页直接用，**不要在前端重算**。
- 分位用 Mongo `$percentile`（Mongo 8 镜像，与 Pixel `usageLogService.metrics()` 同口径）；单次 `$facet` 完成。
- 现有批量端点已支持 `status/priority/category/assignee`（`ticketController.ts:987-1044`），页面不要另造批量语义。
- `TicketSystem.tsx` 保持不动（用户侧 `/support`），管理页独立，避免两套权限在同一组件里分叉。

### GAP-04 `/admin/doc-tool` — 文档转换运维

**页面文件**：`frontend/src/components/admin/DocToolAdminPanel.tsx` + `doc-tool/{OverviewTab,JobsTab,FilesTab,LimitsTab,ui.tsx,format.ts}`
**页面 key**：`doc-tool`；`apiPrefixes`：`["/api/admin/doc-tool"]`
**权限**：`admin` + 页面授权 `doc-tool`（默认只有超管）；清理写操作 = 页面授权 + 安全会话 + 审计

| 页签 | 数据 | 展示 |
| --- | --- | --- |
| 概览 | pandoc 是否可用、工作根目录可写、队列长度、活动任务数、失败率、产物总字节、最早/最新任务 | 指标卡 + 引擎状态 |
| 任务 | 跨用户 `doc_tool_jobs` | 任务 ID / 用户 / 状态 / 文件数 / 成功/失败/跳过 / 创建/结束 / 错误摘要；展开逐文件结果与日志尾 |
| 文件与产物 | 各用户目录占用 | 用户 / inbox 数 / 产物数 / 总字节 / 最近活动；按占用排序；标注保留期与清理策略 |
| 限额 | `docLimitsFromEnv()` + 保留天数 | 单文件 / 总上传 / 活动任务 / 每任务文件数 / 保留天数，附 env 名与默认值 |
| 清理 | 现有 cleanup 语义 | 先 dry-run 预演（返回将删除数量），确认后执行；超管 + 安全会话；写审计 |

**新增端点**

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/admin/doc-tool/overview` | 超管 | 引擎/队列/磁盘汇总 |
| GET | `/api/admin/doc-tool/jobs` | 超管 | 跨用户分页；`status/userId/since/page` |
| GET | `/api/admin/doc-tool/jobs/:id` | 超管 | 单任务详情（含日志，脱敏） |
| GET | `/api/admin/doc-tool/files` | 超管 | 用户目录占用汇总 |
| POST | `/api/admin/doc-tool/cleanup/preview` | 超管 | dry-run 预演 |
| POST | `/api/admin/doc-tool/cleanup/run` | 超管 + 安全会话 | 真实清理，写审计（只记计数） |

**实现要点**
- `DocJobStore` 目前只有 `list(userId, limit)`（`src/docTool/jobs/docJobStore.ts:8`）。跨用户查询需要在 store 增加 `listAll(filter)`（Mongo 实现按 `userId/status/createdAt` 分页），**保持现有按用户方法不变**。
- 所有路径解析必须继续走 `docTool/runtime.ts` 的 `realInside` 守界；面板只读元数据，不提供下载任意用户文件的入口。
- 清理端点复用 `docArtifactCleanup` 的同一实现，不另写删除逻辑。

---

## 4. 需要扩展的现有页

### 4.1 GAP-05 `/admin/geogebra` — 从单屏升级为多页签

现状：`GeoGebraAdminPanel.tsx` 246 行，单屏顺序渲染；后端已有 `overview`、`maintenance`、`ai/setting` GET/PUT。

| 页签 | 数据来源 | 新增工作 |
| --- | --- | --- |
| 概览 | `overview` 计数 + 服务状态 | 指标卡化（项目/版本/分享/评论/资源/任务） |
| 任务队列 | `overview.worker/queue/jobsByStatus/recentJobs` | 增加分页列表端点 `GET /api/admin/geogebra/jobs`（status/kind/user/page） |
| 分享与嵌入 | `overview.recentShares` | 增加 `GET /api/admin/geogebra/shares`（含 embedUrl、撤销状态、fork 开关）；展示 `GEOGEBRA_EMBED_FRAME_ANCESTORS` 生效值（只读） |
| 静态资源 | `overview.staticAssets/recentAssets` | 增加 `GET /api/admin/geogebra/assets`（purpose/mime/size/expires/owner 短哈希） |
| AI 配置 | `ai/setting` | **前端补齐编辑表单**：mode（env/custom/librechat）、baseUrl、model、vision、provider 选择；密钥留空=不改；保存需安全会话 |
| 版本与保留 | 无 | 增加 `GET /api/admin/geogebra/settings` 返回 `GEOGEBRA_VERSION_RETENTION_LIMIT` 生效值与「被评论引用保护」口径 |
| 维护 | `maintenance` | 保留；清理前二次确认，展示返回计数 |

### 4.2 GAP-06 `/admin/pixel` — 字段复核（不重做）

已达标部分：5 页签（overview/mappings/usage/config/compliance）、PIX-13 的来源/覆盖/热更/恢复默认、PIX-14 的 runtime/metrics。
**本轮只做核对与补缺**：

- 确认 `PixelAdminPanel` 已消费 `config.source/overridden/reload`、`runtime.proxy/worker/queue`、`metrics.errors/latency/requestSize`；
- 若 `frontend/src/api/pixelAdmin.ts` 的类型落后于后端 `pixel/types.ts`，只补类型（不改行为）；
- 在「使用记录」页签补「按结果/延迟分位筛选」与 CSV 导出（若后端已支持则只接 UI）。

### 4.3 GAP-07 `/admin/email-traceability` — 增加总览与来源统计

现状：`EmailTraceability.tsx` 已有来源列/筛选，后端 `GET /api/outemail/records?channel=`。

新增：
- `GET /api/outemail/records/stats`（超管）：按来源计数、7/30 天趋势、失败/抑制分布、Top 收件域（打码）、平均发送耗时；
- 页面增加「概览」页签（指标卡 + 趋势 + 来源占比），列表页签保留；
- 详情抽屉中增加「同一收件人最近 10 封」快捷查询（复用现有 records 过滤）。

### 4.4 GAP-08 `/admin/users` — 风险互链（小改）

- 用户页支持 `?focus=<userId>` 深链（从 GAP-01 跳入）；
- 「安全态势」小面板增加「查看账户风险」按钮 → `/admin/account-risk?user=<userId>`；
- 不改变现有批量动作语义。

### 4.5 GAP-09 `/admin/media-tool` — 增加「限制与沙箱」页签

- 展示 `resolveMediaSandboxLimits()` 的四道硬顶、`PROCESS_WATCHDOG_*` 解析值、队列/工作目录占用；
- 只读；提示 env 名与默认值；不提供在线修改（避免超出 RC-39 的裁决）。

### 4.6 GAP-13 `/admin/policy-consents` — 「功能门禁」页签（owner 已确认纳入）

- 只读展示 `config/featureConsent.ts` 的功能键 → 条款 → 挂载路由清单（从 `config/featureConsent.ts` 的静态表 + 路由注册表派生，新增 `GET /api/admin/policy-consents/feature-gates`）；
- 每行给出「该功能当前是否有用户被 403 挡住」的计数（来自 `featureConsent` 拒绝计数器，若不可用则显示原因而不是 0）；
- 不暴露用户同意明细（已有「同意记录」页签）。

---

## 5. 后端新增端点总表

| # | 方法 | 路径 | 权限 | 新文件 |
| --- | --- | --- | --- | --- |
| 1 | GET | `/api/admin/account-risk/overview` | admin + 页面授权 | `controllers/accountRiskAdminController.ts`、`services/accountRiskAdminService.ts` |
| 2 | GET | `/api/admin/account-risk/accounts` | admin + 页面授权 | 同上 |
| 3 | GET | `/api/admin/account-risk/signals` | admin + 页面授权 | 同上 |
| 4 | GET | `/api/admin/account-risk/ip-facts` | admin + 页面授权 | 同上 |
| 5 | GET | `/api/admin/account-risk/actions` | admin + 页面授权 | 同上 |
| 6 | GET | `/api/admin/account-risk/config` | admin + 页面授权 | 同上 |
| 7 | GET | `/api/admin/rate-limits/overview` | admin + 页面授权 | `controllers/rateLimitAdminController.ts`、`services/rateLimitAdminService.ts` |
| 8 | GET | `/api/admin/rate-limits/burst` | admin + 页面授权 | 同上 |
| 9 | GET | `/api/admin/rate-limits/quota-events` | admin + 页面授权 | 同上 |
| 10 | GET | `/api/admin/rate-limits/ladders` | admin + 页面授权 | 同上 |
| 11 | GET | `/api/admin/rate-limits/tts-occupancy` | admin + 页面授权 | 同上 |
| 12 | GET | `/api/admin/rate-limits/resources` | admin + 页面授权 | 同上 |
| 13 | GET | `/api/admin/rate-limits/limiters` | admin + 页面授权 | 同上 |
| 14 | GET | `/api/tickets/admin/insights` | admin + 页面授权 | `services/ticketWorkflowService.ts` 扩展 + 控制器 |
| 15 | GET | `/api/admin/doc-tool/overview` | admin + 页面授权 | `routes/admin/docTool.ts` + 控制器 |
| 16 | GET | `/api/admin/doc-tool/jobs` | admin + 页面授权 | 同上 |
| 17 | GET | `/api/admin/doc-tool/jobs/:id` | admin + 页面授权 | 同上 |
| 18 | GET | `/api/admin/doc-tool/files` | admin + 页面授权 | 同上 |
| 19 | POST | `/api/admin/doc-tool/cleanup/preview` | admin + 页面授权 | 同上 |
| 20 | POST | `/api/admin/doc-tool/cleanup/run` | admin + 页面授权 + 安全会话 + 审计 | 同上 |
| 21 | GET | `/api/admin/geogebra/jobs` | admin（页面授权） | `routes/admin/geogebra.ts` |
| 22 | GET | `/api/admin/geogebra/shares` | admin | 同上 |
| 23 | GET | `/api/admin/geogebra/assets` | admin | 同上 |
| 24 | GET | `/api/admin/geogebra/settings` | admin | 同上 |
| 25 | GET | `/api/outemail/records/stats` | admin + 页面授权（`outemail`） | `routes/outemailRoutes.ts` |
| 26 | GET | `/api/admin/media-tool/limits` | admin | `routes/mediaToolRoutes.ts`（工厂注入） |
| 27 | GET | `/api/admin/policy-consents/feature-gates` | admin + 页面授权 | `routes/admin/policyConsents.ts` |

> 说明：21–24 复用现有 `/api/admin/geogebra` 前缀，已登记页面 key；25 复用 `outemail` key；26 复用 `media-tool` key。新增前缀只有 `account-risk`、`rate-limits`、`doc-tool` 三个，需在 `src/config/adminPages.ts` 登记。

---

## 6. 前端接线清单

每新增一个页面，必须同步以下位置（缺一处 CI 或深链就会红）：

1. `frontend/src/components/admin/adminModules.tsx` → `ADMIN_MODULE_LOADERS` 增加 key；
2. `frontend/src/navigation/navConfig.ts` → `getAdminNavGroups` 对应分组加入口（`requiredRole` / `requiredPage`）；
3. `src/config/adminPages.ts` → 登记 key + `apiPrefixes`（写权限的页面在说明里标注「写操作另叠超管 + 安全会话」）；
4. `pnpm run generate:admin-spa-paths` → 重新生成 `src/generated/adminSpaModulePaths.ts`（**不要手改生成物**）；
5. `frontend/src/api/<domain>.ts` → 新增类型化客户端（禁止组件里裸 `api.get`）；
6. `src/tests/adminPages.test.ts` 若涉及默认集合/前缀反查断言需同步；
7. 新增端点若有 `@openapi` 注释 → 跑 `pnpm run generate:openapi`，否则 `check:openapi-drift` 红；
8. 若新增「读他人数据」的导出 → 同步 `docs/governance/privacy-data-map.json` 的 `export.surface`（本轮新增均为只读浏览，**不新增数据集**）。

**导航分组归属**

| 页面 | 分组 | requiredRole |
| --- | --- | --- |
| 账户风险 `account-risk` | `admin-security` | superadmin |
| 限流与配额 `rate-limits` | `admin-security` | superadmin |
| 工单管理 `tickets` | `admin-operations` | admin（写操作前端按超管隐藏） |
| 文档转换运维 `doc-tool` | `admin-operations` | superadmin |
| GeoGebra（已有） | `admin-operations` | 保持现状 |
| 邮件溯源（已有） | `admin-operations` | 保持现状（requiredPage: outemail） |
| 媒体工具（已有） | `admin-operations` | 保持现状 |

---

## 7. 交互与信息密度验收清单（每个新页逐条打勾）

- [ ] 首屏 6 张以内指标卡，每张都有 `detail` 解释来源/窗口；
- [ ] 至少 4 个页签，页签切换不重新拉取无关数据（每个页签自持 `refreshNonce`）；
- [ ] 每个页签四态齐全（加载/失败+重试/空态+原因/完成），失败不清空已加载数据；
- [ ] 筛选、排序、分页全部下推服务端；筛选状态写入 URL（可分享、可后退）；
- [ ] 自动刷新：手动 / 15s / 1m / 5m；页面隐藏时暂停；
- [ ] 行内展开或抽屉展示完整字段；长文本 `min-w-0`，右侧徽标 `shrink-0`；
- [ ] 导出按钮显式标注「服务端生成 + 写审计」；超限返回 413 文案明确「未导出任何数据」；
- [ ] PII 默认打码；「显示完整」需超管且逐次审计；
- [ ] 写操作：二次确认 + 必填理由 + 安全会话缺失时只展示 `EstablishSecuritySession`，不发请求；
- [ ] 空态文案说明「数据从哪来、什么时候会有」，不写「暂无数据」了事；
- [ ] 全部颜色/圆角/按钮/四态来自 `studioTheme` / `studioFeedback`；无 indigo/purple/任意 hex；
- [ ] 手机端 375px 无横向滚动，触达高度 ≥44px；
- [ ] 页面文件 < 1500 行（`check:ts-file-size`），超出按页签拆文件；
- [ ] 设计语言闸门命中数不上升（`check:frontend-design-language`）。

---

## 8. 实施批次（建议顺序）

| 批次 | 内容 | 依赖 | 风险 |
| --- | --- | --- | --- |
| B1 | GAP-01 账户风险（后端 6 端点 + 页面） | 无 | 中（PII，需脱敏） |
| B2 | GAP-02 限流与配额（后端 7 端点 + 页面） | 需导出 `LIMITER_DEFINITIONS` 快照、TTS 队列注册表 | 中（新增注册表不能改队列行为） |
| B3 | GAP-03 工单管理（1 端点 + 页面复用） | `tickets` key 补前缀 | 低 |
| B4 | GAP-04 doc-tool 运维（6 端点 + 页面） | store 增加跨用户查询 | 中（路径守界） |
| B5 | GAP-05 GeoGebra 多页签 + AI 配置表单 | 4 个只读端点 | 低 |
| B6 | GAP-06/07/08/09/13 现有页扩展 | 2 个统计端点 | 低 |
| B7 | 文档回填、OpenAPI、生成物、测试 | 全部 | 低 |

每批次结束：`git add` 显式文件 → `git commit -S` → 自检 `%G?` → `GIT_TERMINAL_PROMPT=0` push → 盯 check-runs（不用 combined status）。

---

## 9. 测试与 CI 判据

**后端 Jest（`src/tests/`）**
- `accountRiskAdmin.test.ts`：分页上限、脱敏、档位筛选、越权 403、空库空态；
- `rateLimitAdmin.test.ts`：并发快照只读、quota_events 幂等读、阶梯视图字段、占用 Top N；
- `docToolAdmin.test.ts`：跨用户查询分页、清理 dry-run 不删、真实清理只删过期、路径越界拒绝；
- `ticketInsights.test.ts`：分位与聚合口径、空数据返回 null 而不是 0、时间窗边界。

**前端 Vitest（`frontend/src/tests/`）**
- 每个新页面一条「四态 + 筛选 + 分页 + 权限隐藏」用例；
- `adminModules` / `navConfig` 的入口可见性用例（普通管理员看不到超管页）；
- URL 状态往返用例。

**CI 闸门**
`pnpm run test`、`pnpm --dir frontend run test`、`check:admin-spa-paths`、`check:openapi-drift`、`check:ts-file-size`、`check:frontend-design-language`、`check:privacy-data-map`、`check:frontend-bundle`。

---

## 10. 风险、边界与不做的事

1. **不新增集合**：所有页面读取既有集合（`user_datas`、`security_events`、`account_ip_signals`、`quota_events`、`proxycheck_*`、`tickets`、`doc_tool_jobs`、`outemail_records`、`geogebra_*`），因此隐私数据地图不需要新增数据集；若后续加导出，必须补 `export.surface`。
2. **不复制业务逻辑**：风险评分、通道映射、SLA、CSAT、配额阶梯一律调用现有服务；页面只做投影。
3. **不改变处罚语义**：所有处罚仍只经 `applyAccountRiskAction`；管理页不新增第二出口。
4. **不碰用户 WIP**：`auditLog*` 四个文件不读内部形状、不改；处置记录改读 `security_events`。
5. **不伪造数据**：无数据源的分位/延迟指标一律返回 `null + reason`（沿用 GeoGebra/Pixel 口径），页面渲染原因而不是 0。
6. **不把密钥送前端**：上游配置只回「是否已配置 + 来源 + 末 4 位（如需）」。
7. **重查询防护**：所有列表默认 20/页、上限 200/页；导出硬顶（建议 20,000 行）超限 413 不截断；聚合查询加时间窗上限（默认 30 天，最大 180 天）。
8. **Mongo 索引**：新增排序/筛选前先核对索引；`user_datas` 补 `{ riskTier: 1, riskUpdatedAt: -1 }`，`quota_events` 补 `{ scope: 1, resource: 1, createdAt: -1 }`。

---

## 11. 待确认的默认裁决（若不反对，按此实施）

| 议题 | 默认裁决 | 理由 |
| --- | --- | --- |
| 账户风险页给普通管理员吗 | **默认不给，但可授**：端点用 admin + 页面授权，默认集合不含 `account-risk` | 2026-11-22 owner 裁决：权限开口统一交给 admin/admin-scope，不硬编码超管 |
| 限流/配额页给普通管理员吗 | **默认不给，但可授**：同上，页面 key `rate-limits` | 同上 |
| 工单页给普通管理员吗 | 给（读）；写操作按现有路由的 `authenticateSuperAdmin` 保留 | 与现有 `/api/tickets/admin/all` 的 `adminOnly` 一致；工单写端点属既有代码，本轮不改其角色判定 |
| doc-tool 运维页范围 | 页面授权（默认仅超管），只读元数据，不提供跨用户文件下载 | 用户文件内容不属于运维视图 |
| 是否新建导航分组 | 不新建，`tickets` 放 `admin-operations` | 避免侧栏层级膨胀 |
| 是否在线修改限流阈值 | 不提供，页面只读并指向 `/admin/env` | 阈值改动需要重启/运行时配置链路，另有页面承载 |

---

## 12. 回填记录

| 日期 | 批次 | 结果 | 提交 |
| --- | --- | --- | --- |
| 2026-11-22 | 核查 | 本文落盘，未改代码 | — |
| 2026-11-22 | 裁决确认 | §11 全部默认裁决获 owner 确认；GAP-13 由可选改为纳入 | — |
