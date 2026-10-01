# 人机验证统一改造的遗漏面（残留在旧 Turnstile 链路上的前后端代码）

日期：2026-10-01
关联计划：`docs/plans/captcha-page-takeover-2026-10-01.md`（三家供应商共用同一套下发链路）、
`docs/plans/captcha-allocation-console-2026-10-01.md`
关联提交：`e98d7027`（后端接管）、`bebc30a1`（登录/注册等前端接管）、`f24a84a3`（TTS/图床/抽奖/资源商店/挑战页接管）

## 一、判据

「统一链路」= 前端 `ManagedCaptcha` + `captchaToken` / `captchaProvider`；后端
`TurnstileService.getCaptchaRequestPolicy()` + `verifyCaptchaChallenge()`；首访门禁 = `utils/ipVerification`
的 `buildIpVerificationHeaders()`（`X-Fingerprint` + `X-IP-Verification-Token`）+ `/api/ip-verification/*`。

与此不符、且仍可达的用法即为遗漏项。逐条列出（编号 → 文件 → 缺陷类型 → 细节 → 处置）。

## 二、清单与去向

| 编号 | 文件 | 类型 | 细节 | 处置 |
| --- | --- | --- | --- | --- |
| U1 | `src/controllers/ipfsController.ts`、`src/services/ipfsService.ts` | 权限豁免缺失 | 图床上传的人机验证豁免写作 `isAdmin && isLocalIp && isDev`，线上管理员照样被要求验证；且 `/api/ipfs/upload` 没挂会话解析中间件，`req.user` 恒为空，`isAdmin` 永远为 false —— 实测表现为管理员点上传拿到「请先完成人机验证」。 | 已修：`/upload` 前置 `optionalAuthenticateToken`；控制器与服务的跳过判据改为「管理员身份直接跳过（与头像/FBI/抽奖/CDK 同口径）」。 |
| U2 | `frontend/src/components/ImageUploadPage.tsx` | 前端未接豁免 | 单文件与批量上传都写死 `captchaStatus.required && !captcha?.token`，没有 `!isAdmin`；管理员还渲染人机验证控件。 | 已修：引入 `useAuth() + isAdminRole`，管理员不渲染控件、不阻断提交、不带挑战字段。 |
| U3 | `frontend/src/components/GitHubBillingCacheManager.tsx` | 旧链路未迁移（**用户报障**） | `getAdminTurnstileAuthHeaders()` 读 `localStorage.accessTokens` 里 5 分钟有效期的 Turnstile 访问令牌，读不到直接 `throw new Error('缺少 Turnstile 访问令牌')`，请求在本地被杀 → 「清除过期缓存失败」。 | 已修：改用 `buildIpVerificationHeaders()`；拿不到令牌也照常发请求，由首访门禁/403 处理链接管。 |
| U4 | `frontend/src/components/GitHubBillingDashboard.tsx` | 旧链路未迁移 | 同一个 `getTurnstileAuthHeaders` / `getAdminTurnstileAuthHeaders` / `isDevelopment` / `checkAdminAndTurnstileToken` 组合；使用说明还把「Turnstile 验证获取访问令牌」写成必要步骤。 | 已修：合并为一个 `getVerificationHeaders()`；说明文案改为「首访门禁统一带验证请求头」。 |
| U5 | `frontend/src/utils/fingerprint.ts` | 死代码（旧链路） | `reportTempFingerprint` / `verifyTempFingerprint` / `checkTempFingerprintStatus` / `verifyAccessToken` / `checkAccessToken` / `storeAccessToken` / `getAccessToken` / `cleanupExpiredAccessTokens` 8 个旧首访链路辅助函数，除 `getAccessToken`（仅 U3/U4 使用）外全无调用方；`storeAccessToken` 无人调用正是 U3 令牌恒缺的根因。 | 已修：整块删除（含不再使用的 `isFirstVisitVerificationEnabled` 导入）。 |
| U6 | `frontend/src/hooks/{useTurnstileConfig,useHCaptchaConfig,useCapConfig}.ts`、`frontend/src/api/hcaptcha.ts` | 死代码（旧链路） | 单供应商配置 hook 与旧 hCaptcha API 客户端，改为 `useSecureCaptchaSelection` 后已无任何引用。 | 已修：删除 4 个文件。 |
| U7 | `src/middleware/turnstileAuth.ts` | 死代码（旧链路） | 只校验 `X-Turnstile-Token` 访问令牌的旧中间件，全仓无引用。 | 已修：删除。 |
| U8 | `src/routes/turnstileRoutes.ts`、`src/controllers/turnstile/fingerprintHandlers.ts` | 死端点（旧链路） | `POST /api/turnstile/temp-fingerprint`、`POST /verify-temp-fingerprint`、`POST /verify-access-token`、`GET /check-access-token/:fp`、`GET /temp-fingerprint/:fp` 的 5 个 handler，前端调用方已在 U5 消失，当前客户端（含 `Synapse-Client`）均未使用。 | 已修：删除路由与对应 handler，保留仍在用的 `POST /fingerprint/report`。 |
| U9 | `src/middleware/ipBanCheck.ts` | 死配置 | 豁免前缀仍列着 U8 已下线的 4 条 URL。 | 已修：同步移除，避免「已删除端点仍被声明为放行」。 |

## 三、判定为「无需改动」的项（附理由）

- `src/services/turnstile/accessToken.ts`、`services/turnstile/fingerprint.ts`、`TurnstileService` 门面里残留的
  `verifyAccessToken` / `reportTempFingerprint` 等导出：仅被 U8 删除的 handler 使用，现已无外部入口，保留不影响行为；
  其中 `generateAccessToken` 仍被**在用**的三家独立校验端点（`/api/turnstile/verify-token`、
  `/api/turnstile/hcaptcha-verify`、`/api/turnstile/cap-verify`）调用，不能删。
- `src/middleware/corsMiddleware.ts` 的 `X-Turnstile-Token` 放行头：保留，避免旧缓存 SPA 包因预检被拒。
- `services/schedulerService.ts` 的 `cleanupExpiredAccessTokens` 步骤：对应上面的在用签发路径，保留。
- `ipVerificationService.completeVerification` 走 `verifyTokenDetailed(..., captchaType)`：本身就是三家分派，已统一。
- `frontend/src/components/{FirstVisitVerification,CaptchaVerificationPage}.tsx` 直接按供应商渲染三家控件：
  这是「首访门禁 / 独立验证页」的既有设计（`secure-captcha-config` 下发），已统一，不算遗漏。
- `TTSForm` / `tts.pipeline.ts` 对管理员仍要求人机验证：前后端一致（前端也要求），属既有产品口径，不在本次改动内。

## 四、验证

- 后端：`/api/ipfs/upload` 的管理员请求不再进入 `verifyCaptchaChallenge` 分支；匿名请求保持原样。
- 前端：管理员在 `/image-upload` 不再出现「请先完成人机验证」；GitHub 账单页「清理过期缓存」不再因本地令牌缺失失败。
- CI：Node verification（build / tsc / openapi drift / SPA path drift / Jest / Vitest）、Quality Guardrails、
  Frontend bundle budget 全绿为准。
