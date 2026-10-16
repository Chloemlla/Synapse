# Pixel 集成：运维、上线开关与回滚

> 适用对象：运维与超级管理员。
> 记录本文时的实现状态：代码已落地但**尚未跑过 CI**，未在任何环境启用上游。

## 1. 这个功能连的是什么

Pixel 是 GGGGGG 来源仓库的「自助折扣链接任务」能力，在 Synapse 里被重新实现为：

- 用户侧 `/pixel`（仅登录用户）→ `/api/pixel/*`
- 管理侧 `/admin/pixel`（页面 key `pixel`）→ `/api/admin/pixel/*`
- 上游：**一个**由超级管理员在运行时配置的 HTTPS 服务，通过固定「方法 + 路径」白名单访问

**上游授权尚未核实**（见第 6 节）。在此之前，任何环境都不应把上游地址配置成真实供应商。

## 2. 上线开关

| 开关 | 位置 | 效果 |
|---|---|---|
| 上游启用 | `/admin/pixel` → 集成配置 → 「启用该上游」 | 关闭后 `loadPixelIntegrationConfig()` 返回 null，**所有**上游操作 fail-closed（503 `PIXEL_UPSTREAM_NOT_CONFIGURED`），一个字节都不发出去 |
| 上游未配置 | 同上（地址/主机清单为空） | 与「关闭」等价，且没有任何默认地址可回落 |
| 服务类型开关 | 上游 `/api/settings` 的开关（`autoBindEnabled` / `autoBindOneDollarEnabled`） | 前端不可选被关闭的类型；后端在提交前也会拒绝 |
| 前端入口 | `frontend/src/navigation/navConfig.ts` 的「Pixel 自助折扣」项 + `frontend/src/App.tsx` 的 `/pixel` 路由 | 摘掉入口/路由即可对用户隐藏（**这只是界面控制，权限边界在服务端**） |

## 3. 数据与索引

| 集合 | 用途 | 索引 / TTL | 回滚注意 |
|---|---|---|---|
| `pixel_cdk_mappings` | 分发卡密 ↔ 上游卡密映射 | 唯一 `distributionCdkHash`；`createdAt`、`enabled+createdAt` | 回滚代码后数据仍可读；**不要**在回滚时删除，否则历史任务无法再解释额度来源 |
| `pixel_task_access` | 任务归属（谁提交了哪个上游任务） | 唯一 `userId+idempotencyKey`；`userId+createdAt`；`userId+upstreamTaskId`；`userId+distributionCdkHash+createdAt` | 同上；软删除标记 `subjectDeletedAt` |
| `pixel_usage_logs` | 脱敏溯源 | `createdAt` TTL（默认 30 天，`PIXEL_USAGE_LOG_RETENTION_DAYS`）；`mappingId+createdAt`；`userId+createdAt` | 纯遥测，回滚时可整表删除而不影响业务 |
| `pixel_integration_configs` | 上游地址/主机清单/超时/开关 | 唯一 `key` | **回滚时务必先关闭 `enabled`**，再考虑删除配置 |
| `pixel_evidence_holds` | 法律保全快照 | `purgeAfter` TTL（保全中为 null ⇒ 永不自动清理） | 保全中**不要**删；解除后 30 天自动回收 |
| `pixel_evidence_approvals` | 内容级取证审批单 | `expiresAt` TTL（+180 天） | 合规凭证，随案件生命周期保留 |
| `pixel_evidence` | 内容级取证（加密） | `expiresAt` TTL（≤ 30 天） | 独立子密钥加密；删库前确认没有待回应的法律程序 |

TTL 的注意点：MongoDB 的 TTL 索引**只在建索引时读取 `expireAfterSeconds`**，
所以调整保留天数（`PIXEL_USAGE_LOG_RETENTION_DAYS`）后，需要重建索引才会生效。
当前生效值与取数口径在 `/admin/pixel` 的「保留策略」卡片里随总览一起显示（`usage.retentionDays`），
改了环境变量但没重建索引时，界面显示的是**新值**、实际过期仍按旧索引 —— 这一点在卡片文案里已写明。

> 保全为何是「快照」而不是「给主表加 held 标记」：`pixel_usage_logs` 靠 TTL 按 `createdAt` 自动过期，
> TTL 是索引的物理行为，加标记拦不住它。快照集合的 `purgeAfter` 在保全期间为 `null`，
> 因此证据必然留得住；账号注销路径也会先查 legal hold，命中就跳过物理删除（`purgePixelTelemetryUnlessHeld`）。

## 4. 两种回滚路径

**A. 只回滚代码，保留数据（推荐）**

1. 在 `/admin/pixel` 把「启用该上游」关掉 → 所有任务接口立即 fail-closed；
2. 回退前端入口（`navConfig.ts` / `App.tsx`）与后端路由模块注册；
3. 数据留在库里，之后重新上线即可继续用。

**B. 彻底清库（只在确认不再启用时做）**

```js
// 顺序：先停上游，再清遥测，最后清归属与映射
db.pixel_usage_logs.deleteMany({})
db.pixel_task_access.deleteMany({})
db.pixel_cdk_mappings.deleteMany({})
db.pixel_integration_configs.deleteMany({})
```

清理前先导出一份 `pixel_cdk_mappings`（**注意：上游卡密字段是密文，无法离线解密后复用**），
否则重新上线需要管理员重新录入映射。

## 5. 密钥与凭据

- 上游卡密使用平台主密钥派生的 AES-GCM 加密存储（字段：`upstreamCdkCiphertext` / `upstreamCdkIv` /
  `upstreamCdkTag` / `upstreamCdkCryptoVersion`），接口只返回遮罩值。
- 分发卡密只存哈希与遮罩；明文只在创建成功的那一次响应里出现。
- 用户提交的账号邮箱/密码/辅助邮箱/2FA 秘钥**不落库**：只在请求处理内存与上游请求体里存在。
- 待办（依据不足，未成文流程）：
  - 主密钥轮换后如何批量重加密既有映射（当前 `upstreamCdkCryptoVersion` 已预留字段，但**重加密脚本尚未实现**）；
  - 旧密文迁移演练未做。
  **不要**在未验证前手工改写这些字段，否则映射会变成不可读。

## 6. 故障语义

| 情况 | 系统行为 | 运维判断 |
|---|---|---|
| 上游未配置 / 已关闭 | 503，用户看到「该服务当前不可用」 | 预期行为，不是故障 |
| 地址不在允许主机清单 | 502 `PIXEL_UPSTREAM_TARGET_BLOCKED` | 检查集成配置的主机清单（保存与出站各校验一次） |
| 解析到内网/环回地址 | 同上拒绝 | 防 SSRF 与 DNS rebinding，属预期 |
| 上游 3xx | 502，拒绝跟随重定向 | 上游改了跳转策略；allowlist 不允许跟随 |
| 上游超时 | 504 `PIXEL_UPSTREAM_TIMEOUT` | 提交语义为「**结果不确定**」：用户不该重试 |
| 上游 5xx / 连接失败 | 502 `PIXEL_UPSTREAM_UNREACHABLE` | 同上 |
| Mongo 不可用 | 500 通用文案 | 检查数据库；账号凭据从不依赖 Mongo 写入 |
| 用户撤回同意 | 403 | 门禁 key `pixel-tasks`（`terms` + `specific-terms`） |

日志里只有分类信息（路由名、方法、可选路径、是否超时、错误类型），**没有**上游 host、URL、
请求体、响应正文与账号内容。

## 7. 权限与审计

- 读接口：`admin` 角色 + `adminScope` 页面授权（页面 key `pixel`，apiPrefixes `/api/admin/pixel`）。
  未登记的权限前缀一律 fail-closed。
- 写接口（创建/删除映射、保存集成配置）：**仅超级管理员**。
- 审计：创建映射只记「有无备注、是否启用」；保存配置只记「是否启用、主机数量」。
  创建映射的响应里包含一次性分发卡密明文，因此该路由**刻意不使用**会把响应体写进审计的通用审计中间件。

## 8. 未决事项与阻断项

1. **上游授权与正式 API 未核实**：`GGGGGG/docs/openapi.yaml` 自述为「从公开页面重建的草案」。
   当前适配器的 7 条端点与字段解析都按草案实现且全部容错；在拿到供应商确认前不要启用。
2. **GGGGGG 源码许可**：来源仓库未附许可证，因此本实现是**按行为重新实现**，未复制其源码。
3. 运行时配置尚未并入 `runtimeConfigService`：当前独立集合 `pixel_integration_configs`，
   待并入时把 `integrationConfigService` 换成运行时配置的一个分组即可，调用方只认
   `loadPixelIntegrationConfig()`。
4. 密钥轮换/重加密流程未实现（见第 5 节）。

## 9. 法律保全与内容级取证（收到法律程序时怎么做）

### 9.1 先想清楚两条通道的差别

| 通道 | 拿到什么 | 前提 | 适用 |
|---|---|---|---|
| **法律保全**（`pixel_evidence_holds`） | 当时**已经存在**的数据快照：任务归属 + 脱敏溯源（遮罩卡密、账号数、上游状态、耗时） | 案件编号 + 法律依据（必填） | 默认就该走这条：账号内容本来不存在，保全不会凭空产生它 |
| **内容级取证**（`pixel_evidence`） | 这次提交的**账号内容**（加密） | 先有个案**审批单**（含法律依据与有效期，≤ 30 天） | 只有在确有法律依据要求提供内容时才开启 |

两条通道都会写审计：谁、什么时候、凭哪个案件编号、对哪个账号、做了什么。

### 9.2 操作（`/admin/pixel` → 「法律保全与取证」，均需超级管理员）

```bash
# 1) 登记保全（冻结删除 + 立即快照）
#    → 该账号此后不会被物理清理（含账号注销路径）
POST /api/admin/pixel/legal-holds
{ "userId": "<uid>", "caseRef": "CASE-2026-001", "legalBasis": "调取证据通知书 <编号>", "reason": "备查" }

# 2) 解除保全（快照再保留 30 天后自动回收；可用 purgeDelayDays 调整）
POST /api/admin/pixel/legal-holds/<holdId>/release
{ "releaseReason": "case closed", "purgeDelayDays": 30 }

# 3) 需要内容时先开审批（限定账号 + 有效期），之后的提交才会被加密留存
POST /api/admin/pixel/evidence-approvals
{ "userId": "<uid>", "caseRef": "CASE-2026-001", "legalBasis": "调取证据通知书 <编号>", "validDays": 7 }

# 4) 读取内容：必须带上与记录一致的条件编号；每一次读取都进审计
POST /api/admin/pixel/evidence/<evidenceId>/read
{ "caseRef": "CASE-2026-001" }

# 5) 撤销审批（已留存内容仍按各自的到期时间回收）
POST /api/admin/pixel/evidence-approvals/<approvalId>/revoke
{ "reason": "case closed" }
```

### 9.3 必须先满足的前提（不是可选项）

1. **已在隐私说明中披露**：账号内容留存的唯一例外情形写进了 `privacy-data-map.json`
   （`pixel-account-evidence` 数据集），提交页与操作提示也向用户说明「在 X 情形下留存 Y 天」。
   没有这条披露就不要开启取证 —— 那就不再是「合规取证」，而是未告知收集。
2. **限定期限**：留存上限 30 天且不超过审批有效期；到期由 TTL 自动删除。
3. **可追责**：读取只允许超级管理员，且每次读取写审计（含案件编号、经办人、证据 id、
   账号数与字节数）；案件编号不匹配一律拒绝返回内容。
4. **不截断**：单条超过 256 KiB 时整条不留（截断的凭据等于伪造证据），管理员需分批或另议。

### 9.4 密钥与风险

- 取证内容用**独立子密钥**（HKDF label `pixel-account-evidence-v1`）+ AES-256-GCM，
  AAD 绑定版本，跨用途重放会解密失败；与「上游卡密」那把子密钥互不影响。
- **未实现**：主密钥轮换后的批量重加密。轮换前必须先把待回应的法律程序处理完，
  否则旧密文可能无法解密（`decryptPixelEvidence` 会直接报错，而不是回退明文）。
- 检查清单：确认没有保全中的账号、没有生效审批、没有未到期的取证记录，再动主密钥。
