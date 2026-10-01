# 人机验证「接管所有前后端页面」：三家供应商共用同一套下发链路

日期：2026-10-01
上游方案：`docs/plans/captcha-providers-trycap-2026-10-01.md`（三家供应商落地）、
`docs/plans/captcha-allocation-console-2026-10-01.md`（分配体系 + `/admin/captcha-providers` 统一调控台）

## 一、现状（编号 T1–T6）

| 编号 | 事实 | 位置 |
| --- | --- | --- |
| T1 | 只有「首访门禁」「独立验证页」两个页面走统一下发链路（`secure-captcha-config` → 按供应商渲染 → 按供应商校验） | `frontend/src/components/{FirstVisitVerification,CaptchaVerificationPage}.tsx` |
| T2 | 登录 / 注册 / 忘记密码 / 重置密码 / TTS / 图床上传 / 抽奖 / 资源商店 / Cloudflare 挑战页 **只认 Turnstile**：前端用 `useTurnstileConfig` + `<TurnstileWidget>`，后端用 `TurnstileService.verifyToken`（写死 Cloudflare siteverify） | 见下表「接管清单」 |
| T3 | 因此管理端把 hCaptcha / trycap 设为「上线」也不会被这些页面使用；反过来把 Turnstile 下线，这些页面会出现「拿到 hCaptcha 挑战但后端只验 Turnstile」的死局 | 同上 |
| T4 | 请求体里挑战令牌的字段名各页不一（`cfToken` / `turnstileToken`），且**没有任何一处**告诉后端「这次是哪个供应商签发的」 | `src/controllers/auth/*`、`src/tts/*`、`src/services/{ipfs,lottery,cdk}Service.ts` |
| T5 | CDK 兑换直连 Cloudflare siteverify 并直读 `process.env.TURNSTILE_SECRET_KEY`，绕过了 DB 优先的密钥解析 | `src/services/cdkService.ts` |
| T6 | 后台页面的「要不要人机验证」判据是 `turnstileConfig.enabled`（= Turnstile 凭据是否存在），与三家供应商的上线/额度状态无关 | `src/controllers/auth/_state.ts:102`、`src/tts/tts.pipeline.ts:286` 等 |

## 二、设计

### 1. 一套请求契约（前端 → 后端）

所有页面统一发 `captchaProvider` + 挑战令牌；令牌字段名保留兼容回退：

| 字段 | 取值 | 说明 |
| --- | --- | --- |
| `captchaProvider` | `turnstile` / `hcaptcha` / `trycap` | 缺失或非法 → 回落 `turnstile`（老客户端语义） |
| `captchaToken` | string | 首选字段名；回退 `cfToken` → `turnstileToken` → `hcaptchaToken` → `capToken` |

> 注意：**不把裸 `provider` 当供应商字段**——TTS 请求体里的 `provider` 表示 TTS 提供商，含义冲突。

读取逻辑收在 `src/services/turnstile/challenge.ts`（纯函数，可单测）。

### 2. 一个后端闸门 + 一个后端校验入口

- `providers.getCaptchaRequestPolicy()`：`required`（三家是否有任一家真正可下发：已上线 + 有凭据 + 本月额度未用尽）与 `enabledProviders`。
- `verify.verifyCaptchaChallenge({ token, provider, remoteIp })`：按供应商分派到既有的三家校验实现
  （`verifyToken` / `verifyHCaptchaToken` / `verifyCapToken`），三家的 trace、风控、hCaptcha 额度扣减语义**一处不改**。
- `controllers/auth/_state.verifyRequiredCaptcha()`：给所有页面共用的一段判定
  1. `!policy.required` → 放行（与历史「开关关闭即放行」等价）；
  2. 缺 token → 「请先完成人机验证」；
  3. 校验失败且该供应商已不在可下发名单（管理端在用户答题期间下线）→ 放行，不把用户卡死；
  4. 其余失败 → 「人机验证失败，请重试」。

### 3. 一个前端组件

新增 `frontend/src/components/ManagedCaptcha.tsx`：把「指纹 → `secure-captcha-config` → 按供应商懒加载控件 → 渲染失败时按 `failoverMaxAttempts` 换下一家 → 交出 `{ token, provider }`」封成一个组件，
页面只保留一个状态（`captcha: { token, provider } | null`）。控件外观（theme/size/language/署名）由管理端统一下发。

### 4. 管理端

`/admin/captcha-providers` 增加「接管范围」面板：按场景列出已被统一链路接管的页面，并给出「当前会选谁」的直达入口，
让「调整权重/上下线」与实际生效的页面一一对应。

## 三、接管清单（前端页面 → 后端校验点）

| 页面 | 前端文件 | 后端校验点 |
| --- | --- | --- |
| 登录 | `components/LoginPage.tsx` | `controllers/auth/loginHandlers.ts` |
| 注册 | `components/RegisterPage.tsx` | `controllers/auth/registrationHandlers.ts` |
| 忘记密码 | `components/ForgotPasswordPage.tsx` | `controllers/auth/passwordResetHandlers.ts` |
| 重置密码 | `components/ResetPasswordPage.tsx` | 同上 |
| TTS 生成 | `components/TTSForm.tsx` | `tts/tts.pipeline.ts` |
| 图床上传 | `components/ImageUploadPage.tsx` | `services/ipfsService.ts` |
| 抽奖 | `components/LotteryPage.tsx` | `services/lotteryService.ts` |
| 资源商店 | `components/ResourceStoreList.tsx` | `services/cdkService.ts` |
| Cloudflare 挑战 | `components/CloudflareChallengePage.tsx` | `routes/cloudflareChallengeRoutes.ts` |

## 四、批次

| 批次 | 内容 |
| --- | --- |
| P1 | 请求契约 + 请求闸门 + 统一校验入口（`challenge.ts`、`providers.ts`、`verify.ts`、`turnstileService.ts`）+ 单测 |
| P2 | 后端校验点全部接上（auth / tts / ipfs / lottery / cdk / cloudflare / fingerprint）+ 单测 |
| P3 | 前端 `ManagedCaptcha` 组件 + 单测 |
| P4 | 页面逐个接管（按上表顺序），每批一组 |
| P5 | 管理端「接管范围」面板 + 文档回填 |

## 五、验收

1. 登录/注册/忘记密码/TTS 页面在管理端把 hCaptcha 或 trycap 置为唯一上线供应商后，能拿到对应控件并通过后端校验完成原操作。
2. 三家全下线时，上述页面不再要求人机验证（与历史 `turnstileConfig.enabled=false` 行为一致）；TTS/图床的「先启用人机验证」提示语义保持。
3. 老客户端（不带 `captchaProvider`）继续按 Turnstile 校验，行为不变。
4. 控件加载失败时按管理端 `failoverMaxAttempts` 自动换家，页面提示「已换到下一家」。
5. 管理端「接管范围」面板列出的页面与实际生效链路一致。
6. CI 全绿（tsc 前后端、Jest、Vitest、OpenAPI 漂移、管理端 SPA 路径漂移、前端首屏体积预算）。
