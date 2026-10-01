# trycap（Cap）WASM 求解器被生产 CSP 拦截（2026-10-01）

来源：用户提供的浏览器控制台报错

```
Uncaught (in promise) CompileError: WebAssembly.compile(): Compiling or instantiating WebAssembly module
violates the following Content Security policy directive because 'unsafe-eval' is not an allowed source of
script in the following Content Security Policy directive: "script-src 'self' 'nonce-…' … https://cdn.jsdelivr.net …"
```

范围：`src/security/contentSecurityPolicy.ts`、`src/tests/contentSecurityPolicy.test.ts`、
`frontend/src/types/security.ts`、`frontend/src/components/CapWidget.tsx`、`frontend/index.html`、`.env.example`。

## 一、现状（编号 W1–W4）

| 编号 | 事实 | 位置 |
| --- | --- | --- |
| W1 | 生产 `script-src` / `script-src-elem` 为 nonce 白名单，**没有** `'wasm-unsafe-eval'`（也没有 `'unsafe-eval'`，这是刻意的） | `src/security/contentSecurityPolicy.ts:189-190`（修复前） |
| W2 | 三家人机验证供应商已就位（`turnstile` / `hcaptcha` / `trycap`），trycap 走 `<cap-widget>`，控件从 jsdelivr 取、PoW 求解器是 WASM | `frontend/src/components/CapWidget.tsx`、`src/services/turnstile/{cap,verify,providers}.ts` |
| W3 | Cap 控件 `v()` 用 `fetch(wasm).then(arrayBuffer).then(WebAssembly.compile)`，`hashwx` 挑战（`format:2`，线上站点密钥实测就是这个）**必须** WASM | 控件 `@cap.js/widget@0.1.58` |
| W4 | 线上实测：`https://cap.chloemlla.com` 可达、站点密钥有效、CORS 只回显白名单 Origin、`siteverify` 对无效令牌 fail-closed；唯一缺的是 CSP 放行 | 见「三、验证方式」 |

### 根因

`WebAssembly.compile()` 在 CSP 里属于 `script-src` 的 eval 类来源。Chromium 系要求
`script-src`（或 `script-src-elem` 所在策略）出现 `'unsafe-eval'` **或** `'wasm-unsafe-eval'`，
二者任一即可；本仓为安全刻意禁掉了 `'unsafe-eval'`，于是 WASM 编译被直接拒绝。

后果分层：

1. 控件 `v()` 的 promise 被拒 → 控制台红字（用户看到的那条），用户视角是「验证码一直转 / 报错」；
2. 控件只能退化到 JS 求解器（官方自述约慢 10 倍）；
3. **`hashwx` 挑战无 JS 回退**，即线上站点若用 `format:2`，验证直接不可能通过。

`'wasm-unsafe-eval'` 与 `'unsafe-eval'` 不等价：前者只允许编译/实例化 WebAssembly，字符串 `eval` /
`new Function` 仍然被拦（控件里唯一一处 `new Function` 是 `onsolve` 属性式事件绑定的兼容分支，
本仓用 `addEventListener`，走不到）。

## 二、修复

| 编号 | 改法 | 文件 |
| --- | --- | --- |
| W1 | `scriptSrc` / `scriptSrcElem` 增加 `'wasm-unsafe-eval'`（**不加** `'unsafe-eval'`） | `src/security/contentSecurityPolicy.ts` |
| W1 | 前端镜像常量同步，避免两处口径漂移 | `frontend/src/types/security.ts` |
| W1 | 回归断言：必须含 `'wasm-unsafe-eval'`，且仍不含 `'unsafe-eval'` | `src/tests/contentSecurityPolicy.test.ts` |
| W1 | `connect-src` / `script-src` **显式**列出 `https://cap.chloemlla.com`（原先只靠 `https://*.chloemlla.com` 通配；换自定义域名部署时通配不成立，显式列出后一眼能看出迁移点） | `src/security/contentSecurityPolicy.ts` |
| W3 | 补齐 `window.CAP_CSS_NONCE`（控件注入的 `<style>` 用它；后端若把 `style-src-elem` 收成 nonce-only，缺了控件会无样式） | `frontend/src/components/CapWidget.tsx` |
| W3 | `preconnect` / `dns-prefetch` 到 Cap 实例与 jsdelivr，减少首次挑战握手延迟 | `frontend/index.html` |
| W2 | 补 `CAP_SITE_KEY` / `CAP_SECRET_KEY` / `CAP_API_ENDPOINT` 的 env 文档（秘钥仅服务端；站点密钥按用户要求**不写死**，一律走库/env） | `.env.example` |

## 三、验证方式

本地不跑构建/测试（方法论 §一-1、仓库 `AGENTS.md`），改为对**线上 Cap 实例**做只读/无副作用的协议级验证：

| 用例 | 命令 | 实测结果 |
| --- | --- | --- |
| 站点密钥 + 实例地址有效 | `POST https://cap.chloemlla.com/6ceb8b1085/challenge` | `200`，`{"token":…,"format":2,"challenges":[{"protocol":"hashwx",…}],"expires":…}` |
| CORS 是否只放行自家 Origin | 同上带 `Origin: https://chloemlla.com` / `Origin: https://evil.example` | 前者回 `Access-Control-Allow-Origin: https://chloemlla.com`；后者**不回** ACAO（不是通配回显） |
| 无效令牌必须失败（fail-closed） | `POST …/siteverify` body `{"secret":"sk-invalid","response":"junk-token"}` | `{"success":false,"error":"Missing required parameters"}` |
| 缺失参数必须失败 | `POST …/siteverify` body `{}` | `{"success":false,"error":"Internal server error",…}` |
| 生产 CSP 现状（修复对象） | `curl -I https://chloemlla.com/` | 现状 `script-src` 无 `'wasm-unsafe-eval'`、`connect-src` 无显式 cap 主机 — 与改动一一对应 |

CI 复验项：`Node verification`（含 `src/tests/contentSecurityPolicy.test.ts`）、`type-check` /
`type-check-backend` / `type-check-frontend`、`Quality Guardrails`。

未能自动化的部分（如实记录）：**有效令牌**必须由浏览器跑 WASM 解 `hashwx` 挑战才能拿到，
本机无浏览器自动化环境，无法离线造一个有效 token；该路径由线上 `challenge → solve → siteverify`
的用户实测覆盖。

## 四、收尾核对

| 编号 | 去向 | 载体 |
| --- | --- | --- |
| W1 | 已修 | `src/security/contentSecurityPolicy.ts`、`frontend/src/types/security.ts`、`src/tests/contentSecurityPolicy.test.ts` |
| W2 | 已修 | `.env.example` |
| W3 | 已修 | `frontend/src/components/CapWidget.tsx`、`frontend/index.html` |
| W4 | 已验证 | 本文件「三、验证方式」 |
