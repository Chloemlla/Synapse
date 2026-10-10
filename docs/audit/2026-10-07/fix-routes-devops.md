# 路由与 CI/部署：逐项修复记录

修复工作树：`Synapse-audit-all-20261007`。范围为 `be-routes-01…24` 与 `devops-01…18`，共 42 项；旧报告只是定位依据，以下以当前调用链为准。未在本地构建、测试、lint 或安装依赖，未连接部署服务器、执行部署/备份脚本、修改锁文件或提交推送。新增测试交由协调者推送后在 CI 验证。

| 编号 | 去向 | 核验与实际改动 |
| --- | --- | --- |
| be-routes-01 | 已修 | `markdownArticleRoutes.ts` 的管理员读、超管写 guard 加入真实 `requireAdminScope`；保留写操作的超管角色门。`auditRoutesArticles.test.ts` 使用真实范围中间件验证无页面权限拒绝、动态赋权后放行。 |
| be-routes-02 | 已修 | `outemailRoutes.ts` quota/send/batch-send 的异常统一固定 500 文案，并把原异常交给日志；既有 400 业务错误保持原契约。 |
| be-routes-03 | 已修 | 删除 `/api/command` 上重复的 `command-limiter` 模块，保留 8 个端点各自 `commandLimiter`；`postTamperModules.ts` 显式声明 route 模式，避免删除模块后治理信息缺失。 |
| be-routes-04 | 已修 | 删除 data collection admin 三组 guard 中的重复 limiter，保留 `/api/data-collection` 公共前缀的单一 limiter；治理声明改为引用 `data-collection-limiter`。根路径采集端点的独立 limiter 未动。新增 HTTP 回归验证每次管理请求只计数一次。 |
| be-routes-05 | 已修 | 首访验证 `/session`、`/complete` 的 500 文案固定，记录真实异常，保留 `verified`、`requiresVerification` 与动态 TTL 字段。 |
| be-routes-06 | 已修 | 文章公开列表、管理列表/详情、删除的四个 500 分支不再透出异常，新增服务端日志；400 业务反馈未改。 |
| be-routes-07 | 已修 | `dataCollectionAdminRoutes.ts` 七个 500 分支改固定中文，保留既有结构化日志；回归覆盖读/删/批删/清空等路径。 |
| be-routes-08 | 已修 | 邮件记录列表/详情的 500 改固定文案并记录异常；服务组已把详情 DB 异常改为 throw，路由可区分失败 500 与真实缺失 404，回归同时断言两者。 |
| be-routes-09 | 根协作修复 | `admin/shortlinks.ts` 批删 catch 确有 error.message 外泄，已交协调者改为固定「批量删除短链失败」，保留上一条 logger 原异常。该文件由控制器组维护，本组未修改。 |
| be-routes-10 | 原报告不成立 | 当前 `passkeyRoutes.maintenance.ts` 七个 500 均为固定操作文案；原报告把每个 catch 内日志的 `error.message` 当成响应字段。本组未改该文件。 |
| be-routes-11 | 不成立 | `safe` 内 `return await fn()` 捕获五个子查询各自的拒绝；fallback `null` 直接作为 JSON 字段，没有报告假设的后续解引用。同步 providerSnapshot 只读 env。意外 async 拒绝还由 Express 5 全局处理；没有可复现的缺失错误边界，不另叠 catch。 |
| be-routes-12 | 随 01 修复 | 未使用的 `requireAdminScope` 导入现已用于两组 guard。 |
| be-routes-13 | 设计观察，未接线事实保留 | 工厂确实只有定义/re-export；但 Lumen 实际私有端点使用 `requireAuth()` 查持久 Session、校验过期，设备/权益/管理端另外有各自守卫。当前 CLAUDE 未声明该工厂已启用；不能由备用工厂未使用推导已存在的认证绕过，也不能直接全树叠加签名破坏现有客户端。未改签名策略。 |
| be-routes-14 | 不成立 | 原 key 为 `archive:${ip}:${archiveName}`，不同名归档不会互斥；进程 kill 后模块 Set 随进程销毁，不会跨重启残留。原建议改用户维度还会允许不同用户对同一个归档目录同时写，故不机械采纳。 |
| be-routes-15 | 已修 | Crash SDK 未预期异常加入 `logger.warn`，保留 best-effort 的 200/accepted:false 协议；ApiError 原状态码和业务响应保持。 |
| be-routes-16 | 不成立 | 公开 tamper 写端点已有模块级 limiter，未给出额度失效/可利用证据；不同产品采用不同限流档不是缺陷，不叠第二份限流。 |
| be-routes-17 | 已修 | IPFS 短链查询/跳转日志改为 debug，只记录 code、found 和请求 IP，不再记录整条记录或目标 URL，避免一次性链接进入日志归档。 |
| be-routes-18 | 设计观察 | 当前注册表无同 component/scope 的重复项；没有实际覆盖缺陷，不做未要求的注册表重构。 |
| be-routes-19 | 与控制器组修复合并 | 旧报告的前后端互通断言已证伪。控制器组已完成 Cookie 会话返回可读分页、Bearer 保留原加密协议及双模式回归；本组不改 AES 算法或该文件。 |
| be-routes-20 | 不成立 | `ok:false` 不满足 `ok===true`，原报告把 false 推成 true；soft 本就是监测模式，第一/第二次执行都不是 enforce。不得按错误建议改签名短路。 |
| be-routes-21 | 设计观察 | miniapi 目前返回 501 stub，没有调用付费 TTS 或实现业务处理；未来实现时需要确定鉴权，不能把未来实现假设当当前匿名计费漏洞。本组未添加不必要的鉴权行为变更。 |
| be-routes-22 | 已修 | EcoEnchants 验证的是同一 JWT_SECRET 签发的 Synapse 用户 JWT，应遵守会话撤销。验证用户后调用 `assertActiveAuthSession`、复用一次 credential hash 并 `touchAuthSession`；独立下载 token 分支保留。回归验证有效签名但已撤销会话拒绝、活跃会话刷新。 |
| be-routes-23 | 设计观察 | mixed 声明仍检查合法 handler、note；strictStackCheck 对选定模块做栈核对。报告没有指出新增可达漏鉴权端点，全量启用涉及子 router/工厂不同结构，不在此轮做无缺陷依据的治理扩张。 |
| be-routes-24 | 已修 | IPFS 短链请求不再主动 `connectMongo()`，而使用已有 `waitForConnection(5000)` 等待驱动恢复；失败返回 503。避免数据库不可用时每个请求重复发起连接/初始化。 |
| devops-01 | 已修触发缺口，纠正严重度依据 | 去掉 Docker push 的 `.github/**` 排除，使 workflow-only 变更也受镜像验证/发布既有条件约束。原文“混合提交合并后不含 .github”不成立，PR 触发器本来也无 paths-ignore，因此不是原报告描述的 PR 门禁绕过。 |
| devops-02 | 已修代码 | 老用户文件修复脚本必须显式设置 ADMIN_PASSWORD，写入 bcrypt 哈希，不再带公开默认密码或打印口令。现有 bcrypt 依赖直接复用，未改锁。历史泄漏无法靠代码删除撤销；如仍有部署使用该旧密码，需由密钥持有人轮换，本轮未访问线上。 |
| devops-03 | 不成立 | pnpm `$name` 是引用当前项目直接依赖范围的合法写法；frontend 自身有依赖声明，锁里展开为版本属于预期。未修改 workspace/lock。 |
| devops-04 | 已修 | package.json 删除不存在的 test:clean；CLAUDE 排障表删除同一死入口。现有 test:db-init 保留且明确只在隔离 CI 测试库执行。 |
| devops-05 | 已修 | Docker deploy job 使用共享 `deploy-production` concurrency group、cancel-in-progress:false，序列化跨 runner 的部署；镜像构建无需占部署锁，同机脚本锁保留。 |
| devops-06 | 已修 | 删除无效且误导的“连字符路由”检查，CLAUDE 同步纠正普通路径连字符合法；不能修正 grep 后把合法路由全变为失败。真实 Express 路由装配由现有构建/测试验证。 |
| devops-07 | 不成立 | 原管道先 grep 出 `.archive.gz(.age)` 再 tail，旁文件不会参与 KEEP 计数；裁剪发生于成功导出及加密之后，正常路径已有归档，原空目录推断无依据。保留策略未改。 |
| devops-08 | 已修 | 恢复实例未就绪、恢复失败、统计查询失败、对比失败均记录 DRILL_FAILED；比较命令纳入 if，防止 set -e 在加密前提前退出；统计为空也不能报告成功。最后加密/保留归档后非零退出，使 daily.sh 汇总失败。未执行部署 shell。 |
| devops-09 | 已修实际链路，纠正泄漏断言 | 上传接口只保存 file 内容，不保存 adminPassword，且需要 JWT+superadmin，所以原“口令持久化/第三方可读”不成立；当前部署调用不带 JWT，实际是死上传。移除部署自动分享与 ADMIN_PASSWORD env，日志由 GitHub artifact 保留 3 天，服务器地址在内存日志和文件头脱敏。未新增专用密钥、未改线上接口。 |
| devops-10 | 已修 | 前端 package.json 删除 test:rate-limit、security-check 和三个 fix:rollup 死脚本。 |
| devops-11 | 不成立 | `_0x` 不是所有混淆配置的必备标识；已有产物字节不同与实际启动冒烟。不把启发式告警升为硬门禁。 |
| devops-12 | 不成立 | pnpm 在 CI 且有锁文件时默认 frozen；未显式传参不等于会静默修改锁。 |
| devops-13 | 已修 | 删除前端不存在的 analyze:bundle 路径入口；根 analyze:full 指向现存脚本，未给前端凭空引入分析器依赖。 |
| devops-14 | 设计观察 | ALLOW_UNVERIFIED_SSH_HOST 必须显式 true，默认严格验证且已有告警；不把应急 opt-out 误报为默认放行。 |
| devops-15 | 已修 | 本地部署锁等待总时长上限 5 分钟，超时抛错交主入口非零退出；不抢占可能仍存活的锁、不删除他人锁文件。 |
| devops-16 | 不成立 | mongoService 用 `MONGO_URI || MONGODB_URI || 默认地址`，空环境变量会按缺省回退；MONGO_PROXY_URL 空串也被条件判断跳过，原“空串必报解析错”不成立。 |
| devops-17 | 已修 | 删除未被 workflow/package 引用的旧 auto-approve.js；其空 statuses.every 可成为真值，保留危险未接线路径没有收益。现有 auto-merge 的人工审查/检查门禁不变。 |
| devops-18 | 不成立 | icons 空分组是已注明的有意保留项，原报告也明确不算缺陷。 |

## 表外补充与 Nightly 存量失败

- `37529016437` 两套件/10 用例在 beforeAll 的真实异常为 Mongo 握手 `Missing required sub-document 'driver'`。对比不是 replicaSet URI：`tests/integration/mongo-replica.test.js` 已明确记录 mongodb 7.6+ 动态 import('os') 在 Jest CJS VM 中失败，driver 把元数据构造异常吞为 `{}`，并用 `runtimeAdapters: { os }` 修复。协调者已将同一适配器用于 `mongoService.ts`；本组未越权修改服务文件。无需盲目换 Mongo 版本或修改连接串。
- Nightly summary 改为区分 Mongo PRIMARY 与应用握手/认证成功，删除过时的 TypeScript 降级指令。`logshare-mongodb.test.ts` 修正真实认证 fixture：在隔离测试库创建超管和 tracked session，上传/读取带 Bearer，完成后清理用户、会话与日志；数据库仍然是真实的，没有 mock 持久化或弱化断言。
- `docker-compose.yml` 的服务级 mem_limit/cpus 在 Compose 仍有效，报告未给出资源限制失效证据，保持。
- `fix-dependabot-alerts.js` 的 fix-alerts 与 repair-lockfiles 是不同动作，前者有意升级漏洞依赖，后者单纯重生锁；不能用后者“不升级”约束前者，保持。

## 验证交接

新增 `auditRoutesArticles`、`auditRoutesErrors`、`auditRoutesDataCollection`、`auditRoutesEcoSession` 四套后端回归覆盖真实范围授权、错误脱敏、重复计数、会话撤销和 404/500 区分。已静态回读差异；实际编译/测试、部署脚本 shell 语法及 Nightly 结果由 GitHub Actions 裁决，CI 链接由协调者统一回填。
