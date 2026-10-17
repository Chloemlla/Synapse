# CLAUDE.md

> 本文件是本仓库的**架构与实现指南**：仓库怎么搭起来的、请求怎么流、每层归谁管、常见任务怎么做。
> 工程约束（禁本地构建、提交推送、CI 闸门、依赖新增通路、本机环境）在 **`AGENTS.md`**，
> 那里是操作手册，这里不重复命令清单。
> 治理闸门判据见 `docs/governance/repository-governance.md`；分领域细节见 `docs/reference/`、`docs/audit/`、`docs/perf/`。

## 项目概览

Synapse 是一个以 **文本转语音（TTS）** 为核心的全栈平台，围绕它长出了用户与多因素认证、安全防护（WAF /
限流 / IP 封禁 / 篡改检测 / 账户风险分级 / 逐步验证）、资源商店与 CDK、媒体工具（视频/音频转写、
B 站同步）、**Markdown → Word 批量转换（doc-tool）**、**GeoGebra 协作工作台**、**Pixel 任务工作台**、
法律保留与取证审计、运营与审计等子系统。前后端分离、同镜像发布：后端 Express 提供 API 与 Swagger，
并直接托管前端构建产物。

**技术栈**（版本以 `package.json` / `pnpm-lock.yaml` 为准）

| 侧 | 关键依赖 |
| --- | --- |
| 后端 | TypeScript 6、Express 5、Mongoose 9 / MongoDB、Jest 30 + ts-jest、Winston、helmet、compression |
| 前端 | React 19、Vite 8、Tailwind CSS 4、react-router-dom 7、Zustand、framer-motion、Vitest 5 |
| 工具链 | pnpm 11.11.0（`packageManager` 钉死）、javascript-obfuscator、Playwright（浏览器冒烟） |

代码量级：后端 `src/` 下约 800 个 `.ts`，前端 `frontend/src/` 下约 430 个 `.ts/.tsx`。
数字仅用于「心里有数」，不要写进断言或文档死值——新增模块后它会变。

---

## 目录与分层

```
src/
  app.ts                 入口（约 50 行）：装配 + 启动 + 进程级错误处理
  app/assembly.ts        中间件栈、路由相位挂载、静态资源与 SPA 兜底、错误处理（≈500 行）
  app/startup.ts         Mongo/Redis 连接、WebSocket、优雅停机、启动自检
  config/                静态配置（config.ts / startupConfig）、构建信息、受保护 env 键名
  routes/                HTTP 端点；routeModules/*.ts 是按相位分组的模块注册表
  controllers/           请求/响应处理，业务规则下沉到 services
  services/              业务逻辑（认证、TTS、媒体工具、限流、审计、计费、运行时配置……）
  models/                Mongoose schema、索引、TTL
  middleware/            认证、管理员、WAF、IP 封禁、限流、请求守卫
  security/              安全策略、CSP 管线、安全流水线相位
  tts/  mediaTool/       TTS 管线与媒体工具子系统（转写、B 站下载、文件沙箱）
  docTool/               Markdown → Word 批量转换（服务端 pandoc、串行任务队列、内置 ZIP）
  geogebra/              GeoGebra 工作台（项目/版本/协作/评论/分享/资产/AI 任务/导出/诊断）
  pixel/                 Pixel 任务工作台（卡密校验/任务提交/导出/上游适配/取证保全）
  generated/             生成物（勿手改，由 script 生成、CI 卡漂移）
  utils/                 日志、cookie、IP、工具函数
  tests/                 后端 Jest 用例

frontend/src/
  main.tsx               入口（挂载 + 非关键脚本延迟注入）
  App.tsx                路由表（全部页面懒加载）、全局 Provider、首屏闸门
  components/            UI；components/admin/ 是管理面板
  api/                   axios 实例与各域 API 客户端
  hooks/  stores/  utils/  navigation/  layout/
  tests/                 Vitest 用例
```

**分层约定**：`routes`（定义路径 + 挂限流器）→ `controllers`（解析/校验/回响应）→ `services`（业务与外部 IO）→
`models`（持久化）。服务层以**函数式导出**为主；控制器不直接碰 Mongoose 模型以外的业务规则。

**三个「子系统目录」不是新分层**：`tts/`、`mediaTool/`、`docTool/`、`geogebra/`、`pixel/` 各自在内部复刻
同一套 routes/controller/service 习惯，只是把**一个功能的全部实现**收在一个目录里，避免往全局
`services/` 里再堆几十个文件。跨子系统共享的东西（审计、限流、加密、用户）仍然放在全局 `services/`、
`middleware/`。新增子系统按这个形态建目录，不要散落到全局。

---

## 启动与请求生命周期

### 启动顺序

`src/app.ts` 只做四件事：设时区（`Asia/Shanghai`）、挂进程级 `unhandledRejection` / `uncaughtException`
（后者记录后 `exit(1)`），然后依次调用 `registerCoreMiddleware` → `registerSecurityMiddleware` →
`registerApiRoutes` → `registerStaticRoutes` → `registerErrorHandlers`，最后 `startServer(app)`
（非 test 环境）。真正的连接、WebSocket、优雅停机都在 `src/app/startup.ts`。

### 中间件与安全层顺序（**不可随意重排**）

顺序定义在 `src/app/assembly.ts`，自外向内大致是：

1. **CSP + surface 判定**（`security/contentSecurityPolicy.ts` 直接写头：文档响应带 nonce 与完整策略，
   API/静态产物走最小策略；同一处判定 `res.locals.cspSurface`，供 HTML 注入复用）
2. **helmet**（HSTS / noSniff / frameguard……；CSP 已由上一相位接管，helmet 侧关闭）→ 去掉 `Server` / `X-Powered-By`
3. **响应压缩**（`compression`；显式跳过 `text/event-stream` 与 206/Range —— SSE 与音频分段请求压缩会坏事）
4. CORS 特例：`/s/*path` 与 `/api/health`（它们在 `globalCors` 之前，需自带白名单 CORS）
5. **preBodyParser 安全相位**：IP 封禁检查 → 全局审计拦截（包 `res.json`/`res.send`）
6. preParser 路由相位（健康检查等不需要 body 的端点）
7. `requestIdMiddleware` → 请求画像中间件 → **body parser**（JSON 10 MB；
   `verify` 里做原型污染快速扫描，并只为签名面 `nexai/cdict/lumen` 保留 `rawBody`）→ urlencoded
8. **postBodyParser 安全相位**：WAF（`WAF_ENABLED=false` 可关，不推荐）
9. `globalCors` → `isLocalIp`（本机判定，用于限流豁免）→ 访问日志
10. **API 路由相位**：open-CORS 特例 → 认证类免缓存头 → early → **route limiters** → preDocs →
    preTamper → **postBodyParser 之后的篡改守卫** → postTamper → legacy API 重定向
11. **静态资源 + SPA 兜底**：`/cdn-cgi`、`/static/audio`、前端产物（`/static` 挂载优先于根挂载）、
    SPA catch-all（注入 CSP nonce 后回 shell）
12. **错误处理**：全局兜底限流 → JSON 语法错 400 → passkey 错误映射 → 500 → 404

新增路由/中间件时先读这一段与 `assembly.ts`：**安全层的相对顺序是设计的一部分**，
例如 CORS 必须在 WAF 与限流之后、JWT 之后才能进业务处理器。

---

## 配置系统

- **静态配置**：`src/config/config.ts` 导出 `config`（运行期可读的汇总）与 `startupConfig`（启动时解析）。
  生产环境**必需** `ADMIN_PASSWORD` 与 `JWT_SECRET`，缺失直接抛错；`bcryptSaltRounds` 默认 12。
- **运行时配置**：`src/services/runtimeConfigService.ts` 把一批可在线修改的设置（TTS 生成码、邮件系统、
  IPQS、LinuxDo 信用、Google 登录、外部服务密钥等）持久化到 MongoDB，由管理端
  `/api/admin/**/setting` 系列端点（`src/routes/admin/config.ts`）读写，前端对应
  「运行时配置」分区。**需要「超管可在线调整、不写死」的行为都挂在这里**，不要在代码里硬编码常量。
- **环境变量**：完整清单与注释以 **`.env.example`** 为唯一来源（不要在本文件维护第二份）。
  注意 `USER_STORAGE_MODE` **只接受 `mongo`**，传别的值会抛错。
- 受保护 env 键（不允许运行时改写）列在 `src/config/protectedEnvKeys.ts`。

---

## 认证与授权

**五种认证手段**：密码（bcrypt）、TOTP、Passkey/WebAuthn、邮箱验证、备份恢复码。

**会话模型**（关键）：用户身份由 JWT（HS256，有效期取 `JWT_EXPIRES_IN`）承载，同时服务端在
`auth_sessions` 里维护可撤销会话记录：

- Web 端凭据放在 **HttpOnly Cookie `synapse_token`**（`src/utils/authCookie.ts`），不要再让 JS 读 token；
- 原生/脚本客户端用 `Authorization: Bearer <token>`；
- 每个受保护请求都会校验会话仍存在（`assertActiveAuthSession`）并刷新活跃时间（`touchAuthSession`），
  因此**改密/登出/管理员撤销会立刻生效**；
- 认证入口：`src/middleware/authenticateToken.ts`（会话 + 禁用/封停校验）与
  `src/middleware/auth.ts` 的 `authMiddlewareV2`（兼容旧路径，内部走同一套检查）。

**授权分档**：`user` / `admin` / `superadmin`。

- `admin`：只读业务 + 用户管理、API Key、OAuth 客户端/授权管理；
- `superadmin`：系统级写操作（运行时配置、危险开关、维护动作）；
- **普通管理员的页面授权是运行时可配的，不是写死的**：
  - 页面登记表 `src/config/adminPages.ts`：每个页面声明自己的 API 前缀（`apiPrefixes`）。
    新增页面在这一处加一条即可；**未登记前缀的页面只能给超管**（fail-closed：漏登记是功能缺失，不是权力漏洞）。
  - 授权配置：Mongo 集合 `admin_scope_configs`（`defaultPages` + `perUser` 覆盖），
    由 `services/adminScopeConfigService.ts` 读取（进程内 15s 缓存），超管通过
    `/api/admin/admin-scope/setting`（GET/PUT/DELETE）在线调整；文档不存在时按历史默认集合。
  - 任意管理员可用 `GET /api/admin/admin-scope/me` 拿自己可见的页面列表（前端据此过滤入口）。
  - 守卫 `src/middleware/adminScope.ts` 的判定顺序：用户自助端点 → 管理员身份 →
    只要求身份的自检端点（`/api/admin/verify-access`、`.../admin-scope/me`）→ 超管 → 页面授权。
    403 会带上 `requiredPages`，直接告出「该给谁开哪个页面」。
- 被**封停**的账户统一返回 `403 { error, code: "ACCOUNT_SUSPENDED", supportEmail }`
  （`src/services/providerAuthErrors.ts` 提供类型与响应体构造函数）；被**禁用**的账户是
  `403 { error: "账户已被禁用" }`（无 code）。第三方（Google/LinuxDo）与移动端登录必须抛
  `AccountSuspendedError` 让控制器映射成同一契约，前端靠 `code` 弹申诉入口；
  **不要用裸 `Error("账户已被封停")`**。

**第三方登录/绑定**：`services/googleAuthService.ts`、`linuxDoAuthService.ts`、
`providerBindSessionService.ts`、`accountIdentityService.ts`。未绑定身份的第三方账号一律走「显式验密绑定」
（`provider-bind` 流程），**不做按邮箱静默并号**（防账号接管）。

**安全会话（敏感操作二次验证）**：`src/utils/securitySession.ts` 是唯一实现源。

- 用户先经 `/api/admin/user/profile/verify`（密码 / TOTP / passkey）拿到 `verificationToken`，
  放在 `x-verification-token` 请求头；前端由共享 axios 实例与 env-manager 的 `authFetch` **统一附带**
  （漏传的后果是管理员点保存得到一个看不懂的 403）。
- 守卫有两种：`requireSecuritySession`（同步校验存在与归属）与 `assertSecuritySessionBinding`
  （异步绑定判定：UA 摘要已在签名 payload 里，不匹配立即失效；IP 变化不直接踢人，只有 `isGeoJump`
  跨地才终止会话并 `revokeAllAuthSessions`，同城异网只写信号）。
- **不要在控制器里再写一份同步副本** —— 那会让绑定校验在这条链路上静默失效（已发生过一次）。
- 覆盖面：运行时配置写入、环境变量增删改、密钥读取/轮换、命令执行、双因素配置、第三方绑定、
  法律保留与取证导出。新增敏感端点时先问一句「这个动作能不能用一次会话继续做」。

**按同意开放功能（feature consent gate）**：`src/middleware/featureConsent.ts` + `src/config/featureConsent.ts`。

- 与政策同意的区别：政策同意是**全站准入**，这里的门禁是**按功能放行**——用户只同意某几个功能对应的
  条款，就能用那几个功能。
- 契约：只认 `userId`、**不回落设备指纹**、服务层**不做缓存**（撤销后下一请求立即 403）；
  拒绝统一回 `code: POLICY_CONSENT_REQUIRED` + 缺失条款清单。
- 匿名路由用 `requireFeatureConsentForAuthenticatedUser`：匿名请求原样放行，识别出 `userId` 后才复用同一门禁。
- 加新功能：在 `config/featureConsent.ts` 加键 → 在目标路由的**认证之后**挂 `requireFeatureConsent(key)`
  → 前端页面若可能有 403 就包 `<FeatureConsentGate feature="...">`。
  `securityGovernanceCoverage.test.ts` 会钉住已接线的键，漏挂或误删即红。

**账户风险分级与逐步验证**：`services/accountRiskService.ts`（唯一写入口 `applyAccountRiskAction`）、
`middleware/accountStepUpGuard.ts`、`services/geoRisk.ts`（属地判据单一入口）、
`middleware/regionGuard.ts`。

- **所有处罚/升档只经 `applyAccountRiskAction` 这一个出口**，直接改用户字段会让审计与升降档规则脱节。
- `isRiskExempt` 只认 superadmin；豁免范围与「不豁免的三件事」写在 `services/riskExemption.ts`。
- **匿名链路只能记信号、不得升级为封禁**：登录前人机验证失败这类拿不到可信 `userId` 的路径，
  评分按半权重、总额封顶，且必须带 `requireKnownIp` 归因闸（否则任何人都能拿别人用户名刷对方风险分）。
- 客户端上报的探测结果（WebRTC 出口不一致、`navigator.webdriver`）**只作信号**，受
  `accountRisk.ipRecheckEnabled` 观察期开关控制，默认关。

---

## 限流系统

- 单一定义处：`src/middleware/routeLimiters.ts` 的 `LIMITER_DEFINITIONS` +
  `limiterFromDefinition()`；每个限流器有 `profile`（窗口/额度档位）与 `category`（指标分类）。
- 存储后端：`src/services/sharedRateLimitStore.ts`。配了 `REDIS_URL` 走 Redis（多实例一致），
  未配则退**有界进程内存档**；`category: "static"` 的三道闸（`static` / `frontend` / `audio`）
  强制走内存档——静态资源是防刷语义、不是配额，不该每个资源请求打一次 Redis。
  需要跨实例一致性的调用方（API Key 配额）显式走 `requireSharedBackend`。
- 相位挂载：限流器作为模块登记在 `src/routes/routeModules/routeLimiterModules.ts`，由 `assembly.ts`
  在 early 相位统一挂载。**新增路由必须配一个限流器**，且不要在子路由重复挂同一个实例
  （一次请求会过两遍、额度减半）。
- **匿名请求是双判据**：除 IP 桶外，再按设备/浏览器指纹（`X-Fingerprint`，H5 用 `x-device-id`）
  **单独计一个桶，两桶各自计数、任一超限即拒绝**。刻意不把两者拼成一个键（`ip|fp`）：拼键时换指纹
  或换 IP 都会得到全新桶，等于给刷子发新额度。指纹是客户端自报的，只能作附加维度、不能替代 IP；
  登录请求不参与（账户 ID 已是更强身份），不带指纹的客户端行为与单 IP 判据一致。
  存储键只用指纹的 SHA256 前 32 位，不落原文。
- **并发硬顶**：`createBurstConcurrencyGuard()` 按「在途请求数」限制昂贵端点（与固定窗口限流正交），
  超顶立即 429 + `Retry-After`（不排队 —— 排队本身就是新的内存压力），`finish`/`close` 双释放槽位。
- **每用户并发**：TTS 队列按 `userId` 统计 `queued+processing`，超 `perUserMaxActive` 直接 429
  `TTS_USER_CONCURRENCY_LIMIT`；这与「全局队列并发」是两个层面，别互相替代。
- **配额阶梯**：`services/quotaLadderService.ts` 是泛化后的「日额度 → 警告 N 次 → 按累计违规次数递增
  封禁时长」引擎；`libreChatQuotaService` 是第一个消费者（响应体形状保持不变）。封禁动作走
  `applyAccountRiskAction` 统一出口，默认观察期不自动处罚。
- **配额事件与账户预算**：`services/quotaEventService.ts` 按 `keyId+阈值+账期` 幂等写 80%/100% 事件；
  账户级日/月预算取 `min(账户剩余, Key 剩余)`，`admin`/`superadmin` 按既有口径豁免。
- 429 会记指标（`RateLimitMetricsRegistry`，按 IP/路由的有界 Map）并打一条结构化告警日志。

---

## 数据层

- **唯一真相源是 MongoDB**（`src/services/mongoService.ts`，连接由 `startup.ts` 建立，
  不要在别处新建连接）。Redis 可选，用于 IP 封禁与限流加速，缺失时安全降级。
- **管理端只读浏览 Redis**：`/admin/system` 的「Redis 在库数据」面板取
  `src/routes/admin/system.ts` + `services/redisAdminService.ts`。列表一律 SCAN 分页（**禁用 `KEYS`**），
  快照导出走 `DUMP`+`PTTL`（NDJSON，base64 承载，必须字节精确）。写回用
  `scripts/redis-restore-snapshot.js`（默认 dry-run，`--apply` 才写、`--replace` 才覆盖）。
  Redis 与其它应用共享时用 `ADMIN_REDIS_KEY_PREFIXES` 把范围收窄到本服务命名空间。
- 模型在 `src/models/`，索引与 TTL 就近声明。已经具备的代表性约束：
  审计日志 **60 天** TTL（`AUDIT_LOG_RETENTION_DAYS`）+ `requestId`/`createdAt`/`module`/`userId`/`action` 索引；
  会话表按 `userId` 前缀建索引；`credentialHash` 唯一索引；IP 封禁表 `ipAddress`/`fingerprint` 索引。
- **物理 TTL 与法律保留不兼容（裁决三）**：Mongo 的 TTL 后台线程会在应用层来得及校验 `legal_holds`
  之前就把文档删掉。因此六个关键集合**只保留查询索引、不再带 `expireAfterSeconds`**
  （`ipbans` / `accesstokens` / `ip_verification_tokens` / `verification_tokens` / `proxycheck_risk_cache` /
  `auth_email_cooldowns`），过期清理由 `services/legalHoldCleanupService.ts` 每 6 小时执行，
  **删除前逐条校验 hold，库不可用时整轮 fail-closed**。
  ⚠️ 改 schema 只影响**新建**索引；线上老索引必须用 `pnpm run migrate:legal-hold-ttl`
  （默认 dry-run，按索引形状匹配、带 `--apply` 才删）摘除，否则 TTL 继续绕开 hold。
- **取证审计不设 TTL**：`forensic_audit_logs` / `forensic_export_requests` 刻意无过期 ——
  调查周期经常长于普通审计的 60 天，TTL 会把证据静默删掉。普通业务审计仍是 60 天；
  `legal_holds` 的增删在服务层**双写**普通审计与取证集合（覆盖 Pixel 保全这条内部路径）。
- 查询习惯：读多写少的列表一律 `.lean()` + `select()` 投影；筛选/排序/分页**下推到 Mongo**
  （管理端用户列表用 `$facet` + `$skip/$limit`），不要把整表读进内存再分页。
- 写入习惯：批量操作走 `bulkWrite` / `updateMany`；高频审计写入走内存缓冲 + 定时 `insertMany` 批量落库。
- 需要「过期即清」的集合请加 TTL 索引，不要靠定时任务扫表。持久化细节见
  `docs/reference/backend-mongo-persistence-detail.md`。

---

## 可观测性

- **日志**：`src/utils/logger.ts`（Winston，写到 `logs/`：`error.log` + `combined.log`，
  20 MB × 10 轮转）；`src/services/logger.ts` 是只有 `middleware/ipCheck.ts` 用的按日切分文件日志。
  `ACCESS_LOG_ENABLED` 开访问日志，`VERBOSE_LOGGING` / `VERBOSE_REQUEST_DUMP` 只在排查时临时开
  （默认不落 PII，头部只留白名单字段）。
- **健康与状态**：`/health` 与 `/api/health`（同一 router，preParser 相位）、`GET /api/status`
  （公开：版本 + 短 SHA）、`POST /api/server_status`（需 `SERVER_PASSWORD` 的超管诊断）。
- **请求画像**：`services/profilingService` + `/api/status/profiling`（超管），用于看慢请求分布。
- **审计**：`services/auditLogService.ts` 全局拦截所有 `/api` 响应写审计（默认不抓 body，
  `AUDIT_LOG_CAPTURE_PAYLOADS` 才开），统计走 `$facet` 一次扫描。

---

## 前端架构

- **入口与路由**：`main.tsx` 挂载；`App.tsx` 用 `React.lazy` 注册**所有**页面路由，
  并在 shell（桌面侧栏 / 移动端）之间切换。非关键第三方脚本（如 Clarity）延迟到首屏后注入，
  且在验证类页面禁用（会与验证码 PoW 抢主线程）。
- **管理面板注册**：只在 `frontend/src/components/admin/adminModules.tsx` 的 `ADMIN_MODULE_LOADERS`
  登记模块；`scripts/generate-admin-spa-paths.js` 会据此生成
  `src/generated/adminSpaModulePaths.ts`（管理面板 + 前端静态路由两份清单），供
  `src/routes/legacyApiRedirect.ts` 判断「这是前端页面还是 API」。
  漏登记的表现是深链被 308 到 `/api/...`；`pnpm run check:admin-spa-paths` 会在 CI 卡住漂移。
- **API 层**：`frontend/src/api/api.ts` 是共享 axios 实例（补 IP 验证头、错误重试、403 申诉分类）。
  **新增调用一律走它**；确实需要 raw `fetch` 时（如第三方登录回调页），必须自己把失败响应交给
  `maybeEmitPenaltyAppealFromResponse()`，否则封停等处罚态在前端弹不出申诉入口。
- **构建与分块**：`frontend/vite.config.ts` 用 rolldown 的 `codeSplitting.groups` 做手动分块
  （不是 `manualChunks`，那个的 `includeDependenciesRecursively` 会把重依赖一起吞进小块），
  并保持「重包不进首屏静态闭包」。CI 的 `check:frontend-bundle` 会校验
  入口 / 单 chunk / 总量 gzip 预算与首屏闭包，详见 `docs/perf/2026-10-01-captcha-verify-trace-analysis.md`。
- **状态**：Zustand 三个 store（auth / authProvider / ui），组件用选择器订阅，别整包订阅。
- **WebSocket**：`hooks/useWebSocket.ts` + `components/WsConnector.tsx`（指数退避重连、
  后台标签页不做无用的碰撞检测）。
- **视觉基线只有一套**：`components/studioTheme.tsx`（配色 token、面板/磁贴/按钮/字段类名、
  `InfoQueryHero` / `InfoSectionTitle` / `InfoMetricCard` / `InfoBadge` / `InfoPanel`）与
  `components/studioFeedback.tsx`（`StudioModal` / `StudioErrorState` / `StudioEmptyState` /
  `StudioLoadingState` / `StudioPager` 等四态原语）。**新代码从这里取，不要自建弹窗、自写四态、
  自绘 spinner**；也不要引入 indigo/purple/fuchsia/pink 与任意 hex。
  规则由 `pnpm run check:frontend-design-language` 把关（基线在
  `scripts/governance/frontend-design-language-baseline.json`，**只允许下降**），
  清单与编号见 `docs/audit/audit-2026-10-16-frontend-design-language.md`。
- **flex 溢出的固定坑**：`justify-between` 行里，承载文本的兄弟节点必须 `min-w-0`，
  右侧图标/按钮才该 `shrink-0`。flex 子项默认 `min-width: auto` 不收缩，长标题/长邮箱会直接把
  图标顶出卡片；卡片通常带 `overflow-hidden`，溢出的部分是被**裁掉**的——表现是「文字消失」，
  不是「没换行」。同理，绝对定位的纯装饰层要 `pointer-events-none`，否则会挡住下面可点的内容。
- **重依赖不进首屏静态闭包**：`docx`、`katex`、`mermaid`、`monaco-editor`、`react-syntax-highlighter`、
  `exceljs` 一律**动态 `import()`**，模块到达前先渲染可读的退化形态（等宽纯文本/占位），加载失败也要
  有可见退路。`check:frontend-bundle` 会校验首屏闭包与预算。

---

## 测试体系

| | 后端 Jest | 前端 Vitest |
| --- | --- | --- |
| 配置 | `jest.config.js`（+ `jest.ci.config.js`、`jest.nightly*.config.js`）、`tsconfig.jest.json` | `frontend/vitest.config.ts` + `vitest.setup.ts` |
| 用例位置 | `src/tests/**` | `frontend/src/**/*.test.{ts,tsx}` |
| 特点 | `testTimeout` 30s、`maxWorkers: 1`、`detectOpenHandles`，**刻意不设 `forceExit`** | jsdom 环境、自定义覆盖率 provider |

- **两棵树互不交叉**：`jest.config.js` 的 `testPathIgnorePatterns` 排除 `frontend/src`，
  Vitest 只收 `frontend/src`。用例放错树＝永远不跑。
- `jest.ci.config.js` 额外排除需要真实外网/线上环境的用例（`logshare-mongodb`、`policyApi`、
  `ipfs-upload`、`network-apis` 等）与 `tests/browser` 的 Playwright 规格。
- 需要副本集语义的用例走 `test:integration:mongo`（真实 replica set + 事务/TTL）；
  浏览器冒烟走 `test:browser`（Playwright，验证 HttpOnly cookie 的 set/read/clear）。
- **替身一致性**：`jest.mock` 工厂漏一个导出，就会让生产代码在调用点抛 `TypeError`
  并被上层 catch 成 4xx/5xx——现象像业务坏了，根因在替身缺件。改生产代码前先搜有没有替身依赖该成员。

---

## 构建与部署

- **构建脚本**：`build:backend` = 生成 admin 路径 → `tsc` → 拷模板 → 混淆 → 拷混淆产物；
  `build:frontend` 由 Vite 产出（并做混淆与非 ASCII 转义）。
  `build:simple` / `build:minimal` 是给资源紧张场景的降级路径。
- **混淆**：后端 `dist/` → `javascript-obfuscator` → `dist-obfuscated/`（配置在 `package.json`），
  生产镜像跑的是混淆产物；CI 有 `smoke:obfuscated` 在生产模式下真启动一次做冒烟。
- **Docker**：三阶段（`frontend-builder` → `backend-builder` → `production`，均基于
  `node:24.20.0-alpine`），运行时 `CMD ["node", "dist/app.js"]`，只 `EXPOSE 3000`。
  前端静态产物由后端直接托管（`SERVE_FRONTEND=false` 可关），**3001 只是 Vite 开发/预览端口**。
- **本地开发端口**：后端 3000、前端 3001；`docker-compose.yml` 只把 3000 绑到 `127.0.0.1`，
  并要求 `./data` 的属主可写（容器以非 root 运行）。
- **发布**：`Docker` workflow 在 `main` 上构建/发布镜像；灰度/部署细节见 `.github/workflows/docker.yml`
  与 `docs/guides/`。

---

## 常见任务

**新增一个 API 端点**
1. `src/routes/<域>Routes.ts` 定义路径（遵循 Express 5 的命名参数/通配符语法，路径中的普通连字符合法）；
2. `src/controllers/` 加处理器（校验入参、调 service、回响应）；
3. 需要业务逻辑就加 `src/services/`（函数式导出）；
4. 需要持久化就加 `src/models/`（顺带想清楚索引与 TTL）；
5. 在 `src/middleware/routeLimiters.ts` 加限流器定义并导出；
6. 若是新模块，登记到 `src/routes/routeModules/` 的对应相位文件，并在
   `routeLimiterModules.ts` 挂上限流器；
7. `pnpm run generate:openapi` 更新文档，`check:openapi-drift` 会卡注释与 spec 的漂移。

**新增一个前端页面**：建组件 → `App.tsx` 加 `React.lazy` + `<Route>` → 补 `routeConfig.titles`
（`/admin/<module>` 还要在 `adminModules.tsx` 登记）。生成物由 CI 的 drift 闸门兜住。

**新增一个管理面板页面**：只改 `adminModules.tsx` 的 `ADMIN_MODULE_LOADERS`；
深链放行清单（`src/generated/adminSpaModulePaths.ts`）由该注册表生成，因此会自动带上新模块。
要让页面能授给普通管理员，再到 `src/config/adminPages.ts` 里加一条（key 与 `/admin/<key>` 对齐 + `apiPrefixes`），
然后在超管界面的页面授权里勾上；前端入口会自动跟随授权结果。

**新增一条静态治理闸门**：脚本放 `scripts/governance/check-*.js`（纯 Node，不引第三方依赖）→
在 `package.json` 加 `check:<name>` → 接进 `.github/workflows/quality-guardrails.yml`。
存量违规要落基线文件、闸门**只报新增**且允许数值下降（参考 `frontend-design-language-baseline.json`、
`slicing-and-softdelete-baseline.json`）。**不要用 `--update-baseline` 掩盖真实新增**。

**新增一个「按同意放行」的功能**：`config/featureConsent.ts` 加键（含要哪几份条款与依据）→
目标路由认证之后挂 `requireFeatureConsent(key)` → 前端页面包 `<FeatureConsentGate>` →
`securityGovernanceCoverage.test.ts` 补一行断言。

**加一个需要法律保留保护的数据集**：模型登记进 `services/legalHoldCleanupService.ts` 的
`LEGAL_HOLD_CLEANUP_TARGETS`（集合名用**实际落库名**，Mongoose 大写化会产生歧义）→
确保该集合**不带物理 TTL** → 隐私地图登记 → 写进 `docs/reference/data-retention-and-legal-hold.md`。

**新增依赖**：走 `AGENTS.md` §7 的通路（只改清单，锁文件由 CI 的 `Update Lockfiles` 工作流重生）。

**加索引 / TTL**：在对应 model 里 `.index(...)` 声明；线上大集合加索引前先评估构建开销。

**只跑某个测试**：`pnpm run test -- --testPathPatterns="<域>"`、
`pnpm run test -- --testNamePattern="<用例名>"`，前端用 `pnpm --dir frontend run test <pattern>`。

---

## 排障

| 症状 | 先看什么 |
| --- | --- |
| 启动即抛错 | 生产是否设了 `ADMIN_PASSWORD` / `JWT_SECRET`；Mongo URI 是否可解析（缺失库名时看 `MONGO_DB`） |
| Mongo 连不上 | `MONGO_URI` 格式与优先级、副本集广告地址、防火墙；连接池与自愈逻辑在 `mongoService` |
| 想快速看系统全貌 | `logs/combined.log`、`/health`（Mongo/WS 状态）、`POST /api/server_status`（口令或管理员会话）、管理面板首页 |
| 某个 API 突然 403 | 中间件顺序（IP 封禁 → WAF → 限流 → 认证 → 管理员范围）；`code` 字段能直接定位是封停/禁用还是范围收窄 |
| 前端白屏 / 深链 308 | 管理面板路径清单是否漂移（`check:admin-spa-paths`）；SPA 兜底是否被前端构建缺失影响（看启动日志里 `Serving static files from`） |
| 体积闸门红灯 | `pnpm --dir frontend run build` 后看 `check:frontend-bundle` 的首屏闭包与重包归属；不要用 `manualChunks` 兜 |
| 构建产物看着像是旧的 | `pnpm run build:backend:clean`（先清 `dist` 与 `dist-obfuscated`）再判；本地清缓存不能代替 CI |
| 测试环境脏了 | 在隔离的 CI 测试库运行 `pnpm run test:db-init`（初始化测试库） |
| CI 红但本地看着没问题 | 按 `AGENTS.md` §0 第 2 条取父提交同名 job 的历史结论做归因；注意 `skipped` 的步骤不等于通过 |
| 线上日志只有一句模糊错误 | 先确认是不是「把预期拒绝当异常」（如封停打成 `logger.error` + 堆栈）；处罚类必须带 `code` 才能被前端识别 |

---

## 安全注意事项

- **管理端接口**：必须同时满足有效会话 + `admin`/`superadmin` 角色 + 更严格的限流。
  绝不允许绕过管理员校验或范围守卫。
- **Redis 在库数据浏览器**（`/admin/system`，只读）是**三层保护**：挂载级管理员范围守卫 →
  超管硬校（`isSuperAdmin`）→ 全站统一安全会话（`hasValidSecuritySession`，10 分钟 TTL）。
  它逐请求写审计，且**只记键名与规模，不把键值写进审计/日志**（通用 `auditLog` 中间件会把响应体
  抄进审计库，所以这里用 `AuditLogService.log` 手写）。改这个面板时别把 `captureBody` 类中间件加回去。
- **RDB 导出只能在宿主机做**：应用进程看不到 Redis 数据目录，node-redis 也不支持 PSYNC；
  面板的 `format=rdb` 会明确 501 并指向 `deploy/openresty/backup-redis.sh`，不要为此去猜实现。
- **密码与令牌**：bcrypt（12 轮）哈希；日志、审计、接口响应里不出现密码/令牌/密钥/密文；
  Mongoose 敏感字段用 `select: false`。
- **IP 封禁**：最外层守卫，支持单 IP 与 CIDR，存 Redis（若有）或 Mongo；
  内部/回环地址的豁免只应在开发环境放宽。
- **WAF**：`src/middleware/wafMiddleware.ts` 覆盖 SQL 注入、XSS、路径穿越、命令注入等；
  绕过表在启动时预计算成 Map，业务字段（HTML/markdown 等）通过白名单子树跳过；
  可通过 `WAF_ENABLED=false` 关闭，但生产不建议。
- **CSP**：nonce 由服务端每响应生成，HTML 与响应头取同一个值；改静态资源托管或注入脚本时，
  确认 nonce 仍被正确注入（`security/contentSecurityPolicy.ts`）。
- **响应压缩**：跳过 `text/event-stream`（SSE 会被缓冲成一次性响应）与 206/Range
  （压缩后的字节区间与 `Content-Range` 不再对应，音频 seek 会取到错位数据）。
- **处罚态契约**：封停（`ACCOUNT_SUSPENDED`）、通道受限（`ACCOUNT_RESTRICTED`）、工单封禁
  （`TICKET_PERMISSION_BANNED`）、同意缺失（`POLICY_CONSENT_REQUIRED`）、逐步验证
  （`STEP_UP_REQUIRED`）、安全会话（`SECURITY_SESSION_REQUIRED`）都带稳定 `code`，前端据此弹对应入口；
  禁用的 403 目前只有文案。新增任何「拒绝用户」的分支都要先问一句「前端怎么识别它」——
  靠文案匹配是最后选择，不是默认选择。
- **CodeQL 告警的处理顺序**：先判断能不能**真修**，优先把守卫改写成静态分析**看得见**的形态。
  典型手法：自定义守界函数改成「`path.resolve` 后与解析过的根做前缀比较」并把结果直接交给
  `fs.*`；用户可控值先经 `path.basename()` 重新锚定。这样不用抑制也能让数据流收敛。
  ⚠️ **`// codeql[<rule-id>]` 注释在本仓库只是给人看的说明，不构成抑制**——本仓库的 CodeQL
  工作流没有启用 `alert-suppression` 查询，注释写上去告警照样 open（曾因此误以为已收口）。
  确实属于「工具看不到守卫」且无法改写时，走 GitHub 界面或 API 按 `false positive` 关闭，
  并在注释里写清依据（谁做的守界、为什么数据不可控）；**不要只写「误报」了事**。
- **审计脱敏字段**：`src/utils/auditRedaction.ts` 是唯一来源（EXACT 精确匹配 + SUBSTRING 包含匹配）。
  新增凭据类字段名（含 `verificationToken` 这类一次会话令牌）要同时加进 EXACT 表，
  否则 `AUDIT_LOG_CAPTURE_PAYLOADS=true` 时会被写进 60 天可导出的审计库。
- **日志里绝不出现密钥原文**：CodeQL 会把 `apiKey*` 域的数据流一律视作凭据，因此记 `keyId` / 条数 /
  动作名这类元数据时也要在行上写清「记录的是什么」，避免反复被同一类告警打断。
- **NAT 与设备判据要成对出现**：只用 IP 会在校园网/运营商 NAT 后误伤，只用客户端自报标识会被伪造；
  限流与风险判定都应保持「IP + 设备」两个正交维度，且两者各自独立计数。
