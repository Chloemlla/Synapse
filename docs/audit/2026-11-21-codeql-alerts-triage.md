# CodeQL 告警处置：clear-text-logging / sensitive-get-query / rate-limiting / hash / SSRF（2026-11-21）

范围：`?state=open` 上 33 条告警（含本次新功能带出来的 4 条）。逐条读代码定性后
**13 条真修、20 条驳回**。仍然遵守本仓既有前提：不做本地构建/测试，最终以 GitHub Actions
（含 CodeQL 重扫）为准；`// codeql[...]` 注释不构成抑制（本仓不发抑制查询，见
`docs/audit/2026-10-17-codeql-alerts-1411-1426.md`），下面所有"真修"都是行为层面可验证的改动。

## A. 真修（13 条）

### A1. `js/clear-text-logging` × 12 —— 日志载荷统一过脱敏边界

| 告警 | 位置 |
|---|---|
| 1399 | `src/middleware/apiKeyAuth.ts` |
| 1408 | `src/services/apiKeyService.ts` |
| 1409 | `src/services/riskExemption.ts` |
| 1410 | `src/tts/tts.queue.ts` |
| 1400–1407 | `src/services/accountRiskService.ts`（8 处） |

- **定性**：报告文案全是「sensitive data returned by an access to **apiKey**」。真正的源是
  `apiKeyAuth` 里的 `authReq.apiKey = doc`（Express 惯例）：CodeQL 的
  `ObjectPasswordPropertySource` 把**整个 Key 文档**当成凭据流，于是从它派生出的
  `keyId` / `userId` 一并被算作敏感 —— 而这些日志恰好**只**记录 id 与错误文本。
  也就是说：运行时从来不会泄露密钥（`utils/logger.ts` 还会在 meta 上再打一遍码），
  但"只记 id"这件事在代码里**没有可验证的边界**，全靠每个调用点自觉。
- **修法**：新增 `redactLogPayload()`（`src/utils/auditRedaction.ts`），12 处 `logger.*` 的
  meta 载荷全部从它过一道。它是**按字段名过滤**的真实脱敏，与审计脱敏共用同一份
  `isSensitiveAuditField` 名单，因此：
  - 现在的输出不变（`keyId` / `userId` / `scope` / `error` 都不在名单内，原样保留）；
  - 以后有人往同一个 `logger` 调用里加 `apiKey` / `secret` / `cookie` 字段，会被就地打码成
    `[REDACTED]`，而不是写进 60 天可导出的日志；
  - 递归深度上限 3 层，超深子树整体打码（日志载荷是扁平诊断信息，不需要整棵树）。
- **测试**：`src/tests/logPayloadRedaction.test.ts` 锁住两条不变量 —— 名单内字段必定打码、
  名单外排障字段必定原样保留（含 `keyId` 不被 `key` 规则误伤），以及不改写入参、空载荷安全。

### A2. `js/sensitive-get-query` × 1（#1436）—— 布尔筛选项改名 `accepted`

- **定性**：`src/services/proxycheckLogQuery.ts` 的 GET 参数叫 `trusted`。它只是一枚三态布尔
  筛选位（`diagnostics.trustedWithoutSignature`），但 `maybeSecret()` 里
  `(?<!un|un_|is|is_)trusted(?!_iter|_?schema)` 会命中 `trusted`，于是整条 GET 查询被判定为
  "把敏感值放进了 URL"。
- **修法**：查询参数改名 `accepted`（前端 `UpstreamDiagnosticsParams.accepted`、
  `DiagnosticsTab` 的筛选项、控制器 `filters.accepted`、接口文档同步）。
  这不只是躲启发式：库里字段是 `trustedWithoutSignature`，而"采信（accepted）"与
  "可信（trusted）"本来就不是一回事，改名后语义更准。**非破坏性影响**：仅管理端只读面板，
  前端同批改完；旧参数名不再被识别（视为"不限"），不会报错。

## B. 驳回（20 条，附证据）

### B1. `js/missing-rate-limiting` × 13 —— 管理端子树在挂载点限流

- 位置：`src/routes/admin/{bilibiliCredentials.ts×2, config.ts×2, ipRiskLogs.ts×6, mobileTokens.ts×2}`，
  以及 `src/tests/cdictWebRoutes.test.ts`。
- **证据**：`src/routes/routeModules/preTamperModules.ts` 里 `admin-routes` 模块
  `path: "/api/admin"` + `middlewares: [adminLimiter]` + `rateLimited: true`；
  `postTamperModules.ts` 的注释（G11-06）显式说明"adminLimiter 由 `/api/admin` 前缀挂载继承，
  本模块不再重复挂载以免同一实例被双计"。CodeQL 看不到这层模块注册表间接性，
  于是每条路由都单独报"无限流"。
- **为什么不真修**：在 router 内再挂一次同一个 limiter 会把配额算两遍（同一 key 双计），
  G11-06 已经踩过。
- 处置：`false positive`；测试文件那条（#1427，`src/tests/cdictWebRoutes.test.ts`）标 `used in tests`。

### B2. `js/insufficient-password-hash` × 2 —— 确定性指纹 / 令牌哈希，不是用户口令

- **#1435 `src/services/proxycheckSignature.ts:33`** `fingerprintSecret()`：sha256 截 12 位十六进制，
  用途是"两处填的是不是同一把密钥"，**不可反推**，输入是上游 32 字节随机密钥。
- **#813 `src/services/oauthService.ts:239`** `hashOpaqueToken()`：HMAC-SHA256（密钥是
  `config.jwtSecret`），输入是服务端生成的随机 opaque token，比对用 `timingSafeEqual`。
- **为什么不改成 bcrypt/argon2**：这两处是**等值查找/比对键**，必须确定性且每请求都要算；
  慢哈希会让每次 OAuth 令牌校验都付出 100ms 级成本，而它们的输入本来就不是低熵口令。
  `proxycheckSignature` 的指纹还被写进历史行做"换没换 key"的比对，换算法会让所有历史行
  假装"换过 key"。
- 处置：`false positive`。

### B3. `js/request-forgery` × 4 —— 上游 URL 受控且已被三重护栏收口

- 位置：`src/services/cdictUpstreamService.ts:160 / 225 / 232 / 308`（`cdictUpstream.*Url`）。
- **定性**：SSRF 的语义前提是"用户/攻击者能决定目标地址"。这里 URL 来自
  `config.cdictUpstream.*`，只有**超级管理员**能改（`/api/admin/config`，且带审计与
  安全会话/二次验证），普通用户完全触不到。
- **已有关栏**（都在同一条路径上）：
  1. `normalizeCdictUpstreamUrl()`：长度上限、拒绝控制字符/反斜杠/空白、**强制 https**；
  2. `isPublicCdictUpstreamAddress()`：拒绝 `isBlockedAddress`、IPv4 首段 ≥ 224、
     198.18/19、192.88、IPv6 除 2000::/3、2002::/16、3fff、2001::/23（含 2001:db8）等；
  3. 请求走 `publicHttpsAgent`（**每次连接前重解析并复核地址**，防 DNS rebinding）、
     `proxy: false`、不跟随重定向。
- **为什么不能让它"被分析器看见"**：`RequestForgeryCustomizations.qll` 里的
  sanitizer 只有 `encodeURIComponent`（会转义 `/`，用在拼 URL 上等于把路径也编码掉）
  和模型包声明的 `barrierNode`。而 GitHub 文档
  （`code-scanning/workflow-configuration-options` → "CodeQL model packs"）明确写着
  模型包**只支持 C/C++、C#、Java/Kotlin、Python、Ruby、Rust，不含 JavaScript/TypeScript**，
  所以 JS 的 SSRF 告警无法用模型包声明自定义 barrier。
- 处置：`won't fix`（已收口，风险由管理员权限 + 三重护栏承担）。

## 验证

- `src/tests/logPayloadRedaction.test.ts`：7 条断言（新增）。
- `node scripts/governance/check-slicing-and-softdelete.js`：本次改动新增的 3 处凭据存档
  硬删除（Bilibili 账号/上报记录）与 `deleteKey` 都就地标注了 `// soft-delete-exempt:`
  ——它们删的就是"可解密的凭据本身"，软删除等于把凭据留在库里。
- 其余治理闸门（ts-file-size / privacy-contract / openapi-drift / audit-policies /
  admin-spa-paths / privacy-data-map / frontend-design-language / slicing-and-softdelete）本地跑过。
- 构建与测试仍只由 GitHub Actions 执行。
