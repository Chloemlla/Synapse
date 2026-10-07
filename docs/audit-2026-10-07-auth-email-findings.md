# 认证与邮件控制器审查清单（2026-10-07）

范围：`controllers/auth/*`、`emailController.ts`、认证与邮件 routes、`verificationService.ts`、`verificationTokenModel.ts`。依据为当前工作树静态调用链；未在本机执行构建、测试、lint 或安装依赖。实现前先由协调者审查此清单；本文行号对应修复前版本。

## AE-01 注册验证与安全通知错误使用一般发信日配额

- 位置：`src/controllers/auth/registrationHandlers.ts:116,244,293`；`src/controllers/auth/loginHandlers.ts:154,187`；`src/services/emailSender.ts:67-83`。
- 类型：配额语义错误。
- 证据：注册链接/旧验证码重发不声明 `checkQuota`，隐式走 `true`；欢迎、登录失败与锁定通知显式 `true`。无 userId 时统一以收件人邮箱+`verification` 记账，一般额度耗尽使注册返回“验证码发送次数已达上限，请明日再试”，也会丢失安全告警。密码找回已经是 `false`，行为不一致。
- 建议：认证事务邮件与一般管理员发信预算隔离；本组显式标注 `false`，核心组修默认值。保留 CAPTCHA、IP 限流及按收件人短时冷却；安全告警以收件人+事件独立冷却。
- 回归：一般配额为 0 时注册链接照常发；相同邮箱的短时间重复请求受限；欢迎及安全提醒不调用一般配额。

## AE-02 注册/找回邮件没有按邮箱的并发冷却

- 位置：`src/controllers/auth/registrationHandlers.ts:101-121`；`src/controllers/auth/passwordResetHandlers.ts:60-84`；`src/models/verificationTokenModel.ts:164-187`。
- 类型：并发、防刷生命周期。
- 证据：每次请求无条件创建独立随机令牌并发送，前置只有按 IP 的 route limiter 与 CAPTCHA；旧 `emailCodeMap` 的 60 秒冷却仅存在于已不产生初始状态的旧重发路径。多个 IP 或并发请求可向同一收件人反复寄信。
- 建议：新增 Mongo 原子收件人+用途短时预留，窗口内返回稳定 `EMAIL_SEND_COOLDOWN` 与 `retryAfterSeconds`/`Retry-After`；失败只释放当前预留，不删除新的并发记录。注册与找回各自独立，成功冷却按实际完成时间算。
- 回归：同邮箱并发只有一个发信；不同用途不互相锁死；超时后可重发；发送失败允许重试；旧请求释放不能覆盖新预留。

## AE-03 声明一个已停用 CAPTCHA 提供方可绕过认证防刷

- 位置：`src/controllers/auth/_state.ts:119-142`。
- 类型：认证验证绕过。
- 证据：当 policy.required=true，攻击请求只需提供非空 token 与未启用的合法 provider；即使 `verifyCaptchaChallenge` 返回 false，`!enabledProviders.includes(provider)` 分支仍返回 null。该公共 helper 用于注册、找回、登录等入口。
- 建议：全局策略不要求 CAPTCHA 时仍允许；只要策略要求，未知/停用提供方请求必须要求刷新验证，不可直接放行。
- 回归：仅 turnstile 启用时任意 hcaptcha token 被拒；正确启用提供方通过；所有提供方禁用时维持原策略。

## AE-04 一般邮件各入口配额口径和命名空间不一致

- 位置：`src/controllers/emailController.ts:168,301,422,553,660`。
- 类型：配额绕过、前后端统计不一致。
- 证据：send/simple/markdown 最多 10 个收件人但固定扣 1，batch 每个收件人扣 1；batch 按 fromDomain，其他入口 domain=undefined，切换接口或发件域名产生另一套预算，前端查询默认额度看不到 batch 使用量。
- 建议：一般发信统一按实际投递收件人数计入相同 userId 默认命名空间；发送前预留人数，抑制/未投递部分由核心返回 acceptedCount 后精确退还。可选 domain 查询不得代表其它入口默认配额。
- 回归：10 收件人扣 10；单发和批发共享预算；已抑制收件人不耗额度；只剩 1 时请求 2 被拒。

## AE-05 控制器异常路径漏退款，成功后异常也缺少结算边界

- 位置：`src/controllers/emailController.ts:183-230,307-340,427-478,559-609`。
- 类型：资源泄漏、错误补偿。
- 证据：只有 result.success=false 的正常返回路径 refund；运输方法 reject 后进入外围 catch 直接 500，已预扣不退。没有预留凭证，跨日/重复退也不能识别（底层问题由核心组处理）。
- 建议：使用核心组的 reservation 对象和幂等退款；只对未接受发送的名额补偿，发送成功与响应/日志失败分离，防止已寄信却全退。
- 回归：send reject 退款一次；明确失败退款一次；成功后响应/记录故障不全退；部分抑制按 acceptedCount 退差额。

## AE-06 发信端点缺乏一致的运行时字段类型和长度验证

- 位置：`src/controllers/emailController.ts:25-30,109-126,262-295,354-376,494-524`。
- 类型：输入验证、无效请求消耗预算。
- 证据：只做 truthy 检查后 `.split`/`.trim`/spread；`from={}` 或 `to={}` 可变 500；`to=[]` 在非 batch 路径通过必填及格式检查，进入扣款与运输；batch 的 html/text 无大小上限，subject 与可选 text 未验证类型。
- 建议：在任何配额/运输调用之前统一验证非空字符串、非空字符串收件人数组、字段长度与可选字段类型，错误均为 400；不要在 malformed 请求时写完整 req.body。
- 回归：对象、数字、空数组、空白主题、超长正文均 400 且不扣配额、不调用运输；合法单发/批发保持成功。

## AE-07 一次性链接在用途/业务输入检查之前被消费

- 位置：`src/services/verificationService.ts:99-113,226-252`；`src/models/verificationTokenModel.ts:225-260,287-310`；`src/controllers/auth/passwordResetHandlers.ts:192-195`。
- 类型：令牌生命周期、前后端契约。
- 证据：verifyAndUseToken 先 CAS 标 used，再由服务检查用途；将注册链接提交到重置接口会消耗该注册令牌。reset 预验证完全不检查用途，前端显示可改密码，正式调用才失败。服务对密码完整强度校验也在消费之后。CAS 未含 expiresAt，读与消费间恰好跨过有效期仍可成功。
- 建议：存储 API 接受 expectedType；读与 CAS 均检查类型和有效期；reset 预验证仅允许 PASSWORD_RESET；完整业务验证先于最终 CAS，随后才写入账户。不要因错误用途或格式输入烧掉合法链接。
- 回归：错用途预检/正式验证不消费；密码校验失败仍可用原链接改正确密码；跨过 expiry 的 CAS 拒绝；并发同令牌仅一个成功。

## AE-08 旧验证码重发失败会废掉用户手上仍有效的验证码

- 位置：`src/controllers/auth/registrationHandlers.ts:274-307`；`src/controllers/auth/passwordResetHandlers.ts:243-246,267-286`。
- 类型：兼容路径生命周期与设备绑定。
- 证据：重发先覆盖 emailCodeMap，运输失败不恢复旧状态；尝试限制仍针对没送到的新码。旧 reset 只在“entry 与请求都提供 fingerprint”时比较，省略请求 fingerprint 绕过绑定；正确码读取后跨多次 await 才删除，两个并发请求可都进入密码更新。
- 范围说明：全库搜索没有当前生产初始写入 emailCodeMap/resetPasswordCodeMap 的路径（仅失败计数写回、重发）；这些仍暴露的兼容接口不应被误当作当前注册流程。不得为修此问题重新启用无验证的初始发码入口。
- 建议：只修已存在状态的安全处理：重发失败条件恢复旧条目、禁止过期注册数据续命；旧 reset 强制匹配已绑定 fingerprint，并在第一次 await 前原子取走成功匹配的条目。
- 回归：预置旧状态后重发失败原码仍有效；过期状态拒重发；省略绑定指纹拒绝；并发旧 reset 只消费一次。

## AE-09 发信异常会保留本次未寄出的验证令牌

- 位置：`src/controllers/auth/registrationHandlers.ts:102-147`；`src/controllers/auth/passwordResetHandlers.ts:61-95`；`src/services/verificationService.ts:56-82,181-207`。
- 类型：失败清理。
- 证据：创建成功后只在 result.success=false 分支删令牌；生成模板或邮件方法抛异常时 token 变量在 try 内，catch 无法清理。注册的 policy 写入又在发送成功之后，写入失败会返回“注册失败”但邮件实际可用，诱发重复发送。
- 建议：维护本次 token 与 delivered 标志，在未送达失败路径 best-effort 删除本次令牌；同意记录写入移到发信之前，或明确使用不会误报已寄信失败的边界。
- 回归：模板异常、运输 reject 删除本次 token；已成功寄出的 token 不因后续辅助记录失败而删除/误报。

## AE-10 找回入口成功文案直接暴露邮箱是否注册

- 位置：`src/controllers/auth/passwordResetHandlers.ts:43-48,86-87`。
- 类型：隐私/API 契约。
- 证据：未注册返回“如果该邮箱已注册，您将收到密码重置链接”；已注册寄信成功返回“重置链接已发送到您的邮箱”，同为 200 但响应体不同，抵消注释声明的不透露用户存在性。
- 建议：两种成功状态统一相同泛化响应；收件人冷却在用户存在性判断前按同一机制处理，避免新增 429 差异直接重建枚举口。
- 回归：存在与不存在邮箱得到同样 status/body；发送故障保留可诊断内部日志。

## 状态

### AE-11 自定义发件域名被误用收件人白名单拦截

- 位置：修复前 `src/controllers/emailController.ts:125-126,512-513`。
- 证据：HTML/Markdown 把 from 和 to 一起交给 `EmailService.validateEmails`，该方法验证的是主流收件域白名单；管理员已正确配置自定义发件域仍会被当成无效收件人拒发。
- 建议：from 使用邮件语法校验与已配置发件域校验；仅 to 使用收件人策略。
- 回归：已配置 `noreply@mail.example.com` 能向合法主流邮箱发信；非法 from 与未配置域仍拒绝。

AE-01..11 均已实现并交协调者复核。AE-03 采用并行会话已经提交到 `46b57667` 的相同修复，最终整合去重。底层 reservation/acceptedCount 由邮件核心组实现，本组未编辑 emailService/emailSender/outEmailService。

回归文件：`src/tests/emailController.test.ts`、`authEmailFlows.test.ts`、`authEmailCooldownService.test.ts`、`verificationServiceLifecycle.test.ts`；真实 Mongo 并发与租约回归为 `tests/integration/auth-email-cooldown.test.js`。均仅落盘，依约未在本机运行。`git diff --check` 静态检查无空白错误；最终构建/测试以主代理推送后的 GitHub Actions 为准。
