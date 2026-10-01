# `/captcha-verify` 首屏性能分析报告

> 输入证据：`D:\Downloads\Trace-20261001T135120.json.gz`（Chrome DevTools Enhanced Trace，7.7 MB gz / 40.5 MB JSON，130 027 条 trace event，624 个 CPU ProfileChunk）
> 采集对象：`https://chloemlla.com/captcha-verify`（主帧 `71C619C5195A777B271FFFEA9F9D14EA`）
> 分析方式：**纯静态解析 trace + 静态审查仓库与线上产物**；未在本地执行任何构建/测试（遵守仓库约定，构建与验证一律交给 CI）。
> 线上产物抽样：`https://chloemlla.com/static/assets/*`（`Content-Length` 为未压缩值，`Content-Encoding: gzip`）。

---

## 一、结论摘要（先说结果）

这次 trace 里 **不是 JS 逻辑慢，而是「首屏根本不该加载的东西被全量加载了」**。

| 指标 | 实测 | 说明 |
|---|---|---|
| 首帧（空白文档） | +18 ms | HTML 只有 `<div id="root">` |
| **First Contentful Paint** | **6734 ms** | 用户真正看到内容在 **6.7 s** 之后 |
| DOMContentLoaded / load | 6425 ms / 6468 ms | 由入口 chunk 求值完成时间决定 |
| 首屏关键路径 JS | **8 078 491 B 原始 / 2 647 061 B gzip**（11 个 chunk） | ≈ 7.70 MiB / 2.52 MiB |
| 首屏关键路径 CSS | 273 786 B 原始 / 52 439 B gzip | 其中 `diagrams.css` 30 KB 是 mermaid 的样式，属于渲染阻塞 |
| 下载 + 流式编译耗时 | ~5.7 s | HTTP/1.1 + gzip，最大单包 5.43 MB |
| 同步模块求值长任务 | **621.2 ms**（`RunTask` 623.6 ms） | 卡死主线程，期间无渲染、无输入响应 |
| 主线程长任务（>30 ms） | 6 个（150.9 / 102.2 / **623.6** / 38.8 / 72.5 / 38.7 ms） | 类 TBT 合计 ≈ 749 ms |
| 丢帧 | 9 次（6.92 s、7.28~7.32 s、10.07 s、11.02~11.08 s） | |
| Cap PoW（人机验证解题） | 13 个 Worker / 13 个 WASM 实例，合计 ≈ 5.9 s CPU | trace 结束时（11.48 s）仍在计算 |

**根因排序（详见第五、六章）**

1. **R1｜入口把「文章/图表/PDF/人机验证」才需要的重资源变成了全站首屏依赖**：`App.tsx` 静态引入 `BroadcastModalProvider` → `BroadcastModal` → `MarkdownRenderer` → `mermaid` + `katex` + `react-syntax-highlighter` + `katex.min.css`。于是 `/captcha-verify` 也要下载并执行 5.43 MB 的 mermaid+katex、604 KB 的 jspdf/html2canvas、176 KB 的 chart.js。
2. **R2｜`MarkdownRenderer` 用的是 `react-syntax-highlighter` 全量 Prism 构建**（`refractor/all`，模块加载时注册 **298 个语法**），单这一个动作就是 621 ms 长任务里的 ~200 ms。
3. **R3｜`vite.config.ts` 的 `getManualChunk` 有前缀匹配 bug**：`includes('/node_modules/react')` 会把 `react-router-dom`、`react-toastify`、`react-markdown`、`react-syntax-highlighter`、`react-chartjs-2`… 全部塞进 `react-vendor`（实测该包内含以上全部包的代码），并因此把 `charts`/`pdf`/`animations`/`diagrams` 一起拉成首屏依赖。
4. **R4｜`diagrams` 包 = mermaid + katex 打成一块 5.43 MB**，既未按需拆包，默认还进了 `modulepreload`。
5. **R5｜Cap PoW 在首帧后立刻用 13 个 Worker 抢满 CPU**，与页面动画/交互直接争抢核心。

---

## 二、采集信息

| 项 | 值 |
|---|---|
| 采集器 | Chrome DevTools Enhanced Trace v1（`dataOrigin: TraceEvents`） |
| 起始时间 | `2026-10-01T05:51:20.556Z`（本地 13:51:20） |
| 覆盖时长 | 11.48 s（ts 8431825030 → 8443306646 µs） |
| 设备 | Responsive、`hostDPR = 1.785`、视口 1749×1561（`Paint` clip） |
| 进程 | Browser 18496、Renderer 7872（本页）/9552/11160/7972（其他标签页）、GPU 20716 |
| 本页主线程 | `7872:14740 CrRendererMain`（41 890 条事件，3 943 个 `RunTask`） |
| CPU Profile | `7872:10968`（26 193 个采样，覆盖 11 162 ms） |
| 线程额外事实 | 页面起了 **13 个 Dedicated Worker**（PID 7872） |
| 浏览器扩展 | 2 个扩展在页面主线程执行了内容脚本（见 4.8） |

---

## 三、时间线（相对 trace 起点）

| 时刻 | 事件 | 证据 |
|---|---|---|
| +16 ms | `navigationStart` / `CommitLoad` → `/captcha-verify` | `navigationStart` |
| +246 ms | 文档提交到 Renderer 7872 | `FrameCommittedInBrowser` |
| +265 → +416 ms | **`ParseHTML` 150.6 ms**（HTML 只有 ~3.8 KB，绝大部分是两个扩展的内容脚本：`EvaluateScript` 85.8 ms + 49.3 ms） | `ParseHTML` / `EvaluateScript` |
| +541 → +1130 ms | 入口 `index.4rDL9Z2H.js` 流式下载+后台编译完成（479.6 ms） | `BackgroundJSStreamManager::RunScriptStreamingTask` |
| +1267 → +5070 ms | `react-vendor.DoOfiCS4.js` 下载+编译（**3803.5 ms**） | 同上 |
| +2055 → +5693 ms | `diagrams.T_1gdNog.js`（**5.43 MB**）下载+编译（**3638.7 ms**） | 同上 |
| +2504 → +3546 ms | `pdf.D8Eqr2qe.js`（604 KB）下载+编译 | 同上 |
| +2817 → +3651 ms | `charts.zvBYjq7a.js`（176 KB）下载+编译 | 同上 |
| +5700 → +5802 ms | **长任务 102.2 ms**（大脚本 `LargeScriptCatchup` ×8，主线程补编译） | `RunTask` / `LargeScriptCatchup` |
| **+5802 → +6426 ms** | **`v8.evaluateModule` 621.2 ms**：入口模块图求值，主线程完全阻塞 | `v8.evaluateModule`、`RunTask` 623.6 ms |
| +6423 ms | `ModuleEvaluated`（入口模块图完成） | |
| +6425 / +6468 ms | `MarkDOMContent` / `MarkLoad` | |
| **+6734 ms** | **`firstPaint` = `firstContentfulPaint`** | |
| +6706 → +11471 ms | 3 624 次 `UpdateLayer`（持续逐帧 layer 更新）、487 次 `TimerInstall`、329 次 `TimerFire` | |
| +6917 ms 起 | 9 次 `DroppedFrame`（6.92 / 7.28 / 7.30 / 7.32 / 10.07×2 / 10.08 / 11.02 / 11.08 s） | |
| +7453 / +7774 ms | Microsoft Clarity 标签脚本求值 0.6 ms → `clarity.js` 求值 37.0 ms | `v8.run` |
| +8963 / +8984 ms | Cap 控件 `createUI()` + 第 1 个 Worker 创建 | `ParseHTML` 栈、`WorkerScriptFetcher CreateAndStart` |
| +10 667 → +10 695 ms | 另外 **12 个 Worker** 创建（共 13 个） | `DedicatedWorkerHostFactoryImpl::CreateWorkerHostAndStartScriptLoad` |
| +10 693 → (trace 结束 11 481 ms) | 8~13 个 Worker 在 WASM 里解 PoW，每核 **696~732 ms**，仍在运行 | Worker 线程 `RunTask` |

---

## 四、证据链

### 4.1 首屏被预加载了什么（HTML `modulepreload` + 实际体积）

`/captcha-verify` 返回的 HTML（trace 内 `metadata.resources[0]`，与当前线上一致）里 **11 条 `modulepreload` + 2 条渲染阻塞样式表**（`frontend/index.html` 本身没有这些标签，是 Vite 构建时按入口静态依赖图注入的）：

| chunk | 原始 B | gzip B | 首屏必要？ |
|---|---|---|---|
| `diagrams.T_1gdNog.js`（mermaid+katex） | **5 431 069** | **1 709 735** | ❌ 人机验证页不需要 |
| `react-vendor.DoOfiCS4.js` | 1 327 317 | 481 097 | ⚠️ 部分需要，但被塞进了 router/toastify/markdown/prism |
| `pdf.D8Eqr2qe.js`（jspdf+html2canvas） | 604 246 | 194 456 | ❌ 只有导出 PDF 用 |
| `index.BsGxgivz.js`（入口） | 187 331 | 63 450 | ✅ |
| `charts.zvBYjq7a.js`（chart.js） | 176 483 | 68 544 | ❌ 只有后台图表用 |
| `animations.CBOGVBba.js`（framer-motion） | 138 014 | 50 327 | ⚠️ |
| `useAuth.DUxYNgI2.js` | 109 976 | 40 758 | ✅ |
| `utils.CfRp4e2C.js`（axios 等） | 79 402 | 29 838 | ✅ |
| `studioTheme.EGjZpzMX.js` | 10 581 | 2 834 | ✅ |
| `Notification.CSEwY-g6.js` | 7 646 | 2 702 | ✅ |
| `createLucideIcon.9Uz0sN8t.js` | 3 143 | 1 540 | ⚠️ |
| `rolldown-runtime.BJpfBBGe.js` | 3 283 | 1 780 | ✅ |
| **JS 合计** | **8 078 491** | **2 647 061** | |
| `css/index.rrsnHacf.css` | 243 576 | 43 878 | ✅（但偏大） |
| `css/diagrams.DEU8FiFl.css` | 30 210 | 8 561 | ❌ mermaid 样式，却渲染阻塞 |

> 说明：trace 采集时入口是 `index.4rDL9Z2H.js`（现已 404，线上重新构建为 `index.BsGxgivz.js`），其余 chunk 的 hash 与体积未变，结论通用；trace 内的首屏清单以 `metadata.resources` 与 `modulepreload` 列表为准。

### 4.2 静态依赖图（直接从线上 chunk 的 `import` 语句读出）

```
index.BsGxgivz.js
├── rolldown-runtime, animations, studioTheme, Notification, useAuth, createLucideIcon
├── diagrams.T_1gdNog.js          ← 入口直接静态依赖 mermaid+katex
└── react-vendor.DoOfiCS4.js
    ├── animations.CBOGVBba.js
    ├── charts.zvBYjq7a.js        ← react-chartjs-2 被前缀匹配吞进 react-vendor
    ├── pdf.D8Eqr2qe.js           ← 连带上首屏
    └── diagrams.T_1gdNog.js
useAuth.DUxYNgI2.js
└── diagrams.T_1gdNog.js          ← 又一条通往 5.43 MB 的路
pdf.D8Eqr2qe.js
└── diagrams.T_1gdNog.js
```

> 也就是说：**只要 `react-vendor` 与 `index` 被求值，`diagrams`/`pdf`/`charts` 必然被预载**，与当前路由是否为 `/captcha-verify` 无关。

实测 `react-vendor.DoOfiCS4.js` 内含（按特征字符串核对）：`react-dom`（`createRoot`/`flushSync`/`__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE`）、`react-router-dom`（`` `useViewTransitionState` must be used within `react-router-dom`'s `RouterProvider` ``）、`react-toastify`、`react-markdown`（`micromark`/`hast-util-to-jsx-runtime`）、`react-syntax-highlighter` + `refractor`（Prism fork：`cp.register`、`languages.DFS`）。

### 4.3 下载/流式编译（`BackgroundJSStreamManager::RunScriptStreamingTask`）

| 资源 | 开始 | 耗时 | 完成 | 有效带宽（gzip 计） |
|---|---|---|---|---|
| index | 650 ms | 479.6 ms | 1130 ms | 132 KB/s |
| react-vendor | 1267 ms | **3803.5 ms** | 5070 ms | 127 KB/s |
| animations | 1519 ms | 535.9 ms | 2055 ms | 94 KB/s |
| **diagrams** | 2055 ms | **3638.7 ms** | 5693 ms | **470 KB/s** |
| pdf | 2504 ms | 1042.1 ms | 3546 ms | 187 KB/s |
| charts | 2817 ms | 834.3 ms | 3651 ms | 82 KB/s |
| utils | 3865 ms | 414.8 ms | 4280 ms | 72 KB/s |
| useAuth | 4286 ms | 43.5 ms | 4329 ms | 937 KB/s |

- 服务端实测：`Server: openresty`、**`HTTP/1.1`**、`Content-Encoding: gzip`（**没有 Brotli**，即使客户端 `Accept-Encoding: br`）、`Cache-Control: public, max-age=31536000, immutable`。
- 本机对比测试同一 `diagrams` 包：1.71 s（≈1 MB/s）。trace 里 3.64 s，说明用户侧有效带宽约 3~4 Mbps，且 HTTP/1.1 的 6 连接上限让 11 个 chunk 互相排队。
- 入口模块求值被推迟到 **5802 ms**，正是因为它必须等 `diagrams`（5693 ms 才下载完）——**这一步就是 6.7 s 白屏的直接原因**。

### 4.4 621 ms 同步求值长任务（+5802 → +6426 ms）

`v8.evaluateModule` 621.2 ms；同期主线程采样（CPU Profile）分布：

| 归属 | 采样自耗时 | 顶层函数 |
|---|---|---|
| `react-vendor.DoOfiCS4.js`（**refractor/Prism**） | **≈ 198 ms** | `e`(=`languages.DFS`) 136.8 ms、`type` 24.3 ms、`objId` 22.3 ms、`cp.register` 14.6 ms |
| `diagrams.T_1gdNog.js`（mermaid+katex 模块初始化） | 132.3 ms | `(anon)` |
| `rolldown-runtime`（chunk 加载器） | 60.6 ms | `(anon)` |
| `(program)` / GC / 其他 | ≈ 233 ms | |

定点核对（线上文件列偏移）：`react-vendor.DoOfiCS4.js` 列 572352/572424/572512/572968/573253 都是 Prism 的实现——

```js
// col 572352
util:{type:function(e){...}, objId:function(e){return e.__id||Object.defineProperty(e,"__id",{value:++Qd}),e.__id}, clone:function e(t,n){...}}
// col 572968
languages:{plain:Jd, ..., insertBefore:function(e,t,n,r){...}, extend:function(e,t){var n=ep.util.clone(...)}
// col 573253
DFS:function e(t,n,r,a){a=a||{};var i=ep.util.objId;for(var o in t) if(t.hasOwnProperty(o)){n.call(t,o,t[o],r||o); ... e(s,n,o,a)}}
// col 576401（refractor 的 register）
cp.register=function(e){if("function"!=typeof e||!e.displayName)throw new Error("Expected `function` for `syntax`, got `"+e+"`"); ...}
```

### 4.5 主线程热点归属（11.16 s 采样，idle 8.41 s，busy 2.75 s）

| 归属 | 自耗时 | 备注 |
|---|---|---|
| 原生/V8（非 idle） | ≈ 1693 ms | `setTimeout` 46.8、`clearTimeout` 43.4、`requestAnimationFrame` 34.8、GC 34.4 |
| 自有 `react-vendor` | 330.4 ms | Prism/refractor 为主 |
| 自有 `diagrams`（mermaid+katex） | 252.9 ms | 模块初始化 + 解析器 |
| 自有 `animations`（framer-motion） | 129.7 ms | `$s` 42.2 |
| 第三方 `scripts.clarity.ms` | **124.2 ms** | 见 4.8 |
| 自有 `rolldown-runtime` | 71.8 ms | chunk 引导 |
| 第三方 `cdn.jsdelivr.net`（cap 控件） | 38.8 ms | `_spawn` 4.2 |
| 浏览器扩展 2 个 | 50.7 ms | |
| 其余自有 chunk | ≈ 60 ms | useAuth/utils/index/pdf/charts… |

GC：9 次 MinorGC（各 1.2~1.8 ms），`jsHeapSizeUsed` 11.7 MB → 20.3 MB，主线程 GC 自耗时 34.4 ms。

### 4.6 长任务与丢帧

| 区间 | 时长 | 内容 |
|---|---|---|
| 265 → 416 ms | 150.9 ms | HTML 解析（其中扩展脚本 135 ms） |
| 5700 → 5802 ms | 102.2 ms | `LargeScriptCatchup` ×8（大脚本主线程补编译） |
| **5802 → 6426 ms** | **623.6 ms** | 621 ms 模块求值（4.4） |
| 6667 → 6706 ms | 38.8 ms | 首屏布局/绘制 |
| 7272 → 7345 ms | 72.5 ms | React 提交 + rAF（对应当次丢帧） |
| 7773 → 7811 ms | 38.7 ms | Clarity 脚本求值 |

丢帧 9 次；`UpdateLayer` 从 6706 ms 持续到 11471 ms（3 624 次）＝ 首屏之后页面一直有逐帧的 layer 更新（framer-motion 动画 + cap 控件进度动画 + 计时器抖动）。

### 4.7 Cap（trycap）Proof-of-Work 的 CPU 成本

| 事实 | 数值 |
|---|---|
| 控件脚本 | `https://cdn.jsdelivr.net/npm/@cap.js/widget@0.1.58`（第三方源） |
| `createUI()` | +8963 ms |
| Worker 创建 | 第 1 个 +8984 ms，其余 12 个 +10 667~10 695 ms |
| WASM 实例 | 13（`V8PerIsolateData::Initialize` 13 次） |
| 重计算 Worker | 8 个：`RunTask` 696~732 ms/核，窗口 +10 693 s → trace 结束（仍运行） |
| Worker CPU 合计 | **≈ 5 911 ms**（全部 Worker 线程 `RunTask` 求和） |
| 其他 | `CompressionStream Deflate` 6 次（+7898/+8906/+10964 各两次） |

含义：PoW 一开算就吃满 ~13 个逻辑核，且与「首屏动画 + React 提交 + Clarity」在同一时间窗竞争，10.07 s / 11.02 s 的丢帧与此吻合。

### 4.8 第三方与浏览器扩展噪声（不是主因，但可回收）

- **Microsoft Clarity**（`scripts.clarity.ms/0.8.70/clarity.js`）：`v8.run` 于 +7453 ms（0.6 ms）与 +7774 ms（**37.0 ms**）；主线程归属 **124.2 ms**（`(anon)` 28.5、`Mi` 25.3、`zi` 24.2、`start` 19.5）。来源：`frontend/src/App.tsx` 里 `import('@microsoft/clarity')`。
- **浏览器扩展**：`bgnkhhnnamicmpeenaelnjfhikgbkllg`（+271 ms，`EvaluateScript` 85.8 ms）与 `dhdgffkkebhmkfjojejmpbldmpobfkfo`（+361 ms，49.3 ms + 27.6 ms）；主线程合计 ~51 ms，属于环境噪声（真实用户装翻译/脚本类扩展同样会付这份成本）。
- 另一标签页（PID 7972/11160）主线程各 ~223 ms / 41 ms，且 7972 带 WebRTC 线程，对本次观测有轻微干扰。

---

## 五、根因分析（可定位到文件与行号）

### R1 入口把重资源变成全站首屏依赖（最关键）

```
frontend/src/App.tsx:8        import { BroadcastModalProvider } from './components/BroadcastModal';   // 静态
frontend/src/components/BroadcastModal.tsx:5   import MarkdownRenderer from './MarkdownRenderer';        // 静态
frontend/src/components/MarkdownRenderer.tsx:5-10
    import rehypeKatex from 'rehype-katex';
    import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
    import 'katex/dist/katex.min.css';
    import Mermaid from './Mermaid';
frontend/src/components/Mermaid.tsx:2          import mermaid from 'mermaid';                            // 静态
```

- `App.tsx` 在**应用根部**静态引入 `BroadcastModalProvider`（第 8 行）、`FirstVisitVerification`（第 18 行）、`ArticleCommandPalette`（第 25 行），这些都在所有路由（包括 `/captcha-verify`）的初始模块图里。
- 对照良好实践：同一个 `App.tsx:82` 的 `const AnnouncementModal = React.lazy(() => import('./components/AnnouncementModal'))` 就是正确写法。
- 全仓有 **12 个**组件静态 `import './MarkdownRenderer'`（`AnnouncementManager`、`AnnouncementModal`、`ArtifactSharePage`、`BroadcastModal`、`LibreChatAdminPage`、`LibreChatRealtimeDialog`、`LibreChatPage`、`MarkdownArticleManager`、`MarkdownArticlePage`、`MarkdownPreview`、`MarkdownExportPage`、`TicketSystem`）。其中多数自身已挂在 lazy 路由/对话框后面，但只要**有一个**被静态路由或根级 Provider 引到，整条 mermaid+katex+prism 链就进首屏——`BroadcastModal` 就是这一个。

### R2 全量 Prism（621 ms 长任务的主犯）

| 位置 | 写法 | 代价 |
|---|---|---|
| `components/MarkdownRenderer.tsx:6` | `import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'` | 走 `refractor/all` |
| `components/ArtifactSharePage.tsx:19` | 同上 | 同上 |
| `components/DataCollectionManager.tsx:9-12` | `PrismLight` + 仅注册 `json`/`javascript` | ✅ 正确范式 |

`react-syntax-highlighter/dist/esm/prism.js` 的依赖是 `refractor/all`，而 `node_modules/.pnpm/refractor@5.0.0/node_modules/refractor/lib/all.js` 有 **298 条语言 `import`**，模块加载即逐个 `register()` → 每个语法触发 Prism 的 `languages.extend / insertBefore / util.clone / languages.DFS`，正是 4.4 中 136.8 ms 的 `DFS` 与 `objId/type/clone` 递归。

### R3 `getManualChunk` 前缀匹配 bug（把 react-vendor 变成巨型包，并连带 charts/pdf）

```ts
// frontend/vite.config.ts:105-113
function getManualChunk(id: string): string | undefined {
  const normalized = id.replace(/\\/g, "/");
  for (const [chunkName, deps] of Object.entries(MANUAL_CHUNKS)) {
    if (deps.some((dep) => normalized.includes(`/node_modules/${dep}/`) || normalized.includes(`/node_modules/${dep}`))) {
      //                                                            ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ 前缀命中
      return chunkName;
    }
  }
}
```

- `MANUAL_CHUNKS` 第一项就是 `"react-vendor": ["react", "react-dom"]`，而 `'/node_modules/react'` 是 `react-router-dom`、`react-toastify`、`react-markdown`、`react-syntax-highlighter`、`react-chartjs-2`… 的**公共前缀**。
- 后果：本应独立的 `router` / `toast` / `code-highlight` / `charts(react-chartjs-2)` 全部落进 `react-vendor`（已实测），`react-vendor` 因此静态依赖 `chart.js`（`charts` 包）等，把 604 KB 的 pdf（jspdf/html2canvas）与 176 KB 的 charts 一起拖上首屏。
- 二次伤害：`react-syntax-highlighter` 被吞进 `react-vendor` 后，其唯一依赖 `refractor`（`prismjs` fork）因为 `manualChunks` 返回 `undefined`，被 rolldown 合并进同一 chunk —— 于是 **1.3 MB 的 `react-vendor` 里塞了整份 Prism**。

### R4 `diagrams` = mermaid + katex 单包 5.43 MB

```ts
// frontend/vite.config.ts:78
diagrams: ["mermaid", "katex"],
```

- 5 431 069 B / 1.71 MB gzip，单文件下载 3.64 s；`diagrams.DEU8FiFl.css`（mermaid 样式，30 KB）还是 head 里的渲染阻塞样式表。
- mermaid 与 katex 的使用场景几乎不重叠（图表 vs 数学公式），却被绑成一个 chunk：**任一方被静态引用，另一方也必须下载**。

### R5 Cap PoW 时机与核数

- `frontend/src/components/CapWidget.tsx:15` 固定 `@cap.js/widget@0.1.58`（第三方 CDN），控件自动在挂载时取挑战并解题，13 个 Worker 于首帧后 4 s 开算，占满 CPU（4.7 节）。
- 服务端难度/核数由自托管 Cap 实例决定，本仓库看不到参数；但「首帧后立即满核计算」这件事与首屏动画/交互的优先级关系，是本页可优化的。

### R6 其他可回收项

- 只用 gzip、HTTP/1.1：`diagrams` 换 Brotli 约可省 25~30%（≈1.2 MB gz）。
- Clarity 在 `/captcha-verify` 无业务价值，却花掉 124 ms 主线程。
- 首帧后 3 624 次 `UpdateLayer` + 487 次 `TimerInstall` + `setTimeout/clearTimeout` 90 ms 主线程：动画/轮询抖动（`framer-motion` `$s` 42.2 ms）。

---

## 六、优化建议（按收益/成本排序）

> 所有改动只改代码，构建/压测一律在 CI 或预发执行。

### P0-1 让重组件懒加载（一行改动级别，直接砍掉 5.43 MB + 604 KB + 176 KB 首屏）

```tsx
// frontend/src/components/BroadcastModal.tsx
- import MarkdownRenderer from './MarkdownRenderer';
+ const MarkdownRenderer = React.lazy(() => import('./MarkdownRenderer'));
// 渲染处包一层 <Suspense fallback={null}>（弹窗未打开时本就不会渲染，兜底可为 null）
```

```tsx
// frontend/src/App.tsx
- import { BroadcastModalProvider } from './components/BroadcastModal';
+ const BroadcastModalProvider = React.lazy(() =>
+   import('./components/BroadcastModal').then((m) => ({ default: m.BroadcastModalProvider }))
+ );
```

`App.tsx` 里另外三个静态引入（`FirstVisitVerification:18`、`FingerprintRequestModal:20`、`ArticleCommandPalette:25`）按同样方式处理；`AnnouncementModal:82` 已经是正确的 lazy 写法，可对照。总原则：**只要某组件在 `/captcha-verify` 上不会展示，就不该进初始模块图**。

改完后建议用 `vite build` 的产物核对 `dist/index.html`：`modulepreload` 只剩入口 + `rolldown-runtime` + 真实共享依赖。

验收判据：构建后的 `dist/index.html` 中 `modulepreload` 不得再出现 `diagrams`、`pdf`、`charts`。

### P0-2 干掉全量 Prism

```tsx
// frontend/src/components/MarkdownRenderer.tsx
- import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
+ import { PrismLight as SyntaxHighlighter } from 'react-syntax-highlighter';
+ import ts from 'react-syntax-highlighter/dist/esm/languages/prism/typescript';
+ import bash from 'react-syntax-highlighter/dist/esm/languages/prism/bash';
+ import json from 'react-syntax-highlighter/dist/esm/languages/prism/json';
+ // ...只登记真正会展示的 5~8 种
+ SyntaxHighlighter.registerLanguage('typescript', ts);
```

- 顺带把 `frontend/src/components/ArtifactSharePage.tsx:19` 也换掉（`declarations.d.ts` / `types/react-syntax-highlighter.d.ts` 已经声明了 `PrismLight` 用法所需的子路径）。
- 预期：621 ms 长任务里 ~200 ms 直接消失，`react-vendor`/`code-highlight` 体积也显著下降；若语言表仍然偏大，可评估改 `shiki`（按需）或 `highlight.js` 的 core + 少量语言。

### P0-3 修 `getManualChunk` 的前缀匹配

```ts
// frontend/vite.config.ts:105
function getManualChunk(id: string): string | undefined {
  const normalized = id.replace(/\\/g, "/");
  const inPkg = (dep: string) =>
    normalized.includes(`/node_modules/${dep}/`) ||                 // 普通安装
    normalized.includes(`/node_modules/.pnpm/${dep}@`);             // pnpm 虚拟store
  for (const [chunkName, deps] of Object.entries(MANUAL_CHUNKS)) {
    if (deps.some(inPkg)) return chunkName;
  }
}
```

补充建议：
- `MANUAL_CHUNKS` 里把 `react-router`（包名）也显式列出，并把 `prismjs`/`refractor` 放进 `code-highlight`，避免它们随 `react-syntax-highlighter` 一起落进 `react-vendor`。
- 改完请在 CI 用 bundle 分析（`rollup-plugin-visualizer` / `vite-bundle-analyzer`）核对：`react-vendor` 应只剩 `react`+`react-dom`，且不再 import `charts`/`pdf`。

### P1-1 拆 `diagrams`，并让路径按需

- 把 `MANUAL_CHUNKS` 的 `diagrams` 拆成 `mermaid` / `katex` 两个包（各自 lazy），`import 'katex/dist/katex.min.css'` 跟随 katex 的 lazy 边界加载，`diagrams.DEU8FiFl.css` 不应出现在 HTML head。
- mermaid 侧进一步按需：只在 `MarkdownRenderer` 渲染到 `mermaid` 代码块时 `await import('mermaid')`；把 `mermaid.initialize()` 从 `Mermaid.tsx` 模块顶层移进首次渲染（模块级副作用会让任何 import 都触发初始化）。
- 若仍有 1 MB+ 单包，评估把图表渲染改为服务端/后端预渲染，或换更轻的实现。

### P1-2 边缘侧压缩与协议

- openresty 开启 Brotli（`brotli on; brotli_static on;`，优先 br，`Vary: Accept-Encoding` 已有），`diagrams` 预计 1.71 MB → ≈1.2 MB gz 等价值。
- 开启 HTTP/2（或 HTTP/3）：现在 11 个 chunk 在 HTTP/1.1 的 6 连接上限下排队，直接放大等待。
- 可选：`accept-ranges`/预压缩静态文件（`gzip_static` + `brotli_static`）避免每次动态压缩。

### P1-3 Cap PoW 的时机与核数

- 把解题推迟到首帧之后（例如 `requestIdleCallback` / `load` 后 300~500 ms），或改成用户第一次交互（提交表单）时再解，避免与首屏动画争 CPU。
- 与服务端自托管 Cap 实例确认 `challengeCount/challengeSize` 是否过高；前端侧对 Worker 数设上限（例如 `Math.min(navigator.hardwareConcurrency, 4)`，若控件支持），低端机不要开 13 个 WASM 实例。
- 可评估自托管 `@cap.js/widget`（放到 `cap.chloemlla.com`，与 `preconnect` 一致），减少第三方域名的 DNS/TLS 与供应链风险。

### P2-1 第三方与动画抖动

- Microsoft Clarity：`/captcha-verify`（及所有验证类页面）不加载，或延后到 `requestIdleCallback` + 首次交互后再初始化（`App.tsx` 的 `import('@microsoft/clarity')` 分支加路由判断）。
- 首帧后 3 624 次 `UpdateLayer`：把逐帧 JS 动画换成纯 CSS 动画（进度条/呼吸灯），复核 `framer-motion` 的 `LazyMotion`（已在用）是否仍有组件用了完整 `motion`；`setTimeout/clearTimeout` 抖动（90 ms）建议合并为单个 `requestAnimationFrame` 驱动。
- 减少 head 里的 `preconnect`：现在无条件预热 google/hcaptcha/turnstile/cap/jsdelivr 5 个第三方源，可按当前启用的验证供应商条件注入（由后端 CSP/模板按配置下发）。

### P2-2 加 CI 预算守卫（防止回退）

新增 `scripts/perf/check-entry-graph.mjs`（Node ESM，无第三方依赖，风格对齐 `scripts/sync/*.mjs`），在 CI 构建后执行：

1. 解析 `frontend/dist/index.html` 的 `modulepreload`/`stylesheet` 列表；
2. 若列表里出现 `diagrams|pdf|charts|prism|katex|mermaid` 命中的 chunk 文件名 → 退出码 1；
3. 若任一「入口静态可达」的 chunk 原始体积 > 500 KB → 退出码 1；
4. 断言入口静态可达 JS 的 gzip 总量 < 500 KB。

同时在 CI 里跑一次 `vite build` 的 bundle 分析产物归档，便于回归对比。

---

## 七、验证方式（只在 CI / 预发执行）

1. `npm run build`（CI）→ 检查 `dist/index.html` 的 `modulepreload` 列表（P0-1 的验收判据）。
2. CI 跑 `check-entry-graph.mjs` 守卫脚本。
3. 预发环境用 Lighthouse（移动端 4G 限速）测 `/captcha-verify`：目标 **FCP < 1.5 s、TBT < 200 ms**（当前实测 FCP 6.73 s、类 TBT 749 ms）。
4. 真实用户侧对比：同一 gz 总字节（2.52 MiB → 目标 < 500 KiB）+ `PerformanceObserver` 记录 `longtask`。

---

## 八、附录：复现分析的命令与原始数据

从 gz 到可查询的 JSON（不依赖任何第三方包）：

```bash
gzip -dc "D:/Downloads/Trace-20261001T135120.json.gz" > trace.json
```

解析要点（Node ESM 脚本，本次使用的等价片段）：

```js
// 1) 线程/进程与总量
const t = JSON.parse(readFileSync('trace.json', 'utf8'));
const events = t.traceEvents;                       // 130 027
// 2) 主线程长任务（RunTask，dur 单位 µs）
events.filter(e => e.pid === 7872 && e.tid === 14740 && e.name === 'RunTask' && e.ph === 'X')
      .sort((a, b) => b.dur - a.dur);
// 3) 大脚本下载/后台编译：BackgroundJSStreamManager::RunScriptStreamingTask（args.url）
// 4) 模块求值：v8.evaluateModule（621.2 ms）
// 5) CPU 热点：合并 ProfileChunk（args.data.cpuProfile.nodes + samples + timeDeltas 累加时间戳）
// 6) 首屏：firstPaint / firstContentfulPaint（6734 ms）、MarkDOMContent、MarkLoad
```

关键原始数字备查：

| 项 | 值 |
|---|---|
| trace 覆盖 | 11.48 s；主线程 busy 2549 ms；profile busy 2751 ms（idle 8410.8 ms） |
| 入口求值 | `v8.evaluateModule` 621.2 ms（+5802 ms），`ModuleEvaluated` +6423 ms |
| FCP | 6734 ms |
| 长任务 | 150.9 / 102.2 / 623.6 / 38.8 / 72.5 / 38.7 ms |
| 丢帧 | 6917, 7284, 7301, 7317, 10067×2, 10084, 11017, 11084 ms |
| `UpdateLayer` | 3 624 次（6706 ms → 11471 ms） |
| 首屏 JS | 8 078 491 B raw / 2 647 061 B gzip（11 chunk） |
| 最大单包 | `diagrams` 5 431 069 B raw / 1 709 735 B gzip |
| Prism 语法数 | 298（`refractor/lib/all.js`） |
| Cap Worker | 13 个，重计算 8 个 × ~700 ms，合计 ≈5 911 ms CPU |
| Clarity 主线程 | 124.2 ms |

---

## 九、修复记录（本仓库已落地的改动）

> 原则：本地不构建/不测试，只做静态审查与代码修改；打包体积、首屏闭包与行为回归一律由 CI（`tsc.yml` / `quality-guardrails.yml` 的 Frontend bundle budget）验证。

| 编号 | 根因 | 改动 | 文件 |
|---|---|---|---|
| F1 | R1 入口静态引入 Markdown 链 | `BroadcastModalProvider` 保持轻量，正文改用 `React.lazy(() => import('./MarkdownRenderer'))` + `Suspense` | `frontend/src/components/BroadcastModal.tsx` |
| F2 | R2 全量 Prism（298 语法） | 新增共享入口 `PrismLight` + 白名单注册（20 个语法）+ 别名表 + 未注册语言退化纯文本；`MarkdownRenderer` / `ArtifactSharePage` 改用它 | `frontend/src/utils/codeHighlight.ts`、`components/MarkdownRenderer.tsx`、`components/ArtifactSharePage.tsx` |
| F3 | R4 mermaid 5.43 MB 进首屏 | `Mermaid.tsx` 改为 `import('mermaid')` 按需加载，并把 `mermaid.initialize()` 移到加载完成之后（模块顶层不再有副作用） | `frontend/src/components/Mermaid.tsx` |
| F4 | R3 前缀匹配吞包 | `getManualChunk` 改为带分隔符的精确包匹配（兼容 pnpm `.pnpm/<pkg>@` 与 scoped 包），`react-router-dom` / `react-toastify` / `react-markdown` / `react-syntax-highlighter` / `react-chartjs-2` / `react-icons` 不再被并进 `react-vendor` | `frontend/vite.config.ts` |
| F5 | R4 单包过大 | `diagrams` 拆成 `mermaid` + `katex`；新增 `markdown`（react-markdown 家族）与 `code-highlight`（含 refractor）分块 | `frontend/vite.config.ts` |
| F6 | R5 PoW 抢 CPU | Cap 脚本默认等首帧绘制后空闲再注入；`data-cap-worker-count` 收敛到 `min(hardwareConcurrency, 8)`（官方默认上限），新增 `workerCount` / `deferUntilIdle` 两个可调属性 | `frontend/src/components/CapWidget.tsx`、`frontend/src/utils/scheduleAfterPaint.ts` |
| F7 | R6 Clarity 124 ms + 逐帧采集 | `/captcha-verify`、`/hcaptcha-verify` 不再初始化 Clarity；其余路由延后到首帧空闲后再初始化 | `frontend/src/App.tsx` |
| F8 | 回归防线 | bundle 预算脚本新增「首屏静态闭包」校验：入口静态依赖里出现 `mermaid/katex/diagrams/pdf/charts/code-highlight/prism/markdown/docx/swagger/hugeicons` 任一 chunk 即失败，闭包 gzip 总量超过 `FRONTEND_FIRST_SCREEN_MAX_GZIP_KB`（默认 800）即失败 | `scripts/governance/check-frontend-bundle.js` |

### 仍未落地（属于部署侧，需要运维配合）

1. **Brotli**：openresty 目前只回 `Content-Encoding: gzip`（即使客户端 `Accept-Encoding: br`）。开启 `brotli on; brotli_static on;` 后 5.43 MB 的 mermaid 预计再省 25~30%。
2. **HTTP/2/3**：现在 11 个 chunk 在 HTTP/1.1 的 6 连接上限下排队，直接放大等待。
3. **Cap 难度**：`challengeCount/challengeSize` 在自托管 Cap 实例侧，仓库看不到；若求解时长偏高可与 F6 的 Worker 数一起调。

### 上线判据（CI / 预发）

1. `pnpm run check:frontend-bundle` 通过，且打印的 first-screen 闭包里不含 `mermaid./katex./markdown./code-highlight./pdf./charts.`；
2. 预发 Lighthouse（移动端 4G）：`/captcha-verify` 目标 **FCP < 1.5 s、TBT < 200 ms**（修复前实测 6.73 s / 749 ms）；
3. 真实用户侧 `longtask` 观测：不应再出现 600 ms 级别的模块求值长任务。
