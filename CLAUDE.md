# CLAUDE.md

> 本文件是本仓库的**架构与实现指南**：仓库怎么搭起来的、请求怎么流、每层归谁管、常见任务怎么做。
> 工程约束（禁本地构建、提交推送、CI 闸门、依赖新增通路、本机环境）在 **`AGENTS.md`**，
> 那里是操作手册，这里不重复命令清单。
> 治理闸门判据见 `docs/governance/repository-governance.md`；分领域细节见 `docs/reference/`、`docs/audit/`、`docs/perf/`。

## 项目概览

Synapse 是一个以 **文本转语音（TTS）** 为核心的全栈平台，围绕它长出了用户与多因素认证、安全防护（WAF /
限流 / IP 封禁 / 篡改检测）、资源商店与 CDK、媒体工具（视频/音频转写、B 站同步）、运营与审计等子系统。
前后端分离、同镜像发布：后端 Express 提供 API 与 Swagger，并直接托管前端构建产物。

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
  tts/  mediaTool/       TTS 管线与媒体工具子系统
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

---

## 启动与请求生命周期

### 启动顺序

`src/app.ts` 只做四件事：设时区（`Asia/Shanghai`）、挂进程级 `unhandledRejection` / `uncaughtException`
（后者记录后 `exit(1)`），然后依次调用 `registerCoreMiddleware` → `registerSecurityMiddleware` →
`registerApiRoutes` → `registerStaticRoutes` → `registerErrorHandlers`，最后 `startServer(app)`
（非 test 环境）。真正的连接、WebSocket、优雅停机都在 `src/app/startup.ts`。

### 中间件与安全层顺序（**不可随意重排**）

顺序定义在 `src/app/assembly.ts`，自外向内大致是：

1. **CSP nonce + surface 判定**（`res.locals`，为后续 helmet 与 HTML 注入准备）
2. **helmet**（CSP / HSTS / noSniff / frameguard……）→ 去掉 `Server` / `X-Powered-By`
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
- 429 会记指标（`RateLimitMetricsRegistry`，按 IP/路由的有界 Map）并打一条结构化告警日志。

---

## 数据层

- **唯一真相源是 MongoDB**（`src/services/mongoService.ts`，连接由 `startup.ts` 建立，
  不要在别处新建连接）。Redis 可选，用于 IP 封禁与限流加速，缺失时安全降级。
- 模型在 `src/models/`，索引与 TTL 就近声明。已经具备的代表性约束：
  审计日志 90 天 TTL + `requestId`/`createdAt`/`module`/`userId`/`action` 索引；
  会话表按 `userId` 前缀建索引；`credentialHash` 唯一索引；IP 封禁表 TTL + `ipAddress`/`fingerprint` 索引。
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
1. `src/routes/<域>Routes.ts` 定义路径（不要在路径里写连字符，`path-to-regexp` 会歧义）；
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
| 测试环境脏了 | `pnpm run test:clean`（清残留）、`pnpm run test:db-init`（初始化测试库） |
| CI 红但本地看着没问题 | 按 `AGENTS.md` §0 第 2 条取父提交同名 job 的历史结论做归因；注意 `skipped` 的步骤不等于通过 |
| 线上日志只有一句模糊错误 | 先确认是不是「把预期拒绝当异常」（如封停打成 `logger.error` + 堆栈）；处罚类必须带 `code` 才能被前端识别 |

---

## 安全注意事项

- **管理端接口**：必须同时满足有效会话 + `admin`/`superadmin` 角色 + 更严格的限流。
  绝不允许绕过管理员校验或范围守卫。
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
- **处罚态契约**：封停（`ACCOUNT_SUSPENDED`）与工单封禁（`TICKET_PERMISSION_BANNED`）都带稳定 `code`，
  前端据此弹申诉入口；禁用的 403 目前只有文案。新增任何「拒绝用户」的分支都要先问
  一句「前端怎么识别它」——靠文案匹配是最后选择，不是默认选择。
