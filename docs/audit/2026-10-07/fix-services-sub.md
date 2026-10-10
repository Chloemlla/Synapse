# be-services-sub 修复处置（2026-10-07）

范围冻结为 `be-services-sub.md` 的 20 项。未扩大审计；未运行本地构建、测试、lint 或依赖安装；未暂存、提交、推送。以下“已修”指代码已落盘，运行验证仍须 GitHub Actions 裁决。

| 编号 | 处置 | 文件、原因与验证边界 |
| --- | --- | --- |
| be-services-sub-01 | 已修 | `src/services/lumen/admin.service.ts`：手工权益插入不再写空 purchaseToken；更新时 `$unset` 清除该手工记录的历史占位。保留现有唯一索引及真实购买令牌。原报告“sparse 跳过 null”的建议有误：null 也会进入索引，因此使用缺失字段。用例覆盖两个用户的手工计划写入；未在真实旧库执行迁移。 |
| be-services-sub-02 | 已修 | `src/services/lumen/entitlements.service.ts`：新增购买权益使用 token 派生的固定 `_id`，原生主键约束提供原子判重，不依赖可能尚未成功建立的 purchaseToken 唯一索引；保留按 purchaseToken 查旧 UUID 记录。捕获 11000 后仅在查到同 token 时返回已有权益，其他错误继续抛出；pending 重试与初次请求均返回 FREE。并发替身用例覆盖两请求、同主键、同权益及顺序重试。 |
| be-services-sub-03 | 已修 | `src/services/lumen/crash.service.ts`：以 userId/reportId 派生固定主键；11000 查回赢家并返回 duplicate，不重复增加管理聚合计数；既有报告判重放在新报告额度检查之前，额度用尽后的重试仍可幂等返回。保留旧报告读取。测试覆盖并发两次只聚合一次；未模拟数据库在报告写成功后、聚合前宕机的事务问题，该问题不在本项范围。 |
| be-services-sub-04 | 已修 | `src/models/mediaToolModels.ts`、新增 `src/models/mediaToolCookiesCrypto.ts`、经协调授权的 `src/mediaTool/biliCookies.ts`：AES-256-GCM 使用 `deriveKey(KL.BILIBILI_CRED)`，正文/密文/IV/tag 默认均不选择。新写只落密文；读取显式选择凭据字段，旧明文先以内容和“尚无密文”为条件 CAS 写回加密并删除 content，避免覆盖并发上传。测试覆盖加解密、tag 篡改拒绝及明文迁移条件。尚未读取的存量明文和既有备份不会凭代码发布自动清除；当前启动恢复 Cookie 会触发常用那条记录迁移。 |
| be-services-sub-05 | 已修 | `src/config/lumen.ts`、`src/config/config.ts`：保留 true/1/yes/on 与 false/0/no/off 的合法兼容拼写，非标准值显式报配置错误，不将运维拼写错误默认为 true 或反向关闭签名。Lumen 拼写错误回归已新增；部署需改正既有非法值后才可启动。 |
| be-services-sub-06 | 已修（协调者协作） | `src/config/runtimeConfigDefaults.ts`：IPQS 默认 apiKeys 改为 []；协调者已在 `src/services/ipVerificationService.ts` 的 getApiKeys 过滤旧持久化的 `api` 占位，避免仅改默认值仍对老配置发起无效请求。该服务文件由协调者修改，本组不覆盖。 |
| be-services-sub-07 | 已修 | `src/services/turnstile/hcaptcha.ts`：low_score 与 network_error 分支统一为 high/medium。静态复核与 risk 类型相符；历史已存的大写行未批量重写。 |
| be-services-sub-08 | 基线已修 | `src/services/turnstile/verify.ts` 当前已导入并使用 BAN_DURATION，封禁状态分支也复用 banStatus.expiresAt。保留此前验证码生命周期改动，不重新覆盖。 |
| be-services-sub-09 | 已修 | `src/services/lumen/auth.service.ts`、`admin.service.ts`：正确验证码经 `findOneAndDelete` 条件式原子消费，条件重新校验有效期与错误尝试上限；失败计数用原子自增后的结果决定失效。用户/管理员刷新都以 `findOneAndDelete({refreshToken})` 夺取旧会话，再生成新会话。用例覆盖并发验证码和两种 refresh 仅签发一次。新会话持久化失败时旧凭据已消费，需重新登录，不能恢复旧令牌破坏单次消费。 |
| be-services-sub-10 | 已修 | `src/services/userGenerationStorage/mongo.ts`：用户标識继续执行既有净化；text/voice/model/contentHash 只接受字符串并限制长度，保留标点，不把合法 TTS 文本清空。静态字段名下的字符串值不会变成 Mongo 操作符对象。既有测试改为验证拒绝对象注入、保留句号/货币/括号和原文查重；历史已损坏为空串的正文无法从数据库恢复。 |
| be-services-sub-11 | 已修 | `src/services/userGenerationStorage/mysql.ts`：共享 10 连接池、有界等待队列、共享建表 Promise；首次并发共用 DDL，DDL 失败清缓存供下次重试，pool.execute 负责成功/失败连接归还。保留 mandatory URI 校验。既有测试同步连接池契约，补并发、失败后复用及 DDL 重试；未连真实 MySQL。 |
| be-services-sub-12 | 已修 | `src/services/modlistStorage/file.ts`、`commandStorage/file.ts`：只有文件缺失才为空数据；读错误、JSON 错误、非数组内容均抛错，阻止下一次写入覆盖损坏源文件。回归覆盖无效 JSON 与合法 JSON 错形状，确认无写入。 |
| be-services-sub-13 | 已修 | 新增 `src/services/turnstile/keyStorage.ts`，并接入 `models.ts`、`config.ts`、`hcaptcha.ts`、`cap.ts`。写入使用由 key 派生的 ObjectId，靠始终存在的 `_id` 唯一约束原子 upsert，11000 重试更新；不直接添加可能因存量重复而失败的 key 唯一索引。读取优先固定主键，未保存过则按 updatedAt/_id 读取最新旧记录；删除 key 时删除全部该 key 旧副本以防重新出现。测试覆盖固定主键、冲突重试和旧记录排序；旧重复文档保留而不任意删除。 |
| be-services-sub-14 | 已修 | `src/services/turnstile/models.ts`：shc_traces 的 Date time 字段新增 90 天 TTL，与审计日志口径一致，保留 24h 洞察数据。TTL 索引建立后会清理既有超过 90 天且 time 为 Date 的行；未在生产库测量索引构建开销或等待 TTL monitor。 |
| be-services-sub-15 | 已修 | `src/services/modlistStorage/mongo.ts`：单项和批量新增均改为 mod_ + crypto.randomUUID，与 file/mysql 一致，不再同毫秒撞 id。现存 id 保留，更新/删除契约不变。 |
| be-services-sub-16 | 已修（遵循后端边界） | `src/services/commandStorage/mongo.ts`、`file.ts`、新增 `queuePolicy.ts` 与 `mongoQueueLock.ts`：保留原 command_queue 为唯一权威集合，原记录的读取/移除/清空路径不变，无数据迁移、无停机或新增环境配置。新版本入队以固定主键 Mongo 租约锁串行 count+insert，支持 standalone，禁止退内存。争锁最多等待 2 秒，租约 30 秒；计数后条件核验 owner 与有效期再续租，计数/写入使用驱动 3 秒超时；finally 按 owner 释放，失败由到期接管恢复，不依赖 TTL monitor 及时删除。file 将 get/add/remove/clear 完整读改写放入同一 Promise 队列，仅支持本机单进程；多实例用 Mongo。测试覆盖并发最后一槽、原集合兼容、过期接管、失去所有权后拒写与保护继任者、争锁等待上限、Mongo 故障不降级、异常释放及释放失败不改写入结果。滚动发布期间旧版本未使用新锁，仍可能出现原有的轻微超限，但读写同集合，不引入迁移丢失或重复执行；全部实例更新后才共享入队互斥。租约适用于操作在租期内完成的正常运行条件，不能宣称为能抵御无限进程暂停或不确定写入超时的事务式硬容量保证。 |
| be-services-sub-17 | 已修观测缺口；原功能归因部分不成立 | `src/services/turnstile/keyStorage.ts`：空串本来就会回退 env，原报告“DB 空串遮蔽 env”不成立。现按 key 记录 source=mongo/env/missing 和 databaseState=available/unavailable/empty/missing/error 的状态变化，日志不带值或异常原文，保留既有 fail-closed 与缓存。测试覆盖 Mongo 异常时 env 兜底且日志无密钥；没有改变缺失密钥的安全拒绝行为。 |
| be-services-sub-18 | 已修 | 新增 `src/services/turnstile/localIp.ts`，由 risk.ts 与 verify.ts 共用。使用严格 IP 解析，将 172 私网限定为 172.16–31，保留 IPv4-mapped loopback 和合法私网兼容。测试覆盖边界两侧和畸形 IP；公网不再获得低风险/开发自动通过待遇。 |
| be-services-sub-19 | 重复，随 02 修复 | `src/services/lumen/entitlements.service.ts` 删除“待补唯一索引”的失实注释，明确固定主键判重；与 sub-02 同根因、同改动，不重复计数。 |
| be-services-sub-20 | 已修 | `src/services/lumen/session.service.ts`：设备列表限定最近 200 个活跃会话并使用字段投影，当前会话在截断之外也会补回；撤销先单独检查当前设备，再以游标投影读取旧会话，每 200 条删除，finally 关闭游标。测试覆盖列表限制、当前设备保留/保护和 405 条分三批删除。列表最多展示 200 条最近会话加当前一条；旧库撤销仍需扫描该用户会话，但内存不随总数增长。 |

## 验证交付

- 新增 `src/tests/auditServicesSubLumen.test.ts`、`auditServicesSubConfigCookies.test.ts`、`auditServicesSubQueue.test.ts`、`auditServicesSubSessions.test.ts`；更新既有 `src/tests/userGenerationStorage.test.ts`，保持原有 URI 与对象注入拒绝断言。
- 本地仅静态读源码、交叉核对调用方与测试替身、查看 git diff，`git diff --check` 无空白错误。这不能代替类型编译、Jest、真实 Mongo 并发与索引/TTL验证。
- sub-06 使用侧过滤已由协调者落盘；全部改动仍需执行 GitHub Actions，不借用审计起点的旧绿灯作为本轮结果。
