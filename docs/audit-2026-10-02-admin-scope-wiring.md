# 前后端对接审查：管理端页面授权与近一天新增能力（2026-10-02）

- 审查范围：**近 30 小时内落到 `main` 的全部提交**（35 个），重点是「后端已实现、前端没接上」或
  「前端写死、后端已改成运行时配置」这类**两端不同口径**的缺陷。
- 判据来源：仓库当前源码（逐文件读 + 脚本交叉核对，标注 `文件:行`）。本机不构建、不测试，
  最终裁决者是 `main` 上的 CI。
- 背景：本轮起点是用户提问「超级管理员在哪里可以管理普通管理员能看到的页面」——查下来是
  `feat(admin-scope)`（提交 `f41a346d`）只做了后端（接口 + 守卫 + 登记表），前端既没有配置页，
  也仍在用写死的白名单决定普通管理员能看到什么。
- 关联改动：见 §2「本轮改动」；每条缺陷都有唯一编号与去向。

---

## 1. 交叉核对：三方数据源必须一致

页面授权把「页面」拆成了三份数据，任一份漏更新都会变成静默缺陷，因此本轮先用脚本把三者对账：

| 记号 | 数据源 | 作用 |
|---|---|---|
| A | `frontend/src/components/admin/adminModules.tsx` 的 `ADMIN_MODULE_LOADERS` | `/admin/<key>` 能渲染哪些模块 |
| B | `src/config/adminPages.ts` 的 `ADMIN_PAGES` | 页面 → 授权 key + 覆盖的 API 前缀（超管能授什么） |
| C | `frontend/src/navigation/navConfig.ts` 的 `getAdminNavGroups()` | 导航/总览有没有入口 |

对账命令（可重复执行，纯静态）：

```bash
python3 - <<'PY'
import re
A = set(re.findall(r"(?:^|\n)\s*'?([A-Za-z0-9\-/]+)'?\s*:",
      open('frontend/src/components/admin/adminModules.tsx',encoding='utf-8').read().split('as const;')[0]))
B = set(re.findall(r'key:\s*"([^"]+)"',
      open('src/config/adminPages.ts',encoding='utf-8').read().split('ADMIN_PAGES: readonly')[1]))
C = set(re.findall(r"url:\s*['\"]/admin/([A-Za-z0-9\-/]+)['\"]",
      open('frontend/src/navigation/navConfig.ts',encoding='utf-8').read()))
print('A-B（有模块未登记 → 无法授权）:', sorted(A-B-{'default'}))
print('B-A（登记了但无模块）:', sorted(B-A))
print('A-C（有模块但导航无入口）:', sorted(A-C-{'default'}))
print('C-A（导航指向不存在模块）:', sorted(C-A))
PY
```

本轮核对结果与判定：

| 差异 | 判定 |
|---|---|
| `email-traceability` ∈ A，∉ B、∉ C | **真缺陷**：邮件溯源页只能深链访问、且无法授权给普通管理员（WIRE-03） |
| `tamper-detection-demo` ∈ B(apiPrefixes `[]`)，`tamper` ∈ B(`["/api/tamper"]`) 但 ∉ A、∉ C | **真缺陷**：导航指向的页面没有 API 范围；有 API 范围的那个 key 没有任何入口（WIRE-04） |
| `dashboard` / `store` / `store/cdks` / `store/resources` / `email-sender` / `nexai-security` / `tickets` ∈ B，∉ A | 预期：它们是**独立前端路由**（`/admin/store*`、`/email-sender`、`/nexai-security`、`/support`）或纯页面外壳，不进 `ADMIN_MODULE_LOADERS`（WIRE-06） |
| `ipfs` ∈ B(`/api/ipfs`)，前端无任何调用方 | 预期：API-only 登记，无对应页面（WIRE-06） |
| `default` （脚本假阳性） | 来自 `'apikey-billing'` 的 `{ default: function … }` 动态导入写法，对账时应剔除 |

---

## 2. 缺陷与改动清单

### WIRE-01（高 / 已修）页面授权只有后端，前端完全没有配置入口

- 位置：`src/routes/admin/adminScope.ts:37-92`（`GET/PUT/DELETE /api/admin/admin-scope/setting`）、
  `src/services/adminScopeConfigService.ts`、`src/models/adminScopeConfigModel.ts`
- 现状：接口齐全（默认授权 + 按 userId 覆盖 + 恢复默认），但全仓 `rg "admin-scope" frontend/` 只命中注释 ——
  超管只能手写 `curl` 改授权，管理面板里点不到。
- 改动：
  - 新增 `frontend/src/api/adminScope.ts`（四个接口的类型化封装）。
  - 新增 `frontend/src/components/admin/AdminScopeManager.tsx`：可授权页面多选（搜索 / 全选 / 清空 /
    apiScopeCount 标注）、按用户覆盖（增删改）、恢复后端默认（二次确认）、「最后更新 / 操作者 / 是否默认」，
    并把「无 API 范围」的语义写在页面上。
  - `frontend/src/components/admin/adminModules.tsx` 登记 `'admin-scope'` 懒加载；
    `frontend/src/navigation/navConfig.ts` 加导航项（`requiredRole: 'superadmin'`）。
  - **故意不在 `src/config/adminPages.ts` 登记**：该页自身不进「可授权页面」清单，避免它被授给普通管理员；
    路由侧 `isSuperAdminRequest` 已经是硬校验（双保险）。

### WIRE-02（高 / 已修）前端可见性写死，与后端运行时授权两套口径

- 位置：`frontend/src/utils/rbac.ts:22-45`（`PLAIN_ADMIN_ADMIN_MODULES/PATHS`）、
  `frontend/src/navigation/navConfig.ts:63-75`（`filterByVisibility` 里的硬编码过滤）、
  `frontend/src/components/admin/AdminHub.tsx:317`（深链守卫）
- 现状：后端已按运行时配置放行接口，前端仍按写死的四个页面过滤导航与深链 ——
  于是「超管授了新页面，普通管理员接口能通、界面看不到」。
- 改动：
  - 新增 `frontend/src/hooks/useAdminScope.ts`：读 `GET /api/admin/admin-scope/me`，模块级缓存 + in-flight
    去重（一次会话只打一次）；**失败时返回 `undefined` 由 rbac 回退到历史最小集合**（fail-closed：
    既不让授权服务抖动把普通管理员整个挡在门外，也不因“拿不到就全放开”而放大权限）。
  - `rbac.ts` 改为「服务端授权优先 + 回退」：新增 `normalizeGrantedPages` / `adminPageKeyForModule` /
    `adminModuleFromUrl` / `isAdminModuleGranted` / `canAccessAdminModule`；旧名保留并接受可选授权集合。
  - `navConfig.ts`：`NavVisibilityContext` 增 `grantedAdminPages`，`BaseNavItem` 增 `requiredPage`；
    管理入口的可见性 = `超管 || 授权集合包含该页 key`（key 默认由 URL 推导）。
  - `AdminHub.tsx`：两处 `getAdminNavGroups` 传入授权集合；深链守卫改为
    `getSuperAdminOnlyPaths().has(url) || !canAccessAdminModule(...)`；授权拉取中先显示「正在校验页面授权…」
    而不是闪一下拒绝页；授权服务不可用时在总览顶部给出降级提示。

### WIRE-03（中 / 已修）邮件溯源页没有登记、也没有导航入口

- 位置：`frontend/src/components/admin/adminModules.tsx:57`（`email-traceability`）、
  `src/config/adminPages.ts`
- 现状：`EmailTraceability` 调 `/api/outemail/{records,status,quota}`，与「邮件外发」是同一套 API 面。
- 改动：`outemail` 页的 label 改为「邮件外发与溯源」，导航新增「邮件溯源」入口并显式绑定
  `requiredPage: 'outemail'`；`rbac.ts` 的别名表把 `email-traceability → outemail`。
  **不再新开一个 key**：两个 key 覆盖同一批接口会让人以为「可以只授其一」。

### WIRE-04（中 / 已修）篡改检测的页面 key 与 API key 互不对应

- 位置：`src/config/adminPages.ts:78`（`tamper` → `/api/tamper`）、`:98`（`tamper-detection-demo` → `[]`）
- 现状：`TamperDetectionDemo.tsx:261/279/306` 调 `/api/tamper/admin/*`。两个 key 一个没入口、
  一个没 API 范围：把演示页授给普通管理员只会放出入口（请求 403），而 `tamper` 这个 key 无处可点。
- 改动：合并为 `tamper-detection-demo` + `apiPrefixes: ["/api/tamper"]`，删除 `tamper`。
  影响面：默认授权不含它，故无存量授权被放宽；若曾单独授过 `tamper`，该授权现在只剩入口（收窄，fail-closed）。

### WIRE-05（中 / 已修）生成物漂移 + 闸门被 `Run build` 抢先重生成，等于不判闸

- 位置：`src/generated/adminSpaModulePaths.ts`、`package.json:18`（`build:backend` 第一条就是
  `node scripts/generate-admin-spa-paths.js`）、`.github/workflows/tsc.yml:53/64`
- 现状：`ADMIN_MODULE_LOADERS` 里的 `debug-console`（提交 `dd6d4fc2` 引入）在入库的生成物里**不存在**；
  而 CI 里 `SPA path drift gate` 跑在 `Run build` **之后**，后者已经把该文件就地重生成 ——
  闸门拿「刚生成的文件」和自己比，永远为绿，所以这个漂移一路绿灯（`a53ab251` 上该步骤仍是 success）。
- 改动：重生成 `src/generated/adminSpaModulePaths.ts`（补 `admin-scope` 与 `debug-console` 两条，`--check` 通过）；
  把 `SPA path drift gate` 步骤**移到 `Run build` 之前**（该脚本只读源码、不需要构建产物），
  让它比的是真正的入库文件。这样下次漏重生成会真的失败。

### WIRE-06（低 / 记录在案）API-only 登记与独立路由，不造假页面

- `ipfs`（`/api/ipfs`）：登记表里有、前端无调用方 —— 允许保留（可能由外部脚本/客户端使用），
  但它会被列进「可授权页面」。管理页已用「无 API 范围 / N 个 API 前缀」标注这一区别。
- `tickets`、`store`、`email-sender`、`nexai-security`、`dashboard`：对应独立前端路由或页面外壳，
  数据由别的 key 覆盖（如 `/admin/store` 的数据来自 `store/cdks` + `store/resources`）。
  给 `store` 这类「外壳页」授权时必须**同时**授它的数据页，否则界面能进、数据 403 —— 保持现状并在管理页文案里说明。
- 明确不修（沿用 `docs/audit-2026-10-02-admin-panels.md` §3 的结论）：`AdminDashboard` 缺系统级概览
  （需新聚合接口与产品口径确认）、存量 19 处 `window.confirm` 统一、`regexEscape` 副本收敛。

### WIRE-07（中 / 已修）注册邀请码：后端批量与聚合能力没有前端入口

- 位置：`src/routes/admin/registrationInvites.ts:30`（stats）、`:41`（bulk-active）、`:63`（bulk-delete）
- 现状：`RegistrationInviteManager.tsx` 只调用列表/创建/单条更新/单条删除；统计与批量三个接口无调用方。
- 改动：新增统计卡（总数 / 可用 / 已过期 / 已用尽 / 已使用次数 / 剩余可用次数，来自服务端聚合而不是前端求和）、
  「最近使用」列表、列表级多选 + 批量启用 / 批量停用 / 批量删除（`ConfirmModal` 二次确认）。
  批量请求按 200 个 id 分批串行（后端单请求上限 500），失败时提示已完成数量并重新拉取列表。

### WIRE-08（中 / 已修）命令队列：后端支持清空、前端没有入口

- 位置：`src/routes/commandRoutes.ts:378`（`POST /api/command/clear-queue`，要求安全会话 + 管理员）
- 现状：`CommandManager.tsx` 有「清空历史」但没有「清空队列」（只有查看队列/下一条）。
- 改动：新增确认式「清空队列」按钮，与 `clear-history` 一样带 `verificationToken`（复用全站安全会话），
  成功后清空本地队列并提示实际清掉的条数。

---

## 3. 验证方式（本机静态部分）

- 前端全量**语法解析**（452 个文件，`ts.parseDiagnostics`）：0 错误。
- 生成物闸门：`node scripts/generate-admin-spa-paths.js --check` → 已同步（44 个管理模块 / 57 条路由）。
- `.github/workflows/tsc.yml` 用 `yaml.safe_load` 校验结构，并断言 `SPA path drift gate` 的下标 < `Run build`。
- 图标与导出名逐个核对（本轮踩过一次 `FaRotateLeft` 不存在，改用 `FaUndoAlt`；`getBackendErrorMessage`
  的实际路径是 `@/utils/backendError`）—— 这类错误只有 CI 的 `type-check-frontend` 是最终判据。

## 4. 待办（不静默消失）

| 项 | 说明 |
|---|---|
| `Node verification` 存量红灯 | `a53ab251` 上 `Run backend Jest tests with coverage` 失败（`authRoutes.test.ts` 载入时报 `argument handler must be a function`、`recommendationService.test.ts`、`cacheService.test.ts`）。**注意**：`docs/audit-2026-10-02-admin-panels.md` 把 `authRoutes` 那条归因到 `da80d741` 是错的 —— 该提交只加了 14 行（`/auth/security-summary`），`authMobileLoginLimiter` 由 `0d5ca09f` 引入。真正原因应往测试替身（jest.mock 工厂）方向查，属并发会话正在改的文件，本轮不代改。 |
| 普通管理员导航的秒级一致 | 授权有 15s 进程内缓存（`CACHE_TTL_MS`）；`PUT` 会主动失效，故单实例下即时生效，多实例下其他实例最多滞后 15s。 |
| `AdminDashboard` 系统级概览 | 需新聚合接口 + 产品口径（用户/Key/审计/封禁计数）。 |
