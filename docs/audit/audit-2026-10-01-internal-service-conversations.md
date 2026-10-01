# 内部服务会话：不再复用同一对话 + 按组件名命名（2026-10-01）

来源：用户工单要求两条——
1. 「工单言论审查不要复用同一个内部 librechat 对话」；
2. 「在 LibreChat 管理针对系统内部服务单独根据组件名开头命名会话」。

范围：`src/services/librechat/conversations.ts`（新增）、`libreChatService.ts`、`librechat/models.ts`、`moderationService.ts`、`qqGuardModerationService.ts`、`ticketController.ts`、`libreChatRoutes.admin.ts`、前端 `api/librechatAdmin.ts` 与 `LibreChatAdminPage.tsx`。

## 一、缺陷清单

### D1 言论审查复用同一个内部会话（跨工单串味 + 注入持久化）

- **文件**：`src/services/moderationService.ts`（`checkContentWithAi` / `getAiViolationReason`）、`src/services/qqGuardModerationService.ts`（模块级 `SERVICE_OWNER_KEY`）
- **症状**：每次审查都用**写死的身份**取 ownerKey（`system:moderation:check` / `system:moderation:reason` / `system:qq-guard:moderate`），而 `libreChatService.sendMessage` 会把该 ownerKey 最近 20 条历史作为上下文拼进请求。
- **根因**：LibreChat 侧一个会话 = 一个 canonical ownerKey（`user:<sha256>`）。身份固定 ⇒ 会话固定 ⇒ 审查 A 的历史落进审查 B 的上下文：
  1. 上一个工单/上一个群的文本会进入下一次判定（跨用户、跨工单信息混入）；
  2. 内容里的提示注入语料一旦被写进历史，会**长期驻留**并持续影响后续每一轮判定，且系统提示与「定界符内是数据」的边界被历史长度稀释；
  3. 历史越长越接近 `MAX_PROMPT_CHARS`/`MAX_USER_MESSAGES` 上限，判定被历史挤掉关键输入。
- **修复**：每次审查都创建一个**全新会话**（唯一标识 ⇒ 唯一 ownerKey ⇒ 空历史），`checkContentWithAi`、`getAiViolationReason`、`qq-guard.moderate` 三处都是「一次调用 = 一个会话」。工单 AI 助手（`ticketController`）需要单工单内的连续上下文，显式传稳定标识 `ticket-<id>`，保持「一工单一会话」不变。

### D2 系统内部服务会话在管理端不可辨认

- **文件**：`src/services/libreChatService.ts`（`adminListUsers`）、`frontend/src/components/LibreChatAdminPage.tsx`
- **症状**：管理端「LibreChat 管理」列表把内部服务会话和用户会话混在一起，且用户列显示的都是 `user:<sha256>` 摘要——管理员无法判断哪条是工单言论审查、哪条是 QQ 群审查，也无法按服务筛选。
- **根因**：ownerKey 是 sha256 摘要，不可逆；可读信息从未落到历史文档上。
- **修复**：
  - 新增 `src/services/librechat/conversations.ts` 作为内部服务会话命名的**单一事实源**：组件注册表（`moderation` 工单言论审查 / `qq-guard` QQ 群纪律审查 / `ticket-ai` 工单 AI 助手）+ `createInternalConversation()`；
  - 会话名规范 `<组件名>:<用途>:<标识>`（组件名开头，组件内可排序、可前缀搜索）；
  - 历史文档新增 `internalComponent` / `internalName`（`librechat/manage` 读侧同源），`adminListUsers` 返回 `kind/name/component/componentLabel`，并支持 `scope=all|user|system` 筛选与按组件名搜索；
  - 改造前用固定身份写入的 3 个遗留会话（摘要不可逆、无法枚举）由 `lookupLegacyInternalConversation()` 按当年写死的身份反推命名（`moderation:check:legacy` 等）；
  - 管理端加「会话范围」筛选，内部服务会话单独分组展示（紫色标识 + 组件中文名徽标）。

## 二、命名与隔离约定（后续新增内部服务照此办）

| 约定 | 说明 |
| --- | --- |
| 命名 | `createInternalConversation(组件, 用途[, 标识])` ⇒ 名字一律 `<组件名>:<用途>:<标识>` |
| 一次性审查 | 不传标识 ⇒ 每次新会话（言论审查类必须走这条） |
| 需连续上下文 | 传稳定标识（如 `ticket-<id>`）⇒ 同一标识恒定映射同一会话 |
| 登记 | 传 `{ internal: conversation }` 给 `sendMessage` ⇒ 名字落到历史文档，管理端可见 |
| 组件注册 | 新组件必须先进 `INTERNAL_SERVICE_COMPONENTS`，否则管理端不认（`isInternalServiceComponent` fail-closed） |

## 三、验证方式

- 本地不跑构建/测试（方法论 §一-1），只做静态检查（花括号平衡、`rg` 反查残留引用）。
- 新增 `src/tests/librechatInternalConversations.test.ts` 钉住契约：
  1. 会话名以组件名开头、ownerKey 合法且等于 `deriveUserOwnerKey("system:<name>")`；
  2. 不传标识时两次调用 ownerKey 不同（**不复用同一对话**）；
  3. 传稳定标识时 ownerKey 恒定（一工单一会话）；
  4. 用途/标识里的 `/`、空格等危险字符被净化；
  5. `checkContentWithAi` 连续两次审查传给 `sendMessage` 的 ownerKey 不同，且都带 `moderation:check:` 前缀名；`getAiViolationReason` 同理走 `moderation:reason:`；
  6. 遗留固定身份能反推可读名，未登记身份不臆造。
- CI 复验：`type-check`（前端 + 后端）、`Node verification`（Jest）、`Quality Guardrails`、`CodeQL`、`Docker` 全绿。

## 四、已知取舍

- 内部会话现在**一个调用一条会话**，会话数随审查量线性增长（每条 2 条消息）。保留期清理（TTL / 按组件批量删除）未在本轮实现，管理端已有的「删除 / 批量删除」可直接用；后续如需自动清理，按 `internalComponent + updatedAt` 走新加的复合索引。
- 改造前 `system:ticket:<id>` 形式的遗留工单助手会话带动态 ID，无法枚举，管理端仍显示为摘要身份（不臆造名字）。
