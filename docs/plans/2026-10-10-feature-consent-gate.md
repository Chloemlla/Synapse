# 按用户自己的政策同意开放功能访问（feature consent gate）

> 状态：**方案冻结，待实现**。日期：2026-10-10。
> 依据：`AGENTS.md`（禁本机构建、显式 add、动态提交）+ `CLAUDE.md`（认证/授权与治理闸门）。
> 目标：普通用户**自己勾选**政策文件后，才获得对应功能的前后端访问权；撤销同意立即收回访问。

## 1. 与现有体系的差距（为什么不能直接用现成门禁）

现有同意体系（`config/policyMeta.ts` + `services/policyConsentService.ts` + `models/policyConsentModel.ts`）：

- 四份必读文件 `terms / usage / specific-terms / supported-regions`，版本 `POLICY_VERSION`（当前 2.2），同意有效期 `POLICY_CONSENT_VALIDITY_DAYS`（默认 30 天）；
- 记录落在 `policy_consents`，**唯一身份是 `fingerprint`（设备指纹）**，`hasValidPolicyConsent(fingerprint, version)` 已用于 TTS 门禁；
- `recordPolicyConsent`（`POST /api/policy/verify`）落 `source: "feature"`，并只写指纹，**没有 userId**。

问题：按指纹判定 = 同一台设备上换个账号也能蹭到同意（同意泄漏），与「用户**自己**勾选」不符。因此本方案把同意记录**绑到用户**，功能门禁按 `userId` 判定。

## 2. 三条硬性取舍

1. **按用户判定，fail-closed，不用指纹兜底**：`hasValidUserConsent(userId)` 只认 `userId` 命中的有效记录；没有记录（含历史只绑指纹的记录）一律视为未同意，由前端一键同意补齐。理由：用户级门禁一旦回落到设备级，就等于把「账号 A 同意、账号 B 通行」重新引回来。
2. **门禁不加进程缓存**：撤销同意必须立刻生效。代价是每个受保护请求多一次带索引的 Mongo 查询 —— 这些功能本身都是重操作（上传文件、跑 pandoc），这次查询不构成瓶颈。
3. **同意记录必须勾满该功能要求的文件**：沿用 `isCompleteAgreementSet` 的口径，避免「版本号对得上但只勾了一部分」的旧记录被当成有效同意。

## 3. 功能 ↔ 政策文件的映射（`src/config/featureConsent.ts`）

| 功能 key | 用户可见名 | 需要的文件 | 为什么 |
|---|---|---|---|
| `doc-tool` | 文档转换（Markdown → Word） | `usage` + `specific-terms` | 用户文件要上传到服务端并由服务端处理 |
| `image-upload` | 图片上传 | `usage` + `specific-terms` | 同上（图床/图片入库） |

扩展方式：在这张表里加一行 `FEATURE_CONSENT_KEYS` + `FEATURE_CONSENT_REQUIREMENTS`，然后在目标路由挂 `requireFeatureConsent("<key>")`。**不写死在前端**：前端只读 `GET /api/policy/feature-consent` 返回的状态。

## 4. 冻结接口

### 4.1 新增 `src/config/featureConsent.ts`（叶节点，只依赖 `policyMeta`）

```ts
export const FEATURE_CONSENT_KEYS = ["doc-tool", "image-upload"] as const;
export type FeatureConsentKey = (typeof FEATURE_CONSENT_KEYS)[number];

export interface FeatureConsentRequirement {
  key: FeatureConsentKey;
  /** 面向用户的短名（入口/chip 用） */
  label: string;
  /** 该功能要求勾选的政策文件 */
  agreements: PolicyAgreementKey[];
  /** 未同意时的中文说明：只讲「要做什么 / 现在什么状态」 */
  message: string;
}

export const FEATURE_CONSENT_REQUIREMENTS: Record<FeatureConsentKey, FeatureConsentRequirement>;
export function isFeatureConsentKey(value: unknown): value is FeatureConsentKey;
export function requiredAgreementsFor(feature: FeatureConsentKey): PolicyAgreementKey[];

/** 给前端的每功能状态（`GET /api/policy/feature-consent` 的元素） */
export interface FeatureConsentView {
  key: FeatureConsentKey;
  label: string;
  message: string;
  satisfied: boolean;
  requiredAgreements: PolicyAgreementKey[];
  /** 该用户还缺哪些（未同意 / 已过期 / 已撤销 / 未勾满） */
  missingAgreements: PolicyAgreementKey[];
  policyVersion: string;
  /** 有效同意记录的到期时间（无有效记录时 null） */
  expiresAt: string | null;
}
```

### 4.2 模型（`src/models/policyConsentModel.ts` 增字段）

- `userId?: string`、`username?: string`（可选：未登录的指纹级同意仍照旧写入，保持向后兼容）；
- 新索引 `{ userId: 1, recordedAt: -1 }`；
- 新静态方法 `findValidConsentForUser(userId: string, version: string)`（`isValid: true` + `expiresAt > now`）。

### 4.3 服务（`src/services/policyConsentService.ts` 增函数）

```ts
// 写记录时带上用户身份（未登录传 undefined）
export async function writePolicyConsent(params: { fingerprint: string; source: PolicyConsentSource;
  userAgent?: string; ipAddress?: string; userId?: string; username?: string }): Promise<...>;

/** 用户级有效同意：只认 userId，**不回落到指纹**；且要求勾满全部四份文件。 */
export async function hasValidUserConsent(userId: string, version?: string): Promise<boolean>;

/** 每个功能一条状态（前端入口与页面门禁都用它）。 */
export async function resolveFeatureConsentViews(userId: string, version?: string): Promise<FeatureConsentView[]>;

/** 撤销/重新同意后让门禁立刻看到新状态 —— 本方案不加缓存，这个导出留给测试与未来缓存用。 */
export function __resetFeatureConsentCacheForTests(): void;   // 可选：未加缓存时实现为空并注释说明
```

### 4.4 中间件（新增 `src/middleware/featureConsent.ts`）

`requireFeatureConsent(feature: FeatureConsentKey): RequestHandler`

- 未登录 → `401 { error: "未登录", code: "UNAUTHENTICATED" }`；
- 已登录但未同意 → `403`：

```json
{ "error": "该功能需要先同意相关条款", "code": "POLICY_CONSENT_REQUIRED",
  "feature": "doc-tool", "label": "文档转换（Markdown → Word）",
  "requiredAgreements": ["usage","specific-terms"], "missingAgreements": ["usage","specific-terms"],
  "policyVersion": "2.2", "message": "上传到服务端处理前，需要先同意使用政策与服务专项条款。" }
```

`code` 必须稳定：前端靠它决定弹同意清单（靠文案匹配是最后手段，不是默认手段）。

### 4.5 路由

- `GET /api/policy/feature-consent`（`authenticateToken`，`policyRateLimit`）→ `{ policyVersion, features: FeatureConsentView[] }`，写在 `src/routes/policyRoutes.ts` 并配 openapi 注释（路径相对段：`/policy/feature-consent`）。
- 受保护路由：`src/routes/docToolRoutes.ts` 内 `router.use(requireFeatureConsent("doc-tool"))`；图片上传路由（先核实是用户态还是管理端）同样挂 `image-upload`。

### 4.6 前端

- `frontend/src/api/policy.ts` 增 `fetchFeatureConsent(): Promise<{ policyVersion: string; features: FeatureConsentView[] }>`（类型镜像后端，放本文件里，不新开类型文件）；
- 新增 `frontend/src/hooks/useFeatureConsent.ts`：`useFeatureConsent(feature)` → `{ loading, ready, view, refresh, accept }`；
- 新增 `frontend/src/components/FeatureConsentGate.tsx`：未同意时渲染同意清单（**复用** `PolicyConsentChecklist` + `policyCards` 的既有卡片形态与 `recordPolicyConsent()`），同意后 `refresh()` 放行；已同意直接渲染 children；
- `DocConvertPage.tsx` 用 `<FeatureConsentGate feature="doc-tool">` 包住 `DocBatchPanel`；
- 403 兜底：面板捕获 `POLICY_CONSENT_REQUIRED` 时也弹同一份清单（避免用户绕过页面直接调接口后只看到一句错误）。

## 5. 治理闸门对应

| 闸门 | 影响 |
|---|---|
| `check:privacy-data-map` / `check:privacy-contract` | 同意记录新增 `userId/username` 字段属于**已有数据集**（`policy-consents` 在隐私地图里）的字段扩展：需在 `docs/governance/privacy-data-map.json` 的该数据集 `fields` 里补两项，并**同步重新生成** `src/generated/privacyDataMap.ts`（生成器是纯 fs 脚本，本机禁跑 → 由 CI 的 `check:privacy-data-map` 报漂移，按生成器的渲染规则手工补齐字节级一致的内容） |
| `check:openapi-drift` | 新端点写 `@openapi` 注释；CI 先 generate 再对账，注释合法即绿 |
| `check:ts-file-size` | 新文件都很小；`policyConsentService.ts`（现有 200+ 行）增量有限 |
| Jest / Vitest | 新增后端中间件/服务用例、前端门禁组件用例 |
| `check:frontend-bundle` | 门禁组件走 `DocConvertPage`（懒加载）路径，不进首屏闭包 |

## 6. 验证判据（CI 裁决）

1. 未登录访问受保护功能 → 401；已登录未同意 → 403 且带 `POLICY_CONSENT_REQUIRED` + 缺失项；同意后同一请求 → 放行（后端单测 + 前端组件测试）。
2. 撤销同意后，同一用户的访问**立即**被收回（无缓存，服务函数直接反映撤销）。
3. 用户 A 的同意**不会**让用户 B 通过（同一设备指纹也不行）—— 这条是本方案的核心判据，必须有用例。
4. 前端：未同意时页面显示同意清单而不是功能面板；同意成功后自动放行且入口可见。
