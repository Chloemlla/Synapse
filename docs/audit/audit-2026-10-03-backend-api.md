# B1 后端接口层审计（routes / controllers / middleware / security / app）

> 审计日期：2026-10-03 ｜ 模式：MODE-AUDIT（只读审查，未改动仓库内任何文件）
> 范围：`src/routes/**`、`src/controllers/**`、`src/middleware/**`、`src/security/**`、`src/app/**`（assembly.ts / startup.ts）
> 判据：`F:\Repositories\GitHub\code-audit-methodology.md` §二（A 并发 / B 资源 / C 生命周期 / D 编译与结构 / E 安全 / F 持久化 / G 外部数据与降级）
> 约束：只登记本轮**亲自在代码里核实**的缺陷，每条给 `file:line`。不报「建议重构」「建议加测试」。

计 17 条：阻断 0、高 0、中 13、低 4。

| ID | 文件:行 | 类别 | 严重度 | 证据（读到什么） | 触发场景/影响 | 建议改法 |
| --- | --- | --- | --- | --- | --- | --- |
| B1-01 | `src/routes/routeModules/postTamperModules.ts:653` + `src/routes/routeModules/preTamperModules.ts:212` | E 限流重复挂载 | 中 | `admin-routes` 模块在 `/api/admin` 挂 `middlewares: [adminLimiter]`；`media-tool-admin-routes` 模块在 `/api/admin/media-tool` 又挂 `middlewares: [authenticateToken, adminLimiter]`。Express 前缀挂载使 `/api/admin/media-tool/*` 一次请求同时命中两个 adminLimiter 实例 | 同一 limiter 记两次数，媒体工具管理接口的 admin 额度实际减半；与 audit-logs 模块刻意去掉重复挂载的注释（preTamperModules.ts:229「the router-level duplicate was removed to avoid splitting the admin quota (G11-06)」）自相矛盾 | 去掉 `media-tool-admin-routes` 的 `adminLimiter`（`/api/admin` 挂载已覆盖），或把 media-tool 移出 `/api/admin` 前缀单独分桶 |
| B1-02 | `src/routes/admin/qqGuard.ts:109,131,165` | E 权限分档 | 中 | 白名单增删（POST `/qq-guard/whitelist`、DELETE `/qq-guard/whitelist/:userId`）与命令下发（POST `/qq-guard/commands`）只由 `/api/admin` 挂载层的 `authMiddleware` + `adminAuthMiddleware` 把关，无 `authenticateSuperAdmin`。同文件为 `admin` 档，而非 superadmin | 普通管理员即可持久化修改机器人纪律白名单、下发 `recall`（撤回群消息）/`exempt`（豁免）命令——属系统级写操作，按 AGENTS.md §8「admin 只读业务 + 用户管理」应归超管 | 这三个写端点加 `authenticateSuperAdmin`；只读端点（stats/health/pending/audits/whitelist GET/commands GET）保持 admin 档 |
| B1-03 | `src/routes/admin/qqGuard.ts:15-18,74-75,52` | F 分页无上限 | 中 | `num(v, fallback)` 仅校验 `Number.isFinite(n) && n > 0` 后 `Math.floor`，无最大值钳制。`listAudits` 用 `page: num(req.query.page, 1)`、`limit: num(req.query.limit, 30)`；`pending` 用 `num(req.query.limit, 50)` | `?limit=100000000` 直接下推 Mongo，一次拉取全量审计/待复审记录，单请求即可打满内存与带宽 | 给 `num` 增加 `max` 参数（如 limit ≤ 200、page ≤ 10000），或复用 `ticketController.ts:44` 的 `Math.min(raw, MAX)` 钳制写法 |
| B1-04 | `src/controllers/nexaiAuthController.ts:49,88,124,160,221,258,277,312,344,370,402,428,456,485,532,558,585,632,656,688,717` | E 错误信息外泄 | 中 | 21 处 `catch (error: any)` 后 `res.status(error.statusCode \|\| 500).json({ success:false, error: error.message \|\| "…" })`——5xx 分支把原始 `error.message` 原样回客户端（如 Mongoose 校验串、上游 fetch 失败串、内部字段名） | 任何未预期异常都会把内部实现细节/上游 URL/集合名泄露给调用方；绕过 `assembly.ts` 全局 500 处理器的不外泄映射 | 5xx 一律回固定文案，原始 `error.message` 只进 `logger.error`；业务可预期错误显式带 `statusCode < 500` 与稳定 `code` |
| B1-05 | `src/routes/passkeyRoutes.ts:267,336,487` | E 错误信息外泄 | 中 | `res.status(500).json({ error: error?.message \|\| "生成认证选项失败" })`（267）、`{ error: errorMessage }`（336）、`{ error: error?.message \|\| "完成认证失败" }`（487）——认证链路的 5xx 把原始异常文本回客户端 | 无密码登录（Passkey）失败时向未认证调用方泄露内部异常细节 | 同样改为固定文案 + 日志留原文 |
| B1-06 | `src/routes/passkeyRoutes.ts:111,115,142,146` | E 敏感数据外泄 | 中 | 500 响应体带 `details`：`details: { user: sanitizeLogValue(user) }`（111）、`details: { userId, credentialName, options }`（142/146）——把 WebAuthn `options`（含 challenge）与用户名回给客户端 | WebAuthn 注册 challenge 与用户身份串随错误响应外泄，属于本不该出现在 HTTP body 的凭据材料 | 删除 `details` 字段；诊断信息只落日志 |
| B1-07 | `src/controllers/artifactController.ts:183-186,234-237,273-276` | E 错误信息外泄 | 中 | `getArtifact`/`updateArtifact`/`deleteArtifact` 的 catch 均 `res.status(500).json({ success:false, error: error.message \|\| "获取失败"/"更新失败"/"删除失败" })` | 公开 Artifact 面（`/s/*` 与 `/api/nexai/artifacts`）的 5xx 回显内部异常文本 | 统一走固定文案；`isArtifactValidationError` 分支已正确回 400，5xx 分支同样收口 |
| B1-08 | `src/controllers/artifactController.ts:205-209` | E 输入校验 / 越权赋值 | 中 | `const updates = { ...req.body, expiresInDays: optionalNumber(req.body?.expiresInDays ?? req.body?.expires_in_days) };` 后整包传给 `ArtifactService.updateArtifact(shortId, userId, updates)`。请求体字段未做白名单，仅 `shortId` 做了空值校验 | 若服务层未二次白名单，调用方可覆盖任意可更新字段（如 `owner`/`userId`/`shortId`/`visibility`）造成越权改属性。**限定：`ArtifactService.updateArtifact` 在本次读取范围（`src/services/**`）之外，未核实其是否已做字段白名单，本条为「控制器层未收口」，是否构成实际越权取决于服务层** | 控制器侧按可更新字段显式挑选（title/description/content/visibility/expiresInDays），不要把 `req.body` 展开透传 |
| B1-09 | `src/controllers/artifactController.ts:294-295` | F 分页无上限 | 中 | `const page = parseInt(firstStringOr(req.query.page, "1"), 10) \|\| 1;` / `const limit = parseInt(firstStringOr(req.query.limit, "20"), 10) \|\| 20;`——`limit` 无上界，`NaN` 被 `\|\| 20` 吞成默认，但 `?limit=1000000` 原样下推 | 单次列表请求可拉取该用户全部 Artifact，内存与序列化开销不受控 | `Math.min(limit, 100)` 钳制并拒绝非有限值 |
| B1-10 | `src/controllers/imageDataController.ts:26-28,53-55,87-89,123-125` | E 错误信息外泄 | 中 | 四个端点 catch 均 `res.status(500).json({ …, error: error.message \|\| "验证失败"/"批量验证失败"/"获取失败"/"记录失败" })` | 图像数据面 5xx 回显内部异常文本 | 同 B1-04，固定文案 + 日志 |
| B1-11 | `src/controllers/coinFlipController.ts:22-25,45-48,61-64,75-78` | E 错误信息外泄 | 中 | 四个方法 catch 均 `error: error instanceof Error ? error.message : "服务器错误"`，500 直回原始异常文本 | 抛硬币面（含公开 `flip`）5xx 回显内部异常 | 固定文案 + 日志 |
| B1-12 | `src/controllers/coinFlipController.ts:55-56` | F 分页无上限 | 中 | `parsePositiveInt(value, fallback)` 只校验 `Number.isFinite(n) && n > 0`；`pageSize` 无最大值钳制，`listResults` 直接下推 | 管理端列表 `?pageSize=100000000` 一次拉全表 | 加 `Math.min(pageSize, 100)` |
| B1-13 | `src/controllers/ecoEnchantsController.ts:42-46` | F 分页无上限/NaN | 中 | `parsePage` 返回 `{ page: Number.parseInt(firstStringOr(req.query.page,"1"),10), pageSize: Number.parseInt(firstStringOr(req.query.pageSize,"20"),10) }`——既不钳上限也不兜 `NaN`；该函数被 `:443,461,501,549,758` 多处调用 | `?page=abc` 得到 `NaN` 下推 Mongo（查询语义未定），`?pageSize=1000000` 拉全表；影响商品目录/详情等多端点 | 复用 `ticketController.ts:41-46` 的 `Number.isFinite && >0 ? Math.min(x, MAX) : DEFAULT` 写法 |
| B1-14 | `src/routes/shortUrlRoutes.ts:277` | E 错误信息外泄 | 中 | `catch (error: any) { return res.status(500).json({ error: error.message \|\| "创建失败" }); }`（公开创建短链端点） | 未认证的公开端点 5xx 回显内部异常文本（如 Mongo 唯一索引细节、上游错误） | 固定文案 + 日志；409 分支已正确显式处理 |
| B1-15 | `src/controllers/ttsProviderController.ts:170-172,231-233` | G 外部调用丢失 cause | 中 | 两处 `logger.warn("[TTS] Fish … failed", { error: error instanceof Error ? error.message : "unknown" })`——只取 `error.message`，未记录 `error.cause`。这两处是 `fetch` 上游调用（`fetchFishCatalog` / Fish 音频代理） | undici 把真实失败原因放在 `err.cause`（连接被拒/超时/DNS），只记 `message` 会得到无信息的 `fetch failed`，线上排障无法定位 | 按方法论 §二.G 记录 `{ error: error.message, cause: (error as any)?.cause }` |
| B1-16 | `src/controllers/turnstile/providersHandlers.ts:114-115` | F 分页无上限 | 低 | `const monthsRaw = Number.parseInt(String(req.query.months ?? "6"), 10); const months = Number.isFinite(monthsRaw) ? monthsRaw : 6;`——无上下界 | 管理端配额历史 `?months=100000` 触发超长区间聚合 | 钳制到合理区间（如 1–24） |
| B1-17 | `src/routes/analyticsRoutes.ts`、`src/routes/invitationRoutes.ts`、`src/routes/recommendationRoutes.ts`、`src/routes/workspaceRoutes.ts` | D 结构/死代码 | 低 | 以文件 basename 全仓检索，四个路由文件**无任何 import/引用**（`rg -n "<name>" src --glob '!*<name>.ts'` 均 0 命中），即从未挂载到任何 routeModules 相位 | 死代码：既不受任何中间件/鉴权/限流保护（若日后被误挂即裸奔），又增加审计与维护面 | 确认无用后删除，或按需接入 routeModules 并补齐鉴权 + 限流登记 |

## 已核实无缺陷的关键路径

- `/api/admin` 入口链完备：`src/routes/admin/index.ts` 先放公开 `GET /announcement`，随后 `router.use(authMiddleware)` + `router.use(adminAuthMiddleware)`，所有子路由都在会话 + 管理员角色 + `requireAdminScope` 之后。
- `requireAdminScope`（`src/middleware/adminScope.ts`）fail-closed：未登记页面只给超管，403 带 `requiredPages`。
- 除 qqGuard（见 B1-02）外，`/api/admin` 下的系统级写操作均经 `authenticateSuperAdmin`；`apiKeyRoutes` 写操作同样超管闸门。
- `src/app/assembly.ts` 中间件相位顺序与文档一致：CSP/helmet → compression（跳过 SSE 与 206/Range）→ preBodyParser（IP 封禁 → 审计）→ body parser（`__proto__` 过滤 + 受限 rawBody）→ WAF → globalCors → 限流 → JWT → 业务。
- `assembly.ts` 全局 500 处理器只回通用文案，不泄露 `error.message`/栈——B1-04 等条目的风险正来自绕过它的控制器。
- `src/middleware/ipBanCheck.ts` 在 Redis + Mongo 同时不可用时 fail-closed（503），无负缓存降级；CIDR 支持正确。
- 签名类中间件（`nexaiRequestSignature` / `qqGuardRoutes` / `replayProtection` / `nexaiAuth`）均先验签再消费 nonce，使用 `timingSafeEqual` 与漂移窗口。
- `src/middleware/authenticateToken.ts` 与 `auth.ts` 均校验会话存在（`assertActiveAuthSession`）并刷新活跃时间，改密/登出/撤销即时生效。
- `src/middleware/wafMiddleware.ts`、`corsMiddleware.ts` 未读到绕过路径。
- `src/controllers/ticketController.ts:41-46` 分页钳制写法正确（`Math.min(rawLimit, TICKET_LIST_MAX_LIMIT)`），可作为 B1-03/B1-12/B1-13 的整改范式。
- `src/controllers/cdictController.ts:97-101` 对 `type` 做了 `1|2` 枚举校验，无类型注入面。
- `src/controllers/ipRiskController.ts`、`humanCheckRoutes`、`ticketRoutes`、`tamperRoutes`、`emailRoutes`、`ipfsRoutes` 的守卫链未读到缺失。
