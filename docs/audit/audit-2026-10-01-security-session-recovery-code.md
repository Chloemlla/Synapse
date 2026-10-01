# 安全会话：TOTP 验证支持备用恢复码（2026-10-01）

来源：用户工单「修复安全会话 TOTP 验证码不支持使用恢复代码」。

范围：`src/routes/admin/profile.ts`、`src/services/totpService.ts`、`src/controllers/totpController.ts`、前端 `frontend/src/components/EstablishSecuritySession.tsx`、`frontend/src/components/user-profile/profileHelpers.ts`。

## 一、缺陷

### D1 建立安全会话时只认 6 位 TOTP 验证码，恢复码被格式校验挡在门外

- **文件**：`src/routes/admin/profile.ts`（`POST /api/admin/user/profile/verify`，`method === "totp"` 分支）
- **症状**：账号启用了 TOTP 时，用户输入生成双因素时保存的 8 位备用恢复码 → 400 `请输入 6 位 TOTP 验证码`；错误输入的恢复码也只会撞上同一条格式校验，**永远无法用恢复码建立安全会话**。
- **根因**：该分支只有一条路径 `verificationCode`，先按 `/^\d{6}$/` 卡格式再走 `verifyTokenWithCounter`。恢复码（`backupCode`）在登录路径（`src/controllers/totpController.ts` 的 `verifyToken`）与 `TOTPService.verifyBackupCode` 里是另一套校验，验证接口没有接进来。
- **影响**：认证器丢失（换机、卸载、丢设备）时用户彻底失去安全会话 —— 而「配置双因素验证」类操作按设计**拒绝密码建立的会话**（`requireTwoFactorConfigSession`），于是关闭/重配 TOTP、查看恢复码、Passkey 管理等敏感操作全部锁死，恢复码形同虚设。
- **修复**：
  - `POST /user/profile/verify` 的 `totp` 分支支持 `backupCode`（与登录路径同名字段），走同一套校验：格式归一（大写、去非字母数字）→ `TOTPService.verifyBackupCode`（bcrypt 比对，兼容旧明文条目）→ 原子报废用掉的那一枚（`normalizeBackupCodesForStorage` 归一后落库，绝不写回明文或二次哈希）→ 发送「恢复码已使用」安全通知邮件（`checkQuota: false`，不占验证码发送配额）。
  - 建立的会话 `method` 仍是 `totp` —— 恢复码是 TOTP 的离线兜底，因此同样满足「必须非密码会话」的双因素配置要求。
  - 无可用恢复码、恢复码错误、两种输入都为空等情形各自给出可解释的 400/401，且**不消耗任何凭证**、不发通知邮件。
  - `TOTPService.normalizeBackupCodesForStorage()` 提为公开方法（原为 `totpController` 的私有方法），生成/报废/重新生成三条路径共用同一套归一规则，`totpController` 改为委托调用。

### D2 前端没有恢复码入口

- **文件**：`frontend/src/components/EstablishSecuritySession.tsx`（全站统一的安全会话卡片，`UserProfile` / `TOTPManager` / `env-manager` / `CommandManager` 共用）、`frontend/src/components/user-profile/profileHelpers.ts`
- **症状**：TOTP 卡片只有一个 6 位数字输入框（`maxLength={6}`、`\D` 过滤、`/^\d{6}$/` 前置校验），恢复码连字符都输不进去。
- **修复**：TOTP 卡片内置「认证器不可用？改用恢复码」切换：切换后输入 8 位字母数字（自动大写、剥离非字母数字），提示「每个恢复码只能使用一次」，按钮文案随模式变化；`verifyIdentity()` 增加 `backupCode` 字段。成功后两种模式的状态一起清空。

## 二、验证方式

- 本地不跑构建/测试（方法论 §一-1），只做静态检查。
- 新增 `src/tests/securitySessionRecoveryCode.test.ts`（supertest 挂载 `/api/admin/user/profile/verify`）钉住契约：
  1. 恢复码（输入带大小写与分隔符）可建立会话 → 200，且会话 `method === "totp"`（满足双因素配置守卫）；
  2. 用掉的那一枚被报废，剩余恢复码仍以 `$2` 哈希形态落库；
  3. 恢复码被使用时发出安全通知邮件（`checkQuota: false`）；
  4. 恢复码错误 → 401 `恢复码错误`，不改库、不发邮件；
  5. 无可用恢复码 → 400 可解释错误；
  6. 只给垃圾输入 → 400，且不消耗凭证；
  7. 6 位 TOTP 原路径回归：仍走 `verifyTokenWithCounter` + `consumeTotpCounter`（counter 重放防护未被绕过）。
- CI 复验：`type-check`（后端 + 前端）、`Node verification`（Jest）、`Quality Guardrails`、`CodeQL`、`Docker` 全绿。

## 三、收尾核对

| 编号 | 去向 | 载体 |
| --- | --- | --- |
| D1 | 已修 | `src/routes/admin/profile.ts`（含 `TOTPService` 公开归一方法 + `totpController` 委托） |
| D2 | 已修 | 前端 `EstablishSecuritySession.tsx` / `profileHelpers.ts` |
