# trycap 供应商接入后的 CI 红灯清单（2026-10-01）

来源：GitHub Actions `Node Verification`（runs `36809568351` / `36810523019` / `36811855519`）
背景：`2cabd305`（新增 trycap 供应商 + 概率/上下线调度）起，`Node Verification` 连续红；修复性质两批——先恢复编译，再修因新供应商进入候选池而失效的测试装置。

## 一、逐条清单

### D1 重复导入导致 TS2300（已修：commit `bd2ceec4`）

- **文件**：`src/services/turnstile/cap.ts:4` 与 `:7`
- **症状**：CI 报
  ```
  src/services/turnstile/cap.ts(4,10): error TS2300: Duplicate identifier 'sanitizeCapEndpoint'.
  src/services/turnstile/cap.ts(7,29): error TS2300: Duplicate identifier 'sanitizeCapEndpoint'.
  ```
  `type-check` / `type-check-backend` / `Node verification → Run build` 三个 job 同时在编译期挂掉，`exit code 2`。
- **根因**：把 `sanitizeCapEndpoint` 的导入拆成两行写重复了——第 4 行单独导入该符号，第 7 行又从同一模块 `./capEndpoint` 的具名导入列表里再导一次。`capEndpoint.ts` 只导出一次，属纯手误。
- **影响面**：仅编译期，运行期无差异；但 TS2300 会挡住整个 job，其后所有测试都不执行。
- **修复**：删除第 4 行的单符号导入，保留第 7 行的合并导入（`{ isValidCapSiteKey, sanitizeCapEndpoint, validateCapEndpoint }`）。同一提交内对 `src/**`、`frontend/src/**` 做了全仓重复导入标识符扫描（正则逐文件比对 `import {...} from` 的本地绑定名），确认无第二处。

### D2 `多候选时按权重选中 trycap 并带上实例地址` 断言落空（本批修）

- **文件**：`src/tests/captchaProviderSelection.test.ts`（"多候选时按权重选中 trycap 并带上实例地址" 用例）
- **症状**：CI 实测
  ```
  - "apiEndpoint": "https://cap.example.com"      + "apiEndpoint": null
  - "provider": "trycap"                          + "provider": "hcaptcha"
  - "siteKey": "cap-site"                         + "siteKey": "hc-site"
  ```
- **根因**：装置只写了 `turnstile`(weight 0) 与 `trycap`(weight 100) 两条 settings，误以为「没写进 settings 的供应商不进候选」。实际调度语义是**未配置即默认在线、默认权重 50**（同文件 `未配置的供应商默认权重 50 但不写库` 一条正是钉住这个语义的），而 `ALL_KEYS` 里 hcaptcha 的 siteKey/secret 齐全 ⇒ 候选为 `[turnstile(0), hcaptcha(50), trycap(100)]`。注入的随机源 `() => 0` 取下界，`pickWeightedProvider` 按 `CAPTCHA_PROVIDER_IDS` 顺序取第一个正权重项 ⇒ 命中 hcaptcha 而非 trycap。
- **修复**：把 `hcaptcha` 显式写进 settings 并置 `weight: 0`，让「只有 trycap 有权重」这一前提在装置里成立；断言原样保留（仍是三家在线、按下界随机源必然选中权重 100 的 trycap 并带出规范化后的实例 origin）。

### D3 `权重全 0 时仍能选出在线候选（不死锁）` 断言落空（本批修）

- **文件**：同上（"权重全 0 时仍能选出在线候选（不死锁）" 用例）
- **症状**：`expect(["turnstile", "hcaptcha"]).toContain(selection.provider)` 失败——实际选出 `trycap`。
- **根因**：同 D2 的同一前提缺失：装置只把 turnstile / hcaptcha 的权重压到 0，trycap 未写 settings ⇒ 以默认权重 50 在线进入候选，成为唯一正权重项，`() => 0` 必然落到它。「全 0 退化为等概率」这条路径根本没被走到。
- **修复**：装置补 `{ provider: "trycap", enabled: false, weight: 0 }`，把候选收敛回 turnstile / hcaptcha 两家，真正验证 `normalizeWeightPercentages` 与 `pickWeightedProvider` 的全 0 分支（断言不变）。

## 二、为什么不是「改代码去迁就测试」

- D2/D3 期望的「未配置的供应商不该进候选」若成立，会与同文件已通过的 `未配置的供应商默认权重 50 但不写库（读接口无副作用）` 直接冲突；生产语义（未配置=默认在线+权重 50，由管理端面板显式下线）是 `docs/plans/captcha-providers-trycap-2026-10-01.md` 明确的设计，且 `providers.ts` 的 `enabled = setting ? setting.enabled !== false : true` 是唯一实现。
- 因此缺陷在装置（漏写一条 settings），不在调度引擎。两处改动都只**补齐前提**，不下调断言强度。

## 三、验证方式

- 本地不跑构建/测试（方法论 §一-1），静态核对：改动只涉及 `src/tests/captchaProviderSelection.test.ts` 的两个 `setProviderConfig` 字面量，断言与 `it` 标题均未改。
- CI 复验：`Node Verification` 全绿（`Tests: 1333 total`）、`type-check` / `type-check-backend` / `type-check-frontend` 全绿、`Quality Guardrails` 全绿。

## 四、收尾核对

| 编号 | 去向 | 载体 |
| --- | --- | --- |
| D1 | 已修 | commit `bd2ceec4`（`src/services/turnstile/cap.ts`） |
| D2 | 已修 | 本批提交（`src/tests/captchaProviderSelection.test.ts`） |
| D3 | 已修 | 本批提交（同上） |
