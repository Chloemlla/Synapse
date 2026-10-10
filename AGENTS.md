# Repository Guidelines

> 本文件是本仓库的**工程约束 + 操作手册**，给 AI agent 与人类协作者共用，保持精简、可执行。
> 架构、分层、请求生命周期、常见任务怎么做，看 **`CLAUDE.md`**；
> 治理闸门（文件体积 / 前端预算 / 隐私契约）的判据与清单，看 **`docs/governance/repository-governance.md`**。

---

## 0. 硬性约束（先读这几条）

1. **禁止在本机构建 / 测试 / 装依赖**：一切编译、测试、lint、依赖安装只由 GitHub Actions 执行
   （本机性能不足，且本机 `node_modules` 常年落后于锁文件，结论不可信）。
   需要新依赖时走 **§7「新增依赖的唯一通路」**。
2. **CI 是唯一裁决者**：静态读码与本地推断都不算证据，以 `main` 上 workflow 的结论为准。
   判红前先看**同一个 job 在父提交上的历史结论**，把存量红灯摘出去再动手。
3. **不写超级文件**：不要把所有东西塞进一个巨大的聚合文件 / 聚合模块。
   源码体积由 `pnpm run check:ts-file-size` 把关（**默认上限 1500 行**，可用
   `MAX_TS_FILE_LINES` 覆盖；已超限的遗留文件只在「不再增长」时被容忍，允许 +300 行以内的增量）。
4. **每完成一次修改都要提交并推送**：`type: 简短描述` 的 Conventional Commits（`feat:` / `fix:` /
   `docs:` / `chore:` / `perf:` / `test:`），提交信息写**为什么**；修 GitHub issue / code-scanning
   alert 时在信息里带上编号。优先 GPG 签名提交（`git commit -S`）；签名真的失败或超时才退回
   `--no-gpg-sign`，并在总结里如实说明。
5. **`git add` 显式列文件**，不要 `git add -A` / `git add .`。
6. **本 clone 常有多会话并发写同一分支**：动手前 `git status` 看全量——
   `git status --porcelain | head -5` 会把在飞 WIP 的规模隐掉；**别人的未提交 WIP 绝不纳入自己的提交**，
   也不替别人回滚。
7. **敏感文件绝不入库**：`.env`、`secrets/`、`*.jks` / `*.keystore`、签名脚本、任何凭据。
8. **禁止交互式命令**：`git rebase -i`、`git add -i` 等一律不用。
9. **push 一律** `GIT_TERMINAL_PROMPT=0`（否则本机 push 会挂死）。
10. **`gh` 命令一律显式带 `-R <owner>/<repo>`**（本机在 fork 克隆里会解析到 upstream）。

---

## 1. 仓库结构

Synapse 是 TypeScript 全栈 TTS 平台，前后端分离、同镜像发布。

**后端 `src/`**

| 目录 | 职责 |
| --- | --- |
| `app.ts` | 极薄的入口（约 50 行）：装配 + 启动 + 进程级错误处理 |
| `app/assembly.ts` | 中间件栈、路由相位挂载、静态资源与 SPA 兜底、错误处理（**要改顺序先读 CLAUDE.md**） |
| `app/startup.ts` | Mongo / Redis 连接、WebSocket、优雅停机 |
| `routes/` | HTTP 端点定义；`routes/routeModules/*.ts` 是按相位分组的**模块注册表** |
| `controllers/` | 请求/响应处理，不写业务规则 |
| `services/` | 业务逻辑（认证、TTS、媒体工具、限流、审计、计费……），函数式导出为主 |
| `models/` | Mongoose schema 与索引、TTL |
| `middleware/` | 认证、管理员范围、WAF、IP 封禁、限流、请求守卫 |
| `security/` | 安全策略、CSP 管线、安全流水线相位 |
| `generated/` | 生成物（勿手改，由 script 生成、CI 卡漂移） |
| `tts/`、`mediaTool/` | TTS 管线与媒体工具子系统 |
| `tests/` | 后端 Jest 用例 |

**前端 `frontend/src/`**：`main.tsx` 入口、`App.tsx` 路由（懒加载）、`components/`（含
`components/admin/` 管理面板）、`api/`、`hooks/`、`stores/`、`utils/`、`tests/`（Vitest）。

---

## 2. 命令（统一用 pnpm）

仓库用 `packageManager: pnpm@11.11.0` 钉死包管理器；`pnpm-lock.yaml` 是唯一锁文件。
以下命令除 `dev*` 外都由 CI 执行；**本机禁跑**（见 §0 第 1 条），列出来是为了读懂 workflow 与推断依赖关系。

```bash
# 开发（仅在你被明确允许本地起服务时使用）
pnpm run dev              # 后端 + 前端一起起
pnpm run dev:backend      # ts-node + nodemon，端口 3000
pnpm run dev:frontend     # Vite，端口 3001

# 构建 / 类型
pnpm run build            # 后端（tsc + 混淆）+ 前端
pnpm run build:backend    # 生成 admin SPA 路径 → tsc → 拷模板 → 混淆
pnpm --dir frontend run build        # 前端生产构建（vite build，含体积预算输入）
pnpm --dir frontend run typecheck    # 前端 tsc --noEmit

# 测试
pnpm run test             # 后端 Jest
pnpm run test:auth        # 只跑认证相关
pnpm run test:ci          # CI 用（runInBand + 覆盖率报告）
pnpm --dir frontend run test:ci      # 前端 Vitest（Jest 不覆盖 frontend/src）

# 生成物与闸门
pnpm run generate:openapi         # 由路由注释生成 openapi.json
pnpm run check:openapi-drift      # spec 与注释是否漂移
pnpm run check:admin-spa-paths    # 管理面板路径清单是否漂移
pnpm run check:ts-file-size       # 源码体积闸门
pnpm run check:frontend-bundle    # 前端 gzip 预算（需先构建前端）
pnpm run check:privacy-contract   # 隐私数据地图契约
pnpm run smoke:obfuscated         # 混淆产物的生产启动冒烟
```

---

## 3. CI 闸门（推 `main` 会跑什么）

| Workflow | 是否门禁 | 内容 |
| --- | --- | --- |
| **Node Verification** | ✅ | `pnpm install` → audit 策略 → build → openapi 生成/drift → admin SPA 路径 drift → 混淆产物冒烟 → **后端 Jest + 前端 Vitest（含覆盖率）** |
| **Quality Guardrails** | ✅ | 源码体积闸门、隐私契约、存储责任报告（advisory）、未用依赖报告（advisory）；**前端构建 + 体积预算**；Mongo 副本集集成测试 |
| **CodeQL** | ✅ | code scanning |
| **Docker** | ✅ | 镜像构建与发布 |
| **Code Quality (fuck-u-code)** | ⚠️ advisory | `continue-on-error: true`，只报告不拦 |
| **Nightly Test Matrix** | 定时 | 线上环境用例，不入 PR 门禁 |

只有「能改掉进程退出码」的步骤才算闸门；覆盖率报告、open handle 清单、advisory 报告都不算。
**步骤被 `skipped` 不等于通过**——一个编译错会让后续测试步骤整条静默消失，收尾要看每个 job 的
step `outcome`。

---

## 4. 编码约定

- TypeScript；2 空格缩进；现有文件风格优先于个人偏好。
- 服务层**函数式导出**为主（`services/` 里不鼓励 class，除既有单例）。
- 命名：`camelCase` 函数/变量、`PascalCase` 组件与类型；
  后端文件后缀 `*Routes.ts` / `*Controller.ts` / `*Service.ts`；测试 `*.test.ts` / `*.test.tsx`。
- **中间件顺序不可随意重排**（`src/app/assembly.ts`）：CSP/helmet → 压缩 → IP 封禁 → 审计 →
  body parser → WAF → CORS → 限流 → JWT 认证 → 业务处理器。改动前先读 `CLAUDE.md` 的安全层说明。
- 新增路由必须：在 `routes/routeModules/` 对应相位注册 + 配一个限流器 + 不绕过 JWT / 管理员校验。
- 新增管理面板页面只需改 `frontend/src/components/admin/adminModules.tsx` 的 `ADMIN_MODULE_LOADERS`；
  后端路径清单由 `scripts/generate-admin-spa-paths.js` 生成，`check:admin-spa-paths` 会卡漂移。
- 注释写「为什么」，尤其是**反直觉的取舍**与安全相关判断；不要复述代码本身。
- 用户可见文案只讲「要做什么 / 现在什么状态」，不铺实现原理（诊断细节收进可展开的「详情」）。

---

## 5. 测试约定

- **后端**：Jest + ts-jest，配置在 `jest.config.js`（`tsconfig.jest.json` 供 ts-jest 使用），
  用例放 `src/tests/`。`testTimeout` 30s、`maxWorkers: 1`、`detectOpenHandles: true`，
  **刻意不设 `forceExit`**（那会掩盖资源生命周期问题）。
- **前端**：Vitest（`pnpm --dir frontend run test:ci`），用例放 `frontend/src/tests/` 或组件同目录。
  Jest 的 `testPathIgnorePatterns` **排除 `frontend/src`**——前端用例写进 `src/tests/` 不会被执行，
  反之亦然。
- 用例命名按「被测模块或行为」命名（`authController.test.ts`、`securityPipeline.test.ts`）。
- 改生产代码前先看有没有测试**替身**依赖该成员：`jest.mock` 工厂漏一个导出就会让整组用例
  以「看起来像业务坏了」的方式挂掉（报错点常在业务文件里，根因在替身缺件）。

---

## 6. 提交与 PR

- Conventional Commits，信息里写清**为什么**；一次提交做一件事，避免把不相关改动捆在一起。
- PR 描述包含：改了什么、为什么、验证方式（CI run / 命令）、关联 issue 或 alert 编号；
  有可见前端改动时附截图。
- 提交后确认远端真的推进了：`git fetch` 后比对 `git rev-parse HEAD` 与 `origin/main`。

---

## 7. 新增依赖的唯一通路（本机禁止安装）

1. **只改清单**：在对应 `package.json` 加依赖（后端运行时依赖进根 `dependencies`；
   要在 TS 里 `import` 的包必须同时把 `@types/*` 加进 `devDependencies`，否则 `tsc` 会因 TS7016 红）。
   **一个字节都不要碰 `pnpm-lock.yaml`**。`git add <那一个 package.json>` → 提交 → push。
2. **让 CI 重生锁文件**：
   `gh workflow run "Update Lockfiles" -R Chloemlla/Synapse --ref main -f action=repair-lockfiles`
   （工作流文件名是 `.github/workflows/dependabot-maintenance.yml`；`repair-lockfiles` 只跑
   `pnpm install --lockfile-only`，不会顺手把全部依赖升级）。
3. 等它开 PR → `gh pr merge <N> -R <owner>/<repo> --disable-auto` → `--squash --admin`。
   该 PR 上的 check 是结构性不跑（工作流用 `GITHUB_TOKEN` 推的分支），**判据是 jobs 为空**；
   若 PR 上出现了带 job 的真失败，那是真红，不要强合。
4. 合并后再看 `main` 的 push CI：`--frozen-lockfile` 的 job（Quality Guardrails / Docker）此时才可能转绿。

可选的只读查询（不算安装）：`pnpm view <pkg> version`、`curl` 拉 registry tarball 读产物确认契约。

---

## 8. 安全与配置

- 生产**必需** `ADMIN_PASSWORD` 与 `JWT_SECRET`（缺失时启动即失败）；TTS 需要 `OPENAI_API_KEY` /
  `OPENAI_BASE_URL`。完整变量清单以 **`.env.example`** 为准，不要在本文件里抄第二份。
- 用户存储**只支持 MongoDB**：`USER_STORAGE_MODE` 只接受 `mongo`，传别的值直接抛错。
  `MONGO_URI`（优先）/ `MONGODB_URI` + `MONGO_DB`。Redis 可选，缺失时安全降级（限流退内存档）。
- 管理端接口分两档：`admin`（只读业务 + 用户/API Key/OAuth 管理）与 `superadmin`（系统级写操作）。
  普通管理员能看哪些页面由**运行时配置**（Mongo `admin_scope_configs`，默认集合 + 按用户覆盖）决定，
  页面与 API 的对应关系登记在 `src/config/adminPages.ts`。**两侧都不要写死页面清单**：
  加新功能只需在登记表里加一条，授权由超管在线调整。
- 密码一律 bcrypt 哈希；日志与接口响应里绝不出现密码、令牌、密钥。
- IP 封禁是最外层守卫（支持单 IP 与 CIDR，存 Redis（若有）或 Mongo）。
- **Redis 在库数据浏览器是只读的**（`/admin/system` → 「Redis 在库数据」，后端 `src/routes/admin/system.ts`）：
  超管 + 安全会话两层缺一不可，列表走 SCAN（禁用 `KEYS`），快照导出走 `DUMP`+`PTTL`（NDJSON，base64）。
  与其它 1Panel 应用共享 Redis 时，用 `ADMIN_REDIS_KEY_PREFIXES`（逗号分隔）把范围收窄到本服务命名空间；
  不配就是整个当前 DB。真 RDB 只能在宿主机用 `deploy/openresty/backup-redis.sh` 导出；
  拿回快照用 `node scripts/redis-restore-snapshot.js --file <ndjson> [--apply --replace]`（默认 dry-run）。
- 新增路由必须配限流器；不要在子路由重复挂同一个限流器实例（会让一次请求过两遍、额度减半）。

---

## 9. 本机环境提示（Windows / agent 工具）

- 中文文件不是损坏：PowerShell 里按 UTF-8 读即可。
  ```powershell
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  $OutputEncoding = [System.Text.Encoding]::UTF8
  Get-Content -Encoding UTF8 <file>
  ```
- `apply_patch` 的补丁头必须精确是 `*** Begin Patch` 起、`*** End Patch` 止，末尾不能多写 `***`。
- 找文件用 `fd`、搜内容用 `rg`（**不要用 `find`**，尤其不要用 Git 自带的 `find.exe`）；
  `rg` 默认递归，**`-r` 是 replace 不是 recursive**。
- Bash 里每条命令开头的 `\377\376export': command not found` 是 `.bashrc` 的 BOM 噪音，无害。
