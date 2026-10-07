# 前端邮件与认证契约审查（2026-10-07）

范围：`frontend/src/components` 的注册、邮件验证、密码重置、邮件发送、邮件配置页面；对照后端控制器与运行时配置服务。以下是静态源码证据，尚未执行测试；按工作区要求只由 GitHub Actions 构建、测试、lint。审查时未修改源码，提交与推送由协调者负责。行号对应本审查工作树初始版本。

## FE-01 — 认证失败后复用已核销的人机验证令牌

- 位置：`frontend/src/components/RegisterPage.tsx:168-203`；`frontend/src/components/ForgotPasswordPage.tsx:99-174`；`frontend/src/components/ManagedCaptcha.tsx:176-211`。
- 类型：错误恢复 / 一次性凭据生命周期，高。
- 症状：完成人机验证后注册，遇到用户名已存在、邀请码错误、邮件失败；修改输入再提交仍携带旧 token。找回密码发送失败后同样无法通过正常页面操作取得新挑战。
- 根因：注册只在成功分支调用 `captchaRef.reset()`；找回页根本未绑定 reset ref。后端 `registrationHandlers.ts:64`、`passwordResetHandlers.ts:36` 在用户存在性、邀请码、邮件发送前核销验证；ManagedCaptcha 成功后卸载控件并忽略过期事件，要求调用者显式重置。
- 建议：实际提交请求后，无论成功失败均清理持有 token 并重置仍挂载的控件；本地校验失败不核销。按钮与提交函数同时拒绝 `captchaStatus.loading`、`captchaStatus.error`，当前仅检查 required/token 会把尚未下发和下发失败误当免验证。提交函数用同步 ref 阻止同帧重复提交。
- 回归：挑战已解出→邮件请求失败→页面重新展示可解挑战→新 token 成功；下发加载/失败时不发业务请求；免验证时正常提交。
- 归属：认证页面可能与原 clone 的 captcha 生命周期会话重叠，实施前由协调者核对；只读原 clone `git diff HEAD` 对这些文件在本审查时返回空，不据此搬运其它会话内容。

## FE-02 — 运行时邮件设置把脱敏密钥当真实值保存

- 位置：`frontend/src/components/env-manager/EmailSystemSettingsSection.tsx:39-70`；`SelfContainedEmailSystemSettingsSection.tsx:35,51`。
- 类型：配置完整性，高。
- 症状：只修改每日配额并保存也提交三项脱敏密钥。已启用的 Resend key 校验失败，无法保存配额；关闭服务时则会保存掩码，之后重新启用/发送失败。`outemailCode` 也会被掩码覆盖。
- 根因：GET 返回 `maskSecret`（`src/services/runtimeConfigService.ts:2451-2456`），子组件直接拿它初始化编辑 state，随后无条件 POST。服务端将非空字符串视为替换值（2471-2485）。
- 建议：编辑密钥 state 始终从空开始，已有掩码只展示为只读提示；只有用户输入非空的新值才包含在保存载荷，输入用 password。与独立 `MailSystemConfigManager` 现有正确模式一致。
- 回归：读到掩码后只改配额，提交体不含任何密钥字段；明确输入新密钥时只提交那一项；刷新后输入清空、掩码仍可见。

## FE-03 — 发信域名配额缓存与异步结果错配

- 位置：`frontend/src/components/EmailSender.tsx:148-150,236-248,319-346`。
- 类型：缓存一致性 / 异步竞态，中。
- 症状：域名 A→B→A（30 秒内）显示 B 的额度；A 请求慢于 B 返回时旧结果覆盖 B；请求失败仍缓存 30 秒而跳过重试。
- 根因：缓存仅保存请求开始时间，不保存配额值；所有响应写同一个 state，无请求代次/当前域名校验。`fetchQuota` 每次 render 重建，还被列入 effect 依赖，导致每次渲染都重建防抖定时器。
- 建议：用稳定 callback + 请求序号，只接收最新查询；缓存真正的数据与成功时间，或删除无实际价值的缓存，仅保留域名防抖。初始化请求与域名请求归为同一个 effect；发送后刷新应遵守同一代次。
- 回归：不同域名延迟反序、快速往返、首次查询失败后重试，始终显示当前域名数据。

## FE-04 — 配额读取失败时界面伪造可用额度

- 位置：`frontend/src/components/EmailSender.tsx:160-173,236-248,284-294,760-787`。
- 类型：状态契约，中。
- 症状：初始 quota API 503 时面板仍显示 `0 / 100`；后续失败则展示旧值，管理员误以为额度正常。
- 根因：配额状态预置业务数值，catch 仅控制台记录，无 loading/error/unknown 区别。服务不可用与真实耗尽也没有独立显示状态。
- 建议：配额初始值为空；显示加载/暂不可用状态，提供重新读取入口；成功后才显示 used/total/resetAt。按后端新响应区分耗尽与配额服务不可用，避免把后者写成“明日再试”。
- 回归：quota 请求加载中、503、真实 0 剩余、重新读取成功分别显示正确状态。

## FE-05 — 配额文案将手动发信与账号验证混为一谈

- 位置：`frontend/src/components/MailSystemConfigManager.tsx:360-396`；`env-manager/EmailSystemSettingsSection.tsx:77,103,134`；`EmailSender.tsx:761`。
- 类型：前后端语义契约，中（依赖后端本轮 quota 设计）。
- 症状：主服务写着“账号验证、密码重置、系统通知”，紧邻无范围说明的“每日配额”，用户合理推断该配额会阻止账号验证。发送页面“站内邮件配额”也没有说明按用户/域名及手动发送的范围。
- 建议：随服务端最终语义明确标注每日配额用于手动/接口发信，账号验证与密码找回不受此业务额度阻断；保留主服务 enabled/API key 对所有发信可用性的真实约束；Outemail 单独说明其额度范围。
- 回归：人工核对三处入口的标签、提示与后端统计/消耗规则一致，不能只改一个配置页。

## FE-06 — 邮件页面保留已删除的“跳过白名单”开关

- 位置：`frontend/src/components/EmailSender.tsx:200,401-403,451,460,468,1118-1127`；对照 `src/controllers/emailController.ts:124,381,511`。
- 类型：无效控制项 / 错误承诺，中。
- 症状：勾选后界面承诺后端跳过收件人白名单，实际上后端早已删除该开关。它只减少前端校验，并且 HTML 多收件人分支连字段都不发送；行为依发送模式不同。
- 建议：删除失效开关、state、载荷字段；所有模式统一校验全部地址。服务端安全约束保持现状。
- 回归：三种模式、一/多收件人都包含收件地址校验，不再展示或发送无效开关。

## FE-07 — 邮件链接验证与自动跳转未绑定当前 token 生命周期

- 位置：`frontend/src/components/EmailVerifyPage.tsx:31-92`；`ResetPasswordLinkPage.tsx:76-127,157`；`ResetPasswordPage.tsx:124`。
- 类型：异步竞态 / 资源生命周期，中。
- 症状：同一组件内 token A→B 导航时，A 的响应可以覆盖 B 的验证结果；新 token 开始时没有重新进入 verifying 或清除 success，旧表单/成功页继续可见。离开成功页后旧三秒定时器仍把用户强制带回登录页。EmailVerify 在 StrictMode 首次 effect 清理时只清计时器，不中止请求或阻止旧回调，旧请求还失去超时保护。
- 建议：以 token 字符串为依赖，开始时清空成功/错误并进入验证状态；清理中中止请求、使回调失效，跳转 timer 同样清理。重置页只允许当前已验证 token 提交。对于一次性验证提交，协调后端保证重复请求幂等，不能只依赖前端取消。
- 回归：A 慢 B 快、A 成功 B 无效、验证中离开、成功后自行导航、StrictMode effect 重放，均无旧状态/旧跳转污染。

## FE-08 — 注册密码强度把任意用户名拼成正则，可崩溃页面

- 位置：`frontend/src/components/RegisterPage.tsx:118-124,147-150`。
- 类型：输入处理 / 运行时异常，中。
- 症状：填入邮箱和密码后把用户名临时改成 `[` 或 `(`，密码强度 effect 执行 `new RegExp(username, 'i')` 抛 SyntaxError，注册页崩溃；用户名中 `.` 等会错误影响强度。
- 根因：HTML pattern 只在提交校验，键入中间态不受限制；强度函数直接构造正则。
- 建议：用户名包含检测改成小写字符串 includes，并在空用户名时不做包含检查；其余固定常见模式可继续用常量正则。
- 回归：带括号/方括号等中间态输入不抛异常；空用户名不让任意密码命中；合法用户名子串仍降低密码强度。

## FE-09 — 邮件配置尚未读到时允许默认值覆盖线上配置

- 位置：`frontend/src/components/MailSystemConfigManager.tsx:179-218,232-235,330-335,365-404`。
- 类型：异步配置写入 / 数据覆盖，高。
- 症状：初次 GET 失败后 loading 结束，页面展示 defaultForm 且“保存”不受读取成功限制；管理员可以把默认开关、域名和额度提交回去。保存途中输入继续可编辑，随后重载也会覆盖正在输入的新值。
- 根因：只有 saving/resetting/权限禁用保存，没区分配置初次未加载与合法配置。loading 时有 MailLoadingShell，因此“加载过程中可保存”的初步推断已排除；问题限定读取失败后及保存途中。
- 建议：显式 loaded 状态，初次读取成功前拒绝保存；loading/saving/resetting 时禁用编辑与相互冲突操作；失败保留已加载数据并显示读取错误。
- 回归：初次 GET rejected 后不能提交默认值；GET 成功后允许编辑；保存期间不接受会被覆盖的输入。

## FE-10 — 对外发送批量上限与错误/重试状态未遵守实际收件人限流

- 位置：`frontend/src/components/OutEmail.tsx:79-91,140-250,317,429,712`；本轮后端按实际收件人计数，最多 20 位/分钟。
- 类型：前后端参数契约 / 错误恢复，中。
- 症状：页面允许 100 位收件人的单次请求，但服务端按收件人数正确计数后此请求必然被拒绝。429 响应被 `res.text()` 原样当错误，用户看到 JSON；没有按 `retryAfterSeconds` 告知等待时间。双击提交只依赖异步 loading；配额轮询失败仍保留旧数值。
- 建议：页面单次上限 20 位并明确分钟限额按人数计；发送使用有超时保护的共享 api，解析服务端错误文案，同步 ref 锁住重复提交；复用配额 hook 的未知/读取失败状态。注册、找回、OutEmail 共用只读取服务端 `retryAfterSeconds` 的冷却提示，不自行硬编码业务配额。
- 回归：21 位不发请求，20 位可提交；429 提取错误并倒计时，到期可重试；同帧重复点击仅一次实际发送；配额失败不保留陈旧余额。

## FE-11 — 部分收件人未发送时界面仍宣称全部发送成功

- 位置：`frontend/src/components/EmailSender.tsx:472-485`；`OutEmail.tsx:193-194,232-233`（初始版本）。
- 类型：业务结果契约，中。
- 症状：服务端过滤被抑制收件人后，前端仍展示普通成功或原始数组人数，掩盖部分地址实际未发送。
- 根因：只判断 success，未读取本轮后端透传的 `acceptedCount`。
- 建议：按 acceptedCount 显示实际发送人数；少于请求人数时显示“其余地址未发送”，不泄露抑制原因；零接受不能展示“全部发送成功”。
- 回归：全量、部分、零接受的提示对应实际人数；旧后端缺字段时保持兼容。

## 补充契约核对（不单列未证实缺陷）

- 注册与找回页原先没有服务器冷却倒计时；本轮读取后端新增 `retryAfterSeconds`，不凭前端自行硬编码额度或禁发阈值。找回成功页改为“如果该邮箱已注册，您将收到密码重置链接”，与存在/不存在邮箱统一响应一致。
- `fetch` 已由 `ipVerification.ts` 的全局 transport 补首访验证，不能仅看到 raw fetch 就断言“缺少首访头”。是否改共享 api 应基于超时/错误恢复需要。
- 未发现认证页面/邮件配置对应的现有专门组件测试；本轮建议为关键恢复、密钥保留、配额竞态写可观察行为测试并交 CI 执行。

## 去向

协调者已核对并授权实施。FE-02～11 已在本工作树落盘；FE-03 随后端最终方案改为单个用户手动发信桶，彻底删除域名查询/缓存，而非继续维护无意义域缓存。FE-01 的一次性令牌恢复与同步提交锁由原 clone 最新提交修复，协调者最终合并 origin/main 时整合；本分支仅补配置 loading/error 门禁，不复制其它会话实现。

验证：逐份审查前端 diff、`git diff --check -- frontend` 无空白错误。新增 8 个测试文件、17 个行为用例：`useEmailQuota.test.ts`、`useEmailCooldown.test.ts`、`EmailSystemSettingsSection.test.tsx`、`MailSystemConfigManager.test.tsx`、`EmailLinkLifecycle.test.tsx`、`OutEmail.test.tsx`、`RegisterEmailInput.test.tsx`、`emailDelivery.test.ts`。覆盖配额未知/竞态、服务端冷却、脱敏密钥、配置读取失败、StrictMode 去重/旧链接回写/跳转清理、实际批量上限、部分收件人结果及用户名中间态。所有测试仅编写，未本地执行；最终以协调者推送后的 Actions 结果为准。未 commit/push。
