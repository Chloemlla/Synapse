# CodeQL 告警清零（2026-10-01）

来源：`https://github.com/Chloemlla/Synapse/security/code-scanning` open 集快照（30 条，锚在 commit `2cabd305`）
范围：修复除 `js/missing-rate-limiting` 外的全部告警；`js/missing-rate-limiting` 按用户决定批量 dismiss（不做代码改动）。

## 一、分类与去向

| 规则 | 数量 | 决定 | 依据 |
| --- | --- | --- | --- |
| `js/missing-rate-limiting` | 28 | **dismiss（false positive）** | 逐文件接线核实后确认运行时限流真实生效，CodeQL 看不到跨文件挂载与自定义 limiter 工厂 |
| `js/request-forgery` | 1 | **真修** | Cap 实例地址被服务端用于出站请求，属真实 SSRF 面（见 C1） |
| `js/incomplete-sanitization` | 1 | **真修** | Markdown 表格单元格转义漏了反斜杠（见 C2） |

## 二、两名真修项

### C1 `js/request-forgery` — `src/services/turnstile/cap.ts`（severity: error）

- **症状**：`axios.post(\`${apiEndpoint}/${siteKey}/siteverify\`)` 的出站 URL 带污点（清单一轮修完仍报，锚点漂到新 commit）。
- **根因（两轮）**：
  1. 轮廓层：`apiEndpoint` 来自 `CAP_API_ENDPOINT` 配置，写入侧只做了 `sanitizeString` 与去尾斜杠，没有任何 SSRF 防护。
  2. 真正的污点源：`/api/turnstile/cap-verify` 把 **请求体里的 `siteKey`** 当 `siteKeyOverride` 透传进了出站 URL 的路径段——客户端可控的路径片段，属真实缺陷（不只是配置面）。
- **修复**：
  - 新增 `src/services/turnstile/capEndpoint.ts`：只接受 `http`/`https`、拒凭据、拒回环/私网/链路本地/云元数据（`169.254.`）/`.internal`/`.local`/`metadata.`、不支持子路径，并用解析后的部件**重建 origin**；写入侧先校验再落库，读取侧再校验一次兜历史脏值（`cap.ts`、`verify.ts`、`providers.ts` 统一走它）。
  - **彻底删掉 `siteKeyOverride` 参数**：站点密钥只认服务端配置，不再从请求体取；并对站点密钥做格式校验（Cap 为 `randomBytes(5).toString("hex")` = 10 位十六进制），写入侧非法即拒；拼进 URL 时再 `encodeURIComponent`（也是 CodeQL 对 request-forgery 认可的清洗器，见 `RequestForgeryCustomizations.qll` 的 `UriEncodingSanitizer`）。
  - 新增 `src/tests/capEndpointGuard.test.ts` 钉住上述边界（回环/私网/元数据/子路径/带凭据/协议白名单、站点密钥格式）。

### C2 `js/incomplete-sanitization` — `src/utils/policyDocumentMarkdown.ts:19`（severity: warning）

- **症状**：`escapeCell` 只替换 `|` 与换行，CodeQL：「未转义输入中的反斜杠」。
- **根因**：Markdown 表格里输入 `\|` 会被转成 `\\|`，渲染器读作「转义反斜杠 + 列分隔符」→ 单元格被撑开、表格结构损坏（条款存档副本的逐字比对因此不可信）。
- **修复**：先转义反斜杠，再转义竖线，最后压平换行。

## 三、28 条 `js/missing-rate-limiting` 的逐文件接线核实

按 rule × file 汇总（dismiss 前重拉当前 open 集），逐个文件定位运行时限流点：

| 文件 | 条数 | 运行时限流点 | 结论 |
| --- | --- | --- | --- |
| `src/routes/admin/config.ts` | 7 | `src/routes/routeModules/preTamperModules.ts` 的 `admin-routes`：`path: "/api/admin"` + `middlewares: [adminLimiter]` | 结构性误报（G11-06 明确移除路由级重复挂载，重复会让计数翻倍、配额减半） |
| `src/routes/admin/mobileTokens.ts` | 8 | 同上（`/api/admin` 前缀挂载） | 同上 |
| `src/routes/admin/policyConsents.ts` | 4 | 同上（`/api/admin` 前缀挂载） | 同上 |
| `src/routes/totpRoutes.ts` | 5 | 每个路由**行内**已挂 `totpLimiter`（22/33/44/55/66/77/91 行）；该 limiter 由 `src/middleware/routeLimiters.ts` 的 `limiterFromDefinition("totp")` 工厂产出 | 识别性误报：CodeQL 只认同一文件内可追溯的 `express-rate-limit` 实例，自定义工厂把这一层遮住了 |
| `src/mediaTool/http/transcribeUserHttp.ts` | 2 | `postTamperModules.ts` 的 `transcribe-user-routes`：`path: "/api/transcribe"` + `middlewares: [authenticateToken, transcribeLimiter]` | 结构性误报（限流在挂载点，与路由文件不同源） |

处置：`gh api -X PATCH .../code-scanning/alerts/<n> -f state=dismissed -f dismissed_reason='false positive'`，comment 按文件组写明上面各自的真实限流点，留痕备查。**未在子路由重复挂载 limiter 去迎合 CodeQL**——那会让同一请求过两次限流器。

## 四、收尾核对

- `state=open` 复验：应为 0（28 条 dismissed + 2 条在修复提交后由 CodeQL 重扫判 fixed）。
- 代码修复走正常 CI（type-check / Node verification / Quality Guardrails），dismiss 不影响构建。
- 判定「某条修复是否生效」：`state=fixed` 的告警锚在修复前 commit，`state=open` 的锚在更新的 commit——用 `most_recent_instance.commit_sha` 区分即可，不必等 UI。
