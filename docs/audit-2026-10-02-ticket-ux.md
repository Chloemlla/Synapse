# 工单系统（用户端 / 管理端）UI/UX 全面优化 — 审查与改动清单

> 依据 `F:\Repositories\GitHub\verified-methodology.md`（阶段 1 只做静态审查、禁本地构建/测试，最终以 CI 为准）。
> 范围：`/support` 单页（用户视角 + 管理端视角共用 `TicketSystem.tsx`）与其后端 `/api/tickets*`。
> 基线：`main`（HEAD `bef397c3`，工作树干净）。审查方式：逐文件通读 + 调用链 `rg` 反查 + 与 `adminScope` 策略对照，未运行任何构建/测试。

## 一、结论摘要

工单链路的**并发与安全骨架总体是好的**：AI 回复用原子 `$push` + 条件状态翻转、回复用 CAS 重试、防提示注入、长度上限、违规申诉通道都已就位。
本轮问题集中在三类：**权限口径不一致（普通管理员越权读工单原文）**、**列表能力缺失（无分页/搜索/未读）**、**输入与可达性（回复框是单行 input、列表项不可键盘操作）**。

## 二、发现清单

| 编号 | 严重度 | 位置 | 类型 | 状态 |
|---|---|---|---|---|
| TB-B01 | 高 | `ticketController.getTicketById` | 越权：普通管理员可读任意工单原文 + AI 诊断 | ✅ 已修 |
| TB-B02 | 高 | `getUserTickets` / `getAllTickets` | 无分页，返回全部工单 + 全部消息（无上界） | ✅ 已修 |
| TB-B03 | 中 | `TicketSystem.tsx` 回复表单 | 单行 `input` 承载 4000 字回复 | ✅ 已修 |
| TB-B04 | 中 | `getAllTickets` | 无关键词 / 日期筛选 | ✅ 已修 |
| TB-B05 | 中 | 列表（两侧） | 无未读指示、无最后一条预览、无消息数 | ✅ 已修 |
| TB-B06 | 中 | `adminEditMessage` / `adminDeleteMessage` | 整档 `save()`，可覆盖并发消息；按索引删除 | ✅ 已修 |
| TB-B07 | 中 | `TicketSystem.tsx` 列表项 | `div onClick`，不可聚焦、无键盘操作 | ✅ 已修 |
| TB-B08 | 中 | `generateAiTicketResponse` | AI 失败时用户侧完全静默（无任何回复/说明） | ✅ 已修 |
| TB-B09 | 低 | `TicketSystem.tsx` | 无「加载更多」、无错误重试、无深链、回复成功无反馈 | ✅ 已修 |
| TB-B10 | 低 | `TicketSystem.tsx` | 图标按钮缺 `aria-label`；进度浮窗无 `aria-live` | ✅ 已修 |

## 二之二、本轮新增能力（用户要求「尽最大能力添加最多功能」）

### 后端

| 能力 | 位置 | 说明 |
|---|---|---|
| 工单分类 | `ticketModel.category` | `bug/feature/account/billing/other`，创建时可指定、管理端可改可按类筛选 |
| 受理人 / 认领 | `ticketModel.assigneeId/assigneeName` | superadmin 一键认领/退回，列表支持「我受理的 / 未分配」筛选 |
| 内部备注 | `ticketModel.messages[].visibility` | 仅 superadmin 可见可写；WS 走 `notifyTicketInternalNote`（只广播给管理员），列表/详情两处过滤 |
| 管理端综合更新 | `PATCH /api/tickets/admin/:id` | 状态 + 优先级 + 分类 + 受理人一次提交 |
| 批量改状态 | `PATCH /api/tickets/admin/bulk/status` | 列表多选后批量标记已解决/关闭（≤100 条，仅对真正变化者发通知与邮件） |
| 管理端概览 | `GET /api/tickets/admin/stats` | 按状态/优先级/分类分组 + 待回复 + 逾期(>24h) + 最久等待时长 |
| 未读计数 | `GET /api/tickets/unread-count` | 导航角标用，不必拉全量列表 |
| 属主自助关闭 | `PATCH /api/tickets/:id/close` | 用户自己关掉不再需要的工单 |
| 尾消息筛选 | `admin/all?awaitingReply=1&unread=1` | 「待我回复 / 仅未读」在聚合层按尾消息判定 |
| 排序 | `admin/all?sort=updated|created|oldest` | 刻意不提供 priority 排序：字符串字典序不等于紧急度 |

### 前端（新增 `frontend/src/components/ticket/`）

| 组件 | 能力 |
|---|---|
| `ticketConstants.ts` | 状态/优先级/分类展示口径、快捷回复、创建模板、SLA 判定、相对时间 |
| `TicketListItem.tsx` | 未读圆点、分类/优先级/状态徽标、最后一条预览、消息数、逾期标记、内部备注计数、可键盘操作 |
| `TicketFilters.tsx` | 关键词搜索（350ms 防抖）、状态/优先级/分类/受理人筛选、排序、待回复/仅未读快捷开关、清空、CSV 导出、结果计数 |
| `TicketStatsBar.tsx` | 7 张概览卡（待回复/逾期/各状态/总数），点击即应用对应筛选 |
| `TicketComposer.tsx` | 自适应高度多行回复框、`Ctrl/⌘+Enter` 发送、按工单保存草稿、快捷回复、内部备注开关、字数计数 |
| `TicketProcessingToast.tsx` | 处理进度浮窗（去重了原先页面里写两遍的步骤文案）+ `aria-live` |
| `OverLengthMailNotice.tsx` | 超长内容的邮件引导（自 `TicketSystem.tsx` 抽出，控住文件行数） |

其他前端改动：详情页新增复制直达链接、管理端优先级/分类/受理人控件、属主关闭工单、`?ticket=<id>` 深链、消息区内部备注样式与锁标记。

**约束遵守**：`check:ts-file-size` 上限 1500 行 —— `TicketSystem.tsx` 由 1282 涨到 1459 后回落，仍未越界（靠上述组件抽取）。

**按用户要求：前端工单页面零 emoji，全部改用 react-icons**（`FiCpu/FiUser/FiLoader/FiEye` 等）。

---

### TB-B01 — 普通管理员可读任意工单原文与 AI 诊断（高，越权）

- **位置**：`src/controllers/ticketController.ts` `getTicketById`
  ```ts
  const isAdmin = isAdminRole(user.role);
  if (ticket.userId !== user.id && !isAdmin) return res.status(403)...
  res.json(toTicketView(ticket, isAdmin));   // isAdmin=true ⇒ 连 aiErrorDetails 都给出
  ```
- **类型**：授权口径不一致 → 越权读取。
- **证据**：`src/middleware/adminScope.ts` 明确「普通管理员只开放用户管理 / API Key / API Key 计费 / OAuth，其余一律 superadmin」，且 `getAllTickets` 正是挂在 `requireAdminScope` 之后（`ticketRoutes.ts:25`）；同文件的 `replyToTicket` 也显式禁止非 superadmin 管理员代表客服回复。但 `GET /api/tickets/:id` **没有任何范围守卫**，只判 `isAdminRole` ⇒ 只读管理员可以用任意 ObjectId 拉取他人工单全文，并拿到 `aiErrorDetails`（含 AI provider baseUrl / model / 失败原因）。
- **后果**：越权读用户投诉原文；且与 `/admin/all` 的「普通管理员看不了工单原文」注释自相矛盾。
- **改法**：跨用户读取收敛为「工单属主 或 superadmin」；`aiErrorDetails` 只对 superadmin 下发。`replyToTicket` 的返回同样按 superadmin 决定。

### TB-B02 — 工单列表无上界（高）

- **位置**：`getUserTickets`、`getAllTickets`
- **类型**：无分页 / 无投影。
- **证据**：`TicketModel.find(...).sort(...)` 全量返回，且**每条都带完整 `messages`**（AI 回复可达数千字）。管理端列表是全局范围，工单一多即是「大响应 + 慢首屏 + 内存里塞全部对话」。
- **改法**：加 `limit`（默认 50，上限 200）/ `page`，并用 `X-Total-Count` / `X-Has-More` 回传分页信息；新增 `summary=1` 投影（去掉 `messages`，补 `messageCount` / `lastMessagePreview` / `lastSenderRole` / `hasUnread`）供列表使用，**默认响应形状保持数组**以兼容既有调用方。前端列表改用 summary + 选中时再拉详情。

### TB-B03 — 回复框是单行输入框（中）

- **位置**：`frontend/src/components/TicketSystem.tsx` 回复表单 `<input type="text">`
- **类型**：输入体验。
- **证据**：回复上限 `MAX_TICKET_REPLY_LEN = 4000`，却用单行 input 承载；多段描述看不到上下文，长回复只能盲写。创建表单已经是 `textarea`，两处不一致。
- **改法**：改自适应高度的 `textarea`（新行不提交，`Ctrl/Cmd + Enter` 发送），并按 `MAX_TICKET_REPLY_LEN` 显示计数与超长提示。

### TB-B04 — 管理端无搜索 / 无日期筛选（中）

- **位置**：`getAllTickets` + 列表筛选区（仅有 status / priority 两个下拉）
- **改法**：后端支持 `q`（标题/描述/用户名，正则转义）与 `from`/`to`（创建时间）；前端加搜索框、日期区间、清空筛选、结果计数。

### TB-B05 — 无未读指示 / 无最后一条预览（中）

- **位置**：两侧列表卡片（仅标题 + 优先级 + 状态 + 日期）
- **类型**：信息不足 → 管理端无法判断哪些工单需要优先处理。
- **改法**：schema 增 `userLastReadAt` / `adminLastReadAt`，打开详情即标记已读；列表返回 `hasUnread`（最后一条来自对方且晚于本侧已读时间）、`messageCount`、`lastMessagePreview`、`lastSenderRole`；列表卡片显示未读圆点与预览。

### TB-B06 — 管理端改/删消息用整档 `save()`（中，并发）

- **位置**：`adminEditMessage` / `adminDeleteMessage`
- **类型**：并发覆盖 / 索引漂移。
- **证据**：同文件其它写路径都刻意避开整档保存（AI 回复用 `$push`、回复用 CAS 重试），只有这两处 `ticket.messages[idx].content = ...; await ticket.save()`。并发下会把别人刚追加的消息/状态改动整档写回。删除用**索引**，在并发插入后删错条目。
- **改法**：编辑改 `findOneAndUpdate` + `$set` 定位到 `messages.<idx>.content`；删除改为按该消息 `_id` 做 `$pull`（索引不再参与定位）。

### TB-B07 / TB-B10 — 可达性（中/低）

- **TB-B07**：工单列表行是 `motion.div onClick`，键盘用户无法聚焦/打开（应 `role="button"` + `tabIndex` + `onKeyDown`，或用 `<button>`）。
- **TB-B10**：刷新/新建/发送/进度浮窗关闭等图标按钮缺 `aria-label`；进度浮窗是异步状态但无 `aria-live`，读屏用户不知道「正在审查 / 正在生成」。

### TB-B08 — AI 失败时用户侧完全静默（中）

- **位置**：`generateAiTicketResponse`
- **证据**：`aiResponse` 为空或抛异常时只 `wsService.notifyTicketProcess(..., "error")` + 写日志，**不落任何消息**。用户侧于是看到自己的发言后面永远没有回应（`aiErrorDetails` 只对 superadmin 展示）。用户会以为工单没提交成功。
- **改法**：失败且尾消息仍是那条用户发言时，追加一条面向用户的 AI 兜底说明（已收到、已转人工跟进），避免静默。

### TB-B09 — 列表交互缺口（低）

- 无「加载更多」（配合 TB-B02）；`fetchTickets` 失败只有一句 toast、无 inline 重试；不支持 `?ticket=<id>` 深链（无法从通知/邮件直达某工单）；回复成功无反馈且不保证滚到底。

---

## 三、改动去向

见同批提交（提交信息引用本清单路径）。逐条核对结果：

- TB-B01～TB-B10 全部已修，见 `src/controllers/ticketController.ts`、`src/utils/ticketView.ts`、`frontend/src/components/TicketSystem.tsx` 及新增 `frontend/src/components/ticket/*`。
- 回归锁：新增 `src/tests/ticketViewSummary.test.ts`（内部备注可见性边界 + 摘要未读判定）。
- 最终状态以本仓库 CI 结论为准（本地不构建/不测试）。
