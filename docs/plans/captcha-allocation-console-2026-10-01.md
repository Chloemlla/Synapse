# 人机验证「供应商分配体系」+ 统一调控台（/admin/captcha-providers 扩展）

日期：2026-10-01
上游方案：`docs/plans/captcha-providers-trycap-2026-10-01.md`（已落地：三家供应商 + 权重 + 月度额度 + trycap）
本次范围：`src/services/turnstile/*`、`src/controllers/turnstile/*`、`src/routes/turnstileRoutes.ts`、`src/services/turnstileService.ts`、
`frontend/src/hooks/useSecureCaptchaSelection.ts`、`frontend/src/utils/captchaSelection.ts`、
`frontend/src/components/{TurnstileWidget,HCaptchaWidget,CapWidget,FirstVisitVerification,CaptchaVerificationPage}.tsx`、
`frontend/src/components/admin/CaptchaProviderAdmin.tsx` + 新目录 `frontend/src/components/admin/captcha-providers/`

## 一、现状（编号 C1–C8）

| 编号 | 事实 | 位置 |
| --- | --- | --- |
| C1 | 供应商只有「上线/下线 + 相对权重 + 月度额度」三个可调项；选择是一次无偏加权抽取 | `src/services/turnstile/providers.ts` |
| C2 | 任何调用点（首访门禁 / `/captcha-verify` / 其它）都走同一个全局分布，无法按场景分配 | `src/controllers/turnstile/configHandlers.ts:79-110` |
| C3 | 没有「同一指纹在一段时间内固定同一家」的能力：用户刷新一次就可能换供应商，验证码体感抖 | 同上 |
| C4 | 没有故障转移：某家脚本被墙/实例挂掉时，前端只能报错让用户刷新 | `frontend/src/components/FirstVisitVerification.tsx`、`CaptchaVerificationPage.tsx` |
| C5 | 三家控件的可选外观（theme / size / language / 是否显示供应商署名）在前端是硬编码或组件默认值，管理端无法统一调 | `frontend/src/components/*Widget.tsx` |
| C6 | 管理面板只有「三家卡片 + trycap 凭据」两块，缺：KPI 总览、逐月额度历史图（接口已有但没用）、trace 成功率、分配模拟、当前选谁诊断、保存便捷性（无快捷键/无粘性保存栏） | `frontend/src/components/admin/CaptchaProviderAdmin.tsx` |
| C7 | `GET /api/turnstile/providers/quotas` 已经返回逐月历史，前端未消费 | `src/controllers/turnstile/providersHandlers.ts:85-108` |
| C8 | 写入侧已是 superadmin + auditLog；读侧 admin。新增写接口必须保持同一口径 | `src/routes/turnstileRoutes.ts` |

## 二、设计

### 1. 分配体系（B1）—— 三个正交维度

1. **场景（scenario）**：`default` / `first_visit`（首访门禁）/ `standalone`（独立验证页）。
   每家供应商可为每个场景配一份权重，覆盖全局权重；未配的场景回落全局权重。
2. **策略（strategy）**：全局默认 + 可按场景覆盖
   - `weighted`：加权随机（现状，`crypto.randomInt`）。
   - `round_robin`：按时间窗轮换，`index = floor(now / rotationSeconds) % 候选数`（无状态、跨实例一致）。
   - `failover`：按 `priority`（小者优先）取第一个，前端失败后带 `exclude` 再请求 → 自动落到下一家。
3. **修饰项**：
   - `stickyEnabled` + `stickyTtlMinutes`：同一 `fingerprint` 在时间窗内固定同一家。
     实现用 `sha256(fingerprint|scenario|windowIndex) → [0,1)` 落到权重区间 —— **无状态**、多实例一致、可单测。
   - `rolloutPercent` + `rolloutControlProvider`：灰度。`hash("rollout"|fingerprint|scenario) < p` 的流量走新策略，
     其余固定发给对照组供应商（0 = 关闭灰度）。
   - `failoverMaxAttempts`：前端最多换几家（1–3），用于 widget 加载/求解失败后的自动降级。

### 2. 统一调控（B2）—— 前端控件外观

新增 `captcha_widget_settings`（单文档 `key=global`）：`theme`（auto/light/dark）、`size`（normal/compact/flexible）、
`language`（BCP-47 或 `auto`）、`showProviderLabel`（是否展示「本次验证方式 / 技术支持」文案），以及 `perProvider` 覆盖。
公开下发路径 `POST /api/turnstile/secure-captcha-config` 增加返回 `widget`（按选中供应商解析后的最终值），
三家控件组件各自接收 `theme/size/language`：
- Turnstile：`theme` / `size` / `language` 原生支持。
- hCaptcha：`theme` / `size` / `language` 原生支持。
- Cap：`data-cap-lang` 属性 + 宿主 CSS 变量（`--cap-background` / `--cap-color` / `--cap-border-color`）实现深色。

### 3. 管理端（B3）

`/admin/captcha-providers` 改为**四页签控制台**（读 admin、写 superadmin）：

| 页签 | 内容 |
| --- | --- |
| 总览与供应商 | KPI（生效家数 / 候选家数 / 本月外呼 / 24h 成功率 / 未保存改动）、三家卡片（上线、权重、优先级、场景权重、额度、自检、仅用此家、平均分配、全部下线、撤销） |
| 分配策略 | 策略、轮换周期、粘性窗口、灰度比例与对照组、故障转移次数、按场景策略矩阵；**分配模拟器**（按草稿算 N 次抽取的直方图，不写库）+ **当前会选谁**诊断（可填指纹、可指定场景/强制某家） |
| 组件外观 | 全局 theme/size/language/署名开关 + 逐家覆盖 + **实机预览**（按当前草稿渲染真实控件，不写库） |
| 额度与统计 | 本月额度进度、逐月历史柱状图（`/providers/quotas`）、按供应商的成功/失败与成功率（`/providers/stats`，聚合 `shc_traces`） |

便利性：粘性保存栏（滚到哪都能保存）、`Ctrl/Cmd+S` 保存、按页签统计的改动数徽标、离开前未保存提醒、一键刷新、
失败/成功统一走 `useNotification`、所有输入带 `aria-label`、只读账号全量禁用写控件并在顶部说明原因。

### 4. 新增/变更接口（B4）

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/turnstile/providers` | admin | 追加 `policy`、`widgets`、`scenarios`、`strategies`、`defaults`、每家 `priority`/`scenarioWeights` |
| PUT | `/api/turnstile/providers` | superadmin + audit | 追加 `priority`、`scenarioWeights` |
| GET/PUT | `/api/turnstile/providers/policy` | admin / superadmin + audit | 分配策略读写 |
| GET/PUT | `/api/turnstile/providers/widgets` | admin / superadmin + audit | 控件外观读写 |
| POST | `/api/turnstile/providers/simulate` | admin | 按草稿算抽取分布（不写库） |
| GET | `/api/turnstile/providers/selection` | admin | 当前会选谁（可 `scenario`/`fingerprint`），`force` 时返回指定供应商的下发配置（实机预览用） |
| GET | `/api/turnstile/providers/stats` | admin | 近 N 小时 trace 的成功/失败聚合 |
| POST | `/api/turnstile/secure-captcha-config` | public | 请求体追加 `scenario`/`exclude`，响应追加 `widget`/`scenario`/`strategy` |

### 5. 治理（B5）

- 新路由补 `@openapi` 注释；不改 `adminModules.tsx` 的键，故无需重跑 SPA 路径生成。
- 新文件 ≤ 1500 行；既有 `CaptchaProviderAdmin.tsx` 保持为壳（拆到 `captcha-providers/` 子目录）。
- 单测：`src/tests/captchaAllocation.test.ts`（纯引擎：策略、粘性确定性、灰度、归一化钳制）+ 更新
  `src/tests/captchaProviderSelection.test.ts` 的模型 mock（新增 policy/widgets 读取）。

## 三、批次

| 批次 | 内容 |
| --- | --- |
| P1 | 类型 + 存储 + 纯函数引擎（`types.ts`/`models.ts`/`allocation.ts`）+ 选择引擎接入 |
| P2 | 控制器 + 路由 + 门面（`allocationHandlers.ts`(新)、`providersHandlers.ts`、`configHandlers.ts`、`turnstileRoutes.ts`、`turnstileService.ts`） |
| P3 | 前端下发链路（`captchaSelection.ts`、`useSecureCaptchaSelection.ts`、三家 Widget、两个消费页） |
| P4 | 管理台四页签（`captcha-providers/*` 新目录 + 壳） |
| P5 | 单测 + 文档回填 |

## 四、验收

1. `GET /api/turnstile/providers` 一次拿到策略/外观/场景/默认值；`PUT` 改 `priority` 与场景权重后
   `secure-captcha-config` 的分布随之变化。
2. `strategy=failover` 时按 `priority` 下发；前端把 `exclude` 传回后落到下一家。
3. `stickyEnabled` 打开后，同一指纹在窗口内多次请求得到同一家；窗口跨过之后允许变化（确定性可复现）。
4. `rolloutPercent=100` 等价于全量走策略；`=0` 关闭灰度；对照组供应商不可用时自动忽略灰度。
5. 外观设置改 `theme=dark`/`language=en`/关署名后，门禁页与独立验证页的三家控件都按新值渲染。
6. 管理台：四页签可切、草稿未保存有提示、模拟器与「当前会选谁」结果与实际下发一致、额度/统计有图可看。
7. CI 全绿（tsc 前后端、quality-guardrails、openapi 漂移、admin SPA 漂移、Jest 存量用例）。

## 五、风险

- R1：多读两份配置（策略/外观）会给下发链路加两次 Mongo 读 —— 用 30s 进程内缓存兜住，写侧失效。
- R2：粘性/轮换/灰度都必须是**确定性纯函数**，否则多实例下同一用户会得到不同结论；随机源仍只用于 `weighted`。
- R3：`secure-captcha-config` 是公开端点，只能回 `theme/size/language/署名开关` 这类非敏感项，绝不回权重、额度、secret。
