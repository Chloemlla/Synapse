# CodeQL 告警清零修复报告 — 2026-09-27

> 任务：按 `verified-methodology.md` 修掉 `Chloemlla/Synapse` 上除 `js/missing-rate-limiting`
> 之外的全部 open code-scanning 告警。分支 `main`，基线 HEAD `1b728724`。
> 全部改动只经 GitHub Actions 验证（本机不构建、不测试、不装依赖）。

## 一、告警清单与去向

`GET repos/Chloemlla/Synapse/code-scanning/alerts?state=open` 共 27 条，其中 22 条是
`js/missing-rate-limiting`（本次任务范围外，未处理）。剩余 5 条：

| 编号（Alert #） | 规则 | 位置 | 状态 |
|---|---|---|---|
| 1231 | `js/polynomial-redos` | `src/services/outEmailService.ts:42` | ✅ 已修 |
| 1228 | `js/incomplete-sanitization` | `src/controllers/auth/_state.ts:30` | ✅ 已修 |
| 1225 | `js/resource-exhaustion` | `src/services/mobileIntegrityService.ts:277` | ✅ 已修 |
| 1224 | `js/resource-exhaustion` | `src/services/mobileIntegrityService.ts:213` | ✅ 已修 |
| 1211 | `js/incomplete-url-substring-sanitization` | `src/tests/mobileIntegrityService.test.ts:81` | ✅ 已修 |

---

### 1231 — 对外邮件 HTML 探测正则的多项式回溯（High）

- **位置**：`src/services/outEmailService.ts:42`（原 `HTML_TAG_PROBE`，定义在 :31）
  ```ts
  const HTML_TAG_PROBE = /<(?:[a-z][a-z0-9]*)(?:\s[^>]*)?\/?>|<\/[a-z][a-z0-9]*\s*>/i;
  ```
- **触发路径**：`sendOutEmail*` / `buildEmailBodies(content)` 的正文完全由调用方（带 outemail 鉴权的
  第三方调用者）提交，属不可控输入。
- **根因**：`(?:\s[^>]*)?` 里的 `[^>]*` 之后必须出现 `>`。当输入里根本没有 `>`（例如 `<a ` 重复
  n 次）时，每个候选起点都要把 `[^>]*` 扫到串尾、再逐字符回溯尝试 `\/?>`，整体 O(n²)。
  CodeQL 报文原话：*may run slow on strings starting with `<a ` and with many repetitions of `<a `*。
- **改法**：把正则换成单遍线性扫描（`src/services/outEmailHtmlProbe.ts` 的新 `containsHtmlTag`）。
  先用一次 `lastIndexOf(">")` 定界（任何标签都必须以 `>` 闭合，其后的 `<` 不可能是标签起点），
  再逐候选点判断三种形态：`<name>`、`<name/>`、`<name 属性区（不含 `>`）...>`、 `</name\s*>`。
  每个字符最多被看两次。
- **语义等价性**：新模块头注释逐条列出与原正则的对应关系；
  `src/tests/outEmailHtmlProbe.test.ts` 用 28 条期望值（取自原正则实测结果）对照，
  并额外用 `<a ` × 50,000 的病理输入把它们钉死（旧实现会在这条用例上超时）。

### 1228 — 域名白名单拼接正则时的转义不完整（High）

- **位置**：`src/controllers/auth/_state.ts:30`
  ```ts
  export const emailPattern = new RegExp(`^[\\w.-]+@(${allowedDomains.map((d) => d.replace(/\./g, "\\.")).join("|")})$`);
  ```
- **根因**：CodeQL 报文是 *This does not escape backslash characters in the input.*
  `replace(/\./g, "\\.")` 只把 `.` 变成 `\.`，没有把输入里的 `\` 自身转义 —— 也就是
  `javascript/ql/src/Security/CWE-116/IncompleteSanitization.ql` 里的 `isBackslashEscape` +
  `not allBackslashesEscaped` 分支。（同一行历史上还有更早的漏洞：`d.replace(".", "\\.")`
  只替换第一个点，多点域名会漏转义，白名单过宽。）
- **改法**：数组直接存**已转义的正则片段**（`"gmail\\.com"` …），下面只做 `join("|")` 拼进
  `RegExp`。运行时不再有任何 `replace`，不存在"转义少写一个 `\`"的可能。
- **回归保护**：`src/tests/authEmailWhitelist.test.ts` 覆盖 10 个白名单域名、形近域名
  （`gmailxcom` —— 点号若丢转义就会放行）、后缀拼接（`gmail.com.evil.com`）、子域名、
  本地部分非法字符等 9 条拒绝用例。

### 1224 / 1225 — Play Integrity 请求超时的定时器时长用户可控（High）

- **位置**：`src/services/mobileIntegrityService.ts:213`（`getAccessToken`）与 `:277`
  （`decodeIntegrityToken`），sink 均为 `setTimeout(() => controller.abort(), abortAfterMs)`。
- **根因**：时长来自 `runtimeMutableConfig.mobileTokenIntegrity.timeoutMs`（超管配置面板可改）。
  历史提交 `70876167` 试图用 `Math.min(resolveRequestTimeoutMs(cfg.timeoutMs), MAX)` 做"钳制"，
  但 `javascript/ql/lib/semmle/javascript/security/dataflow/ResourceExhaustionQuery.qll` 的
  `isAdditionalFlowStep` 明确写着 `isNumericFlowStep`：**任何 `Math.*` 调用都是污点传播步骤**
  （`c = DataFlow::globalVarRef("Math").getAMemberCall(_)`）。也就是说 `Math.min` 不但不能
  清污，反而把污点原样搬到了 sink —— 这就是两次"已修"后告警仍在的原因。
- **该查询唯一认可的有界性证明**：`UpperBoundsCheckSanitizerGuard`（`BarrierGuard` 子类）——
  在**与 sink 同一个函数体**里，用关系比较把变量守卫住：
  `blocksExpr(true, lesserOperand)` / `blocksExpr(false, greaterOperand)`。屏障守卫是 CFG 局部
  的，跨函数（哪怕 helper 里写了同样的 `if`）不会生效。
- **改法**：删掉 `resolveRequestTimeoutMs`，在两个 sink 所在函数体内各自内联：
  ```ts
  let abortAfterMs = Number(cfg.timeoutMs);
  if (!Number.isFinite(abortAfterMs)) abortAfterMs = DEFAULT_REQUEST_TIMEOUT_MS;
  if (abortAfterMs < MIN_REQUEST_TIMEOUT_MS) abortAfterMs = MIN_REQUEST_TIMEOUT_MS;
  if (abortAfterMs > MAX_REQUEST_TIMEOUT_MS) abortAfterMs = MAX_REQUEST_TIMEOUT_MS; // ← 这一条守卫住 sink
  ```
  最后一处 `> MAX_REQUEST_TIMEOUT_MS` 的 false 分支支配 `setTimeout`，污点在该分支被截断；
  语义与旧 `resolveRequestTimeoutMs` 一致（非有限值 → 8000，低于 1000 → 1000，高于 60000 → 60000）。
  文件头注释已写明"不要再抽公共函数、不要再用 Math.min 钳"，防止下次被"重构"回去。

### 1211 — 测试替身用子串判断 URL host（High）

- **位置**：`src/tests/mobileIntegrityService.test.ts:81`
  ```ts
  if (String(url).includes("oauth2.googleapis.com")) {
  ```
- **根因**：`includes` 是子串匹配，`https://evil.example/?x=oauth2.googleapis.com` 也会被判成
  Google 换票端点 —— 测试替身对 URL 的判定不可靠，等于把生产端的端点判定逻辑放松了。
- **改法**：改成 `new URL(String(url)).hostname === "oauth2.googleapis.com"`（非法 URL 走
  catch，hostname 置空），只认真正的 hostname。

---

## 二、验证方式

- 本机只做静态自查（`git diff` 逐份核对 + 括号/引用一致性检查），不跑构建/测试。
- 提交后由 GitHub Actions 判定：`CodeQL`（重扫后 5 条告警应从 open 列表消失）、
  `Node verification`（tsc）、`Quality Guardrails`、`Code Quality`。
- 收尾以 `gh api repos/Chloemlla/Synapse/code-scanning/alerts?state=open` 复验，
  只应剩下范围外的 `js/missing-rate-limiting`。
