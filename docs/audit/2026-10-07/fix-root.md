# 协调者修复记录

范围是冻结的 fe-api 11 项与 be-core 15 项，以及其他组明确移交的调用方。没有继续扩大审查。以下“已修”仅代表代码落盘，最终以同一提交上的 GitHub Actions 记录为准。

| 编号 | 处置 | 具体实现与边界 |
| --- | --- | --- |
| fe-api-01 | 已修，待 CI | useAdminScope 缓存/inflight 按用户和认证代次隔离；旧请求不能重建已失效缓存；授权失效通知全部 hook 消费方重新加载。前端范围只是展示，后端守卫继续权威裁决。 |
| fe-api-02 | 已修，待 CI | authRequestGeneration 在登录/登出/换号推进代次，store与hook的认证、头像刷新和2FA异步结果写入前核对。迟到结果不恢复旧用户、不清掉新登录。 |
| fe-api-03 | 已修，待 CI | WS 生命周期绑定已认证用户ID，游客登录/切账号后用新Cookie重新握手。 |
| fe-api-04 | 已修，待 CI | removeAuthenticator 删除失败抛给页面，不能再进入“Passkey已删除”的成功分支。 |
| fe-api-05 | 基线已修（cb9fb199） | 新的 fetchWithTimeout 在JSON响应体 clone 消费完成前维持计时器，超时取消会使正文读取拒绝；验证码/IP握手JSON路径已有总消费保护。流式Response仍按原有流生命周期处理，不强行缓存整个流。 |
| fe-api-06 | 已修，待 CI | api与useTts的旧403只派发重新握手事件，不直接清除可能刚存入的新IP验证令牌；服务端握手决定失效。 |
| fe-api-07 | 已修，待 CI | getApiBaseUrl显式配置统一去尾斜杠，手工追加/api时不再双斜杠。 |
| fe-api-08 | 已修，待 CI | LogShare导入先验证条目/主键，再于一个readwrite事务按键增量合并；失败回滚并抛出。取消clear+多次put链，旧数据保留；导入计数取真正新增数。 |
| fe-api-09 | 已修，待 CI | 指纹请求按已认证userId加载/清理；effect卸载和用户变化后旧结果不能回写；未登录不展示。 |
| fe-api-10 | 已修，待 CI | 第三方配置store区分错误与明确禁用，有限退避重试并暴露refresh；LoginPage显示错误及重试入口。 |
| fe-api-11 | 已修，待 CI | CONNECTING/OPEN复用连接，旧回调核对wsRef；disconnect先失效引用和解绑再关闭，手动重连与自动退避分开。 |
| be-core-01 | 已修，待 CI | ipBanCheck与ipUtils的IPv4 /0 显式使用零掩码；不让JavaScript移位模32破坏全网匹配。 |
| be-core-02 | 修正文档；漏洞归因证据不足 | CSP注释改为与实际runtime style策略一致，script nonce仍保留。原报告没有可利用HTML注入点，不能以错误注释为由全面收紧样式并破坏已用运行时组件。未宣称新增CSS注入防线。 |
| be-core-03 | 已修，待 CI | TtsQueue调度错误捕获记录并延迟重试；等待已启动任务结束后释放调度锁，周期回收也重新触发队列，queued任务不依赖新入队才恢复。 |
| be-core-04 | 已修，待 CI | vivo转写进度设置有界总期限，连续三次无效进度进入失败；保留取消与真实进度响应。 |
| be-core-05 | 已修，待 CI | standalone默认只准本实例同源/无Origin客户端；未允许的浏览器Origin在路由前403，CORS与访问判断使用同一函数。自定义跨源界面需配置MEDIA_TOOL_CORS，显式*仍是运维主动选择。 |
| be-core-06 | 已修，待 CI | 重复注册审计视图限制最近1000条、限制用户名/邮箱/UA长度；Mongo原子push+slice，文件回退同样有界。完整审计历史继续归canonical audit log，而非无界单文档。 |
| be-core-07 | 已修，待 CI | WAF超过深度10拒绝并记录，避免不检查子树直接放行；保留既有字段宽松策略，不递归消耗调用栈。 |
| be-core-08 | 已修，待 CI | mvhd回退读取的文件描述符放进finally关闭，readSync异常不漏句柄。 |
| be-core-09 | 已修，待 CI | B站viewCache过期命中删除，设置5000条上限并淘汰最旧项。 |
| be-core-10 | 不成立 | TOTPDebugger有两套现有测试直接引用，属于测试诊断用途；无生产调用。原报告“全树无引用”因排除tests得出，不能据此删除测试依赖或宣称线上验证码泄漏。 |
| be-core-11 | 已清理 | 删除无引用的0字节middleware/test.ts，无业务行为变化。 |
| be-core-12 | 已加固 | restoreAudioAssetToDisk自身校验basename及两平台路径分隔符，调用方原有净化保留。当前调用链原已守界，属于边界内收而非修复可利用路径穿越。 |
| be-core-13 | 随01修复 | CIDR解析network先trim；与写入侧规范化一致。 |
| be-core-14 | 设计观察 | 三套签名实现已逐一确认无具体缺陷；不做无关协议重构。 |
| be-core-15 | 设计观察 | 独立limiter已有响应契约与内存后端语义说明，未发现本次新缺陷，不强行替换。 |

跨组闭环：管理员资源列表新增带认证/角色/范围守卫的GET /api/resources/admin，普通用户原列表仍仅活跃项；CDK API更新类型支持null并由服务$unset；mobileLogin与providerBind控制器同步await共享存储接口；IPQS过滤老配置的api占位；shortlinks批删500固定文案；mongoService采用现有副本集测试验证过的node:os runtime adapter修Nightly握手元数据。

独立静态复核与回归用例追加见 `fix-root-verification.md`。生产迁移和CI状态统一写回 `remediation.md`，不将旧基线的绿灯当作本轮验证。
