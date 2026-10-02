# 第三方登录 / 绑定：前后端 UI/UX 全面优化 — 审查与改动清单

> 依据 `F:\Repositories\GitHub\verified-methodology.md`（阶段 1 只做静态审查、禁本地构建/测试，最终以 CI 为准）。
> 范围：第三方（Google / Linux.do）**登录入口 → 未绑定身份的绑已有账号页 → 个人主页的绑定/解绑/合并**全链路。
> 基线：`main`（HEAD `7e2409d1`，工作树干净）。审查方式：逐文件通读 + 调用链 `rg` 反查 + 历史归因（`git log -S`），未运行任何构建/测试。
> 相邻已有工作：`7e2409d1` 已把封停拒绝统一到 `403 + code: ACCOUNT_SUSPENDED`（后端服务层 + `sendProviderAuthFailure` + 前端 `maybeEmitPenaltyAppealFromResponse`）。本清单**不重复**该笔已修项，只处理其未覆盖的 UX 断点。

## 一、结论摘要

链路的**安全骨架是好的**（PKCE、state 单次消费、一次性 ticket、fragment 藏令牌、绑定需安全会话 + 验密）。
本轮问题集中在 **UX 断裂**：个人主页的第三方账号管理界面在 `29384a62`（2026-07-15「deeper UI splits」）被整段删除，只留下 handler/state/ref —— 用户**没有任何入口**可以绑定或解绑第三方账号；以及 **Linux.do 未绑定身份无法进入绑定页**（fragment/query 契约不一致）。

其中 PB-F01、PB-B02 是**功能性断裂**（点了没反应 / 页面直接报错），其余为一致性与打磨。

## 二、发现清单

| 编号 | 严重度 | 位置 | 类型 | 状态 |
|---|---|---|---|---|
| PB-F01 | 严重 | `frontend/src/components/UserProfile.tsx` | 整块功能缺失（`29384a62` 删 JSX 留死代码） | ✅ 已修 |
| PB-B02 | 严重 | `providerBindSessionService.buildProviderBindPageRedirect` × `ProviderBindPage` | fragment/query 契约不一致，Linux.do 绑定页必失败 | ✅ 已修 |
| PB-F03 | 高 | `frontend/src/components/LoginPage.tsx` | 文案与真实行为不符（承诺"自动创建本地账户"） | ✅ 已修 |
| PB-F04 | 中 | `frontend/src/components/user-profile/profileHelpers.ts` | raw fetch 未接申诉分类器（封停无申诉入口） | ✅ 已修 |
| PB-B01 | 中 | `src/controllers/linuxDoAuthController.ts` `exchangeTicket` | 无 try/catch，封停/异常退回裸 500 | ✅ 已修 |
| PB-B04 | 中 | `src/services/providerBindSessionService.ts` | 密码错误不计数，同一 bind token 可无限试密 | ✅ 已修 |
| PB-B03 | 中 | `providerHandlers.getProviderBindSession` vs `confirm` | 同一"会话过期"两种状态码（404 / 410） | ✅ 已修 |
| PB-F05 | 中 | `ProviderBindPage.tsx` | 无密码可见性/忘记密码/禁用原因/冲突引导 | ✅ 已修 |
| PB-F08 | 中 | `LinuxDoAuthCallbackPage.tsx` | bind `conflict` 只弹错误、无出路 | ✅ 已修 |
| PB-F06 | 低 | `GoogleAuthButton.tsx` | 绑定令牌走 query（应走 fragment）；无 aria-live | ✅ 已修 |
| PB-F07 | 低 | `LinuxDoAuthButton.tsx` | 无加载态；后端 503 JSON 会裸露 | ✅ 已修 |
| PB-F09 | 低 | `ProfileSidebarSummary.tsx` | 绑定数来自未补默认项的数组；账户状态显英文 | ✅ 已修 |

---

### PB-F01 — 个人主页的第三方账号管理界面整段消失（严重）

- **位置**：`frontend/src/components/UserProfile.tsx`
- **类型**：功能缺失 / 死代码。
- **证据**：`git log -S"linkedAccountsSectionRef"` → 只有 `200b0a62`（引入）与 `29384a62`（拆分）。`29384a62` 的 diff 里删掉了 `ref={linkedAccountsSectionRef}` 与整个 `第三方账号` 卡片（含绑定/解绑/合并预览按钮），同时新增 `ProfileSidebarSummary` 并在原位置插入它，**但没有把该卡片搬到任何新文件**（全仓 `rg -l "LinkedAccount"` 只剩 `UserProfile.tsx` / `profileHelpers.ts` / `ProfileSidebarSummary.tsx` 三个文件，后两者都不渲染操作按钮）。
- **后果**（当前 HEAD 实测，靠 `rg -n` 逐符号确认，全部只有"声明/定义"没有 JSX 引用）：
  - `linkedAccountsSectionRef`：只有 `useRef`(136) 与 `scrollIntoView`(1024)，**无 `ref=` 挂载** ⇒ 顶部「绑定第三方账号」按钮点了不滚动、不跳转，完全无反应。
  - `handleStartLinkedAccountBind`(838) / `handleUnlinkLinkedAccount`(872) / `handleOpenMergePreview`(895)：**从未被任何按钮调用** ⇒ 绑定、解绑、合并预览三条路都不可达。
  - `googleBindActive`(128) 只被 `handleStartLinkedAccountBind` 置真，而后者不可达 ⇒ **Google 绑定按钮的渲染 effect(783) 永不执行**，`googleBindButtonRef` 永不挂载。
  - `linkedAccountSummary`(1048) / `displayedLinkedAccounts`(1027) / `linkedAccountsLoading`(126) 计算后无人消费。
- **归因**：不是本次同步引入，是 2026-07-15 的存量回归；`ProfileSidebarSummary` 只显示"绑定账号数 + 状态文本"，替代不了操作。
- **改法**：按 `29384a62` 删除前的 JSX 还原第三方账号卡片（挂 `ref`、刷新、绑定/刷新/解绑/合并预览按钮、Google 内联按钮位），保留现有 `ProfileSidebarSummary`（信息摘要 + 操作卡片互补）。

### PB-B02 — Linux.do 未绑定身份进不了绑定页（fragment vs query）（严重）

- **位置**：`src/services/providerBindSessionService.ts:259` `buildProviderBindPageRedirect`、`frontend/src/components/ProviderBindPage.tsx:89`
- **类型**：跨端契约不一致（G2-38 的 fragment 改造只做了一半）。
- **证据链**：
  - `buildProviderBindPageRedirect` 把 token 写进 **fragment**：`url.hash = new URLSearchParams({ sessionToken }).toString()`（注释明说要避免进历史/Referer/日志）。
  - 它的调用方是 Linux.do 的两条"需要绑定"路径：`linuxDoAuthService.completeLinuxDoAuthorization:630`、`linuxDoAuthController.handleCallbackPayload:62`。
  - 但 `ProviderBindPage` 只读 **query**：`const sessionToken = searchParams.get("sessionToken")`；登录页的 `LinuxDoAuthCallbackPage` 有 `readCallbackHashParams/mergeCallbackParams` 处理自己的 fragment，**ProviderBindPage 没有对应逻辑**。
  - Google 一侧写 query（`GoogleAuthButton:158`），所以"Google 能进绑定页、Linux.do 进不去"。
- **后果**：Linux.do 首次登录（未绑定身份）→ 跳到 `/auth/provider/bind#sessionToken=…` → 页面报「缺少第三方登录绑定会话，请返回登录页重试」，用户永远无法完成绑定。
- **改法**：`ProviderBindPage` 同时接受 query 与 fragment（query 优先、fragment 兜底，与 `LinuxDoAuthCallbackPage` 同一套写法）；`GoogleAuthButton` 统一改走 fragment（令牌不进历史/Referer，与 G2-38 一致）。

### PB-F03 — 登录页承诺"首次登录自动创建本地账户"，后端实际要求绑定已有账号（高）

- **位置**：`frontend/src/components/LoginPage.tsx:471-478`
- **类型**：文案与行为不符（用户按文案注册会撞到"绑定已有账号"页）。
- **证据**：后端 `G2-03` 已明确"未绑定的第三方身份不再按邮箱静默并号，一律返回 requiresBinding"（`googleAuthService.startGoogleBindSession`），Linux.do 同理（`completeLinuxDoAuthorization` 在 `!boundUser` 时 `issueProviderBindSession`）。两条路径都不会创建新用户；`intent=register` 也不改变这一行为。
- **后果**：用户读到"首次登录自动创建本地账户"，实际上被要求输入既有账号密码，认知落差大、易放弃。
- **改法**：改为"使用 Google 账号登录；若尚未关联本站账号，将引导你绑定一个已有账户"。

### PB-F04 — 第三方相关的 raw fetch 仍漏申诉分类器（中）

- **位置**：`frontend/src/components/user-profile/profileHelpers.ts`
- **类型**：错误契约丢失。
- **证据**：`7e2409d1` 只给 `bindGoogleAccount`(333) 补了 `maybeEmitPenaltyAppealFromResponse`，同文件的 `fetchLinkedAccounts` / `startLinkedAccountBind` / `unlinkLinkedAccount` / `fetchAccountMergePreview` / `confirmAccountMerge` 全是 raw `fetch`，不经 axios 拦截器；被封停时 `authMiddlewareV2` 返回 `403 + ACCOUNT_SUSPENDED`，这些调用点只 `throw new Error(result.error)`，用户拿不到申诉入口。
- **改法**：统一在这 5 个失败分支调用 `maybeEmitPenaltyAppealFromResponse(result, res.status, '<source>')`。

### PB-B01 — `exchangeTicket` 无 try/catch，封停/异常退回裸 500（中）

- **位置**：`src/controllers/linuxDoAuthController.ts` `exchangeTicket`
- **类型**：错误处理缺失 / 契约不一致。
- **证据**：`consumeLinuxDoLoginTicket` 是 `async` 且上游可能抛（例如签发后账户被改状态、store 异常）；`exchangeTicket` 没包 try/catch，Express 5 下未捕获 rejection 直接 500，且不带 `code: ACCOUNT_SUSPENDED`，前端 `LinuxDoAuthCallbackPage` 的申诉分类器拿不到特征。
- **改法**：包 try/catch，封停走统一 `403 { code: ACCOUNT_SUSPENDED, supportEmail }`，其余 400/500 分档。

### PB-B04 — 绑定会话密码错误不计数（中）

- **位置**：`src/services/providerBindSessionService.ts` `confirmProviderBindSession`
- **类型**：暴力破解面 + UX 缺反馈。
- **证据**：密码错误时 `throw new Error("用户名/邮箱或密码错误")` 但**不删除、不计数** `providerBindSessions` 记录 ⇒ 持有一个 bind token 就能对目标账号持续试密，只有 IP 级 `loginLimiter` 兜底（换 IP 即绕过）。同时前端无法告知"还剩几次"。
- **改法**：记录 `failedAttempts`，超过阈值（5）即删除会话并抛"尝试次数过多"；错误文案带剩余次数。

### PB-B03 — 同一"会话过期"两种状态码（中）

- **位置**：`providerHandlers.getProviderBindSession`（404）vs `confirmProviderBind`（"已过期"→410）
- **类型**：状态码不一致。
- **改法**：`GET /provider-bind/session` 未知/过期统一 410 + 同一句文案，前端两处提示一致。

### PB-F05 / PB-F08 / PB-F06 / PB-F07 / PB-F09 — 交互打磨（中/低）

- `ProviderBindPage`：密码可见性切换、「忘记密码」入口、禁用原因提示、409 冲突给"换一个本站账号"引导、`aria-live` 播报错误。
- `LinuxDoAuthCallbackPage`：bind `conflict` 从"只弹错误"改成给出可操作说明（当前账号已绑定另一个 Linux.do 身份，需先在个人主页解绑）。
- `GoogleAuthButton`：令牌改 fragment、错误区加 `role="alert"`。
- `LinuxDoAuthButton`：点击后置加载态（避免重复点击/网络慢无反馈）。
- `ProfileSidebarSummary`：绑定数用"补过默认项"的完整列表；账户状态显示中文。

---

## 三、改动去向

见本文件同批提交（提交信息引用本清单路径）。逐条核对结果在收尾时回填。
