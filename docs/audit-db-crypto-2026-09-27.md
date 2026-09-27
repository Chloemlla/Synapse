# Synapse 后端数据库层 · 性能 + 密码学安全审查 — 2026-09-27

> 方法论：`verified-methodology.md`（流程/验证）+ `code-audit-methodology.md`（审什么）+
> `security-audit-skills.md` 里的 **performing-cryptographic-audit-of-application**（密码学基元/密钥管理）、
> **implementing-secret-scanning-with-gitleaks**（硬编码密钥）、**implementing-semgrep-for-custom-sast-rules**（NoSQL 注入面）三条 skill 的检查表。
> 审计只读、修复只落最小改动；**未执行本地构建/测试**（方法论硬约束，CI 为唯一裁判）。

## 一、范围与方法

- 目标：后端数据库相关代码——连接层（`services/mongoService.ts`）、57 个 model 的索引/TTL、服务层查询模式（`.find`/`.sort`/`.aggregate`/`insertMany`/`bulkWrite`）、以及落库 PII 的静态加密（密码 / B 站 Cookie / 数据采集原文）。
- 密码学审查按 skill 检查表逐类扫描：弱哈希（MD5/SHA-1 用于安全用途）、不安全加密（DES/RC4/ECB/`createCipher` 无 IV）、硬编码密钥、弱 KDF、弱随机（`Math.random` 用于安全令牌）、认证标签缺失、定时安全比较。
- 命令兜底：`rg` 全量扫索引定义、`.sort` 调用点、`createCipheriv/createHash/randomBytes/scrypt/hkdf`、`Math.random`、硬编码密钥模式、`readyState` 散落点。

## 二、已核对且判定为稳健的区域

| 区域 | 结论 |
|---|---|
| 连接层 `mongoService.ts` | 连接池参数完整（maxPoolSize/minPoolSize/maxIdle/maxConnecting/waitQueueTimeout）、`retryWrites/retryReads`、`w:"majority"`、超时齐备；凭据在日志中 `maskMongoUri` 脱敏；`waitForConnection` 只等不重连（G5-22 防连接风暴）；`getPoolStats` 不再读驱动私有路径（G5-29）。代理仅允许 socks5，其它协议显式拒绝。 |
| 静态加密 · 密码 `utils/passwordSecurity.ts` | 新写入只留单向 `bcrypt` 哈希（不再可逆入库）；历史密文走 AES-256-GCM + per-record 随机 12B IV + auth tag + 包裹 DEK（信封加密）；解密失败回 `null` 不抛。 |
| 静态加密 · B 站 Cookie `bilibiliSyncService.ts`、数据采集原文 `dataCollectionService.ts` | 均 AES-256-GCM + 每条随机 IV + `getAuthTag/setAuthTag`；密钥 = SHA-256(高熵 env 密钥)，含 legacy 回退链保证旧密文可解。无 ECB、无 `createCipher`、无 IV 复用。 |
| 弱哈希扫描 | MD5/SHA-1 仅出现在**外部协议签名**（`biliApi`/`cdictUpstream` 的三方 API 签名要求）与**非安全用途**（TTS/头像/文件去重的缓存/ETag key）；无一用于我方完整性/签名/口令。 |
| 弱随机扫描 | 安全令牌（登录码、邀请/空间 ID、交易码、Turnstile）均标注并使用 CSPRNG；`Math.random` 仅用于 workerId/抖动/洗牌等非安全场景。 |
| 硬编码密钥扫描（gitleaks 风格） | 无硬编码密钥/回退默认密钥；命中项全是随机 ID 的字符集常量与路径白名单。`.env`/`secrets/` 已 gitignore。 |
| NoSQL 注入面（沿用 2026-09-27 主审结论） | 正则查询经 `escapeRegex` 后拼 `$regex`；status 走 allowlist；无 `$where`/用户可控运算符注入。 |

## 三、发现（Findings）与修复

> 修复原则：只做**纯 schema 级索引补充**（无运行时行为变化、不影响被 mock 的测试套件），不触碰当前工作树中他会话未提交的 WIP（F-01/F-02 安全改动涉及的 10 个文件）。

### D-01 · 已修（性能）— `broadcastLog` 集合零索引，历史查询走内存排序

- **文件**：`src/models/broadcastLogModel.ts`。
- **症状/根因**：`GET /admin/broadcast/history` 执行 `find(audience?).sort({ createdAt: -1 }).limit(≤100)`，而 `BroadcastLogSchema` 此前**没有任何索引**（全 57 个 model 中唯一"被带排序查询、却零索引"者）。无过滤时的 `sort({createdAt:-1})` 与带 `audience` 过滤的 find+sort 都做内存排序，集合随每次广播单调增长后会撞 MongoDB 32MB sort memory limit（报 `Sort exceeded memory limit`）并逐步变慢。
- **修复**：补 `{ createdAt: -1 }`（服务无过滤排序）与 `{ audience: 1, createdAt: -1 }`（服务带 audience 的过滤+排序，等值前缀 + 排序后缀，可同时服务过滤与排序）两条索引。
- **部署注**：既有部署需跑一次 `syncIndexes()` 让索引物理落地（新集合自动创建）。

### D-02 · 已修（性能）— `securityEvent` 按 deviceFingerprint 过滤时排序落内存

- **文件**：`src/models/securityEventModel.ts`。
- **症状/根因**：`getSecurityEvents`（nexaiSecurityController）支持 `find({ deviceFingerprint }).sort({ createdAt: -1 }).skip().limit()`。模型已有 `deviceFingerprint` 单字段索引与 `createdAt` 单字段索引，但单字段 `deviceFingerprint` 索引只服务过滤、`createdAt` 排序仍落内存；单个高频设备累积大量事件时会撞 sort memory limit（`eventType` 过滤路径已有 `{ eventType:1, createdAt:-1 }` 复合索引覆盖，deviceFingerprint 路径此前缺对偶）。
- **修复**：补 `{ deviceFingerprint: 1, createdAt: -1 }` 复合索引，与既有 eventType 复合索引对齐，让过滤+排序全走索引。

## 四、观察与建议（未改动，交由 owner 决策）

- **E-obs-01（低危 · 信息）** `apiKeyService.hashKey` 用**静态 salt** `"api-key-static-salt"` + scrypt 做 API Key 哈希。静态 salt 通常是缺陷，但此处 **(a)** API Key 是 24 字节 CSPRNG（192-bit 熵），彩虹表/字典攻击不可行；**(b)** 确定性哈希是"用呈递的 key 反查库中记录"的前提。属**有意的查表设计取舍**，风险低。若要改（如 per-key salt + 独立查找索引），需配套迁移存量 key，超出本次最小改动范围——**保持现状**，仅登记。
- **G-obs-02（增长治理）** `broadcastLog` 与 `securityEvent` 两个集合**无 TTL**（`expireAfterSeconds`），会无限增长；同类日志集合（auditLog/translationLog 等）多有 90 天 TTL。是否加 TTL 属**保留期策略**（安全审计留存 vs 存储成本），沿用 `ipqsLookupLog` 注释里"TTL 待 owner 决定"的既有惯例，**本次不加**，登记为待决。
- **G-obs-03（统一处理 · 维护性）** 全仓约 200 处内联 `mongoose.connection.readyState === 1 / !== 1` 魔法数判连接态，而 `mongoService` 已导出等价的 `isConnected()`。统一收敛可提升可维护性，但属大范围机械改动、且与当前未提交 WIP（`adminController.ts` 等）高度重叠，易起冲突——**本次不做**，登记为后续独立小改动的候选。

## 五、边界声明

- 本次为**静态审计 + schema 级索引补充**，抓不到运行时/编译错误——最终以 **GitHub Actions 全绿**为准。
- 索引补充是纯 schema 元数据注册，对被 mock 的测试套件无影响，也不改任何查询/控制流；理论上不会让既有 CI 变红。
- 密码学审查结论：静态加密与令牌生成层**未发现新的 E 类缺陷**，弱算法仅限外部协议签名与非安全缓存 key。
