# 工单系统 UI/UX v2 — 缺陷与实施清单

> 依据：`docs/plans/2026-10-17-ticket-system-ux-v2-prd.md`（本清单是其实施拆分）。
> 依据方法论：先只做静态审查与落盘清单，再按「文件两两不相交」并行实施；**禁止本地构建/测试/装依赖**，
> 最终以 GitHub Actions 为准。每条改动完成后在此更新状态与去向。
>
> 基线：`main`（`661ab4de feat(ticket): 附件上传支持按用户单独授权`）。
> 工作树另有 geogebra 相关改动，**不属于本任务，不得改动**。

## 一、问题与需求编号

### 后端

| 编号 | 严重度 | 位置 | 问题 | 改法 |
| --- | --- | --- | --- | --- |
| TUX-B01 | 高 | `src/models/ticketModel.ts` | 无首响/解决时间、无处理记录、无满意度字段 | 新增 `events/firstResponseAt/resolvedAt/csat*` 与索引 |
| TUX-B02 | 高 | `src/controllers/ticketController.ts` | 统计只有存量计数，无法评估支持质量 | 新增分诊/今日/首响/满意度聚合 |
| TUX-B03 | 高 | `src/controllers/ticketController.ts` | 批量只有状态，客服无法批量认领/分类 | 扩展批量端点，`bulkWrite` 逐条事件 |
| TUX-B04 | 中 | `src/controllers/ticketController.ts` | 用户列表无搜索/状态/排序 | `GET /api/tickets` 支持 `q/status/sort` |
| TUX-B05 | 中 | `src/controllers/ticketController.ts` | 管理端无法按工单 ID / 受理人名搜索，无法筛低满意度 | `q` 扩展 `_id/assigneeName`；新增 `csat=low` |
| TUX-B06 | 中 | `src/controllers/ticketController.ts` | 无满意度提交能力 | 新增 `POST /api/tickets/:id/csat` |
| TUX-B07 | 中 | `src/utils/ticketView.ts` | 新字段未纳入视图；处理记录可能泄露客服姓名 | 视图补默认值、CSAT 字段、事件脱敏 |
| TUX-B08 | 中 | `src/controllers/ticketController.ts` | 状态/受理人/优先级/分类变更无审计轨迹 | 所有变更追加事件（上限 100 条） |
| TUX-B09 | 低 | `docs/governance/privacy-data-map.json` | 新增字段未登记隐私数据地图 | 补字段、用途、留存说明与变更记录 |

### 前端用户端

| 编号 | 严重度 | 位置 | 问题 | 改法 |
| --- | --- | --- | --- | --- |
| TUX-U01 | 高 | `TicketSystem.tsx` | 用户列表无搜索/状态筛选 | 新增 `TicketUserFilters` + 后端参数 |
| TUX-U02 | 高 | `TicketCreateForm.tsx` | `TICKET_CREATE_TEMPLATES` 定义未使用；表单过长 | 模板胶囊 + 「更多信息」折叠 |
| TUX-U03 | 中 | `TicketCreateForm.tsx` | 创建草稿不持久化 | localStorage 草稿 + 恢复/丢弃 |
| TUX-U04 | 高 | `TicketSystem.tsx` | 会话无日期分隔、无新消息提示、无条件滚底 | 抽 `TicketConversation` 并重写滚动策略 |
| TUX-U05 | 高 | `TicketSystem.tsx` | 消息编辑框浅色气泡上白字浅底不可读 | 编辑框改白底深色字 |
| TUX-U06 | 高 | 无 | 解决后无满意度评价 | 新增 `TicketSatisfactionCard` + API |
| TUX-U07 | 中 | 无 | 状态/受理人/优先级变更不可见 | 新增 `TicketEventTimeline` |
| TUX-U08 | 中 | `TicketSystem.tsx` | 筛选刷新即丢；深链不保留筛选 | `ticketUrlState` URL 同步 |
| TUX-U09 | 低 | `TicketSystem.tsx` | 标签页不提示未读 | `document.title` 未读前缀 |
| TUX-U10 | 低 | `TicketSystem.tsx` | 列表无可用的键盘移动 | `j/k` 切换、`Esc` 返回 |

### 前端管理端

| 编号 | 严重度 | 位置 | 问题 | 改法 |
| --- | --- | --- | --- | --- |
| TUX-A01 | 高 | `TicketStatsBar.tsx` | 缺我的待办/未分配/今日/首响/满意度 | 新卡片 + 快捷视图高亮 |
| TUX-A02 | 高 | `TicketFilters.tsx` | 无快捷视图，筛选条件收起后不可见 | 快捷视图 + CSAT 筛选 + 激活摘要 |
| TUX-A03 | 高 | `TicketSystem.tsx` | 批量只能改状态 | 新 `TicketBulkBar`，批量认领/转派/优先级/分类 |
| TUX-A04 | 中 | `TicketListItem.tsx` | 列表无满意度提示 | CSAT 星级徽标（≤2 星 rose） |
| TUX-A05 | 中 | `TicketAttachmentSettingsCard.tsx` | 低频设置常驻顶部；读取失败无重试 | 折叠默认收起 + 摘要 + 重试 |
| TUX-A06 | 中 | `TicketSystem.tsx` | 详情无上下条、无 SLA、无满意度 | 详情头部补 SLA/CSAT/上下条 |
| TUX-A07 | 中 | `TicketSystem.tsx` | 筛选条件无法分享/恢复 | 与 TUX-U08 共用 URL 同步 |

---

## 二、文件所有权（两两不相交）

### Agent BE（后端）

- `src/models/ticketModel.ts`
- `src/services/ticketWorkflowService.ts`（新建）
- `src/controllers/ticketController.ts`
- `src/routes/ticketRoutes.ts`
- `src/utils/ticketView.ts`
- `src/tests/ticketWorkflowV2.test.ts`（新建）
- `docs/governance/privacy-data-map.json`

### Agent FE-USER（用户端 + 共享层）

- `frontend/src/api/ticketApi.ts`
- `frontend/src/components/ticket/ticketConstants.ts`
- `frontend/src/components/ticket/ticketUrlState.ts`（新建）
- `frontend/src/components/ticket/TicketUserFilters.tsx`（新建）
- `frontend/src/components/ticket/TicketCreateForm.tsx`
- `frontend/src/components/ticket/TicketConversation.tsx`（新建）
- `frontend/src/components/ticket/TicketEventTimeline.tsx`（新建）
- `frontend/src/components/ticket/TicketSatisfactionCard.tsx`（新建）
- `frontend/src/tests/ticketUrlState.test.ts`（新建）
- `frontend/src/tests/ticketEventCopy.test.ts`（新建）

### Agent FE-ADMIN（管理端组件）

- `frontend/src/components/ticket/TicketFilters.tsx`
- `frontend/src/components/ticket/TicketStatsBar.tsx`
- `frontend/src/components/ticket/TicketBulkBar.tsx`（新建）
- `frontend/src/components/ticket/TicketListItem.tsx`
- `frontend/src/components/ticket/TicketAttachmentSettingsCard.tsx`

### 协调者（主会话）

- `frontend/src/components/TicketSystem.tsx`（集成）
- `docs/plans/2026-10-17-ticket-system-ux-v2-prd.md`（已完成）
- 本文件
- `src/generated/privacyDataMap.ts`（生成器生成）
- 最终 diff 核查、提交与推送

> FE-USER 与 FE-ADMIN 都依赖 `ticketConstants.ts`，**只允许 FE-USER 编辑**；
> FE-ADMIN 只 import 现有导出，不新增共享常量。

---

## 三、组件 Props 契约（并行实施必须遵守）

### 1. `TicketUserFilters`（FE-USER）

```ts
export interface UserTicketFilterValue {
  status: string;
  q: string;
  sort: string;
}
export const EMPTY_USER_TICKET_FILTER: UserTicketFilterValue = { status: "", q: "", sort: "updated" };

interface TicketUserFiltersProps {
  value: UserTicketFilterValue;
  searchInput: string;
  onSearchChange: (value: string) => void;
  onChange: (patch: Partial<UserTicketFilterValue>) => void;
  onReset: () => void;
  onRefresh: () => void;
  loading: boolean;
  total: number;
  shown: number;
}
```

- 搜索框 + 5 个状态胶囊（全部/待处理/处理中/已解决/已关闭）+ 排序下拉 + 计数。
- 手机可横滑；不得新增禁用色；使用 `studioPillClassName` / `studioFieldClassName` / `studioGhostButtonClassName`。

### 2. `TicketConversation`（FE-USER）

```ts
interface TicketConversationProps {
  ticket: ITicket;
  currentUserId?: string;
  isAdmin: boolean;
  canWrite: boolean;            // superadmin
  streamingAiResponse: { ticketId: string; content: string } | null;
  editingIdx: number | null;
  editValue: string;
  isUpdating: boolean;
  onStartEdit: (index: number, content: string) => void;
  onCancelEdit: () => void;
  onEditValueChange: (value: string) => void;
  onSaveEdit: (index: number) => void;
  onDeleteMessage: (index: number) => void;
  onCopyMarkdown: (success: boolean, whole?: boolean) => void;
}
export default TicketConversation;
```

行为：

- 内部自己持有滚动容器 ref，**不要再由父组件滚动**。
- 切换工单 → 立即滚到底；消息数增加时，若距底部 < 120px 则平滑滚底，否则显示「有新消息 · 回到底部」浮钮。
- 日期分隔：按本地自然日分组，首条显示「今天 / 昨天 / YYYY年M月D日」，`role="separator"`。
- 每条消息 `<time dateTime>`，显示 `formatTicketTime`，`title` 为完整 `toLocaleString`。
- 管理员可见「全部 / 公开 / 内部备注」过滤；过滤时保留原始索引用于编辑/删除。
- 编辑框统一白底深色字（`bg-white text-slate-900 border-slate-300`），不再使用白字透明底。
- 消息操作按钮在 hover 与键盘 focus 时可见，均有 `aria-label` 与 `title`；增加「复制」按钮。
- 发送者标签统一中文：智能助手 / 客服 / 用户。
- 保留 AI 流式气泡、`AiErrorDetailsPanel`、Markdown 渲染、内部备注 violet 样式。
- 空态：过滤后无消息时显示「没有符合条件的消息」。

### 3. `TicketEventTimeline`（FE-USER）

```ts
interface TicketEventTimelineProps {
  events?: ITicketEvent[] | null;
  defaultOpen?: boolean;
}
```

- `<details>` 可折叠；无事件返回 `null`。
- 每条显示 `ticketEventDescription(event)`、操作者（后端已脱敏）、`formatTicketTime`。
- 使用竖向时间线，色只用 slate/amber/emerald/rose/sky。

### 4. `TicketSatisfactionCard`（FE-USER）

```ts
interface TicketSatisfactionCardProps {
  ticket: ITicket;
  currentUserId?: string;
  isAdmin: boolean;
  onSubmit: (rating: number, comment: string) => Promise<boolean>;
}
```

- 仅 `!isAdmin && ticket.userId === currentUserId && (status === 'resolved' || status === 'closed')` 渲染。
- 未评价：5 星 radio（`role="radiogroup"`、`aria-checked`）+ 可选评论 ≤500 + 提交。
- 已评价：只读星级、评论、时间 + 「修改评价」。
- 提交失败时保留本地输入；`onSubmit` 返回 false 时不关闭编辑态。

### 5. `TicketBulkBar`（FE-ADMIN）

```ts
export interface TicketBulkPatch {
  status?: string;
  priority?: string;
  category?: string;
  assignee?: string;
}

interface TicketBulkBarProps {
  checkedCount: number;
  totalShown: number;
  busy: boolean;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onExit: () => void;
  onBulk: (patch: TicketBulkPatch) => void;
}
```

- 按钮：认领给我 / 取消分配 / 标记已解决 / 关闭 / 重新打开 / 全选本页 / 清除选择 / 退出。
- 下拉：优先级（低/一般/紧急）、分类（5 类），选择后立即调用 `onBulk`，随后重置为占位。
- 0 选中时写操作禁用；`busy` 时全部禁用。
- 手机端换行，不横向溢出。

### 6. `TicketFilters`（FE-ADMIN）

在现有 `TicketFilterValue` 增加：

```ts
csat: string; // "" | "low"
```

新增 props（可选，保持向后兼容）：

```ts
activeView?: string;
onQuickView?: (view: string) => void;
```

- `TICKET_QUICK_VIEWS = ['all','mine','unassigned','awaiting','overdue','lowCsat']`。
- 每个视图对应 patch：
  - all：清空 status/assignee/awaitingReply/unread/csat/priority/category/type/service/from/to
  - mine：`assignee:'me', awaitingReply:'1'`，其余清空
  - unassigned：`assignee:'unassigned'`，其余清空
  - awaiting：`awaitingReply:'1'`，其余清空
  - overdue：`awaitingReply:'1', sort:'oldest'`，其余清空
  - lowCsat：`csat:'low'`，其余清空
- 高级筛选增加「满意度 ≤2 星」下拉。
- 收起时不仅用 title，还要在按钮下方显示可读的激活条件摘要（最多 3 个 + 「等 N 项」）。
- 导出按钮保留。

### 7. `TicketStatsBar`（FE-ADMIN）

```ts
interface TicketStatsBarProps {
  stats: TicketStats | null;
  loading: boolean;
  onQuickFilter: (patch: Partial<TicketFilterValue>) => void;
  activeView?: string;
}
```

- 卡片：我的待办 / 待回复 / 逾期 / 未分配 / 今日新增 / 今日解决 / 平均首响 / 满意度 / 待处理 / 处理中 / 已解决 / 已关闭 / 全部。
- 平均首响卡不可点击（`interactive: false`），其余点击即筛选。
- 当前 `activeView` 卡片加 `ring-2 ring-slate-900`。
- 新字段缺失时回退 0 / `—`，不白屏。

### 8. `TicketListItem`（FE-ADMIN）

- 管理员视角：`ticket.csatRating` 为 1–5 时显示星级徽标；≤2 用 rose，其余 emerald。
- 保留未读、SLA、内部备注、附件、受理人信息。
- 不新增 `rounded-lg` 等非基线圆角。

### 9. `TicketAttachmentSettingsCard`（FE-ADMIN）

- 外层改为 `<details>`，默认收起；`summary` 显示「管理设置 · 附件上传：已开启/默认关闭 · 单独授权 N 人」。
- 内容保持现有开关、授权名单、恢复默认。
- 读取失败时在内容区显示「重试」按钮（不是只显示错误文字）。
- 展开后内容宽度不溢出；不改变任何 API 调用。

### 10. `ticketApi`（FE-USER）

新增/变更：

```ts
export interface ITicketEvent { ... } // 见 PRD §6.1
// ITicket 增加 events/firstResponseAt/resolvedAt/csat*
// ITicketSummary 增加 csatRating

async getMyTickets(params?: { page?: number; limit?: number; q?: string; status?: string; sort?: string }): Promise<TicketListPage>
async getAllTickets(params?: { ..., csat?: string }): Promise<TicketListPage>
async bulkUpdate(ids: string[], fields: { status?: string; priority?: string; category?: string; assignee?: string }): Promise<{ success: boolean; updated: number; matched: number }>
async submitCsat(id: string, rating: number, comment?: string): Promise<ITicket>
```

- 保留 `bulkUpdateStatus(ids, status)` 作为 `bulkUpdate(ids, { status })` 的包装。
- `TicketStats` 增加后端新字段（可为可选，兼容旧响应）。

---

## 四、后端实现要点（Agent BE）

### 1. `ticketWorkflowService.ts` 导出

```ts
export type TicketEventType = "created" | "status" | "priority" | "category" | "assignee" | "type" | "service" | "csat";
export interface TicketEventInput { ... }
export function buildTicketEvent(input: TicketEventInput): Record<string, unknown>;
export function buildBulkTicketUpdate(args: {
  ticket: { _id: unknown; status?: string; priority?: string; category?: string; assigneeId?: string | null; assigneeName?: string | null; firstResponseAt?: Date | null; resolvedAt?: Date | null };
  patch: { status?: string; priority?: string; category?: string; assigneeId?: string | null; assigneeName?: string | null };
  actor: { id: string; name: string; role: string };
  now: Date;
}): { changed: boolean; $set: Record<string, unknown>; $push?: { events: unknown } };
export function normalizeCsatInput(input: unknown): { ok: true; rating: number; comment: string | null } | { ok: false; error: string };
export async function computeTicketStats(viewerId: string): Promise<Record<string, number | null>>;
export async function applyBulkTicketPatch(args: { ids: string[]; patch: ...; actor: ... }): Promise<{ matched: number; updated: number; changed: Array<{ userId: string; title: string; status?: string }> }>;
```

- `computeTicketStats` 只读 `TicketModel`，用 `Promise.all` 并行聚合。
- `applyBulkTicketPatch` 先 `find` 选中字段，构造 `bulkWrite`，再 `find` 更新后的文档。
- 事件 `$push` 用 `{ $each: [event], $slice: -100 }`。
- 首响/解决时间规则见 PRD §6.3。
- 所有 helper 纯函数可单测；不要在这里发邮件或 WS（由控制器负责）。

### 2. 控制器改动

- 用户列表：解析 `q/status/sort`，复用 `escapeRegexLiteral`。
- 管理列表：`q` 增加 `_id`/`assigneeName`；`csat=low`。
- `replyToTicket`：非属主公开回复且 `firstResponseAt` 为空时写入。
- `generateAiTicketResponse`：追加 AI 消息时若 `firstResponseAt` 为空则写入。
- `updateTicketStatus`/`updateTicketFields`/`closeOwnTicket`：状态进入 resolved/closed 写 `resolvedAt`，回到 open/in-progress 清空；追加事件。
- `bulkUpdateStatus`：扩展为 status/priority/category/assignee；调用 `applyBulkTicketPatch`；状态变化才发邮件。
- `submitTicketCsat`：新增 handler。
- 控制文件不得超过 1500 行：把可复用的纯逻辑放进 service，必要时把 `parseTicketListQuery` / `setTicketListHeaders` / `resolveRelatedTickets` 也迁移到 service/utils。

### 3. 视图

- `toTicketView(ticket, includeAiErrorDetails, { includeInternal })`：
  - 必填 `events` 默认 `[]`。
  - 非 `includeInternal` 时，对 `actorRole` 为 `admin/superadmin` 的事件：删除 `actorId`，`actorName = "客服"`。
  - `csatComment` 仅在 `includeInternal` 为真时下发；`csatRating/csatSubmittedAt` 两个视角都下发。
- `toTicketSummary`：`csatRating` 下发；`csatComment/events` 不下发。
- 新增测试 `src/tests/ticketWorkflowV2.test.ts`，至少覆盖：
  - 事件构造与时间线脱敏；
  - CSAT 输入校验（非整数、0、6、超长评论）；
  - 批量更新构造只写变化字段、事件类型正确；
  - 首响/解决时间规则。

### 4. 路由

```ts
router.post(
  "/:id/csat",
  ticketWriteLimiter,
  auditLog({
    module: "other",
    action: "ticket.csatSubmit",
    extractTarget: (req) => ({ targetId: req.params.id }),
    extractDetail: (req) => ({ rating: req.body?.rating }),
  }),
  ticketController.submitTicketCsat,
);
```

位置放在 `/:id/messages` 附近；`/capabilities`、`/unread-count` 仍必须在 `/:id` 之前。

### 5. 隐私数据地图

- `docs/governance/privacy-data-map.json` 的 `tickets.fields` 增加
  `firstResponseAt/resolvedAt/csatRating/csatComment/csatSubmittedAt/events`；
- `purpose` 与 `userFacing.what` 补「满意度评价与处理记录」；
- `changelog`/`updatedAt`（若存在）补一条 2026-10-17 记录。

---

## 五、实施顺序与验收

1. **BE** 完成后，协调者跑 `node scripts/generate-privacy-data-map.js` 与 `node scripts/governance/check-privacy-contract.js`。
2. **FE-USER / FE-ADMIN** 并行完成，协调者逐份 `git diff` 核查。
3. 协调者集成 `TicketSystem.tsx`。
4. 静态检查：`check:ts-file-size`、`check:frontend-design-language`（不得新增违规）。
5. 提交（签名）→ push → CI 全绿。

## 六、状态追踪

| 编号 | 状态 | 去向 |
| --- | --- | --- |
| TUX-B01 ~ B09 | [x] | 后端批次：`ticketModel` / `ticketWorkflowService` / `ticketController` / `ticketRoutes` / `ticketView` / 隐私数据地图 + `ticketWorkflowV2.test.ts` |
| TUX-U01 ~ U07 | [x] | 用户端批次：`ticketApi` / `ticketConstants` / `ticketUrlState` / `TicketUserFilters` / `TicketCreateForm` / `TicketConversation` / `TicketEventTimeline` / `TicketSatisfactionCard` + 两个 Vitest 用例 |
| TUX-U08 ~ U10 | [x] | 协调者集成：`TicketSystem.tsx` 的 URL 同步、标签页未读、j/k 与 Esc |
| TUX-A01 ~ A05 | [x] | 管理端批次：`TicketFilters` / `TicketStatsBar` / `TicketBulkBar` / `TicketListItem` / `TicketAttachmentSettingsCard` |
| TUX-A06 ~ A07 | [x] | 协调者集成：详情头部 SLA/满意度/上下条；URL 同步与管理端共用 |
| PRD | [x] | `docs/plans/2026-10-17-ticket-system-ux-v2-prd.md` |

### 复核记录（协调者）

- 控制器抽取 `ticketWorkflowService` 后为 1488 行（≤1500）；`TicketSystem.tsx` 1692 → 1910（+218/300 遗留增长预算）。
- 修正了后端批次遗留的一处重复声明（控制器内 `getAdminTeamEmails` 与 import 同名）。
- `csatComment` 的可见性按 PRD §6.4 实现为「属主 + superadmin」；WS 广播给管理员时单独剥离评论，
  避免只读管理员经 WebSocket 收到评价内容。列表摘要仍只带 `csatRating`。
- 静态闸门：`check:frontend-design-language` 通过且工单文件零新增违规；
  `check:privacy-contract` / `check:privacy-data-map` 通过（已重生成 `privacyDataMap.ts`）。
- 未在本地构建或运行测试；最终以 GitHub Actions 结论为准。
- 提交：`be45c5a8`（主体）、`9556bc94`（时间线展开态 / 列表星级同步）、
  `50c9ee38`（移动端 flex / 工单 ID 搜索）、`5d7f1fea`（概览卡筛选归一）。
