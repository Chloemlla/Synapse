# 邮件核心审查（2026-10-07）

范围：`src/services/emailService.ts`、`emailSender.ts`、`outEmailService.ts`，以及只读追踪的调用方、配置、抑制名单。行号以本次审查开始时工作树为准。遵循工作区方法论：先记录后修复；未执行本机构建、测试、lint 或依赖安装。下列均有可追踪代码路径，回归策略需交由 GitHub Actions 执行。

## EC-01 — 注册/确认邮件误用普通用户日配额，存储错误也被说成次数用尽

- 类型/优先级：业务规则 / 高。
- 位置：`emailSender.ts:25-35,62-76`；调用证据 `controllers/auth/registrationHandlers.ts:116-121,244-249,293-298`。
- 症状/根因：统一账号邮件封装默认 `checkQuota=true`，匿名发送把邮箱作为 userId、`verification` 作为 domain 调用通用日额度。命名空间虽隔离，仍执行每日上限；达到上限就直接拒绝注册验证邮件并要求明日重试。`consumeEmailQuota` 在 Mongo 离线/错误时同样返回 false，因此基础设施故障也变成“验证码发送次数已达上限”。欢迎邮件显式 true，同样消耗该账号邮件额度。
- 重要边界：当前 `passwordResetHandlers.ts:83`、凭据通知已明确 `checkQuota:false`，不能把它们报告成当前已经受日额限制；应回归确保此行为持续成立。
- 建议：账号/事务邮件封装不承担用户自助外发日额；移除额度逻辑或保留兼容参数但标为废弃。在注册/重发/重置入口保留按邮箱/IP/用户的短窗口冷却，不引入“明日再试”。基础设施问题返回临时不可用。
- 回归：普通邮件日额耗尽后注册/重发/密码重置依然调用传输层；短时间重复请求仍被冷却；额度数据库异常不能生成日额错误文案。

## EC-02 — 默认额度不随在线配置更新，对外额度会覆盖主邮件额度

- 类型/优先级：配置一致性 / 高。
- 位置：`emailService.ts:74,248-266,374-380,488-500`；`runtimeConfigService.ts:2475,2486`。
- 症状/根因：无 domain 的查询/扣额都选择 `default`，域额度表不含 default，最终使用模块加载时读取的 `_EMAIL_QUOTA_TOTAL`；管理端在线修改 `email.quotaTotal` 对单发/simple/markdown不生效。主邮件和对外邮件使用相同发信域时，`buildDomainQuotaMap` 后写的 outemailQuotaTotal 又覆盖主额度，使批量接口与单发额度不同。
- 建议：用户外发额度统一从当前 runtime `quotaTotal` 读取；对外公共额度只在 outemail 策略中应用；发信域/供应商凭据不能成为用户额度所属者。仍需保留域兼容入口时，显式定义其与用户统一桶的关系。
- 回归：运行时从100改为3，无domain查询和扣减立即显示/执行3；主/对外同域而不同额度时互不覆盖；单发/批发查询同一额度。

## EC-03 — 批量原子扣额只检查 used < total，可一次跨过上限

- 类型/优先级：计量/并发 / 高。
- 位置：`emailService.ts:488-542`；实际调用 `controllers/emailController.ts:301`。
- 症状/根因：过滤条件是 `used < quotaTotal`，更新却增加 count。used=99、total=100、count=10 时仍成功并变为109；过期分支也无条件接受 count>total。服务未限制 count 必须为有限正整数。
- 建议：验证正整数 count；本次 count 不得大于额度；条件必须是有效窗口内 `used <= total-count`，过期窗口以0为基线执行同一比较。
- 回归：99/100申请2拒绝；98/100申请2成功；过期窗口申请101拒绝；并行批发总和不超限；0/负数/小数/NaN参数拒绝。

## EC-04 — 非唯一配额键使首次并发创建产生多个独立余额

- 类型/优先级：并发/持久化 / 高。
- 位置：`emailService.ts:33-46,504-509,525-542`。
- 症状/根因：schema特意只建非唯一 `(userId,domain)` 索引，而首次扣额通过 `updateOne(...,{upsert:true})` 初始化。在并发首次使用时无法保证只创建一条文档；历史重复文档也已被注释明确承认。后续条件更新可从已耗尽文档转而命中另一条有余额文档，累计发信超过额度。
- 建议：新权威文档使用确定性唯一 `_id` 或有受控迁移的唯一键；不能直接在历史重复数据上加唯一索引。旧数据需保留/聚合有效日使用量并记录迁移策略，新扣额和读取必须固定命中同一权威文档。
- 回归：真实Mongo并发初始化仅产生一条权威文档；预置旧重复记录后不能获得第二份额度；唯一索引冲突重试不能被误报成额度耗尽。

## EC-05 — 查询额度的读后无条件重置会抹掉并发成功扣减

- 类型/优先级：竞态 / 高。
- 位置：`emailService.ts:381-389`。
- 症状/根因：`getEmailQuota`先读到缺失/过期文档，再按仅含 userId/domain 的过滤器无条件写 `used:0`。两步之间另一个发送可先建立/重置窗口并增加used，随后查询把成功发送的计数清零。读取接口改变计量数据，刷新额度页面即可遇到午夜并发漏洞。
- 建议：读取不修改计数，过期时只在返回值中投影为0；初始化/窗口变更由条件更新完成，或将整个读重置做为一次原子条件操作。
- 回归：构造查询读到旧窗口后暂停，发送成功，再恢复查询；used保留该发送。首次文档创建同样验证。

## EC-06 — 退款不关联预留/窗口，可跨天扣别人的新计数并可退成负数

- 类型/优先级：补偿一致性 / 高。
- 位置：`emailService.ts:552-565`；`emailSender.ts:89-93`。
- 症状/根因：退款只凭 userId/domain 和 `used>0` 执行 `$inc:-count`。旧窗口发送在新一天才失败，退款可扣当天新发送；已重置或仅剩1时退10会得到-9。没有预留标识，重复补偿也无法识别。
- 建议：扣额成功返回携带唯一id、窗口标识、count的reservation；退款原子地核销该预留，部分退款累计不得超过预留，且不得改动另一窗口。计数至少钳制到0，不能用钳制代替预留归属。
- 回归：跨午夜失败不影响新日计数；相同预留重复退款仅生效一次；部分退款与全额退款竞态不多退；管理员重置后迟到退款不影响后续发送。

## EC-07 — 查询/重置的文件降级与Mongo扣额形成两份互不相通的事实

- 类型/优先级：持久化/误导状态 / 中。
- 位置：`emailService.ts:140-181,393-409,444-480,493-495`。
- 症状/根因：Mongo失败时查询、addEmailUsage、resetEmailQuota落本机json，且只按userId存储忽略domain；实际扣额却fail-closed且只写Mongo。页面可显示0/100，外发却全部拒绝；文件里的“重置成功”不影响Mongo恢复后的真余额，多实例也各自不同。文件写入还依赖data目录存在。
- 建议：按仓库约定Mongo为唯一真相源，移除这些配额json降级；只读/管理失败显式报告存储不可用，扣额用稳定reason区分exhausted/unavailable。
- 回归：Mongo不可用时读取/重置返回可识别的暂时故障且不产生本地文件；恢复后使用同一份原额度；接口不再把unavailable映射为每日超限。

## EC-08 — 对外批发跨分钟分支漏掉20封上限，旧请求还能将分钟窗口倒退

- 类型/优先级：限流/竞态 / 高。
- 位置：`outEmailService.ts:257-308,460-461,491`。
- 症状/根因：同分钟分支检查 `countMinute<=20-count`，跨分钟分支只检查每日余额，直接把countMinute设为count；批发允许100条，所以既有日文档在下一分钟接受21~100条。跨分钟过滤器是 `$ne`，若旧分钟请求因IO暂停到新请求完成后才更新，可以把minute从新值写回旧值，再次打开一份分钟额度。
- 建议：入口拒绝超过分钟容量的单次预留，或明确切块排队；窗口使用可单调比较的时间桶并禁止回退。更简单可靠的是按固定日期/分钟唯一键记账，日额与分钟额要同时成立并可靠补偿。
- 回归：空日/同分钟/跨分钟三种状态申请21都拒绝；并发20以内不超限；刻意延迟旧分钟请求不能回拨或清空新窗口。

## EC-09 — 对外发送失败永久占额，记录落库失败却把已发送邮件说成失败

- 类型/优先级：事务边界 / 高。
- 位置：`outEmailService.ts:491-526,574-611`。
- 症状/根因：reserveQuota先增日/分钟计数，后续供应商拒绝、抑制名单全部拦截、正文处理异常等均无退款。供应商成功后 `OutEmailRecord.insertMany/create` 与发送在同一个try中，记录失败会返回发送失败，诱导调用方重试并重复投递/计量。
- 建议：对外预留也返回窗口化、可核销的reservation；明确未发送时补偿相应计数。供应商已接受就保存成功结果，记录作为独立失败处理，不能改变实际投递结果。分钟策略明确是防刷尝试数还是成功收件人数并保持返回契约一致。
- 回归：供应商明确拒绝/全部抑制不消耗成功发送日额；正文异常不泄漏预留；供应商成功而记录落库失败仍返回成功且不退款；跨分钟退款不影响新窗口。

## EC-10 — 对外批发按消息条数扣额，多收件人及抑制过滤使额度/记录不对应真实发送

- 类型/优先级：计量/数据正确性 / 高。
- 位置：`outEmailService.ts:474-491,506-522`；`emailService.ts:609-623,694-717`（收件人过滤）。
- 症状/根因：每条message可带多个收件人，但reserveQuota只扣messages.length，一条发给多人只占1。传输层过滤掉被抑制地址/整条消息后仍整体success；调用方既不知实际接受人数，也按原messages写发送成功记录，导致未发送的地址占额度并被标为已发送。通用EmailController也存在此类按原人数结算的问题，由控制器组处理。
- 建议：定义用户/公共外发额度单位为实际接受的收件人数；传输返回acceptedCount和被接受的消息/收件人，预留原请求人数后退款差额，记录只包含实际投递目标；或在预留前完成一次统一收件人准备。
- 回归：单message十个收件人扣十；重复地址规范化去重策略明确；混合抑制地址仅对可投递者结算和记账；全部抑制无成功记录。

## EC-11 — 主邮件与对外邮件传输配置合并，启停和同域凭据彼此干扰

- 类型/优先级：配置隔离 / 中。
- 位置：`emailService.ts:273-315,341-354,363-370`；`outEmailService.ts:452-467`。
- 症状/根因：两种服务把domain→key写进同一个map。相同域时对外API key覆盖主邮件key；主邮件enabled=false但outemailEnabled=true时，默认发件人会回退到对外域，EmailService状态仍available，站内账号邮件继续借用对外通道。反向地，对外指定domain用的是合并map，因此可选择仅主邮件配置的域。
- 建议：明确发送通道/配置来源，主邮件和outemail分别选择其允许域和凭据；保留共享Resend客户端缓存，但不把业务启停和凭据归属混为一体。需要有意共享的配置应显式声明回退规则，不能靠map覆盖顺序。
- 回归：同域两套key各用自己的凭据；主邮件关闭时不因对外开启而显示主服务可用；对外自选domain只接受对外允许域。

## EC-12 — 批发收件人校验会静默丢掉无效地址，整批仍报成功

- 类型/优先级：数据校验/契约 / 中。
- 位置：`outEmailService.ts:473-480`。
- 症状/根因：注释承诺“任一收件人无效即整体拒绝”，实现却map(sanitizeRecipient).filter(nonNull)，仅检查剩余是否为空；混合合法/非法地址时非法项消失，随后记录还是原始地址列表，用户看到成功却有人未收到。
- 建议：先检查每个原始收件人有效性，再规范化/去重；任一无效即返回校验错误，或显式返回逐收件人的部分结果且前端可见，不能静默过滤。
- 回归：一个合法+一个非法地址时不发送、不扣额、不写成功记录，并返回校验失败。

## EC-13 — 退订营销通知会同时阻断用户主动请求的账号验证/找回邮件

- 类型/优先级：事务邮件策略 / 高。
- 位置：`emailService.ts:16-31`及所有sendEmail/sendBatchEmail调用；`emailSuppressionService.ts:131-159`；`models/emailSuppressionModel.ts:15-22`。
- 症状/根因：抑制查询把bounce、complaint、unsubscribe、manual全部合并，传输接口没有邮件用途；事务封装同样调用此传输。用户曾点击退订后，主动请求密码重置/邮箱确认仍被“退订/退信抑制”统一拒绝。仅改checkQuota不能解除这个独立阻断。
- 建议：增加显式transactional/notification用途。主动账号事务邮件可排除纯unsubscribe原因；bounce/complaint/manual仍遵循地址不可投递/人工拦截政策，不应全部绕过。默认外发仍尊重退订。此项需协调抑制服务文件归属。
- 回归：退订用户主动请求验证/重置允许投递，普通通知/外发仍被抑制；投诉、硬退信、人工抑制不会因transactional类型被绕过。

## EC-14 — Resend批发响应解包错误，成功邮件ID丢失

- 类型/优先级：第三方接口契约 / 中。
- 位置：原 `emailService.ts:745-751`。
- 症状/根因：把解构后的data当数组；实际固定依赖resend@6.31.0的 `CreateBatchSuccessResponse` 是 `{ data: Array<{id:string}> }`，因而成功时ids一直undefined。已只读核查该版本公开包 `https://unpkg.com/resend@6.31.0/dist/index.d.mts`。
- 建议：去掉Resend的any绕过，使用类型约束下的 `data?.data.map(...)`。
- 回归：SDK返回 `{data:{data:[{id:"batch-id"}]},error:null}` 时最终结果包含ids。

## EC-15 — 常用合法加号邮箱与大写邮箱域被共享校验器拒绝

- 类型/优先级：输入校验 / 中。
- 位置：原 `emailService.ts:219`。
- 症状/根因：白名单正则只接受 `[\\w.-]` 本地部分且未忽略域名大小写，`user+verify@GMAIL.COM`被拒绝。
- 建议：保留已有域白名单策略，允许加号别名并忽略域名大小写；发送前统一trim和规范化。
- 回归：共享邮件校验器接受加号地址，错误地址仍被拒绝。

## EC-16 — 锁定的Mongoose9拒绝未显式启用的更新管线，所有扣额会被误报成用尽

- 类型/优先级：驱动兼容/根因 / 高。
- 位置：原 `emailService.ts:430-440,525-542`；依赖 `mongoose@9.10.3`。
- 症状/根因：原子扣额传入聚合更新数组，却没有 `updatePipeline:true`。只读核查锁定版本 `https://unpkg.com/mongoose@9.10.3/lib/query.js`，其在该选项未启用时直接抛出 `Cannot pass an array to query updates unless the updatePipeline option is set.`。原实现catch把错误统一转换成success:false，所以未耗尽的新用户也会被“配额已用尽”挡住。
- 建议：所有聚合更新调用显式传 `updatePipeline:true`，不改全局选项掩盖其它调用；数据库错误与真实额度耗尽分开返回。
- 回归：真实Mongo集成直接执行新预留与结算，确保驱动实际接受管线；初次使用成功而非false。

## 实施状态（等待GitHub Actions验证）

- EC-01：emailSender彻底移除日额依赖，兼容保留旧checkQuota/userId参数；事务用途显式声明，控制器调用方由认证组同步。
- EC-02~07：新增 `emailQuotaService.ts`，用户统一桶、运行时额度、确定性唯一ID、原子预留与幂等最终结算、无json降级。旧 `email_quotas` 集合按userId聚合未过期域桶，排除verification，保留原记录；无效旧到期时间的已用数保留到当日结束，未来的旧到期时间取最晚值以避免提前赠送额度。
- EC-08~10：对外额度也使用同一预留引擎的独立公共ledger，同一条更新内同时检查日额与分钟额；分钟窗口不回拨，单次超过20收件人拒绝。失败退款，成功按实际人数结算，记录故障只记日志。
- EC-11：传输显式区分primary/outemail通道，主/公共启停、域与凭据分别解析。
- EC-12：批发任一非法收件人即校验失败，发送前去重。
- EC-13：仅显式transactional用途忽略纯unsubscribe；bounce/complaint/manual仍阻止。默认notification仍遵守退订。
- EC-14~15：修复SDK批量响应解包与加号/域大小写兼容。
- EC-16：新预留与结算的聚合更新都显式启用updatePipeline。

回归代码已添加：`src/tests/emailDeliveryPolicy.test.ts`、`src/tests/outEmailDelivery.test.ts`，以及真实Mongo `tests/integration/email-quota.test.js`；后者通过现有replica CI执行，Jest integration配置补充TS源码转换。没有在本机执行测试、构建、lint或安装依赖。

迁移边界：新的权威集合是 `email_quota_ledgers`；旧集合保留用于审计但不再更新。部署切换必须先停旧版额度写入，再让新版本承接流量，不能让旧版和新版长期混合写两份额度；无需删除历史记录或在重复旧数据上强建唯一索引。回滚也应先停写并处理新ledger期间的使用量，不能把旧集合直接当作最新余额。

## 已落盘的接口

- 统一用户外发配额桶，不把发信域/供应商限制用作用户配额键。
- `consumeEmailQuota`成功附带 `{id,ledgerId,resetAt,count}` reservation，失败附带稳定reason；控制器保留reservation并按发送结果结算。
- `settleEmailQuota(reservation,acceptedCount)`原子最终结算并删除预留；`refundEmailQuota(reservation)`等价于接受人数0，同一个预留不可重复退款。
- `EmailResponse`补充实际acceptedCount；批发补充acceptedMessages以保证发送记录真实。
- 核心代码与回归已实施，所有EC条目待主代理静态核查与GitHub Actions裁决；没有commit/push。
