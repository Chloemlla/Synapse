# 后端密钥统一为单一 AES_KEY + 派生子密钥 + 首启数据迁移 —— 技术设计文档

> 状态：已定稿（D-1=双接受过渡；D-2=并入 env 主密钥；新增 env-manager 验证后查看密钥）
> 日期：2026-09-27
> 关联：`verified-methodology.md` §一-8（先落盘完整清单再动手）、`docs/audit-2026-09-27.md`
> 决策来源：用户要求「所有后端内部密钥只保留一个 `AES_KEY`，其它全部重定向；采用**单一主密钥 + `HMAC(AES_KEY, 标签)` 派生子密钥**；首启检测新版构建后对库内全部密文逐条解密再重加密，期间展示迁移进度页；先落文档再逐项勾选落实」。

---

## 0. 目标与非目标

### 0.1 目标
1. **唯一可管理密钥**：运维只需维护一个 `AES_KEY`。所有**内部**签名/加密密钥都由它派生，不再各自独立配置。
2. **域分隔派生**：各用途用 `HKDF/HMAC(masterKey, 标签)` 得到独立子密钥，避免跨算法裸复用同一份密钥。
3. **零数据丢失**：现有库内密文（旧密钥加密）在首启迁移阶段被逐条解密→用新派生子密钥重加密，迁移完成前不对外提供正常服务，只显示「服务器迁移中」进度页。
4. **旧密钥可从 DB 运行时配置取出**：迁移期需要的旧密钥直接从 `runtime_config_settings`（`RuntimeConfigModel`）+ `data/env.admin.json` + `process.env` 汇聚成「仅解密」候选链，不要求运维再手工填旧 env。
5. **前端同步**：`env-manager` 只保留 `AES_KEY` 一个可编辑项，被重定向的内部密钥分区改为只读并标注来源；外部第三方凭据分区保持不变。

### 0.2 非目标（明确不做）
- **不重定向外部第三方凭据**（见 §2.4）。把它们指向 `AES_KEY` 只会让集成失效。
- 不引入新的第三方 KMS / 密钥托管。
- 不改变各密文的算法本身（仍为 AES-256-GCM / HMAC-SHA256），只改「密钥从哪来」。

---

## 1. 现状盘点（代码取证）

### 1.1 密钥来源机制（三层）
| 层 | 位置 | 说明 |
|---|---|---|
| 进程环境变量 | `process.env` | `.env` / 容器注入 |
| 管理后台落盘覆盖 | `data/env.admin.json` | `adminController.setEnv` 写盘并同时写 `process.env`；`config/env.ts` 启动时重放，优先级：**后台覆盖 > 真实 env > .env > 默认** |
| DB 运行时配置 | `runtime_config_settings`（`RuntimeConfigModel`，`src/services/runtimeConfigService.ts`） | 分组对象，`value` 为**明文 Mixed**。键集见 `RUNTIME_CONFIG_KEYS`（含 `NEXAI_SIGNING`/`CDICT_SIGNING`/`QQ_GUARD_SIGNING`/`LUMEN`/`PROXYCHECK`/`ADMIN_SECURITY` 等） |

- `JWT_SECRET` / `AES_KEY` / `PASSWORD_ENCRYPTION_KEY` / `BILIBILI_COOKIE_ENCRYPTION_KEY` / `DATA_COLLECTION_RAW_SECRET` 是**受保护键**（`PROTECTED_ENV_KEYS` / `DATA_AT_REST_ENCRYPTION_KEYS`，`src/config/protectedEnvKeys.ts`），运行时不可改写；覆盖静态加密根密钥须带 `confirmRotate`。
- 各 app-sign / proxycheck 密钥则存在 **DB 运行时配置**里，可运行时改。← 迁移取旧密钥的关键来源。

### 1.2 内部密钥用途分类（本次改造对象）

**A. 签名类（不落库、改密钥即令牌/签名失效）**
| 密钥 | 用途 | 取证位置 |
|---|---|---|
| `JWT_SECRET`（`config.jwtSecret`） | 用户 JWT 签名/校验、多处 HMAC 兜底 | `config.ts:262`；被 `passwordSecurity`/`verificationTokenModel`/`tts.assetAccess`/`policyConsentService` 当兜底源 |
| `SIGN_SECRET_KEY`（`config.signSecretKey`） | 防重放签名 | `middleware/replayProtection.ts:23` |
| `PROXYCHECK_HMAC_SECRET` | 客户端出口探测 HMAC 会话 | `config.ts:408`、`ipRiskController` |
| `PROXYCHECK_PAYLOAD_VERIFICATION_KEY` | proxycheck 回调载荷校验 | `config.ts:407`、`services/proxycheckSignature.ts` |
| `SMART_HUMAN_CHECK_SECRET` | 人机验证令牌 | `services/smartHumanCheckService.ts:545`（缺失回退进程级临时高熵） |
| `VERIFICATION_TOKEN_SECRET` | 验证令牌 metadata 加密（**其实是静态加密**，见 B） | `models/verificationTokenModel.ts:90` |

**A′. 共享签名类（与客户端 App 共享密钥 —— 高危，见 §5 D-1）**
| 密钥 | 客户端 | 取证 |
|---|---|---|
| `NEXAI_APP_SIGN_SECRET`(+`_PREV`) | NexAI App | DB `NEXAI_SIGNING`、`config.ts:370` |
| `CDICT_APP_SIGN_SECRET`(+`_PREV`) | CDict App | DB `CDICT_SIGNING`、`config.ts:386` |
| `QQ_GUARD_SHARED_SECRET` | QQ Guard Bot | DB `QQ_GUARD_SIGNING`、`config.ts:398` |
| `LUMEN_REQUEST_SIGNING_SECRET` | Project-Lumen 客户端 | DB `LUMEN` |
| `ECOENCHANTS_*_TOKEN_SECRET` / `*_WEBHOOK_SECRET` / `LICENSE_KEY_PEPPER` | EcoEnchants 插件 / 支付平台 | `services/ecoEnchants*.ts` |
| `MEDIA_TOOL_KEY` | media-tool 独立壳 | `mediaTool/standalone.ts:24` |

> A′ 的密钥**烧在客户端里**，服务端单方面改成 `AES_KEY` 派生 = 所有存量客户端签名校验失败。`ECOENCHANTS_*_WEBHOOK_SECRET`、`*_STRIPE/PAYPAL/POLYMART_WEBHOOK_SECRET` 更是**外部平台**设定的，属外部凭据（§2.4）。

**B. 静态加密类（落库密文，改密钥必须迁移，否则永久解不开）**
| 数据 | 集合 / 字段 | 算法 | 现有密钥源（优先级链） | 版本标记 |
|---|---|---|---|---|
| 用户密码可逆密文（仅**历史遗留**行；新写入只存 bcrypt 哈希） | `users`：`passwordCiphertext/Iv/Tag/KeyVersion/WrappedDek/DekId` | AES-256-GCM + HKDF 派生每用户 DEK | KEK=`sha256(PASSWORD_ENCRYPTION_KEY \|\| AES_KEY \|\| jwtSecret)` | `v1`(legacy 派生)/`v2`(wrappedDek) |
| Bilibili 同步凭据 | `bilibili_sync`：`credentialCiphertext/Iv/Tag/KeyVersion` | AES-256-GCM | `credentialKeys()`=[`BILIBILI_COOKIE_ENCRYPTION_KEY`,`PASSWORD_ENCRYPTION_KEY`,`AES_KEY`,`jwtSecret`] 各 `sha256` | `v1` |
| Bilibili 登录上报凭据 | `bilibili_cookie_reports`：同上（`select:false`） | 同上 | 同上（共用 `encryptCredential`） | `v1` |
| 验证令牌 metadata | `verification_tokens`：`metadataCiphertext/Iv/Tag` | AES-256-GCM | `sha256(VERIFICATION_TOKEN_SECRET \|\| JWT_SECRET \|\| AES_KEY \|\| jwtSecret)` | 无（10 分钟 TTL） |
| 数据采集原始详情 | 采集集合：`encryptedRaw{iv,tag,data}` | AES-256-GCM | `sha256(DATA_COLLECTION_RAW_SECRET)`（为空则不加密） | 无 |
| 短链导出加密 | `ShortUrlSetting{key:"AES_KEY"}`（DB） / `AES_KEY` env | AES | DB 优先，回退 env `AES_KEY` | 见 §5 D-2 |

**C. 盐 / pepper 类（HMAC/hash 输入，改则历史校验值失配）**
- `POLICY_SECRET_SALT`（`policyConsentService.ts:9`，生产必配，缺失回退 `JWT_SECRET`）
- `LEGACY_API_CHOICE_SECRET`（`legacyApiRedirect.ts:336`）
- `TTS_ASSET_ACCESS_SECRET`（`tts.assetAccess.ts:93`，回退 `jwtSecret`）
- `LICENSE_KEY_PEPPER`（`ecoEnchants*.ts`，pepper 一旦变更历史 license 全失配 → 归入 A′/外部约束）

### 1.3 启动流程
`src/app.ts` → `startServer(app)`（`src/app/startup.ts`）→ `connectMongo()` → 各后台服务 → `app.listen(port)`。**迁移闸门插入点 = `connectMongo()` 之后、正常路由生效/`listen` 对外之前。**

---

## 2. 目标架构

### 2.1 主密钥与派生
```
masterIkm  = sha256(AES_KEY)                       // 32B，统一入口
subkey(label) = HKDF-SHA256(ikm=masterIkm,
                            salt="synapse-key-v1", // 固定 salt，域版本号
                            info=label,            // 用途标签
                            length=32)             // 32B
```
- **加密用途**直接用 `subkey(label)` 作 AES-256-GCM 密钥。
- **HMAC/签名用途**用 `subkey(label)` 作 HMAC key（或其 hex 作字符串密钥，取决于调用点契约）。
- **实现**：`crypto.hkdfSync("sha256", masterIkm, salt, Buffer.from(label), 32)`。（备选 `HMAC(masterIkm, label)`，等价强度；本设计选 HKDF 以带 salt 做域版本。）

### 2.2 标签表（`src/config/keyDerivation.ts` 单一出处）
| 标签常量 | value | 替换的旧密钥 |
|---|---|---|
| `KL.JWT` | `"jwt"` | `JWT_SECRET` / `config.jwtSecret` |
| `KL.REPLAY_SIGN` | `"replay-sign"` | `SIGN_SECRET_KEY` |
| `KL.PASSWORD_KEK` | `"password-kek"` | password KEK |
| `KL.BILIBILI_CRED` | `"bilibili-cred"` | bilibili 凭据 |
| `KL.VERIFICATION_META` | `"verification-metadata"` | `VERIFICATION_TOKEN_SECRET` |
| `KL.DATA_COLLECTION_RAW` | `"data-collection-raw"` | `DATA_COLLECTION_RAW_SECRET` |
| `KL.POLICY_SALT` | `"policy-salt"` | `POLICY_SECRET_SALT` |
| `KL.TTS_ASSET` | `"tts-asset"` | `TTS_ASSET_ACCESS_SECRET` |
| `KL.LEGACY_API_CHOICE` | `"legacy-api-choice"` | `LEGACY_API_CHOICE_SECRET` |
| `KL.SMART_HUMAN_CHECK` | `"smart-human-check"` | `SMART_HUMAN_CHECK_SECRET` |
| `KL.PROXYCHECK_HMAC` | `"proxycheck-hmac"` | `PROXYCHECK_HMAC_SECRET` |
| `KL.PROXYCHECK_PAYLOAD` | `"proxycheck-payload"` | `PROXYCHECK_PAYLOAD_VERIFICATION_KEY` |
| `KL.SHORT_URL` | `"short-url-aes"` | 短链导出 `AES_KEY`（D-2：并入主密钥） |
| `KL.NEXAI_SIGN` | `"nexai-app-sign"` | `NEXAI_APP_SIGN_SECRET`（D-1：双接受） |
| `KL.CDICT_SIGN` | `"cdict-app-sign"` | `CDICT_APP_SIGN_SECRET`（D-1：双接受） |
| `KL.QQGUARD_SIGN` | `"qqguard-shared"` | `QQ_GUARD_SHARED_SECRET`（D-1：双接受） |
| `KL.LUMEN_SIGN` | `"lumen-request-sign"` | `LUMEN_REQUEST_SIGNING_SECRET`（D-1：双接受） |

### 2.3 统一密钥解析层
新增 `src/config/keyDerivation.ts`：
```ts
export const KL = { JWT: "jwt", REPLAY_SIGN: "replay-sign", /* … */ } as const;
export type KeyLabel = typeof KL[keyof typeof KL];

function masterIkm(): Buffer { /* sha256(process.env.AES_KEY) 惰性；缺失走临时高熵+告警 */ }
export function deriveKey(label: KeyLabel): Buffer { /* HKDF 32B */ }
export function deriveSecretHex(label: KeyLabel): string { return deriveKey(label).toString("hex"); }

// 仅解密：新派生子密钥 + 全部旧密钥候选（env + env.admin.json + DB 运行时配置），去重
export async function legacyDecryptKeys(label: KeyLabel): Promise<Buffer[]> { /* 见 §3.3 */ }
```
- **惰性求值**：`masterIkm()` 每次读 `process.env.AES_KEY`（尊重运行期覆盖），内部做进程级缓存 + 失效钩子（`AES_KEY` 变更时清缓存）。
- **生产校验**：`AES_KEY` 未配置或 < 32 字符 → `config.ts` 的 zod superRefine 直接拒绝启动（对齐现有 `JWT_SECRET` 校验）。

### 2.4 外部第三方凭据（保持独立，**不重定向**）
`OPENAI_API_KEY`/`CHAT_API_KEY`、`RESEND_API_KEY`、`TURNSTILE_SECRET_KEY`、`HCAPTCHA_SECRET_KEY`、`PROXYCHECK_API_KEY`/`PUBLIC_API_KEY`、`IP_QUERY_KEY`、`VIVO_*`、`LINUXDO_*`、`PLAY_INTEGRITY_...PRIVATE_KEY`、`STRIPE/PAYPAL/POLYMART_WEBHOOK_SECRET`、`*_GITHUB_TOKEN`、`ADMIN_PASSWORD`/`ADMIN_OPERATION_PASSWORD`/`SERVER_PASSWORD`、`MONGO_URI`/`REDIS_URL` 等 —— 由第三方或运维独立设定，`env-manager` 分区照旧可编辑。

---

## 3. 首启数据迁移

### 3.1 版本标记与触发
- 代码内常量 `SECURITY_KEY_SCHEME_VERSION = 2`（1=旧多密钥，2=单主密钥派生）。
- DB 存 `security_migrations` 集合单文档 `{ _id:"key-scheme", version, phase, progress, startedAt, finishedAt }`（或复用 `RuntimeConfigModel` 一个非枚举键 —— 但其 `key` 有 enum 约束，故**新建独立集合**）。
- 启动时读该文档：
  - `stored.version >= 2 && phase==="done"` → 跳过迁移，正常启动。
  - 否则 → **进入迁移模式**（含首次部署、上次迁移中断）。

### 3.2 迁移闸门（服务不对外）
- `startServer`：`connectMongo()` 后先判定是否需迁移；需要则：
  1. 启动一个**最小 HTTP 服务**（或在完整 app 前挂一个 `migrationGate` 中间件）：
     - 放行：静态迁移页资源、`GET /api/system/migration-status`、健康探针 `GET /health`（返回 503 + `{migrating:true}`）。
     - 其余一切请求 → `503` + JSON `{ success:false, migrating:true }`；HTML 请求 → 返回迁移进度页。
  2. 后台异步跑迁移 runner。
  3. runner 完成 → 写 `phase="done"` → **平滑切换**到完整 app（简单实现：迁移完成后 `process.exit(0)` 由进程管理器/容器重启拉起正常模式；健壮实现：不重启，动态卸载 gate、注册正式路由）。**首版采用「迁移完成即受控退出重启」**，逻辑最简、最不易错（容器/systemd 会重新拉起，此时 `phase==="done"` 直接正常启动）。

### 3.3 旧密钥候选链（`legacyDecryptKeys`）
按用途聚合，去重后依次尝试（GCM auth tag 判定命中）：
1. 新派生子密钥 `deriveKey(label)`（已迁移行）。
2. env / `env.admin.json` 里的旧命名密钥（如 `BILIBILI_COOKIE_ENCRYPTION_KEY`、`PASSWORD_ENCRYPTION_KEY`、`AES_KEY`、`JWT_SECRET`、`VERIFICATION_TOKEN_SECRET`、`DATA_COLLECTION_RAW_SECRET`）各 `sha256`。
3. **DB 运行时配置** `runtime_config_settings` 内相关密钥（如 `PROXYCHECK.hmacSecret`、`NEXAI_SIGNING.appSignSecret` …）——满足用户「从数据库运行时配置取」。
4. 全部 `sha256` 归一为 32B，`Set` 去重。

### 3.4 逐集合重加密（幂等、可恢复、可跳错）
按批（如 500/批）游标遍历，每行：解密（候选链）→ 用 `deriveKey(label)` 重加密 → 写回并打**新版本标记**（如 `credentialKeyVersion="v2"`）。已是新版本的行跳过（幂等）。解密全失败的行：记 `failed++` + 日志（含 `_id`），**不中断**整体迁移。

| 阶段 | 集合 | 处理 |
|---|---|---|
| P1 | `bilibili_sync` | `credentialCiphertext…` 重加密，`credentialKeyVersion→v2` |
| P2 | `bilibili_cookie_reports` | 同 P1（注意 `select:false`，需显式 `+` 取字段） |
| P3 | `users`（历史遗留密文行，`passwordCiphertext` 非空） | 解出 DEK→用新 KEK 重 `wrapDek`，`passwordKeyVersion→v2`；仅 bcrypt 哈希行跳过 |
| P4 | 数据采集集合 `encryptedRaw` | 重加密（旧 `DATA_COLLECTION_RAW_SECRET` 为空则本阶段无数据） |
| P5 | `verification_tokens` | **不迁移**：10 分钟 TTL，直接让其过期（迁移期本就不签发新令牌）。仅在文档中声明豁免 |

### 3.5 进度模型（`GET /api/system/migration-status`）
```jsonc
{
  "migrating": true,
  "schemeVersion": 2,
  "phase": "P2",              // P1..P5 / done / failed
  "phaseLabel": "迁移 Bilibili 登录上报凭据",
  "collections": [
    {"key":"bilibili_sync","total":1234,"processed":1234,"failed":0,"done":true},
    {"key":"bilibili_cookie_reports","total":88,"processed":40,"failed":0,"done":false}
  ],
  "overall": {"processed":1274,"total":1322,"failed":0,"percent":96},
  "startedAt":"…","updatedAt":"…"
}
```
进度落 `security_migrations` 文档，前端轮询（2–3s）。

### 3.6 安全前置
- **迁移前强制 `mongodump` 备份**（脚本/文档双保险；见 §8 回滚）。
- 迁移期禁止签发新令牌/写新凭据（gate 已拦全部业务路由）。

---

## 4. 前端改造（`frontend/src/components/env-manager` + 迁移页）

### 4.1 迁移进度页
- 新增 `frontend/src/pages/MigrationGate.tsx`（或全局拦截组件）：轮询 `migration-status`，展示总进度条 + 分集合明细 + 「服务器迁移中，请稍候」文案（**不写实现原理**，对齐方法论 §一-10；诊断细节收进可展开「详情」）。
- 触发方式：SPA 首屏若任一 API 命中 `503 {migrating:true}` → 切到该页；`done` 后自动 reload。

### 4.2 env-manager
- `SecretKeySection` / `SelfContainedSecretKeySection`：`AES_KEY` 成为**唯一主密钥**，加说明「所有内部签名/加密密钥均由它按用途派生」。
- 被重定向的内部密钥分区（`SecuritySecretSection`、`ProxycheckConfigSection` 的 hmac/payload 字段、`NexaiSigningConfigSection`/`CDictSigningConfigSection` 视 D-1 结果…）：
  - 若纳入重定向：字段置**只读** + 徽标「已重定向到 AES_KEY（派生子密钥），无需单独配置」。
  - 若因 D-1 保留：维持可编辑，加提示。
- 外部凭据分区（Turnstile/Hcaptcha/Email/Github/Lumen 外呼等）：**不动**。
- `types.ts` / `configurationNotice.ts`：更新「缺失必配密钥」告警——被派生的键不再报缺失；只报 `AES_KEY` 缺失。

---

## 5. 待拍板决策项

- **D-1 = 选项 (b) 双接受过渡（已定）**：A′ 共享签名类（`NEXAI_/CDICT_APP_SIGN_SECRET`、`QQ_GUARD_SHARED_SECRET`、`LUMEN_REQUEST_SIGNING_SECRET`）**签发**改用派生子密钥（`KL.*_SIGN`），**校验同时接受**「新派生子密钥」与「DB 运行时配置里的旧值（含 `*_PREV`）」。待 CDict/PiliPlus/Project-Lumen 发版内置新密钥后，再单独提交撤掉旧值接受分支。

- **D-2 = 选项 (a) 并入 env 主密钥（已定）**：短链导出加密密钥统一为 `deriveKey(KL.SHORT_URL)`（源自 env `AES_KEY`）。`ShortUrlSetting{key:"AES_KEY"}` DB 独立键**降级为仅解密兜底**：导入旧的离线加密导出包时，若新派生 key 解不开，回退尝试 DB 内旧 `AES_KEY` 与 env 旧值；导出一律用新派生 key，并在 UI 提示「旧导出包需用当时的 key 离线解密后重导」。

- **D-3（告知）：外部第三方凭据不重定向**（§2.4），无需拍板。

- **D-4：JWT 折入 `AES_KEY` 的一次性全体登出** —— 用户已确认接受。

- **D-5（新增，已定）：env-manager 验证管理员后可查看密钥明文。** 新增受保护的「查看密钥」能力：superadmin 二次验证（复用 `ADMIN_OPERATION_PASSWORD` / 现有 admin 操作校验链）后，后端返回 `AES_KEY` 及各派生子密钥的 hex（或按需单个），前端在 env-manager 以「点击查看/复制」形式展示，默认脱敏。审计日志记录每次查看。

---

## 6. 落地检查清单（对着逐项勾选）

### 阶段 A：派生层与配置
- [ ] A1 新增 `src/config/keyDerivation.ts`：`KL` 标签表、`deriveKey`/`deriveSecretHex`、`legacyDecryptKeys`、`masterIkm` 惰性+缓存失效。
- [ ] A2 `config.ts`：`AES_KEY` 生产必配校验（zod superRefine，≥32）；`config.jwtSecret` 改为 `deriveSecretHex(KL.JWT)`（保留旧 `JWT_SECRET` 仅作 legacy 校验候选）。
- [ ] A3 `protectedEnvKeys.ts`：`AES_KEY` 保持受保护；被派生的旧键从「必配」语义降级（仍受保护但允许为空）。

### 阶段 B：签名类改造（不落库）
- [ ] B1 `middleware/replayProtection.ts`：签名密钥改 `deriveSecretHex(KL.REPLAY_SIGN)`；过渡期候选保留旧 `SIGN_SECRET_KEY`。
- [ ] B2 `ipRiskController` + `clientProbeService`：`hmacSecret` 改 `deriveSecretHex(KL.PROXYCHECK_HMAC)`。
- [ ] B3 `proxycheckSignature.ts`：payload 校验密钥改 `deriveSecretHex(KL.PROXYCHECK_PAYLOAD)`。
- [ ] B4 `smartHumanCheckService.ts`：改 `deriveSecretHex(KL.SMART_HUMAN_CHECK)`（去掉进程级临时密钥分支或保留为极端兜底）。
- [ ] B5 `policyConsentService.ts`：salt 改 `deriveSecretHex(KL.POLICY_SALT)`（**注意**：改 salt 会让历史 consent 校验值失配 —— 评估是否需迁移或宽限）。
- [ ] B6 `tts.assetAccess.ts` / `legacyApiRedirect.ts`：改对应派生。

### 阶段 C：静态加密类改造 + 迁移
- [ ] C1 `bilibiliSyncService.ts`：`encryptCredential` 用 `deriveKey(KL.BILIBILI_CRED)`；`credentialKeys()`→`legacyDecryptKeys(KL.BILIBILI_CRED)`；`credentialKeyVersion` 升 `v2`。
- [ ] C2 `passwordSecurity.ts`：`getPasswordMasterKey`→`deriveKey(KL.PASSWORD_KEK)`；解密保留旧 KEK 候选。
- [ ] C3 `verificationTokenModel.ts`：`metadataKey`→`deriveKey(KL.VERIFICATION_META)`（配合 P5 豁免，仅新令牌用新键）。
- [ ] C4 `dataCollectionService.ts`：`encryptedRaw` 用 `deriveKey(KL.DATA_COLLECTION_RAW)`。
- [ ] C5 新增 `security_migrations` 模型 + `src/services/keySchemeMigrationService.ts`（版本判定、gate、runner P1–P5、进度写入、跳错、幂等）。
- [ ] C6 `app/startup.ts`：`connectMongo` 后接迁移判定；需迁移则起 gate + runner，完成受控退出重启。
- [ ] C7 `app/assembly.ts`：`migrationGate` 中间件 + `GET /api/system/migration-status`。

### 阶段 D：前端
- [ ] D1 `MigrationGate` 页/拦截 + 503 探测切换 + 完成自动 reload。
- [ ] D2 `env-manager`：`AES_KEY` 主密钥文案；被重定向分区只读+徽标；告警只报 `AES_KEY` 缺失。
- [ ] D3 **验证后查看密钥（D-5）**：后端新增受 superadmin + 二次验证保护的 `POST /api/admin/env/reveal-key`（入参 label 或 `master`，返回 hex；审计留痕）；前端 env-manager 加「验证后查看/复制」交互（默认脱敏，验证态短时有效）。
- [ ] C8 **短链（D-2）**：`shortUrlService` 加密改 `deriveKey(KL.SHORT_URL)`；导入解密候选链加 DB 旧 `AES_KEY` + env 旧值兜底。
- [ ] B7 **app-sign 双接受（D-1）**：`nexai/cdict/qqguard/lumen` 签名**签发**用 `deriveSecretHex(KL.*_SIGN)`；**校验**接受 [派生子密钥, DB 旧值, `*_PREV`]。撤旧留独立 TODO（客户端发版后）。

### 阶段 E：测试与验证（CI 为准）
- [ ] E1 单测：`deriveKey` 确定性 + 域分隔（不同标签不同）。
- [ ] E2 单测：旧密钥 fixture 解密 → 新键重加密 → 再解密一致（各集合）。
- [ ] E3 单测：迁移 runner 幂等（跑两遍第二遍 processed 增量为 0）、跳错不中断。
- [ ] E4 现有 `bilibiliCookieReport.test.ts`/`bilibiliAccountService.test.ts`/`bilibiliSyncService.test.ts` 全绿（`tests/setup.ts` 需补 `AES_KEY` 默认值）。
- [ ] E5 type-check / governance / 前端构建全绿（禁本地构建，推 CI 判定，见 methodology §五）。

---

## 7. 兼容性与影响
- **一次性全体登出**（JWT 折入）—— 已确认。
- **A′ 若纳入（D-1(b)）→ 客户端需同步发版**，否则签名失败。默认 (a) 不影响客户端。
- **迁移期不可用**（分钟级，取决于密文行数）：期间显示进度页。
- **旧导出/历史 consent** 等「离线/历史校验值」类：改 salt/短链 key 需单独宽限或迁移（D-2、B5 标注）。

## 8. 回滚
1. **迁移前 `mongodump` 全量备份**（前置硬要求）。
2. 迁移中断：`phase` 未 `done`，重启后**从断点续跑**（幂等），无需回滚。
3. 需回退到旧多密钥方案：恢复代码 + `mongorestore` 备份；**切勿**在已重加密后的库上跑旧代码（旧代码无新键、解不开 v2 密文）。
4. 保留旧密钥（env + DB 运行时配置）直到线上确认迁移成功、观察期过后再清理。

---

## 9. 附：为什么不做「裸重定向」（方案 A）
所有内部密钥直接 `= AES_KEY` 会导致：同一份密钥同时用于 JWT 的 HMAC、AES-GCM 加密、各类签名 —— 跨算法/跨用途裸复用是明确的密码学反模式（一处泄露/侧信道波及全部）。派生子密钥在「只管一个 `AES_KEY`」的运维体验完全相同的前提下消除该风险，故采用方案 B（用户已确认）。
