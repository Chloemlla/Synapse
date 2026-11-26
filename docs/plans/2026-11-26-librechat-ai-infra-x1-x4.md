# LibreChat AI 基建扩展 X1–X4 · 实施规格（编号清单）

> 2026-11-26。依据 `AGENTS.md` §0/§4/§5/§8、`verified-methodology.md` §一-8、§六。
> 本文是实现与收尾的**唯一依据**：每处改动都能指回一个编号；每条都有去向（已实现 / 挂起理由）。

## 0. 全局约束（G 项）

| # | 约束 | 落实方式 |
|---|---|---|
| G-01 | **零新依赖** | 只用已有的 `axios` / `mongoose` / node 内置；不动 `package.json`、一个字节不碰 `pnpm-lock.yaml` |
| G-02 | **向后兼容、老数据零迁移** | 新字段一律可选 + 归一化回退（照 `normalizeWire()`：空/非法 → 默认值）；`chat_providers` 老文档没有 `vision` 就当 `false` |
| G-03 | **不写超级文件** | `libreChatService.ts` 已 1842 行（超限遗留，仅容忍 +300 行）→ 本次对它的新增 ≤ 120 行，其余全部进 `src/services/librechat/` 新模块（纯函数、可单测） |
| G-04 | **文本请求体逐字节不变** | `wire.ts` 注释钉住"openai-chat 输出与改造前逐字节一致"；只有显式传 `parts` / `responseFormat` 时才多出键 |
| G-05 | **不落图片字节** | X1 的图只用于**当轮**上游调用，不写历史、不写文件、不进 Mongo → 隐私数据地图无漂移（`check:privacy-data-map` 不红） |
| G-06 | **拒绝要带稳定 code**（AGENTS §8） | 结构化/投票失败返回 `{ ok: false, code, issues }`，绝不返回编造的默认值（对齐 Pixel 管理端"无数据显式 null 与原因"） |
| G-07 | **不新增 HTTP 路由** | 本次是"修路"，不加用户端点 → `check:admin-spa-paths` / `check:openapi-drift` 不受影响；只在既有 `/admin/providers` 上加一个字段 |
| G-08 | **软删除与响应切片闸门** | 不写 `deleteOne/deleteMany`；列表响应沿用既有映射裁剪（`check:slicing-and-softdelete` 只报新增） |

## 1. X1 多模态内容件（vision）

| # | 条目 | 落点 | 判据 |
|---|---|---|---|
| X1-01 | `ChatContentPart = {type:"text";text} \| {type:"image";dataUrl;mediaType?}`；`WireChatMessage.content` 由 `string` 放宽为 `string \| ChatContentPart[]` | `librechat/wire.ts` | 单测：纯文本消息产出的 body 与改动前**完全一致**（快照） |
| X1-02 | 只接受 **`data:` URL**（`data:image/(png\|jpeg\|webp\|gif);base64,`），拒绝 `http(s)://` 外链 | `wire.ts: parseInlineImage()` | 单测：外链被拒 + 原因码 `EXTERNAL_IMAGE_NOT_ALLOWED`（防把 SSRF 交给上游） |
| X1-03 | 体积与张数上限：单图 base64 ≤ 4 MB、每次 ≤ 4 张、超限返回原因码 | `wire.ts` 常量 + `assertContentParts()` | 单测：超限被拒、边界值通过 |
| X1-04 | 三种线格式各自的图片件构造：chat→`content[].image_url.url`；anthropic→`content[].{type:"image",source:{type:"base64",media_type,data}}`；responses→`input[].{type:"input_image",image_url}` | `wire.ts: buildWireRequest()` | 单测：三协议各钉一组请求体 |
| X1-05 | provider 能力位 `vision`（schema 默认 `false`） | `librechat/models.ts`、`routes/libreChatRoutes.admin.ts`（list + upsert 白名单）、`frontend/.../env-manager/types.ts` + providers 面板 | 单测：`vision` 非法值归一为 `false`；管理端列表回显 `vision` |
| X1-06 | **fail-closed**：请求含图但候选集里没有 vision provider → 不调用上游、不静默丢图，返回诊断 `reason: "vision_unavailable"` | `libreChatService.sendMessage()` 入口 + `diagnostics.ts` 的 summary 映射 | 单测：无 vision 时 `invoke` 从未被调用，且 `attempts` 为空数组 |
| X1-07 | `ChatFailureDiagnostics["reason"]` 加 `"vision_unavailable"`；`buildChatFailureDiagnostics` 的 summary 改成按 reason 取表（原来的三元会把新 reason 写成"全部 0 个调用均失败"） | `librechat/types.ts`、`diagnostics.ts` | 单测：新 reason 的 summary 可读、不含实现术语（AGENTS §4 文案约定） |
| X1-08 | 历史只存文本件（图不落盘），并在代码注释写清"下一轮追问看不到图"是**刻意取舍** | `libreChatService.sendMessage()` | 代码走查 |

## 2. X2 结构化抽取通道

| # | 条目 | 落点 | 判据 |
|---|---|---|---|
| X2-01 | `buildWireRequest` 支持 `responseFormat: "json"`：chat→`response_format:{type:"json_object"}`；responses→`text:{format:{...}}`；anthropic→不加键（上游无该参数），靠提示 + 解析层 | `wire.ts` | 单测：chat/responses 带键、anthropic 不带且仍能解析 |
| X2-02 | `extractJsonObject(raw)`：剥 ``` 围栏 + **括号配对扫描（尊重字符串与转义）**，取第一个完整对象。修掉 `qqGuardModerationService` 里 `/\{[\s\S]*\}/` 的贪婪缺陷（会把"JSON + 后再一段带花括号的废话"整段吞进来） | `librechat/structured.ts` | 单测：尾部废话、前导说明、嵌套、字符串里的 `}`、`Think` 标签 |
| X2-03 | 字段规格 `StructuredFieldSpec`：`string/number/boolean/enum/string[]` + `required/enumValues/maxLen/maxItems/min/max/description` | `structured.ts` | 类型层 + 单测 |
| X2-04 | `validateStructuredPayload()`：白名单键（未知键 → issue 并丢弃，**不做 identity replacement**）、数字字符串强转、枚举成员校验、长度/条数上限、必填缺失 | `structured.ts` | 单测：每类 issue 至少一条；未知键绝不进结果 |
| X2-05 | `buildStructuredSystemPrompt(base, spec)`：只允许输出 JSON、键清单、"不确定就省略该键"（为 X3 的弃权铺路） | `structured.ts` | 单测：包含全部字段名、禁 fence 措辞 |
| X2-06 | `buildRepairPrompt(issues, spec, previousRaw)`：把 issue 翻成**用户可读**的一条条"哪个字段为什么不行"，`previousRaw` 截断到 2000 字 | `structured.ts` | 单测：issue 映射条数、截断 |
| X2-07 | `runStructuredExtraction({ invoke, spec, system, maxRepairTurns=1 })`：invoke 由外部注入 → 纯逻辑、零服务耦合，失败返回稳定 `code`：`EMPTY_OUTPUT/PARSE_FAILED/SCHEMA_FAILED/REPAIR_EXHAUSTED` | `librechat/structuredRunner.ts` | 单测：一次过 / 修复一次过 / 修不好 / 空输出 |
| X2-08 | `libreChatService.extractStructured()`：把 runner 绑到真实 provider 通路；`SendMessageOptions` 新增 `system?`（内部调用覆盖内置客服提示，缺省行为不变）与 `responseFormat?`、`parts?` | `libreChatService.ts`（≤60 行） | 单测：mock `chatOnce` 后正向 + 弃权路径 |

## 3. X3 provider 能力选路 + 一致性投票

| # | 条目 | 落点 | 判据 |
|---|---|---|---|
| X3-01 | 把 `buildProviderTryList()` 内联的"按 weight 展开 + shuffle"抽成纯模块 `selection.ts`：`selectProviders(pool, req)` / `shuffleWithRandom(items, random)` / `buildTryList(...)`，`random` 可注入（原来 `shuffleInPlace(Math.random)` 不可测） | `librechat/selection.ts` | 单测：同种子 → 同顺序；`requireVision` 过滤；`exclude` 生效；weight 上下界 [1,10] |
| X3-02 | `ProviderRequirement = { requireVision?: boolean; group?: string; exclude?: string[]; limit?: number }`；`providerKey()` = `model@host`（不含凭据，永不入日志/响应） | `selection.ts` | 单测：key 不含 apiKey 子串 |
| X3-03 | 一次性上游调用抽到 `invoke.ts`：`invokeChatOnce({ provider, spec, timeoutMs })`，沿用既有护栏（`maxContentLength` 2 MB、`proxy:false`、`maxRedirects:5`、超时） | `librechat/invoke.ts` | 单测：注入假 axios？→ 改为纯请求构造 + 错误归因（`buildChatProviderFailureAttempt` 复用） |
| X3-04 | `normalizeForAgreement(value)`：键排序、数字归一（`3.0`≡`3`、`"3.0"`≡`3`）、字符串 NFKC + 折叠空白；`agreementOf()` 给 `{majority,votes,total,score}` | `librechat/consensus.ts` | 单测：等价写法同票、不同值分票、平票判定 |
| X3-05 | `structuredConsensus(payloads, spec, { minVotes=2, threshold=0.5 })`：**逐字段多数**，低于阈值字段**丢弃**（= 弃权，不是猜）→ 输出 `{value, fieldAgreement, dropped}` | `consensus.ts` | 单测：3 份里 2 份一致留、1 份独占丢；全丢时 `value` 为 `{}` 且 `dropped` 齐 |
| X3-06 | `runStructuredQuorum({ invoke, spec, votes=3, ... })`：串行取 N 份结构化结果 → 交给 X3-05；返回 `coverage = 保留字段数/期望字段数` | `structuredRunner.ts` | 单测：3 票一致 coverage=1、全不一致 coverage=0 且 `code:"NO_CONSENSUS"` |
| X3-07 | `libreChatService.chatOnce({ system, parts, requirement, responseFormat, votes? })` 与 `extractStructuredQuorum()`：每一票用 `exclude` 排掉已用过的 provider，票不够就退回单 provider 复用并在结果里标 `distinctProviders:false` | `libreChatService.ts`（≤60 行） | 单测：3 票来自 3 个不同 key；池里只有 1 个时标记为 false |
| X3-08 | 内部调用**不得复用**用户聊天额度桶：`chatOnce` 走独立入口，历史仍按 `internal` 命名规范落（一次性审查 = 每次新会话） | 代码走查 + `conversations.ts` 既有约定 | 走查 |

## 4. X4 提示词/模型回归评测台

| # | 条目 | 落据 | 判据 |
|---|---|---|---|
| X4-01 | `src/eval/types.ts`：`GoldenCase / CaseResult / EvalReport`（含 `providerKey`、`suite`、`startedAt`、`summary`） | `eval/types.ts` | 类型层 |
| X4-02 | 评分器（纯）：`scoreExact`、`scoreLabel`、`scoreStructured(spec, expected, actual)` 逐字段；`isAbstain()` 认"缺键/空值/显式 unknown"为弃权 | `eval/scorers.ts` | 单测：对/错/弃权三态各自计数 |
| X4-03 | `riskCoverageCurve(results)`：按置信度阈值降序 → `[{threshold,coverage,errorRate}]`，**必须单调**（覆盖率升高 → 错误率不降要能看出来） | `eval/scorers.ts` | 单测：人造数据上曲线单调性与端点值 |
| X4-04 | `runEvalSuite({cases, invoke, scorer})`：`invoke` 注入（离线用假模型 → 主 CI 可跑；nightly 用真 provider）；单例抛错只记该 case 失败，不中断整轮 | `eval/harness.ts` | 单测：12 例里 1 例抛错 → 其余照常完成，`summary.errors=1` |
| X4-05 | `compareReports(baseline, candidate)`：输出 `regressions/improvements/newErrors`；`renderReportMarkdown()` | `eval/harness.ts` | 单测：人为回退能被抓到 |
| X4-06 | golden 集入库：`eval/suites/notify-fields.json`（12 例，含"信息缺失应弃权"3 例）、`eval/suites/abstain.json`（6 例） | `eval/suites/*.json` | JSON 合法 + 每例有 `expected`；不含真实个人信息（全为脱敏样例） |
| X4-07 | 离线回归 `src/tests/aiEvalHarness.test.ts`（假 invoke，**进主 CI**） | `src/tests/` | CI 步骤 `Run backend Jest tests` 里必须看到该套件执行（方法论 §六"裁判真的在看"） |
| X4-08 | 真模型评测 `src/tests/aiEvalLive.test.ts`：`AI_LIVE_EVAL_CHECK==="1" ? describe : describe.skip`（照 `edgeLiveSpeech` 姿势），挂到 `jest.nightly.external.config.js` 的显式清单 | 该文件 + `jest.nightly.external.config.js` | nightly 才跑；PR 门禁不受上游抖动影响 |
| X4-09 | 新增内部组件 `"ai-eval": "AI 能力评测"`（评测会话要能在管理端按组件分组，且每次运行是全新会话） | `librechat/conversations.ts` | 单测：`isInternalServiceComponent("ai-eval")` 为真，历史名以组件名开头 |

## 5. 变更文件清单（按批次）

**批次 A（核心，本次我改）**
```
src/services/librechat/wire.ts            X1-01..04, X2-01
src/services/librechat/selection.ts       新 X3-01..02
src/services/librechat/invoke.ts          新 X3-03
src/services/librechat/structured.ts      新 X2-02..06
src/services/librechat/structuredRunner.ts 新 X2-07, X3-06
src/services/librechat/consensus.ts       新 X3-04..05
src/services/librechat/types.ts           X1-07（类型 widening，仍纯类型）
src/services/librechat/diagnostics.ts     X1-07 summary 取表
src/services/librechat/models.ts          X1-05 vision 字段
src/services/librechat/conversations.ts   X4-09 新组件
src/services/libreChatService.ts          X1-06/08, X2-08, X3-07（≤120 行增量，G-03）
src/routes/libreChatRoutes.admin.ts       X1-05 管理端字段
frontend/src/components/env-manager/types.ts            X1-05
frontend/src/components/env-manager/*ProvidersSection   X1-05 表单/表格回显
```
**批次 B/C/D（并行 subagent，文件与 A 及彼此不相交）**：`src/tests/libreChat*.test.ts`、`src/eval/**` + `src/tests/aiEval*.test.ts` + `jest.nightly.external.config.js`、`docs/guides/ai-infra-extensions.md`。

## 6. 收尾核对

1. 每条 X 编号 → 指得到实现处或挂起理由（§六 经验法则）。
2. `git diff --cached --name-only` 与白名单逐字一致；**docTool 在飞 WIP 不纳入**。
3. 签名提交 + `GIT_TERMINAL_PROMPT=0` push + `gh` 带 `-R Chloemlla/Synapse`。
4. 判据：`Node verification` / `type-check` / `Quality Guardrails` 全绿；且**确认新测试套件真的跑了**（日志里 `Tests: N passed` 增量、套件名可见），不是被 skipped。
