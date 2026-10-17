# 管理端账户数据导出与注销落位（用户管理页）

> 日期：2026-10-17
> 范围：`frontend/src/components/UserManagement.tsx` 及其子组件；后端
> `/api/admin/users/:id/data-summary`、`/api/admin/users/:id/export`、`/api/admin/users/export`。
> 约束：遵守 `CLAUDE.md` / `AGENTS.md` / `verified-methodology.md`；**未在本地构建或运行测试**，
> 静态闸门与 GitHub Actions 为唯一裁判。

## 1. 背景

用户与法务此前只能通过支持邮箱申请账户数据副本或注销；管理端只有「删除」，没有任何数据导出能力。
隐私数据地图里 `user-fingerprints.export.surface` 早已写着「admin user export」，但实现并不存在。
本轮把这两件事收敛到用户管理页：

- 普通用户仍然**没有**自助导出 / 自助注销入口（按需求不做）；
- 超级管理员可以在用户列表里打开「数据」弹窗：查看该账号实际存了哪些数据、导出脱敏 JSON、注销账号；
- 批量导出所选账号（最多 10 个）。

## 2. 后端

| 端点 | 权限 | 说明 |
| --- | --- | --- |
| `GET /api/admin/users/:id/data-summary` | 超管 | 只统计每个数据集的条数，不读正文 |
| `GET /api/admin/users/:id/export` | 超管 + 安全会话 | 单账号完整数据 JSON（已脱敏） |
| `POST /api/admin/users/export` | 超管 + 安全会话 | 最多 10 个账号的批量导出 |

审计：`user.dataSummary` / `user.dataExport` / `user.dataExportBulk`，只记目标与规模，不记正文。

实现：

- `src/services/accountDataExportService.ts`
  - 显式登记 34 个高价值数据集（账号资料、会话、API Key 元数据、工单、TTS、GeoGebra、Pixel、
    数据采集、审计、短链、兑换、抽奖、OAuth 等）；
  - 自动纳入 `USER_CASCADE_COLLECTIONS`（注销级联清单）中其余账号归属集合，避免新功能上线后
    导出悄悄漏项；
  - 隐私数据地图标注 `export.supported=false` 的数据集列入 `omitted` 并附原因；
  - 每个数据集有行数上限，超出标注 `truncated`；单次导出上限 20MB，超过直接拒绝（不静默截断）。
- 脱敏规则：键名包含 password / secret / token / credential / ciphertext / privateKey / apiKey /
  keyHash / cdkHash，或精确命中 `iv`、`tag`、`storageKey`、`rawResponse`、`backupCodes`、
  `pendingChallenge`、`currentChallenge`、`passkeyVerified` 的字段替换为 `[redacted]`；
  二进制正文替换为 `{ redacted: true, type: "binary" }`；日期转 ISO，ObjectId 转十六进制。
- 路由：`src/routes/admin/userData.ts`，控制器 `src/controllers/adminUserDataController.ts`。

## 3. 数据地图与政策页

- `docs/governance/privacy-data-map.json`：
  - 新增 `auth-sessions`（登录会话与设备）与 `api-keys`（API Key）两个数据集；
  - `user-fingerprints` / `tickets` / `tts-jobs` / `policy-consents` 的 `export.surface`
    补上管理端导出端点；
  - `notes` 增加 2026-10-17 变更记录。
- `src/generated/privacyDataMap.ts` 由 `pnpm run generate:privacy-data-map` 重新生成（48 个数据集）。
- 政策页因此自动多出「登录会话与设备」「API Key」两条数据说明，无需另写文案。

## 4. 前端

- `frontend/src/api/adminUserData.ts`：摘要、单账号导出、批量导出、blob 错误文案提取。
- `frontend/src/components/user-management/UserDataDialog.tsx`：
  - 账号标识、数据量概览（按数量排序）、无记录数据集折叠、按契约不导出的数据集与原因折叠；
  - 导出区：安全会话未建立时就地展示 `EstablishSecuritySession`，建立后出现「导出 JSON」；
  - 注销区：写清后果（撤销会话、禁用 API Key、清除凭据、写身份墓碑、数据按保留策略留存），
    危险确认后调用既有 `DELETE /api/admin/users/:id`。
- `frontend/src/components/user-management/UserBulkExportControl.tsx`：批量导出按钮 + 就地验证卡。
- `UserManagement.tsx`：
  - 行操作新增「数据」按钮（`FaDatabase`）；
  - 批量区新增「导出所选数据」；
  - 删除按钮保留（快速路径），弹窗内的注销与之共用后端软删除语义。

## 5. 测试

`src/tests/accountDataExport.test.ts`：

- 脱敏：密码/令牌/密钥/密文/存储键被替换，`sha256`/`checksum`/`documentHash` 保留，日期与二进制处理正确；
- 契约一致：隐私数据地图里所有可导出的账号数据都被注册表覆盖；标注不可导出的都在 `omitted` 里且有原因；
- 注销级联清单中的集合要么被导出、要么明确排除；
- 批量上限与前端口径一致（10）。

## 6. 静态验证

- `check:privacy-contract`：通过（48 个数据集）；
- `check:privacy-data-map`：生成物已同步；
- `check:frontend-design-language`：通过，无新增违规；
- `check:ts-file-size`：`UserManagement.tsx` 1478 行（< 1500），新文件均远低于上限；
- `check:audit-policies`：通过。

## 7. 补充：MongoDB 在库数据浏览器（/admin/system）

仿照 Redis 在库数据浏览器（`frontend/src/components/admin/RedisDataBrowser.tsx` +
`src/routes/admin/system.ts` + `src/services/redisAdminService.ts`）新增 MongoDB 版本：

| 端点 | 权限 | 说明 |
| --- | --- | --- |
| `GET /api/admin/system/mongo/overview` | 超管 + 安全会话 | 连接、库名、集合数、估算文档数、数据/索引体积 |
| `GET /api/admin/system/mongo/collections` | 超管 + 安全会话 | 集合清单与估算条数（只读元数据） |
| `GET /api/admin/system/mongo/collections/:name/documents` | 超管 + 安全会话 | 分页读文档，支持受限 JSON 过滤与排序 |
| `GET /api/admin/system/mongo/collections/:name/detail` | 超管 + 安全会话 | 索引与集合选项（不返回 validator 正文） |
| `GET /api/admin/system/mongo/export` | 超管 + 安全会话 | NDJSON 流导出（头信息 / 文档 / 汇总） |

要点：

- **脱敏可选**：默认原样返回（该端点已强制超管 + 安全会话，即管理员当场验过一次身份）；
  传 `redact=1` 时按账户导出同一套规则把密码材料、令牌、密钥、密文与内部存储键替换为 `[redacted]`。
  前端在浏览器面板提供「脱敏显示」开关，未脱敏时明确标注「原始数据」并提示截图前先脱敏。
- **过滤条件受限**：只接受 JSON 对象，拒绝 `$where` / `$function` / `$accumulator`（服务端脚本执行），
  嵌套超过 8 层直接拒绝；排序字段只允许 `[A-Za-z0-9_.]`。
- **分页有硬上限**：每页 ≤100、页码 ≤200，避免 `skip` 深页退化成全表扫描；超限时提示改用过滤条件。
- **审计只记元数据**：集合名、页码、返回条数、是否脱敏、导出条数；不记过滤条件正文与文档内容。
- **BSON 归一**：ObjectId / Long / Decimal128 / Timestamp / Binary 等先转成 JSON 安全形状，
  二进制正文只报大小（不脱敏时也一样）。

## 8. 已知边界

- 工单附件正文、Pixel 取证材料、法律保留与取证日志不在账号导出内（按契约走各自的下载 / 取证通道），
  导出文件会列出原因；
- 导出是同步请求，超大账号可能触发 20MB 上限并收到 413；后续如需要可改为异步任务队列；
- 批量导出不包含「批量注销」：注销仍按单账号执行，避免一次误操作停用多个账号。
