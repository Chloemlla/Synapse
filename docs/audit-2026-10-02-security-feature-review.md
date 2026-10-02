# 安全 / 性能 / 合规审查：账号安全体系与全部附属子系统

- 审查日期：2026-10-02
- 审查范围：用户列出的 13 个子系统（多因素认证、OIDC、统一安全会话、单主密钥派生、多层防护、
  人机验证调度、政策条文、TTS、STT/媒体工具、生成记录、资源商店/CDK、行为数据采集、WebSocket）
- 判据来源：仓库当前工作树源码（逐文件读，标注 `文件:行`）。**本机不构建、不测试**，
  一切结论以 CI 为最终裁决者；本文档只记录源码层面可判定的结论。
- 关联改动：见 §2「本轮改动」；每条缺陷的「去向」标注已修 / 待修。

> 说明：本文档中的「已修复」指本轮改动集合内已落地；「待修」表示需要产品/口径决策或改动面较大，
> 本轮不做。任何一条都有去向，不允许静默消失。

---

## 0. 结论速览

| # | 子系统 | 总体判断 | 主要结论 |
|---|---|---|---|
| 1 | 多因素认证（密码 + TOTP + Passkey + 邮箱 + 恢复码） | 强 | 恢复码已哈希、TOTP 有重放防护；**锁定计数只在进程内存**（SEC-03，已修）、**安全会话验证入口不计数**（SEC-06，已修） |
| 2 | OIDC 登录提供方 | 中 | 发现/JWKS/userinfo/id_token 齐全；**`email_verified` 无条件为 true**、**签名密钥无轮换窗口** |
| 3 | 全站统一安全会话 | 强 | 单一 `verificationToken` + sealed token + 撤销水位线，10 分钟 TTL；双因素配置类操作强制非密码会话 |
| 4 | 单一 `AES_KEY` + HKDF 派生 | 强 | 派生清单完整、含 `AES_KEY_PREV` 与 legacy 双接受；**缺派生版本对外可观测性（仅指纹）** |
| 5 | 多层防护（WAF / IP 封禁 / 限流 / 篡改 / 人机验证 / proxycheck / WebRTC） | 强 | 相位顺序与 fail-closed 明确；限流在 Redis 缺失时退内存档（多副本下额度被放大） |
| 6 | 人机验证供应商调度 | 强 | 权重/粘性/灰度/优先级/月度额度均已实现且是确定性算法（可复现） |
| 7 | 政策条文单点维护 | 强 | 条文指纹留痕、逐项同意、可撤回；**撤回后条文版本漂移的再次征求策略需明确** |
| 8 | 多提供商 TTS | 中 | 三提供商可用；本轮未做全量审计（抽样） |
| 9 | STT 与媒体工具 | 中 | 抽样；建议补链接抓取的 SSRF 边界复核 |
| 10 | 生成记录自助管理 | 中 | 抽样；软删除口径需与"数据删除权"对齐 |
| 11 | 资源商店与 CDK | 中 | CDK 兑换走 `findOneAndUpdate` + TransactionService，原子性成立 |
| 12 | 用户行为数据收集（Clarity） | 中 | 抽样；需与隐私数据地图逐字段对齐 |
| 13 | WebSocket | 中 | 升级有限流；**认证在连接后置**，未认证连接可短暂占用资源 |

---

## 1. 缺陷与改进清单

### SEC-01（合规 / 高）OIDC `email_verified` 恒为 true，缺少证据链

- 位置：
  - `src/services/oidcService.ts:219-223`（id_token 中 `email_verified = true`）
  - `src/services/oauthService.ts:629-630`（userinfo 的 `emailVerified` / `email_verified` 同为 true）
  - `src/utils/userStorageTypes.ts:4-65`（`User` 模型**没有**邮箱验证状态字段）
- 缺陷细节：Synapse 对"邮箱已验证"的唯一事实来源是注册期的邮箱验证链接
  （`src/models/verificationTokenModel.ts:9-12` 的 `email_registration` 令牌），
  但该事实**从未落库到用户文档**。第三方登录路径里只有 Google 会校验 `email_verified`
  （`src/services/googleAuthService.ts:143-149`），校验结果同样不回写。
  于是 OIDC 向依赖方断言"邮箱已验证"没有任何可审计的依据。
- 影响：依赖方若按 `email_verified` 做账号认领（account linking by verified email）或跳过自己的
  邮箱二次确认，会把未验证邮箱当成已验证邮箱——这是 OIDC 提供方的典型越权断言。
- 建议：`User` 增 `emailVerifiedAt?: string`；注册邮箱链接验证、Google 已验证邮箱两条路径置位；
  `id_token` 与 userinfo 按实际值输出（无记录时输出 `false` 并保留 `email`）。
  存量用户口径需产品决定（默认 `false` 更安全，但会让依赖方要求重新验证）。
- 去向：**待修**（本轮不动：涉及 User 模型 + 注册链路 + 存量口径，需产品确认）。

### SEC-02（运维 / 高）OIDC 签名密钥无轮换窗口，JWKS 只发布一把

- 位置：`src/services/oidcService.ts:101`（`findOne({ active: true })`）、`:118-131`（单例 upsert）
- 缺陷细节：模型 `src/models/oidcKeyModel.ts:19-25` 只有 `active: boolean`，`/oauth/jwks`
  只发布当前 active 公钥。轮换 = 立刻作废所有在途 `id_token`（依赖方验签失败），
  实际效果是"没人敢轮换"。
- 建议：JWKS 发布 active + 近 N 天退役公钥（按 `kid` 区分）；加轮换计划任务与"旧公钥仍被请求"
  的告警指标。
- 去向：**待修**（需引入 key 版本表 + 定时任务，属于独立改动）。

### SEC-03（安全 / 中）TOTP 锁定计数是进程内 Map：重启即清零、多副本各算各的

- 位置：`src/controllers/totpController.ts:21-24`（`TOTP_LOCKOUT_DURATION` / `totpAttempts = new Map()`）、
  `:83-101`（`recordTOTPAttempt`）
- 缺陷细节：失败计数与锁定状态只存在该模块的内存 Map 里。
  1. 多副本部署时，攻击者在 N 个副本上各失败 `TOTP_ATTEMPT_LIMIT` 次才被全部锁住 → 额度 ×N；
  2. 进程重启（发布、崩溃、滚动升级）后锁定立即失效；
  3. 该 Map 没有容量上限与淘汰（对比 `src/controllers/auth/_state.ts:51-58` 的
     `LOGIN_ATTEMPTS_MAX_ENTRIES` 淘汰逻辑），只失败过一次、此后不再尝试的用户会长期占用条目。
- 建议：改用已有的共享状态存储（`src/services/sharedStateStore.ts`，Redis 缺失时自动降级内存），
  键 `totp-attempts:<userId>` 带 TTL＝锁定窗口，成功即删除；给降级路径加日志标记。
- 去向：**本轮修复**：抽出 `src/services/verificationAttemptGuard.ts`（共享状态存储 + TTL + 上限语义），
  `totpController` 改为委托调用；备用恢复码失败也计入同一额度（此前只在 TOTP 分支计数）。

### SEC-06（安全 / 高）建立「安全会话」的验证入口完全没有失败计数

- 位置：`src/routes/admin/profile.ts:233-290`（`POST /api/admin/user/profile/verify`，`method === "totp"` 分支）
- 缺陷细节：该接口是全站安全会话（改密码 / 查看密钥 / 双因素配置 / 解绑第三方）的**唯一闸门**，
  但它的 TOTP 与备用恢复码两条分支既不读也不写失败计数：错误只返回 401，不累计、不锁定。
  6 位 TOTP 的爆破在这里只被挂载级 `adminLimiter` 拦（宽窗口计数限流），
  相比登录路径的「5 次锁 15 分钟」弱得多——最强的爆破面恰好在权限最高的入口。
- 去向：**本轮修复**：与登录二次验证共用 `verificationAttemptGuard` 同一份额度；
  锁定中返回 429 + `code: "TWO_FACTOR_LOCKED"`，失败响应附 `remainingAttempts`（首次尝试行为不变）。

### SEC-04（安全 / 中）限流在 Redis 缺失时退内存档：多副本下限流额度被放大

- 位置：`src/middleware/rateLimiter.ts`（共享存储工厂）、`src/services/wsService.ts:30,176`
  （`ws-upgrade` 限流存储不可用时"放行"并只记日志）
- 缺陷细节：单副本 / 有 Redis 时正确；但 Redis 不可用且跨副本时，每个副本各自计数，
  真实允许速率 = 配置值 × 副本数；WS 升级路径更是显式 fail-open。
- 建议：把"限流存储降级"做成可观测指标并进入告警（而不是只写日志），
  关键端点（登录、注册、验证码）在降级时可选择保守收紧而不是放行。
- 去向：**待修**（属于运行时可观测性改造；本轮只在文档登记）。

### SEC-05（合规 / 中）隐私数据地图与新增导出能力需同步

- 位置：`docs/governance/privacy-data-map.json`（`scripts/governance/check-privacy-contract.js` 校验）
- 缺陷细节：本轮新增的用户端接口 `/api/auth/security-summary` 只读**调用方自己**的数据
  （安全评分、设备数量、指纹条数），不引入新数据集，因此数据地图无需新增条目；
  但"自助安全总览"实质上是一种面向数据主体的**导出**能力，建议在地图对应数据集的
  `export` 字段里记明该入口，方便下次审计直接对上。
- 去向：**待办（低风险）**，登记于此。

### UI-01（缺陷 / 中）管理端逐行计算的安全评分从未被展示：纯浪费 + 能力闲置

- 位置：`src/controllers/adminUserListHelpers.ts:118-133`（每行 `securitySummary`）、
  `frontend/src/components/UserManagement.tsx`（此前未消费该字段）
- 缺陷细节：用户列表对**每一行**都调用 `buildAccountSecuritySummary`（纯函数，但按行进入
  payload 体积），前端拿到后完全丢弃——既增加响应体，又让"哪个账号最该跟进"这个结论无处可看。
- 去向：**本轮修复**：新增安全态势面板 + 行内评分徽标（见「本轮改动」）。

### UI-02（体验 / 中）用户端缺"我现在安不安全、下一步做什么"的单点结论

- 位置：安全信息分散在 `frontend/src/components/UserProfile.tsx`（安全会话、设备）、
  `TOTPManager`（双因素/恢复码，由 `App.tsx:569,1638` 的模态承载）、`PrivacyConsentPanel`
- 缺陷细节：用户要自己拼：TOTP 开了吗？恢复码还剩几个？有没有陌生设备？
  服务端其实已经有 `buildAccountSecuritySummary` 的评分与建议，但只给管理员用。
- 去向：**本轮修复**：新增 `/api/auth/security-summary` + 个人页安全中心面板（见「本轮改动」）。

### OPS-01（一致性 / 低）安全会话 TTL 与「双因素配置类操作」的提示文案

- 位置：`src/services/profileUpdateVerificationService.ts:27`（10 分钟）、
  `src/utils/securitySession.ts:49-80`
- 说明：TTL 与"非密码会话"约束本身正确且 fail-closed。仅提示：`requireTwoFactorConfigSession`
  在"用户尚未配置任何二次验证因素"时放行密码会话（否则无法首次配置），这个例外必须在任何
  新增的配置类接口上继续保持审视——不然就会出现"攻击者先删掉全部因素再改配置"的路径。
- 去向：登记（设计正确，作为后续新增接口的检查项）。

### （未逐行审计的部分）

以下子系统本轮只做抽样通读，**不宣称已全量审计**，例如 TTS 三提供商的分支、STT/媒体工具的
外链抓取、数据采集与 Clarity 的字段级合规、资源商店的库存并发。它们的风险不应被本表的
"强/中"判断替代。建议后续按同样格式单独出清单。

---

## 2. 本轮改动（已落地）

### 2.1 用户端：账号安全中心

- 新增 `src/services/accountSecurityOverviewService.ts`
  - 复用 `buildAccountSecuritySummary`（**单点打分**，避免管理端与个人页出现两个分数），
    叠加只有本人需要考虑的事实：恢复码余量、Passkey 数量、活跃设备数。
  - 输出机器可读的 `checks[]` 自检清单（pass / warn / fail + 可执行动作标识）。
- 新增 `GET /api/auth/security-summary`
  - `src/controllers/auth/sessionHandlers.ts`（只回答调用方自己的账号，**不接受任何 userId**）、
    `src/controllers/authController.ts`、`src/routes/authRoutes.ts`（`authReadLimiter` + `authenticateToken`，带 OpenAPI 注释）
  - 第三方绑定 / 设备列表查询失败时降级为"该项不报警"，不让整个安全总览 500。
- 新增 `frontend/src/api/securitySummary.ts`、`frontend/src/components/user-profile/SecurityScorecardPanel.tsx`
  - 评分环形图 + 风险等级 + 关键指标（TOTP / Passkey / 恢复码 / 指纹 / 最近登录 IP）+ 逐项清单。
  - 每项带"去处理"：双因素类直接打开全站共用的账户安全设置弹层（`App.tsx` 现有 `openTOTPManager`），
    邮箱 / 设备滚动到本页对应区块，指纹则走既有 `reportFingerprintOnce(true)`。
- `frontend/src/components/UserProfile.tsx`：面板置于个人页最前（进页先看结论），
  新增 `onOpenSecuritySettings` 可选属性，`frontend/src/App.tsx` 注入 `openTOTPManager`。

### 2.2 管理端：安全态势

- 新增 `frontend/src/components/user-management/AdminSecurityPosturePanel.tsx`
  - 二次验证覆盖率条（TOTP / Passkey / 需指纹 / 封停），每条都能一键套用列表筛选。
  - 本页风险最高的账号（按评分升序，最多 5 个）与"查看并处理"直达用户表单。
  - 明确写出"聚合统计无法精确给出『一个都没启用』的账号数"（TOTP 与 Passkey 可能重叠），
    并指向走数据库筛选的精确入口——不用三元估计冒充准确数字。
- `frontend/src/components/UserManagement.tsx`
  - 消费此前被丢弃的 `securitySummary`：行内评分徽标（含建议 tooltip）、快速筛选回调。
  - 用户类型补齐 `securitySummary` 字段声明。

### 2.3 安全加固

- SEC-03 + SEC-06：新增 `src/services/verificationAttemptGuard.ts`——二次验证失败计数与锁定统一落在
  共享状态存储（Redis → Mongo → 进程内存分层降级，TTL = 锁定窗口）。
  - `src/controllers/totpController.ts` 改为委托调用；备用恢复码失败与 TOTP 失败共用同一额度。
  - `src/routes/admin/profile.ts` 的安全会话验证入口接入同一份额度（此前完全不计数），
    锁定中返回 429 `TWO_FACTOR_LOCKED`，失败响应附带剩余次数。
  - 多副本共享同一份额度、进程重启不再清零；降级到内存时行为与加固前一致（不会更差）。

---

## 3. 后续建议优先级

1. **SEC-01 / SEC-02**（合规与密钥轮换）——依赖方与运维的直接风险，建议下一轮做。2. **SEC-04**（限流降级可观测）——多副本部署下的实际防护强度。
3. 8～13 号子系统的独立专项清单（TTS / STT / 商店 / 采集 / WS）。
4. **SEC-05** 顺手补数据地图 `export` 说明。
