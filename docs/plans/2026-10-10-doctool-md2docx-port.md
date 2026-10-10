# doc-tool：Markdown → Word 批量转换（md2docx 能力迁入 Synapse）

> 状态：**方案已定稿，待实现**。日期：2026-10-10。
> 来源：`F:\studys\md2docx`（本机零依赖 Node 脚本 + 浏览器界面，已 36/36 自检通过）。
> 依据：`verified-methodology.md`（本机禁构建、CI 唯一裁决、显式 add、签名提交）、本仓库 `AGENTS.md` / `CLAUDE.md`。

## 1. 目标与不迁入项

**迁入（服务端）**：md → docx 批量转换、冲突策略（跳过 / **自动重命名** / 覆盖）、参考样式模板（含「生成默认模板」）、
递归收集与相对子目录结构、逐文件进度、成功/跳过/失败统计、可下载报告、**只重试失败项**、产物打包下载、
用户偏好持久化（下次打开自动带出）。

**不迁入**：本机目录浏览器、文件系统自动扫描开关（Web 侧没有本地文件系统）、CLI 控制台流程、`md2docx.config.json` 落盘。
浏览器内已有的「单文档即时预览 + 客户端 docx/PDF」保留不变（`frontend/src/components/MarkdownExportPage.tsx`，走 `docx` npm 包）。

**融合方式**：`MarkdownExportPage` 顶部加「单文档 / 批量」模式切换——单文档＝原有即时预览（零上传、无鉴权依赖）；
批量＝服务端 pandoc（高保真、可批量、表格/公式/中文字体由参考样式统一）。另开独立深链 `/doc-convert` 渲染同一批量面板。

## 2. 为什么用服务端 pandoc（而不是继续用 `docx` npm 包）

| | 客户端 `docx` 包 | 服务端 pandoc |
|---|---|---|
| 表格/公式/脚注保真 | 手写映射，覆盖有限 | GFM/LaTeX 原生 |
| 中文字体与标题样式统一 | 逐处设置 | `--reference-doc` 一处生效 |
| 批量 100 个文件 | 浏览器内存/卡顿 | 服务端队列 + 进度 |
| 失败可重试/可出报告 | 无 | 有 |

## 3. 二进制：pandoc 打包（已取证）

Docker 里像 yt-dlp 一样内置**上游官方二进制**，不走 `apk add pandoc`（仓库版本常年滞后且拉入 GHC 依赖树）。

已在本机对上游产物取证（只读，未安装任何东西）：

- 上游最新 `jgm/pandoc` release：**3.12.1**（2026-10-08），资产 `pandoc-3.12.1-linux-amd64.tar.gz` / `-linux-arm64.tar.gz`
  —— **没有** musllinux/静态命名的变体。
- 但该 tarball 里的 `bin/pandoc` 是 **完全静态 ELF**：`e_type=ET_EXEC`、**无 `PT_INTERP`**、
  无 `GLIBC_2.*` 符号版本引用、无 `DT_NEEDED`。→ 在 Alpine(musl) 上可直接运行，**不需要 gcompat**。
- 二进制内嵌 data files（含 `reference.docx`）→ `--print-default-data-file reference.docx`「生成默认样式模板」可用。
- tarball SHA256（本次实测）：`d0c90410e90204c9ca83b8539fac5c7aed01fd537207e4585849f8abc5df20b8`（3.12.1 / linux-amd64）。

落地要点：

- **必须钉版本**：上游资产名带版本号（`pandoc-<ver>-linux-amd64.tar.gz`），
  所以不能用 `releases/latest/download/...`；`ARG PANDOC_VERSION=3.12.1` 是默认值，升级＝改一行或 `--build-arg`。
- 顺带用 `ARG PANDOC_SHA256` 做校验（上游**不发** checksums 文件，所以校验和由我们钉住；留空则跳过校验并打印提示）。
- 落点 `/usr/local/bin/pandoc`（在 PATH 上，探测逻辑「留空即 PATH」与 yt-dlp 一致），层末 `pandoc --version` 兜住架构/兼容问题。
- 只拷 `bin/pandoc`（157.8 MB 静态二进制），不留 tarball、不拷 `pandoc-lua`/`pandoc-server`。镜像体积代价记在此处备查。

## 4. 后端结构（新增子系统，与 `src/mediaTool/` 同构）

```
src/docTool/
  types.ts                 # 类型契约（本文件先落盘，其它模块只依赖它）
  runtime.ts               # pandoc 探测/版本、workRoot 解析、路径安全、相对路径、冲突命名、文件清单
  converter.ts             # convertOne / buildReferenceDoc / collectMarkdown / 报告文本
  zipStore.ts              # 内置 ZIP 打包（zlib + crc32，无第三方依赖）
  settingsStore.ts         # 用户偏好持久化（Mongo 单文档 per user）
  serverRuntime.ts         # 单例装配 + 进程重启恢复
  jobs/docJobStore.ts      # 任务存储（Mongo）
  jobs/docJobRunner.ts     # 串行队列、逐文件进度、取消
  jobs/docArtifactCleanup.ts
  http/docToolHttp.ts      # 路由构建器（依赖注入，便于单测）
src/models/docToolModels.ts
src/routes/docToolRoutes.ts                # 挂到 /api/doc-tool（用户态鉴权）
src/routes/routeModules/postTamperModules.ts   # 相位登记（改）
src/routes/routeModules/routeLimiterModules.ts # 限流器挂载（改）
src/middleware/routeLimiters.ts            # 新增 docToolLimiter（改）
```

**访问控制**：用户态（`authenticateToken`），任务按 `scope: "user" + ownerId` 隔离；不使用管理员档。
**工作目录**：`<DOC_TOOL_WORK_DIR or data/doc-tool>/users/<userId>/{inbox,out,templates}`；
每条落盘路径都要 `relInside` 校验（沿用 `src/mediaTool/runtime.ts` 的 `relInside` 语义），拒绝 `..`、绝对路径、符号链接逃逸。
**上传**：multer 磁盘存储，仅 `.md`/`.markdown`，单文件与总大小上限走 env（默认单文件 8 MB、单任务 300 个文件）。

**任务存储**：集合 `doc_tool_jobs`。`createdAt`/`finishedAt` **用 `Date` 而不是 epoch 数字**——
本仓库 TTL 索引都建在 Date 字段上（`auditLogModel` 有专门注释说明 TTL 是索引的物理属性）；
用毫秒数字会让 TTL 立刻命中。TTL `expireAfterSeconds = 7 天`，另加 `{ userId: 1, createdAt: -1 }` 索引。

**并发**：进程内串行队列（并发 1，pandoc 本身是重进程）；`cancelRequested` 时 kill 当前子进程。
**重启恢复**：残留 `running` → `failed("服务重启，任务被中断")`；残留 `queued` 且未取消 → 重新入队（沿用 mediaTool 做法）。

## 5. HTTP 契约（前后端并行开发的唯一依据）

前缀 `/api/doc-tool`，全部要求登录（Cookie/`Bearer`），只返回调用者自己的数据。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | `{ ok, pandoc: { available, version, bin }, workDir, limits, limitsSource }` |
| GET | `/settings` | `{ pandoc, limits, prefs }`，`prefs` = 该用户上次用的选项（服务端持久化） |
| PUT | `/settings` | body `{ prefs: DocPrefs }` → `{ prefs }`（只允许已知键） |
| GET | `/files?recursive=&conflict=` | 列该用户已上传的 md：`{ files: DocFileEntry[], counts }`（`status: new\|stale\|fresh`） |
| POST | `/upload` | multipart：`files[]`（多个 .md）+ `relPaths[]`（同序相对路径，用于保留目录结构）→ `{ files, rejected[] }` |
| POST | `/jobs` | body `CreateJobInput` → `{ jobId }`，创建后立即入队 |
| GET | `/jobs?limit=` | 该用户最近任务（默认 20，上限 100） |
| GET | `/jobs/:id` | 任务详情（进度、逐文件结果、日志尾部） |
| POST | `/jobs/:id/cancel` | 请求取消 |
| DELETE | `/jobs/:id` | 删除任务并清理其产物 |
| GET | `/jobs/:id/report` | `text/plain` 报告（统计 + 策略 + 逐条明细） |
| GET | `/jobs/:id/bundle` | `application/zip`：成功产物打包（内置 zip） |
| GET | `/files/download?path=` | 单个 docx 下载（owner 内、`relInside` 校验、`Content-Disposition` 用 basename） |
| POST | `/templates` | body `{ name? }` → 用 `--print-default-data-file reference.docx` 生成模板到 `templates/` |
| POST | `/cleanup` | `{ keepDays? }` → 清理过期产物，返回删除数 |

**核心类型（`src/docTool/types.ts` 为准）**

```ts
type ConflictMode = "skip" | "rename" | "overwrite";
type OutMode = "alongside" | "custom";
interface DocPrefs { conflict: ConflictMode; outMode: OutMode; outDir: string; recursive: boolean; referenceDoc: string }
interface DocFileEntry { rel: string; sizeBytes: number; mtime: number; destRel: string; status: "new" | "stale" | "fresh"; willRename: boolean }
interface CreateJobInput { files?: string[]; recursive?: boolean; outMode?: OutMode; outDir?: string; conflict?: ConflictMode; referenceDoc?: string }
interface DocJobItem { rel: string; destRel: string; status: "ok" | "skipped" | "failed"; sizeBytes?: number; ms?: number; renamed?: boolean; error?: string }
interface DocJobRecord { id, userId, createdBy, createdAt: Date, startedAt?, finishedAt?, status: "queued"|"running"|"succeeded"|"partial"|"failed"|"cancelled", stage, progress, total, done, ok, skipped, failed, input: {files: string[], outMode, outDir, conflict, referenceDoc}, items: DocJobItem[], logs: {t:number,text:string}[], error?, cancelRequested: boolean }
```

## 6. 前端（与既有页面融合，不新增重依赖）

- `frontend/src/api/docTool.ts`：走共享 axios 实例 `./api`（**不用**裸 fetch，避免处罚态弹窗失效）。
- `frontend/src/components/docTool/DocBatchPanel.tsx`：批量面板（来源/文件列表与徽章/选项/进度/结果/报告/重试失败项/打开产物），
  子组件按需拆分（`DocFileList.tsx`、`DocJobProgress.tsx`）。
- `frontend/src/components/DocConvertPage.tsx`：独立页面，渲染 `DocBatchPanel`。
- `frontend/src/components/MarkdownExportPage.tsx`：加「单文档 / 批量」模式切换，批量模式**懒加载** `DocBatchPanel`。
- `frontend/src/App.tsx`：新增 `/doc-convert` 路由 + `routeConfig.titles` 条目。
- `frontend/src/navigation/navConfig.ts`：「实用工具」组加入口。
- 进度用**轮询**（`GET /jobs/:id`，1s，完成后停止）而不是 SSE：仓库内 SSE 只有 libreChat 反向代理在用
  （`assembly.ts` 明确把 `text/event-stream` 排除出压缩），轮询与既有 media-tool 的任务模型一致、无新增中间件风险。
- **体积预算**：`check:frontend-bundle.js` 的首屏禁用名单里有 `docx`；批量面板必须保持懒加载，
  不得把 `docx`/新依赖拉进首屏静态闭包。

## 7. 安全

- 路径穿越：所有用户输入路径 `resolve` 后必须 `relInside(userRoot)`；上传文件名清洗（去盘符、`..`、控制字符）。
- 命令注入：pandoc 一律 `spawn(bin, [args...])` **数组传参**，不拼 shell；用户提供的值只出现在
  `-o <path>`、`--reference-doc=<path>` 两个位置，且路径已过白名单校验。
- SSRF：本功能不接受 URL，无需 URL 校验（与 media-tool 的 B 站下载不同）。
- 资源保护：串行队列 + 单任务文件数上限 + 取消即 kill + 产物 TTL/清理；上传大小上限借鉴 mediaTool 的 multer 配置。
- 审计：写操作走 `auditLog` 中间件（创建/删除任务、生成模板），不记录用户文件内容。

## 8. 治理闸门与本次交付的对应关系

| 闸门 | 本次影响 |
|---|---|
| `check:openapi-drift` | 新路由写 `@openapi` 注释；CI 先 `generate:openapi` 再对账，注释合法即绿（**不需要**手改 `openapi.json`） |
| `check:privacy-data-map` / `check:privacy-contract` | **不动**隐私地图：仓库现状里 `media_tool_jobs` 等同类集合本就未登记；新增集合属owner决策，在 PR 描述里点出 |
| `check:ts-file-size` | 新文件全部远低于 1500 行；`MarkdownExportPage.tsx`（514 行）只加模式切换，增量小 |
| `check:frontend-bundle` | 批量面板懒加载，不进首屏闭包 |
| `check:admin-spa-paths` | 不新增管理面板页面，无需改生成物 |
| `Docker` workflow | 唯一能验证 pandoc 打包的地方：层末 `pandoc --version` 是这次打包的判据 |
| Jest / Vitest | 新增 `src/tests/docTool*.test.ts`（runtime/转换/zip/HTTP）与前端 `docBatchPanel.test.tsx` |

## 9. 验证判据（无本机构建，全部由 CI 裁决）

1. `Node Verification` 全绿：tsc、openapi 生成+对账、混淆冒烟、后端 Jest、前端 Vitest。
2. `Quality Guardrails` 全绿：体积闸门、前端构建+预算、隐私契约。
3. `Docker` 全绿：镜像构建成功且 `pandoc --version` 打印 3.12.1（层内自证）。
4. 前端单测覆盖：文件列表徽章（含「会另存为」）、冲突策略切换、进度轮询到完成、失败项重试、报告/打包按钮。
5. 后端单测覆盖：`relInside` 越界拒绝、冲突命名 `(2)/(3)`、`--print-default-data-file` 调用参数、
   zip 结构（EOCD/CRC32 校验向量 `123456789 → 0xCBF43926`）、任务状态机（queued→running→succeeded/partial/failed/cancelled）。

## 10. 后续（不在本次范围）

- 治理：把 `doc_tool_jobs` 登记进 `docs/governance/privacy-data-map.json`（需同步重新生成 `src/generated/privacyDataMap.ts`，由 owner 决定保留期口径）。
- 参考样式模板的可视化编辑（当前只生成 pandoc 默认模板，字体/标题样式在 Word 里改）。
- 与服务端 TTS/邮件等既有能力的组合工作流（如「转换完自动发邮件」）。
