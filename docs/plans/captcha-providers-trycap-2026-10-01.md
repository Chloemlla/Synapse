# 人机验证供应商扩展：新增 trycap（Cap）+ 按供应商配置概率与上下线

日期：2026-10-01
范围：`frontend/src/components/admin`、`frontend/src/components/env-manager`、`src/services/turnstile`、`src/controllers/turnstile`、`src/routes/turnstileRoutes.ts`、`src/security/contentSecurityPolicy.ts`

## 一、现状审计（编号 A1–A9）

| 编号 | 事实 | 位置 |
| --- | --- | --- |
| A1 | 供应商枚举只有 turnstile / hcaptcha | `frontend/src/utils/captchaSelection.ts:11` |
| A2 | 服务端从「已启用且配置了 siteKey」的候选里**等概率**随机选一家（`crypto.randomInt`），无权重概念 | `src/controllers/turnstile/configHandlers.ts:83-129` |
| A3 | 「启用」= secretKey && siteKey 都存在，没有独立的上线/下线开关 | `src/services/turnstile/config.ts:6-11`、`hcaptcha.ts:214-221` |
| A4 | 配置存 Mongo：`turnstile_settings` / `hcaptcha_settings` 集合，键为 `*_SECRET_KEY` / `*_SITE_KEY`，可回退环境变量 | `src/services/turnstile/models.ts` |
| A5 | 校验入口统一在 `verify.ts`，`captchaType` 联合类型只有两值；trace 落 `shc_traces` 带 `verificationMethod` | `src/services/turnstile/verify.ts:174`、`models.ts:88-112` |
| A6 | 前端已有一条「后端决定类型」的链路：`useSecureCaptchaSelection` → `/api/turnstile/secure-captcha-config` → `FirstVisitVerification` 分支渲染 | `frontend/src/hooks/useSecureCaptchaSelection.ts`、`FirstVisitVerification.tsx:178-181` |
| A7 | CSP 为 nonce 白名单，按脚本/连接来源分别列出；新增第三方脚本必须同时进 `script-src` 与 `connect-src` | `src/security/contentSecurityPolicy.ts:23-93` |
| A8 | 管理面板由 `ADMIN_MODULE_LOADERS` 单一表驱动，改表后必须跑 `node scripts/generate-admin-spa-paths.js`，CI 有漂移闸门 | `frontend/src/components/admin/adminModules.tsx`、`tsc.yml:68` |
| A9 | openapi 漂移闸门在 CI 内**先重新生成再对账**，因此只需保证注释 YAML 合法 | `.github/workflows/tsc.yml:58-62` |

已具备的 Cap 侧条件：`https://cap.chloemlla.com` 已部署 Cap Standalone 3.1.14（Docker + 复用现有 Redis），管理端可用；接口形状与 reCAPTCHA 同构：`POST /<siteKey>/challenge`、`POST /<siteKey>/siteverify`（body `{secret, response}`，secret 为 `sk-` 开头，token 单次有效）。

## 二、设计

### 1. 供应商模型（B1）

- 三家常量：`turnstile` / `hcaptcha` / `trycap`。
- 每家两份状态，**解耦**：
  - **凭据**：siteKey + secretKey（Cap 另有 endpoint），存各自的 `*_settings` 集合；
  - **调度**：`enabled`（上线/下线）+ `weight`（权重，0–100 整数），存新集合 `captcha_provider_settings`，每供应商一条文档。
- 判定顺序：`调度 enabled=false` → 不下发；`enabled=true 但凭据不全` → 不下发且给出 `reason`（管理端可见），避免「配置缺失被静默当作正常」。

### 2. 概率语义（B2）

- 权重是**相对值**，服务端用 `crypto.randomInt` 做无偏加权抽取（累加前缀 + 二分/线性命中），**不用** `Math.random`。
- 归一化百分比只用于展示（P = w/Σw）。
- 边界：全部权重为 0 → 退化为「按启用的候选等概率」；无候选 → 返回 `enabled:false`（沿用现状兜底 `turnstile`）。
- 抽取逻辑放在纯函数里，随机源可注入，便于单测断言分布与边界。

### 3. trycap 接入（B3）

- Cap Standalone 校验：`POST {endpoint}/{siteKey}/siteverify`，body `{ secret, response }`，10s 超时，**fail-closed**（网络异常/超时一律判失败并落 trace）。
- 前端：`<cap-widget data-cap-api-endpoint="{endpoint}/{siteKey}/">`，脚本固定版本（`@cap.js/widget@0.1.58`），事件 `solve` / `error` / `reset`。
- CSP：`script-src` 增 `https://cdn.jsdelivr.net`，`connect-src` 增 Cap endpoint（默认 `https://cap.chloemlla.com`）。
- 端点/站点密钥不硬编码，全部走 Mongo 配置，默认值仅作兜底。

### 4. 管理端（B4，含「便利项」）

- 新面板 `/admin/captcha-providers`：每家一张卡片 —— 上线/下线开关、权重滑块 + 数字输入、实时归一化百分比与概率条、凭据配置状态（脱敏）、未生效原因。
- 便利项：**平均分配**、**仅此一家**、**全部下线**、批量保存、连通性自检（Cap 打一次 challenge 验证 endpoint 与 siteKey）、未保存改动提示（离开/刷新前提醒）、保存后立即生效（无需重启）、时间戳展示。
- 权限：读取 admin，写入与自检 superadmin；写操作全部挂 auditLog。

### 5. 月度额度（B5，对齐 proxycheck.io 的限额口径）

- 口径与 `ipRiskService` 的 proxycheck 日配额一致：**先算额度再外呼，用尽即不外呼并落一条 `quota_exhausted` trace**；
  计数落 Mongo（`captcha_monthly_quotas`，`provider + monthKey` 唯一），失败只告警、不阻断已拿到的结论。
- 切分粒度是**月**（`Asia/Shanghai` 的 `YYYY-MM`）：hCaptcha 的免费额度按月给，按日切会在月中重置导致超发。
- 默认额度：**hCaptcha 10,000 / 月**；**trycap 与 Cloudflare Turnstile 不限额**（`limit = 0` 表示不限，只计数不拦截）。
  上限可在管理面板逐家覆盖（0 = 解除限额）。
- 用尽的供应商会被**自动摘出下发候选**（reason `quota_exhausted`），避免把用户送到一个必然失败的验证码上；
  下月 1 日 00:00（CST）计数自然归零，无需人工干预。
- 管理端展示本月已用/上限/剩余/进度条/重置时间，并提供逐月历史接口 `GET /api/turnstile/providers/quotas`。

### 6. 治理（B6）

- 新路由补 `@openapi` 注释（CI 会重新生成 spec 并对账）。
- `adminModules.tsx` 注册后跑 `node scripts/generate-admin-spa-paths.js`。
- 新文件 ≤ 800 行（`check:ts-file-size`），既有超限文件增长 ≤ 300 行。
- 单测覆盖：加权分布、全 0 回退、单候选、无候选、下线但凭据齐全、凭据缺失但上线。

## 三、实施批次

| 批次 | 内容 | 文件 |
| --- | --- | --- |
| P1 | 存储 + 概率引擎 + 类型/常量 | `turnstile/types.ts`、`models.ts`、`providers.ts`(新)、`constants.ts` |
| P2 | Cap 服务 + 校验入口接入 | `turnstile/cap.ts`(新)、`verify.ts`、`turnstileService.ts` |
| P3 | 控制器 + 路由 | `controllers/turnstile/{providersHandlers,capHandlers}.ts`(新)、`configHandlers.ts`、`routes/turnstileRoutes.ts` |
| P4 | 前端选择与控件 | `utils/captchaSelection.ts`、`hooks/useCapConfig.ts`(新)、`components/CapWidget.tsx`(新)、`FirstVisitVerification.tsx`、`utils/fingerprint.ts` |
| P5 | 管理面板 + 注册 + 生成物 | `components/admin/CaptchaProviderAdmin.tsx`(新)、`adminModules.tsx`、`src/generated/adminSpaModulePaths.ts` |
| P6 | 安全头 + 测试 | `security/contentSecurityPolicy.ts`、`frontend/index.html`、`src/tests/captchaProviderSelection.test.ts`(新) |
| P7 | 月度额度 + 自动下线 | `models/captchaQuotaModel.ts`(新)、`turnstile/quota.ts`(新)、`verify.ts`、`hcaptcha.ts`、`providers.ts`、面板额度区、`src/tests/captchaQuota.test.ts`(新) |

## 四、验收

1. `/api/turnstile/providers` 能读到三家状态与归一化概率；PUT 改权重后 `secure-captcha-config` 的分布随之改变。
2. 下线某家后，即使凭据齐全也不再下发该家。
3. Cap 走通「challenge → widget 解题 → siteverify」；伪造/重放 token 必须失败。
4. hCaptcha 额度：达到 10,000 后不再外呼、自动摘出候选、面板显示剩余与重置时间；turnstile/trycap 计数但不拦截。
5. CI 全绿：tsc、quality-guardrails（文件体量/隐私契约）、admin SPA 路径漂移、openapi 漂移、审计策略。

## 五、风险

- R1：Cap 的 challenge 默认协议是 `hashwx`（记忆硬化），无头浏览器验证可能被拦；生产 key 建议保持 `instrumentation: true`，自动化验证另建临时 key。
- R2：权重语义若被理解为「绝对概率」会与归一化结果不符 —— 面板上明确标注「相对权重，自动归一化」。
- R3：新增第三方脚本来源会扩大 CSP 白名单，仅放行 jsdelivr 与 Cap 自有域名，不放行 `unsafe-inline`/`unsafe-eval`。
