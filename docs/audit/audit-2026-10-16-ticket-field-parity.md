# 工单系统「前后端对照」补齐 — 审查与改动清单（2026-10-16）

> 依据 `F:\Repositories\GitHub\verified-methodology.md`：阶段 1 只做静态审查并**先落盘清单**（§一-8），
> 修复按编号逐条对账；本机不构建 / 不测试 / 不装依赖，最终以 GitHub Actions 结论为准。
> 基线：`main`（审查开始时 HEAD `a23fe21b`，工作树干净）。方式：逐文件通读 `/support` 链路（后端
> `src/{models,controllers,routes,utils}` + 前端 `TicketSystem.tsx` 与 `components/ticket/*`）、
> 与 `docs/governance/privacy-data-map.json`、`src/middleware/routeLimiters.ts` 对照，未运行任何命令式验证。

## 一、参照物与范围

参照物是用户提供的**生产工单票面**，它定义了「一个工单应该有哪几项信息」：

| 票面字段 | 说明（票面原文） |
|---|---|
| 姓名 | 提交人 |
| 邮件地址 | 联系邮箱 |
| 主题 | 标题 |
| 问题分类 | 性能问题 / 产品问题 / 财务问题 |
| 相关服务 | 具体服务实例（形如 `SV-VPS/Cloud-VM(Shared) - P1QSHWWXRGNITST(有效的)`） |
| 类型 | 咨询 / 故障 |
| 关联工单 | 无 / 关联到既有工单 |
| 信息 | 正文 |
| 附件 | `.jpg/.gif/.jpeg/.png/.txt/.pdf`；不支持中文名称；单个不超过 1M |

范围：用户端 `/support` 与共用的管理端视角（`TicketSystem.tsx`）+ 后端 `/api/tickets*` 全链路。

## 二、结论摘要

两端**已经一致**的部分（逐项核对过，不动）：标题 / 正文 / 消息与内部备注 / 状态 / 优先级 / 分类 /
受理人认领 / 未读水位 / 分页 / 关键词与尾消息筛选 / 批量改状态 / 概览统计 / 属主自助关闭 /
管理端改状态与改删消息 / AI 应答与兜底 / 邮件通知 / WebSocket 推送 / 限流器。

缺口分三类：

1. **票面有、两端都没有**（5 项，必须两端一起补，缺一侧就是半成品）：
   联系邮箱、工单类型、相关服务（+ 补充说明）、关联工单、附件。
2. **两端口径不一致的真实缺陷**（3 项：TP-06 / TP-07 / TP-09）。
3. **后端有能力、前端无入口**（2 项：TP-08 日期区间筛选、TP-10 每页条数）。

## 三、发现清单

| 编号 | 严重度 | 侧 | 位置 | 类型 | 状态 |
|---|---|---|---|---|---|
| TP-01 | 中 | 前后端 | `ticketModel` / `TicketSystem.tsx` 创建表单 | 票面字段缺失：联系邮箱 | 待修 |
| TP-02 | 中 | 前后端 | 同上 | 票面字段缺失：工单类型（咨询 / 故障） | 待修 |
| TP-03 | 中 | 前后端 | 同上 | 票面字段缺失：相关服务 + 具体资源/任务说明 | 待修 |
| TP-04 | 中 | 前后端 | 同上 | 票面字段缺失：关联工单 | 待修 |
| TP-05 | 高 | 前后端 | 同上 + 无附件接口 | 票面字段缺失：附件（上传 / 下载 / 删除 / 规则） | 待修 |
| TP-06 | 中 | 后端→前端 | `ticketController.adminEditMessage`、`adminDeleteMessage` | 响应未带 `includeInternal`：superadmin 改/删一条消息后，**同一响应里内部备注被过滤掉**，前端 `setSelectedTicket(updated)` 立刻把它们从界面上抹掉（要刷新才回来） | 待修 |
| TP-07 | 低 | 前后端 | `frontend/src/components/TicketSystem.tsx` `toSummary` | WS `ticket:update` 走本地 `toSummary`，`ageHours` 恒为 0 ⇒ 管理端「逾期」徽标与 `formatTicketAge` 在 WS 更新过的行上失效（列表刷新后才有值） | 待修 |
| TP-08 | 低 | 后端有 / 前端无 | `getAllTickets` 已支持 `from`/`to`；`TicketFilters.tsx` 无日期控件 | 能力缺口：无法按创建时间区间筛选巡检 | 待修 |
| TP-09 | 低 | 前端 | `frontend/src/api/ticketApi.ts` `createTicket` 形参类型 | `{title, description, priority?}` 未声明 `category`：字段是「靠变量多余属性被放行」传过去的，将来收紧成对象字面量即静默丢字段 | 待修 |
| TP-10 | 低 | 后端有 / 前端无 | `getAllTickets` 支持 `limit` ≤ 200；前端固定 50 | 能力缺口：每页条数不可调 | 待修 |
| TP-11 | 低 | 后端有 / 前端无 | `getAllTickets` 支持 `assignee=<userId>`；前端只有「我受理的 / 未分配」 | 能力缺口：不能按指定客服筛选（需要管理员列表，**挂起**：本轮不引入新的用户检索接口） | 挂起 |
| TP-12 | 中 | 治理 | 新增附件落库 | 存储责任：隐私数据地图里没有工单/附件条目，本轮补 `tickets` + `ticket_attachments` 两个数据集并重生 `src/generated/privacyDataMap.ts` | 待修 |

### 逐条细节

**TP-01 联系邮箱**：票面「邮件地址」在两端都不存在——后端只存 `username`，通知一律取账号邮箱。
改为：工单落库时快照 `contactEmail`（缺省取账号邮箱，格式校验，≤254 字），管理端可见 / 可改；
通知仍**只发账号邮箱**，仅在账号没有邮箱时用 `contactEmail` 兜底 —— 否则等于给了一个「把通知改寄到任意地址」
的入口，属于把邮件通道变开放重定向。

**TP-02 工单类型**：`inquiry`（咨询）/ `incident`（故障）。与既有 `category`（问题分类）是两维信息：
分类回答「哪方面的问题」，类型回答「是不是坏了」。两者都可筛选、都进概览统计。

**TP-03 相关服务**：票面的「相关服务」是服务实例 ID（`SV-VPS/... - P1QSHWWXRGNITST`）。
Synapse 没有「服务实例」注册表，所以落成两层：`relatedService`（枚举：本平台模块，见契约）+ 
`relatedServiceRef`（自由文本 ≤120，写具体任务 / 资源 / 订阅 ID）。管理端可按模块筛选。

**TP-04 关联工单**：存 `{ ticketId, title }` 快照数组（≤5 条），创建时校验「每个 ID 都真实存在、
且属于同一属主」（superadmin 可跨属主关联）。存标题快照是为了列表/详情不用额外查询即可渲染，
代价是标题改后快照会旧 —— 详情里以快照标题渲染并链接到 `?ticket=<id>`，可接受。

**TP-05 附件**（最重的一项）：
- 规则按票面：白名单 `.jpg/.jpeg/.png/.gif/.txt/.pdf`、单文件 ≤ 1 MB、**文件名不支持非 ASCII**（中文名直接拒绝并说明原因）、单工单 ≤ 5 个。
- 存储：新集合 `ticket_attachments`（**本仓用户存储已统一为 MongoDB**，见 `scripts/start-with-file-storage.sh`；不引入本地磁盘 / 新对象存储）。
  正文以 `Buffer` 落库，**不进 Ticket 文档** —— 列表接口会整档读 `tickets`，1 MB 附件混在文档里会让列表变成大 IO。
- 校验：扩展名 + MIME 白名单 + **魔数**（jpg/png/gif/pdf 必须与声明的 MIME 一致）；`.txt` 走既有
  `ModerationService.checkContentWithAi`（属主上传时），其余类型不做内容审核（图片/PDF 无廉价审核通道，靠白名单 + 体积上限 + 属主可见性约束）。
- 权限：上传/下载/删除都要求「工单属主 或 superadmin」；已关闭工单不允许再上传（与「终态工单不再对话」一致）。
- 下载：`Content-Disposition: attachment` + 仅 ASCII 文件名 + `X-Content-Type-Options: nosniff`，不做内联渲染。
- 列表侧只暴露 `attachmentCount`（由附件接口 `$inc` 维护），详情侧才带附件元数据。

**TP-06**：`res.json(toTicketView(updated, true))` 少了 `{ includeInternal: true }`（同文件其它管理端写路径都带）。
后果：superadmin 编辑/删除消息后，前端拿到的工单里内部备注消失，界面上「内部备注（用户不可见）」整段被抹掉。

**TP-07**：`TicketSystem.tsx` 的 `toSummary` 是 WS 推送路径的本地投影，`ageHours: 0` 写死。

**TP-08 / TP-10**：后端 `/admin/all` 已实现 `from`/`to` 与 `limit`（上限 200），前端没有入口 —— 属于「后端有、前端缺」。

**TP-09**：`createTicket(data: { title: string; description: string; priority?: string })`，而调用方传的
`newTicket` 还带 `category`；TS 允许变量多余属性，所以现在能跑，但类型没把契约写全。

## 四、契约（本轮两端必须一致的部分）

### 4.1 数据模型新增字段（`tickets`）

| 字段 | 类型 | 说明 |
|---|---|---|
| `type` | `"inquiry"｜"incident"`，默认 `inquiry`，索引 | 工单类型（咨询 / 故障） |
| `relatedService` | 枚举，默认 `other`，索引 | 相关服务（平台模块） |
| `relatedServiceRef` | `string \| null`，≤120 | 相关服务的具体资源 / 任务说明 |
| `contactEmail` | `string \| null`，≤254 | 联系邮箱快照（缺省取账号邮箱） |
| `relatedTickets` | `[{ ticketId, title }]`，≤5 | 关联工单快照 |
| `attachmentCount` | `number`，默认 `0` | 附件计数（列表徽标；由附件接口维护） |

`relatedService` 允许值（两端同一份顺序）：
`tts` 语音合成 · `transcribe` 语音转写 · `librechat` 智能对话 · `geogebra` 数学画板 · `pixel` 图片处理 ·
`lottery` 抽奖活动 · `store` 资源商店 · `articles` 文章 · `shortlink` 短链 · `outemail` 发信 ·
`image-upload` 图床 · `api` API 调用 · `account` 账号与登录 · `billing` 计费与额度 · `other` 其他

类型标签：`inquiry` 咨询 · `incident` 故障

### 4.2 新增集合（`ticket_attachments`）

`ticketId`(索引) / `userId` / `username` / `fileName` / `ext` / `mimeType` / `size` / `sha256` / `data`(Buffer) / `createdAt`

上限常量（两端镜像，后端是安全边界、前端只做即时提示）：
`MAX_TICKET_ATTACHMENTS = 5`、`MAX_TICKET_ATTACHMENT_BYTES = 1MB`、
`TICKET_ATTACHMENT_EXTS = ["jpg","jpeg","png","gif","txt","pdf"]`

### 4.3 接口

| 方法 | 路径 | 变化 |
|---|---|---|
| `POST /api/tickets` | body 新增 `type` / `relatedService` / `relatedServiceRef` / `contactEmail` / `relatedTicketIds[]` |
| `PATCH /api/tickets/admin/:id` | 新增可改 `type` / `relatedService` / `relatedServiceRef` / `contactEmail` / `relatedTickets` |
| `GET /api/tickets/admin/all` | 新增筛选 `type`、`service`（既有 `from`/`to`/`limit` 前端本轮接上） |
| `GET /api/tickets/admin/stats` | 新增按 `type`、`service` 分组 |
| `POST /api/tickets/:id/attachments` | 新增：multipart 字段 `file`，返回 `{ attachment, attachmentCount }` |
| `GET /api/tickets/:id/attachments/:attachmentId/download` | 新增：流式下载（属主 / superadmin） |
| `DELETE /api/tickets/:id/attachments/:attachmentId` | 新增：上传者本人或 superadmin |
| `GET /api/tickets/:id` | 详情响应新增 `attachments[]`（元数据，不含 `data`） |
| `GET /api/tickets`（summary） | 摘要新增 `type` / `relatedService` / `attachmentCount` 等 |

限流：新增 `ticketUpload` 限流档（10 分钟 20 次），挂在上传与删除上。

## 五、改动清单（按批对账）

**批次 1（后端 + 治理）**
- `src/models/ticketModel.ts`：6 个新字段 + 关联子 schema + 索引
- `src/models/ticketAttachmentModel.ts`（新）
- `src/utils/ticketAttachments.ts`（新）：白名单 / 体积 / 文件名 / 魔数 / 摘要投影
- `src/utils/ticketView.ts`：摘要与详情暴露新字段
- `src/controllers/ticketController.ts`：创建 / 更新 / 筛选 / 统计 / 附件三端点 + TP-06 修复
- `src/routes/ticketRoutes.ts`：附件路由（静态段在 `/:id` 之前）
- `src/middleware/routeLimiters.ts`：`ticketUpload`
- `docs/governance/privacy-data-map.json` + `src/generated/privacyDataMap.ts`：`tickets`、`ticket_attachments` 两个数据集
- `src/tests/ticketAttachmentPolicy.test.ts`（新）、`src/tests/ticketViewSummary.test.ts`（补新字段断言）

**批次 2（前端）**
- `frontend/src/api/ticketApi.ts`：类型 + 新方法（含 TP-09 类型收紧）
- `frontend/src/components/ticket/ticketConstants.ts`：类型 / 相关服务 / 附件规则 / 标签
- `frontend/src/components/ticket/TicketAttachments.tsx`（新）：选择、上传进度、失败重试、下载、删除
- `frontend/src/components/ticket/TicketDetailMeta.tsx`（新）：类型 / 相关服务 / 联系邮箱 / 关联工单（含管理端编辑与关联选择）
- `frontend/src/components/ticket/TicketFilters.tsx`：类型 / 服务 / 日期区间 / 每页条数（TP-08、TP-10）
- `frontend/src/components/ticket/TicketListItem.tsx`：类型 / 服务 / 附件徽标
- `frontend/src/components/TicketSystem.tsx`：创建表单新字段 + 详情元信息 + 附件接线 + TP-07 修复

## 六、验证

- 静态：新增/改动文件的类型与调用链自查（`ticketApi` ↔ 控制器 ↔ 视图三段字段名逐一对照）。
- CI：`Node Verification`（后端 Jest + 前端 Vitest + 类型 + 治理闸门）与 `Quality Guardrails`
  （隐私契约、体积闸门、前端构建与预算）全绿即判通过；本地不跑任何构建/测试。
- 逐条对账：本节编号 TP-01～TP-12 在收尾时逐条标注去向（已修 / 挂起理由）。
