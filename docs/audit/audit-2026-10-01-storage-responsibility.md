# 存储职责分配核对：Mongo / Redis / 文件（2026-10-01）

问题（用户）：后端服务的数据库职责是否分配周到——持久性的落到 MongoDB、短期可缓存的用 Redis？

核对方式：通读 `src/models/**`（58 个模型）、`src/services/**` 的存储实现与缓存、`src/middleware/**` 的限流/封禁链路、`src/config/config.ts` 的存储开关，并用新增的 `pnpm run report:storage-responsibility` 把「过期字段 vs TTL 索引」「进程内共享状态」扫成清单。

## 一、结论

**总体分配是周到的，且方向正确**：MongoDB 是唯一主持久层；Redis 只承担「短期 / 需要跨实例共享 / 可重建」的状态，并且在未配置 Redis 时有明确回退；文件只用于运行期目录、音频缓存、日志与降级。既定分工与 `docs/reference/backend-mongo-persistence-detail.md` 一致。

**但有六类例外**，其中没有一类是「持久数据被放进 Redis」这种会造成数据丢失的错配；问题集中在：(a) 若干**进程内**状态承担了跨实例才需要共享的职责；(b) 若干**可丢弃的缓存**放在 Mongo / 磁盘上，靠应用级清理兜底；(c) 同类数据（一次性 nonce / 幂等键）存在两套并行实现。

当前生产是**单实例**部署（`docker-compose.yml` 只有 1 个 app 容器、仅绑定 `127.0.0.1:3000`），所以 (a) 目前不构成线上缺陷，而是**扩容/重启时的前置条件**；一旦起第二实例，下面 S1 各项会立刻变成真问题。

## 二、判定规则（本次核对采用的判据）

| 数据性质 | 应有落点 | 判据 |
| --- | --- | --- |
| 业务实体与需要跨重启/审计的记录（用户、API Key、订单、账单、审计日志、工单、政策同意） | **MongoDB** | 丢了要有事故定级；需要查询/关联/导出 |
| 带期限的凭证与令牌（访问令牌、IP 验证令牌、OAuth 授权码、移动端令牌、临时指纹） | **MongoDB + TTL 索引** | 需要跨重启生效、要能被审计/吊销；到期即删由 TTL 兜底 |
| 短期共享状态（限流计数、一次性 nonce、幂等键、IP 封禁加速、任务锁） | **Redis**（未配置时回退 Mongo/内存，且必须显式记录降级语义） | 可重建；多实例必须看到同一份 |
| 可丢弃的加速缓存（外部 API 结果、配置热值、归属地） | **Redis 优先 / Mongo+TTL 次之 / 进程内 TTL 再次之** | 允许丢失；不参与正确性判定 |
| 运行期产物（音频、日志、上传临时文件、JSONL 缓存） | **文件/对象存储** | 大对象、按目录清理；不是权威数据 |

反向红线：**任何「丢了就是数据丢失」的数据不得只存在 Redis**（Redis 可能被 evict / 未开持久化）。

## 三、核对结果（正面清单）

| 类别 | 现落点 | 判定 | 证据 |
| --- | --- | --- | --- |
| 用户/认证/业务实体 | Mongo | ✅ | `src/services/userService.ts`、`src/models/*`；`USER_STORAGE_MODE` 强制 `mongo` |
| 限流 | Redis → Mongo(`shared_rate_limits`, TTL) → 有界内存 | ✅ | `src/services/sharedRateLimitStore.ts:25`（TTL 索引）、`:315-405` 三级回退 |
| API Key 限流 | 共享后端（Redis），**禁止** Mongo 回退 | ✅ | `src/services/apiKeyRateLimitService.ts:16-19` `requireSharedBackend: true`（7-18 审计里的「进程内 Map」已收口） |
| IP 封禁 | **Mongo 权威** + Redis 镜像，双向同步 5 分钟一轮 | ✅ | `src/models/ipBanModel.ts:27`（TTL）、`src/services/ipBanSyncService.ts:55/204`、`src/middleware/ipBanCheck.ts` |
| 一次性 nonce（主链路） | Redis + Lua 原子消费，内存回退 | ✅ | `src/services/nonceStore.ts:39-50` |
| 人机验证挑战 nonce | Redis（`shc:nonce` 前缀） | ✅ | `src/services/smartHumanCheckService.ts:568-569` |
| 令牌类集合 | Mongo + TTL 索引 | ✅ | accessToken / ipVerificationToken / mobileClientToken / oauth / tempFingerprint / tamperEvent / proxycheckRiskCache / lumen 系列（脚本输出里 `TTL索引=有`） |
| 审计日志 | Mongo + 90 天 TTL | ✅ | `src/models/auditLogModel.ts:100` |
| 配置热值（Turnstile/Cap key、runtime config） | 进程内 TTL 缓存 + 写时失效 | ✅ | `src/services/turnstile/models.ts:14,129`、`src/services/runtimeConfigService.ts:80` |
| LibreChat 会话历史 | Mongo + 文件/内存降级（原子写） | ✅ | `src/services/libreChatService.ts`（`librechat/atomicJsonWriter.ts`） |
| 调度清理 | 进程内定时器（单实例）+ Mongo 侧 TTL | ⚠️ 见 S1 | `src/services/schedulerService.ts:110-116` |

## 四、缺陷与缺口

### S1 进程内状态承担「跨实例共享」职责（P2 · 当前单实例下不是线上缺陷）

- **证据**：
  - ✅ **安全会话与邮箱变更验证码**：已改为自包含 HMAC 令牌 + 共享撤销水位（详下），
    `src/services/profileUpdateVerificationService.ts` + `src/services/sharedStateStore.ts`；
  - `src/services/linuxDoAuthService.ts:101`：`oauthStateStore`（OAuth state / PKCE，容量上限 5000）、`loginTicketStore`；
  - `src/services/accountMergeService.ts:87`：`mergeSessions`（账号合并预览/确认，15 分钟 TTL）；
  - `src/services/clientProbeService.ts`：`probeSessions` / `usedNonces`；
  - `src/services/smartHumanCheckService.ts:526-535`：10 个 abuse 计数 Map（nonce 已在 Redis，计数没有）；
  - `src/services/schedulerService.ts:38`：`isRunning` 重入保护是进程内布尔值，定时清理/双向同步在多实例下会重复执行。
- **症状（多实例时）**：A 实例签发的安全会话在 B 实例 403；OAuth 回调打到另一实例直接 state 无效；账号合并预览消失；abuse 限额被放大 N 倍；清理任务重复跑（幂等但放大 DB 负载，IP 封禁双向同步并发合并时可能互相覆盖）。
- **已完成（安全会话 + 邮箱验证码）**：
  - 令牌自包含：`v2.<base64url(payload)>.<base64url(hmac)>`（密钥由 `JWT_SECRET` 派生独立用途键），
    校验 = 验签 + 时间比较 ⇒ **跨实例、跨重启**都成立，且签发**不需要**任何共享读（保住同步 API，无涟漪）；
  - 撤销：同用户重新建立会话 / 显式结束会话 ⇒ 写共享撤销水位
    （`sharedStateStore` 的 `security-session:revoked:<userId>`、全局 `…:revoked:global`），
    本地保留水位缓存并异步刷新；
  - 邮箱变更验证码与失败计数整体落 `sharedStateStore`（TTL 即过期），不再随实例丢失。
  - **取舍（已在代码注释与本文写出）**：① 跨实例撤销收敛窗口 ≤ 2s（本地水位缓存刷新间隔），
    单实例内是立即生效；② 同一毫秒内为同一用户签发两枚会话时，较早那枚不会被水位覆盖
    （水位严格小于才判失效，否则刚签发的那枚会被自己写下的水位误杀）；
    ③ 部署时在陈的旧版不透明令牌（64 位 hex）全部失效，用户需重新建立会话（TTL 本来只有 10 分钟）。
- **待办**：OAuth state / 登录 ticket、账号合并会话、探针会话与 nonce、人机验证 abuse 计数、
  调度器分布式锁 ⇒ 全部改走 `sharedStateStore`（原语已具备：`set/get/delete/deleteByPrefix/claim/consume`）。
- **建议改法（剩余项）**：逐个把进程内 Map 换成 `sharedStateStore`（调用点本来就是 async）；
  调度器用 `claim()` 做任务锁（TTL 设成预期单轮耗时上界）。
- **去向**：部分已修（S1 的安全会话 + 邮箱验证码），其余挂起。

### S2 可丢弃的缓存放在 Mongo，靠应用级清理兜底（P3 · 可接受但要知其代价）

- **证据**：`proxycheck_risk_cache`（TTL 索引 ✅）、`shared_rate_limits`（Redis 缺失时的回退，TTL ✅）、`github_billing_cache`（`src/services/githubBillingService.ts:232` 只有普通索引，另有 `clearExpiredCache()` 与调度器 `billingCache` 步骤）、`ipqs_monthly_quotas` / `proxycheck_daily_quotas`（计数器）、`proxycheck_lookup_logs`（**刻意不加 TTL**，`:93` 注释）、`proxycheck_probe_reports`。
- **代价**：写放大、备份/落盘膨胀、多一条「清理任务不能停」的隐性依赖；`github_billing_cache` 这类集合若不慎漏跑清理就会无界增长。
- **建议改法**：Redis 可用（`REDIS_URL` 配置）时优先 Redis 承载这些可丢弃数据，Mongo 只留审计所需的持久记录；`github_billing_cache` 若要上 TTL 索引，注意**索引名需另起**（同名同键改 options 会 IndexOptionsConflict，需要先 drop 旧索引），属需要迁移窗口的操作。
- **去向**：挂起（记录判据；不blocking）。

### S3 短期缓存放磁盘且无压缩/上限（P3）

- **证据**：`src/services/ipTelemetryService.ts:11,69-130`：IP 归属地缓存写成 JSONL 追加文件，进程内 Map 为权威，24h TTL 只在**读时**校验；过期行不会从文件里消失，也没有大小上限/压缩任务。
- **症状**：文件随唯一 IP 数单调增长（每行约 120B），长期运行后既占盘又让加载变慢。
- **建议改法**：加载时顺带压紧（丢弃过期行，超过阈值或距上次压紧超过 N 小时时重写一次），或直接把这份缓存交给 Redis（`SETEX`）——它本来就可丢弃。
- **去向**：挂起（已在脚本输出里可见）。

### S4 同类数据两套实现：一次性 nonce / 幂等键（P3）

- **证据**：Redis 侧 `src/services/nonceStore.ts`（Lua 原子申领）；Mongo 侧 `src/models/lumen/ApiNonce.ts:18`（TTL）、`src/models/ecoEnchantsModel.ts:607,623`（`IdempotencyRecord` / `OpsNonce`，TTL）。
- **问题**：同一语义（一次性凭证/幂等）在两种存储里各有一套，清理策略与失败语义不同，容易漏清理或出现「Redis 有、Mongo 没有」的行为差异。
- **建议改法**：统一判据——「只需一次语义、可丢」用 `nonceStore`；「需要跨重启审计的幂等记录」留 Mongo，并在模型文件顶部写清归属理由。
- **去向**：挂起（记录判据）。

### S5 带过期字段但无 TTL 索引：需人工确认的清单（脚本产出）

| 集合 | 过期字段 | 判断 |
| --- | --- | --- |
| `linuxdo_credit_orders` | `expiresAt` | 订单是财务记录 ⇒ **不该**上 TTL（到期是业务语义，不是删除） |
| `entitlements`（lumen） | `expiresAt` | 权益到期同理 ⇒ **不该**上 TTL |
| `VisionStreamSession`（lumen） | `expiresAt` | 短期会话 ⇒ 值得补 TTL 或应用级清理（待 lumen 侧确认） |
| `registration_invites` | `expiresAt` | 邀请码到期；若靠管理端 purge 就够，可维持现状，建议在模型上注明 |
| `login_requests`（lumen`PendingLogin`） | `expiresAt` | 已有 TTL ✅（脚本误判为「无」的情况请以模型文件为准） |

- **去向**：挂起（清单已固化在脚本输出里，后续按行确认）。

### S6 观测缺口（本轮已补）

- 之前没有工具能一眼看出「新加的集合是否有过期语义」「新加的模块级 Map 是不是共享状态」，只能靠人肉 review。本轮补了 `scripts/governance/report-storage-responsibility.js`（`pnpm run report:storage-responsibility`）并挂进 `Quality Guardrails → Governance checks`（**只做可见性，从不失败**，与 `check:tree-shaking-config` 同一档）。

## 五、收尾核对

| 编号 | 去向 | 载体 |
| --- | --- | --- |
| S1 | 挂起（多实例前置条件，改法与代价已写明） | 本文档 §四 S1 |
| S2 | 挂起（判据已固化；涉及索引迁移窗口） | 本文档 §四 S2 |
| S3 | 挂起 | 本文档 §四 S3 |
| S4 | 挂起（判据已固化） | 本文档 §四 S4 |
| S5 | 挂起（逐行确认清单） | `pnpm run report:storage-responsibility` 输出 |
| S6 | 已修 | `scripts/governance/report-storage-responsibility.js`、`package.json`、`.github/workflows/quality-guardrails.yml` |

## 六、验证方式

- 本地不跑构建/测试（方法论 §一-1）。静态核对：`node scripts/governance/report-storage-responsibility.js` 在本地跑通并输出上文引用的清单（纯静态扫描，无依赖、不连库）。
- CI 复验：`Quality Guardrails → Governance checks`（含该 advisory 步骤）、`type-check`、`Node verification`、`CodeQL`、`Docker` 全绿。
