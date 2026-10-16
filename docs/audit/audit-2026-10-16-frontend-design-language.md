# 前端设计语言统一：审查与修复清单（2026-10-16）

> **任务来源**：owner 要求「所有前端统一以 `frontend/src/components/ResourceStoreList.tsx` 的实际设计语言为基准」，
> 沿用 `studioTheme.tsx` 的 tokens/helper，不得另起蓝紫渐变 / Apple 蓝 / Pixel 独立配色，
> 不得单独沿用 GeoGebra 蓝黑视觉或 GGGGGG（Pixel 来源仓库）的独立视觉；
> 并逐项满足 loading/error/empty/success 四态、reduced motion、移动端触控、bundle budget。
> 流程遵循 `verified-methodology.md` §一-8（先落盘清单，再对症修复）与 §二（并行 subagent + 逐份 `git diff` 核查）。
>
> **视觉基准（唯一事实源）**：`frontend/src/components/ResourceStoreList.tsx` + `frontend/src/components/studioTheme.tsx`
> （本次已完整通读，906 + 340 行）。
>
> **基线 commit**：`3959442082242dc35be4071c70cd7d82bb5dc2c8`（2026-10-16 20:49 +0800）。
> 本仓当前有**其他会话在并发提交**（审查期间 HEAD 从 `0fbd3ee4` 变为 `3959442`），
> 因此每条缺陷都带文件路径与行号，修复前以 `git status` 全量输出确认在飞 WIP。
>
> **本文性质**：只读审查 + 修复清单。除本文档外不改动生产代码，不运行本地构建/测试/lint（`AGENTS.md` §0-1）。
> 编号 `FD-xxx` 供修复批次与收尾逐条追溯。

---

## 0. 结论速览

| 类别 | 现状 | 规模 | 判定 |
| --- | --- | --- | --- |
| A 第二套设计系统 | `components/ui/*` + `layout/*` 走 shadcn/base-ui，`:root` 里写死 **oklch indigo-violet "Synapse brand"**；`tailwind.config.js` 另有一套 legacy 色板；`index.css` 用 `!important` 覆盖层伪造统一 | 4 个地基文件 + 10 个 ui/layout 文件 | **必须拆除**（FD-001～FD-010） |
| B 禁用配色 | indigo/purple/fuchsia/pink 160+60+0+14 命中 / 38 文件；11 个文件 1104 处任意 hex；21 个文件仍有 `bg-gradient-to-*` | 38 + 11 + 21 文件 | **必须改**（FD-011～FD-030） |
| C 语义色漂移 | `red-*` 280 处/29 文件（应为 rose）；`green-*` 175/17（应为 emerald）；`yellow-*` 66/13（应为 amber）；`gray-*` 17/4（应为 slate） | 4 组共 ~540 处 | **必须改**（FD-031～FD-034） |
| D Token 未复用 | 115 个 `.tsx` 完全不 import `studioTheme`，大量手写与 token 逐字相同的 Tailwind 串（含新并入的 geogebra/pixel 全部组件） | 115 文件 | **必须改**（FD-035～FD-045） |
| E 结构不一致 | 无 hero/main/sidebar 骨架、未用 `studioPageClassName`、列数不按 1/2/3 响应式、modal 未走 `studioModal*` | 大量 | **应改**（FD-046～FD-055） |
| F 状态缺失 | 60 个文件的 catch 只写 `console.error` 或空块（用户看不到失败）；只有 loading 无独立 error/empty 分支；自绘 spinner 而非 `UnifiedLoadingSpinner` | 60 文件 | **必须改**（FD-056～FD-062） |
| G 无障碍/动效/触控 | 85 个 framer-motion 文件无 reduced-motion 处理；298 个 `<button>` 缺 `type`；319 个文件无任何 `focus-visible:`；6 处可点 div 无 role | 见附录 | **必须改**（FD-063～FD-070） |
| H 性能/体积 | 重依赖（monaco/geogebra/chart.js/react-syntax-highlighter/katex/docx）静态 import；46 个文件 > 800 行（治理软上限） | 23 + 46 | **部分必须改**（FD-071～FD-078） |
| I 缺自动化闸门 | 无任何静态检查阻止新代码再引入禁用配色/token 漂移 | — | **新增**（FD-079） |

一句话：**配色层已经基本收敛到 slate（7870 处 slate 命中 / 262 文件），
但"地基"里还压着第二套 indigo-violet 设计系统、一套 legacy 色板和一个 `!important` 覆盖层；
再叠加 38 个文件仍在用 indigo/purple、11 个 demo/工具页整页任意 hex、115 个文件不复用 token。**
本轮的正题是**先拆地基、再逐页对齐 token、最后补四态与无障碍**，并加一道静态闸门防止回流。

---

## 1. 视觉基准（唯一事实源，逐条列出）

### 1.1 允许复用的 `studioTheme.tsx` 导出（新增代码只能从这里取）

| 类别 | token |
| --- | --- |
| 字体 | `studioPageFont`（`"Avenir Next","PingFang SC","Noto Sans SC","Microsoft YaHei",sans-serif`）、`studioDisplayFont` |
| 页面 | `studioPageClassName`（`mx-auto w-full max-w-none px-0 py-6 sm:py-8`） |
| 面/卡 | `studioHeroCardClassName`、`studioMainSurfaceClassName`、`studioPanelClassName`、`studioSubPanelClassName`、`studioElevatedPanelClassName`、`studioSurfaceClassName`、`studioTileClassName`、`studioDarkPanelClassName` |
| 表单 | `studioFieldClassName`、`studioTextareaClassName` |
| 按钮 | `studioPrimaryButtonClassName`、`studioSecondaryButtonClassName`、`studioMutedPrimaryButtonClassName`、`studioGhostButtonClassName`、`studioDangerButtonClassName` |
| 弹窗 | `studioModalOverlayClassName`（`z-[10050]`）、`studioModalCardClassName`、`studioModalCloseButtonClassName` |
| 标签 | `studioEyebrowClassName`、`studioEyebrowPillClassName`、`studioEyebrowAccentPillClassName`、`studioSoftBadgeClassName`、`studioStrongBadgeClassName`、`studioInfoRowClassName` |
| 函数 | `studioMetricToneClassName(tone)`、`studioPillClassName(active, tone)`、`studioBadgeClassName(tone)` |
| 装饰 | `studioAccentBlobBlueClassName`（`rgba(59,130,246,0.22)`）、`studioAccentBlobSkyClassName`（`rgba(14,165,233,0.16)`） |
| Info 族 | `InfoQueryShell`/`InfoQueryHero`/`InfoPanel`/`InfoMetricCard`/`InfoSectionTitle`/`InfoBadge`/`InfoPrimaryButton`/`getInfoToneClasses`/`InfoTone` |

`ResourceStoreList.tsx` 的实际骨架（必须照此对齐）：

```
<div className={studioPageClassName} style={{ fontFamily: studioPageFont }}>
  <div className="mx-auto max-w-7xl min-w-0">
    <motion.div className={cn("mb-5 sm:mb-8", studioHeroCardClassName)}>
      {studioAccentBlobBlueClassName + studioAccentBlobSkyClassName 各一颗，aria-hidden}
      <eyebrow pill><h1 text-[2rem] sm:text-5xl slate-900>{状态卡 3 列 sm:grid-cols-3}</h1>
    </motion.div>
    <div className="grid gap-4 sm:gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,400px)]">
      <motion.div className={studioMainSurfaceClassName}>{主内容：pill tab + 工具条 + 1/2/3 列卡片网格}</motion.div>
      <div className="min-w-0 space-y-4 sm:space-y-6">{侧栏 studioPanelClassName 面板}</div>
    </div>
  </div>
  <AnimatePresence>{studioModalOverlayClassName + studioModalCardClassName}</AnimatePresence>
</div>
```

### 1.2 允许的调色板

- 中性：**slate-50/100/200/300/400/500/600/700/800/900/950**；surface 用 `bg-white` / `bg-white/80` / `bg-white/90` / `bg-slate-50/80`。
- 主操作：`bg-slate-900` + `hover:bg-slate-800`（`studioPrimaryButtonClassName`）。
- 装饰：**仅** blue/sky 的轻量径向 blob（`rgba(59,130,246,…)`、`rgba(14,165,233,…)`）。
- 语义：成功 `emerald`、警告 `amber`、错误/危险 `rose`。
- 圆角：卡片/面/表单/按钮/弹窗一律 `rounded-2xl`；pill/徽标 `rounded-full`。
- 阴影：`shadow-sm`；模糊：`backdrop-blur-xl`。
- 动效：`framer-motion` 的 `opacity/y/scale`，`duration 0.45～0.5`、`delay ≤ 0.2`，并遵守 reduced motion。

### 1.3 禁止清单（本轮判据）

1. indigo / purple / fuchsia / pink 任何色阶（`studioBadgeClassName('violet')` 与 `InfoTone='violet'` 是既有白名单例外，**新代码不得新增**）。
2. 任意值颜色 `bg-[#...]` / `text-[rgb(...)]` / `border-[oklch(...)]`。
3. Apple 系统蓝 `#007AFF` / `#0A84FF`，以及把 `#2563eb`/`#3b82f6`/`#1d4ed8` 当作主色。
4. 高饱和双色渐变 `bg-gradient-to-*`（`studioAccentBlob*` 使用的 radial 装饰除外）。
5. 整页深色底（`bg-gray-900|950`、`bg-slate-950`、`bg-black`）；`studioDarkPanelClassName` 只作局部深色强调块。
6. 非 slate 中性阶（`gray-*`/`zinc-*`/`neutral-*`/`stone-*`）。
7. `red-*`（→ rose）、`green-*`（→ emerald）、`yellow-*`（→ amber）。
8. 第二套 UI kit 的语义 token（`bg-primary`、`text-muted-foreground`、`border-sidebar` …）与 oklch 变量。
9. `tailwind.config.js` 的 legacy 色名（`ink-black`/`dark-slate`/`wheat`/`burnt-orange`/`midnight-violet`）与 `font-songti`。
10. 非 `rounded-2xl`/`rounded-full` 的卡片圆角（`rounded-sm|md|lg|xl` 目前 526 处 / 123 文件）。

---

## 2. 缺陷清单

> 每条字段：`编号` / 位置 / 类型 / 详细错误信息 / 建议改法。
> 附录 A 给出可直接照抄的完整文件清单与命中数。

### A. 第二套设计系统（地基级，必须先拆）

#### FD-001 `frontend/src/styles/sidebar-theme.css` — 站内第二个主色（indigo-violet）
- **位置**：`:root` 块，`--primary: oklch(0.45 0.16 265); /* indigo-violet, Synapse brand */`、
  `--ring: oklch(0.55 0.16 265)`、`--sidebar-primary: oklch(0.48 0.17 265)`、
  `--accent: color-mix(in oklch, var(--primary) 10%, var(--background))`。
- **类型**：配色基准冲突（另行一套品牌主色）。
- **详情**：文件头注释自称 "Existing Synapse slate/indigo visual language is preserved"，
  但实际把 `--primary` 定义为一个**独立的 265° 蓝紫**，与 `studioPrimaryButtonClassName` 的
  `bg-slate-900` 无关。`components/ui/button.tsx` 的 `default` 变体吃 `bg-primary`，
  于是同一个站里「主按钮」有两种颜色：studio 页是 slate-900，sidebar/ui 页是蓝紫。
- **改法**：把 `--primary`、`--ring`、`--sidebar-primary`、`--sidebar-ring`、`--accent`、
  `--accent-foreground` 全部改为 slate 刻度（`--primary: #0f172a`；`--ring: #94a3b8`；
  `--accent: #f1f5f9`），或在 `sidebar-theme.css` 顶部注释明确声明「仅 shell chrome 使用，
  且主色必须等于 slate-900」。同步修 `--radius` 语义：`--radius: 0.75rem` 时
  `--radius-xl = 1.05rem`，与 `rounded-2xl`(1rem) 不一致 → 令 `--radius-xl: 1rem`。

#### FD-002 `frontend/tailwind.config.js` — **整份文件是死配置**（比想象的严重）
- **位置**：`theme.extend.colors` 的 `ink-black: '#04151f'`、`dark-slate: '#183a37'`、
  `wheat: '#efd6ac'`、`burnt-orange: '#c44900'`、`midnight-violet: '#432534'`；
  `fontFamily.songti`；`screens.xs: '480px'`；`animation['bounce-slow']`；`minHeight.btn-*`；
  `plugin: tailwind-scrollbar`。
- **类型**：第二套色板 + 主题声明完全不生效。
- **详情（已实测确认，不是推测）**：仓库使用 Tailwind v4（`index.css` 的 `@import "tailwindcss"`
  + `@tailwindcss/postcss@4.3.3`），全仓**没有任何 `@config` 指令**；
  实测把 `screens.xs` 改成 `481px`、并把同份配置放到 CSS 文件旁边，编译输出里均**不出现 `481px`** ⇒
  v4 既不自探项目根配置、也不自探相邻目录配置。
  后果（都是静默的，没有报错）：
  - `xs:` 变体（`components/TigerAdventure.tsx` 14 处，如 `L1134 xs:left-6 xs:right-6`、
    `L1144 xs:text-2xl`、`L1174 xs:flex-row`）被整类丢弃 → 480–640px 区间没拿到预期样式；
  - `font-songti`（`FBIWantedManager.tsx` 9 处 + `ShortLinkManager.tsx` 11 处）被丢弃；
  - `animate-bounce-slow`（`tailwind.config.js` 定义）被丢弃；
  - 5 个 legacy 色名全仓零引用。
- **改法**：删除 `frontend/tailwind.config.js`；把真正需要的主题改成 v4 原生的 CSS 声明
  （`index.css` 的 `@theme { --breakpoint-xs: 480px; --font-sans: … }`）；
  `font-songti` 与 `animate-bounce-slow` 的使用点一并清掉（前者归 FD-025，后者归 FD-068）。
  `tailwind-scrollbar` 依赖保留在 `package.json`（移除需走 §十七 锁文件重生成），仅停用插件。

#### FD-003 `frontend/src/index.css` — `!important` 覆盖层伪造统一（最严重）
- **位置**：`index.css:205-303` 的 `.logshare-admin-surface` 一族规则，例如
  `:where([class*="bg-gradient-to-"]) { background-image: none !important }`、
  `[class*="rounded"][class*="border"] { border-radius: 26px !important; box-shadow: 0 18px 60px rgba(15,23,42,.06) !important }`、
  `[class*="text-indigo"], [class*="text-purple"], [class*="text-cyan"], [class*="text-orange"] { color: #334155 !important }`。
- **类型**：以 CSS 覆盖替代 token 收敛（隐藏真实配色漂移）。
- **详情**：使用方为 `App.tsx:688`、`components/admin/AdminHub.tsx`（5 处）、
  `AdminGuard.tsx`（3 处）、`AdminScopeManager.tsx`（2 处）、`SuperAdminGuard.tsx`。
  这层规则反向证明：管理端页面里确实存在 indigo/purple/cyan 配色，
  而且不是被改掉、只是被 `!important` 压成 slate；任何新增管理页都会继续累积。
  同一文件 `index.css:19-200` 还有一整套 Toastify 渐变皮肤
  （`index.css:142` `linear-gradient(90deg, #3b82f6, #6366f1)`、`index.css:148 color: #3b82f6`），
  以及 `index.css:582-905` 的 markdown 阅读器配色：`:root` 的浅色 `--md-*`
  （`--md-link: #0969da`）与 `.markdown-renderer.markdown-invert` / `.markdown-reader.markdown-invert`
  的深色反色变体（`--md-link: #7dd3fc`）。反色变体**是活的**
  （`components/MarkdownRenderer.tsx:405` 由 `invert` prop 驱动，用于深色聊天气泡），不属于死代码。
- **改法**：先把被覆盖的真实配色逐页改到 token（FD-011 起），再**整段删除**
  `.logshare-admin-surface` 及其 `App.tsx` / `admin/*` 的使用点；
  Toastify 皮肤改为读取 `studio*` 语义色（emerald/amber/rose/slate），去掉 `#6366f1`；
  markdown 阅读器的 `--md-*` 收敛为 slate + sky 强调色（`--md-link` 浅色改 `#0369a1`、
  反色变体沿用 `#7dd3fc`），`--md-*` 仍是既有 token 体系的一部分，**保留**。

#### FD-004 `frontend/src/components/ui/*`（9 个文件）— shadcn/base-ui 第二 UI kit
- **位置**：`button.tsx`（`bg-primary text-primary-foreground`、`rounded-lg`、`size-8`）、
  `sheet.tsx`、`sidebar.tsx`（10 处非 2xl 圆角）、`tooltip.tsx`、`skeleton.tsx`、
  `separator.tsx`、`scroll-area.tsx`、`Input.tsx`、`CredentialIdModal.tsx`。
- **类型**：第二套组件库 + 第二套圆角/尺寸刻度。
- **详情**：`button.tsx` 用 `class-variance-authority` + `@base-ui/react`，
  尺寸体系是 `h-6/h-7/h-8/h-9` + `rounded-md/lg`，与 `studioPrimaryButtonClassName`
  （`px-5 py-3.5 text-sm rounded-2xl`）完全不同；移动端触控目标 `h-7`(28px) 低于 44px 要求。
- **改法**：判定实际使用范围（当前只有 `layout/*` 与 `ui/*` 互相引用，见 FD-005）后
  整体删除，或把 `button.tsx` 各 variant 的 className 直接换成 `studio*ButtonClassName()`；
  `Input.tsx` 换成 `studioFieldClassName`。

#### FD-005 `frontend/src/layout/*`（4 个文件）— 唯一使用第二 UI kit 的位置
- **位置**：`DesktopShell.tsx`（`import DesktopShell = React.lazy(...)`，`App.tsx:50` 唯一引用）、
  `app-sidebar.tsx`、`nav-group.tsx`、`sidebar-view-header.tsx`。
- **类型**：app chrome 走第二视觉体系。
- **详情**：`layout/DesktopShell.tsx` 自身命中 1 处 forbidden hue；
  `app-sidebar.tsx` / `nav-group.tsx` 全部依赖 `components/ui/sidebar.tsx` 的
  `bg-sidebar`/`text-sidebar-foreground` token（即 FD-001 的 oklch 蓝紫）。
- **改法**：把 sidebar chrome 的配色改为 slate/white（`bg-white/80`、`border-slate-200`、
  激活态 `bg-slate-900 text-white`），并去掉对 `--sidebar-*` oklch 变量的依赖。

#### FD-006 `frontend/src/lib/utils.ts` 的 `cn` 与 `frontend/src/utils/cn.ts` 双份实现
- **类型**：基础工具重复。
- **详情**：`components/ui/*` 与 `layout/*` `import { cn } from '@/lib/utils'`，
  其余 340+ 文件 `import { cn } from '../utils/cn'`。两份 `cn` 若行为不一致，
  会让 TD-1 的 token 改造在 ui/layout 里表现不同。
- **改法**：保留 `utils/cn.ts`，`lib/utils.ts` 改为 re-export 或整体删除（连同 `@/` 别名是否仍需要）。

#### FD-007 `frontend/src/index.css:8-10` — 全局字体不是基准字体
- **位置**：`body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', ... }`。
- **类型**：字体基准缺失（基准要求 `Avenir Next` + 中文系统字体）。
- **详情**：基准字体目前靠每个页面的 `style={{ fontFamily: studioPageFont }}` 内联注入，
  26 个页面漏写即掉回 `-apple-system`，同一站出现两种正文观感。
- **改法**：`body` 直接设 `studioPageFont` 的字面值（CSS 不能 import TS 常量，
  需在 `index.css` 复制一份并在 `studioTheme.tsx` 注释双向指向），
  并逐步删除页面级内联 `fontFamily`。

#### FD-008 `frontend/src/components/studioTheme.tsx` — `violet` 语义缺口
- **位置**：`studioMetricToneClassName` 的 `violet` 与 `studioBadgeClassName('violet')`
  都退化为 slate；`InfoTone` 保留 `violet` 与真实 violet 色阶（`components/studioTheme.tsx`
  的 `toneClasses.violet`）。
- **类型**：token 语义不一致。
- **详情**：`ResourceStoreList.tsx` 的状态卡用 `tone: "violet"` 却渲染成 slate（`map.violet = 'border-slate-200 bg-slate-50/80'`），
  而 `InfoTone='violet'` 渲染成真 violet。同名不同色。
- **改法**：删除 `InfoTone` 的 `violet`（改为 `sky`/`slate`），或让 `studioMetricToneClassName('violet')` 明确映射到 sky。

#### FD-009 `frontend/src/main.tsx` — 导入顺序与全局副作用
- **类型**：待核（需确认 `index.css` / `sidebar-theme.css` 的导入链与 `.dark` 注入）。
- **改法**：FD-003 收敛后，确认 `styles/sidebar-theme.css` 的 `@theme inline` 是否仍有消费者；
  无消费者则整个文件删除。

#### FD-010 `frontend/src/styles/scrollbar.css` + `katex-fonts.css`
- **类型**：待核（是否与 `tailwind-scrollbar` 插件重复定义）。
- **改法**：合并为单一滚动条样式，色值改为 slate-200/300。

### B. 禁用配色 / 独立视觉

#### FD-011 `components/CDKStoreManager.tsx`（2082 行）— 33 处 purple
- **位置**：`L119 text-purple-500`、`L133 focus:ring-purple-500 focus:border-purple-500 rounded-md`、
  `L318/335/396/407` 同类表单、`L1171-1227` purple 图标/按钮/输入框。
- **类型**：禁用色（purple）+ 表单未复用 token + 非 2xl 圆角。
- **详情**：整个 CDK 管理页以 purple 为主色，与 `studioPrimaryButtonClassName` 的 slate-900
  并排放置时呈两种品牌；`rounded-md shadow-sm` 表单与 `studioFieldClassName` 不同。
- **改法**：purple → slate（图标 `text-slate-500`、主按钮 `studioPrimaryButtonClassName`、
  输入框 `studioFieldClassName`、焦点环 `ring-slate-300`）；文件本身按 FD-078 拆组件。

#### FD-012 `components/CommandManager.tsx`（1578 行）— 21 处 indigo/purple/pink
- **位置**：`L793 focus:ring-indigo-500`、`L875 bg-purple-500`、`L929-947 bg-purple-50/indigo-50`、
  `L984-987 bg-pink-50 text-pink-700`。
- **类型**：禁用色 + 指标卡未走 `InfoMetricCard`。
- **改法**：四张统计卡改用 `InfoMetricCard`（tone: slate/sky/emerald/amber），
  表单换 `studioFieldClassName`，按钮换 `studio*ButtonClassName`。

#### FD-013 `components/NexAISecurityDashboard.tsx` — 18 处 indigo
- **位置**：`L266 border-indigo-600` 加载环、`L301/335/365 text-indigo-600`、
  `L315 bg-indigo-600` tab、`L378-398 border-indigo-600 text-indigo-600 bg-indigo-50/30` tab 态。
- **类型**：禁用色 + 自绘 spinner（应 `UnifiedLoadingSpinner`）+ 自绘 tab（应 `studioPillClassName`）。
- **改法**：spinner → `<UnifiedLoadingSpinner />`；tab → `studioPillClassName(active)`；图标色 → slate-500/600。

#### FD-014 `components/EmailTraceability.tsx` — 17 处 indigo
- **位置**：`L190 bg-indigo-50 text-indigo-600`、`L227 bg-indigo-500` 进度条、
  `L258/269 focus:border-indigo-300 focus:ring-indigo-100` 搜索框、
  `L274 bg-indigo-600 hover:bg-indigo-700` 按钮、`L292 border-t-indigo-500` spinner。
- **类型**：禁用色 + `rounded-xl/lg` + 自绘 spinner。
- **改法**：按钮/输入统一 token；进度条 `bg-slate-900`；spinner 换共享组件。

#### FD-015 `components/ResourceStoreManager.tsx` — 9 处 indigo/purple + 3 处 gradient + 2 处 bg-black
- **类型**：与同域 `ResourceStoreList.tsx` 基准直接冲突（同功能域两种皮肤）。
- **改法**：按 `ResourceStoreList.tsx` 完全对齐（hero + main + sidebar）。

#### FD-016 `components/speech-to-text/SpeechToTextPage.tsx` + `TranscriptView.tsx` — 11 处 indigo
- **位置**：`SpeechToTextPage.tsx L348/389/458/467`、`TranscriptView.tsx L74/84 bg-indigo-600`。
- **改法**：tab/徽标走 `studioPillClassName`/`studioBadgeClassName`；进度条 slate-900。

#### FD-017 `components/admin/**` 内 12 个文件共 65 处禁用色
- **文件**：`AdminHub.tsx`(8)、`media-tool/JobsPanel.tsx`(8)、`media-tool/TranscribePanel.tsx`(7)、
  `crash-reports/CrashGroupListView.tsx`(7)、`qq-guard/AuditLogPanel.tsx`(7)、`AdminScopeManager.tsx`(6)、
  `MediaToolAdmin.tsx`(6)、`crash-reports/CrashGroupDetailView.tsx`(4)、`ip-risk-log/LookupsTab.tsx`(4)、
  `ip-risk-log/ui.tsx`(3)、`QqGuardManager.tsx`(3)、`ip-risk-log/OverviewTab.tsx`(1)、
  `qq-guard/CommandPanel.tsx`(1)、`AdminCommandPalette.tsx`(1)、`AdminOverviewPanel.tsx`(2)。
- **类型**：禁用色（同时被 FD-003 的 `!important` 层掩盖）。
- **改法**：逐文件把 indigo/violet 语义改写为 slate + sky + 语义色；改完全部后删除 `.logshare-admin-surface`。

#### FD-018 `App.tsx` — 6 处禁用色 + 非 slate 中性 + 渐变
- **位置**：`L240 bg-indigo-200`、`L1612 hover:text-indigo-600`、`L1637 bg-indigo-600 … focus-visible:ring-indigo-400`、
  `L1789 bg-gradient-to-r from-red-500 to-pink-500`、
  `L1525/1526 bg-gradient-to-br from-gray-50 to-gray-100`、
  `L1771 bg-gray-50`、`L1778-1779 text-gray-800/text-gray-600`。
- **类型**：禁用色 + 非 slate 中性 + 高饱和渐变 + 错误边界页未用 token。
- **改法**：`L409-410/465-466` 的落地页径向装饰保留（这是允许的 blue/sky radial），
  但 `#eef2ff`（indigo-50 底）改为 `#f8fafc`；`L1789` 红色渐变按钮 →
  `studioDangerButtonClassName`；`L1771-1779` 错误边界页 → `studioSurfaceClassName` + slate 文本。

#### FD-019 `types/fbi.ts:146-152` — 类型层里硬编码 Tailwind 色串
- **位置**：`color: 'text-gray-700'`、`bgColor: 'bg-gray-100'`、`text-purple-700`、`bg-purple-100`。
- **类型**：配色泄漏进数据模型。
- **改法**：`types/fbi.ts` 只保留语义枚举（如 `tone: 'slate' | 'rose'`），
  由消费组件映射到 `studioBadgeClassName(tone)`。

#### FD-020 `components/Notification.tsx:487-506` — 内联 SVG 硬编码 `#3b82f6`
- **类型**：Apple/原生蓝硬编码（且是 inline SVG attribute，不吃 Tailwind）。
- **改法**：`stroke="#3b82f6"` → `stroke="currentColor"` 并给容器 `text-slate-500`（info 用 sky-600）。

#### FD-021 demo 页整页任意 hex（4 个 demo 文件共 468 处）
- **文件**：`components/MeditationAppDemo.tsx`(170)、`components/FinanceAppDemo.tsx`(165)、
  `components/MusicPlayerDemo.tsx`(125)、`components/XiaohongshuDemo.tsx`(8)；
  另有 `components/ModListEditor.tsx`(164) 与 `components/CoinFlip.tsx`(5 处禁用色) 同属 demo 性质。
- **位置**：`FinanceAppDemo.tsx:199-205` canvas `createLinearGradient('#667eea' → '#764ba2')`、
  `L338 border-[#2a2a2a]`、`shadow-[0_20px_60px_rgba(0,0,0,0.3)]`；`MeditationAppDemo.tsx` 170 处。
- **类型**：独立视觉（紫罗兰渐变 + 手机壳拟物）。
- **详情**：这 4 个页面挂在 `App.tsx:773-776` 的 `/demo/*`（admin 路由），
  是**唯一**在站内呈现「另一套品牌」的地方，正是 owner 点名的「独立视觉」。
- **改法**：canvas 渐变改为 `ctx.createLinearGradient` 使用 `rgba(15,23,42,…)`→`rgba(100,116,139,…)`
  （slate 刻度）；容器 `border-[#2a2a2a]` → `border-slate-300`；`shadow-[…rgba(0,0,0,.3)]` → `shadow-sm`。
  若这些 demo 无产品价值，owner 可裁决直接下线（见 §5 挂起项）。

#### FD-022 `components/WebhookEventsManager.tsx`（1457 行）— 186 处任意 hex
- **位置**：`L650 border-[#8ECAE6]/30`、`L653 text-[#023047]/70`、`L658 focus:ring-[#FFB703]`、
  `L666 bg-[#023047]`、`L682 bg-[#FFB703] hover:bg-[#FB8500]`。
- **类型**：整页独立色板（深蓝 + 橙，与 slate/sky 完全无关）+ 非 2xl 圆角。
- **改法**：`#023047` → `text-slate-900`/`bg-slate-900`；`#8ECAE6` → `border-slate-200`；
  `#FFB703`/`#FB8500` → `studioPrimaryButtonClassName`（slate-900）；`#219EBC` → `text-sky-700`。

#### FD-023 `components/ShortLinkManager.tsx`（1273 行）— 179 处任意 hex + `font-songti`
- **位置**：`L143 classList.add('bg-[#8ECAE6]/30','text-[#219EBC]')`（命令式 class 注入！）、
  `L557-581 text-[#023047]/50`、`bg-[#023047]`、`text-[#FFB703]`。
- **类型**：独立色板 + 命令式 class 操作（改色时容易被正则漏掉）+ 非基准字体。
- **改法**：同上映射；`L143-145` 的 `classList.add/remove` 改为状态驱动的 `studioPillClassName`；
  `font-songti` → `studioPageFont`；顺带移除 `index.css` 的 `.font-songti` 补丁。

#### FD-024 `components/ModListEditor.tsx`（1001 行）— 164 处任意 hex
- **类型**：整页独立配色。
- **改法**：同 FD-022 的映射表（任意 hex → slate/sky 刻度）。

#### FD-025 `components/FBIWantedManager.tsx`（1360 行）+ `FBIWantedPublic.tsx` — 62 处任意 hex + 禁用色
- **位置**：`FBIWantedManager.tsx` 62 处任意 hex、9 处 `red-*`、2 处 `bg-black`；
  `FBIWantedPublic.tsx:440/546` 用 `cn(studioModalOverlayClassName, "z-50 bg-slate-950/55")` ——
  overlay 底色本身合规（`bg-slate-950/55` 是 `studioModalOverlayClassName` 的加深变体），
  但 `z-50` 覆盖了 token 的 `z-[10050]`，会被 MobileNav（`z-[9998]`）盖住（见 FD-050）。
- **类型**：独立配色 + `font-songti`（9 处）+ 弹窗层级覆盖。
- **改法**：任意 hex → slate；`font-songti` → `studioPageFont`；`red-*` → `rose-*`；
  去掉 `z-50`，保留 `studioModalOverlayClassName` 的层级。

#### FD-026 `components/SmartHumanCheck.tsx`（1464 行）— 36 处任意 hex
- **改法**：同上映射。

#### FD-027 `components/CloudflareChallengePage.tsx` — 7 处任意 hex + 1 处 bg-slate-900
- **改法**：任意 hex → slate/sky 刻度；深色底若为「挑战页」设计意图，改 `studioDarkPanelClassName` 局部使用。

#### FD-028 `components/LinuxDoAuthCallbackPage.tsx` — 2 处任意 hex + 1 处 gradient
- **改法**：对齐 `components/LoginPage.tsx` 的既有 auth 页骨架。

#### FD-029 `components/admin/**` + `layout/DesktopShell.tsx` 的零散禁用色
- 见 FD-017 清单；`layout/DesktopShell.tsx` 1 处。

#### FD-030 `frontend/index.html` / `frontend/vercel.json` favicon 与主题色
- **类型**：待核（是否有 `theme-color` meta 指向非 slate 值）。
- **改法**：若存在，改为 `#0f172a`。

### C. 中性色与语义色漂移

#### FD-031 `red-*` → `rose-*`（280 处 / 29 文件）
- **类型**：语义色不统一（危险色两种写法）。
- **详情**：`studioDangerButtonClassName` 与 `ResourceStoreList.tsx` 的错误块都用 rose；
  另有 29 个文件用 red，两种红在同一屏并列时肉眼可见。
- **改法**：逐文件替换 `-red-` → `-rose-`（保留 `red` 仅当引用第三方 CSS 变量）；
  注意 `text-red-500` 在暗底上的对比度需同步核（rose-400 更亮）。
- **完整清单**：附录 A / C1。

#### FD-032 `green-*` → `emerald-*`（175 处 / 17 文件）
- **改法**：同 FD-031；清单见附录 A / C2。

#### FD-033 `yellow-*` → `amber-*`（66 处 / 13 文件）
- **改法**：同 FD-031；清单见附录 A / C3。

#### FD-034 `gray-*` → `slate-*`（17 处 / 4 文件）
- **文件**：`App.tsx`(8)、`components/FinanceAppDemo.tsx`(5)、`components/ApiKeyManager.tsx`(3)、
  `types/fbi.ts`(2)、`components/MeditationAppDemo.tsx`(1)。
- **改法**：同 FD-031。

### D. Token 未复用（手写串与 token 逐字重复 → 必然漂移）

#### FD-035 115 个 `.tsx` 完全不 import `studioTheme`
- **类型**：token 未复用。
- **详情**：其中 26 个是 `components/geogebra/*`(10) 与 `components/pixel/*`(6) 等**新并入功能**，
  它们手写了与 token 几乎逐字相同的串，例如
  `components/geogebra/GeoGebraPage.tsx:704` 的
  `"flex gap-2 rounded-2xl border border-slate-200 bg-white/80 p-2"`、
  `:715` 的 `"min-h-11 rounded-2xl border border-slate-200 bg-white px-3 text-sm text-slate-700"`、
  `:758/779/799` 的 `"rounded-2xl border border-slate-200 bg-white/80 px-3 py-2"`。
  一旦 `studioTheme` 调色（例如 `bg-white/80`→`bg-white/90`），这些页面不会跟随。
- **改法**：按功能域批量替换为 `studioPanelClassName`/`studioSubPanelClassName`/
  `studioFieldClassName`/`studioPrimaryButtonClassName`/`studioGhostButtonClassName`/`studioTileClassName`。
- **完整清单**：附录 A / D1（按目录分组）。

#### FD-036 `components/geogebra/*` 全部 10 个文件（含新并入功能）
- **位置**：`GeoGebraPage.tsx`(887)、`GeoGebraEditor.tsx`、`GeoGebraAiPanel.tsx`、
  `GeoGebraCloudPanel.tsx`、`GeoGebraCommentsPanel.tsx`、`GeoGebraExportPanel.tsx`、
  `GeoGebraProjectPanel.tsx`、`GeoGebraSharePage.tsx`、`GeoGebraSharePanel.tsx`、`GeoGebraApplet.tsx`。
- **类型**：token 未复用（配色本身已接近合规，但仍有 `min-h-11 rounded-2xl border border-slate-200 bg-white` 手写表单）。
- **改法**：统一 import `studioTheme`；页面外壳改 `studioPageClassName` + `max-w-7xl` + hero（`InfoQueryHero`）
  + main surface + 侧栏三段式；**严禁**保留 GeoGebra 来源的蓝黑画布皮肤（当前 `GeoGebraPage.tsx` 有 5 处
  `bg-slate-900` 深色块 —— 只允许作为 `studioDarkPanelClassName` 局部强调，不得铺满画布区）。

#### FD-037 `components/pixel/*` 全部 6 个文件（GGGGGG 来源）
- **位置**：`PixelWorkbenchPage.tsx`(379)、`PixelCardPanel.tsx`、`PixelHistoryPanel.tsx`、
  `PixelNoticeDialog.tsx`、`PixelSubmitPanel.tsx`、`PixelTaskPanel.tsx`。
- **类型**：token 未复用 + 未走 `studioModal*`。
- **详情**：`PixelWorkbenchPage.tsx` 用 `relative mx-auto max-w-7xl px-4 py-8` 自拼外壳，
  未用 `studioPageClassName`（会与 App shell 的 padding 双重内缩）；`PixelNoticeDialog.tsx` 自建弹窗。
- **改法**：外壳换 `studioPageClassName` + `InfoQueryHero`；弹窗换 `studioModalOverlayClassName` +
  `studioModalCardClassName` + focus trap（可参照 `ResourceStoreList.tsx:300-330` 的实现）。
  **注意**：`PixelWorkbenchPage.tsx` / `admin/PixelAdminPanel.tsx` 审查期间处于其他会话在飞 WIP，
  开修前先 `git status` 确认（若仍为 modified，跳过该文件并入下一批）。

#### FD-038 `components/admin/**`（除 WIP）共 ~30 个文件未 import `studioTheme`
- **文件**：`AdminHub.tsx`、`AdminGuard.tsx`、`SuperAdminGuard.tsx`、`AdminScopeManager.tsx`、
  `AdminOverviewPanel.tsx`、`AdminCommandPalette.tsx`、`AdminModuleGrid`（`adminModules.tsx`）、
  `CaptchaProviderAdmin.tsx` + `captcha-providers/*`(5)、`CrashReportManager.tsx` + `crash-reports/*`(3)、
  `IpRiskLogPanel.tsx` + `ip-risk-log/*`(6)、`MediaToolAdmin.tsx` + `media-tool/*`(5)、
  `PolicyConsentPanel.tsx` + `policy-consent/*`(3)、`QqGuardManager.tsx` + `qq-guard/*`(5)、
  `RedisDataBrowser.tsx`、`DebugConsole.tsx`、`IntegrationsHealthPanel.tsx`、`MobileTokenLineagePanel.tsx`、
  `GeoGebraAdminPanel.tsx`。
- **改法**：把 `InfoQueryShell`/`InfoPanel`/`InfoMetricCard`/`InfoSectionTitle` 引入替代手写骨架；
  一并移除 `.logshare-admin-surface`。

#### FD-039 `components/env-manager/**`（56 个文件）+ `EnvManager.tsx`
- **类型**：token 未复用（该目录是「手写表单行」的重灾区，且存在 `SelfContained*` 与普通版两份镜像组件）。
- **改法**：`ConfigFieldRow.tsx` / `EnvRow.tsx` / `InfoBox.tsx` / `CollapsibleSection.tsx`
  是这一组的共享层，先把这 4 个改成 `studioFieldClassName`/`studioPanelClassName`/`studioGhostButtonClassName`，
  其余 52 个文件改用它们，禁止逐文件重写 Tailwind 串。

#### FD-040 `components/ticket/*`(8) + `TicketSystem.tsx`(1507)
- **改法**：`TicketHero.tsx` 应改为 `InfoQueryHero`；`ticketBadges.tsx` 改为 `studioBadgeClassName`。

#### FD-041 `components/policy/*`(6) + `PolicyPage.tsx` + `PolicyConsentChecklist.tsx`
- **位置**：`PolicyDataInventoryPanel.tsx` 1 处禁用色。
- **改法**：统一到 slate + sky 装饰；`policyCards.tsx` 改用 `studioTileClassName`。

#### FD-042 `components/user-profile/*`(5) + `UserProfile.tsx`(1930) + `user-management/*`(3) + `UserManagement.tsx`(1451)
- **改法**：`ProfileSidebarSummary.tsx`/`SecurityScorecardPanel.tsx`/`DeviceSessionsPanel.tsx`
  改用 `InfoMetricCard`；`PrivacyConsentPanel.tsx` 已用 slate，补 `rounded-2xl` 一致性。

#### FD-043 `components/docTool/*`(3) + `DocConvertPage.tsx`、`components/speech-to-text/*`(2)
- **改法**：同 FD-035。

#### FD-044 `components/confirm/ConfirmDialogProvider.tsx` + `components/ConfirmModal.tsx` +
  `components/AlertModal.tsx` + `components/PromptModal.tsx` + `components/DebugInfoModal.tsx` +
  `components/ModalPortal.tsx`
- **类型**：6 套并行弹窗实现（都未用 `studioModal*`）。
- **详情**：`ResourceStoreList.tsx` 的重复资源弹窗已实现 focus trap + Escape + 恢复焦点
  （`L296-330`），这 6 处没有同一套行为 → 无障碍与视觉双重分叉。
- **改法**：抽一个共享 `StudioModal`（基于 `studioModal*ClassName` + 该 focus trap），
  6 处改为调用它；`ModalPortal.tsx` 保留 portal 职责。

#### FD-045 `components/ui/Input.tsx` 与全仓手写 input
- **改法**：`Input.tsx` 改为 `studioFieldClassName` 包装；其余手写 input 统一替换。

### E. 结构不一致（hero + 主 surface + 侧栏、max-w-7xl、1/2/3 列）

#### FD-046 缺少 hero + 主 + 侧栏三段式骨架
- **类型**：页面级结构。
- **详情**：`ResourceStoreList.tsx` 是 `hero(slate-900 标题 + 3 张状态卡) → 主 surface(1/2/3 列卡片网格) → 侧栏(操作面板 + 摘要面板)`。
  当前只有少数页面符合；`components/pixel/PixelWorkbenchPage.tsx:…relative mx-auto max-w-7xl px-4 py-8`、
  `components/AdminDashboard.tsx`、`components/AntiCounterfeitPage.tsx`、`components/ApiDocs.tsx`、
  `components/ProductQueryForm.tsx`、`components/LogShare.tsx` 等仍是单列长滚动。
- **改法**：按 FD-035 的批次，每页统一为三段式；`components/*/…-*-Panel.tsx` 类子组件保持面板形态不变。

#### FD-047 未使用 `studioPageClassName`（App shell 已提供水平 padding）
- **类型**：双重内缩（`ResourceStoreList` 注释明确 `studioPageClassName` 不带 padding，
  水平 padding 由 App shell 给）。
- **详情**：`PixelWorkbenchPage.tsx`、`InfoQueryShell`（`mx-auto max-w-6xl px-4 py-10`）都会与 App shell 叠加。
- **改法**：页面外壳统一 `studioPageClassName`；`InfoQueryShell` 的 `px-4` 改为 `px-0`
  （或明确只在非 shell 路由使用）。`max-w-*` 参数统一为 `max-w-7xl`（`InfoQueryShell` 默认 `max-w-6xl` 会与基准不符）。

#### FD-048 响应式列数不统一
- **详情**：基准是 `grid-cols-1 md:grid-cols-2 xl:grid-cols-3`（卡片）
  与 `lg:grid-cols-[minmax(0,1fr)_minmax(0,400px)]`（主+侧）。
- **改法**：统一到这两条；当前存在 `sm:grid-cols-3`、`lg:grid-cols-4`、`grid-cols-2` 等混用（见 FD-017 各 panel）。

#### FD-049 非 2xl 圆角（526 处 / 123 文件）
- **类型**：圆角刻度。
- **详情**：主要集中在 `components/WebhookEventsManager.tsx`(59)、`components/OAuthClientManager.tsx`(51)、
  `components/ShortLinkManager.tsx`(26)、`components/LogShare.tsx`(20)、`components/EmailTraceability.tsx`(19)、
  `components/ResourceStoreManager.tsx`(15)、`components/admin/IntegrationsHealthPanel.tsx`(14)、
  `components/LotteryAdmin.tsx`(13)、`components/TTSForm.tsx`(12)、`components/CDKStoreManager.tsx`(11)。
- **改法**：卡片/面板/表单/按钮的 `rounded-sm|md|lg|xl` → `rounded-2xl`；
  **保留** `rounded-full`（pill/头像）与装饰性小尺寸元素（如 `h-1.5` 进度条）用 `rounded-full`。
  逐一判断，不做机械全局替换。

#### FD-050 弹窗未走 `studioModal*`
- 与 FD-044 同一问题，此处记录「z-index 与 MobileNav 层级」细节：`studioModalOverlayClassName` 用 `z-[10050]`
  是为了压过 MobileNav 的 `z-[9998]`；自建弹窗若用 `z-50`/`z-[999]` 会被底部导航盖住。
- **改法**：统一 `studioModalOverlayClassName`。

#### FD-051 `components/MobileNav.tsx` / `components/Footer.tsx` / `components/HomeHub.tsx`
- **详情**：这 3 个已基本合规（HomeHub 29 处 studio 引用、MobileNav 3 处、Footer 0 处）；
  `MobileNav.tsx` 有 3 处 `bg-red-50`（→ rose，见 FD-031）、`Footer.tsx` 无 studioTheme import。
- **改法**：小改；`Footer` 引入 token 统一底部色。

#### FD-052 `components/DemoHub.tsx` 及其 5 个 demo 子页入口
- **改法**：`DemoHub` 卡片改 `studioTileClassName`；子页见 FD-021。

#### FD-053 `.logshare-admin-surface` 使用点（5 处）
- 见 FD-003；删除顺序必须是「先改页面配色 → 再删 CSS → 再删 className 使用点」。

#### FD-054 `components/RuntimeConfigSections.tsx`(1676) 与 `EnvManager.tsx` 的手写分组卡
- **改法**：改用 `studioPanelClassName` + `CollapsibleSection`。

#### FD-055 `components/AdminStoreDashboard.tsx` / `AdminDashboard.tsx` / `AdminLogin.tsx`
- **详情**：`AdminStoreDashboard.tsx` 2 处禁用色；三者都未 import studioTheme。
- **改法**：`AdminLogin` 对齐 `LoginPage` 的 auth 骨架（`ResourceStoreList` 同源的 hero + surface）。

### F. 状态缺失（每页必须有独立 loading / error / empty / success）

#### FD-056 错误被吞：catch 里只 `console.error` 或空块，页面没有失败出口（最严重）
- **位置**：`components/ResourceStoreList.tsx:87-98` 已经**正确**示范了分离
  （`resourcesError` / `redeemedError` 与「本来就没有」分开，注释明确写了原因）。
- **反例（可复现计数）**：全量扫描 351 个 `.tsx`，**60 个文件**存在「catch 块为空」
  或「catch 里只写 `console.error/warn/log`，用户看不到任何失败提示」的情况。
  命中最多的是：`components/DataCollectionManager.tsx`（26 个 catch，1 个空块）、
  `components/ImageUploadPage.tsx`（24 个 catch，19 个只 console）、
  `components/CDKStoreManager.tsx`（17 / 17 只 console）、`components/LogShare.tsx`（17 / 3 只 console）、
  `components/UserProfile.tsx`（16 / 8）、`App.tsx`（13 / 11）、`components/CoinFlip.tsx`（12 / 9）、
  `components/EmailSender.tsx`（10 / 5）、`components/FBIWantedManager.tsx`（10 / 8）、
  `components/ShortLinkManager.tsx`（9 / 5）、`components/TamperDetectionDemo.tsx`（9 / 7）；
  完全没有任何 error 出口（`errSurface:N`）的有 `components/DebugInfoModal.tsx`、
  `components/ticket/TicketComposer.tsx`、`components/admin/policy-consent/shared.tsx`、
  `components/LegacyApiChoicePage.tsx`、`components/PromptModal.tsx`、
  `components/ticket/OverLengthMailNotice.tsx`、`components/ui/CredentialIdModal.tsx`（空 catch）。
  **不是**反例（已达标，勿改错方向）：`components/pixel/PixelHistoryPanel.tsx`、
  `components/pixel/PixelTaskPanel.tsx`（`error` 由 props 传入并渲染 `role="alert"`）、
  `components/AntiCounterfeitPage.tsx`、`components/ApiDocs.tsx`（都有完整 error 状态机）。
- **改法**：按 `ResourceStoreList.tsx:389-410`（store 分支）与 `:428-450`（owned 分支）的写法：
  独立 `xxxError` 状态 + `role="alert"` + 重试按钮；只有请求成功且数组为空才走空态。
  禁止用 `console.error` 代替用户可见的失败态（console 可保留用于诊断）。

#### FD-057 独立 loading 缺失（复用页面级 loading 导致整页闪烁）
- **详情**：`ResourceStoreList.tsx` 有**两级** loading：页面级 `loading`（首屏 `UnifiedLoadingSpinner`）
  与 tab 级 `redeemedLoading`（`min-h-[380px]` 内联 spinner）。
- **反例**：多数页面只有一级，切 tab 会整页白屏。
- **改法**：列表/面板级异步一律给局部 loading。

#### FD-058 自绘 spinner（未用 `UnifiedLoadingSpinner`）
- **位置**：`components/NexAISecurityDashboard.tsx:266`（`animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-600`）、
  `components/EmailTraceability.tsx:292`（`border-t-indigo-500`）、`components/CommandManager.tsx` 等 58 个文件含手写 `animate-spin`。
- **改法**：统一 `<UnifiedLoadingSpinner size="lg" text="…" />`（来自 `components/LoadingSpinner.tsx`）。

#### FD-059 空态无文案/无下一步
- **详情**：基准空态是 `rounded-2xl border border-dashed border-slate-200 bg-slate-50/80 px-6 py-14 text-center text-slate-400`
  + 一句「当前没有…」/「先去右侧输入 CDK」（给出下一步）。
- **反例**：多处 `return null` 或 `暂无数据`（无引导）。
- **改法**：统一该 class 串 + 一句含下一步动作的文案；可抽 `StudioEmptyState` 组件。

#### FD-060 错误态样式不统一
- **详情**：基准错误块 `rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700`（内联，`text-rose-700`）。
- **反例**：`components/ErrorDisplay.tsx` 是另一套实现。
- **改法**：`ErrorDisplay.tsx` 改为该样式（tone 可变），所有页面统一调用。

#### FD-061 成功态缺 `role="status"` + `aria-live`
- **详情**：基准 `success` 用 `role="status" aria-live="polite"`（`ResourceStoreList.tsx:533-545`）。
- **改法**：所有 toast/inline 成功提示补 aria 属性。

#### FD-062 列表分页态缺失
- **详情**：基准 `total > pageSize` 时渲染 `nav aria-label="资源分页"` + 上一页/下一页 + 「第 x / y 页 · 共 n 项」。
- **反例**：`AdminHub`、`AuditLogViewer`、`WebhookEventsManager` 等有分页接口但 UI 分页能力不一致。
- **改法**：抽 `StudioPager` 组件，全部列表页复用。

### G. 无障碍 / 动效 / 移动端

#### FD-063 85 个 framer-motion 文件无 reduced-motion 处理
- **位置**：`hooks/useReducedMotion.ts` **已存在**（且导出 default）；基准 `ResourceStoreList.tsx`
  的 `motion.article` / `motion.div` 用 `initial/animate` 但**也没有**接 reduced motion（这本身也只是
  「不阻塞」—— 因为 `opacity/y` 无循环动画）。真正的问题是循环动画与 `AnimatePresence` 大面积入场。
- **详情**：78 个文件有 `<motion.` 用法且无 reduced 判定；完整清单见附录 A / G1。
- **改法**：统一模式
  ```tsx
  const reduced = useReducedMotion();
  <motion.div initial={reduced ? false : { opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} />
  ```
  或在 `index.css` 加全局 `@media (prefers-reduced-motion: reduce) { *,*::before,*::after { animation-duration:.01ms!important; transition-duration:.01ms!important } }`
  作为兜底（两者都做）。

#### FD-064 298 个 `<button>` 缺 `type`（58 个文件）
- **类型**：无障碍 + 表单误提交（HTML 默认 `type="submit"`，在 `<form>` 内会意外触发提交）。
- **改法**：脚本化补 `type="button"`（对 `<form>` 内确需提交的保留 `type="submit"`）；
  清单见 `F:/tmp/fescan/scan2.tsv` 的 `btnNoType` 列。
- **注意**：`components/CommandManager.tsx`、`components/CDKStoreManager.tsx` 等大文件内嵌表单最多。

#### FD-065 6 处可点非交互元素无 role（4 个文件）
- **改法**：改为 `<button type="button">`；必须保留 div 时补 `role="button" tabIndex={0}` +
  `onKeyDown` 处理 Enter/Space。清单见附录 A / G2。

#### FD-066 319 个文件完全没有 `focus-visible:`
- **详情**：`studio*ButtonClassName` 都带 `focus-visible:ring-2 focus-visible:ring-slate-300 focus-visible:ring-offset-2`，
  手写按钮普遍缺，导致键盘用户看不到焦点。
- **改法**：走 token；`index.css` 补一条全局兜底
  `:where(button,a,input,select,textarea,[tabindex]):focus-visible { outline: 2px solid #94a3b8; outline-offset: 2px; }`
  （仅兜底，不替代 token）。

#### FD-067 触控目标 < 44px
- **详情**：`components/ui/button.tsx` 的 `size-xs/sm` = `h-6`(24px)/`h-7`(28px)；
  基准 `studioPrimaryButtonClassName` 是 `py-3.5 + text-sm` ≈ 48px，
  `GeoGebraProjectPanel` / `GeoGebraAdminPanel` 用 `min-h-11`(44px) 达标。
- **改法**：移动端（`< sm`）交互元素最小 `min-h-11`；`ui/button.tsx` 删除后自然消失。

#### FD-068 无限/循环动画未降级
- **位置**：`components/TigerAdventure.tsx`（1213 行，13 处 `bg-black` + 5 处 gradient）、
  `components/TamperDetectionDemo.tsx`、`tailwind.config.js` 的 `animation['bounce-slow']`。
- **改法**：`animate-bounce-slow` 在 reduced motion 下停用；demo 页按 FD-021 处理。

#### FD-069 `img` 缺 `alt` 与装饰图处理
- **详情**：多行标签内的 `<img>` 未检出缺失（0 命中），但基准 `ResourceStoreList.tsx:343` 用
  `alt={resource.title}`，装饰性图标一律 `aria-hidden`。
- **改法**：新增图片必须同时给 `alt`（语义图）或 `aria-hidden`（装饰图）；
  背景图容器给 `aria-hidden`（如基准的 `studioAccentBlob*` 用法）。

#### FD-070 弹窗键盘行为（Escape / focus trap / 恢复焦点）
- **详情**：基准 `ResourceStoreList.tsx:296-330` 完整实现（Escape 关闭、Tab 循环、关闭后 `previouslyFocused?.focus()`）。
- **改法**：抽 `StudioModal` 时把该行为内置；所有自建弹窗迁移。

### H. 性能 / bundle 预算 / 文件体积

#### FD-071 重依赖静态 import（23 个文件）
- **详情**：`components/geogebra/GeoGebraEditor.tsx` 静态 `monaco-editor`；
  `components/CommandManager.tsx`（1578 行）与 `components/CommandManager/ResourceTrendChart.tsx` 静态 `chart.js`+`react-chartjs-2`；
  `components/NexAISecurityDashboard.tsx` 静态 chart.js；
  `components/MarkdownRenderer.tsx` 静态 `katex`+`react-syntax-highlighter`；
  `utils/codeHighlight.ts` 静态 `react-syntax-highlighter`；
  `components/ArtifactSharePage.tsx`、`components/DataCollectionManager.tsx` 静态 `react-syntax-highlighter`；
  `components/MarkdownExportPage.tsx` 静态 `docx`；`components/VtRatioExplorer/Tex.tsx` 静态 `katex`；
  `api/geogebra.ts` 与多个 geogebra 组件静态引用 `geogebra` 全局包。
- **改法**：`vite.config.ts` 的 `getManualChunk` 已把 mermaid/docx/jspdf 等隔离，
  **但 `monaco-editor` 与 `geogebra` 的 chunk 名未在 `check:frontend-bundle` 的必需清单内**。
  逐项改为 `await import(...)`（组件内 effect 懒加载）并确认 chunk 名落在隔离组；
  同时把 `monaco-editor`、`geogebra` 加入 `docs/governance/repository-governance.md` 的重依赖清单与 CI 校验。

#### FD-072 `hook 覆盖面`: `frontend/src/index.css` 首屏 CSS 1216 行
- **详情**：全部被 `main.tsx` 同步引入，含 demo/日志/挑战页专用样式。
- **改法**：FD-003 收敛后按路由拆 CSS（`cssCodeSplit: true` 已开），把 `.logshare-admin-surface`、
  `.custom-toast-*`、`.markdown-*` 迁到各自组件的 CSS Module 或 `@layer components` 分支文件。

#### FD-073 geogebra/pixel 新功能的路由级懒加载（已达标，需保持）
- **位置**：`App.tsx` 已有 71 处 `React.lazy`；GeoGebra/Pixel 入口需确认在列。
- **改法**：新增页面一律 `React.lazy` + `Suspense`（`renderAnimatedRoute`）。

#### FD-074 46 个文件超过 800 行治理软上限
- **清单**：附录 A / I1（`utils/integrityCheck.ts` 2804、`components/CDKStoreManager.tsx` 2082、
  `components/LogShare.tsx` 1945、`components/UserProfile.tsx` 1930、`components/LibreChatPage.tsx` 1830、`App.tsx` 1810 …）。
- **详情**：`docs/governance/repository-governance.md` 明确「已超限的遗留文件只在**不再增长**时被容忍」，
  本轮改造会触碰其中一批 → 一旦增长 CI 的 `check:ts-file-size` 会红。
- **改法**：凡本轮要改的 >800 行文件，**先拆后改**：纯 helper → API hooks → 区块组件 → 路由元数据表。
  至少把新增的 token 映射与状态块抽成独立文件，保证净增行数 ≤ 0。

#### FD-075 `components/CommandManager.tsx` 内联 chart 与 `ResourceTrendChart.tsx` 重复
- **改法**：`CommandManager.tsx` 只保留入口，图表全走 `CommandManager/ResourceTrendChart.tsx`（自身也要懒加载）。

#### FD-076 `components/env-manager/SelfContained*.tsx`（27 个镜像组件）
- **类型**：同一配置项的「普通版 + SelfContained 版」两份实现 → 每次改样式要改两遍（必然漂移）。
- **改法**：抽共享 `EnvConfigSection` 渲染层，两份壳只负责数据来源。

#### FD-077 `frontend/src/api/*.ts`（38 个）无 error 归一化
- **详情**：`api/cdks.ts`、`api/resources.ts` 等直接抛 axios 错误，页面各自 catch 文本；
  基准的「独立 error 态」需要统一错误文案。
- **改法**：新增 `api/errors.ts` 归一化（把 HTTP 状态/网络失败映射为中文用户文案），
  页面只消费归一化后的 message。

#### FD-078 组件/API/hooks/services/models 分层
- **详情**：`components/*` 里仍有直接 axios 调用与业务规则（如 `CDKStoreManager.tsx` 2082 行、
  `CommandManager.tsx` 1578 行、`WebhookEventsManager.tsx` 1457 行）。
- **改法**：按 owner 要求「按功能拆组件/API/hooks/services/models，不写 mega-file」，
  在 FD-074 的拆分中同步下沉请求与业务逻辑。

### I. 缺自动化闸门

#### FD-079 新增静态检查 `pnpm run check:frontend-design-language`
- **类型**：防回流（否则改完下一批代码又会引入 indigo/hex）。
- **详情**：本次审查用的扫描器逻辑（禁用色 / 任意 hex / 非 slate 中性 / 非 2xl 圆角 /
  未复用 token / 未处理 reduced motion / 缺 `type`）已可脚本化。
- **改法（已落地于 P1）**：`scripts/governance/check-frontend-design-language.js`
  （Node CJS、零第三方依赖、只读 `frontend/src`，不需构建、不读 `node_modules`），
  基线 `scripts/governance/frontend-design-language-baseline.json`（每条规则一个上限），
  接入 `.github/workflows/quality-guardrails.yml` 的 Guardrails job；CI 只允许命中数**下降**。
  `--report` 打印违规点，`--update-baseline` 在清理后收紧上限。
  **禁止**把基线改成当前值后就不管：每个修复批次结束都要跑 `--update-baseline` 并回填 §6。

#### FD-080 新增共享四态/弹窗原语 `components/studioFeedback.tsx`
- **类型**：缺少共享实现，导致每个页面各自手写四态与弹窗（FD-044 / FD-056～FD-062 的根因）。
- **详情**：基准里只有 `ResourceStoreList.tsx` 一处把「独立 error 态 / 局部 loading /
  空态给下一步 / success role=status / 分页 / 弹窗 focus trap」做全了，其他 300+ 页面无参照物，
  于是“照猫画虎”成 6 套弹窗与 60 个吞错误的 catch。
- **改法（已落地于 P1）**：新增 `frontend/src/components/studioFeedback.tsx`，导出
  `StudioErrorNote` / `StudioSuccessNote` / `StudioErrorState` / `StudioEmptyState` /
  `StudioLoadingState` / `StudioPager` / `StudioModal` / `StudioModalHeader` /
  `StudioModalDangerButton` / `StudioModalPrimaryButton`。
  内部只用 `studioTheme` 常量 + `UnifiedLoadingSpinner` + `useReducedMotion`，
  不新增任何 Tailwind 颜色串。后续所有批次的新代码必须从这里取，
  自建弹窗、自写四态、自绘 spinner 一律不接受。

---

## 3. 修复批次划分（文件两两不相交，可并行）

> 原则：**先地基、后页面**。P1 未合入前不动页面，避免在旧 token 上做无用功。
> 每批一个 fresh subagent（禁 `fork`），提示词自包含：仓库绝对路径 + 允许编辑文件清单 +
> 本清单编号 + 禁止运行构建/测试/lint + 禁止 commit/push（提交只由协调者做）。

| 批次 | 范围（可编辑文件） | 覆盖编号 | 交付 |
| --- | --- | --- | --- |
| **P1 地基** ✅ | `frontend/tailwind.config.js`（已删）、`frontend/src/index.css`、`frontend/src/styles/sidebar-theme.css`、`frontend/src/components/studioTheme.tsx`、`frontend/src/components/studioFeedback.tsx`（新）、`frontend/src/components/LoadingSpinner.tsx`、`scripts/governance/check-frontend-design-language.js`（新）、`scripts/governance/frontend-design-language-baseline.json`（新）、`package.json`、`.github/workflows/quality-guardrails.yml`、`readme.md` | FD-001、FD-002、FD-003（Toastify/字体部分）、FD-007、FD-008、FD-079、FD-080 | 单一配色体系 + 共享原语 + 静态闸门 |
| **P2 shell** | `frontend/src/App.tsx`、`frontend/src/layout/*`、`frontend/src/components/ui/*`、`frontend/src/lib/utils.ts`、`frontend/src/components/MobileNav.tsx`、`frontend/src/components/Footer.tsx`、`frontend/src/components/HomeHub.tsx`、`frontend/src/components/ErrorDisplay.tsx`、`frontend/src/components/ModalPortal.tsx` | FD-004～FD-006、FD-009、FD-018、FD-034、FD-050、FD-051、FD-060、FD-067、FD-070 | shell 与共享件对齐 |
| **P3 auth/验证** | `LoginPage`、`RegisterPage`、`ForgotPasswordPage`、`ResetPasswordPage`、`ResetPasswordLinkPage`、`MobileLoginPanel`、`EmailVerifyPage`、`GoogleAuthButton`、`LinuxDoAuthButton`、`LinuxDoAuthCallbackPage`、`TOTPManager`、`TOTPSetup`、`TOTPVerification`、`PasskeySetup`、`PasskeyVerifyModal`、`BackupCodesModal`、`VerificationMethodSelector`、`VerifyCodeInput`、`EstablishSecuritySession`、`StepUpGate`、`FirstVisitVerification`、`SmartHumanCheck`、`SmartHumanCheckTraces`、`SmartHumanCheckTestPage`、`TurnstileWidget`、`HCaptchaWidget`、`CapWidget`、`ManagedCaptcha`、`CaptchaVerificationPage`、`CaptchaVerificationExample`、`CloudflareChallengePage`、`FeatureConsentGate`、`FingerprintManager`、`FingerprintRequestModal` | FD-013 变体、FD-026、FD-027、FD-056～FD-062 | 认证/验证域四态齐备 |
| **P4 管理端 A** | `components/admin/AdminHub.tsx`、`AdminGuard.tsx`、`SuperAdminGuard.tsx`、`AdminScopeManager.tsx`、`AdminOverviewPanel.tsx`、`AdminCommandPalette.tsx`、`adminModules.tsx`、`CaptchaProviderAdmin.tsx`、`captcha-providers/*`(5)、`CrashReportManager.tsx`、`crash-reports/*`(3)、`DebugConsole.tsx`、`RedisDataBrowser.tsx`、`IntegrationsHealthPanel.tsx`、`MobileTokenLineagePanel.tsx` | FD-017、FD-038、FD-053 | 删 `.logshare-admin-surface` |
| **P5 管理端 B** | `components/admin/IpRiskLogPanel.tsx`、`ip-risk-log/*`(6)、`MediaToolAdmin.tsx`、`media-tool/*`(5)、`PolicyConsentPanel.tsx`、`policy-consent/*`(3)、`QqGuardManager.tsx`、`qq-guard/*`(5)、`GeoGebraAdminPanel.tsx`、`AdminDashboard.tsx`、`AdminLogin.tsx`、`AdminStoreDashboard.tsx` | FD-017、FD-038、FD-055 | 同上 |
| **P6 用户/账户** | `UserProfile.tsx`、`UserManagement.tsx`、`user-management/*`(3)、`user-profile/*`(5)、`Notification.tsx`、`NotificationTestPage.tsx`、`PolicyPage.tsx`、`policy/*`(6)、`PolicyConsentChecklist.tsx`、`TtsPolicyConsentPanel.tsx` | FD-020、FD-041、FD-042 | 账户域对齐 |
| **P7 商店/工具** | `ResourceStoreManager.tsx`、`ResourceStoreDetail.tsx`、`CDKStoreManager.tsx`、`CommandManager.tsx`、`CommandManager/*`(2)、`ApiKeyManager.tsx`、`AntiCounterfeitPage.tsx`、`ApiDocs.tsx`、`AgeCalculatorPage.tsx`、`CaseConverter.tsx`、`WordCountPageSimple.tsx` | FD-011、FD-012、FD-015、FD-049、FD-057、FD-074、FD-078 | store/工具域 |
| **P8 通讯/集成** | `WebhookEventsManager.tsx`、`ShortLinkManager.tsx`、`PublicShortLinkCreator.tsx`、`ShortUrlMigrationManager.tsx`、`EmailSender.tsx`、`EmailTraceability.tsx`、`OutEmail.tsx`、`MailSystemConfigManager.tsx`、`RuntimeConfigSections.tsx`、`EnvManager.tsx`、`env-manager/*`(56)、`BilibiliDataAdmin.tsx`、`BilibiliSyncAdmin.tsx` | FD-022、FD-023、FD-039、FD-054、FD-076 | 通讯/环境配置域 |
| **P9 内容/媒体** | `MarkdownArticleManager.tsx`、`MarkdownArticlePage.tsx`、`MarkdownExportPage.tsx`、`MarkdownExportPage/*`、`MarkdownPreview.tsx`、`MarkdownRenderer.tsx`、`Mermaid.tsx`、`DocConvertPage.tsx`、`docTool/*`(3)、`ImageUploadPage.tsx`、`ImageUploadSection.tsx`、`ArtifactSharePage.tsx`、`AudioPreview.tsx`、`speech-to-text/*`(2)、`TranslationAuditViewer.tsx`、`VtRatioExplorer.tsx`、`VtRatioExplorer/*`(4)、`DeepLXTranslatorPage.tsx` | FD-016、FD-043、FD-071 | 内容/媒体域 + 重依赖懒加载 |
| **P10 票据/杂项** | `TicketSystem.tsx`、`ticket/*`(8)、`DataCollectionManager.tsx`、`EcoEnchantsAdminPage.tsx`、`EcoEnchantsOpsPanel.tsx`、`GitHubBillingDashboard.tsx`、`GitHubBillingCacheManager.tsx`、`IPBanManager.tsx`、`ip-ban/*`、`LotteryAdmin.tsx`、`LotteryPage.tsx`、`BroadcastManager.tsx`、`BroadcastModal.tsx`、`BroadcastModalView.tsx`、`AnnouncementManager.tsx`、`AnnouncementModal.tsx`、`OAuthClientManager.tsx`、`OAuthAuthorizePage.tsx`、`OAuthOidcEndpointPanel.tsx`、`ProductDetails.tsx`、`ProductQueryForm.tsx`、`PromptModal.tsx`、`AlertModal.tsx`、`ConfirmModal.tsx`、`DebugInfoModal.tsx`、`ModalPortal.tsx`、`confirm/ConfirmDialogProvider.tsx`、`RegistrationInviteManager.tsx`、`NexAISecurityDashboard.tsx`、`SystemManager.tsx`、`WsConnector.tsx`、`LegacyApiChoicePage.tsx`、`CampusEmergencyPage.tsx`、`CampusEmergency.css`、`PenaltyAppealActions.tsx`、`PenaltyAppealHost.tsx`、`ProviderBindPage.tsx` | FD-013、FD-044、FD-049、FD-056 | 收尾 |
| **P11 新并入功能** | `components/geogebra/*`(10) + `components/pixel/*`(6) + `components/admin/PixelAdminPanel.tsx`（**WIP 消退后**） | FD-036、FD-037 | GeoGebra/Pixel 去独立视觉 |
| **P12 demo 页** | `FinanceAppDemo.tsx`、`MeditationAppDemo.tsx`、`MusicPlayerDemo.tsx`、`XiaohongshuDemo.tsx`、`CoinFlip.tsx`、`TigerAdventure.tsx`、`TamperDetectionDemo.tsx`、`DemoHub.tsx`、`ModListEditor.tsx`、`ModListPage.tsx` | FD-021、FD-052、FD-068 | demo 页统一（或按 §5 裁决下线） |

**并行度**：P1 单独跑；P2 收工后 P3～P10 可 4～6 路并发（文件不相交）；
P11 需先确认 WIP 清零；P12 待 owner 对 demo 页去留的裁决。

---

## 4. 验收判据

1. **静态（协调者本地，非构建）**
   - `node frontend/scripts/check-design-language.mjs` 全项 ≤ 基线且逐批下降（FD-079）。
   - `rg -n "indigo-|purple-|fuchsia-|pink-" frontend/src --glob '*.tsx'` 归零（`InfoTone='violet'` 白名单除外）。
   - `rg -n "bg-\[#|text-\[#|border-\[#" frontend/src --glob '*.tsx'` 归零。
   - `rg -n "logshare-admin-surface" frontend/src` 归零。
   - `rg -n "rounded-(sm|md|lg|xl)\b" frontend/src --glob '*.tsx'` 归零（装饰性小元素人工豁免清单化）。
   - 每个被改文件的 `git diff` 逐份人工核查（方法论 §二-3）：改动真实落盘、无语法/结构错误、无顺带删除业务逻辑。
2. **CI（唯一裁决者）**
   - `Node verification`：后端 Jest + 前端 Vitest（含覆盖率）+ `build` + openapi drift 全绿。
   - `Quality Guardrails`：`check:ts-file-size`（FD-074 拆分为前提）、
     `check:frontend-bundle`（entry ≤ 220 KB gzip、单 chunk ≤ 1800 KB、总 ≤ 4525 KB）、
     `check:privacy-contract`、新增 `check:design-language`。
3. **交互回归（人工/Playwright，若 CI 有 `test:browser`）**
   - 移动端（≤ 640px）：主按钮/表单/弹窗触控目标 ≥ 44px、底部导航不被弹窗遮挡。
   - 键盘：Tab 走遍可聚焦元素均可见焦点环；Escape 关闭弹窗并恢复焦点。
   - `prefers-reduced-motion: reduce`：入场动画与循环动画停用。
4. **收尾**：对照本清单逐条核对去向（已修 / 挂起理由），写回本文档 §6。

---

## 5. 挂起项（需 owner 裁决，不在本轮默认执行）

| # | 事项 | 说明 |
| --- | --- | --- |
| S1 | `/demo/*` 5 个 demo 页（4 个 demo 文件合计 468 处任意 hex）去留 | 若属演示资产而非产品功能，建议直接下线（连带 `DemoHub`），避免为演示页付出全量 token 化成本 |
| S2 | `components/geogebra/GeoGebraApplet.tsx` 画布区的深色底 | GeoGebra 画布本身品牌为蓝黑（第三方运行时），画布容器是否允许深色需 owner 明确；当前倾向「容器白底 + 局部深色工具条」 |
| S3 | `InfoTone='violet'` / `studioBadgeClassName('violet')` | 既有白名单，是否一并清除为 sky/slate |
| S4 | `.dark` markdown 主题 | 当前无切换入口（死代码），是否直接删除；若未来要做深色模式，需先定义 slate 深色 token 而非复用 `#0f172a` |
| S5 | `components/env-manager/SelfContained*.tsx` 27 个镜像组件 | 合并会触及运行时配置读取链路，是否本轮一并做 |
| S6 | 其他会话在飞的 `PixelAdminPanel.tsx` / `PixelWorkbenchPage.tsx` | P11 开工前需 `git status` 确认已提交或已放弃 |

---

## 6. 收尾核对（随批次推进回填）

> 状态图例：✅ 已修并推送 / 🟡 部分已修（余下在后续批次）/ ⏳ 排队中 / 🧊 挂起（见 §5）
> 闸门基线：`scripts/governance/frontend-design-language-baseline.json`，只允许下降。

| 批次 | commit | 覆盖编号 | 状态 |
| --- | --- | --- | --- |
| 清单落盘 | `a23fe21b` | 本文档本身 | ✅ |
| P1 地基 | `0c5b1816` | FD-001 ✅、FD-002 ✅、FD-003（Toastify/字体部分）✅、FD-007 ✅、FD-008 ✅（澄清为白名单）、FD-079 ✅、FD-080 ✅ | ✅ |
| P2 shell | `868671c5` | FD-004 ✅、FD-005 ✅、FD-006 ✅、FD-009 ✅（确认 `main.tsx` 无需改）、FD-018 ✅、FD-031（MobileNav 部分）✅、FD-034 ✅、FD-045 ✅、FD-051 ✅、FD-060 ✅、FD-067 ✅（ui/button）、FD-070（原语就绪）✅ | ✅ |
| P4 管理端 A | `f7d182ed` | FD-017 ✅、FD-038 ✅、FD-053（11 处使用点）✅ | ✅ |
| P6 账户/政策/LibreChat | `8a2c4ebf` | FD-040 ✅、FD-041 ✅、FD-042 ✅ | ✅ |
| P5 管理端 B | `（本批）` | FD-017 收口 ✅、FD-038 收口 ✅、FD-053 收口 ✅（`independent-visual-overlay` 归零）、FD-055 ✅、FD-062（部分）✅ | ✅ |
| — 其它会话在飞 WIP 收编 | `4896ca34` | 不属于本清单（工单/隐私地图），已按 owner 要求一并推送 | ✅ |
| P7 商店/工具 | — | FD-011、FD-012、FD-015、FD-049、FD-057、FD-074、FD-078 | ⏳（首轮 429 中断，待重跑） |
| P8 通讯/集成（a：Webhook/ShortLink/FBI/Notification） | — | FD-019、FD-020、FD-022、FD-023、FD-025、FD-034 | ⏳ |
| P3 认证/验证 | — | FD-026～FD-028、FD-031、FD-056～FD-062、FD-063～FD-070 | ⏳ |
| P9 内容/媒体 | — | FD-016、FD-043、FD-062、FD-071 | ⏳ |
| P8b 环境配置（env-manager 56 + Email/SMTP） | — | FD-014、FD-039、FD-054、FD-056、FD-076 | ⏳（运行中） |
| P10 票据/杂项 | — | FD-013、FD-035（TTSForm）、FD-044、FD-049、FD-056、FD-040（ticket） | ⏳ |
| P11 GeoGebra/Pixel | — | FD-036、FD-037 | ⏳ |
| P12 demo 页 | — | FD-021、FD-052、FD-068 | ⏳ / 🧊（S1 待 owner 裁决） |
| FD-010 / FD-030 / FD-072 / FD-073 / FD-075 / FD-077 | — | 待核项/CSS 拆分/错误归一化 | ⏳ |

### 6.1 闸门计数轨迹（每批只允许下降）

| 规则 | 基线起点 | P1+P2 | +P4 | +P6 | +P5 |
| --- | --- | --- | --- | --- | --- |
| palette-forbidden-hue | 236 | 229 | 193 | 193 | **142** |
| arbitrary-color-value | 1110 | 1110 | 1110 | 1110 | 1110 |
| non-slate-neutral | 19 | 11 | 11 | 11 | **11** |
| semantic-color-drift | 533 | 516 | 498 | 498 | **493** |
| saturated-gradient | 88 | 85 | 83 | 83 | **83** |
| second-ui-kit-token | 171 | 63 | 63 | 63 | **63** |
| legacy-palette-name | 21 | 21 | 21 | 21 | **20** |
| second-brand-color-literal | 11 | 9 | 9 | 9 | **9** |
| independent-visual-overlay | 12 | 7 | 1 | 1 | **0** |
| off-scale-radius | 526 | 508 | 441 | 441 | **382** |
| **合计** | **2727** | 2559 | 2430 | 2430 | **2313** |

---

## 附录 A. 完整文件清单（扫描器输出，可直接作为批次工单）

> 生成方式：`frontend/src` 下 554 个 `.tsx/.ts`/`.css` 全量扫描（`node_modules`/`dist` 排除），
> 命中数为正则匹配计数（同一行多个命中计多次）。

### A.1 禁用色文件（indigo/purple/fuchsia/pink）

- `components/CDKStoreManager.tsx` — 33 hits
- `components/CommandManager.tsx` — 21 hits
- `components/NexAISecurityDashboard.tsx` — 18 hits
- `components/EmailTraceability.tsx` — 17 hits
- `components/ResourceStoreManager.tsx` — 9 hits
- `components/speech-to-text/SpeechToTextPage.tsx` — 9 hits
- `components/admin/AdminHub.tsx` — 8 hits
- `components/admin/media-tool/JobsPanel.tsx` — 8 hits
- `components/BilibiliSyncAdmin.tsx` — 8 hits
- `components/FinanceAppDemo.tsx` — 8 hits
- `components/admin/crash-reports/CrashGroupListView.tsx` — 7 hits
- `components/admin/media-tool/TranscribePanel.tsx` — 7 hits
- `components/admin/qq-guard/AuditLogPanel.tsx` — 7 hits
- `components/ApiKeyManager.tsx` — 7 hits
- `App.tsx` — 6 hits
- `components/admin/AdminScopeManager.tsx` — 6 hits
- `components/admin/MediaToolAdmin.tsx` — 6 hits
- `components/BroadcastManager.tsx` — 6 hits
- `components/CoinFlip.tsx` — 5 hits
- `components/admin/crash-reports/CrashGroupDetailView.tsx` — 4 hits
- `components/admin/ip-risk-log/LookupsTab.tsx` — 4 hits
- `components/EcoEnchantsOpsPanel.tsx` — 4 hits
- `components/LibreChatAdminPage.tsx` — 4 hits
- `components/admin/ip-risk-log/ui.tsx` — 3 hits
- `components/admin/QqGuardManager.tsx` — 3 hits
- `components/admin/AdminOverviewPanel.tsx` — 2 hits
- `components/AdminStoreDashboard.tsx` — 2 hits
- `components/AnnouncementModal.tsx` — 2 hits
- `components/speech-to-text/TranscriptView.tsx` — 2 hits
- `components/admin/AdminCommandPalette.tsx` — 1 hit
- `components/admin/ip-risk-log/OverviewTab.tsx` — 1 hit
- `components/admin/qq-guard/CommandPanel.tsx` — 1 hit
- `components/AnnouncementManager.tsx` — 1 hit
- `components/AuditLogViewer.tsx` — 1 hit
- `components/LotteryAdmin.tsx` — 1 hit
- `components/policy/PolicyDataInventoryPanel.tsx` — 1 hit
- `layout/DesktopShell.tsx` — 1 hit
- `index.css` — 4 hits（Toastify 渐变 `#6366f1`）
- `styles/sidebar-theme.css` — 2 hits（`indigo-violet` 注释 + oklch 265）

### A.2 任意颜色值文件（`bg-[#…]` / `text-[rgb(…)]` / `border-[oklch(…)]`）

- `components/WebhookEventsManager.tsx` — 186 hits
- `components/ShortLinkManager.tsx` — 179 hits
- `components/MeditationAppDemo.tsx` — 170 hits
- `components/FinanceAppDemo.tsx` — 165 hits
- `components/ModListEditor.tsx` — 164 hits
- `components/MusicPlayerDemo.tsx` — 125 hits
- `components/FBIWantedManager.tsx` — 62 hits
- `components/SmartHumanCheck.tsx` — 36 hits
- `components/XiaohongshuDemo.tsx` — 8 hits
- `components/CloudflareChallengePage.tsx` — 7 hits
- `components/LinuxDoAuthCallbackPage.tsx` — 2 hits

### A.3 高饱和渐变文件（`bg-gradient-to-*`）

- `components/FinanceAppDemo.tsx` — 18 hits
- `components/MusicPlayerDemo.tsx` — 16 hits
- `components/MeditationAppDemo.tsx` — 15 hits
- `components/CDKStoreManager.tsx` — 6 hits
- `components/TigerAdventure.tsx` — 5 hits
- `App.tsx` — 3 hits
- `components/ResourceStoreManager.tsx` — 3 hits
- `components/AnnouncementManager.tsx` — 2 hits
- `components/BroadcastManager.tsx` — 2 hits
- `components/CaptchaVerificationExample.tsx` — 2 hits
- `components/EmailSender.tsx` — 2 hits
- `components/EmailVerifyPage.tsx` — 2 hits
- `components/FBIWantedManager.tsx` — 2 hits
- `components/LotteryAdmin.tsx` — 2 hits
- `components/UserProfile.tsx` — 2 hits
- `components/CoinFlip.tsx` — 1 hit
- `components/CommandManager.tsx` — 1 hit
- `components/DebugInfoModal.tsx` — 1 hit
- `components/LinuxDoAuthCallbackPage.tsx` — 1 hit
- `components/MarkdownExportPage/MarkdownPreview.tsx` — 1 hit
- `components/ModListPage.tsx` — 1 hit

### A.4 `red-*`（→ `rose-*`）

`components/CommandManager.tsx`(16)、`components/CDKStoreManager.tsx`(16)、`components/ResourceStoreManager.tsx`(10)、
`components/FBIWantedManager.tsx`(9)、`components/TigerAdventure.tsx`(8)、`components/WebhookEventsManager.tsx`(7)、
`components/NexAISecurityDashboard.tsx`(7)、`components/LotteryAdmin.tsx`(7)、`components/AuditLogViewer.tsx`(7)、
`components/TTSForm.tsx`(6)、`components/ShortLinkManager.tsx`(6)、`components/AnnouncementManager.tsx`(6)、
`components/LibreChatAdminPage.tsx`(5)、`components/ApiKeyManager.tsx`(5)、`components/ShortUrlMigrationManager.tsx`(4)、
`components/EcoEnchantsOpsPanel.tsx`(4)、`components/DataCollectionManager.tsx`(4)、`App.tsx`(4)、
`components/MobileNav.tsx`(3)、`components/BroadcastManager.tsx`(3)、`components/FinanceAppDemo.tsx`(2)、
`components/BilibiliSyncAdmin.tsx`(2)、`components/ArtifactSharePage.tsx`(2)、`components/AdminStoreDashboard.tsx`(2)、
`components/RegistrationInviteManager.tsx`(1)

### A.5 `green-*`（→ `emerald-*`）

`components/CommandManager.tsx`、`components/CDKStoreManager.tsx`、`components/TigerAdventure.tsx`、
`components/LotteryAdmin.tsx`、`components/ResourceStoreManager.tsx`、`components/WebhookEventsManager.tsx`、
`components/EmailTraceability.tsx`、`components/EcoEnchantsOpsPanel.tsx`、`components/BilibiliSyncAdmin.tsx`、
`components/DataCollectionManager.tsx`、`components/FinanceAppDemo.tsx`、`components/MeditationAppDemo.tsx`、
`components/ModListEditor.tsx`、`components/ShortLinkManager.tsx`、`components/SmartHumanCheck.tsx`、
`components/UserProfile.tsx`、`types/fbi.ts`

### A.6 `yellow-*`（→ `amber-*`）

`components/CommandManager.tsx`、`components/CDKStoreManager.tsx`、`components/LotteryAdmin.tsx`、
`components/FBIWantedManager.tsx`、`components/TigerAdventure.tsx`、`components/WebhookEventsManager.tsx`、
`components/ResourceStoreManager.tsx`、`components/EcoEnchantsOpsPanel.tsx`、`components/FinanceAppDemo.tsx`、
`components/ModListEditor.tsx`、`components/ShortLinkManager.tsx`、`components/UserProfile.tsx`、`App.tsx`

### A.7 `gray-*`（→ `slate-*`）

`App.tsx`(8)、`components/FinanceAppDemo.tsx`(5)、`components/ApiKeyManager.tsx`(3)、`types/fbi.ts`(2)、
`components/MeditationAppDemo.tsx`(1)

### A.8 未 import `studioTheme` 的 `.tsx`（115 个，按目录）

- `layout/` (4): `DesktopShell.tsx`, `app-sidebar.tsx`, `nav-group.tsx`, `sidebar-view-header.tsx`
- `components/ui/` (9): `button.tsx`, `sheet.tsx`, `sidebar.tsx`, `tooltip.tsx`, `skeleton.tsx`, `separator.tsx`, `scroll-area.tsx`, `Input.tsx`, `CredentialIdModal.tsx`
- `components/geogebra/` (10): `GeoGebraAiPanel.tsx`, `GeoGebraApplet.tsx`, `GeoGebraCloudPanel.tsx`, `GeoGebraCommentsPanel.tsx`, `GeoGebraEditor.tsx`, `GeoGebraExportPanel.tsx`, `GeoGebraPage.tsx`, `GeoGebraProjectPanel.tsx`, `GeoGebraSharePage.tsx`, `GeoGebraSharePanel.tsx`
- `components/pixel/` (6): `PixelCardPanel.tsx`, `PixelHistoryPanel.tsx`, `PixelNoticeDialog.tsx`, `PixelSubmitPanel.tsx`, `PixelTaskPanel.tsx`, `PixelWorkbenchPage.tsx`
- `components/admin/` (20+): `AdminCommandPalette.tsx`, `AdminGuard.tsx`, `AdminHub.tsx`, `AdminOverviewPanel.tsx`, `AdminScopeManager.tsx`, `CaptchaProviderAdmin.tsx`, `CoinFlipAdmin.tsx`, `CrashReportManager.tsx`, `DebugConsole.tsx`, `GeoGebraAdminPanel.tsx`, `IntegrationsHealthPanel.tsx`, `IpRiskLogPanel.tsx`, `MediaToolAdmin.tsx`, `MobileTokenLineagePanel.tsx`, `PixelAdminPanel.tsx`, `PolicyConsentPanel.tsx`, `QqGuardManager.tsx`, `RedisDataBrowser.tsx`, `SuperAdminGuard.tsx`, `adminModules.tsx` + `captcha-providers/*`(5) + `crash-reports/*`(3) + `ip-risk-log/*`(6) + `media-tool/*`(5) + `policy-consent/*`(3) + `qq-guard/*`(5)
- `components/env-manager/` (56)
- `components/ticket/` (8) + `TicketSystem.tsx`
- `components/policy/` (6) + `PolicyConsentChecklist.tsx`
- `components/user-profile/` (5) + `user-management/` (3) + `UserProfile.tsx`, `UserManagement.tsx`
- `components/docTool/` (3) + `DocConvertPage.tsx`
- `components/speech-to-text/` (2)
- `components/VtRatioExplorer/` (4) + `VtRatioExplorer.tsx`
- `components/CommandManager/` (2)
- 顶层其余：`AdminDashboard.tsx`, `AdminLogin.tsx`, `AdminStoreDashboard.tsx`, `AgeCalculatorPage.tsx`, `AiErrorDetailsPanel.tsx`, `AlertModal.tsx`, `AnnouncementManager.tsx`, `AnnouncementModal.tsx`, `AntiCounterfeitPage.tsx`, `ApiDocs.tsx`, `ApiKeyManager.tsx`, `ArticleCommandPalette.tsx`, `ArtifactSharePage.tsx`, `AudioPreview.tsx`, `AuditLogViewer.tsx`, `BackupCodesModal.tsx`, `BilibiliDataAdmin.tsx`, `BilibiliSyncAdmin.tsx`, `BroadcastManager.tsx`, `BroadcastModal.tsx`, `BroadcastModalView.tsx`, `CDKStoreManager.tsx`, `CampusEmergencyPage.tsx`, `CapWidget.tsx`, `CaptchaVerificationExample.tsx`, `CaptchaVerificationPage.tsx`, `CaseConverter.tsx`, `ClientOriginProbe.tsx`, `CloudflareChallengePage.tsx`, `CoinFlip.tsx`, `CommandManager.tsx`, `ConfirmModal.tsx`, `DataCollectionManager.tsx`, `DebugInfoModal.tsx`, `DeepLXTranslatorPage.tsx`, `DemoHub.tsx`, `DocConvertPage.tsx`, `EcoEnchantsAdminPage.tsx`, `EcoEnchantsOpsPanel.tsx`, `EmailSender.tsx`, `EmailTraceability.tsx`, `EmailVerifyPage.tsx`, `EnvManager.tsx`, `ErrorDisplay.tsx`, `EstablishSecuritySession.tsx`, `FBIWantedManager.tsx`, `FBIWantedPublic.tsx`, `FeatureConsentGate.tsx`, `FinanceAppDemo.tsx`, `FingerprintManager.tsx`, `FingerprintRequestModal.tsx`, `FirstVisitVerification.tsx`, `Footer.tsx`, `ForgotPasswordPage.tsx`, `GitHubBillingCacheManager.tsx`, `GitHubBillingDashboard.tsx`, `GoogleAuthButton.tsx`, `HCaptchaWidget.tsx`, `HomeHub.tsx`, `IPBanManager.tsx`, `ImageUploadPage.tsx`, `ImageUploadSection.tsx`, `LegacyApiChoicePage.tsx`, `LibreChatAdminPage.tsx`, `LibreChatContext.tsx`, `LibreChatGuestCleanup.tsx`, `LibreChatPage.tsx`, `LibreChatQuotaIndicator.tsx`, `LibreChatRealtimeDialog.tsx`, `LinuxDoAuthButton.tsx`, `LinuxDoAuthCallbackPage.tsx`, `LoadingSpinner.tsx`, `LogShare.tsx`, `LoginPage.tsx`, `LotteryAdmin.tsx`, `LotteryPage.tsx`, `MailSystemConfigManager.tsx`, `ManagedCaptcha.tsx`, `MarkdownArticleManager.tsx`, `MarkdownArticlePage.tsx`, `MarkdownExportPage.tsx`, `MarkdownExportPage/MarkdownPreview.tsx`, `MarkdownPreview.tsx`, `MarkdownRenderer.tsx`, `MeditationAppDemo.tsx`, `Mermaid.tsx`, `MobileLoginPanel.tsx`, `MobileNav.tsx`, `ModListEditor.tsx`, `ModListPage.tsx`, `ModalPortal.tsx`, `MusicPlayerDemo.tsx`, `NexAISecurityDashboard.tsx`, `Notification.tsx`, `NotificationTestPage.tsx`, `OAuthAuthorizePage.tsx`, `OAuthClientManager.tsx`, `OAuthOidcEndpointPanel.tsx`, `OutEmail.tsx`, `PasskeySetup.tsx`, `PasskeyVerifyModal.tsx`, `PenaltyAppealActions.tsx`, `PenaltyAppealHost.tsx`, `PolicyPage.tsx`, `ProductDetails.tsx`, `ProductQueryForm.tsx`, `PromptModal.tsx`, `ProviderBindPage.tsx`, `PublicShortLinkCreator.tsx`, `RegisterPage.tsx`, `RegistrationInviteManager.tsx`, `ResetPasswordLinkPage.tsx`, `ResetPasswordPage.tsx`, `ResourceStoreDetail.tsx`, `ResourceStoreManager.tsx`, `RuntimeConfigSections.tsx`, `ShortLinkManager.tsx`, `ShortUrlMigrationManager.tsx`, `SmartHumanCheck.tsx`, `SmartHumanCheckTestPage.tsx`, `SmartHumanCheckTraces.tsx`, `StepUpGate.tsx`, `SystemManager.tsx`, `TOTPManager.tsx`, `TOTPSetup.tsx`, `TOTPVerification.tsx`, `TTSForm.tsx`, `TamperDetectionDemo.tsx`, `TigerAdventure.tsx`, `TranslationAuditViewer.tsx`, `TtsGenerationManager.tsx`, `TtsHistoryList.tsx`, `TtsPage.tsx`, `TtsPolicyConsentPanel.tsx`, `TurnstileWidget.tsx`, `UserManagement.tsx`, `UserProfile.tsx`, `VercelAnalytics.tsx`, `VerificationMethodSelector.tsx`, `VerifyCodeInput.tsx`, `WebhookEventsManager.tsx`, `WelcomePage.tsx`, `WordCountPageSimple.tsx`, `WsConnector.tsx`, `XiaohongshuDemo.tsx`, `confirm/ConfirmDialogProvider.tsx`

### A.9 framer-motion 文件但无 reduced-motion 处理（85 个）

见 §2 FD-063；完整清单由 `node frontend/scripts/check-design-language.mjs --json` 在 P1 落地后输出，
P1 交付前以本次扫描为准（`F:/tmp/fescan/detail.txt` 的 `framer` 标记）。

### A.10 可点非交互元素无 role（4 个文件，6 处）

见 §2 FD-065；由同一扫描器输出，随 P1 落地转为 CI 判据。

### A.11 超过 800 行的文件（46 个）

`utils/integrityCheck.ts`(2804)、`components/CDKStoreManager.tsx`(2082)、`components/LogShare.tsx`(1945)、
`components/UserProfile.tsx`(1930)、`components/LibreChatPage.tsx`(1830)、`App.tsx`(1810)、
`components/ImageUploadPage.tsx`(1710)、`components/RuntimeConfigSections.tsx`(1676)、`components/EmailSender.tsx`(1583)、
`components/CommandManager.tsx`(1578)、`components/CaseConverter.tsx`(1556)、`components/TicketSystem.tsx`(1507)、
`components/SmartHumanCheck.tsx`(1464)、`components/WebhookEventsManager.tsx`(1457)、`components/UserManagement.tsx`(1451)、
`components/FBIWantedManager.tsx`(1360)、`components/LotteryAdmin.tsx`(1345)、`components/TTSForm.tsx`(1324)、
`components/ApiKeyManager.tsx`(1299)、`components/EcoEnchantsAdminPage.tsx`(1276)、`components/ShortLinkManager.tsx`(1273)、
`components/MeditationAppDemo.tsx`(1217)、`components/TigerAdventure.tsx`(1213)、`components/DataCollectionManager.tsx`(1198)、
`components/EcoEnchantsOpsPanel.tsx`(1087)、`components/FinanceAppDemo.tsx`(1053)、`components/LotteryPage.tsx`(1035)、
`components/ResourceStoreManager.tsx`(1013)、`components/OAuthClientManager.tsx`(1001)、`components/ModListEditor.tsx`(1001)、
`components/AuditLogViewer.tsx`(988)、`components/CoinFlip.tsx`(962)、`components/user-management/UserFormControls.tsx`(939)、
`components/TamperDetectionDemo.tsx`(921)、`components/ResourceStoreList.tsx`(906)、`components/GitHubBillingDashboard.tsx`(906)、
`components/XiaohongshuDemo.tsx`(892)、`components/BroadcastManager.tsx`(890)、`components/geogebra/GeoGebraPage.tsx`(887)、
`components/admin/IntegrationsHealthPanel.tsx`(865)、`components/LibreChatAdminPage.tsx`(854)、
`components/FingerprintManager.tsx`(850)、`components/SmartHumanCheckTraces.tsx`(838)、`navigation/navConfig.ts`(822)
（另有 `components/EnvManager.tsx` 等 2 个在扫描边界上）。
