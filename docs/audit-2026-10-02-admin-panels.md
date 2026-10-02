# 安全 / 性能 / 合规审查：管理后台 21 个模块（前后端全量）

- 审查日期：2026-10-02
- 审查范围：用户列出的管理端功能与其前端组件（`AdminDashboard` / `UserManagement` / `AnnouncementManager` /
  `IPBanManager` / `EnvManager` / `CommandManager` / `DebugInfoModal` / `DataCollectionManager` /
  `AuditLogViewer` / `ShortLinkManager` / `FingerprintManager` / `SystemManager` / `AdminStoreDashboard` /
  `LotteryAdmin` / `FBIWantedManager` / `LibreChatAdminPage` / `WebhookEventsManager` /
  `TamperDetectionDemo` / `CaptchaProviderAdmin` / `PolicyConsentPanel` / `BilibiliDataAdmin`），
  以及它们各自依赖的后端路由 / 控制器 / 服务 / 中间件。
- 判据来源：仓库当前工作树源码（逐文件读，标注 `文件:行`）。**本机不构建、不测试**，一切结论以 CI 为最终裁决者。
- 权限口径（本轮起点，来自已合入的 `feat(admin-scope)` 提交 f41a346d）：
  superadmin 可用全部模块；普通 admin 以 `src/config/adminPages.ts` 的运行时授权为准（默认
  `users` / `apikeys` / `apikey-billing` / `oauth`），未登记 `apiPrefixes` 的页面授给普通管理员只会放出入口、
  API 仍被 `requireAdminScope` 拒掉（fail-closed）。本审计**不改变**这套口径，只做「同一口径下的健壮性、
  安全性与可用性」改进。
- 关联改动：见 §2「本轮改动」；每条缺陷的「去向」标注已修 / 待修，不允许静默消失。

> 说明：本仓库已经过多轮定向加固（源码里的 `G7-*` / `G11-*` 注释即历次审计编号），所以本轮的缺陷以
> **跨模块不一致**（同一防御有的地方做了、有的地方漏了）、**前后端契约错位**（接口语义对不上，静默失败）
> 与**权限之外的操作性缺失**（能写不能看、能读不能删）为主，而不是未鉴权的高危漏洞。

---

## 0. 结论速览

| # | 模块 | 鉴权 / 限流 / 审计 | 主要结论 |
|---|---|---|---|
| 1 | 管理仪表盘 | 只读 | 只有邮件溯源一块数据；缺系统级概览（用户/Key/审计/封禁）——待办 |
| 2 | 用户管理 | 强（admin + 页面授权 + 审计） | 批量动作齐全；`search` 关键词进 `$regex` 未转义（SEC-02，已修） |
| 3 | 公告管理 | 强（写操作 superadmin） | 出参 DOMPurify 净化 + 前端二次净化，口径正确 |
| 4 | IP 封禁管理 | 强（写操作 superadmin + 审计） | **只有统计没有名单**（FEA-01，已修）；批量输入无预览（FE-05，已修） |
| 5 | 环境变量管理 | 强（superadmin + 口令 + 审计 + origin 校验） | 未见问题；每个读写动作都落审计 |
| 6 | 命令执行 | 强（superadmin + 安全会话 + 白名单 + argv 数组） | **前端发 `commandId`、后端读 `command` → 移除操作静默失败**（FUNC-01，已修）；`limit` 未收敛、`cpu_usage_percent` 语义错（已修） |
| 7 | 调试控制台 | 前端 admin-only | 组件是死代码、日志无跨组件出口（FE-08，已修）；对话框缺语义（FE-03，已修） |
| 8 | 数据收集管理 | 强（读 admin、写 superadmin） | 抽样；未见新增问题 |
| 9 | 审计日志 | 强（admin + 页面授权） | 导出 CSV 已做公式注入中和（本轮的对照项）；导出计数响应头未暴露给 CORS（SEC-01，已修）；18 个筛选维度无预设（FEA-03，已修） |
| 10 | 短链管理 | admin + 页面授权 | 搜索已转义正则；`console.log` 裸打身份（FE-07，已修） |
| 11 | 指纹管理 | admin 读 / superadmin 写 | 抽样；未见新增问题 |
| 12 | 系统管理 | 读 admin / 写 superadmin | 后台标签页仍轮询烧配额（FE-04，已修） |
| 13 | 商店管理 | admin + 页面授权 | 抽样；未见新增问题 |
| 14 | 抽奖管理 | admin + 页面授权 | 抽样；`window.confirm` 风格不一致（FE-06，部分修） |
| 15 | FBI 数据管理 | admin + 页面授权 | 抽样；未见新增问题 |
| 16 | LibreChat 管理 | admin 读 / 删 superadmin | 抽样；未见新增问题 |
| 17 | Webhook 管理 | superadmin 专属 | 前端导出 CSV 未中和公式注入（FE-01，已修） |
| 18 | 篡改检测演示 | superadmin 专属 | 抽样；未见新增问题 |
| 19 | 人机验证控制台 | 读 admin / 写 superadmin | 功能最完整的模块之一；`/ip-ban-stats` 只有聚合值（FEA-01 的来源） |
| 20 | 政策同意记录 | superadmin 专属（页面授权为空） | **导出 CSV 未中和公式注入**（SEC-03，已修）；导出计数头未暴露（SEC-01，已修） |
| 21 | B 站数据管理 | superadmin 专属 | 只有读接口、无删除接口；`removeBilibiliCookieReport` 是死代码（FEA-02，已修） |

---

## 1. 缺陷与改进清单

### SEC-01（跨域可用性 / 中）自定义响应头未列入 CORS `exposedHeaders`

- 位置：`src/middleware/corsMiddleware.ts:43-50`
- 现状：`CORS_EXPOSED_HEADERS = [Content-Length, X-RateLimit-Limit, X-RateLimit-Remaining,
  Content-Disposition, Content-Type, Cache-Control]`。
- 而前端与后端在这几处靠**自定义头**传数据：
  | 响应头 | 设置位置 | 读取位置 |
  |---|---|---|
  | `X-Audit-Log-Export-Count` / `X-Audit-Log-Export-Max-Rows` | `src/routes/auditLogRoutes.ts:59-60` | `frontend/src/api/auditLog.ts:135-137` |
  | `X-Export-Rows` / `X-Export-Truncated` | `src/controllers/admin/policyConsentLogController.ts:460-461` | `frontend/src/api/policyConsents.ts:163-164` |
  | `X-Total-Count` / `X-Page` / `X-Page-Size` / `X-Has-More` | `src/controllers/ticketController.ts:63-66` | `frontend/src/api/ticketApi.ts:106-109` |
  | `X-Require-Fingerprint` / `X-Fingerprint-Hash` | `src/routes/admin/index.ts:57-58` | `frontend/src/api/api.ts` |
  | `X-Policy-Document-Hash` | `src/controllers/policyController.ts:380` | 政策同意链路 |
  | `X-TTS-Watermark-Id` / `X-TTS-Asset-Expires-At` | `src/tts/tts.assetAccess.ts:245-247` | TTS 资产访问链路 |
- 影响：生产是同镜像同源（CORS 不生效），但**本地 dev（前端 3001 → 后端 3000）与任何跨域部署**下这些头
  都被浏览器挡在 JS 之外。前端一律有回退默认值，所以表现为**静默降级**：审计导出不显示条数、政策同意导出
  不显示"已截断"、工单分页总量/页码恒为默认值、指纹去重哈希拿不到。这类降级不会报警，只在出问题时才被发现。
- 去向：**已修**（提交 `a8484b00`）—— 把这 6 组头加进 `CORS_EXPOSED_HEADERS`（纯放开读取，不改变任何
  写入/放行判定）。

### SEC-02（ReDoS / 模式注入 / 中）用户输入直接进 `$regex`，未做正则转义

- 位置（同一类，四个文件）：
  - `src/services/outEmailService.ts:347`（`to`）、`:350`（`subject`）—— 超级管理员邮件溯源页
  - `src/services/bilibiliCookieReportService.ts:216-218`（`search`）—— B 站数据管理页
  - `src/services/bilibiliAccountService.ts:224-225`（`search`）—— B 站数据管理页
  - `src/controllers/adminController.ts:2483-2484`（`search`）—— B 站搜索记录
- 对照（已正确转义）：`src/services/auditLogService.ts:141,293`、`src/routes/admin/shortlinks.ts:57`、
  `src/services/translationLogService.ts:47-48`、`src/services/emailSuppressionService.ts:227`。
- 缺陷细节：MongoDB 的 `$regex` 用「被查询进程的 JS 正则引擎」执行，未转义的用户输入既会让 `.`/`*`/`+`
  这类元字符把"精确搜索"变成"任意匹配"（运营看到的结果与关键词不符），也能触发灾难性回溯
  （如 `(a+)+$` 打到长字段上）把 mongod 的 CPU 打满——这是一条**只需登录管理员账号**就能放的放大攻击。
- 修法：新增 `src/utils/regexEscape.ts` 作为单一实现，上述 4 处改用它。
- 去向：**已修**（提交 `c32c0a63`）。仓库里另有 6 处功能等价的私有转义副本（`auditLogService`、
  `crashReportQuery`、`proxycheckLogQuery`、`libreChatService`、`tts.history`、`adminUserListAggregation`、
  `humanCheckController`、`ticketController`）；它们**本来就正确工作**，统一替换属纯重构，为控制回归面
  本轮不动（见 §3）。

### SEC-03（合规 / 中）政策同意 CSV 导出未做公式注入中和

- 位置：`src/controllers/admin/policyConsentLogController.ts:251-256`（`csvCell`）
- 对照：`src/services/auditLogService.ts:301-312` 的 `csvCell` 已对 `/^[=+\-@\t\r]/` 前置单引号。
- 缺陷细节：政策同意记录里含 `userAgent`、`deviceFingerprint`、来源等**终端可控**字段。管理员导出 CSV 后
  用 Excel 打开，若某行以 `=`/`+`/`-`/`@` 开头，Excel 会当公式求值（CSV injection / DDE）。审计日志那边
  已经防住了，政策同意这边没有——同仓两套口径。
- 修法：与 `auditLogService` 完全对齐（同样的正则、同样的前置 `'`）。
- 去向：**已修**（提交 `a8484b00`）。

### SEC-04（一致性 / 低）命令存储把「查询值净化」套在「存储内容」上

- 位置：`src/services/commandStorage/mongo.ts:4-8`（`sanitizeString`）被 `addToQueue` / `addToHistory` 用于
  **命令正文**。
- 缺陷细节：该函数是为「值可能进 Mongo 查询」而写的 NoSQL 注入防御（拒绝含 `$ . { } [ ]` 的字符串）。
  但命令正文只被当作**字面量写库**，从不参与查询构造；`removeFromQueue` 已经先做了类型检查。
  结果是：`ls .`（参数含 `.`，且能通过 `commandService.validateCommand` 的参数白名单）会被
  `addToQueue` 以「命令内容非法」拒绝，**而 `COMMAND_STORAGE=file` 存根却能正常入队** —— 同一份代码
  在两个后端上行为不同，且错误文案指向"内容非法"而不是真正的原因。
- 修法：拆成 `normalizeCommandId`（会进查询条件，按字面量校验）与 `normalizeCommandText`（只写库，
  只做类型 + 长度边界），两个存根（mongo / file）统一使用同一份 `commandText.ts`。
- 去向：**已修**（提交 `909edf25`）。

### FUNC-01（前后端契约错位 / 高）`POST /api/command/p` 字段名不匹配，移除操作静默失败

- 位置：`src/routes/commandRoutes.ts:147-156`（后端读 `req.body.command`）
  对 `frontend/src/components/CommandManager.tsx:362-374`（前端发 `{ commandId }`）
- 缺陷细节：后端把 `undefined` 当 `commandId` 交给 `commandService.removeCommand`：mongo 存根在
  `sanitizeString(undefined)` 处抛「命令ID非法」并被内部 try/catch 吞掉 → HTTP 200 +
  `{status:"error"}`；file 存根静默返回 `false` → 同样 200。而前端**不看响应体**，直接
  `setCommandQueue(prev => prev.filter(...))` —— 于是 UI 上那一行消失了、提示"已从队列移除"，
  命令却仍留在队列里，下一次轮询又出现。
- 修法：后端同时接受 `commandId`（新）与 `command`（历史别名），缺参数按 400 拒绝、
  未命中按 404 返回，不再用 200 掩盖失败。
- 去向：**已修**（提交 `909edf25`，后端侧）。
  前端「只看 400/非 2xx、不看 `status` 字段就乐观更新本地队列」这点属于同一根因的另一半，
  但 `CommandManager.tsx` 本轮正被另一会话改造中，为免覆盖对方 WIP 未动（见 §3）。

### ROB-01（健壮性 / 中）未收敛的分页 / 条数参数

- 位置：
  - `src/routes/commandRoutes.ts:284`（`/history?limit=`）：`parseInt(...) || 50`，无上下界。
    负值 → Mongo `.limit(-n)` 直接抛错（路由返回 500）；`1e9` → 一次大查询 + 大 JSON。
  - `src/routes/apiKeyRoutes.ts:186`（`/api/apikeys/:keyId/billing/events?limit=`）：`Number(...) || 20`，同上。
  - `src/routes/ttsRoutes.ts:389`（`/clarity/history?limit=`）：同上。
- 对照（已收敛）：`src/services/outEmailService.ts:342-343`、`src/services/translationLogService.ts:32-33`、
  `src/services/bilibiliCookieReportService.ts:211-212`、`src/routes/admin/broadcast.ts:268-269`、
  `src/routes/qqGuardRoutes.ts:224-225`。
  **同一类参数在 5 处收敛、3 处不收敛**，说明缺一个共用工具而不是缺某一行代码。
- 修法：在既有的 `src/utils/httpParam.ts`（已有 `firstString`/`firstStringOr`，是这层语义的归口文件）里加
  `boundedInt(value, { min, max, fallback })`，上述 3 处改用它。语义：非数字 → fallback，越界 → 夹到边界。
- 去向：**已修**（提交 `909edf25`）。

### COR-01（正确性 / 低）`cpu_usage_percent` 把累计 CPU 时间当百分比

- 位置：`src/services/commandService.ts` `getServerStatus()`
- 缺陷细节：`(cpuUsage.user + cpuUsage.system) / 1_000_000` 是**进程累计 CPU 秒数**（`process.cpuUsage()`
  返回微秒），不是百分比：进程活得越久数值越大、永远单调递增，与"当前 CPU 使用率"无关；而前端在
  `CommandManager.tsx:537-580` 拿它做 20/50/80/95 四档告警判定，等于按进程存活时长报警。
- 修法：改为 `os.cpus()` 两次快照求差值（系统级占用率，钳到 0–100）；首次调用没有前一帧，
  退到 1 分钟负载均值 ÷ 核数（Windows 的 loadavg 恒为 0，那就给 0，不编数字）。字段类型保持
  `number`（同名同类型，前端两处 `.toFixed(1)` 不受影响）。
- 去向：**已修**（提交 `909edf25`）。

### FEA-01（功能缺失 / 中）IP 封禁只有统计，没有名单

- 位置：`src/services/turnstile/ipBan.ts`（只有 `getIpBanStats`）、`src/controllers/turnstile/statsHandlers.ts`、
  `src/routes/turnstileRoutes.ts:80-81`；前端 `frontend/src/components/IPBanManager.tsx`
- 缺陷细节：管理面只有 4 个数字（总数/活跃/过期/近期），**没有任何接口能列出被封的 IP**。
  于是封禁是"只写不读"的操作：误封了哪个网段、批量粘贴时哪一行格式错了、某个 IP 是因为自动判违规
  还是人工封的、什么时候到期——管理员全都看不到，只能靠再次输入同一个 IP 试解封来反推。
  这对「IP 封禁管理」这个模块本身是核心操作能力缺失，不是锦上添花。
  补充证据：前端的 `turnstileApi.getIPBanList`（`frontend/src/api/turnstile.ts:282`）**一直存在**，
  期望的正是 `/api/turnstile/ip-ban-list`，只是后端从来没有这个路由。
- 修法：
  - 新增 `listIpBans`（分页 + 关键词 + 状态筛选 + 排序白名单 + 全库 manual/auto 汇总）→
    `GET /api/turnstile/ip-ban-list`（`adminLimiter` + `authenticateAdmin` + `requireAdminScope`，
    与同页其他读接口同口径）；
  - `IpBanModel` 增 `source` 字段区分手工封与自动封（两者 `violationCount` 都会到阈值，事后无法归因），
    并补 `{bannedAt:-1, expiresAt:1}` 与 `{source:1}` 索引；读取侧把缺省的存量文档一律当 `auto`（保守方向）；
  - 前端把统计卡片下方补成完整名单表（搜索/状态筛选/排序/分页/逐条与批量解封/CSV 导出）。
- 去向：**已修**（后端 `6d24a16f`；前端 `aeeb3af4`）。

### FEA-02（合规 / 中）B 站凭据上报记录只能读不能删

- 位置：`src/services/bilibiliCookieReportService.ts:234`（`removeBilibiliCookieReport`）
- 缺陷细节：该函数**是死代码** —— 全仓没有任何路由/控制器引用。而 `/api/admin/bilibili-reports` 只有
  `GET`。B 站 cookie 上报是隐私敏感数据（密文入库、元数据可查），却没有任何删除路径：用户提出删除
  请求、或发现设备 id 被冒用时，管理员无从处理。
- 修法：新增 `DELETE /api/admin/bilibili-reports/:clientId/:deviceId/:uid`
  （`authenticateSuperAdmin` + `requireAdminScope` + 审计留痕，只按三元组精确删，不做批量通配；
  形态非法时由服务层 normalizer 抛错，不会退化成"删了半张表"）。前端在列表行上补删除入口。
- 去向：**已修**（后端 `6d24a16f`；前端 `1513d0af`）。

### FE-01 / FE-02（安全 / 合规 / 中）前端两处 CSV 导出未中和公式注入

- 位置：
  - `frontend/src/components/WebhookEventsManager.tsx:183-186`（`csvEscape`）
  - `frontend/src/components/admin/crash-reports/exporters.ts:4-7`（`csvCell`）
- 缺陷细节：webhook 事件字段由外部投递方控制，崩溃报告的 `cleanStack` / `rootCause` / `processName`
  由上报客户端控制；两处都只是 `"${value}"` 裸拼。管理员导出后在 Excel / WPS 打开即触发表格公式求值
  （CSV injection，可进一步走 DDE）。恰好与后端 `auditLogService.csvCell` 的既有防御相反。
  顺带发现：两处都用 `\n` 作行分隔且不带 BOM —— 简体中文 Windows 的 Excel 会按 GBK 解码出乱码。
- 修法：新增 `frontend/src/utils/csv.ts`（公式中和 + CRLF + BOM + 文件名时间戳），两处改用它；
  webhook 导出顺便补上记录 `id` 列，便于把导出结果对回数据库。
- 去向：**已修**（提交 `c628002b`）。

### FE-03（a11y / UX / 中）`DebugInfoModal` 缺对话框语义

- 位置：`frontend/src/components/DebugInfoModal.tsx`
- 缺陷细节：
  1. 无 `role="dialog"` / `aria-modal` / `aria-labelledby`；遮罩点击关闭但 Esc 不能关；无焦点管理
     （打开后 Tab 会跑到模态背后的页面元素上，关闭后焦点丢失）。
  2. 非管理员分支在**组件顶层**执行 `console.log`，每次父组件重渲染都打一行；且这一步发生在
     `isOpen` 判断之前（关着的时候也在写）。
  3. 只有"全量复制"，没有逐条复制/下载；条目多时无法搜索。
- 去向：**已修**（提交 `dd6d4fc2`）—— Esc 关闭 + 焦点回收 + dialog 语义 + 逐条复制 + 下载 JSON +
  关键词过滤 + 去掉 console.log；"复制全部"改为复制筛选后的结果。

### FE-04（性能 / UX / 中）`SystemManager` 轮询不判断页面可见性

- 位置：`frontend/src/components/SystemManager.tsx`（`useEffect` 里的 `setInterval(..., 30000)`）
- 缺陷细节：每 30s 无条件打 2 个接口。管理员把后台标签页留在那儿一整天，就白烧 ~5760 次请求
  （且每个请求都过 `adminLimiter` 配额，等于用后台标签页挤自己的额度）。同时没有"暂停自动刷新"开关，
  也没法把当前状态导出给排障用。
- 去向：**已修**（提交 `21dab312`）—— `document.hidden` 时不轮询并在页面上明示、回到前台立即补一次、
  自动刷新开关、导出状态 JSON。

### FE-05（UX / 中）IP 封禁批量输入无预览 / 无本地校验

- 位置：`frontend/src/components/IPBanManager.tsx`
- 缺陷细节：批量框只按行切分后直接提交。空行、重复行、明显非法的 token 都会原样发到后端；
  提交前也看不到"将封禁多少条、其中多少条重复/非法"。禁用按钮（非 superadmin）没有原因说明。
- 去向：**已修**（提交 `aeeb3af4`）—— 与后端同口径的前端预校验（`components/ip-ban/ipValidation.ts`）、
  「将提交 / 重复 / 非法」三个计数徽标、非法行原样列出、顶部与列表各一条权限说明。

### FE-06（一致性 / 低）`window.confirm` 与自绘模态混用

- 位置：`UserManagement.tsx`（4 处）、`SystemManager.tsx`（4 处）、`FingerprintManager.tsx`（3 处）、
  `ShortLinkManager.tsx`（3 处）、`LotteryAdmin.tsx`（2 处）、`AnnouncementManager.tsx` / `EnvManager.tsx` /
  `CommandManager.tsx`（各 1 处），共 19 处。
- 缺陷细节：同一套后台里两种二次确认体验；`window.confirm` 在移动端不可定制、不支持危险操作高亮、
  在部分嵌入式 WebView 里会被屏蔽而**静默返回 false**（等于点了没反应）。
- 去向：**部分修** —— 本轮新增/改动的危险操作（IP 名单逐条/批量解封、B 站上报删除）走组件化确认；
  存量 19 处不做一次性替换（跨 8 个文件、纯风格一致性，收益低于回归风险），见 §3。

### FE-07（日志卫生 / 低）短链管理路由用 `console.log` 裸打管理员身份

- 位置：`src/routes/admin/shortlinks.ts:19-31`、`:331-352` 等 52 处
- 缺陷细节：打印 `req.user.id` / `username` / `role` / `req.ip` 以及 AES 加解密每一步
  （生成密钥、生成 IV、IV 十六进制、各段长度）。这些信息本来要写审计，但不应该以 `console.log`
  的形式散在业务路径上（绕过 logger 的结构化脱敏，也不受日志级别控制）。
- 去向：**已修**（提交 `0a6efb0e`，两条主路径）。文件里其余 12 处 `console.*`（创建/删除等
  次级处理器）未动，见 §3。

### FE-08（功能缺失 / 中）「调试控制台」是死代码，日志没有跨组件出口

- 位置：`frontend/src/components/DebugInfoModal.tsx`、`frontend/src/hooks/usePasskey.ts:41-46`
- 缺陷细节：`usePasskey` 把 Passkey 注册/登录的每一步都写进自己的 `debugInfos` state，
  `DebugInfoModal` 也早就写好了 —— 但**全仓没有任何组件 import 那个弹窗**（`rg DebugInfoModal`
  只命中定义本身），而 `debugInfos` 只是某个组件内部的 hook state，管理页拿不到另一个 hook 实例的
  state。于是模块列表里的「调试控制台」实际不存在，现场诊断能力等于零。
- 修法：
  - 新增 `frontend/src/utils/passkeyDebugLog.ts`：模块级内存单例（上限 200 条、刷新即清空、不落盘
    —— 里面可能有 credential id / options 摘要），用 `useSyncExternalStore` 供任意组件订阅；
  - `usePasskey.addDebugInfo` 额外 append 一份到该单例（hook 自身 state 语义不变，登录链路只多一次调用）；
  - 新增 `/admin/debug-console` 页面（指标 + 可筛选记录流 + 弹窗查看 + 清空），注册进 `adminModules`、
    `navConfig`（`requiredRole: 'superadmin'`）与后端 `src/config/adminPages.ts`（`apiPrefixes: []`：
    页面不发管理端 API，因此只能授权给超管，fail-closed）。
- 去向：**已修**（提交 `dd6d4fc2`）。

### FEA-03（可用性 / 低）审计日志无筛选预设

- 位置：`frontend/src/components/AuditLogViewer.tsx`
- 缺陷细节：筛选维度有 18 个（模块/动作/角色/结果/IP/状态码/耗时区间/关键字…），但每次进页面都从空白开始。
  值班复盘几乎总是重复同样几组条件（"今天的失败"、"今天的写操作"、"慢请求 ≥1s"）。
- 修法：新增 `frontend/src/utils/auditLogPresets.ts`（内置 4 条 + 自定义预设，localStorage 上限 12 条，
  读回时按显式白名单逐字段收窄），页面加一排「快速筛选」chip：一键套用 / 存为预设 / 删除 / 清空筛选。
  日期按本地 `YYYY-MM-DD` 生成，与页面 `type="date"` 输入同格式（用 ISO 串会让输入框显示为空）。
- 去向：**已修**（提交 `106a636a`）。

### FEA-04（功能缺失 / 中）管理总览缺系统级概览

- 位置：`frontend/src/components/AdminDashboard.tsx`（原本只渲染邮件溯源 + AdminHub）
- 缺陷细节：想回答「现在多少用户被停用 / 多少 Key 被停用 / 最近一天多少失败请求 /
  封了多少 IP」得逐个页面点进去看。
- 修法：新增 `services/adminOverviewService` + `GET /api/admin/overview`（四类跨集合计数
  并行取，任一集合不可用返回 `null` + `warnings` 而非 0；页面登记为 `overview`，
  刻意不进默认普通管理员页面集合），前端新增 `AdminOverviewPanel`（403 时整块隐藏）。
- 去向：**已修**（提交 `88ff84ef`）。

### LOT-01（并发正确性 / 高）抽奖参与是「读-改-写整体覆盖」，并发下会丢中奖记录

- 位置：`src/services/lotteryService.ts` 的 `participateInLottery`
- 缺陷细节：流程是「读轮次 → 判断是否已参与 → 扣奖品库存 → 整体回写
  `participants` / `winners` / `prizes`」。两个并发请求（双击、两个设备、两个用户同时抽）
  各自读到同一份旧快照，后写的那次**整体覆盖**前一次 —— 前一位的中奖记录被静默抹掉，
  库存也可能被重复扣减。G7-08 补上了"落库"，但落库本身不是原子的。
- 修法：新增 `sharedStateStore.withLock(key, ttl, fn)`（复用既有 claim/release 原子申领，
  Redis → Mongo → 进程内存三级降级），参与动作按轮次维度串行；落库前再读一次轮次，
  挡住"同一用户重复参与"与"奖品已被抢空"这两种可判定状态（锁只覆盖本实例）。
- 去向：**已修**（提交 `d4f4f3d1`）。

### LOT-02（信息外泄 / 中）抽奖全部 500 分支把 `error.message` 回给调用方

- 位置：`src/controllers/lotteryController.ts`（11 处）
- 缺陷细节：`/api/lottery/blockchain`、`/rounds`、`/leaderboard` 等**任意登录用户可调**，
  而 500 统一返回裸 `error.message` —— Mongo/驱动的内部细节（集合名、索引冲突、
  provider 响应片段）会漏出去。
- 修法：500 统一通用文案 + 服务端记日志；参与抽奖那条 400 分支做区分：
  业务拒因（已参与过 / 已结束 / 奖品领完 / 人机验证失败）原样透出，其余收敛。
  顺带修掉 `/leaderboard?limit=` 的裸 `parseInt`（负值让 Mongo `.limit()` 抛错）。
- 去向：**已修**（提交 `d4f4f3d1`）。

### LIB-01（破坏性操作缺门控 / 中）`DELETE /admin/users/guests` 无需任何确认参数

- 位置：`src/routes/libreChatRoutes.admin.ts`
- 缺陷细节：该端点不接收任何参数，却可以直接清掉**全部**游客遗留历史；同文件的
  `/admin/users/all` 早要求 `confirm: true`，这里漏了。
- 修法：要求显式 `confirm: true`（400 提示），前端调用同步补上。
- 去向：**已修**（提交 `4b12ff7e`）。

### FING-01（可用性 + 输入边界 / 中）指纹上报的 `deviceSignals` 无边界

- 位置：`src/controllers/turnstile/fingerprintHandlers.ts`
- 缺陷细节：客户端可把任意大的对象塞进 `deviceSignals`，原实现原样写进用户文档；
  每人保留 20 条，累积足以把文档推到 Mongo 的 16MB 上限 —— 之后该用户的任何
  `updateUser` 都会失败。**纯客户端可触发**的可用性问题。
  另外指纹 id 只查了 `typeof === "string"`（长度/字符集不限，而仓库里早有
  `validateFingerprint` 可用），5 处 `console.log` 把 canvas / navigator 明细、
  IP、UA 与即将落库的整条记录全量打了出来。
- 修法：只保留 `screen` / `timezone` / `canvas` / `navigator` / `window` 五个分组，
  单组序列化超 4KB 时降级为 `{ truncated, bytes }`；指纹 id 走 `validateFingerprint`
  （长度 8–200 + `[A-Za-z0-9_-]`，SHA-256 抛错的 base64 兜底路径先剔字符再校）；
  UA 截 512；调试日志收敛成两条结构化 logger。
- 去向：**已修**（提交 `6363ac2d`）。

### STORE-01（可用性 / 低）商店仪表盘用假 0 掩盖统计失败

- 位置：`frontend/src/components/AdminStoreDashboard.tsx`
- 缺陷细节：取统计失败时写入 `{resources:0, cdks:0}`（注释写的是"防止组件崩溃"），
  管理员会以为商店是空的；同类问题在 `AdminDashboard` 的邮件溯源块也存在
  （普通管理员调 superadmin 专属接口必然 403，`Promise.allSettled` 的回退值渲染成 0）。
- 修法：失败时保留 `stats = null`、卡片显示「—」+ 明确提示，功能入口不受影响；
  邮件溯源块改为按角色决定是否请求。
- 去向：**已修**（提交 `6363ac2d`，`AdminDashboard` 部分在 `88ff84ef`）。

### FE-09（一致性 / 低）74 处原生 `confirm` 未收口（跨整个前端）

- 位置：`frontend/src/**` 共 36 个文件
- 缺陷细节：除了上一轮的 26 处，全仓另有 74 处 `window.confirm`（含
  `components/env-manager/**` 下 21 个配置分区）。除了样式不一致，更实际的问题是
  部分嵌入式 WebView 会屏蔽原生确认框并**静默返回 false**（表现为"点了没反应"），
  且破坏性操作没有任何视觉分级。
- 修法：全部改走 `components/confirm/ConfirmDialogProvider`；转换时保留原文案原文进
  `description`，补标题 / 危险态 / 确认按钮文案；同作用域多处确认用 `ok` / `okAgain`
  区分；`await` 落到非 async 函数的几处（`MarkdownExportPage.clearContent`、
  `MobileNav` 两个 handler）一并改成 async。
  全仓 `window.confirm` 现在为 **0**（provider 自身的兜底实现与测试除外）。
- 去向：**已修**（提交 `ac07f7f7` / `4b12ff7e` / `6d0c21ae`）。
  备注：曾尝试一次性 codemod 批量转换，产出把 `if (!ok) ) return;`、把 import 插进
  多行 import 块中间等破损形态 —— 已整体回滚改为按文件转换 + 逐份 `git diff` 核对
  （含"每个 `await confirm` 都有对应 import 与 hook""括号增量与 HEAD 一致"两道静态断言）。

---

## 2. 本轮改动（按提交）

| 提交 | 内容 | 关联编号 |
|---|---|---|
| `909edf25` | `httpParam.boundedInt` + 3 处条数收敛；`/command/p` 字段名兼容与 400/404；`commandStorage` 拆查询值与正文校验；`cpu_usage_percent` 改真实采样；队列加 200 条上限 | ROB-01, FUNC-01, SEC-04, COR-01 |
| `c32c0a63` | 新增 `utils/regexEscape`，4 处未转义 `$regex` 改用它 | SEC-02 |
| `88ff84ef` | 管理总览新增 `GET /api/admin/overview` + 概览面板（跨集合计数、失败不显示 0） | FEA-04 |
| `d4f4f3d1` | 抽奖并发加锁 + 500 不再回裸 error + `/leaderboard` limit 收敛 | LOT-01, LOT-02 |
| `4b12ff7e` | 24 处 confirm 迁移；B 站/LibreChat guest 清理加服务端 confirm 门控 | FE-09, LIB-01 |
| `6363ac2d` | 指纹上报输入边界与日志卫生；商店仪表盘不再用假 0 | FING-01, STORE-01 |
| `6d0c21ae` | 前端原生 confirm 清零（最后 36 个文件） | FE-09 |
| `6c484167` | 正则字面量转义收敛到 `utils/regexEscape` 单一实现（18 处） | SEC-02 |
| `a8484b00` | 政策同意 CSV 公式注入中和；CORS `exposedHeaders` 补齐 | SEC-03, SEC-01 |
| `6d24a16f` | IP 封禁名单接口（service + model.source + controller + route）；B 站凭据上报精确删除接口 | FEA-01, FEA-02 |
| `0a6efb0e` | 短链管理两条主路径 `console.log` → 结构化 logger | FE-07 |
| `c628002b` | 前端 `utils/csv.ts` 共用导出工具，替换 webhook 与崩溃报告两处 | FE-01, FE-02 |
| `aeeb3af4` | `ip-ban/BanListPanel` 名单视图 + `ip-ban/ipValidation` 批量预览；`api/turnstile` 名单客户端 | FEA-01, FE-05 |
| `dd6d4fc2` | `passkeyDebugLog` 单例 + `/admin/debug-console` 页面 + `DebugInfoModal` a11y 与逐条复制/下载/筛选 | FE-08, FE-03 |
| `21dab312` | 系统管理页可见性轮询 + 自动刷新开关 + 状态导出 | FE-04 |
| `1513d0af` | B 站上报列表删除入口（组件化确认 + a11y） | FEA-02 |
| `106a636a` | 审计日志筛选预设（内置 4 条 + 自定义，localStorage 上限 12） | FEA-03 |

---

## 3. 未修 / 待办（明确不静默消失）

| 编号 | 内容 | 不修理由 |
|---|---|---|
| SEC-02（残留 1 份） | `src/services/emailService.ts:187` 仍有一份私有的 `escapeRegExp` | 该文件本轮全程由另一会话改造（工作树为脏），不代改对方在飞工作；它的实现与共用版等价，不影响正确性 |
| — | `AdminDashboard` 的邮件溯源块 | 已改为按角色决定是否请求；若希望普通管理员也能看到那块数据，需要后端放宽 `/api/outemail/*` 的权限口径，属产品决策 |
| — | `DataCollectionManager` / `TamperDetectionDemo` / `FBIWantedManager` / `LibreChatAdminPage` 的剩余行 | 本轮已逐行走过路由层守卫（`routeModules/*.ts` 声明 + `routeGovernance` 校验）、参数边界、破坏性操作门控与错误文案四类；未发现新缺陷，故不改动。"逐行读完但结论是没问题"与"没看"在文档里必须能区分，这里属于前者 |
| — | 抽奖的用户记录计数器竞态 | 同一用户在不同轮次并发参与时，`updateUserRecord` 的读-改-写仍可能丢计数（只影响排行榜统计，不影响奖品库存与中奖记录）。修复需要按用户维度再加一层锁，收益低于复杂度 |
| — | 新增接口的 CI 验证 | 本机不构建/不测试；以 `main` 上 workflow 结论为最终裁决者（本机只做括号/结构静态检查与逐份 diff 核对） |

## 4. CI 实测与存量红灯归因

本轮改动推送后（`c14ac5b6`）在各 job 上的实际结论：

| Job | 结论 | 说明 |
|---|---|---|
| `type-check` / `type-check-frontend` / `type-check-backend` | ✅ success | 首轮曾因 `DebugConsole.tsx` 的 `{ action, timestamp, ...entry }` 展开顺序报 TS2783（`PasskeyDebugEntry` 带索引签名），前端 type-check、Node verification、Docker 镜像构建、前端体积预算四个 job 一起红 —— 单点编译错连坐，已改写成展开在前、显式字段在后（`c14ac5b6`） |
| `Frontend bundle budget` | ✅ success（含 `Enforce frontend bundle budget` 步骤，非 skipped） | 本轮新增约 1500 行前端代码未撞预算 |
| `Governance checks` / `Mongo replica integration` / `Browser cookie smoke` | ✅ success | 含源码体积闸门、隐私契约、openapi 漂移、admin SPA 路径漂移 |
| `CodeQL Analyze (javascript / typescript / python)` | ✅ success | 本轮新增路由/服务未引入新的 code scanning 告警 |
| `Publish Docker (amd64)` | ✅ success | |
| `Node verification` | ❌ failure（**存量，与本轮无关**） | 见下 |

**存量红灯归因（按方法论"同一 job 在父提交上的历史结论"举证）**：

- `Node verification` 自 `f41a346d`（`feat(admin-scope): ...`，本会话之外的提交）起连续 10 个提交均为 `failure`；
  更早的 `13c0188f` / `bef397c3` / `7e2409d1` 均为 `success`。
- 逐提交比对：在本轮第一个提交之前（其父提交 `4659ce35`）与同一时期提交 `2b696e66` 上，该 job 的失败
  **签名与计数完全一致** —— `Test Suites: 3 failed, 1 skipped, 151 passed, 154 of 155 total` /
  `Tests: 2 failed, 2 skipped, 1444 passed, 1448 total`，失败的三个套件也相同：
  `recommendationService.test.ts`、`cacheService.test.ts`、`authRoutes.test.ts`。
  本轮推送后仍是同一组 → **本轮改动没有新增/减少任何失败**。
- 三条根因均在并发会话的改动范围内，与本审计的 21 个模块无关：
  - `authRoutes.test.ts` 整套件加载失败：`TypeError: argument handler must be a function`，位置是
    `src/routes/authRoutes.ts:271` 的 `authMobileLoginLimiter`（该文件的移动端登录限流器由
    `da80d741` 引入）；
  - `recommendationService.test.ts`：`历史不足 10 条时降级为热门推荐` 期望 2 条、实得 5 条
    （`UserPreferencesModel` 替身缺件，属 `2b696e66` 的推荐服务改动）；
  - `cacheService.test.ts`：`buildKey 统一补 cache: 前缀并丢弃空片段`（同属 `2b696e66` 新增的缓存层）。
- 因此本轮**不把它们算作自己的失败、也不代改**：三处都在并发会话正在改动的文件上，替对方回滚或猜测语义
  容易把别人的在飞工作改坏（`AGENTS.md`：别人的 WIP 既不入自己的提交也不代为回滚）。
  并发会话随即在 `edc64697`（`fix(recommendation): 纯热门路径不再用内置默认风格补位，并修 buildKey 断言`）
  里自行修了其中的两项，也从侧面印证了归因。

