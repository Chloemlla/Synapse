# 2026-10-03 审计 — 中 / 低严重度条目处置记录

> 本文件记录 2026-10-03 前后端全量审计七份报告中**中 / 低严重度**条目（共 117 行）的处置结果，
> 对应提交 `44d1b5ef`
> （`fix(audit): 修复 2026-10-03 审计全部中/低缺陷并挂载 4 组孤儿路由`）与补修提交 `9645b041`
> （`fix(audit): 补修中/低避让条目 F2-22、F2-23`），两者均已签名、已推送 `main`。
> 117 条最终 **101 条已修 + 9 条已顺带修复 + 7 条误报**，无遗留避让条目。
>
> **核验口径**：逐条**回读当前工作树源码**，确认缺陷描述的行为是否已消失，不采信修复代理的自述报告。
> 判定来源为逐条核验明细（含 `文件:行` 依据），本文件按该明细落盘。
>
> 总索引与阻断 / 高条目（94 条）的处置见 [`audit-2026-10-03-index.md`](./audit-2026-10-03-index.md)；
> 那 94 条已在 `e31ca36d`（第一批：全部 49 条阻断）、`5f07ca90`（第二批：高 + `B2-01`）、
> `245d26d6`（第三批：高）三批内处置。七份报告本身由 `fc84eb38` 落盘。

---

## 1. 总账

| 指标 | 数值 |
|---|---|
| 中 / 低条目总行数 | 117 |
| 仍存在 → 已修 | 101 |
| 仍存在 → 避让未修 | 0 |
| 已顺带修复（更早批次或另一会话已修，本批未动） | 9 |
| 误报（复核后不成立，登记撤销） | 7 |

**按报告拆分**：

| 报告 | 条目数 | 已修 | 避让未修 | 已顺带修复 | 误报 |
|---|---|---|---|---|---|
| B1 `backend-api` | 17 | 12 | 0 | 0 | 5 |
| B2 `backend-domain` | 13 | 12 | 0 | 1 | 0 |
| F4 `ui-admin` | 22 | 21 | 0 | 1 | 0 |
| F1 `ui-auth-2fa` | 16 | 15 | 0 | 1 | 0 |
| F3 `ui-core` | 27 | 24 | 0 | 2 | 1 |
| F5 `ui-tools` | 5 | 5 | 0 | 0 | 0 |
| F2 `ui-verification` | 17 | 12 | 0 | 4 | 1 |
| **合计** | **117** | **101** | **0** | **9** | **7** |

本批改动范围：**前端 78 个组件 + 后端 23 个文件**（含 1 处用例替身修正，
`src/tests/authSessionService.test.ts`）。

### 与任务口径的差异（如实登记）

任务简报给出的是「仍存在 → 已修 101」，等于七份报告里判定为「仍存在」的行数之和
（12 + 12 + 21 + 15 + 24 + 5 + 12 = 101）。首轮提交 `44d1b5ef` 只落地了其中 99 条：
**F2-22、F2-23** 涉及的 `FirstVisitVerification.tsx`、`useSecureCaptchaSelection.ts` 当时正被
另一会话改写，按「不触碰他人未提交文件」的边界**明确避让**，未纳入该批（历史记录见 §3.2）。

待该会话的改动落库后，这两条已在补修提交 `9645b041` 中完成（见 §2.7），
超时/网络异常的英文 `AbortError` 不再透出界面、`FirstVisitVerification.tsx` 的英文文案全量中文化。
因此 **117 条至此全部处置完毕，无遗留避让条目**。

---

## 2. 逐条处置

状态词口径：`已修` = 该条缺陷描述的行为已在提交 `44d1b5ef`（或补修 `9645b041`）的工作树中消失；
`已顺带修复` = 更早批次或另一会话已修，本批未动；`误报` = 复核后原判不成立；
`本轮避让未修` = 行为仍存在，因文件被占用未在本批处理（**本批为 0 条**）。

### 2.1 B1 `backend-api`（17 条）

| ID | 严重度 | 处置 | 处置说明/依据 |
|---|---|---|---|
| B1-01 | 中 | 已修 | `media-tool-admin-routes` 模块自身 middlewares 里的重复 `adminLimiter` 去掉（`/api/admin` 挂载层已覆盖该前缀），`rateLimitPolicy` 改 `mixed` 注明「继承自 `/api/admin` 挂载」，同一实例不再计数两次、admin 额度不再减半。 |
| B1-02 | 中 | 已修 | qqGuard 三个写端点（`POST/DELETE /qq-guard/whitelist`、`POST /qq-guard/commands`）挂 `authenticateSuperAdmin`；只读端点保持 `admin` 档。 |
| B1-03 | 中 | 已修 | `GET /qq-guard/commands` 的 `recentCommands()` 入参钳到 `Math.min(num(req.query.limit, 50), 200)`（`listAudits` / `pending` 已由服务层钳制，无需再动）。 |
| B1-04 | 中 | 已修 | `nexaiAuthController` 新增 `clientErrorMessage()`：显式带 `statusCode` 的业务错误照常回可控文案，未预期异常记 `logger.error` 后回固定中文；21 处 5xx 不再透传 `error.message`（GitHub 回调重定向同样收口）。 |
| B1-05 | 中 | 已修 | `passkeyRoutes` 三处（:267/:336/:487，同类 :136/:163/:604）500 改固定中文，不再回 `error?.message` / `errorMessage`。 |
| B1-06 | 中 | 误报 | 该处位于 `/register/start` 的 `authenticateToken` + `requireTwoFactorConfigSession` 之后，`options`（含 challenge）本就在成功响应中合法返回给同一用户；`sanitizeLogValue` 会按 key 正则把 password/token/credential 打码。不构成「凭据材料外泄」。 |
| B1-07 | 中 | 已修 | `artifactController` 的 get/update/delete（连同 create/list）500 分支改固定中文；`isArtifactValidationError` 分支仍正确回 400 且带原始 message。 |
| B1-08 | 中 | 误报 | `ArtifactService.updateArtifact` 按显式字段逐一读取（title/visibility/description/tags/password/expiresInDays），`...req.body` 中的 `owner`/`userId`/`shortId` 等额外键被完全忽略，不存在越权赋值。 |
| B1-09 | 中 | 已修 | 控制器与 `ArtifactService.listArtifacts` 双双把 limit 钳到 `Math.min(Math.max(x, 1), 100)`，`?limit=1000000` 不再原样下推。 |
| B1-10 | 中 | 已修 | `imageDataController` 四个端点 500 改固定中文，不再回 `error.message`。 |
| B1-11 | 中 | 已修 | `coinFlipController` 四个方法 500 统一改固定「服务器错误」，不再回原始异常文本。 |
| B1-12 | 中 | 误报 | `CoinFlipService.listCoinFlipResults` 入口即 `clampPageSize`（`Math.min(value, 100)`）并以 `clampPage` 兜 NaN，控制器不钳上限也拉不到全表。 |
| B1-13 | 中 | 误报 | `parsePage` 的 5 个调用点下游服务全部 `Math.max(1, page \|\| 1)` + `Math.min(100, pageSize…)`，`?page=abc` 的 NaN 与超大 pageSize 都在服务层被中和。 |
| B1-14 | 中 | 已修 | 公开创建短链端点 500 改固定文案并加 `logger.error`，不再回 `error.message`（409 分支保持原样）。 |
| B1-15 | 中 | 已修 | `ttsProviderController` 新增 `describeFetchError()`，把 undici 的 `error.cause` 展平进 `logger.warn`（并抹掉可能出现的 `Bearer` 令牌），不再只留 `fetch failed`。 |
| B1-16 | 低 | 误报 | `readCaptchaQuotaHistory` 入口已 `Math.min(QUOTA_HISTORY_MAX_MONTHS(24), Math.max(1, Math.round(months)))`，`?months=100000` 不会触发超长区间。 |
| B1-17 | 低 | 已修 | 4 个「零挂载」路由文件按产品决策**挂载而非删除**，登记进 `earlyModules`；详见 §4。 |

### 2.2 B2 `backend-domain`（13 条）

| ID | 严重度 | 处置 | 处置说明/依据 |
|---|---|---|---|
| B2-02 | 中 | 已顺带修复 | 由另一会话对 `ipRiskService.ts` 的未提交改动加入 `describeError()`（展平 `cause` 后经 `redactSecret`），非本批提交；本批未触碰该文件。**残留**：同文件批量路径的 `redactSecret(error.message, apiKey)` 仍丢 `cause`。 |
| B2-03 | 低 | 已修 | `ipTelemetryService` 新增 `describeFetchError()`，`catch` 内展平 `cause` 后再记日志。 |
| B2-04 | 低 | 已修 | `mobileIntegrityService` 两处 `catch`（换 access token、decode token）同样改走 `describeFetchError()`，不再只留 `fetch failed`。 |
| B2-05 | 中 | 已修 | 重复 `purchaseToken` 的日志改为只记 `purchaseTokenHash`（`sha256` 前 16 位），完整凭据不再进 `logs/combined.log`。 |
| B2-06 | 中 | 已修 | `getUsageDay` 改用 `Asia/Shanghai` 的 `Intl` 日键，与风控侧 `currentDayKey` 同一口径，额度不再在北京时间 08:00 归零。 |
| B2-07 | 低 | 已修 | `recordView` 由 `findOne → save()` 读-改-写改 `findOneAndUpdate` + `$inc: { viewCount: 1 }` + `$set: { lastViewedAt }` 原子写。 |
| B2-08 | 低 | 已修 | CDK 消耗后「资源不存在」分支补回滚：条件 `updateOne`（带 `usedAt` 精确定位）复位 `isUsed`、清 `usedAt`/`usedIp`/`usedBy`。 |
| B2-09 | 低 | 已修 | `highRiskRegions` 由 `["Unknown","Anonymous"]` 改为与 `ip.ts` 哨兵一致的 `["未知","非法IP","内网"]`，原先永不命中的死分支恢复生效。 |
| B2-10 | 低 | 已修 | `buildAnonymousScopeKey` 改返回 `sha256(`${ip}::${fingerprint}`)` 前 24 位，IP + 指纹不再明文落库。 |
| B2-11 | 低 | 已修 | `listPublished` / `listAdmin` 各补 `.limit(500)`。 |
| B2-12 | 低 | 已修 | 三处（客户许可证列表、许可证 activations、发布构建列表）各补 `.limit(200)`。 |
| B2-13 | 低 | 已修 | `listAuthDevices` 查询补 `.sort().limit(500).lean()`；顺带修正 `src/tests/authSessionService.test.ts` 的用例替身缺 `limit`。 |
| B2-14 | 低 | 已修 | `ProductionServiceBase` 的 `executeOperation` / `executeQuery` 两处 `Promise.race` 计时器改为在 `finally` 里 `clearTimeout`，不再悬挂。 |

### 2.3 F4 `ui-admin`（22 条）

| ID | 严重度 | 处置 | 处置说明/依据 |
|---|---|---|---|
| F4-14 | 中 | 已修 | 14 处确认框标题由泛化「确认执行该操作？」改为「动作 + 对象」；ApiKeyManager 的吊销/删除改以 Key 名 + 短 keyId 指代（不再裸 keyId）。 |
| F4-15 | 中 | 已修 | UserManagement 行内删除/批量/提交改用独立 `actionBusy`，`fetchUsers` 增 `silent` 参数，操作时不再把整表替换成「加载中」。 |
| F4-16 | 中 | 已修 | 空态按 `hasActiveFilters` 分档：筛选无结果显示「没有符合当前筛选条件的用户」+「清除筛选」按钮。 |
| F4-17 | 中 | 已修 | 引入 `isFormDirty`（对比 `formBaseline`）+ `confirmDiscardIfDirty`；取消/切换行/新建前做脏检查并确认，成功保存走 `resetFormState` 不触发确认。 |
| F4-18 | 中 | 已修 | 7 个文件（UserManagement / AuditLogViewer / DataCollectionManager / IntegrationsHealthPanel / BroadcastManager / BilibiliSyncAdmin / ip-ban BanListPanel）用 `useSearchParams` 双向同步筛选/页码/排序，刷新与分享不再丢状态。 |
| F4-19 | 中 | 已修 | 6 个自建遮罩层（UserManagement 指纹弹窗、EnvManager、WebhookEventsManager、EmailTraceability、DataCollectionManager、qq-guard TimelineDrawer）补 `role="dialog"` + `aria-modal` + `aria-labelledby` 与 Esc 关闭。子项 `admin/CrashReportManager.tsx`「弹窗」经全历史 `git log -S` 核对为**误报**：该文件从无 overlay，详情页已处理 Escape。 |
| F4-20 | 中 | 已修 | BanListPanel 删除自建确认层，解封/批量解封改接站内 `useConfirm`，确认键文案改「解封」。 |
| F4-21 | 中 | 已顺带修复 | 由第二批 `5f07ca90` 给 `Notification` 加 `role`/`aria-live` 并把错误类时长由 3s 提到 8s。 |
| F4-22 | 中 | 已修 | Webhook 状态、qq-guard 事件/裁决、EcoEnchants 审计结果与风险等级、UserManagement 的 `authProvider`、RuntimeConfig 的 `GOOGLE_CLIENT_ID`/`NEXAI_GOOGLE_CLIENT_ID` 等建中文映射，原始枚举降为 `title`/hint。AdminScopeManager 的「ID 旁附用户名」部分见 §3.1。 |
| F4-23 | 中 | 已修 | UserFormControls（TextField/SelectField/CheckboxField）、env-manager ConfigFieldRow、RuntimeConfigSections.FieldLabel、MailSystemConfigManager.FieldLabel、DataCollectionManager 用 `useId` + `htmlFor` 关联 label 与控件。 |
| F4-24 | 中 | 已修 | ApiKeyManager 的 `apiJson` 不再把 HTTP 状态码写进用户可见文案（改「服务端暂时不可用，请稍后重试」等），原始状态码只进 console。 |
| F4-25 | 中 | 已修 | `forbidden` 分支不再 `return null`，改渲染说明「需要『系统概览』页面授权，请联系超级管理员开启」的占位面板。 |
| F4-26 | 中 | 已修 | 命令面板加 Tab / Shift+Tab 焦点环，焦点不再逃出 `aria-modal` 弹窗。 |
| F4-27 | 中 | 已修 | 面板右上角加带 `aria-label='关闭命令面板'` 的可点关闭按钮。 |
| F4-28 | 中 | 已修 | `handleInvalidateCache` 与 `handleFlushMemory` 接 `useConfirm`，写明缓存前缀/清空范围与后果。 |
| F4-29 | 中 | 已修 | CommandManager 文案由「最后更新」改「最近一次同步」，不再把前端取响应时刻冒充服务端采样时间（EnvManager 子项已在 `245d26d6` 引入 `envsLoadedAt` 修复）。 |
| F4-30 | 中 | 已修 | AdminHub 消费原先悬空的 `scopeLoading`，授权未到达时渲染骨架占位，不再先按回退集合闪卡片。 |
| F4-31 | 中 | 已修 | EcoEnchantsOpsPanel 两处与 EcoEnchantsAdminPage 一处确认框标题改为具体动作 + 对象（如「恢复备份『…』？」「吊销授权『…』？」）。 |
| F4-32 | 中 | 已修 | BilibiliDataAdmin 卡片标签由「本页记录」改「记录总数」，与 `pagination.total` 口径一致。 |
| F4-33 | 低 | 已修 | 媒体工具「清除」按钮接 `useConfirm`，写明「清除后 B 站下载按游客请求走，很容易撞 412」。 |
| F4-34 | 低 | 已修 | 非超管分支补原因说明 + 「返回管理总览」`Link to='/admin'`，不再死胡同。 |
| F4-35 | 低 | 已修 | 面包屑回退链改为「中文名 → 模块 key」：借助页面授权清单取 `label`，未登记模块不再直落 `admin-scope` 这类内部段。 |

### 2.4 F1 `ui-auth-2fa`（16 条）

| ID | 严重度 | 处置 | 处置说明/依据 |
|---|---|---|---|
| F1-10 | 中 | 已修 | 9 个遮罩层（TOTPVerification、TOTPSetup、BackupCodesModal、PasskeyVerifyModal、PenaltyAppealHost、PenaltyAppealActions、TOTPManager、RevealPasswordModal、ui/CredentialIdModal）补 `role="dialog"` + `aria-modal` + `aria-labelledby` 与 Esc 关闭。**Tab 焦点陷阱未做**，见 §3.1。 |
| F1-11 | 中 | 已修 | EstablishSecuritySession 的密码/恢复码/动态验证码三个输入补 `<label htmlFor>` + id，「当前密码」由 `div` 改 `label`。 |
| F1-12 | 中 | 已修 | MobileLoginPanel 设备 ID 输入补 `<label htmlFor="client-device-id">设备 ID</label>`。 |
| F1-13 | 中 | 已顺带修复 | 由第二批 `5f07ca90` 收敛为「通行密钥 (Passkey)」「动态验证码 (TOTP)」，与 `EstablishSecuritySession` 的叫法对齐。 |
| F1-14 | 中 | 已修 | 注册页邮箱字段下方常驻「只支持主流邮箱：<域名列表>」并 `aria-describedby` 关联，白名单规则不再只在提交失败后出现。 |
| F1-15 | 中 | 已修 | 登录/注册引入 `invalidFields` 状态，`aria-invalid` 只随字段自身错误；「未勾选条款」「未过人机验证」等非字段错误不再污染无辜输入框。 |
| F1-16 | 中 | 已修 | 验证失败改为按因素在对应卡片内联 `role="alert"` 错误，不再只靠 3 秒即消失的 toast。 |
| F1-17 | 中 | 已修 | 6 处裸 `fetch`（EmailVerifyPage、LinuxDoAuthCallbackPage、ForgotPasswordPage、ResetPasswordPage、ProviderBindPage、EstablishSecuritySession）各内联 `AbortController` + 15s 超时，超时进入可重试错误态。 |
| F1-18 | 中 | 已修 | 验证方式选择器空态补「前往账户安全设置」`Link to='/profile'`。 |
| F1-19 | 低 | 已修 | 去掉「记住我」复选框的英文 `aria-label="Remember my username"`，沿用可见中文 label。 |
| F1-20 | 低 | 已修 | 去掉验证码输入的英文 `aria-label="Verification code"`，沿用可见「验证码」label。 |
| F1-21 | 低 | 已修 | RevealPasswordModal 关闭按钮补 `aria-label="关闭"`。 |
| F1-22 | 低 | 已修 | 英文 eyebrow/副标题中文化：登录页「欢迎回来 / 账号登录 / 管理员入口」、注册页「创建账号 / 新账号」、找回密码「密码重置」、重置链接页「安全重置链接」、通行密钥弹窗「通行密钥验证」、OAuth 授权页「应用 / 账号 / 授权范围」与「共 N 项」。 |
| F1-23 | 低 | 已修 | 找回密码成功态补「重新发送重置链接」（复用 `handleSubmit`，必要时先重过人机验证）。 |
| F1-24 | 低 | 已修 | TOTP 帮助文案补支持邮箱链接 `support@chloemlla.com`。 |
| F1-25 | 低 | 已修 | TOTPSetup 复制密钥加 try/catch，剪贴板被拒时提示「复制失败，请手动选择密钥后复制」，不再无条件报成功。 |

### 2.5 F3 `ui-core`（27 条）

| ID | 严重度 | 处置 | 处置说明/依据 |
|---|---|---|---|
| F3-12 | 中 | 误报 | `LoadingSpinner` 的 compact 分支自带 `role="status" aria-label="加载中"`（该写法自 2026-05-26 `d9661bdc` 起就存在，早于审计），原判「无无障碍名称」不成立；仅「无可见文字」这半句成立。 |
| F3-13 | 中 | 已修 | TTSForm「输入文本 / 输出格式 / 语速 / 生成码」四处补 `htmlFor` + 控件 `id`，与「语言」下拉的包裹写法统一。 |
| F3-14 | 中 | 已修 | ProductQueryForm 四个输入补 `htmlFor` + `id`（`product-query-<key>`）。 |
| F3-15 | 中 | 已修 | 导入弹窗补 `role="dialog"` + `aria-modal` + `aria-labelledby` + Esc + 打开移焦 + Tab 焦点陷阱 + 关闭焦点回归。 |
| F3-16 | 中 | 已修 | 校验/接口错误横幅补 `role="alert"`。 |
| F3-17 | 中 | 已修 | 标签筛选空态补「清除筛选」按钮、首用空态补「去生成语音」（新增 `onGoGenerate`，TtsPage 侧落焦到输入框）。**筛选仍未接入 URL**（finding 的次要诉求），见 §3.2。 |
| F3-18 | 中 | 已修 | 历史条目 `<audio>` 补 `onError`，失败显示「音频加载失败…请稍后重试，或点击下载保存后本地播放」。 |
| F3-19 | 中 | 已修 | TtsPage 结果播放器补 `onError` 与 `role="alert"` 失败提示，`audio.play().catch` 不再静默吞错。 |
| F3-20 | 中 | 已修 | AudioPreview 失败态渲染 `role="alert"` 文案 + 「重试」按钮，不再恢复初始外观。 |
| F3-21 | 中 | 已修 | SpeechToTextPage `loadJobs` 失败落 `jobsError`，渲染可重试错误态，不再伪装成首用空态「还没有任务」。 |
| F3-22 | 中 | 已修 | 后端原始任务日志收进默认折叠的 `<details>技术详情`，主界面只给阶段与结论。 |
| F3-23 | 中 | 已修 | 商店英文/内部术语改中文（可兑换 / 已拥有 / 验证状态 / 价格 / 管理员豁免 / 未启用），原值降为 `title`。 |
| F3-24 | 中 | 已修 | CDK 兑换输入框补 `<label htmlFor="cdk-redeem-input">`（`sr-only`）+ `id`。 |
| F3-25 | 中 | 已修 | 重复资源弹窗补 dialog 语义 + Esc + Tab 焦点陷阱 + 焦点回归。 |
| F3-26 | 中 | 已修 | 提交按钮去掉 `!complete` 的 `disabled`，未勾选时由按钮 handler 的 `setShowInvalid(true)` 给出「请先勾选全部条款」提示。 |
| F3-27 | 中 | 已修 | SecurityScorecardPanel 反转优先级：默认回人话「安全总览加载失败，请稍后重试。」，原始异常只进 console。 |
| F3-28 | 中 | 已修 | ProfileSidebarSummary 在 `profile === null` 时显示「未知」，不再把未加载当成「正常」。 |
| F3-29 | 中 | 已修 | DeviceSessionsPanel 按钮 `title` 随 `securitySessionActive` 分档（「验证后退出此设备」/「退出此设备全部会话」）。 |
| F3-30 | 中 | 已修 | Footer 拉取失败态补「重试」按钮（自增令牌重跑 effect），不再只能整页刷新。 |
| F3-31 | 中 | 已修 | ProductDetails 英文 eyebrow「Verification Result」改「验证结果」。 |
| F3-32 | 中 | 已修 | TtsGenerationManager 错误块补「重试」按钮；空态区分「筛选无结果」并给「清除筛选」，不再与「暂无记录」混同。 |
| F3-33 | 低 | 已修 | 去掉 PrivacyConsentPanel 暴露条文指纹 hash 的 `title`（hover 不再显示原始哈希）。 |
| F3-34 | 低 | 已顺带修复 | 由第二批 `5f07ca90` 给撤回/删除成功 notice 加 `role="status" aria-live="polite"`。 |
| F3-35 | 低 | 已修 | ProductDetails 的 `<dt>`/`<dd>` 容器由普通 `div` 改 `<dl>`。 |
| F3-36 | 低 | 已修 | DeviceSessionsPanel 把「未找到位置 / 获取位置时出错」单独显示为「定位失败」，与「未知」区分。 |
| F3-37 | 低 | 已顺带修复 | 由第二批 `5f07ca90` 给 PromptModal 加 document 级 Esc 监听、Tab 焦点陷阱、关闭焦点回归与 `role="dialog" aria-modal`。 |
| F3-38 | 低 | 已修 | 导入弹窗顶部英文 eyebrow「Import URL」改「导入链接」。 |

### 2.6 F5 `ui-tools`（5 条）

| ID | 严重度 | 处置 | 处置说明/依据 |
|---|---|---|---|
| F5-41 | 中 | 已修 | EmailSender `validateEmails` 的 catch 改返回 `serviceError: true`，上层单独提示「邮箱校验服务暂不可用，请稍后重试」并可重试，不再与「邮箱格式无效」走同一分支。 |
| F5-42 | 中 | 已修 | DeepLX 桌面端与移动端两处交换语言按钮补 `aria-label="交换源语言与目标语言"` + `title`。 |
| F5-43 | 中 | 已修 | AgeCalculatorPage 的 `updateDayIfNeeded(year, month)` 改用「本次变更后的新值」重算上限，月份天数变少时 `birthDay` 正确回落，不再出现无匹配 option。 |
| F5-44 | 中 | 已修 | LogShare 日志列表补三态：加载骨架、内联错误 + 「重试」、空态「暂无上传记录，先上传一条日志。」，不再只靠 3 秒 toast。 |
| F5-45 | 低 | 已修 | 自动复制链接成功后真正 `setCopied(true)`（失败则 `setCopied(false)` 并改 warning 提示），「已自动复制」提示不再恒为假。 |

### 2.7 F2 `ui-verification`（17 条）

| ID | 严重度 | 处置 | 处置说明/依据 |
|---|---|---|---|
| F2-20 | 中 | 已修 | 验证通过态补「继续访问」链接，目标沿用全站既有 `redirectTo` 查询参数（仅接受站内相对路径，缺省 `/`），不再只能返回首页。 |
| F2-22 | 中 | 已修 | `useSecureCaptchaSelection.ts` 的 `catch` 改为按 `AbortError`（含 `DOMException`）分档：超时回「请求超时，请稍后重试」、其余回「验证服务暂不可用，请稍后重试」，原生英文 `message` 不再 `setError`（补修提交 `9645b041`）。 |
| F2-23 | 中 | 已修 | `FirstVisitVerification.tsx` 全部用户可见英文文案（`Traffic review`、`Checking your browser`、`Reload challenge`、`Session context`、页脚与要点列表等 44 处）中文化；协议枚举值（`challenge`/`token`/`turnstile`/`hcaptcha`/`trycap`）与 `className`/`aria-*`/动画结构不动（补修提交 `9645b041`）。 |
| F2-24 | 中 | 已顺带修复 | 由另一会话的未提交改动把「Network scan / Session token」等实现细节改写为普通用户文案（不再属协议细节）。 |
| F2-25 | 中 | 误报 | 该行渲染的是 `fingerprintPreview`，值为 `${fingerprint.slice(0,10)}...${fingerprint.slice(-6)}`（自 `b2d33796` 起就是这样），从来不是 hash 原文；原判「直接展示原文」不成立（唯一残留是未做折叠）。 |
| F2-26 | 中 | 已修 | CapWidget `loadScript()` 补 15s 超时；load / error / 超时三者只落定一次，超时移除仍挂起的脚本并复位全局状态，重试时 load 事件能再触发。 |
| F2-27 | 低 | 已修 | trycap 静默 rearm 期间补「正在重试，请稍候…」`role="status" aria-live="polite"` 提示。 |
| F2-29 | 中 | 已修 | 手动「重试」按钮不再被 `retryCount >= maxRetries` 门控，失败即可点（自动退避重试并行保留）。 |
| F2-30 | 低 | 已修 | 「隐私 · 条款」由纯 `<span>` 改真实 `Link to='/policy'`，可点观感与实际行为一致。 |
| F2-31 | 中 | 已顺带修复 | 与 F2-12 同一缺陷，由第二批 `5f07ca90` 补 `listError` 行内错误条 + 重试、空态以 `!loading && !listError` 门控。 |
| F2-32 | 中 | 已修 | SmartHumanCheckTraces 两个 Portal 弹窗补 `role="dialog"` + `aria-modal` + `aria-labelledby` + Esc 关闭 + 焦点进入/回归。 |
| F2-35 | 中 | 已顺带修复 | 与 F2-15 同一缺陷，由第二批把所有 `alert()`/`String(error)` 弹窗换成站内通知 + 中文文案。 |
| F2-36 | 中 | 已顺带修复 | 与 F2-16 同一缺陷，由第二批给「禁用」「紧急恢复」加 `useConfirm` 二次确认并写明影响范围。 |
| F2-37 | 中 | 已修 | FingerprintManager 补 `loadError` 行内错误条 + 重试，失败时不再渲染空表 + 全 0 统计。 |
| F2-38 | 低 | 已修 | FBIWantedPublic 错误时隐藏空态（`error ? null : …`），错误横幅补「重试」按钮，两态不再并列矛盾。 |
| F2-39 | 低 | 已修 | 搜索输入补 300ms 防抖，请求只跟防抖后的值走，不再每次击键即发。 |
| F2-40 | 低 | 已修 | CaptchaVerificationExample 的 `alert()` 改内联 `role="status"` 成功提示（该文件无任何 import 方，属示例/死代码，实际影响面为零）。 |

---

## 3. 本轮明确登记的残留（未完全达成，不静默丢弃）

### 3.1 任务简报已登记的残留

- **F4-22（`admin/AdminScopeManager` 部分）**：原建议「`userId` 旁附用户名」**未做**。
  `AdminScopeConfigService.perUser` 与模型 `perUser` 只有 `Record<userId, string[]>` / `Map<userId, string[]>`，
  后端未返回用户名，补用户名属后端改动、超出本批文件范围。本批改补了「一键复制 userId」按钮与 `title`，
  便于管理员拿去核对是哪位普通管理员。
- **F2-28 的 PoW 未 Worker 化**：上一轮（`5f07ca90` 批次）已登记，本批未动。
- **F1-10 的 9 个遮罩层**：只补了对话框语义 + Esc + 焦点进入/回归，**未做 Tab 焦点陷阱**
  （成本较高，按 finding「低成本能做到就做」的口径处理）。相关文件在改动处亦留了「焦点陷阱/回归未做」注释。
- **`Footer.tsx` 一处多余依赖（`ipRetryToken`）**：F3-30 的重试令牌被 `useEffect` 依赖数组引用，
  属既非接口失败也未阻塞：仓库无前端 ESLint、Biome 不扫前端、`tsc` 不报错。**登记不修**。

### 3.2 本批核验时另行发现、同样登记

- **F2-22、F2-23（历史遗留，已闭环）**：首轮核验（HEAD = `44d1b5ef`）判定「仍存在」，
  当时因文件被另一会话占用而避让；已在补修提交 `9645b041` 完成，此处保留记录，
  以免与 §1 的口径说明对不上。
- **F3-17 的「筛选接入 URL」半部分未做**：本批补了空态出口动作（清除筛选 / 去生成），
  但 `TtsHistoryList` 的 `tagFilter` 仍是组件内 `useState`，未写入 URL query，刷新/分享仍丢筛选。
  finding 的主诉求（空态不知是「真没有」还是「被筛掉」）已解决，此半部分登记为未达成。

### 3.3 越界同类问题（未登记，本批未修，仅记录）

`src/services/userService.ts:630`、`src/utils/userRepository.ts:273`、`:276` 仍用
`new Date().toISOString().split("T")[0]` 做「日切」，与已修的 `B2-06`（TTS 配额日切口径：`toISOString()` 恒 UTC，
而进程 `TZ` 为 `Asia/Shanghai`）属**同类日期口径问题**。但这三处**未被本次审计登记**，
按「只修已登记缺陷」的边界本批未动，此处仅在文件层面登记。

---

## 4. B1-17 的处置：挂载而非删除（产品决策）

原报告判「四个路由文件零挂载、不受任何中间件/鉴权/限流保护」。2026-10-04 用户决策为
**挂载并补齐登记**（不删除、不搁置），据此处置：

- 4 个文件 `src/routes/analyticsRoutes.ts`、`recommendationRoutes.ts`、`invitationRoutes.ts`、
  `workspaceRoutes.ts` 登记进 `src/routes/routeModules/earlyModules.ts`，前缀分别取
  `/api/analytics`、`/api/recommendations`、`/api/invitations`、`/api/workspaces`，
  字段按该文件既有写法补全（`name` / `path` / `router` / `requiresAuth` / `rateLimited` / `isPublic` /
  `authPolicy` / `rateLimitPolicy`）。
- **澄清原报告偏差**：这 4 个路由**内部**本就逐条挂了 `authenticateToken`
  （`recommendationRoutes` 的 `GET /popular` 除外），并各自用 `createLimiter` 建了**路由级本地限流器**
  （`analyticsLimiter`/`exportLimiter`、`recommendationLimiter`/`analyzeLimiter`、`invitationLimiter`、
  `workspaceLimiter`/`inviteLimiter`），因此并非「完全无鉴权 / 无限流」，
  原先只是「未挂到任何相位」导致这些保护链路不可达。
- **挂载时不重复应用任何限流器**：吸取 `B1-01` 的教训（同一实例挂两层会让额度减半），
  在 `rateLimitPolicy` 中显式记 `mode: "route"` 并注明「路由内自带限流器，挂载层不再叠加，
  同一实例永不重复计数」。
- **公开面标记**：`recommendationRoutes` 的 `GET /popular` 有意公开、`POST /analyze` 走
  `optionalAuthenticateToken`，故该组 `isPublic: "mixed"`、`requiresAuth: "mixed"`，其余三组为 `false`/`true`。
- **OpenAPI 漂移闸门不受影响**：`scripts/generate-openapi.js` 与 `scripts/check-openapi-drift.js` 都是按
  `src/routes/**/*.ts` **文件**扫描生成与对账，不按挂载关系，故挂载不会改动 `openapi.json`，
  也不会触发 `check:openapi-drift`。

---

## 5. 验证方式

按仓库 `AGENTS.md` 与 `CLAUDE.md` 的硬性约束，**一切编译、类型检查与测试只由 GitHub Actions 执行**，
本地不做构建 / 测试 / 装依赖。本批提交的 CI 结论见对应 workflow run。

提交前另做了一次「逐 hunk 静态核验」：对每个改动块核对其新增/引用的标识符是否存在（悬空标识符检查）、
新增 import 是否可解析、被改动的可见文案是否命中既有测试断言。据其发现顺带修正了
`src/tests/authSessionService.test.ts` 的用例替身——服务端 `listAuthDevices` 新增了
`.sort().limit(500).lean()` 链，而原替身缺 `limit`，会在调用点抛 `TypeError`。

`44d1b5ef` 落地后 CI 的 `check:ts-file-size` 闸门亮红：本次改动使
`UserManagement.tsx`（1487 → 1605）与 `WebhookEventsManager.tsx`（1500 → 1540）越过 1500 行上限。
按该闸门自身给出的「split or reduce」口径，把两个组件顶部的纯常量、类型与 URL/标签工具函数
外移到 `frontend/src/components/user-management/userManagementShared.ts` 与
`frontend/src/components/webhook-events/webhookEventsShared.ts`（提交 `34e7cf8e`），
两文件行数回到 1452 / 1458，导出名与运行时逻辑均不变。

---

*本文件按七份 2026-10-03 报告的「中 / 低」严重度行逐条落盘，共 117 行 / 7 张表。
如需核对某条的原始判据与证据行号，请回到 `audit-2026-10-03-index.md` §1 对应的分领域报告。*
