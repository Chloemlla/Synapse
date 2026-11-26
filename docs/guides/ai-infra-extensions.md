# AI 基础设施用法：识图能力位、一次性调用与结构化抽取

> 适用对象：要在 Synapse 后端调大模型的人（内部服务、评测、新业务），以及在管理端配 LibreChat 提供者的运维。
> 背景计划：`docs/plans/2026-11-26-librechat-ai-infra-x1-x4.md`。本文只讲**怎么用**与**为什么这样设计**，不重复实现细节。

涉及的文件（都在 `src/services/librechat/` 与 `src/services/libreChatService.ts`）：

| 位置 | 职责 |
|---|---|
| `libreChatService.sendMessage(..., { parts })` | 用户聊天通路：带历史、带 SSE、带内置客服系统提示 |
| `libreChatService.chatOnce(...)` | 一次性上游调用：不写历史、不 SSE、系统提示由调用方给 |
| `libreChatService.extractStructured(...)` | 一次性调用 + JSON 解析 + 字段校验（可含一次修复轮） |
| `libreChatService.extractStructuredQuorum(...)` | 多票表决的结构化抽取 |
| `librechat/selection.ts` | 按能力位/分组/排除项选 provider（纯函数） |
| `librechat/wire.ts` | 三种协议请求体构造 + 图片件校验 |
| `librechat/structured.ts` / `structuredRunner.ts` | JSON 抽取、schema 校验、修复轮、表决 |
| `librechat/diagnostics.ts` | 失败原因 → 一句人话（`summary`） |

---

## 1. 「支持识图」这个能力位

后端契约（`routes/libreChatRoutes.admin.ts`）：

- `POST /api/librechat/admin/providers` 的 body 里 `vision` **只认严格布尔 `true`**；缺字段、`"true"`、`1`、`null` 全部落成 `false`。
- `GET /api/librechat/admin/providers` 每条都返回 `vision: boolean`，老文档没有该字段时返回 `false`。
- 语义是 **fail-closed**：没勾上的 provider **不会收到带图片的请求**。请求会在真正打上游**之前**被拒，并给出原因，而不是「把图剔掉再回答」——后者会得到一个假装看过图的答案，比失败更难被发现。

管理端怎么勾：运行时配置页 →「LibreChat 提供者配置」→ 勾「支持识图」→ 新增/更新。
列表的「识图」列（移动端是详情卡里的「识图：是/否」）就是后端回读的值，不是前端自己记的草稿。

界面上的文案刻意只讲「勾上后这个模型能看图；不勾就只会当纯文本模型用」，把张数上限、体积上限、失败口径这类实现细节收在表单下方的可展开「详情」里——面向管理员的话术不该出现协议名和内部术语。

新增 provider 时前端要动三处，缺一处就会出现「类型里有、payload 里没有」的假接通：

1. `frontend/src/components/env-manager/types.ts` 的 `ChatProviderItem`
2. `LibreChatProvidersSection.tsx`：表单勾选 + 表格列 + 移动端详情卡回显
3. `SelfContainedLibreChatProvidersSection.tsx`：保存 payload 带 `vision`，**并且**列表回填时 `row.vision === true` 归一（别把 `undefined` 透传进表单）

---

## 2. `CHAT_VISION=1`：环境变量兜底口径

当数据库里一个 provider 都没有（或 Mongo 不可用）时，服务会用环境变量组一个兜底 provider：

- `CHAT_BASE_URL` + `CHAT_API_KEY` **都**存在才算配置（另可用 `CHAT_MODEL`，默认 `gpt-oss-120b`；`CHAT_WIRE` 选协议格式）。
- 这个兜底 provider **默认不算能识图**：只有 `CHAT_VISION=1` 才抬这个位。
- 判定是**严格字符串比较** `process.env.CHAT_VISION === "1"`。写 `CHAT_VISION=true`、`CHAT_VISION=yes`、或带空格的 `1 ` 都**不生效**——这一点和后端「只认真 `true`」是同一个 fail-closed 立场，别指望有宽松解析。

选型建议：生产环境优先在管理端勾（可随时改、有审计、按 provider 粒度生效）；`CHAT_VISION=1` 只用于「整个部署就一个上游、且确定它能看图」的单机/自测场景。它是**全局**开关，会把兜底 provider 抬成能看图，无法按模型区分。

---

## 3. 三个新入口各自什么时候用

| 入口 | 什么时候用 | 拿到什么 |
|---|---|---|
| `chatOnce` | 只想要一段自由文本（判定、摘要、改写、翻译），不需要会话历史、不需要 SSE | `{ ok:true, text, provider }`；失败 `{ ok:false, reason, diagnostics, issues? }` |
| `extractStructured` | 需要**固定字段**的结果，一次调用足够（内含最多 1 次自动修复轮） | 成功 `{ ok:true, value, notes, droppedKeys, repairs }`；失败带 `code` |
| `extractStructuredQuorum` | 关键结论、要抑制单模型抖动；能接受多花几倍延迟与额度 | 逐字段多数表决的结果 + `coverage` + `votes` + `distinctProviders` |

三条通用规则：

- **别用 `sendMessage` 做内部判定**：那条通路带历史回灌和内置客服系统提示，一次性判定读到上一轮内容就是「串味」；而且用户聊天通路有额度桶，内部服务不该蹭（`chatOnce` 是独立入口）。
- 带图片时用**内容件数组**，而不是拼字符串：`[{ type: "text", text: "…" }, { type: "image", dataUrl }]`。
- `requirement` 用来收窄选路：`{ group }` 按分组路由，`{ exclude }` 排掉已用过的 provider，`{ requireVision: true }` 只留能看图的。**注意副作用**：`requireVision` 会把候选池过滤空，此时你拿到的是 `no_provider_configured` 而不是 `vision_unavailable`——想区分「没配 provider」和「没人能看图」，就依赖默认的 fail-closed 判定，别传 `requireVision`。

```ts
// 只想要一段文字（带图）
const once = await libreChatService.chatOnce({
  system: "看这张图，只回一句话结论。",
  messages: [{ role: "user", content: [
    { type: "text", text: prompt },
    { type: "image", dataUrl },
  ] }],
});
if (!once.ok) return fail(once.diagnostics.summary); // 一句人话，可直接给管理员看

// 固定字段，且要在多模型间求稳
const q = await libreChatService.extractStructuredQuorum({
  spec: { fields: [{ name: "category", type: "enum", enumValues: [...], required: true }] },
  user: [{ type: "text", text: prompt }],
  votes: 3,
  minVotes: 2,
});
if (!q.ok) return fail(q.message); // 弃权，不猜
```

`extractStructuredQuorum` 的 `distinctProviders: false` 是有意的诚实信号：可用 provider 不够时票会复用同一个模型，此时「3 票」并不代表 3 个独立意见，别拿它当共识强度用。

---

## 4. 失败 code 表

### 4.1 `chatOnce` 的 `reason`（`ChatFailureReason`）

| reason | 含义 | 该怎么处理 |
|---|---|---|
| `no_provider_configured` | 一个可用 provider 都没有（全停用 / 必填缺失 / 被 `requirement` 过滤空） | 去管理端补配置；不要重试 |
| `all_providers_failed` | 候选都试过了，上游都失败 | 看 `diagnostics.attempts`：逐 provider 的 `status`/`code`/`message`（已脱敏、不含凭据） |
| `vision_unavailable` | 请求带图，但候选里没有一个勾了「支持识图」 | 勾上 `vision` 或让用户改用文字描述；`attempts` 为空数组，**因为压根没查上游** |
| `content_rejected` | 图片件本身不合格（见 4.3） | 看 `issues[]` 里每张图的原因码 |

### 4.2 结构化结果的 `code`（`StructuredErrorCode`）

| code | 含义 | 是谁的问题 |
|---|---|---|
| `INVALID_INPUT` | 连要处理的内容都没有 | 调用方的 bug |
| `EMPTY_OUTPUT` | 上游回了空 | 模型/上游 |
| `PARSE_FAILED` | 回了内容但提不出 JSON 对象 | 模型；换 `responseFormat` 或加提示 |
| `SCHEMA_FAILED` | 有 JSON，但字段不符合 spec（缺必填、类型不对、越枚举） | 模型；看 `issues[]` 的逐字段原因 |
| `NO_CONSENSUS` | 表决过了，没有任何字段凑够多数 | 结论本身不稳；**不是**失败重试的信号 |
| `INVOCATION_FAILED` | 调用没成功 / 成功票数不足 `minVotes`（「没问到」≠「没谈拢」） | 配置或上游可用性 |

硬约束（G-06）：失败**一定**带 `code` 与可读 `message`，绝不返回一个编造出来的默认对象。写调用方时也别把 `ok:false` 兜成 `{}` 继续往下跑。

### 4.3 图片件被拒的原因码（`InlineImageRejection`）

只接受内联的 base64 图片件，且：单张解码后 ≤ 4 MB、一次 ≤ 4 张、类型限 `png / jpeg / webp / gif`。

| code | 含义 |
|---|---|
| `EXTERNAL_IMAGE_NOT_ALLOWED` | 传了 `http(s)://` 外链（不让上游替我们去取地址） |
| `NOT_A_DATA_URL` | 既不是内联 data URL 也不是外链 |
| `NOT_BASE64` | data URL 少了 `;base64` |
| `UNSUPPORTED_IMAGE_TYPE` | MIME 不在支持列表里 |
| `EMPTY_IMAGE` | 头有了、载荷是空的 |
| `IMAGE_TOO_LARGE` | 单张超过 4 MB |
| `TOO_MANY_IMAGES` | 一次超过 4 张 |

`issues[].index` 指向出问题的第几个件；`TOO_MANY_IMAGES` 的 `index` 是 `-1`（不属于单个件）。

---

## 5. 「图片不入库、下一轮追问看不到图」——刻意取舍

现状：`sendMessage` 的 `parts` 只拼到**本轮**最后一条用户消息的上游请求上；写进历史时被压成纯文本（`contentPartsToPlainText` 只保留文字件）。所以：

- 聊天记录、搜索、导出、管理端历史页**都看不到图**，只有文字；
- 下一轮追问时模型**看不到上一轮那张图**。要继续聊同一张图，就得再附一次，或者把上一轮的看图结论落成文字。

为什么这样取舍（而不是「反正要存，存下来更省事」）：

- 历史会被回灌进后续每一轮 prompt。图一旦入库，同一张图会反复发给不同 provider——其中可能包含没勾「支持识图」的那些，也可能体积/合规上根本不该出现这张图，等于把一次性的东西变成了长期扩散。
- 历史还要进搜索、导出、管理员视图、隐私数据地图。图片是二进制个人数据，落库就得整套跟着管起来，收益不匹配。
- 一次性通路（`chatOnce` / 两个 `extract*`）压根不写会话历史，也就没有「图入库」这个入口。

所以：**图是本轮的临时输入，不是会话内容**。若某个内部服务确实要跨轮保留图片，那是它自己的存储决定（带自己的生命周期与权限），不要往聊天历史文档上塞。

---

## 6. 加新能力位时的检查清单

沿用 `vision` 的同一条链，缺一环就是「假接通」：

1. schema 默认值与后端读写白名单（`librechat/models.ts` + `routes/libreChatRoutes.admin.ts` 的 list 与 upsert），非法值一律归一到保守侧；
2. 选路纯函数里的过滤（`selection.ts`），保持可注入随机、可单测；
3. 消费点的 fail-closed 判定 + `diagnostics.ts` 的 `FAILURE_SUMMARIES` 补一条人话（**新增 reason 必须补文案**，否则会写成「全部 0 个调用均失败」）；
4. 管理端：类型字段 + 表单控件 + 列表回显 + 保存 payload + 列表归一；
5. 本文档补一句「怎么开、不开会怎样」。
