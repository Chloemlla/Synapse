# 服务层第二批整改记录

范围：`be-services-2-01` 至 `be-services-2-26`，只核验既有报告。工作树为 `Synapse-audit-all-20261007`。本组未运行本地 build/test/lint/依赖安装，未 add/commit/push；以下“已修复”表示实现与回归用例已落盘，最终验证由 GitHub Actions 裁决。

| 编号 | 处置 | 事实与落地改动 |
| --- | --- | --- |
| be-services-2-01 | 已修复 | `nexaiSyncService.mergeIncrementalData` 改为 `_id + version` 条件更新并递增版本，冲突最多重读合并三次，仍冲突抛 `NexaiSyncVersionConflictError`。初次插入的唯一键竞争也重试。`patchSyncData` 同步递增版本，避免类别更新绕开 CAS。并发设备测试验证两条独立笔记都保留。 |
| be-services-2-02 | 已修复 | `workspaceService.acceptInvitation` 消费邀请后，成员条件写入零条时，将尚未过期且仍为 accepted 的邀请补偿为 pending，保留原成员上限错误，允许名额释放后重试。补偿按确定的零写入结果执行。 |
| be-services-2-03 | 已修复 | `userService` 用固定 `Asia/Shanghai` 日键；Mongo 原子额度条件和递增管道也用 `$dateToString` 的上海时区解析原 ISO 时间戳。`userRepository` 的剩余额度读取复用相同日键。保留 `lastUsageDate` 的真实时间戳格式，未把上海日键与 UTC 前缀混比。 |
| be-services-2-04 | 已修复 | `providerCredentialEmailService` 不再调用含口令模板，改为固定的第三方登录/忘记密码设置指引，邮件标题也改为账号创建通知。`nexaiAuthService` 两个新用户分支不再传递随机口令给邮件服务。保留兼容可选参数但绝不写入邮件。 |
| be-services-2-05 | 已修复 | Play Integrity nonce 改用 `sharedStateStore.set/consume`，共享 TTL 与原子一次性消费；签发 API 改为 async。报告同项提及的 NexAI discoverable challenge 一并迁移共享存储并原子消费，未改变既有 failOpen 产品策略。 |
| be-services-2-06 | 已修复并纠正范围 | 当前 Redis 驱动配置已有无限退避重连，因此“启动晚必永久失联”的推论过度；但 `connect()` 真正 reject 的 catch 确实没有恢复入口。现增加 30 秒惰性退避重试与并发初始化保护，显式关闭后停止重试，并清理旧连接。 |
| be-services-2-07 | 已修复 | 当前代码确实只限制 admin 前缀。`wsService` 现在只允许订阅本人 `user:<id>`；拒绝客户端自选 `ticket:` 频道，继续使用服务端按用户/管理员投递工单事件的既有路径。 |
| be-services-2-08 | 已修复 | `manualSync`、`manualCleanup` 使用与定时任务相同的共享锁键、TTL 和 owner；未获锁返回忙碌提示，finally 按 owner 释放。 |
| be-services-2-09 | 已修复 | `lotteryService.getBlockchainHeight` 第一次外部 fetch 补 5 秒 AbortSignal 超时。原报告“冻结事件循环”措辞不准确；真实问题是请求无有界等待。 |
| be-services-2-10 | 已修复 | 运行时管理口令哈希改用 `config.bcryptSaltRounds`（当前为 12）；在写入路径动态导入配置，避免初始化时增加 config/runtimeConfig 的循环依赖。 |
| be-services-2-11 | 不成立 | 回读 `sharedStateStore.consume/get`：`JSON.parse(raw)` 明确处在现有 try 内，后续 catch 会处理解析异常，原报告称 catch 不覆盖 parse 错误。Mongo value 为 Mixed 对象，也不是报告所称的另一次 JSON.parse 路径。未按错误前提改存储降级行为。 |
| be-services-2-12 | 已修复 | 短链导出在已选择加密后若 cipher 失败，抛导出失败异常；不再返回 `{content}` 明文结果。回归用例注入 cipher 故障验证拒绝导出。 |
| be-services-2-13 | 已修复 | 支付 URL 统一解析并只接受 HTTP(S) 或正常站内绝对路径；拒绝其他 scheme、协议相对路径、反斜线、控制字符和 URL 用户凭据。Location 与同链路 JSON 的 payurl/payUrl/url 都经过校验；不合格返回 null，保留既有表单提交退路。 |
| be-services-2-14 | 不成立 | RFC 8252 并不禁止 public/native 客户端接收 refresh token。现有公开客户端刷新属于产品契约，不能据此删除 PiliPlus 的刷新令牌。保留现有签发与刷新流程。 |
| be-services-2-15 | 已修复 | `hashEncrypt("md4")` 显式返回不支持，不再计算 MD5 伪装成 MD4；支持算法提示去除 MD4。类型仍接受旧请求以返回清晰业务错误，MD5 等真实算法保持原值。 |
| be-services-2-16 | 已修复 | `tamperService.destroy` 幂等停止 blocked IP 刷新计时器，并接入现有 shutdown flush 步骤。单例重复 getInstance 本身不会创建第二个计时器，修复针对缺少清理入口。 |
| be-services-2-17 | 已修复 | `getOutEmailRecordById` 仅真实缺失返回 null，数据库异常记录后抛出，使调用方能区分 404 与 500。路由 500 文案由协调者同步收敛。 |
| be-services-2-18 | 已修复 | `lotteryService.updateUserRecord` 从抽奖入口显式接收 roundId，历史新记录分别写真实 roundId 与 prizeId。未猜测或批量改写存量历史记录。 |
| be-services-2-19 | 已修复 | network/media/social 外部请求错误日志统一携带嵌套 cause 的 name/code，可区分 ENOTFOUND 等传输故障；不序列化 cause 的请求配置、密码或原始载荷。没有把诊断 cause 外发给客户端。 |
| be-services-2-20 | 已修复 | 删除 `totpService` import 时修改 `process.env.TZ` 的副作用；TOTP 使用 Unix 时间步，不依赖局部时区。 |
| be-services-2-21 | 已修复 | 删除 passkey 注册成功路径的整块 `registrationInfo` stdout，以及认证路径 `fullAllowCredentials/fullOptions` 调试载荷。与 04 的辅助位合并处理但独立登记。 |
| be-services-2-22 | 已修复 | 自动生成密钥使用固定 Mongo `_id` 与 `$setOnInsert`，利用现有主键唯一约束避免双实例各插一把；所有生成者重新读取数据库胜出的密钥后才缓存和签名。旧 active 文档读取增加 `_id` 排序打破同时间戳平局。未新增需清洗旧数据才能建立的 active 唯一索引；显式签名文件优先契约保留。 |
| be-services-2-23 | 不成立 | 当前 `RedisServiceStatus` 已同时提供 configured/ready/available；`IntegrationsHealthPanel.tsx` 用 `redisStatus.available` 显示健康。无证据支持“enabled 让面板持续显示绿”。仅补 enabled 兼容字段注释，不改响应契约。 |
| be-services-2-24 | 不成立 | 缓存未命中并发多一次同值回源没有已证实的功能、资源越界或安全缺陷；现有 TTL/固定单键缓存有界。未为消除无害形态增加锁。 |
| be-services-2-25 | 已修复 | 扫码登录挑战迁 `sharedStateStore`，create/scan 改 async，scan/approve/poll 共享临界区。最终登录签发前原子 consume，跨实例并发轮询至多发一份凭据。 |
| be-services-2-26 | 已修复 | 当前分支确实仍使用 `providerBindSessions` Map。迁移到按 token 哈希命名的共享 TTL 记录；共享锁保护失败次数，成功后原子消费，密码失败不会延长原会话截止时间。issue/get/reset 改 async，服务与控制器调用方已由各责任组补 await。 |

## 回归与静态核对

- 新增 `src/tests/auditServices2{Sync,Workspace,Network,Oidc,Mobile,Usage,Security,Redis}.test.ts`：覆盖 CAS 重试/重试上限、邀请补偿、口令不出邮件、MD4 语义、OIDC 双实例首启、跨实例扫码与原子消费、上海午夜用量、导出加密故障、支付重定向、Redis 初始连接拒绝后恢复。
- `mobileIntegrityService.test.ts`、`providerBindSessionService.test.ts` 已同步 async 签发/查询/reset，并使用序列化的共享状态替身保持原有 nonce 防重放、身份绑定、密码尝试次数、过期测试。
- 已回读改动与调用方、执行限定文件的 `git diff --check`；未运行本地编译、测试、lint。测试结论为待 CI，不声称通过。
- `sharedStateStore` 仍保留仓库已有的共享层故障时内存兜底策略与告警，迁移后的跨实例保证以所有实例连接相同共享后端为前提。锁的 TTL/后端故障策略未在本批扩大重构。
- 未改资源服务已有 `getResources(..., {includeInactive})` 差异，未触碰其他组修改；未做存量中奖历史迁移或线上数据修改。
