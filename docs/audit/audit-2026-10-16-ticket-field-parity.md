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
| TP-13 | 中 | 前后端 | 附件上传权限口径 | **普通用户上传文件默认关闭**，需超管在后台手动开启；开启前只能以「附件链接」提交。默认开启会把任意二进制收进库，而白名单只能拦类型、拦不住内容 | 待修 |
| TP-14 | 中 | 前后端 | `TicketAttachments.tsx` / `TicketCreateForm.tsx` | **附件 URL 输入框在开关关闭与打开时都要有**（票面要求）：关闭时它是主通道，打开时它是「不占本站存储」的补充通道 | 待修 |

### 逐条细节

**TP-13 / TP-14 附件上传权限（默认关闭 + 链接兜底）**

附件是用户上传的**任意二进制**：扩展名/MIME/魔数白名单只能挡住「类型不对」与「扩展名伪装」，挡不住
「类型对但内容是恶意文件」或大量垃圾。因此默认**不对普通用户开放文件上传**，由超管在后台手动开启：

- 开关实体：运行时配置 `TICKET_ATTACHMENTS.userUploadEnabled`（默认 `false`，Mongo 存储、保存即生效、
  多实例 ≤10s 收敛）；管理端接口 `GET/POST/DELETE /api/admin/ticket-attachments/setting`；
  管理 UI 在工单管理台的「普通用户附件上传」卡片（超管可见）。
- 关闭时：普通用户上传接口返回 403（`ATTACHMENT_UPLOAD_DISABLED`），提示改用附件链接或联系管理员；
  已存在的附件仍可下载与删除（不因关开关而丢数据）。
- 开启时：普通用户可上传（jpg/jpeg/png/gif/txt/pdf、单个 ≤1MB、每工单 ≤5 个），
  `.txt` 过同一套 AI 内容审查，避免附件成为绕过工单文本审查的直通车。
- 管理员/超管不受该开关限制（他们本来就能改工单内容）。
- **附件链接输入框在两种状态下都展示**：关闭时它是提交截图的主通道；打开时它仍然有用
  （图床/网盘地址不占本站存储、不需要先传文件）。链接只做形态校验（仅 http/https、≤2048 字），
  本站**从不代取**这些 URL（不引入 SSRF 面），渲染时 `rel="noopener noreferrer nofollow"`。

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
| `attachmentLinks` | `[{ url, label }]`，≤5 | 附件链接（仅 http/https，只存 URL 不代取） |
| `attachmentCount` | `number`，默认 `0` | 文件附件计数（列表徽标；由附件接口维护） |

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
| `PUT /api/tickets/:id/attachment-links` | 新增：属主 / superadmin 整体替换附件链接（关闭与打开状态下都可用） |
| `GET /api/tickets/capabilities` | 新增：`canUploadAttachments` + 上传说明 + 各类限额（前端据此决定渲染上传入口还是仅链接输入框） |
| `GET/POST/DELETE /api/admin/ticket-attachments/setting` | 新增：超管开关「普通用户可上传附件」（默认关闭，写入运行时时配置 `TICKET_ATTACHMENTS`） |
| `GET /api/tickets/:id` | 详情响应新增 `attachments[]`（元数据，不含 `data`） |
| `GET /api/tickets`（summary） | 摘要新增 `type` / `relatedService` / `attachmentCount` 等 |

限流：新增 `ticketUpload` 限流档（10 分钟 20 次），挂在上传与删除上。

## 五、改动清单（按批对账）

> 说明：本 clone 由多个会话共用。批次 1（后端字段/附件策略 + 隐私地图）与批次 2 的前半
> （运行时配置接线 + `ticketApi`/`ticketConstants` 骨架）已被并行会话按“收编在飞 WIP 快照”提交为
> `4896ca34`、`3b02dcf5`（提交信息里写明了来源），本文件与其余改动在同批次的后续提交中补齐。
>
> **未做（有意）**：env-manager 的「工单附件」卡片。原因是 `frontend/src/components/EnvManager.tsx`
> 当时正被并行设计语言批次修改，改动同一文件会把对方的在飞 WIP 一起带进提交（§三 的暫存区污染风险）。
> 当前开关已可从工单管理台（超管可见的「普通用户附件上传」卡片）与
> `GET/POST/DELETE /api/admin/ticket-attachments/setting` 修改；待 EnvManager.tsx 空闲后再补分区即可，
> 数据与接口无需再改。

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
- `frontend/src/api/ticketApi.ts`：类型（类型/服务/关联/附件/链接/能力）+ 新方法（含 TP-09 类型收紧）
- `frontend/src/components/ticket/ticketConstants.ts`：类型/服务/附件规则/链接校验/体积格式化
- `frontend/src/components/ticket/TicketAttachments.tsx`（新）：`TicketAttachmentLinks`（链接输入框，两种状态都显示）/`TicketAttachmentPicker`/`TicketAttachmentList`
- `frontend/src/components/ticket/TicketCreateForm.tsx`（新）：创建表单全量票面字段（从 `TicketSystem.tsx` 抽出，控制体积闸门）
- `frontend/src/components/ticket/TicketDetailMeta.tsx`（新）：详情元信息 + 超管就地改字段 + 关联工单选择器
- `frontend/src/components/ticket/TicketAttachmentSettingsCard.tsx`（新）：超管的附件上传开关卡片
- `frontend/src/components/ticket/TicketFilters.tsx`：类型 / 服务 / 日期区间 / 每页条数（TP-08、TP-10）
- `frontend/src/components/ticket/TicketListItem.tsx`：类型 / 服务 / 附件与链接计数徽标
- `frontend/src/components/TicketSystem.tsx`：能力拉取、创单后附件上传、附件链接乐观提交、TP-07 修复
- `frontend/src/tests/ticketFieldParity.test.ts`（新）：服务清单与后端一致（漂移即失败）+ 附件/链接预校验

**批次 3（开关与链接通道，对应 TP-13 / TP-14）**
- `src/models/runtimeConfigModel.ts`、`src/config/runtimeConfigDefaults.ts`、`src/services/runtimeConfigService.ts`：
  `TICKET_ATTACHMENTS` 分区（默认 `userUploadEnabled: false`）+ get/set/delete
- `src/controllers/adminController.ts`、`src/routes/admin/config.ts`：`/api/admin/ticket-attachments/setting`（读管理员 / 写超管 / 审计）
- `src/models/ticketModel.ts`、`src/utils/ticketAttachments.ts`、`src/utils/ticketView.ts`：`attachmentLinks` 字段 + 链接校验/视图
- `src/controllers/ticketController.ts`、`src/routes/ticketRoutes.ts`：`/capabilities`、`PUT /:id/attachment-links`、上传开关门控
- `frontend/src/components/ticket/TicketAttachmentSettingsCard.tsx`：开关卡片

## 六、验证

- 静态：新增/改动文件的类型与调用链自查（`ticketApi` ↔ 控制器 ↔ 视图三段字段名逐一对照）。
- CI：`Node Verification`（后端 Jest + 前端 Vitest + 类型 + 治理闸门）与 `Quality Guardrails`
  （隐私契约、体积闸门、前端构建与预算）全绿即判通过；本地不跑任何构建/测试。
- 本地静态校验（非构建）：`check-slicing-and-softdelete`、`check-privacy-contract`、
  `generate-privacy-data-map --check`、`check-ts-file-size`、`check-frontend-design-language` 全部通过
  （附件删除与运行时配置重置两处裸删除按闸门口径逐行标注 `soft-delete-exempt` 并写明理由，
  基线数量保持 124 不变，只有行号刷新）。
- 逐条对账：本节编号 TP-01～TP-14 在收尾时逐条标注去向（已修 / 挂起理由）。
