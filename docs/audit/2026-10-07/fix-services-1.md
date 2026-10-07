# services-1 冻结清单处置

范围：`be-services-1-01` 至 `be-services-1-14`。仅修复已登记问题，未重新开展审查。起点为 `cb9fb199`；本组不提交、不暂存、不推送，由协调者统一提交并通过 GitHub Actions 验证。

| 编号 | 处置 | 变更文件、原因与回归检查 |
| --- | --- | --- |
| be-services-1-01 | 起点已修，不重复改动 | 回读 `cdkService.ts`、`ipfsService.ts`：校验失败已直接拒绝，不再依赖客户端选择的 provider 是否启用。起点已包含验证码修复；本组不改验证码策略。 |
| be-services-1-02 | 已修，待 CI | `bilibiliSyncService.ts` 区分明确未登录/身份不符（401）和超时、连接失败、429、5xx、畸形响应（503）。只对明确失效写 invalid，且更新带原密文条件，避免覆盖并发重新绑定的凭据；最近成功校验复用 5 分钟，仍先验证本地凭据可解密。`auditServices1Credentials.test.ts` 覆盖失效、临时故障、无效响应、条件写与校验节流。 |
| be-services-1-03 | 已修，待 CI | `antaService.ts` 删除 400 后查询硬编码示例商品的分支，保留原商品查询的错误响应。`auditServices1External.test.ts` 检查 400 后仅一次原商品外呼且业务失败。 |
| be-services-1-04 | 已修，待 CI | `apiKeyService.ts` 每次认证重新读取数据库的 enabled、权限、限流、到期与文档存在状态；30 秒缓存仅保留昂贵 scrypt 的验证结果，缓存键用 SHA-256，命中仍核对当前 keyHash。撤销、删除和权限变更后的下一次数据库读取跨实例生效，不依赖本进程失效广播；已开始的请求不作追溯撤销。`auditServices1Credentials.test.ts` 覆盖预热后的禁用、权限/限流修改、到期和删除。 |
| be-services-1-05 | 已修，待 CI | `accountMergeService.ts` 会话、相同账号对替换索引与待合并提示索引迁入 `sharedStateStore`，TTL 仍为 15 分钟；替换通过共享锁发布，查询重验风险不把已删除会话重新写回。`accountIdentityService.ts` 等待异步 pending 查询。`auditServices1Merge.test.ts` 用两份独立模块实例和同一共享后端替身验证读取、目标账号隔离及旧令牌替换。共享存储正常时跨实例/重启有效；其既有内存应急降级仍只有单实例语义，不宣称故障期间跨实例可用。 |
| be-services-1-06 | 已修，待 CI | `antaService.ts` 两个剩余外呼点使用 `keepAlive: false` 的单次 agent，不再保留用后即弃的空闲连接池。03 删除的第三处 agent 随分支一并去除。`auditServices1External.test.ts` 检查请求 agent 不启用 keepAlive。 |
| be-services-1-07 | 已修，待 CI | 新增经协调者确认的 `withOperationTimeout.ts`；`cdkService.ts` 两处、`clarityService.ts` 六处、`dataCollectionService.ts` 三处超时竞争统一在 finally 清定时器，保留原截止时间和错误。`auditServices1External.test.ts` 使用假时钟覆盖先成功、先失败与到期三条路径。此改动只清理计时器，不声称取消底层数据库操作。 |
| be-services-1-08 | 已修，待 CI | `imageDataService.ts` 改为唯一 imageId 上单条 `findOneAndUpdate` upsert，白名单字段更新、createdAt 只在插入设置，唯一键不置于 `$set`，返回实际数据库记录。`auditServices1Persistence.test.ts` 检查原子写入选项与既有创建时间保留。 |
| be-services-1-09 | 已修，待 CI | `githubBillingService.ts` 缓存读取把来源配置传入预热，按该配置直接强制抓取；无来源参数时按客户匹配 config1/2/3，显式拒绝客户不符；强制抓取不再先读缓存，避免再次触发预热。`auditServices1Cache.test.ts` 检查 customer-2 使用自身配置和缓存键，不默认读取 config1。 |
| be-services-1-10 | 已修；GET 合同保留 | `dataProcessService.ts` 成功日志仅留长度和成功标记，失败日志仅留长度/状态码，不记录响应正文或原始异常。2026-10-07 只读获取 [Base64 官方文档](https://xxapi.cn/doc/base64) 与 [Hash 官方文档](https://xxapi.cn/doc/hash)，两页均只声明 GET、参数位置 query，并给出 `curl -X GET` 示例；按原报告建议保留上游合同并写下注释，没有臆造 POST 支持。`auditServices1External.test.ts` 覆盖三种操作的日志不含原文与结果。 |
| be-services-1-11 | 已修失败缓存；既有 TTL 设计保留 | `clarityService.ts` 数据库错误/不可用/超时不再折叠为可缓存 null；有显式环境变量则临时降级返回且不缓存，无环境变量则向上抛出；成功读取后的真实缺省仍可缓存。`auditServices1Cache.test.ts` 覆盖故障恢复立即重读、环境变量降级不固化及真实缺省可缓存。原报告第 3 节同时明确 60 秒成功配置缓存是有意取舍，故保留其多实例陈旧上界，不将其宣称为立即广播。 |
| be-services-1-12 | 已修，待 CI | `libreChatService.ts` 超过 2 MB 时以 `STREAM_RESPONSE_TOO_LARGE` 拒绝并销毁流；不切下一个 provider 拼接已发送片段，进入已有失败诊断和 fallback 通知流程，不把半截内容落为完整回答。`auditServices1Stream.test.ts` 覆盖已发 delta、超限销毁、失败回调、只保存带诊断的降级回复且不继续外呼。 |
| be-services-1-13 | 已修，待 CI | `ipTelemetryService.ts` JSON 无有效归属地时同样标记 provider 失败，进入既有五分钟冷却并尝试后续 provider。`auditServices1External.test.ts` 检查一次全失败后立即查询不会再次请求同批 provider。 |
| be-services-1-14 | 已修，待 CI | `cdkService.ts` 导出文件名增加随机 UUID，独立请求即使同秒/跨实例也得到不同路径，保留现有净化与路径边界检查。`auditServices1Persistence.test.ts` 并发触发两个文件导出并检查文件名和写流路径互不相同。 |

额外跨组闭环（协调者明确要求）：

- `cdkService.updateCDK` 的类型改为 `expiresAt?: Date | null`；null 使用 `$unset` 删除到期字段，undefined 不改，Date 仍按未来时间校验。与控制器/前端已完成的 null 合同一致，回归用例覆盖三种分支。
- `googleAuthService.ts` 的绑定 session 类型改为 `Awaited<ReturnType<...>>`，Google 与 `linuxDoAuthService.ts` 两个签发调用加 await，匹配 services-2 组共享绑定会话的异步接口。

本组新增回归文件：`src/tests/auditServices1Credentials.test.ts`、`auditServices1External.test.ts`、`auditServices1Cache.test.ts`、`auditServices1Merge.test.ts`、`auditServices1Persistence.test.ts`、`auditServices1Stream.test.ts`。

验证状态：已静态回读本组差异、调用契约与测试替身；未在本机构建、测试、lint 或安装依赖。以上“已修”表示代码已落盘，测试和运行结论待协调者提交后的 GitHub Actions；不将静态检查写成 CI 通过。
