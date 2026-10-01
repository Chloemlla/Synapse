# trycap（Cap）instrumentation 在严格 CSP 下必然超时（2026-10-01）

来源：用户提供的浏览器控制台报错

```
Failed to load resource: the server responded with a status of 429 ()
13:20:31.100 widget@0.1.58:1 Uncaught (in promise) Error: Instrumentation timeout
```

范围：Cap 实例侧站点密钥配置（`6ceb8b1085`）、`frontend/src/utils/captchaSelection.ts`、
`frontend/src/components/admin/CaptchaProviderAdmin.tsx`、`docs/plans/captcha-providers-trycap-2026-10-01.md`、
本文档。与上一条缺陷（`audit-2026-10-01-captcha-wasm-csp.md`，CSP 放行 WASM）是同一条链上的下一段。

## 一、现状（编号 I1–I6）

| 编号 | 事实 | 证据（只读实测） |
| --- | --- | --- |
| I1 | 线上 `script-src` / `script-src-elem` 只有 `'wasm-unsafe-eval'`，**没有** `'unsafe-eval'` | `curl -sI https://chloemlla.com/` |
| I2 | 生产站点密钥 `6ceb8b1085`：`instrumentation:true`、`blockAutomatedBrowsers:true`、`protocol:hashwx`、`hashwxDifficulty:1000000`、`difficulty:4`、`challengeCount:80` | `GET /server/keys/6ceb8b1085` |
| I3 | 该密钥当天统计 `challenges:3 / verified:0 / failed:3`，`rateLimited:0` —— 与用户三次实测一一对应 | 同上 |
| I4 | 该密钥的 challenge 返回 `format:2`，`challenges[]` = `hashwx`×4 + `instrumentation`×1（载荷 `payload.blob`） | `POST /cap.chloemlla.com/6ceb8b1085/challenge` |
| I5 | instrumentation 载荷（base64 + deflate-raw）解出的 JS 用 `eval(...)` / `(0, eval)(...)` 做「全局可见性 / 篡改」探针，并且探针整体包在 `try{…}catch{return null}` 里；一旦返回 `null`，脚本 `if (!lhq6ooa6l \|\| typeof lhq6ooa6l !== 'object') return;` 直接结束、**不发 `cap:instr` 消息** | 解码载荷源码（见下「复现命令」） |
| I6 | 关掉 `blockAutomatedBrowsers` **不会**移除那些 eval 探针（不是"拦截无头浏览器"专属） | 临时密钥对照实验（建 `instrumentation:true, blockAutomatedBrowsers:false` 的 key → 解载荷 → 删除 key） |

### 根因

1. 控件的 instrumentation 跑在 `srcdoc` + `sandbox="allow-scripts"` 的 iframe 里；该文档**继承父页面 CSP**（上游 issue [#229](https://github.com/tiagozip/cap/issues/229) 已确认这条链路，其修复只是把 nonce 透传进 srcdoc，我们钉的 `0.1.58` 已带）。
2. 载荷里的 `eval` 被父页面 CSP 拒绝（`'wasm-unsafe-eval'` 不等价于 `'unsafe-eval'`）→ `EvalError` → 被载荷自己的 `catch` 吞成 `return null` → **不回消息**。
3. 控件只能干等 20 秒（`runInstrumentationChallenge` 的 20000ms 兜底），随后把该解标成 `{timeout:true}` 上交；服务端判定 instrumentation 缺失并 403 `Blocked by instrumentation`（`standalone/src/cap.js`），落成 `failed`。

即：**只要站点密钥开着 instrumentation，在没有 `'unsafe-eval'` 的严格 CSP 下验证码 100% 不可能通过**。这不是配置能绕的——I6 已排除，且探针由服务端按挑战生成，随版本走。

### 另外两条路为什么不走

- **加 `'unsafe-eval'`**：与仓库既有安全口径直接冲突（`src/tests/contentSecurityPolicy.test.ts` 断言生产 CSP 不得出现 `'unsafe-eval'`），且等于把动态求值放给整个 SPA。instrumentation 只是「环境证明」这一层，不值这个代价；PoW（hashwx，GPU 抗性）仍在。
- **拦截 iframe 的 `srcdoc` / 改写载荷**：等于伪造反自动化结果，是安全旁路，不做。

## 二、修复

| 编号 | 改法 | 载体 |
| --- | --- | --- |
| I2 | 生产密钥 `instrumentation` 置 `false`，其余配置一个不动（`hashwx` PoW 保留：difficulty 4、80 挑战、`hashwxDifficulty` 1e6），challenge 只剩 PoW | Cap 实例 API（见下「复现命令」） |
| I5 | 仓库文案不再宣称「PoW + instrumentation」，并写明严格 CSP 下的取舍 | `frontend/src/utils/captchaSelection.ts`、`frontend/src/components/admin/CaptchaProviderAdmin.tsx` |
| I5 | 计划文档 R1 的「建议保持 instrumentation: true」就地更正 | `docs/plans/captcha-providers-trycap-2026-10-01.md` |

回滚方式（一条命令，改回 `true` 即回到改前状态）：

```bash
curl -X PUT https://cap.chloemlla.com/server/keys/6ceb8b1085/config \
  -H "authorization: Bearer <登录后 base64(token+hash)>" -H "content-type: application/json" \
  -d '{"instrumentation":true}'
```

`blockAutomatedBrowsers` 保持 `true` 未动（instrumentation 关掉后它不再参与挑战生成，留着无害，也不扩大本次改动面）。

## 三、验证方式

| 用例 | 命令 | 实测结果 |
| --- | --- | --- |
| 改前 challenge 含 instrumentation | `POST …/6ceb8b1085/challenge` | `hashwx,hashwx,hashwx,hashwx,instrumentation` |
| 改后 challenge 只剩 PoW | 同上 | `hashwx,hashwx,hashwx,hashwx` |
| 改动只动了 instrumentation | `GET /server/keys/6ceb8b1085` 前后对比 | 改前 `difficulty 4 / challengeCount 80 / protocol hashwx / hashwxDifficulty 1000000 / corsOrigins ["https://chloemlla.com"]`；改后各项一致，仅 `instrumentation:true→false`（`ratelimitMax`/`ratelimitDuration`/`blockNonBrowserUA`/`requiredHeaders` 由"未设置"变成显式 `null`，默认值等价） |
| eval 探针是否与 blockAutomatedBrowsers 绑定 | 临时 key 对照实验 | 仍含 `eval(` / `(0, eval)` / `'typeof '` 探针 → 与开关无关（实验后已删除临时 key） |
| 线上 CSP 现状（未变，故意） | `curl -sI https://chloemlla.com/` | 仍是 `'wasm-unsafe-eval'` + nonce，无 `'unsafe-eval'` |

未能自动化的部分（如实记录）：**真实浏览器跑通 solve → redeem**。本地不跑构建/测试（方法论 §一-1、仓库 `AGENTS.md`），只读探针造不出有效 token；判据交给线上实测——`GET /server/keys/6ceb8b1085` 的 `stats.verified` 由 0 变正即为通过。

另注：`frontend/src/components/CapWidget.tsx` 的 nonce 透传是 `7ce42d3d` 引入的，**需要前端重新部署才在线上生效**；但即便生效，本条 eval 链仍会让 instrumentation 超时——这正是本次改实例配置的原因。

## 四、遗留：那一行 429

- 事实：密钥当天统计 `rateLimited: 0`（Cap 对 challenge 端点的限流会计入该指标，默认 30 次/5 秒/IP，实例未自定义 `/settings/ratelimit`），challenge 也确认成功过（`challenges:3`）。
- 因此 429 更可能来自 `cdn.jsdelivr.net`（控件脚本、`cap_wasm_bg.wasm`、`hashwx.wasm`、pako 全走它）；用户控制台里失败 URL 被省略，**不下结论**。
- 若要彻底消掉这条第三方路径：实例打开 asset server（`ENABLE_ASSETS_SERVER=true` + `WIDGET_VERSION` / `WASM_VERSION`，当前 `/assets/widget.js` 实测 404 = 未开），再把 `CapWidget.tsx` 的脚本源与 `CAP_CUSTOM_WASM_URL` / `CAP_CUSTOM_HASHWX_URL` 指向 `https://cap.chloemlla.com/assets/*`（CSP 已放行该域）。需要重启容器，**本次未执行**。

## 五、收尾核对

| 编号 | 去向 | 载体 |
| --- | --- | --- |
| I2 | 已修 | Cap 实例站点密钥 `6ceb8b1085`（`instrumentation:false`，可一键回滚） |
| I5 | 已修 | `frontend/src/utils/captchaSelection.ts`、`frontend/src/components/admin/CaptchaProviderAdmin.tsx`、`docs/plans/captcha-providers-trycap-2026-10-01.md` |
| I1 | 保持原状（刻意） | `src/security/contentSecurityPolicy.ts` 不加 `'unsafe-eval'` |
| 429 | 待定，已记录复现路径 | 本文档 §四 |
