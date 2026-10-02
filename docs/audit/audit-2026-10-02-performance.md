# Synapse 前后端性能审查清单（2026-10-02）

> 范围：后端 HTTP 管线 / 中间件 / 服务层 / 数据访问 + 前端运行时 / 网络层 / 构建产物。
> 方法：静态读码 + 符号级扫描（`rg`），不做本地构建/测试（仓库硬性约束）；结论以 `main` 上的 CI 为唯一裁决者。
> 基线：`main` @ `d2a8e918`（`Node Verification` / `Code Quality` / `CodeQL` / `Quality Guardrails` 全绿）。
> 交叉核对：`docs/audit/performance-review.md`（2026-08-03，2026-09-03 复核）。该报告 🔴/🟡 条目经逐条复核**绝大多数已落地**（`$facet` 聚合、限流内存档、`touchAuthSession` 的 HMAC 化、IP 封禁 5min TTL、WS `maxPayload`+`terminate`、index.html 启动期缓存、rawBody 仅签名面、`bulkWrite` 批量化、TTL 索引、管理端列表下推 aggregation），因此本清单只记录**复核后仍然成立**的问题，并新增此前未覆盖项。

| 编号 | 严重度 | 位置 | 类型 | 状态 |
|---|---|---|---|---|
| PERF-01 | 🔴 高 | `src/app/assembly.ts` | 全站响应未压缩 | 本批修复 |
| PERF-02 | 🔴 高 | `src/services/authSessionService.ts` + 3 处中间件 | 认证热路径重复 DB 往返 | 本批修复 |
| PERF-03 | 🟡 中 | `src/controllers/ipInfoController.ts`、`src/routes/status.ts`、`src/routes/openapiJsonRoutes.ts` | 公开稳定端点无缓存头 | 本批修复 |
| PERF-04 | 🟡 中 | `frontend/src/components/Footer.tsx` | 1 Hz 全组件重渲染 | 本批修复 |
| PERF-05 | 🟡 中 | `frontend/src/components/Footer.tsx` | 每次挂载 2 个 API 请求，无客户端缓存 | 本批修复 |
| PERF-06 | 🔵 低 | `src/app/assembly.ts:354-359` | `/static/audio` 无 `Cache-Control` | 第一批修复（`1f187e8a`） |
| PERF-07 | 🔵 低 | `src/app/assembly.ts:401-413` + `src/security/contentSecurityPolicy.ts:259-274` | SPA shell 每请求 3 次全文正则 | 第二批修复 |
| PERF-08 | 🔵 低 | `src/app/assembly.ts:269-283` | 全局 10MB body 上限 + 全量 `buf.includes` 扫描 | 挂起（需逐路由核对上限，行为收紧） |
| PERF-09 | 🔵 低 | `frontend/vite.config.ts:70` | `react-icons` 手动分块把懒加载页图标也拖上首屏 | 第二批修复 |
| PERF-10 | 🔵 低 | `frontend/src/components/WsConnector.tsx:110-131` | 后台标签页仍在跑碰撞检测 | 第二批修复 |
| PERF-11 | 🔵 低 | `frontend/src/api/api.ts` | 无 GET 去重/短 TTL 缓存层 | 挂起（扫描未找到并发重复 GET 的证据） |
| PERF-12 | 🔴 高 | `src/middleware/routeLimiters.ts:215-283` | 每个静态资源请求两次 Redis 计数 | 第二批修复 |
| PERF-13 | 🟡 中 | `src/app/assembly.ts:426-428` | `/static/*` 先经过根挂载：多一次限流 + 一次落空 stat | 第二批修复 |

---

> 第一批（`1f187e8a` / `db080906`）：PERF-01~06。第二批（本文件下方）：PERF-07 / 09 / 10 / 12 / 13。
> 每一条的「严重度」按 CI 可核验的字节数 / 请求次数 / 数据库往返次数定级。

## 🔴 高优先级

### PERF-01 全站响应未压缩（HTML / JS / CSS / JSON / SSE 同一条管线）

| 字段 | 内容 |
|---|---|
| **位置** | `src/app/assembly.ts` `registerCoreMiddleware()`（helmet 之后、`registerSecurityPipeline(app, "preBodyParser")` 之前）；`registerStaticRoutes()` 的 `express.static` 两处 |
| **现状** | 全仓**没有任何响应压缩**：`package.json` 无 `compression`/`shrink-ray`/`express-compression`，`src/` 内无 `node:zlib` 的 gzip/brotli 使用（`rg "node:zlib\|gzip\|brotli" src` 仅命中 `routes/logShare/archive.ts` 的 tar 归档与 `tts/edge/edge.client.ts` 作为**客户端**发出的 `Accept-Encoding`）。`helmet` 也不做压缩。 |
| **影响的响应** | ① `express.static` 直接下发的 Vite 产物（`frontend/dist/assets/*.js`，按 `scripts/governance/check-frontend-bundle.js` 的预算口径总量上限 4600 KiB **gzip**，原始体积约为其 2–4 倍）；② `sendIndexHtml` 的 SPA shell（`src/app/assembly.ts:401-413`）；③ 所有 `res.json()`：管理端用户列表 / 审计日志 / 翻译审计 / webhook 事件等分页结果单响应可达数百 KB；④ `GET /api/openapi.json`（仓库内 `openapi.json` 为 254 KB）。 |
| **量级** | 以首屏闭包实测 344.2 KiB gzip（`check-frontend-bundle.js` 注释）推算，未压缩时同一份首屏 JS/CSS 至少多传 2–3 倍字节。JSON 类响应文本压缩比通常 5–10×。 |
| **前提** | 若接入的反代（Cloudflare / 1Panel openresty）已做压缩，本项对客户端字节收益变小，但对「源站 → 反代/边缘」这一段仍成立，且不改变 `Content-Encoding` 语义（压缩中间件默认跳过已带 `Content-Encoding` 的响应）。**先落地源站压缩，再按需在反代侧重复调优。** |
| **建议改法** | 引入 `compression`，在 `registerCoreMiddleware` 中 `helmet` 之后注册；`filter` 显式排除 `text/event-stream`（`compression` 依赖的 `compressible` 把 `text/event-stream` 判为可压缩，SSE 一旦被压缩就会缓冲分块、把流式响应退化成一次性响应 —— 仓库有真实 SSE 端点：`src/routes/libreChatRoutes.ts:483` 与前端 `LibreChatPage.tsx:1131` 的 `EventSource`）。保留默认 `threshold: 1kb`，并沿用 `compression.filter` 对 `Cache-Control: no-transform` / 已编码 / HEAD 的排除。 |
| **校验** | ① CI `type-check-backend`（需 `@types/compression`）；② `Node Verification` 的后端 Jest 全量（`libreChatRoutes.test.ts` 会覆盖 SSE 路由）；③ 合并后对生产 `curl -H 'Accept-Encoding: gzip' -I https://<host>/api/status` 复核是否出现 `Content-Encoding: gzip`。 |

### PERF-02 认证热路径对同一 session 文档查两次（每个已认证请求多 1 次 Mongo 往返）

| 字段 | 内容 |
|---|---|
| **位置** | `src/services/authSessionService.ts:319-331`（`assertActiveAuthSession`）与 `:333-365`（`touchAuthSession`） |
| **调用链** | `src/middleware/authenticateToken.ts:45-58`：`assertActiveAuthSession(userId, token, credentialHash)` → `findOne`；随后 `touchAuthSession(userId, token, {...}, credentialHash)` → **再 `findOne` 同一条件** → `updateOne`。 |
| **问题** | `touchAuthSession` 内部先 `findOne({ userId, credentialHash, revokedAt: null }).lean()` 取 `existing`，**唯一用途**是（a）确认会话仍存在、（b）比较 `existing.ipAddress !== normalized.ipAddress` 决定是否刷新 `ipLocation`。而 `assertActiveAuthSession` 在同一个请求里刚刚查到**完全相同的文档**并把它返回给调用方，调用方却把它丢掉。 |
| **同一形态的其它两处** | `src/middleware/auth.ts:152-157`（`authMiddlewareV2`）：先 `assertActiveAuthSession(user.id, token)`（内部 `hashAuthCredential` 一次）再 `touchAuthSession(user.id, token, …)`（内部**再** `hashAuthCredential` 一次 + `findOne`），即 2 次 HMAC + 2 次 `findOne` + 1 次 `updateOne`；`src/middleware/oauthTokenAuth.ts:108-112` 同形。 |
| **影响** | 每个已认证 API 请求多 1 次 Mongo `findOne`（`authMiddlewareV2` 还多 1 次 HMAC）。已认证请求是最高频路径（`rg -c authenticateToken src/routes/*.ts` 单文件即 8–9 处挂载），按 QPS 线性放大。 |
| **建议改法** | ① `touchAuthSession` 增加可选入参 `existingSession?: AuthSessionDoc \| null`（以及 `auth.ts` 复用 `credentialHash` 预计算）；传入时跳过内部 `findOne`，`updateOne` 的过滤条件不变（保持 `revokedAt: null` 的乐观并发语义）。② `assertActiveAuthSession` 的返回值原样透传给 `touchAuthSession`。③ `mobileLoginService.ts:784`、`linuxDoAuthController.ts:150` 这两处**没有**前置 `assert`，保持不传、走原有内部查询。 |
| **不改语义** | `updateOne` 的 `{ userId, credentialHash, revokedAt: null }` 过滤与 `$set` 字段完全不变；会话在「assert 之后、touch 之前」被撤销的极端竞态下，`updateOne` 的 `modifiedCount === 0` 与现状一致（现状也只在 `findOne` 与 `updateOne` 之间做同样的事）。 |
| **校验** | `src/tests/authenticateToken.integration.test.ts` 对 `authSessionService` 是 `jest.mock`（`assertActiveAuthSession`/`touchAuthSession` 替身），签名向后兼容即不受影响；`authSessionService.test.ts` 只覆盖列表分组。最终以 `Node Verification` 的后端 Jest 全量 + `tsc` 为准。 |

---

## 🟡 中优先级

### PERF-03 公开且稳定的 GET 端点没有 `Cache-Control`

| 端点 | 位置 | 现状 | 建议 |
|---|---|---|---|
| `GET /api/ip` | `src/controllers/ipInfoController.ts:19-45`（`router.get("/ip", ipQueryLimiter, …)`，`src/routes/ipInfoRoutes.ts:7`） | 无缓存头。前端页脚**每次页面加载**都调用（`Footer.tsx:59-104`）。服务端有进程内 + Mongo 两级缓存，但网络往返每次照旧。 | `Cache-Control: private, max-age=120`（`private` 防共享缓存串号；URL 已含 `?ip=`，缓存键天然区分）。 |
| `GET /api/status` | `src/routes/status.ts:41-52`（公开根路由，返回 `version` / `shortSha` / `timestamp`） | 无缓存头。前端页脚每次加载查一次后端版本。 | `Cache-Control: public, max-age=30, stale-while-revalidate=300`。 |
| `GET /api/openapi.json` | `src/routes/openapiJsonRoutes.ts:6-13` | 无缓存头，且 `readOpenapiJson()` 每次请求 `stat` 一遍文件（内容有 mtime 缓存，`src/services/openapiDocumentService.ts`）。254 KB。 | `Cache-Control: private, max-age=300`（该路由有 `apiDocsAuthGate`，不得 `public`）。 |

### PERF-04 页脚 1 Hz 定时器导致整个 Footer 每秒重渲染

| 字段 | 内容 |
|---|---|
| **位置** | `frontend/src/components/Footer.tsx:36-57`（`setInterval(updateUptime, 1000)` → `setUptime(...)`），消费点在 `:127-136` |
| **问题** | 运行时长文本按秒变化，但 `setUptime` 落在 `Footer` 组件自身，于是**每秒**重渲染整个页脚：4 个信息块 + 4 个 `react-icons` 元素 + grid 布局。Footer 在应用 shell 里常驻（`App.tsx:1530-1532` / `1630-1632`），即每个页面、每个标签页生命周期内持续 1 Hz 重渲染。 |
| **建议改法** | 把「起始时间 + 1 Hz 计时 + 格式化文本」抽成一个内部小组件（`<UptimeClock />`），`Footer` 本体用 `React.memo` 包裹且不再持有 uptime state。计时器范围收窄到只重渲染那一个 `<span>`。 |
| **风险** | 纯渲染边界调整，DOM 结构与文本不变；无测试覆盖该组件（`rg -l "Footer" frontend/src/tests` 无命中）。 |

### PERF-05 页脚每次挂载发 2 个 API 请求，无客户端缓存

| 字段 | 内容 |
|---|---|
| **位置** | `frontend/src/components/Footer.tsx:59-104`（`GET /api/ip`）、`:106-139`（`GET /api/status`） |
| **问题** | 两个 effect 各自 `fetch`，无去重、无 TTL。Footer 在 shell 切换（登录/登出、768px 断点跨侧栏）时会重新挂载并重发两请求；`/api/ip` 失败时也只是打日志。 |
| **建议改法** | 加模块级「Promise + 结果 + 过期时间」缓存（`sessionStorage` 或模块级 Map），TTL 与 PERF-03 的服务端缓存头对齐；同一会话内跨挂载复用，失败不回写缓存。保持失败回退（`ipLoading=false` + `获取失败`）不变。 |
| **配套** | 与 PERF-03 互补：服务端 `Cache-Control` 让浏览器 HTTP 缓存生效，客户端缓存再兜住「同一会话内的 SPA 重挂载」。 |

---

## 🔴 高优先级（第二批）

### PERF-12 每个静态资源请求打两次 Redis 计数

| 字段 | 内容 |
|---|---|
| **位置** | `src/middleware/routeLimiters.ts:215-283`（`createStore` / `createLimiter`）；受影响的实例：`staticFileLimiter`、`frontendLimiter`、`audioFileLimiter`（三者 `category: "static"`） |
| **现状** | `createStore` → `createSharedRateLimitStore(prefix, windowMs)`；未显式传 `preferMemory` 时，`ResilientRateLimitStore` 的默认行为是「配了 REDIS_URL 就走 Redis」（`G5-08`，生产确实配了 Redis）。于是 **每个 JS/CSS/字体/图片/音频请求**、以及每个 SPA 路由请求，都要打一次 Redis `INCR` + `PEXPIRE`。再叠加 PERF-13（同一资源过两道闸）就是 2 次/资源。 |
| **量级** | 按 `check-frontend-bundle.js` 口径，一次生产构建共 3.38 MB gzip / 上百个 chunk；按每页 20-40 个资源算，单次访问就是几十次 Redis 往返，而这些都是 `immutable` 且浏览器已缓存的字节。 |
| **为什么可以改成进程内存** | 这三道闸的语义是**防刷**（`static` 档 5000/60s），不是**配额**：进程内 `BoundedMemoryRateLimitStore` 已能拦住单机洪水；多实例下每实例各算一份对静态资源毫无影响（没人“应得”跨实例合并的 5000/min）。真正需要跨实例一致的调用方（API Key 配额等）走 `requireSharedBackend`，不受本规则影响。 |
| **实现** | `createLimiter` 里 `preferMemory = opts.preferMemory ?? category === "static"`，透传到 `createStore`。**关键细节**：只在需要内存档时传 `{ preferMemory: true }`；显式传 `preferMemory: false` 会盖掉 `createSharedRateLimitStore` 内部的“未配 Redis 就默认内存”兜底，把那些限流器推回 Mongo（每请求一次 `findOneAndUpdate`）——这正是 `G5-08` 修掉的旧问题，本批已避开。 |
| **校验** | `Quality Guardrails` / `Node Verification` 的后端 Jest 全量（`src/tests` 无任何用例断言限流器 store 类型；`apiKeyRateLimit.test.ts` 走的是 `requireSharedBackend`，不受影响）。 |

---

## 🟡 中优先级（第二批）

### PERF-13 `/static/*` 先过根挂载：多一次限流 + 一次注定落空的 stat

| 字段 | 内容 |
|---|---|
| **位置** | `src/app/assembly.ts` `registerStaticRoutes()`，原顺序：先 `app.use(staticFileLimiter, express.static(root, {index:false}))`，再 `app.use("/static", staticFileLimiter, express.static(root))` |
| **现状** | 生产构建的 `base` 是 `/static/`（`vite.config.ts` 的 `defaultBase`），所以**所有**哈希资源都在 `/static/assets/*` 下。而 `app.use(后端无路径)` 对 `/static/...` 同样命中：先跑一次限流器，再拿 `/static/assets/x.js` 到 `frontend/dist/` 下找（必不存在）→ 落空 → `next()` 后才轮到 `/static` 挂载真正命中。 **每个资源请求 = 2 次限流计数 + 1 次失败的 fs 探测。** |
| **改法** | 把 `/static` 挂载提到根挂载之前。命中即响应，根挂载与它的限流器不再参与；两者都在 miss 时继续 `next()`，行为等价。 |
| **顺带** | `dist/static/` 不存在，所以根挂载原本就从未真的服务过 `/static/*`；调换顺序不改变任何可达 URL。 |
| **校验** | `src/tests` 无任何用例请求 `/static/*` 或断言静态目录挂载顺序（已 `rg` 核实）。 |

---

## 🔵 低优先级

### PERF-06 `/static/audio` 无 `Cache-Control` —— 第一批修复（低成本）
`src/app/assembly.ts:354-359` 只设了 CORS 头。TTS 产物文件名唯一（`src/tts/tts.storage.ts:185`：`tts_${Date.now()}_${random}`），内容对同一 URL 不变，可安全加 `Cache-Control: public, max-age=31536000, immutable`（`express.static` 的 ETag/Last-Modified 仍保留作为兜底）。

### PERF-07 SPA shell 每请求 3 次全文正则 —— 已修（启动期模板 + 占位符）
`sendIndexHtml` 原实现每请求跑 `applyCspNonceToHtml`（3 条 `String.replace(正则)`）。现改为启动时用占位符 `{{SYNAPSE_CSP_NONCE}}` 注一次，请求时只做 `split(占位符).join(nonce)`。

- **安全性不变**：HTML 里的 nonce 与 CSP 头里的 nonce 仍取自同一个 `res.locals.cspNonce`（`ensureCspNonce`），头由 helmet 的 directive 回调生成；占位符不是用户输入，替换值仍先剥引号。
- **复用既有函数语义**：`applyCspNonceToHtml` 本身是幂等的（不覆盖已有 `nonce=`），所以“先注占位符、再替占位符”与“直接注真 nonce”等价。
- **不碰 `contentSecurityPolicy.ts`**：改动只在 `assembly.ts`，`src/tests/contentSecurityPolicy.test.ts` 覆盖的纯函数一行未动。

### PERF-08 全局 10 MB body 上限 —— 挂起（保持）
`src/app/assembly.ts:269-283` 的 `express.json({ limit: "10mb" })` 对**所有**路由生效，`verify` 回调对最大 10 MB 的 buffer 做 `buf.includes('"__proto__"')` 全量扫描（Buffer 字节搜索，已是快路径；真正成本是 `JSON.parse`）。收紧必须逐路由建大 body 白名单（big-body 业务散布在 dataCollection / nexAI / artifacts / imageData 等），属于**行为收紧**：白名单漏一个就是生产 413，而 CI 不会拿大 body 去打这些端点。**扫描取证的阻塞点**：仓库内大上传多数走 multer（multipart，自带限制）或 `express.text({limit:"5mb"})`，但仍有若干 JSON 大 body 业务无法静态穷举，因此保留挂起。

### PERF-09 `react-icons` 被手动分组拖上首屏 —— 已修（改回默认分块）
**真实病因不是“App.tsx 静态导入了桶”，而是手动分块 `MANUAL_CHUNKS.icons`**：它把所有被引用的 `react-icons` 模块聚成单个 chunk，而入口侧确实需要图标（`FirstVisitVerification` 静态可达，用它自己的 11 个 fa 图标；它又导入 `PenaltyAppealActions` 的 fi 图标），于是“入口需要 1 个图标”拉动了“全站所有图标”。

- **实测数据**（`Quality Guardrails` run `36997009790` 的 `[perf-chunk]` + budget 输出）：`assets/icons.C7g8aLmQ.js` = **41.4 KiB gzip**，在首屏静态闭包（344.1 KiB / 14 JS + 1 CSS）内，占 **12%**。
- **改法**：把 `icons` 组置空（保留文档注释），交回 rolldown 默认分块 —— 图标模块按“哪些 chunk 真的 import 它”落位，入口只带自己那几个，其余留在懒加载 chunk。`react-vendor` 不会吞它（`matchesPackage` 带路径分隔符，`react` 不会前缀匹配 `react-icons`）。
- **零视觉改动**：不动任何组件，不换图标库（原先考虑的“换成内联 SVG / lucide”会改外观，且安全闸 UI 的视觉回归 CI 抓不到，已舍弃）。
- **CI 即判据**：`Frontend bundle budget` 会打印新的首屏闭包与 `icons` 归属；`heavyChunkNames`（`documents/pdf/mermaid/katex/charts/fingerprint`）不含 `icons`，置空不会触发“应存在的隔离 chunk 缺失”。

### PERF-10 `WsConnector` 后台标签页仍在碰撞检测 —— 已修（隐藏即不排期）
`frontend/src/components/WsConnector.tsx`：`MutationObserver(body, subtree+attributes)` + `ResizeObserver` + `resize`/`scroll`(capture) 常驻，200ms 去抖后跑 5 点 `elementsFromPoint` + 多次 `getComputedStyle`。后台标签页里 WS 推送仍会改 DOM，于是这些取值照跑但没人看得到。

- **改法**：`scheduleCheck` 在 `document.visibilityState === 'hidden'` 时直接返回；新增 `visibilitychange` 监听，回前台补排一次（避免恢复后状态陈旧）。
- 不删除任何检测逻辑、不改判定阈值；`visibilitychange` 与其它监听在同一个 effect 的清理函数里一并解绑。

### PERF-11 前端 API 层无 GET 去重/短 TTL 缓存 —— 挂起（保持）
本轮把入口可静态到达的模块逐个看完（`ArticleCommandPalette` 只在 `Ctrl/⌘+K` 打开时才拉列表且关闭时 `return null`；`useTwoFactorStatus` 无调用方；`/api/outemail/quota` 的三处调用落在互斥的懒加载路由），**仍未找到并发重复 GET 的证据**。无证据不引入全局缓存层：in-flight 去重会把同一个 response 对象交给多个调用方（共享 `res.data` 引用），短 TTL 缓存会改变回退/刷新语义——两者都需要先有一个真实重复请求的现场。

---

## 收尾去向（已回填）

第一批 commit：`1f187e8a`（代码 + 声明，11 文件）→ 锁文件由 §十七 流程重生成（PR #1012，squash `61bc1865`）→ `db080906`（补测试替身）→ `9fcb08c7`（回填文档）。
第二批 commit：见下表（`PERF-07 / 09 / 10 / 12 / 13`）。

| 编号 | 去向 |
|---|---|
| PERF-01 | 已修（`1f187e8a`）：`compression` 中间件 + `compression@^1.8.2` / `@types/compression@^1.8.1`；锁文件 `compression@1.8.2`、`compressible@2.0.18`。`type-check-backend` 绿；`Obfuscated artifact smoke`（生产构建启动）绿。 |
| PERF-02 | 已修（`1f187e8a`）：`touchAuthSession` 新增可选 `existingSession`，三处调用点（`authenticateToken` / `authMiddlewareV2` / `oauthTokenAuth`）复用 `assertActiveAuthSession` 的返回值；`authMiddlewareV2` 复用凭证哈希。**连带修复**（`db080906`）：`rbacMiddleware.test.ts` 的 jest.mock 工厂缺 `hashAuthCredential`，`authMiddlewareV2` 读成 `undefined` 抛 TypeError 被外层 catch 成 500，6 个用例全红 → 按同仓 5 个套件既有写法补 `...jest.requireActual(...)`（见 §五-75/67 同族坑）。 |
| PERF-03 | 已修（`1f187e8a`）：`/api/ip` `private, max-age=120`；`/api/status` `public, max-age=30, stale-while-revalidate=300`；`/api/openapi.json` `private, max-age=300`。 |
| PERF-04 | 已修（`1f187e8a`）：`UptimeClock` 叶子组件 + `React.memo(Footer)`。 |
| PERF-05 | 已修（`1f187e8a`）：`sessionStorage` + TTL 缓存 + 模块级 in-flight 去重。 |
| PERF-06 | 已修（`1f187e8a`）：`/static/audio` → `public, max-age=31536000, immutable`。 |
| PERF-07 | 已修（第二批）：启动期 nonce 模板 + 占位符替换，不再每请求跑 3 条正则。 |
| PERF-08 | **挂起**（保持）：收紧全局 10 MB body 上限需逐路由大 body 白名单，属行为收紧；白名单漏一项即生产 413，CI 不拿大 body 打这些端点。 |
| PERF-09 | 已修（第二批）：`MANUAL_CHUNKS.icons` 置空，交回 rolldown 默认分块；不动组件外观。基线 `icons` = 41.4 KiB gzip / 首屏闭包 344.1 KiB（12%）。 |
| PERF-10 | 已修（第二批）：`WsConnector` 隐藏标签页不排期 + `visibilitychange` 回前台补检。 |
| PERF-11 | **挂起**（保持）：本轮逐个看过入口可达模块，仍未找到并发重复 GET 的证据；无现场不引入全局缓存层。 |
| PERF-12 | 已修（第二批）：`category === "static"` 的限流器（`static` / `frontend` / `audio`）改用进程内内存档，不再每资源一次 Redis 往返。 |
| PERF-13 | 已修（第二批）：`/static` 挂载提到根挂载之前，每个 `/static/*` 请求从「2 次限流 + 1 次落空 stat」降为「1 次限流」。 |

### CI 判据（`db080906`，全绿）

| workflow | run | 结论 |
|---|---|---|
| Node Verification | `36995962807` | success —— `Run build`、`Obfuscated artifact smoke`、`Run backend Jest tests with coverage`、`Run frontend Vitest tests with coverage` 均实际执行（非 skipped） |
| Quality Guardrails | `36995962767` | success（含 `TypeScript size guard` 与 `Frontend bundle budget`） |
| CodeQL | `36995962877` | success |
| Docker | `36995962760` | success |
| Code Quality (fuck-u-code) | `36995962739` | success |

> 中间态留档：`1f187e8a` 的 push CI 里 `Quality Guardrails` / `Docker` / `Node Verification` 因 `pnpm-lock.yaml` 未同步而在 `Install dependencies` 就失败（`ERR_PNPM_OUTDATED_LOCKFILE`，属 §十七 预期），锁文件 PR 合并后同批 job 全部转绿；`61bc1865` 上只剩 `rbacMiddleware` 一个套件红（即上面 PERF-02 的连带修复）。
