# 前后端无用依赖审查与清理（2026-10-01）

来源：用户要求「审查前后端无用依赖一并移除」。

## 一、审查方式（不装依赖、可复现）

`pnpm-lock.yaml` 的依赖安装一律由 CI 负责，本机不做任何 `install`；因此审查也没用 `depcheck`，而是新增
`scripts/governance/report-unused-dependencies.js`（**纯静态**）扫描两张清单的引用面：

- **代码面**：`src/`、`scripts/`、`frontend/src/`、`.github/` 下的 `import "pkg"` / `import "pkg/sub"` /
  `require("pkg")` / `import("pkg")`；
- **配置面**：`vite/vitest/tailwind/postcss/tsconfig/jest` 配置、`package.json` 的 `scripts`、CI workflow、
  `Dockerfile`、`docker-compose.yml` 里带引号的包名引用；
- **CLI 面**：从已安装包的 `bin` 字段取二进制名，再在 scripts / workflow / Dockerfile 里按整词匹配
  （这一层专门用来避免把 `nodemon`、`ts-node`、`@playwright/test`、`@biomejs/biome` 这类「只在命令行用」的包误删）。

判定为 unused 的项还会**二次核对**：全仓（排除 node_modules / lockfile / docs）再搜一遍包名与二进制名，只有
一处引用都没有才进入删除清单。命令：`pnpm run report:unused-dependencies`（CI 里作为 advisory 步骤展示，不阻断）。

## 二、本次移除（31 项，均已二次核对无任何引用）

### 后端 `package.json`（14 项）

| 依赖 | 依据 |
| --- | --- |
| `http-proxy-agent` | 全仓无 import/require；代理支持由 `proxy-addr` / `axios` 自身承担 |
| `is-docker` | 无引用 |
| `liquid-glass-react` | 前端 UI 包误落在后端清单，且前端也未引用 |
| `lodash` | 无引用（工具函数各自实现） |
| `mongodb-connection-string-url` | 无引用（mongoose 自带解析） |
| `morgan`、`@types/morgan` | 无引用（请求日志由自研 logger / auditLog 中间件承担） |
| `nanoid` | 仅注释提到「nanoid 重试策略」，无实际调用（短链 ID 由自有实现生成） |
| `path-to-regexp` | 仅 CI 里有一条名为「path-to-regexp issues」的检查步骤标题 |
| `serve` | 无引用（静态产物由后端/前端各自 serve） |
| `swagger-ui-express`、`@types/swagger-ui-express` | `/api-docs` 是 SPA 内嵌 Swagger UI（见 `src/app/assembly.ts` 注释），spec 由 `swagger-jsdoc` 生成 |
| `tar-fs` | 无引用 |
| `uuid`、`@types/uuid` | 无引用（ID 统一走 `crypto.randomUUID`） |

### 前端 `frontend/package.json`（17 项）

| 依赖 | 依据 |
| --- | --- |
| `@heroicons/react` | 全仓无引用（图标统一用 `react-icons`） |
| `canvg` | 无引用 |
| `highlight.js`、`marked-highlight` | 无引用（高亮走 `react-syntax-highlighter` / 自研 `codeHighlight`） |
| `jszip` | 无引用 |
| `lodash.merge` | 无引用 |
| `react-copy-to-clipboard` | 无引用（复制走 `navigator.clipboard`） |
| `react-debounce-input` | 无引用 |
| `react-inspector` | 无引用 |
| `rollup` | 仅 `rollupOptions` 字样命中；vite 自带 rollup 依赖，无需直接声明 |
| `vite-plugin-auto-i18n` | 无引用（实际使用 `vite-auto-i18n-plugin`） |
| `@rsbuild/core` | 早期构建实验残留，无引用 |
| `@types/testing-library__jest-dom` | `@testing-library/jest-dom` v6 自带类型，`@types/*` 已废弃 |
| `@vitest/ui` | 无脚本使用（`pnpm exec vitest --ui` 也没被引用） |
| `cross-env` | 前后端 scripts 都没有用它设环境变量 |
| `rollup-plugin-visualizer` | 无引用（`analyze` 脚本用的是 `vite-bundle-analyzer`） |
| `vite-plugin-obfuscator` | 无引用（混淆走 `javascript-obfuscator` CLI + `dist-obfuscated` 流程） |

## 三、保留但需要说明的（避免后续误删）

| 依赖 | 为什么保留 |
| --- | --- |
| `@biomejs/biome`、`@playwright/test`、`ts-node`、`nodemon`、`concurrently`、`javascript-obfuscator` | 只在 `scripts` / CI 里以 CLI 形式调用（静态 import 扫描看不见） |
| `@types/node`、`@types/jest`、`@types/express`… | 类型检查需要，源码里不会出现 import |
| `postcss`、`autoprefixer`、`@tailwindcss/postcss` | `frontend/postcss.config.js` 里按配置键引用（`@tailwindcss/postcss`、`autoprefixer`） |
| `buffer`、`process`、`util` | vite 的 node polyfill alias 目标（`frontend/vite.config.ts`） |
| `prismjs`、`tw-animate-css` | 分别被 `vite.config.ts`、`src/index.css` 的 `@import` 引用 |
| `vite-auto-i18n-plugin`、`terser`、`@vitejs/plugin-react`、`tailwind-scrollbar`、`@radix-ui/react-dialog` | 被 `vite.config.ts` / `tailwind.config.js` / `vitest.config.ts` 引用 |

## 四、锁文件与 CI

- 本机不装依赖、不动锁文件（方法论 §一-1、§十七）：只改 `package.json`，锁文件交给既有工作流重生成
  （`.github/workflows/dependabot-maintenance.yml` 的 `repair-lockfiles` 动作会跑 `node scripts/fix-dependabot-alerts.js --repair`
  并开 PR，由 auto-merge 合入）。
- 校验方式：CI 的 `pnpm install --frozen-lockfile` + `type-check`（前后端）+ `Node verification`（Jest）
  + `Frontend bundle budget`（`tsc && vite build`）会立刻暴露任何「删多了」的依赖。

## 五、遗留

| 项 | 说明 |
| --- | --- |
| `fix:rollup` / `fix:rollup:win` / `fix:rollup:smart` 脚本 | 指向的 `fix-rollup-deps.js` / `fix-rollup-win.js` / `fix-rollup-deps.sh` 在前端目录**并不存在**（历史遗留脚本），本轮只清依赖，没有顺手删脚本，避免超出「依赖审查」范围 |
| advisory 报告接入 | `pnpm run report:unused-dependencies` 已加进 `Quality Guardrails → Governance checks`（只展示、不阻断）；后续若要做成门禁，需要先补足「CLI 工具 / @types / 配置引用」的白名单来源 |
