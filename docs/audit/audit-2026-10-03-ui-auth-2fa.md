# Nielsen 启发式审计 — 认证 / 2FA 前端

> 审计日期：2026-10-03 ｜ 模式：MODE-AUDIT（只读审查，未改动仓库文件）
> 方法论：`verified-methodology.md`（并行只读审查 → 先落盘发现 → 最小化修复）
> 同批报告：`audit-2026-10-03-ui-*.md`、`audit-2026-10-03-backend-*.md`；总索引 `audit-2026-10-03-index.md`。

审计范围：`frontend/src/components/` 下认证与 2FA 相关组件（27 个文件）+ 其直接引用的 `frontend/src/api/`。
判据：`F:\Repositories\GitHub\nielsen-heuristics-ui-design-prompt.md`（§3.1 反馈预算 / §3.2 状态矩阵 / §3.3 对比度与命中区 / §3.4 文案公式 / §4 H01–H10 / §6.2 B01–B14）。
视觉统一（studio* 主题收敛，2026-09-25 已完成）不在本次范围。

共 27 条：阻断 6、高 2、中 10、低 9。

| ID | 文件:行 | 启发式 | 严重度 | 证据（读到什么） | 用户影响 | 建议改法 |
|---|---|---|---|---|---|---|
| F1-01 | VerificationMethodSelector.tsx:251-301,306-356 | H03/B07 | 阻断(B07) | 两个验证方式卡片是 `motion.div` + `onClick`，无 `role`/`tabIndex`/`onKeyDown`；唯一可用键盘到达的是「取消」 | 同时启用 Passkey+TOTP 的账号（LoginPage.tsx:271-273 必定走此弹窗）键盘用户完全无法完成登录 | 卡片改成 `<button>`，或补 `role="button" tabIndex={0}` + Enter/Space 处理 |
| F1-02 | BackupCodesModal.tsx:215-218 | H09/B02 | 阻断(B02) | error 分支只渲染一段红字；拉取由 effect 触发，失败后无重试入口 | 恢复码加载失败只能关弹窗再开，用户不知道该怎么办 | error 分支加「重试」按钮，重新执行 fetchBackupCodes |
| F1-03 | TOTPSetup.tsx:60-64,175-179,296 | H09/B02 | 阻断(B02) | 生成 setup 失败后走 `setStep('setup')` 且 `setupData` 仍为 null，只显示红字；「验证并启用」因 `!setupData` 永久禁用 | 失败即死路，只能取消，TOTP 永远启用不了 | 失败态提供「重新生成」重跑 generateSetup |
| F1-04 | OAuthAuthorizePage.tsx:528-538,626,632,636-639 | H02/B05 | 阻断(B05) | 同意页正文直接渲染 `response_type=code`、原始 scope key、`scope.endpoints` 接口路径，以及「管理员识别字段 role / isAdmin / is_admin / synapseAdmin」 | 用户在授权决策点看到内部字段名与接口路径，无法据此判断授权含义 | 只留中文标签与描述；内部字段/端点收进可折叠 Details |
| F1-05 | TOTPManager.tsx:158-167 | H01/B09 | 阻断(B09) | 初始加载整区只有裸 spinner，无任何文字 | 账户安全页首屏 >1s 等待无操作说明 | 加「正在读取账户安全状态…」 |
| F1-06 | authStudioTheme.ts:49-50（应用于 LoginPage.tsx:422、RegisterPage.tsx:268,287、ResetPasswordPage.tsx:194,207、ResetPasswordLinkPage.tsx:229,242、ProviderBindPage.tsx:506） | ♿/B06 | 阻断(B06) | 密码可见性切换按钮自身被赋 `h-4 w-4`，命中区 16×16px | 触屏与低精准度用户点不中，容易误触旁边输入框 | 按钮加 `p-2` 使命中区 ≥24px，图标保持 16px |
| F1-07 | OAuthAuthorizePage.tsx:323；TOTPManager.tsx:213 | ♿/B06 | 阻断(B06) | 小号正文用 `text-slate-400`(#94a3b8)，白底约 2.9:1，低于 4.5:1 | 低视力用户读不清状态卡与摘要项标签 | 正文改用 slate-500/600 |
| F1-08 | RegisterPage.tsx:318 | H05/H01 | 高 | 提交按钮 `disabled` 条件含 `password !== confirmPassword`；页内「两次输入的密码不一致」只在 handleSubmit 内设置，而提交按钮已不可点 | 用户面对一个点不动的按钮，界面上没有任何原因说明 | 取消该 disabled 条件（按 Primer：不因表单无效禁用提交），或在密码框下方内联实时提示不一致 |
| F1-09 | LoginPage.tsx:317,546-548 | H03 | 高 | 关闭 VerificationMethodSelector/TOTP/Passkey 时把 `pending2FA`、`pendingVerificationData` 一并清空，无法重新打开验证步骤 | 误关验证弹窗后，必须重输密码、重勾四份条款、重过人机验证才能再来一次 | 关闭仅收起弹窗，保留 pending 状态并留一个「继续二次验证」入口 |
| F1-10 | TOTPVerification.tsx:111-131；TOTPSetup.tsx:124-138；BackupCodesModal.tsx:169-185；PasskeyVerifyModal.tsx:61-75；PenaltyAppealHost.tsx:57-70；PenaltyAppealActions.tsx:248-261；TOTPManager.tsx:361-376；RevealPasswordModal.tsx:53-64；CredentialIdModal.tsx:22-38 | H03/♿ | 中 | 这些遮罩/弹窗均无 Esc 关闭；除 RegisterPage 邮件弹窗（:368 有 role/aria-modal/aria-labelledby）外都缺 dialog 语义；关闭后不归还焦点 | 键盘用户无法用标准方式退出读屏不被播报为对话框 | 统一补 Esc + `role="dialog"`+`aria-modal`+`aria-labelledby` + 焦点归还；VerificationMethodSelector.tsx:54-68 已有 Esc 实现可复用 |
| F1-11 | EstablishSecuritySession.tsx:194-205,235-257 | H06/♿ | 中 | 密码/恢复码/TOTP 验证码三个输入只有 `placeholder`；上方「当前密码」是 `div` 而非 `label`，也无 `aria-label` | 读屏播报输入框无名称；输入后失去字段含义 | 用 `<label htmlFor>` 或补 `aria-label` |
| F1-12 | MobileLoginPanel.tsx:278-289 | H06/♿ | 中 | 「设备 ID」输入框既无 `<label htmlFor>` 也无 `aria-label`，仅 `placeholder="设备 ID（如已绑定）"`（上方令牌框有 label，形成反差） | 读屏无法辨识该框用途 | 补可见 label |
| F1-13 | LoginPage.tsx:485；VerificationMethodSelector.tsx:271,326；TOTPManager.tsx:187,263；EstablishSecuritySession.tsx:218 | H04/B13 | 中 | 同一因素多种叫法：登录页「通行密钥」、选择器「Passkey 验证」；TOTP 在 TOTPManager 叫「动态验证码」、选择器叫「动态口令 (TOTP)」、EstablishSecuritySession 叫「TOTP 验证码」 | 用户以为「动态验证码」与「TOTP 验证码」是两种东西 | 每个概念收敛为一个词：通行密钥 (Passkey)、动态验证码 (TOTP) |
| F1-14 | RegisterPage.tsx:105-106,137,256 | H05/H06 | 中 | 邮箱只接受 10 个域名白名单，但表单提交前只写「请输入邮箱地址」，规则句「只支持主流邮箱…」只在提交失败后出现 | 用其它域名邮箱注册的用户填完整个表单才被拒 | placeholder 或字段下方事先列出接受的邮箱类型 |
| F1-15 | LoginPage.tsx:406,419；RegisterPage.tsx:244,255,265,284 | H09/♿ | 中 | `aria-invalid={!!error}` 把「未勾选条款」「未过人机验证」这类非字段错误也标到用户名/邮箱/密码上 | 读屏把无辜字段报为无效，错误位置与来源不符 | 按字段各自的错误设置 aria-invalid，并用 aria-describedby 指向对应错误文案 |
| F1-16 | EstablishSecuritySession.tsx:106-114 | H09 | 中 | 验证失败只 `setNotification(...)`，无内联错误、无 `aria-live`；toast 3s 后消失（Notification.tsx:125） | 错过 toast 就不知道失败原因，也看不到恢复入口 | 在对应因素卡片内联错误并 `role="alert"` |
| F1-17 | EmailVerifyPage.tsx:50-79；LinuxDoAuthCallbackPage.tsx:157-171；ForgotPasswordPage.tsx:118-139；ResetPasswordPage.tsx:95-115；ProviderBindPage.tsx:168,257；EstablishSecuritySession.tsx:53 | H01/B09 | 中 | 这些 raw `fetch` 不走 axios（api.ts:81 的 15s timeout 覆盖不到），也没有 AbortController | 后端挂起时 loading 态无限持续，>10s 无取消，只能刷新整页 | 加 AbortController + 超时，超时后进入可重试的错误态 |
| F1-18 | VerificationMethodSelector.tsx:224-239 | H10 | 中 | 空态只写「请先在设置中启用验证方式」，无任何跳转入口，唯一按钮是「取消」 | 用户不知道「设置」在哪 | 加「前往安全设置」链接；该态在上游已被拦截，也可直接不渲染 |
| F1-19 | LoginPage.tsx:429 | H04/♿ | 低 | 「记住我」复选框 `aria-label="Remember my username"`，与可见中文标签不一致 | 读屏读出英文，与页面语言不符 | 改为「记住我」或删除（已有 `<label>`） |
| F1-20 | ResetPasswordPage.tsx:180 | H04/♿ | 低 | 验证码输入 `aria-label="Verification code"`（英文），可见标签是「验证码」 | 同 F1-19 | 改为「验证码」 |
| F1-21 | RevealPasswordModal.tsx:69-76 | ♿/B08 | 低 | 关闭按钮内容为裸字符 `✕`，无 `aria-label` | 读屏把关闭按钮读成「乘号」 | 换图标组件并加 `aria-label="关闭"` |
| F1-22 | LoginPage.tsx:326,329,339；RegisterPage.tsx:209,212,222；ForgotPasswordPage.tsx:182,217；ResetPasswordLinkPage.tsx:165；PasskeyVerifyModal.tsx:93；OAuthAuthorizePage.tsx:323,465,503 | H02/H04 | 低 | 中文界面里混排英文 eyebrow/副标题/状态卡：`Welcome back`、`Account Login`、`Reset Link Sent`、`Client/Account/Scopes`、`Items` | 语言不一致，中文用户需额外解码 | 统一中文，或明确作为品牌字串统一处理 |
| F1-23 | ForgotPasswordPage.tsx:202-208 | H09 | 低 | 成功态只有「返回登录」+「请检查垃圾邮件文件夹」，没有「重新发送」入口 | 邮件未收到时只能回登录页重走全流程 | 加「重新发送」按钮（复用 handleSubmit） |
| F1-24 | TOTPVerification.tsx:339 | H10 | 低 | 帮助文案「如果都没有，请联系管理员」，未给任何联系渠道 | 认证器与恢复码都丢失的用户没有出路 | 给出支持邮箱/申诉入口 |
| F1-25 | TOTPSetup.tsx:114-118 | H01 | 低 | `navigator.clipboard.writeText` 无 try/catch，剪贴板被拒时 Promise 未处理，仍只报成功 | 复制失败无任何反馈，用户粘贴到空内容 | try/catch 并提示失败 |
| F1-26 | AdminLogin.tsx:28-45,94-99 | H05/H01 | 低（当前未挂路由） | `handleSubmit` 无 loading/禁用态，可重复提交；错误写死「登录失败：用户名或密码错误」，丢弃后端原因（锁定/封停等） | 若被路由启用：重复提交、误导用户 | 补 in-flight 态并透出后端错误 |
| F1-27 | VerifyCodeInput.tsx:95-115 | H06/♿ | 低（当前未被引用） | 每个输入格无 `label`/`aria-label`/`aria-invalid`，错误仅一个纯文本 div | 读屏无法辨识 | 外层 `role="group"`+label，或每格补 aria-label |

## 已核实无缺陷的关键路径

- LoginPage 主登录：`aria-busy` + 按钮「登录中...」in-flight 态、失败不清空输入、captcha 失败后 `captchaRef.reset()`、尝试次数/锁定倒计时以 `role="status"` 展示（:448,289-296）。
- ProviderBindPage：loading/error/session 三态齐全；提交禁用时由 `submitHint` 明示缺什么；条款计数 N/4；会话剩余时间可见（:148-155,400,581-583）。
- PolicyConsentChecklist：已选 N/4 + 实时「全部勾选」+ 无效态红框与文字提示（:88,162-167）。
- EmailVerifyPage 错误态：列出四类可能原因并给出「重新注册」「返回登录」两条出路（:149-179）。
- WelcomePage：账号列表空态有文案，移除按钮 `h-8 w-8`（32px）+ `aria-label`（:304-312,159-166）。
- OAuthAuthorizePage 加载态用带文字的 UnifiedLoadingSpinner；同意/拒绝按钮各自有「正在同意…/正在拒绝…」in-flight 文案（:175,576-598）。
- Google / LinuxDo 按钮：`authenticating`/`redirecting` 态 + `aria-busy` + 文案切换（GoogleAuthButton.tsx:293-302、LinuxDoAuthButton.tsx:39-59）。
- TOTPVerification 输入校验：6 位/8 位正则校验 + 剩余尝试次数与锁定时长提示（:38-95）。
