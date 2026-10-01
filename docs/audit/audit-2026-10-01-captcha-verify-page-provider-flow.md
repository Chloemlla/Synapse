# 人机验证页改走 captcha-providers（首访门闸流程线路）+ 文案/路由适配（2026-10-01）

来源：用户工单「前端 hcaptcha-verify 页面改成走后端 captcha-providers 按照首访门闸流程线路」「文案和路由也适配」。

范围：`frontend/src/components/CaptchaVerificationPage.tsx`（原 `HCaptchaVerificationPage.tsx`）、`frontend/src/components/CaptchaVerificationExample.tsx`、`frontend/src/App.tsx`、`frontend/src/navigation/navConfig.ts`、`readme.md`、`src/generated/adminSpaModulePaths.ts`。

## 一、缺陷

### D1 页面把 hCaptcha 写死，绕过后端供应商调度

- **症状**：`/hcaptcha-verify` 页固定走「`/api/turnstile/public-config` 取 `hcaptchaSiteKey` → 渲染 hCaptcha → `POST /api/turnstile/hcaptcha-verify`」。后端 `captcha-providers` 的上线开关、权重、月度额度、其他两家供应商（Turnstile / trycap）在这条页面上完全不起作用。
- **影响**：
  1. hCaptcha 被下线或凭据缺失时，页面直接报「hCaptcha 未启用或配置不完整」，即使 Turnstile / trycap 可用也无法验证；
  2. 与首访门闸（`FirstVisitVerification`）不是同一条流程线路：门闸是「`/api/turnstile/secure-captcha-config` 由后端选供应商 → 渲染对应组件 → 按供应商走后端校验」，本页是硬编码单家，两条线路的判定结果可能不一致（管理端看到「供应商已切到 trycap」，这个页面却还在要 hCaptcha）。
- **修复**：页面改为与首访门闸同一条线路：
  1. `getFingerprint()` → `useSecureCaptchaSelection({ fingerprint })` → `POST /api/turnstile/secure-captcha-config`（即后端 `captcha-providers` 调度：上线开关 + 权重 + 额度）；
  2. 按返回的 `captchaType` 懒加载渲染 `TurnstileWidget` / `HCaptchaWidget` / `CapWidget`（trycap 带 `apiEndpoint`），与门闸一致的三件套；
  3. challenge 通过后按供应商投递到各自的后端校验端点（与门闸服务端同一套 verify）：`turnstile → /api/turnstile/verify-token`、`hcaptcha → /api/turnstile/hcaptcha-verify`（附 `timestamp`/`fingerprint`）、`trycap → /api/turnstile/cap-verify`；
  4. 供应商选择失败（后端不可用 / 三家都不可用）单独呈现并给「重新获取验证方式」（`regenerateSelection()`），不再对着空白框干等；
  5. 重试用 key 重挂载取代原先只对 hCaptcha 生效的 `ref.reset()`，三家组件行为统一。

### D2 文案与路由仍写着 hCaptcha

- **症状**：路由 `/hcaptcha-verify`、导航项 `hCaptcha`、页面标题文案、示例组件与 readme 都写死单家供应商；改用后端调度后这些文案与路由与实际行为不符（用户/管理员看到「hCaptcha」会以为只会走 hCaptcha）。
- **修复**：
  - 路由 `/hcaptcha-verify` → `/captcha-verify`；**旧路径保留 301 式前端重定向**（`<Navigate to="/captcha-verify" replace />`），老书签/外链不 404，且在 SPA 路径清单里保留，避免整页导航被 308 到 API；
  - 导航项与页面标题改为「人机验证」，页面徽标/页脚/结果区动态显示本次实际使用的供应商（`getCaptchaDisplayName()`）；
  - 组件改名：`HCaptchaVerificationPage.tsx` → `CaptchaVerificationPage.tsx`（导出 `StandaloneCaptchaVerificationPage` / `ReturnableCaptchaVerificationPage`）、`HCaptchaVerificationExample.tsx` → `CaptchaVerificationExample.tsx`，示例文案改为「验证方式由后端选择」；
  - `readme.md` 的能力表条目由「hCaptcha 验证」改为「人机验证」，指向 `CaptchaVerificationPage`；
  - `App.tsx` 文档标题映射补 `/captcha-verify`（旧路径条目保留）；
  - `src/generated/adminSpaModulePaths.ts` 由仓库脚本重新生成（`node scripts/generate-admin-spa-paths.js`：41 个管理模块、56 条前端路由）。

## 二、验证方式

- 本地不跑构建/测试（方法论 §一-1）。只做静态检查：花括号平衡、`rg` 反查旧标识符（`HCaptchaVerificationPage` / `StandaloneHCaptchaVerificationPage` / `ReturnableHCaptchaVerificationPage` / 页面路径 `/hcaptcha-verify`）已无残留引用（除刻意保留的旧路径重定向与 API 端点 `/api/turnstile/hcaptcha-verify`）。
- 生成物一致性：`node scripts/generate-admin-spa-paths.js` 已跑，`--check` 口径的清单与 `App.tsx` / `adminModules.tsx` 一致（CI 的 SPA 路径漂移闸门复验）。
- CI 复验：`type-check-frontend`（新页面/示例/App 均参与编译）、`Node verification`（后端 Jest）、`Quality Guardrails`（含前端 bundle 预算）、`CodeQL`、`Docker` 全绿。

## 三、收尾核对

| 编号 | 去向 | 载体 |
| --- | --- | --- |
| D1 | 已修 | `frontend/src/components/CaptchaVerificationPage.tsx`（选择→渲染→按供应商校验） |
| D2 | 已修 | `App.tsx`（路由 + 重定向 + 标题）、`navConfig.ts`、示例组件、`readme.md`、`src/generated/adminSpaModulePaths.ts` |
