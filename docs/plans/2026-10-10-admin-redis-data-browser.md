# 管理端 Redis 在库数据浏览器（前后端 + 安全会话）

> 需求原文：「Synapse 前后端的 admin/system 页面支持查看当前服务所有 redis 在库明文数据，需要建立安全会话」。
> 本文件是实施前的设计清单（方法论 §一-8：先落盘、再动手），编号 `RB-xx` 供收尾逐条核对。

---

## 1. 结论：要做什么 / 不做什么

| 项 | 决策 | 理由 |
| --- | --- | --- |
| 入口 | 挂在现有 `/admin/system`（`SystemManager`）内新增一个面板 | 需求指定「admin/system 页面」，不新增前端路由 ⇒ 不触碰 `adminSpaModulePaths` 生成物 |
| 后端前缀 | `GET /api/admin/system/redis/*` | 落在既有 `/api/admin` 挂载之下，自动继承挂载级认证 + `adminLimiter` |
| 权限 | **superadmin + 有效安全会话**（缺一不可） | 需求「需要建立安全会话」；全库明文属系统级能力，普通管理员拿不到（`adminPages.ts` 的 `system` 保持 `apiPrefixes: []` ⇒ fail-closed） |
| 能力 | **只读**：概览 / 键分页列表 / 单键内容 / 全库快照导出 | 需求是「查看 + 导出」。不提供删除、写入、flush —— 危险面与需求无关 |
| 明文 | 原样返回（可截断），不做掩码 | 需求明确「明文数据」。截断只防大 value 撑爆响应，不改变可读性 |
| 命名空间 | 默认**整个当前 DB**；可用 `ADMIN_REDIS_KEY_PREFIXES` 收紧 | 生产 Redis 是 1Panel 共享实例（`deploy/openresty/backup-redis.sh`），共享时用白名单把范围收窄到本服务 |
| 审计 | 每个端点 `auditLog({ module: "system", captureBody: false })` | 查看明文属敏感操作；`captureBody: false` 避免把键名/值写进审计体 |
| 日志 | 只记「谁在什么时候看了哪一类端点」，**不记值与键名内容** | 与仓库既有的「日志不出现令牌/密钥」一致 |

---

## 2. 安全边界（这是本功能的重点，不是附加项）

1. **两层身份校验**：`isSuperAdmin(req)` 与 `hasValidSecuritySession(req)` 都通过才继续。
   安全会话复用全站统一的那一枚 `verificationToken`（`utils/securitySession.ts`，10 分钟 TTL），
   与「查看密钥」`/api/admin/envs/reveal-key` 同一套 —— 不再新造第二套口令机制。
2. **GET 也要带会话**：列表/概览没有 body，令牌走 `x-verification-token` 请求头
   （`requestVerificationToken` 已支持，`frontend/src/api/passkey.ts` 是现成先例）。
3. **限流**：挂载级 `adminLimiter`（50/min）之上再加一道 `adminRedisLimiter`（30/min），
   重操作（SCAN）不该和普通读共享同一档额度。
4. **绝不使用 `KEYS`**：一律 `SCAN` + 有界 `COUNT`，单次请求最多推进有限次迭代（RB-05），
   防止一次翻页把 Redis 打满（与 `RedisService.deleteByPrefix` 同一约定）。
5. **响应有界**：单键值截断到 `maxValueChars`（默认 4000，上限 20000），
   集合类截断到 `maxEntries`（默认 200，上限 1000）；截断在响应里显式标注。
6. **共享实例护栏**：`ADMIN_REDIS_KEY_PREFIXES` 配置后，范围外的键**既不列出也读不到**
   （读单键时 `REDIS_KEY_OUT_OF_SCOPE`），列表响应回报 `outOfScope` 计数 —— 静默漏数据比报错更难查。

---

## 3. 改动清单

### 3.1 后端

| 编号 | 文件 | 内容 |
| --- | --- | --- |
| RB-01 | `src/services/redisService.ts` | 新增只读浏览原语 `scanKeysPage` / `readKeyMeta` / `readKeyContent`，以及快照用的 `dumpKeyForExport`（客户端是该类私有成员，直接在这里做，不对外暴露 connection） |
| RB-02 | `src/services/redisAdminService.ts`（新） | 命名空间范围解析、概览、键分页、单键读取、`exportRedisAdminSnapshot` 流式生成器、参数钳制 |
| RB-03 | `src/routes/admin/system.ts`（新） | `/redis/overview`、`/redis/keys`、`/redis/value`、`/redis/export` 四个端点 + 两道守卫 + 显式审计 |
| RB-04 | `src/routes/admin/index.ts` | 挂载 `router.use("/system", systemRouter)` |
| RB-05 | `src/middleware/routeLimiters.ts` | `adminRedisLimiter`（40/min）与 `adminRedisExportLimiter`（3/10min） |
| RB-06 | `.env.example` | `ADMIN_REDIS_KEY_PREFIXES` 说明 |
| RB-07 | `src/tests/redisAdminService.test.ts`（新） | 范围判定、参数钳制、截断语义、不可用降级、导出三段记录与中止条件 |
| RB-08 | `src/tests/adminRedisRoutes.test.ts`（新） | 未登录 401、普通用户/普通管理员 403、超管缺会话 403（`SECURITY_SESSION_REQUIRED`）、`format=rdb` 501、NDJSON 导出契约 |
| RB-15 | `scripts/redis-restore-snapshot.js`（新） | 把快照 NDJSON 用 `RESTORE` 写回；默认 dry-run，`--apply` 才写库，`--replace` 才覆盖 |

### 3.2 前端

| 编号 | 文件 | 内容 |
| --- | --- | --- |
| RB-09 | `frontend/src/api/adminRedis.ts`（新） | 四个端点的类型化客户端；令牌走 `x-verification-token`；导出走 `responseType: 'blob'` + `timeout: 0` |
| RB-10 | `frontend/src/components/admin/RedisDataBrowser.tsx`（新） | 安全会话闸门 + 概览 + 命名空间/过滤 + 键列表分页 + 单键明文详情 + 快照导出 |
| RB-11 | `frontend/src/components/SystemManager.tsx` | 引入该面板（只加一段，不搬既有逻辑） |
| RB-12 | `frontend/src/tests/redisDataBrowser.test.tsx`（新） | 会话未建立时不发请求、建立后渲染、超管可见性 |

### 3.3 文档

| 编号 | 文件 | 内容 |
| --- | --- | --- |
| RB-13 | `CLAUDE.md` | 「安全注意事项 / 常见任务」补一条：管理端 Redis 浏览器的位置与两层守卫 |
| RB-14 | `AGENTS.md` | 「安全与配置」补 `ADMIN_REDIS_KEY_PREFIXES` 与只读定位 |

---

## 4. 不做什么（显式排除，避免「顺手」扩大危险面）

- 不做删除 / 写入 / `FLUSHDB` 类操作（需求是查看 + 导出快照）。
- **不做「应用侧 RDB 文件导出」**：真 RDB 在 Redis 服务器数据目录里，应用进程看不到，node-redis 也不支持 PSYNC 拉流。
  `format=rdb` 返回 501 并指向宿主机上的 `deploy/openresty/backup-redis.sh`（BGSAVE → 归档 → 真空加载校验），
  而不是产出一份恢复不了的假 `.rdb`。
- 不把键值写进日志、审计 payload、错误文案（审计只记键名与规模）。
- 不给普通管理员开这条 API（`adminPages.ts` 维持 `system: apiPrefixes: []`）。

---

## 5. 验证计划

本机禁构建/测试（`AGENTS.md` §0-1），全部判据取 GitHub Actions：

1. `type-check-backend` / `type-check-frontend` 绿（新服务与 axios 客户端的类型是首要风险）。
2. `Node verification` → 后端 Jest（含 RB-07/RB-08）与前端 Vitest（含 RB-12）绿；
   `check:admin-spa-paths` / `check:privacy-data-map` / `check:openapi-drift` 不漂移
   （本次不新增 `@openapi` 注释，故 spec 无需重生成）。
3. `Quality Guardrails` → `check:ts-file-size` 不超限（三个新文件均 < 500 行）；
   前端 bundle 预算不受影响（面板属既有 `system` 懒加载模块）。
4. 人工复核：响应里不出现键值内容被写入日志的路径；只读端点无任何写命令。
5. 快照可恢复性：`DUMP` 用 `BLOB_STRING → Buffer` 类型映射保证二进制字节精确，拿不到 Buffer 时**拒绝出快照**
   （RB-01）；`scripts/redis-restore-snapshot.js` 默认 dry-run，只有 `--apply` 才用 `RESTORE` 写回。
