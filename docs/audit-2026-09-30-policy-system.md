# 政策（Policy）体系全面优化 — 审查与改动清单

> 依据 `F:\Repositories\GitHub\verified-methodology.md`（阶段 1 只做静态审查、禁本地构建/测试，最终以 CI 为准）。
> 范围：`src/config/policyDocument.ts`、`src/services/policyConsentService.ts`、`src/models/policyConsentModel.ts`、
> `src/controllers/policyController.ts`、`src/routes/policyRoutes.ts`、`src/controllers/admin/policyConsentLogController.ts`、
> `src/routes/admin/policyConsents.ts` 与 `frontend/src/{api,types,utils,components}` 下政策相关文件。
> 基线：`main`（HEAD `254ab5eb`，工作树干净）。审查方式：逐文件通读 + 调用链 grep，未运行任何构建/测试。

## 一、结论摘要

政策链路的**安全骨架是扎实的**（设备凭据 cookie 而非登录会话、服务端签名 checksum、TTL 回收、条文单点维护 + 契约测试）。
本轮发现的问题集中在三类：**留痕丢失（写库字段不在 schema 里）**、**输入/边界未收敛**、**用户端与管理端的信息完整性与可操作性问题**。
每条编号在下方「三、改动去向」里都能指回具体提交。

## 二、发现清单

| 编号 | 严重度 | 位置 | 类型 | 状态 |
|---|---|---|---|---|
| P-01 | 中 | `src/controllers/policyController.ts` revoke | 留痕丢失（字段不在 schema，Mongoose strict 静默丢弃） | ✅ 已修 |
| P-02 | 低 | `src/services/policyConsentService.ts:16` | 环境变量未收敛（`NaN` → 500 + TTL 失效） | ✅ 已修 |
| P-03 | 低 | `src/services/policyConsentService.ts:174` | 死代码分支 + 有效性不校验勾选项完整性 | ✅ 已修 |
| P-04 | 中 | `src/routes/policyRoutes.ts` `/check` | 设备指纹进 URL / 访问日志 | ✅ 已修 |
| P-05 | 低 | `src/controllers/policyController.ts` 多处 `logger.info` | 日志写入完整指纹与 IP | ✅ 已修 |
| P-06 | 低 | `src/controllers/policyController.ts` revoke | 「无有效同意」与「撤回成功」返回同形 | ✅ 已修 |
| P-07 | 低 | `src/config/policyDocument.ts` | 无条文指纹，无法证明同意的是哪份文本 | ✅ 已修 |
| P-08 | 低 | `src/controllers/policyController.ts` 凭据 cookie | HMAC 不含签发时间/有效期 | ✅ 已修 |
| P-09 | 低 | `/api/policy/admin/stats` | 与 superadmin 面板口径漂移（无来源分布/已撤销计数） | ✅ 已修 |
| P-10 | UX | `frontend/src/api/policy.ts` | 需两次请求（version + check）才能拿到状态 | ✅ 已修 |
| P-11 | 合规 | `/api/policy/revoke` | 同意记录缺自助硬删除路径（只有软置无效 + 30 天 TTL） | ✅ 已修 |
| P-12 | UX | 管理端 `policyConsentLogController` | 无日期范围/勾选不完整筛选、趋势固定 7 天、无导出 | ✅ 已修 |
| P-13 | UX | `frontend/src/components/PolicyPage.tsx` | 14 章正文无站内搜索 | ✅ 已修 |
| P-14 | UX | 同上 | 无字号控制、打印样式零散 | ✅ 已修 |
| P-15 | UX | `PolicyConsentChecklist.tsx` | 勾选项只有一句 label，看不到要点 | ✅ 已修 |
| P-16 | UX | `PrivacyConsentPanel.tsx` | 不显示同意时间/来源/勾选项，无「撤回并删除」 | ✅ 已修 |
| P-17 | UX | `PolicyPage.tsx` | 不显示本设备同意状态 | ✅ 已修 |
| P-18 | UX | `PolicyPage.tsx` | 不展示条文指纹，无法与同意记录对账 | ✅ 已修 |
| P-19 | UX | `frontend/src/components/admin/PolicyConsentPanel.tsx` | 无日期筛选/导出/撤回列 | ✅ 已修 |
| P-20 | 可维护性 | `frontend/src/utils/policyConsent.ts` | 清单在前端第二处硬编码，登录页/TTS 面板各取一 次条文 | ✅ 已修 |

### P-01 — 撤回同意的时间与 IP 从未落库（中）

- **位置**：`src/controllers/policyController.ts` `revokePolicyConsent`
  ```ts
  const result = await PolicyConsent.updateMany(queryFilter, {
    isValid: false,
    revokedAt: new Date(),
    revokedIP: clientIP,
  });
  ```
- **类型**：留痕丢失。`revokedAt` / `revokedIP` 不在 `policyConsentSchema` 里，Mongoose 默认 `strict: true`
  会**静默丢弃**未知路径（不报错、不改 `modifiedCount` 语义），于是撤回动作在库里的唯一痕迹是 `isValid:false`。
- **后果**：管理面板无法区分「用户主动撤回」与「自然过期 / 被新版本顶替」；合规问询「谁在何时从哪个 IP 撤回」无从回答。
- **改法**：schema 增加 `revokedAt` / `revokedIP` / `revokedReason`，面板与导出展示；同时给 `{source, recordedAt}` 补索引。

### P-02 — `POLICY_CONSENT_VALIDITY_DAYS` 未做数值收敛（低）

- **位置**：`src/services/policyConsentService.ts:16`
  `export const CONSENT_VALIDITY_DAYS = Number(process.env.POLICY_CONSENT_VALIDITY_DAYS || 30);`
- **类型**：环境变量解析。`abc` → `NaN` → `new Date(NaN)` → Mongoose 校验失败 → `writePolicyConsent` 返回 null
  → `POST /api/policy/verify` 恒 500 `RECORD_FAILED`；同时 `res.cookie(maxAge: NaN)` 与 TTL 索引都失去意义。
- **改法**：抽出纯函数 `resolveConsentValidityDays(raw)`，非有限值/越界一律回落到 30，并限制在 `[1, 3650]`。

### P-03 — 有效性判定里的不可达分支与勾选完整性缺口（低）

- **位置**：`src/services/policyConsentService.ts` `hasValidPolicyConsent`
- **类型**：死代码 + 完整性缺口。`findValidConsent` 已经带 `expiresAt: { $gt: new Date() }`，
  因此 `consent.isExpired()` 永远为 false；反过来，早期写入（`agreements` 字段尚未引入）的记录虽然版本号等于当前版本，
  却没有覆盖四份必读文件，门禁照样放行。
- **改法**：删掉不可达分支；新增 `isCompleteAgreementSet()`，有效记录必须覆盖当前版本要求的全部文件键，
  不完整视为「需重新同意」（并在管理面板以「勾选不完整」筛选暴露存量）。

### P-04 — 指纹出现在 URL 查询串里（中）

- **位置**：`GET /api/policy/check?fingerprint=…` + 前端 `checkPolicyConsent`
- **类型**：隐私/日志。设备指纹在本系统里就是设备凭据本体（同意 cookie 是它的 HMAC），放进 query 会同时落到
  访问日志、代理日志与 `Referer`。
- **改法**：后端优先读 `X-Fingerprint` 请求头（query 仍兼容），前端只发请求头；新增的 `GET /api/policy/status` 只用请求头。

### P-05 — 同意相关 info 日志直写完整指纹（低）

- **改法**：日志改用 `describeFingerprintForLog()`（前 6 位 + 长度）与 `hashText` 形制的短标识，保留可定位性、去掉可回放性。

### P-06 — 撤回在「本来就无有效同意」时也报成功（低）

- **改法**：响应加 `hadActiveConsent` / `purged`，前端据此区分「已撤回」与「本设备无需撤回」。

### P-07 — 缺少条文指纹（低 → 合规增强）

- **改法**：`policyDocument.ts` 按稳定键序对「章节正文 + 勾选项文案 + 重点提示」做 SHA-256，导出
  `POLICY_DOCUMENT_HASH` 并放进 `document.documentHash`；同意记录落库时一并存 `documentHash`，
  管理面板与用户面板都能对账「这条同意对应哪份文本」。历史区块（revisions/historyNote）刻意不进哈希，
  避免补记修订说明就作废存量同意。

### P-08 — 设备凭据 cookie 的签名不含有效期（低）

- **改法**：新 cookie 形态为 `base64url({f,iat}).hmac`，校验时同时验指纹与 `iat` 年龄（≤ 同意有效期，容忍 5 分钟时钟偏移）；
  **旧的 `fp.sig` 形态继续接受**（重放上限由库中记录自身的 `expiresAt` 兜住），避免升级即让所有设备掉凭据。

### P-09 — `/api/policy/admin/stats` 与只读面板口径漂移（低）

- **改法**：补充 `revokedCount`、`sources` 分布与 `documentHash`，趋势窗口参数化（`days`，1–90）。

### P-10 / P-11 — 缺一次取回的 status 端点与缺硬删除（UX/合规）

- **改法**：新增 `GET /api/policy/status`（一次返回版本 + 有效期 + 条文指纹 + 本设备同意状态/来源/勾选项/时间）；
  `POST /api/policy/revoke` 支持 `purge: true`（硬删除本指纹全部记录并清 cookie），满足「删除」这项用户权利。

### P-12 / P-19 — 管理端可操作性（UX）

- **改法**：逐条记录支持 `from`/`to` 时间范围、`agreementsIncomplete` 完整性筛选、趋势窗口可选、
  新增 CSV 导出端点（superadmin + 审计留痕 + 行数上限），面板补齐撤回列、条文指纹列、指纹复制与导出按钮。

### P-13 ~ P-18 / P-20 — 用户端阅读与知情（UX/可维护性）

- **改法**：政策页加站内搜索（命中计数 + 定位 + 高亮）、字号控制（本地记忆）、本设备同意状态徽标、
  条文指纹展示与复制、打印样式收敛；勾选清单每项内联展开「这份文件的要点」（改由单点条文接口提供）；
  隐私面板补同意时间/来源/勾选项与「撤回并删除记录」；前端清单与文案改为从 API 条文 + 单一映射派生。

## 三、改动去向

| 编号 | 去向 |
|---|---|
| P-01 | `3b013f66` schema 补 revokedAt/revokedIP/revokedReason + 面板撤回列 + 回归用例 |
| P-02 | `3b013f66` policyMeta.resolveConsentValidityDays（纯函数 + 用例） |
| P-03 | `3b013f66` 删不可达分支 + isCompleteAgreementSet 门禁；管理端「仅看勾选不完整」筛选 |
| P-04 | `3b013f66` 后端请求头优先；`ee4bb276` 前端指纹只走 X-Fingerprint |
| P-05 | `3b013f66` describeFingerprintForLog 统一日志短标识 |
| P-06 | `3b013f66` hadActiveConsent / purged；`ee4bb276` 面板区分文案 |
| P-07 | `3b013f66` POLICY_DOCUMENT_HASH + 同意记录 documentHash + ETag |
| P-08 | `3b013f66` base64url({f,iat}).hmac + 判龄；旧形态兼容（有回归用例） |
| P-09 | `3b013f66` admin/stats 补 revokedConsents / sources / documentHash / trendDays |
| P-10 | `3b013f66` GET /api/policy/status；`ee4bb276` 前端单次往返 |
| P-11 | `3b013f66` revoke {purge:true} 硬删除 + 清 cookie |
| P-12 | `3b013f66` 时间范围/完整性筛选、趋势窗口、CSV 导出（审计 + 5000 行封顶） |
| P-13 | `ee4bb276` utils/policySearch + 政策页检索（高亮/目录置灰/空态） |
| P-14 | `ee4bb276` 字号三档 + 打印样式收敛 |
| P-15 | `ee4bb276` 勾选清单内联文件要点（hooks/usePolicyDocument） |
| P-16 | `ee4bb276` 隐私面板同意明细 + 「删除本设备记录」 |
| P-17 | `ee4bb276` 政策页「本设备同意状态」卡片（含就地同意） |
| P-18 | `ee4bb276` 页脚条文指纹展示与复制 |
| P-19 | `ee4bb276` 管理端面板拆分 + 撤回/条文指纹列 + 导出按钮 |
| P-20 | `ee4bb276` 清单文案/标题单一映射 + 条文共享缓存 hook |

无挂起项：P-01 ～ P-20 全部已修。

### 本次新增/变更的接口与页面入口（供后续维护者索引）

- `GET /api/policy/status`（新增，设备凭据门槛）：版本 + 有效期 + 条文指纹 + 本设备同意明细与 reason
- `POST /api/policy/revoke`（扩展）：`purge: true` 硬删除；响应新增 `hadActiveConsent` / `purged`
- `GET /api/policy/check` / `/version` / `/document`（扩展）：指纹可走 `X-Fingerprint`；回带 `documentHash`；document 带 ETag/304
- `GET /api/policy/admin/stats`（扩展）：`revokedConsents` / `sources` / `documentHash` / `trendDays`
- `GET /api/admin/policy-consents`（扩展）：`from`/`to`/`agreementsIncomplete` 筛选 + 撤回与条文指纹字段
- `GET /api/admin/policy-consents/export`（新增，superadmin + 审计）：CSV，5000 行封顶
- 前端：`hooks/usePolicyDocument`、`utils/policySearch`、`components/policy/*`、`components/admin/policy-consent/*`
