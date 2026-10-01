# 收窄普通管理员（admin）的管理后台权限（2026-10-01）

来源：用户要求——「进一步收窄非超级管理员的管理后台权限」，并明确「`/admin/oauth`、`/admin/users`、`/admin/apikeys`、（`/admin/apikey-billing`）这几项前后端只给普通管理员开放」。

## 一、策略（与既有分层的关系）

`docs/plans/admin-superadmin-rbac-plan.md` 定的分层是「admin = 只读管理视图 + OAuth 管理例外，superadmin 是超集」。本轮把 admin 的**可见范围**再收一刀：

| 角色 | 管理端可见/可调用的范围 |
| --- | --- |
| `admin` | **只有** 用户管理（`/api/admin/users*`）、API Key（`/api/apikeys*`）、API Key 计费（`/api/admin/apikey-billing*`、`/api/apikeys/billing*`）、OAuth 管理（`/api/oauth*`） |
| `superadmin` | 全部（仍是 admin 的超集） |
| 其他角色 / 匿名 | 不受本轮影响：管理端接口本来就由各自的路由守卫拒绝 |

**关键点：这是「范围收窄」，不是「提权」。** 白名单内的接口**各自原有的写守卫继续生效**（例如用户增删改仍然是 `authenticateSuperAdmin`），本轮只保证白名单之外的路径普通 admin 一律进不去。

## 二、为什么守卫必须 fail-closed

第一版实现把守卫写成「匿名/非管理员一律放行，交给目标路由自己的守卫」，这是错的：这样守卫自己**不提供任何保护**，安全性完全依赖「每个管理端路由都记得自己加认证守卫」这个假设——而这正是历史上出现漏配的根因（新增路由漏挂守卫时，守卫会安静放行）。

现行实现（`src/middleware/adminScope.ts`）：

- 匿名 / 非管理员角色 → **403 `ADMIN_REQUIRED`**（挂错位置只会更严，不会漏人）；
- `superadmin` → 放行；
- `admin` → 只有白名单前缀放行，其余 403 `ADMIN_SCOPE_FORBIDDEN`；
- 唯一例外：`/api/admin/user/profile|avatar|fingerprint` 这三个**用户自助端点**（普通登录用户的接口，只是住在 `/api/admin` 前缀下），它们由挂载级 `authMiddleware` 先认证，因此放行；例外清单与 `routes/admin/index.ts` 的旁路共用同一处定义，不再各写一份。

## 三、落地位置

### 后端

- 新增 `src/middleware/adminScope.ts`：白名单常量 + 路径归一 + `requireAdminScope`。
- `/api/admin` 子树：`src/routes/admin/index.ts` 的挂载级 `adminAuthMiddleware` 在角色校验通过后调用 `requireAdminScope` ⇒ 覆盖 config/env、crash-reports、ip-risk-logs、mobile-tokens、policy-consents、qq-guard、shortlinks、broadcast、audit-logs、registration-invites、bilibili-*、email-traceability 等整片子树。
- 独立管理端路由：在 `authenticateAdmin` / `adminAuthMiddleware` / `adminOnly` 之后插入 `requireAdminScope`（共 22 个文件、50 余处），含 `ttsRoutes`(admin/history, clarity/history)、`turnstileRoutes`(fingerprint-stats、ip-ban-stats、scheduler-status、hcaptcha-config、providers*)、`ipfsRoutes`(settings)、`status.ts`(profiling)、`cdkRoutes`、`webhookEventRoutes`、`outemailRoutes`、`emailRoutes`、`auditLogRoutes`、`tamperRoutes`、`policyRoutes`、`humanCheckRoutes`、`ticketRoutes`、`dataCollectionAdminRoutes`、`libreChatRoutes.admin.ts`、`resourceRoutes`、`shortUrlRoutes`、`mediaToolRoutes`、`markdownArticleRoutes`、`githubBillingRoutes`、`fbiWantedRoutes`、`coinFlipRoutes`、`oauthRoutes`。
- 本轮顺带把几个**页面已经超管专属、但接口还是 admin 可读**的错配补齐：`GET /api/cdks/export`、`GET /api/outemail/records[/:id]`、`GET /api/email/domains`、`GET /api/webhook-events[/:id]`、`GET /api/data-collection/admin/:id/raw`、`GET /api/librechat/admin/users[/:userId/history]`、`GET /api/status/profiling`。
- 治理登记：`src/routes/routeModules/knownMiddleware.ts` 把 `requireAdminScope` 登记为已知认证处理器，路由治理校验不会把它当成未知中间件。

### 前端（只影响可见性，后端才是判据）

- `frontend/src/utils/rbac.ts`：新增 `PLAIN_ADMIN_ADMIN_MODULES` / `PLAIN_ADMIN_ADMIN_PATHS` / `canAccessAdminSurface()`，与后端白名单同口径（注释里写明两边必须一起改）。
- `frontend/src/navigation/navConfig.ts`：`filterByVisibility()` 里加一条规则——普通 admin 看到的管理端导航只剩白名单四项，其余（包括原先标 `requiredRole: 'admin'` 的审计、用户列表之外的模块）全部隐藏。
- `frontend/src/components/admin/AdminHub.tsx`：`/admin/<module>` 深链再加一道判断，白名单之外的模块对普通 admin 直接渲染 `SuperAdminGuard` 提示页，不再等到接口 403 才报错。

## 四、验证方式

- 本地不跑构建/测试（方法论 §一-1）。
- 新增 `src/tests/adminScope.test.ts`：白名单正/反用例、路径归一、自助端点例外、以及 **fail-closed** 三条（匿名 → `ADMIN_REQUIRED`、普通用户 → `ADMIN_REQUIRED`、普通 admin 越界 → `ADMIN_SCOPE_FORBIDDEN`）、superadmin 全放行。
- CI 复验：`type-check`（前后端）、`Node verification`（Jest）、`Quality Guardrails`、`CodeQL`、`Docker`。

## 五、遗留与后续

| 项 | 说明 | 去向 |
| --- | --- | --- |
| 处理函数内的内联 `isAdminRole(req.user.role)` 判断 | 这类路由不走中间件链，`requireAdminScope` 不会自动生效（本轮已覆盖的路由都在中间件链上） | 后续按路由逐个处理，或统一改为中间件式守卫 |
| `/admin` 之外的 `renderAdminRoute` 页面 | 例如 `/outemail`、`/smart-human-check`、`/notification-test`；它们的接口已收窄，页面本身尚未套 `SuperAdminGuard` | 后续在 `App.tsx` 补守卫 |
| 白名单维护 | 新增管理端能力默认落在「未允许」一侧；要开放给普通 admin 必须显式加进后端 `PLAIN_ADMIN_ALLOWED_PREFIXES` 与前端 `PLAIN_ADMIN_ADMIN_PATHS` | 已写进代码注释与本文 |
