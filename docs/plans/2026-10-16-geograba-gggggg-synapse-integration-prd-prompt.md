# GeoGebra + Pixel 全量并入 Synapse：PRD 与实现提示词

> **文档性质**：目标产品需求、技术约束、验收清单，以及可直接交给后续实现代理的完整提示词。
> **目标仓库**：Synapse（本仓库）；`Pixel` 在本文中指来源仓库 `GGGGGG` 的自助折扣链接任务系统。
> **来源仓库**：`geograba/`、`GGGGGG/`。
> **日期**：2026-10-16。
> **状态**：需求基线 / 待实现；本文只定义合并需求，不代表功能已接入。
> **范围原则**：要求纳入来源代码中已存在的用户可见功能与管理能力；产品介绍中的商业化设想、未落地的后端契约，不得冒充现有功能。若实现所需授权、外部接口或数据处理依据未确认，必须列为发布阻断项，不得静默删减或绕过。

---

## 1. 目标与边界

将 GeoGebra Script Lab 的交互式数学工作台、项目协作与 AI 辅助能力，以及 GGGGGG 的 CDK 代理、折扣链接任务、任务查询/导出和管理能力，作为 Synapse 的**一体化功能域**接入。用户在 Synapse 的站点、账号体系、导航、审计、隐私同意、权限与部署体系中使用这些能力；不得另建一套登录系统、独立 MongoDB、Rust 服务或第二个生产站点。

本需求包含三个层次：

1. **功能完整性**：把下文列出的来源已实现功能逐项纳入最终目标，并为只有客户端契约的服务端能力补齐 Synapse 实现；阶段化交付不等于从最终范围删功能。
2. **平台一致性**：用 Synapse 现有 Express/TypeScript、React、MongoDB、登录会话、权限门禁、运行时配置、审计、隐私和 CI 模式实现，不机械搬运两个来源的架构。
3. **安全与合规**：GeoGebra 脚本、公用分享、第三方 AI、上传文件、Pixel 上游代理及账号凭据均需单独处理授权、隐私、日志脱敏、保留期和撤回/删除。

### 1.1 不在本次需求范围内

- 不把 Synapse 重写为 Rust 服务，不创建独立的 GG/GeoGebra 容器、数据库或监听端口。
- 不把 GGGGGG 的任意 `/api/*` 通用反向代理直接挂进 Synapse；只实现经审查的必要上游端点白名单。
- 不把商业化优先级文案（订阅、积分、市场、付费机构空间等）当作已实现功能或必需计费系统。
- 不实现 GeoGebra 来源中未落地的机构订阅、付费水印、私人分享、浏览分析等商业化设想；如后续要做，另立需求。
- 不将上游用户密码、辅助邮箱、2FA/TOTP 秘钥或原始完整账号行保存到 Synapse 的 MongoDB、日志、审计、分析、浏览器存储或错误追踪中。
- 不在本需求执行本地构建、测试、lint 或依赖安装；按 Synapse 仓库规则由 GitHub Actions 验证。

---

## 2. 来源事实与证据边界

### 2.1 GeoGebra Script Lab（`geograba/`）

| 已核对内容 | 来源证据 | 需求解释 |
|---|---|---|
| React + Vite 浏览器应用；GeoGebra applet、Monaco 编辑器、执行预处理器和调度器 | `geograba/package.json`；`src/components/App.jsx`；`src/engine/GeoGebraEngine.js`；`src/engine/Preprocessor.js`；`src/engine/Dispatcher.js` | 可复用其功能行为；需按 Synapse 的 TypeScript 前端与模块拆分重建/迁移，不直接把 5,000 行主组件并入 Synapse。 |
| 平面几何、立体几何、函数图形、综合工作台四种画布模式；示例脚本；运行、清空、重置、日志、进度、错误和统计 | `src/components/App.jsx:110-160,235-275`；`src/components/ControlPanel.jsx`；`src/components/LogPanel.jsx` | 属于确定的本地核心功能。 |
| 脚本预处理、基础语法校验、风险提示、执行时限；自由点拖拽后选择性回写脚本、冲突确认和拖拽锁定 | `src/engine/Preprocessor.js`；`src/engine/Dispatcher.js`；`src/engine/GeoGebraEngine.js:660-855`；`src/components/App.jsx:2170-2383,2719-2834` | 保留行为并增加测试；来源正则检查不是安全沙箱，不能作为唯一脚本安全边界。 |
| PNG/GGB 导出、脚本文本导出、参数控件、批量样式、课堂逐步讲解、自动播放和演示/全屏模式 | `src/engine/GeoGebraEngine.js:476-598`；`src/components/App.jsx:2257-2297,2719-3001,3256-3262`；`src/components/ControlPanel.jsx` | 属于来源已有功能。 |
| 本地项目、收藏/文件夹/标签、最近访问、版本快照/比较/回滚/撤销/重做、手动与定时云同步 | `src/utils/studio.js`；`src/components/App.jsx:968-1331,2430-2690,3340-3384` | 本地项目与云端项目是两种保存层级；同步冲突和用户隔离需在服务端重新设计。 |
| 团队、成员角色、团队项目、项目/版本/对象评论及 resolved 状态 | `src/components/App.jsx:1333-1541,1380-1541,4547-4678,4917-4991`；`src/api/backend.js:307-352` | 前端对 API 的调用存在；源仓库没有对应服务端实现，不能认为云端协作已在 Synapse 可用。 |
| 图片辅助 AI 绘图任务、上传凭证、异步轮询、脚本洞察、对象标注、对象依赖解释、异步导出 | `src/components/App.jsx:1936-2022,3003-3254`；`src/api/backend.js:174-425` | 只证明前端预期的接口和用户流程；需在 Synapse 实现并接既有 AI、队列、存储、配额与同意机制。 |
| 分享读取、公开分享创建、封面、嵌入地址、允许 fork | `src/components/App.jsx:1754-1810,2024-2103`；`src/api/backend.js:255-264` | 前端创建分享时固定为公开且允许 fork；不能将“私密分享/品牌页/访问分析”等营销设想算作现有功能。 |
| 管理端 IP 威胁配置与查询、后端概览/队列/缓存/模型/上传指标 | `src/components/App.jsx:1812-1934`；`src/components/BackendPanel.jsx`；`src/components/AdminConsole.jsx` | 来源实现的是 Scamalytics 配置/查询界面和一套独立 API 预期；应与 Synapse 既有 proxycheck/IP 风险系统比较后再决定适配或并存，不得混淆数据语义。 |
| 前端 API 预期包含 assets、AI jobs、projects、versions、teams、review、shares、exports、IP threat、admin dashboard | `src/api/backend.js` | 该文件没有后端服务。它是接口调用清单，不是可直接复用的 Synapse API 实现。 |
| 商业化优先级/收费方案 | `src/components/App.jsx:278-316`；`src/components/AppOverviewPage.jsx:158-216` | 这是策略说明，不是可运行功能；排除在本次“全量功能”验收之外。 |

GeoGebra README 将项目描述为 MIT，但合并代码前仍需核实源仓库实际许可文件与 GeoGebra API/脚本加载许可；不要从 README 文案推导第三方运行时可任意重分发。

### 2.2 Pixel 自助折扣链接（`GGGGGG/`）

| 已核对内容 | 来源证据 | 需求解释 |
|---|---|---|
| 用户工作台：卡密验证、服务类型/额度估算、账号列表提交、任务进度、历史查询、单任务/全部导出、排队取消、操作提示 | `frontend/src/App.tsx:208-906`；`docs/pixel-site-spec.md` | 属于用户侧功能。输入包含邮箱、密码、辅助邮箱和 2FA 秘钥，是高度敏感账号凭据。 |
| 代理 API：`/api/settings`、`/api/verify-card`、`/api/submit-task`、`/api/task/{id}`、`/api/tasks-by-card`、`/api/tasks/export-by-card`、`/api/task/{id}/account/{id}/cancel-queue` | `docs/openapi.yaml`；`docs/pixel-site-spec.md`；`backend/src/proxy.rs` | OpenAPI 标注为从公开页面重建的契约；以实现和目标上游当前正式接口二次核实为准。 |
| 三种服务：`link_only`（0.5 额度/账号）、`link_and_bind`（1）、`link_and_bind_1usd`（1.5）；开关来自 `/api/settings`；已存在链接时扣额可不同 | `frontend/src/App.tsx:110-138`；`docs/pixel-site-spec.md:56-66` | 额度估算和上游最终扣额应分开说明；以服务端/上游最终账本为准。 |
| 本地 CDK 映射：生成/创建/列出/删除分发 CDK，映射真实上游 CDK；上游值加密存储且只显示脱敏值 | `backend/src/admin.rs:28-34,102-186,238-304`；`backend/src/models.rs:4-37` | 目标中迁移为 Synapse 管理能力；不得把上游 CDK 返给浏览器。 |
| 使用溯源：按分发 CDK 过滤、分页上限、详情查看请求/响应摘要、状态码、耗时 | `backend/src/admin.rs:188-236`；`backend/src/proxy.rs:114-275,373-519`；`frontend/src/App.tsx:1001-1141,1384-1494` | 只保留最小必要审计字段并新增明确的保留/删除策略；不得保存账号密码、完整请求体或完整上游响应。 |
| 管理运行时配置：分组展示、敏感值脱敏、保存/恢复容器默认值、区分热更新/重启生效/不可覆盖的 bootstrap 项 | `backend/src/config_admin.rs`；`frontend/src/App.tsx:1509-1778` | 迁移到 Synapse 现有运行时配置系统；MongoDB、主加密密钥等 bootstrap 配置不得变成可在线覆盖字段。 |
| Admin OAuth：独立 code/state/callback、HttpOnly cookie、token 加密/刷新、要求 Synapse `active admin` 或 `trusted` | `backend/src/oauth.rs`；`backend/src/models.rs:164-249`；`docs/synapse-oauth-integration.md` | Synapse 内部应用不能再 OAuth 回自己；使用 Synapse 当前站点会话、服务端认证和管理范围守卫。不能把 `trusted` 直接映射成系统管理员。 |
| Docker/Rust/Axum 独立服务、独立 Mongo collection、用户前端静态托管 | `README.md`；`backend/src/main.rs` | 不迁移运行架构；把业务放入 Synapse Express + Mongoose + 现有同源前端。 |
| 来源仓库未选定许可证 | `README.md` 明示“尚未添加许可证” | 在授权澄清前可将其文档/API 行为作为需求证据；不得复制其受版权保护源码或作出可以再分发的假设。 |

### 2.3 Synapse 实施约束

- 以 `CLAUDE.md` 与 `AGENTS.md` 为架构/操作事实源：React 页面用懒加载；API 走共享 axios；后端按 routes → controllers → services → models 分层；新路由登记 route module 并配置限流器。
- 站内认证、会话、管理员角色、adminScope、审计、WAF、CSP、runtime config 与政策门禁必须复用现有实现。普通管理员的具体页面权限是运行时可配置的；未登记的管理 API 必须 fail-closed。
- 需要上传、外部 AI/上游处理或公开发布的功能，逐项登记 `src/config/featureConsent.ts`；按真实义务归类，后端也必须门禁，不能只挡前端。
- 新增/改变个人数据集时更新 `docs/governance/privacy-data-map.json`，维护 retention/delete/export/userFacing 字段，并按现有生成流程更新生成物。生成文件不得手工伪造。
- Synapse 限制本地构建、测试、lint 与依赖安装；源码文件 800 行是治理软上限，前端重依赖须 route/feature 隔离并通过 CI 预算。
- 新依赖只改对应 `package.json`，不手改锁文件；按 `AGENTS.md` 的 `Update Lockfiles` 流程由 CI 重生锁文件。

---

## 3. 用户、权限与核心流程

### 3.1 建议的目标权限模型

| 主体 | 建议能力 | 强制边界 |
|---|---|---|
| 游客 | 可打开 GeoGebra 本地工作台/示例并在本机运行；是否开放 Pixel 任务入口按登录和同意规则确定 | 不得调用用户私有项目、AI、上传、分享发布、Pixel 上游代理或管理 API。 |
| 普通 Synapse 用户 | GeoGebra 云端项目/版本；按功能同意后使用 AI、上传、分享、团队/评论；按授权 CDK 使用 Pixel 工作台、查询自己的任务 | 所有对象按服务端 `userId` 或已授权 CDK 约束；不从客户端传入的 `userId` 建立权限。Pixel 提交前显式确认账号归本人授权处理。 |
| `admin` | 按 `adminPages.ts` 与 runtime adminScope 授权的管理查看/维护能力 | 不因来源 GGGGGG 的 `trusted` 状态自动获得此角色；管理映射上游秘钥等写操作默认要求 `superadmin` 或显式授予的管理页/API 范围。 |
| `superadmin` | 管理 Pixel CDK 映射/集成配置、查看管理仪表盘、配置外部服务 | 高风险写操作经现有安全会话/审计/限流要求；秘钥不回显、不写日志。 |

> 这是建议基线，不是把所有功能一律强制登录：本地几何编辑可保留游客可用；云端能力和 Pixel 外部处理要求登录/授权/同意。后续实现如需改变此划分，先记录产品决策并同步前端路由、后端认证与政策门禁。

### 3.2 主流程

**GeoGebra 本地/云端工作流**：进入工具 → 创建/打开项目或示例 → 选择 2D/3D/Graphing/Classic 画布 → 编辑脚本并预检 → 顺序执行与查看日志 → 拖拽自由点/调参/改样式 → 保存版本/同步云端 → 可选 AI 生成或解释 → 可选分享/团队审阅/导出。

**Pixel 任务工作流**：登录并完成相关政策同意 → 阅读并确认操作提示 → 输入卡密并验证额度 → 读取服务器开关并选择可用服务 → 按格式录入账号列表并显示预估额度 → 后端完成入参校验/限流/映射/最小脱敏审计后调用经批准的固定上游 → 返回 task id → 查询/轮询状态 → 查询历史、导出结果或取消仍排队的账号 → 刷新额度与任务记录。

**Pixel 管理工作流**：Synapse 管理员会话和管理范围校验 → 管理分发 CDK 映射 → 查看筛选后的使用溯源与详情 → 调整允许在线修改的集成参数/开关 → 查看健康与运行指标。管理人员不得从 UI 或 API 读取明文上游 CDK。

---

## 4. 功能需求

### 4.1 GeoGebra 基础画布与脚本运行（GEO）

- **GEO-01 入口与模式**：在 Synapse 现有导航/工具分类内提供独立懒加载入口，不覆盖 HomeHub、TTS 或现有页面。支持平面几何、立体几何、函数图形、综合模式，并在切换模式前提示未同步拖拽点会被丢弃。
- **GEO-02 编辑器**：提供脚本编辑器、UTF-8 中文注释、行号、折叠、括号匹配、高亮和 `Ctrl/Cmd+Enter` 运行；若 Monaco 尚未安装，先核对依赖和 license，再按 Synapse 唯一依赖流程增加，禁止前端首屏同步加载重型编辑器。
- **GEO-03 预处理/安全**：支持注释/空行处理、行号保留、括号/顶层赋值基础校验、变量统计、定义/引用分析、高风险函数警告；来源限制参考（50,000 字符、5,000 条命令、30 秒执行超时）是行为基线，最终阈值应配置化/实测。输入检查只作防御纵深，不宣称是安全沙箱。
- **GEO-04 引擎生命周期**：按需初始化 GeoGebra Web API、等待 ready、在未 ready 时禁止执行、resize/重初始化/卸载清理、错误/超时重试、注册/注销更新事件。不同 applet 模式切换时必须销毁旧实例，避免全局回调和旧 canvas 泄漏。
- **GEO-05 顺序执行**：运行前默认重置画板；单条失败停止后续命令；记录每条成功/失败、时间、命令、错误行、执行总耗时及成功率；提供运行状态、进度、清空、重置。重复点击不得并发执行同一画布脚本。
- **GEO-06 画布交互**：监听用户拖动自由点而不把普通渲染事件误判为拖动；展示变更对象、原/新指令；可锁定/解锁拖动、选择部分点同步、忽略拖动；代码同时变化时显示冲突并请求确认；不能静默覆盖未保存脚本。
- **GEO-07 示例与基本操作**：保留矩形/圆、三角形中线、函数/切线、平移/旋转等示例；运行、清空、重置、PNG、GGB 文件、脚本文本导出均可用。
- **GEO-08 响应式/无障碍**：保留桌面编辑器+画布工作区、移动端编辑器/画布标签、加载/错误状态；键盘可操作、明确 aria label、focus 管理，遵守 Synapse 现有 UI 设计与 reduced-motion 规范。

### 4.2 GeoGebra 项目、版本与调参

- **GEO-09 本地项目**：游客可创建/保存/打开本地项目；元数据包括标题、文件夹、标签、收藏、画布模式、脚本、创建/修改/最后打开时间。支持最近项目（来源最多展示 6 个）的排序。浏览器存储读写必须容错，不能存认证 token 或 Pixel 账号凭据。
- **GEO-10 云端项目**：登录后列出/新建/更新/打开项目、手动同步和默认关闭的 5 分钟自动同步开关；显示同步中、成功、失败和最近同步时间。按 `ownerUserId` 服务端隔离；本地较新/云端较新/并发修改的冲突需可解释、可恢复，不得只按客户端时钟静默覆盖。
- **GEO-11 版本**：保存快照（手动、运行、参数调整、画布同步、AI 回写等 trigger）、历史列表、简单 diff 统计/样例、回滚、撤销/重做；来源最多保留 24 个版本作为默认行为，但云端保留上限/清理需由数据保留策略决定。回滚覆盖未保存更改前必须确认。
- **GEO-12 参数面板**：识别简单数字、布尔、字符串顶层赋值；提供滑块/数值框/开关/文本框；支持仅回写代码与回写+重跑。复杂表达式、未知值不误识别成可控变量。
- **GEO-13 批量样式**：支持指定全体/所选对象的颜色、线宽、点大小、标签可见、网格和坐标轴状态；不存在对象或 Applet API 不支持时有部分成功/失败反馈。
- **GEO-14 课堂讲解与演示**：把脚本命令逐条重放，支持准备、上一步、下一步、自动播放、停止；演示模式尽量隐藏编辑 UI、保留画布/重新运行/PNG/GGB/退出演示，并安全退出 fullscreen。

### 4.3 GeoGebra AI、上传、分享、团队与导出

- **GEO-15 图片转脚本**：可选上传参考图 + 提示词 + 画布模式 + `geogebra_commands_v1` + `zh-CN`，创建异步 drawing job，显示 job 状态/进度，完成时先展示场景摘要、命令、置信度/人工复核建议，再由用户确认后进入现有预检与执行流程。AI 输出不可绕过预处理与人工确认。
- **GEO-16 脚本解读/对象标注**：支持概要/关键点/标注建议/讲解步骤/讲稿；允许将概要写入注释；对象级标注支持勾选要写回的项并执行预检；对象依赖解释支持指定关注对象并显示依赖图/解释文本。每种能力都展示明确加载/失败/重试状态。
- **GEO-17 云端分享**：登录用户可发布运行后的脚本/画布模式/标题/封面，得到 slug、分享 URL 与 embed URL；支持从 `?share=<slug>` 载入、在 GeoGebra 画布执行、fork 成自己的项目；对公开可见性作明确提示。不能假设源前端已支持私密分享或浏览统计。
- **GEO-18 文件/媒体资产**：上传前检查大小、MIME、扩展名、用途、用户配额；上传凭证和真正的存储服务必须复用 Synapse 现有能力或明确设计新的目的限定资产服务，不能将任意 URL/图片字节直接写到业务 Mongo 文档。清理任务和下载权限纳入数据地图。
- **GEO-19 团队空间**：支持创建团队、成员列表/添加、项目绑定团队；角色至少保持来源已有 `admin/editor/reviewer/viewer` 语义。服务端校验邀请/添加者权限及成员角色，禁止客户端自行声明团队归属。
- **GEO-20 版本评论**：评论可关联项目版本和可选 GeoGebra 对象；支持列表、新建、标记 resolved；用户只能读取自己有权访问的项目/团队评论；评论文本按不可信输入处理。
- **GEO-21 异步导出矩阵**：支持来源 UI 中的 SVG、PDF、GIF、MP4、PPTX、GGB Bundle 选项、尺寸、网格/坐标轴选项；创建任务、查询状态、失败信息、授权下载。若某格式在目标端无法实现，须在验收表标成明确缺口并说明依赖/替代，不得保留一个不可用的 UI 按钮。

### 4.4 GeoGebra 管理与诊断

- **GEO-22 后端概览**：管理页展示服务状态、启动时间、Mongo 状态、静态资源、模型与 key 是否配置（只显示“已配置/未配置”）、worker/队列、assets/shares/jobs 计数、端点/Mongo/model P95/P99/均值/峰值、上传大小分布、最近任务/资产/分享；支持手动/自动刷新与 loading/error/空状态。
- **GEO-23 Scamalytics 适配**：保留来源的管理员配置（base URL、用户名、secret 只保存/提交不回显）及 IP 风险查询/测试模式/摘要/详情。先对照 Synapse 现有 `ipRiskService`/proxycheck 能力；如果功能语义相同则复用，不得偷偷把 Scamalytics 值写进 proxycheck 日志或改变其判定；如果必须并存，作为单独的有名 provider 适配，base URL 限制 HTTPS 与许可域名，防 SSRF，API secret 只在服务端。
- **GEO-24 权限**：该诊断入口为管理页，服务端管理权限是唯一边界；前端仅隐藏入口是不够的。涉及配置写入/第三方 IP 查询时套现有 adminScope、限流、安全会话（若当前同类敏感操作要求）和审计。

### 4.5 Pixel 用户功能

- **PIX-01 操作提示**：用户首次进入时展示服务说明和“提取链接 + 绑卡”注意事项；打开配置的操作文档后才可勾选“已阅读并确认”；可选择今天不再弹出。日级关闭记录仅为浏览器便利状态，不能替代服务端用户同意。
- **PIX-02 卡密验证/额度**：支持卡密输入和 Enter/按钮验证；展示额度；兼容 `remaining_quota`/`total_quota`/`*_units` 与旧 `remaining`/`total_count` 字段；对 `valid=false` 但仍返回历史任务可用信息的响应，允许查看历史并清晰显示验证状态。
- **PIX-03 服务选择**：保留 `link_only`、`link_and_bind`、`link_and_bind_1usd` 三种枚举、0.5/1/1.5 额度展示、`auto_bind_enabled`/`auto_bind_one_dollar_enabled` 开关及关闭提示；若选中能力被关闭，明确回退到 `link_only` 并通知用户；最终扣额以服务端/上游响应为准。
- **PIX-04 多账号提交**：每个非空输入行一个账号，输入格式 `邮箱----密码----辅助邮箱----2FA密钥`；显示账号数与预估最高额度；缺卡密/账号/服务关闭均不发请求；服务端解析并验证每行字段、行数、字段大小和重复提交。账号凭据仅在请求处理内存中短暂存在并向经批准上游传输，不持久化、不缓存、不分析。
- **PIX-05 任务状态**：提交成功后显示 task id，初始加载并每 5 秒查询详情；终态 `completed/failed/cancelled` 停止轮询；显示任务整体状态、进度、账号状态、取消数、消息、结果链接和排队位置。账号状态保留 `pending/running/success/failed/bind_pending/binding/bind_success/bind_failed/cancelled`。
- **PIX-06 历史任务**：按卡密与可选账号关键字查询；每页 10 条，首页/上一页/下一页/末页；任务状态、总账号、成功/失败/取消/时间；支持查看详情和有可导出成功账号时显示导出按钮。查询失败、空历史、空搜索结果有不同状态。
- **PIX-07 导出**：单任务和按卡密全部任务导出纯文本，每行 `email----result_link`；文件名包含 task 前缀或时间戳；仅允许已完成且有 `result_link` 的可导出状态；下载端点重新验证用户与 CDK 权限，不信任前端缓存的结果。
- **PIX-08 取消排队**：只允许对 `pending` 账号显示取消；用户确认后调用服务端；取消后刷新额度、任务详情和历史；重复/竞争取消应幂等，不能对已运行/已完成账号执行取消。
- **PIX-09 速率/失败恢复**：保留来源限流量级作为初始参考（verify/tasks 20 次/分钟、submit 10、detail 60；最终限流走 Synapse routeLimiter 定义）；上游超时/429/5xx 不暴露上游密文/栈，不伪造成功；服务端任务状态与客户端重试遵守幂等/重放策略。

### 4.6 Pixel 管理端

- **PIX-10 Synapse 原生登录**：移除来源 `/api/admin/auth/login|callback|status|logout` 与独立 `admin_sessions`；通过 Synapse 当前 HttpOnly session / API 认证和 `authenticateAdmin`、`adminScope` 保护。页面显示当前用户/角色/active 状态；会话失效清理页面敏感数据。
- **PIX-11 CDK 映射**：管理员可以创建映射（自填分发 CDK 或自动生成、必填上游 CDK、可选备注）、列出、复制分发 CDK、删除；上游 CDK AES-GCM/现有受保护配置机制加密，仅返回遮罩；分发 CDK 唯一索引，创建重复返回冲突；未使用/停用状态遵循后端真实数据，不显示无操作可触发的假按钮。
- **PIX-12 使用溯源**：按分发 CDK 过滤；默认 50，范围 1–200；展示时间、CDK 遮罩/映射命中、方法/路径、客户端基础信息、服务类型、账号数、请求/响应体大小、状态和耗时；详情只显示脱敏摘要、错误类别与必要的调用上下文。不能显示完整请求体、密码、辅助邮箱、TOTP、完整结果链接或上游密钥。
- **PIX-13 运行时配置**：按核心/上游/安全/OAuth 等来源分组显示 effective value、来源（容器默认/数据库覆盖）、是否已覆盖、热更新/需重启/bootstrap；提供允许字段保存与恢复默认。Synapse 内不实现第二套 OAuth 配置。Mongo URI、数据库名、主密钥、签名/加密材料等禁止在该页面动态改写。
- **PIX-14 管理总览**：整合必要的 proxy/worker/queue/upstream 状态、任务/错误/延迟/请求大小等运行指标；如不存在可验证的数据源，显示“无数据/未配置”，不得虚构或从其它 Synapse 模块拼出误导数字。

---

## 5. 目标架构与 API 契约建议

### 5.1 架构落位

- **前端**：Synapse `frontend/src/App.tsx` 懒加载用户侧 GeoGebra 与 Pixel 页面；沿用现有 Navigation/HomeHub/工具分组、`frontend/src/api/api.ts`、store、design tokens、错误/处罚态显示。页面、hooks、纯函数、API 客户端按域拆分，避免复制来源单文件主组件。
- **服务端**：Express + TypeScript。用户侧 API 走新 route modules + routeLimiter + controller + service + Mongoose model；管理接口在 admin route/module 注册，使用现有管理员范围守卫；所有自定义业务 HTTP 请求通过既有审计/错误/安全流水线。
- **认证**：不实现新 OAuth Provider/client 回调，不把 token 放 localStorage；UI 从 Synapse 当前 auth store/API 获取身份，后端每次受保护请求使用现有 session 校验。来源 GGGGGG OAuth 仅说明其独立部署接 Synapse 的方式，不能复制成 Synapse 内部自循环登录。
- **AI/异步任务**：优先评估 Synapse 现有 TTS/media/doc-tool 队列存储与租约/看门狗模式是否适合通用 AI/export job；若不适合，新增小型、域隔离服务。不要把任务都塞进 TTS 队列或只依赖进程内 timer。任务拥有者、幂等键、重试数、状态、到期/清理必须明确。
- **文件**：优先复用已存在并符合用途/配额/访问控制的 Synapse 上传能力；不符合时建立 purpose-scoped service。禁止把 GeoGebra 图片、封面或导出文件不受控地放 MongoDB 文档。
- **数据**：MongoDB 是事实源；collection 名、字段、索引、TTL 需检查现有 `src/models/` 和存储责任报告后决定。不要重复创建已有 workspaces、users、audit、policy consent、assets 或 job 能力。
- **外部上游**：Pixel 路由只允许列举的业务端点/方法，使用固定服务器配置的 HTTPS host，关闭自动重定向；不允许用户传入任意 upstream URL，不做任意 header/response header 全量透传，不暴露上游 host/credentials。保留原始 API 行为所需的请求/响应头必须逐项审查。

### 5.2 推荐目标路由（实现前须搜索冲突并按 Synapse 现有惯例调整）

以下是域隔离建议，不是声称当前 Synapse 已有端点：

| 领域 | 建议路由形状 |
|---|---|
| GeoGebra 项目/版本 | `/api/geogebra/projects`, `/api/geogebra/projects/:projectId`, `/api/geogebra/projects/:projectId/versions` |
| GeoGebra 团队/评论 | `/api/geogebra/teams`, `/api/geogebra/teams/:teamId/members`, `/api/geogebra/review-comments` |
| GeoGebra assets/AI | `/api/geogebra/assets/uploads`, `/api/geogebra/ai/drawing-jobs`, `/api/geogebra/ai/script-insights`, `/api/geogebra/ai/annotation-jobs`, `/api/geogebra/ai/object-explanations` |
| GeoGebra 分享/导出 | `/api/geogebra/shares`, `/api/geogebra/shares/:slug`, `/api/geogebra/exports`, `/api/geogebra/exports/:exportJobId` |
| Pixel 用户任务 | `/api/pixel/settings`, `/api/pixel/verify-card`, `/api/pixel/submit-task`, `/api/pixel/tasks/:taskId`, `/api/pixel/tasks-by-card`, `/api/pixel/tasks/export-by-card`, `/api/pixel/tasks/:taskId/accounts/:accountId/cancel-queue` |
| Pixel 管理 | `/api/admin/pixel/cdks`, `/api/admin/pixel/cdks/:id`, `/api/admin/pixel/cdk-usage`, `/api/admin/pixel/cdk-usage/:id`, `/api/admin/pixel/configs`, `/api/admin/pixel/dashboard` |

- 所有端点需在目标当前 OpenAPI 注释/生成工作流里登记；错误契约要兼容 Synapse 当前统一错误格式和处罚码。
- Pixel 用户端不得保留裸 `/api/submit-task`、`/api/task/:id` 等容易与现有服务冲突的命名；必须经过来源校验、配额/限流、政策门禁和用户授权后再转上游。
- 只有确有需要才暴露敏感操作路径；不通过 `adminRoutes` 路径前缀猜测权限，按实际页面和 API 建立准确 `adminPages.apiPrefixes`。

### 5.3 建议数据实体（均为待核对的逻辑实体，不要求一对一照抄来源表）

| 实体 | 最低字段/约束 | 不得保存/注意 |
|---|---|---|
| GeoGebra project | `ownerUserId`、可选 `teamId`、标题/文件夹/标签/收藏、`canvasMode`、脚本、时间戳、latestVersion | 所有查询带 owner/team 权限过滤；公用分享用独立实体，不把公开权限隐含在项目记录。 |
| GeoGebra version | `projectId`、`ownerUserId`、version id、label、code、mode、trigger、summary、createdAt | 上限与 TTL 按产品/数据保留决策，不从来源的本地 24 个缓存限制推导云端永久保留。 |
| GeoGebra share | 唯一 slug、作者、项目/版本快照、命令、画布模式、封面 asset、visibility、allowFork、createdAt | 输出脚本/评论均是不可信输入；撤销/删除后公开 URL 立即失效；不记录访客 PII 除非有依据并告知。 |
| GeoGebra job/export | jobId、ownerUserId、job type、状态、幂等键、输入 asset/project refs、进度、错误 code、输出 asset/下载授权、lease/expiry | 不把上传原文、完整命令、账号凭据放进普通日志；敏感输入到期清理。 |
| Pixel CDK mapping | 唯一分发 CDK、加密上游 CDK、备注、启用状态、创建/更新时间/操作者 | 明文上游 CDK 不从服务端返回、日志/审计/异常不出现；密钥轮换/旧密文迁移单列方案。 |
| Pixel task access | Synapse `userId`、上游 task id、CDK 映射/授权引用、创建时间、最少必要状态 | 不存账号原始行、password、recovery、2FA/TOTP、完整 result link；用户只能访问拥有/授权的任务。 |
| Pixel usage log | request id、映射 ID、masked CDK、method/path、结果状态、时延、计数、有限摘要、createdAt/TTL | 默认不保存原始 IP/UA/query/body/response。若安全审计确有需要，逐字段说明、脱敏、时间限制和用户告知。 |
| Runtime config | 白名单 key、加密 value、更新人/时间、来源标记 | 唯一键索引；bootstrap-only keys 禁改；敏感值只返回 `configured/masked` 元数据。 |

> 具体 schema、集合名和索引必须由实现者先搜索 Synapse 当前 models/collections 与已有 owner/workspace/job/audit 语义再确定；以上不是要求复制 Rust struct 的数据库布局。

---

## 6. 安全、隐私、合规与外部依赖硬性要求

### 6.1 Pixel 账号凭据与上游调用

1. 每次把账号信息交给上游前，展示明确服务名称、处理目的、接收方、必填字段、额度/计费、可能的账号/支付后果与停止方式；按 Synapse `account-credential` 门禁要求用户同意 `terms + specific-terms`，后端接口本身也强制检查。
2. 仅允许提交用户本人或已获授权管理的账号。不得增加批量撞库、凭据校验/筛选、绕过验证、抢占他人账号或扩大上游操作范围的功能。
3. 账号输入只驻留请求内存；上游必须 HTTPS；请求体不能进入 access log、Winston、全站 `auditLog` payload、错误上报、分析事件、队列 payload 持久化或前端 localStorage。审计只记录经验证的必要摘要（例如账号数/字段是否存在），默认不记邮件地址。
4. 上游响应中有密码/验证码/完整邮箱/结果链接时，不允许在通用代理异常、response summary、前端日志、管理员溯源详情或公开监控里出现；错误信息按 allowlist/字段级遮罩处理。
5. 上游不可用、超时、5xx、429、解析异常时不得伪造“成功”、错误扣额或重复提交；请求幂等键/上游任务状态映射、取消竞态、额度最终一致性要有实现与测试证据。
6. CDK 映射值用 Synapse 已审查的加密存储机制，密钥受 `protectedEnvKeys`/安全会话和主密钥派生规则保护；绝不把 AES_KEY、client secret 或上游 CDK 输出到 API。
7. 运行时上游 URL 仅允许超级管理员设置，校验 HTTPS、hostname allowlist、DNS/IP 私网和重定向策略；防 SSRF、DNS rebinding、内网探测和任意代理。若只能连接一个固定供应商，优先固定允许域名而不是开放任意 URL。
8. 对用户提供的账号/服务使用说明不从固定外部文档 URL 的硬编码跳转开始；先确认来源说明仍有效，再放入受管理的配置或 Synapse 内容页，允许管理员更新并有审计。

### 6.2 GeoGebra、AI、分享与上传

- GeoGebra 本地脚本运行是用户输入的不可信内容；限制代码大小/执行时间/命令量，对象标签、日志、AI 输出和分享脚本均按不可信文本渲染，禁止 `dangerouslySetInnerHTML`。
- CDN/GeoGebra Web API 的域名、脚本注入方式、CSP、许可与官方 API 使用条件需实现前核实；只为功能加最小范围 CSP，不全局扩大 `script-src`/`connect-src`。
- 上传图片/封面属于 `content-upload`；图片交第三方 AI 属 `third-party-transfer`；生成公开分享属 `content-publish`。分别按 `featureConsent.ts` 细分 key，用户撤回后 API 立即拒绝后续操作。
- AI 只在服务端调用已配置 provider；模型名/密钥不硬编码在客户端。脚本生成结果先做结构与长度校验，再给用户预览，最后走同一 GeoGebra 执行验证；错误不得将供应商凭证或上传 URL 泄露到 UI。
- 分享 slug 必须足够不可猜测；公开页面仅返回分享授权的字段；对撤销、删除、重新 fork、外链封面和无效/过期 asset 定义行为与缓存策略。
- 团队成员角色服务端校验；用户无法仅靠传 `teamId`、`projectId`、`commentId` 或 `assetId` 访问他人数据；评论、标题、标签、项目脚本输出按 XSS/注入威胁处理。

### 6.3 Synapse 既有闸门

- 按 `AGENTS.md` 的路由注册、限流、认证、测试树、开源依赖通路实施；不得改乱 `src/app/assembly.ts` 中安全层顺序。
- 每个新 API 端点有 routeLimiter，管理 API 有身份+adminScope 双校验；页面入口隐藏不是授权控制。
- 先确认目标功能是否需要 `requireFeatureConsent()`，更新 `FEATURE_CONSENT_KEYS`、`FEATURE_CONSENT_REQUIREMENTS`、分类映射与配置自检测试；不要只加前端弹窗。
- 更新 privacy data map 的个人数据、目的、接收方、保留期、删除/导出路径、用户可见说明及证据路径；运行/生成/漂移判据交给 CI。
- 代码分拆满足 Synapse file-size 与 bundle budget；monaco/GeoGebra、AI/export 格式等重依赖路由懒加载/动态加载。

---

## 7. 迁移映射与不可照搬项

| 来源做法 | Synapse 目标做法 |
|---|---|
| `geograba` standalone OAuth，自持 access/refresh token 于 localStorage | 使用 Synapse 本地 HttpOnly cookie/session 和现有 auth store；不复制 token 到 localStorage、不创建新 OAuth client flow。 |
| `geograba` 5,000+ 行 `App.jsx` 管多个领域 | 拆成懒加载页面、按域组件、hooks/services、API 客户端和纯函数；页面组件目标遵守 Synapse 800 行软限制。 |
| `geograba` 前端直接使用 `/api/v1/*` 自定义 backend contract | 迁移为 Synapse route/controller/service/model 和 OpenAPI 契约；先列缺口，不把 API 客户端当后端现状。 |
| `geograba` 浏览器项目/会话和 `X-Workspace-Key` | 游客本地数据可用浏览器存储；用户云数据改用 Synapse userId/workspace 权限。不能把浏览器 workspace key 当身份/授权凭证。 |
| `geograba` Scamalytics 第三方 API 配置 | 与 Synapse 当前 proxycheck/IP 风险产品能力比对；同义则复用，不同义才独立 provider；管理员专属，密钥服务端加密，限制出站。 |
| GGGGGG 的 Rust Axum app + `pixel_remake` 数据库 + 独立 `admin_sessions` | 迁移业务逻辑到 Synapse Node/Express/Mongoose；复用 Synapse Mongo 连接、会话、权限、runtime config、审计。 |
| GGGGGG 独立 Synapse OAuth callback/cookie | 删除这套重复会话；用当前 Synapse 用户会话，不保留 `/api/admin/auth/*` 自我回跳。 |
| GGGGGG `/api/{*path}` 通用透传 | 仅允许通过路由 allowlist 的业务端点/方法；规范化 URL、固定上游、逐项转发必要头、禁止任意响应头/重定向。 |
| GGGGGG `cdk_usage_logs` 对账号文本与响应做摘要 | 保留“可诊断溯源”的价值，收窄为数据最小化，不让邮箱、链接、密码、TOTP 进入持久化审计正文。 |
| GGGGGG `app_configs` 自定义 secret/默认值目录 | 复用 Synapse `runtimeConfigService`、env-manager、加密/保护字段策略；不要新建并行配置体系。 |
| 来源的 success/status JSON 形状 | 在 Synapse 使用其 API 错误/分页/认证约定；若外部上游契约必须保留，则仅在 Pixel adapter 内做转换。 |
| 来源 CSS/品牌/分析与第三方监控 | 使用 Synapse `studioTheme` 与布局规范；不复制 Vercel Analytics/外部追踪；分析需重新评估隐私与首屏预算。 |

---

## 8. 实施阶段（全量范围，分批交付）

> 以下是降低风险的交付顺序，不是砍范围。每个阶段完成后更新本文件的状态与 CI 证据；没有证据的功能不能标记完成。

### Phase 0 — 代码库与授权核查

- 检查 Synapse 当前路由、页面导航、store/API、Mongo models、runtime config、upload/queue/AI/export、policy consent、privacy data map、adminPages、CSP、OpenAPI 生成与 CI 脚本。
- 搜索各来源功能是否在 Synapse 已存在；给每一项标记“复用 / 适配 / 新增 / 不适用及理由”，禁止重复造轮子。
- 核实 GeoGebra API/CDN 可用性、许可和 CSP 要求；核实 Pixel 上游服务的归属/授权、正式 API、是否会保存或再处理原始账号凭据、数据跨境与条款；核实 GGGGGG 源码许可。没有授权时不能复制其源码或上线敏感上游功能。
- 固化数据分类/保留/删除/export 和运营开关；决定未知 CDK 是否可直通上游（推荐默认 fail-closed，除非产品/供应商明确允许）。

### Phase 1 — GeoGebra 本地工作台

- 路由/懒加载、GeoGebra applet lifecycle、四模式、编辑器、预处理/验证/执行、日志、模板、基本控件、自由点同步、PNG/GGB/脚本文本导出。
- 完成关键纯函数单测与浏览器状态/销毁/切换冒烟规格。

### Phase 2 — GeoGebra 项目/协作

- 本地项目、云项目/版本/同步、团队成员、版本评论、分享/载入/fork、资产权限/清理；实现 owner/team 授权、数据地图、consent 和删除路径。

### Phase 3 — GeoGebra AI/导出/管理

- 上传凭证、AI drawing/insight/annotation/object explanation jobs、异步 export formats、管理仪表盘、Scamalytics 适配（经审核后）。
- 加 job idempotency、owner checks、queue watchdog/retention、错误恢复与配额。

### Phase 4 — Pixel 工作台和服务端代理

- 卡密验证/额度、服务开关、账号任务提交、轮询/历史/导出/取消、透明提示与状态。
- 先固定上游 URL/端点 allowlist/权限，再实现 CDK 映射替换、加密、限流、脱敏溯源、TTL 与上游故障语义。
- 账号凭据处理门禁、用户授权记录、日志/审计/analytics 禁止采集原文作为合并阻断测试。

### Phase 5 — Pixel 管理、上线/回退准备

- Synapse 原生权限下的 CDK mappings、usage logs、runtime config 与 dashboard；管理页登记、adminScope、审计、安全会话。
- 更新 OpenAPI 注释/生成物、隐私数据地图、用户指南与运维文档；完成 CI；评估关闭 feature flags 和回滚数据/索引/密钥方案。

---

## 9. 验收标准

### 9.1 GeoGebra

- [ ] 四种画布模式可初始化、切换、resize、清理，网络失败/超时可见并可重试；离开页面后无重复 applet、遗留 listener 或全局回调污染。
- [ ] 样例、语法校验、运行/停止行为、执行报告、单条失败中止、Ctrl/Cmd+Enter、清空/重置、日志与统计均可用。
- [ ] 手动拖拽自由点可被准确识别；选择性同步保留注释且不覆盖其他代码；冲突确认/丢弃/锁定均有测试。
- [ ] PNG/GGB/文本导出生成可打开文件；导出失败显示可恢复错误。
- [ ] 数字/布尔/字符串参数正确映射；应用但不运行、应用并运行结果一致。
- [ ] 批量样式对全体/选中对象生效；讲解前进后退/自动播放停止；演示模式退出后回到正确编辑状态。
- [ ] 游客本地项目和登录用户云项目互不混淆；跨账户切换/登出不泄漏数据；版本回滚/比较/同步冲突行为有测试。
- [ ] 用户无法横向读取/修改他人项目、团队、评论、asset、job、export；公开分享只返回已授权字段，撤销后访问失效。
- [ ] AI/图片/导出任务全链路能显示 queued/running/completed/failed/expired 等状态；重试不会重复收费/重复创建；生成命令必须过预检。
- [ ] 所有源 UI 的 AI、对象标注、对象依赖解释、分享/Embed、团队/评论、异步格式导出都有对应后端实现或在验收矩阵解释明确替代；不留假按钮。
- [ ] 管理员指标不含秘密/PII，Scamalytics 若启用不会混写到 proxycheck 语义中；普通用户所有管理 API 均拒绝。

### 9.2 Pixel

- [ ] 卡密验证支持新/旧额度字段与 valid-but-history 状态；卡密错误、配额为零、历史不可用均有清晰状态。
- [ ] 服务选项与开关一致，估算与实际扣额不混淆；后台关闭服务时前后端都拒绝。
- [ ] 账号文本服务端校验、最大行/大小限制、一次性确认、请求超时/重试和幂等语义明确；双击/网络重试不重复提交/扣费。
- [ ] 任务轮询只在非终态继续；状态枚举全覆盖；进度与 cancelled 数一致；轮询失败可手动重试。
- [ ] 历史模糊搜索、分页、单条/全部导出、只取消 pending、取消后额度刷新均可用；越权查询他人 task 返回拒绝。
- [ ] admin CDK 唯一性、创建/自动生成/删除、遮罩、加密、copy、filter/trace/detail 端到端可用；删除映射后的未决任务按明确定义处理。
- [ ] runtime config 对热更新/重启/Bootstrap 分类正确；秘密只写入、不能读取原文；Mongo URI/主密钥等受保护字段不能在线改。
- [ ] 任何请求/response/log/audit/trace/test snapshot 中均不出现密码、辅助邮箱、2FA/TOTP、完整 CDK/上游 CDK、完整账号文本或敏感 result link。
- [ ] 未登录、缺政策同意、权限不足、rate limited、无 mapping、上游 4xx/429/5xx/timeout、Mongo unavailable、用户撤销同意等分支均有明确行为和测试。

### 9.3 Synapse 项目级

- [ ] 新页面懒加载；首屏 bundle 预算不回退；没有把 GeoGebra/Monaco/导出大库静态导入 App 壳。
- [ ] 新 routes 在正确 routeModule 注册且每个端点有且仅有合适 limiter；认证、adminScope、featureConsent、audit 的顺序符合现有 assembly 设计。
- [ ] `openapi.json` 与路由注释/generated contract 无漂移；`adminPages` 和 adminModules 与实际页面/API 前缀一致；未知权限 fail-closed。
- [ ] 隐私 data map 有所有新增集合/本地状态/外发方/保留/删除/export 信息，并由 CI 检查生成物一致；账号凭据从不作为可导出“用户数据副本”持久化。
- [ ] 新代码遵守 TS/React 规范、源文件限制、dependency policy 和测试目录；CI 中 Node Verification、Quality Guardrails、CodeQL、Docker 等相关 job 的真实步骤结论符合目标。`skipped` 不等同通过，`continue-on-error` 不等于门禁通过。
- [ ] GitHub Actions 是唯一 build/test/lint 裁判；本地不安装依赖、不构建、不跑测试。

---

## 10. 后续实现代理提示词（复制以下全文执行）

```text
你正在 F:\Repositories\GitHub\Synapse 仓库工作。目标是把产品需求文件
`docs/plans/2026-10-16-geograba-gggggg-synapse-integration-prd-prompt.md`
定义的 geograba（GeoGebra Script Lab）和 GGGGGG（Pixel 自助折扣链接系统）全部既有功能，原生集成进 Synapse。
目标仓库只有 Synapse；不要在 geograba 或 GGGGGG 改代码，不要另建站点、Rust sidecar、第二个 MongoDB 或新监听端口。

执行前先阅读 Synapse/CLAUDE.md、AGENTS.md、本需求文档、docs/governance/repository-governance.md，并确认当前分支与完整 git status；禁止吞入其他会话的 WIP。阅读目标路由注册、中间件顺序、鉴权/会话、adminScope、runtimeConfig、featureConsent、privacy-data-map、models、队列、上传、CSP、OpenAPI、前端 API/nav/design system 和 CI workflow。再逐项阅读来源仓库相关文件；需求文档的源文件行号用于定位，不取代对当前源码的核实。

范围要求：
1. 全量完成需求中的 GEO-01…GEO-24 和 PIX-01…PIX-14；按 Phase 0→5 分批实施、每批小而完整，但不能把暂时未实现的功能标为完成或从最终范围删掉。若遇授权/法律/供应商 API/功能不可用阻断项，先完成其余不依赖项，将阻断项和证据写入本需求文档，不猜接口、不绕过安全闸门。
2. 严格区分：geograba 是前端代码/部分服务接口契约，不带服务端；GGGGGG 的 OpenAPI 是从公开页面重建的草案，其 Rust 后端是独立代理；商业化优先级只是设想。先从真实调用和服务端实现确认功能，不把文档/常量包装成已经落地的后端。
3. GGGGGG README 说明尚无项目 license；在获得明确许可之前，不复制 GGGGGG 受版权保护代码。可按本需求的行为/API契约在 Synapse 中重新实现。核实 geograba 实际 license 和 GeoGebra API/脚本许可后再复用其代码/资源。
4. 不能让 Pixel 工作台收集/持久化用户密码、辅助邮箱、2FA/TOTP、原始账号输入、完整 upstream CDK 或敏感 result link。必须落实授权用途提示、account-credential feature consent（terms + specific-terms）、后端限流/入参限制、固定 HTTPS 上游 allowlist、每用户/授权卡访问边界、敏感日志清零测试、任务幂等和删除/保留策略。账号只能是用户本人或明确授权处理的账号；不增加凭据测试、撞库、绕过验证等行为。
5. 本项目原生登录用 Synapse HttpOnly session/API auth；删除/不建立 GGGGGG admin OAuth 自回环、localStorage token 或独立 admin_sessions。管理员用现有 adminScope/adminPages；上游 CDK/config 写权限默认 superadmin，若要授予 admin，必须补精确 apiPrefixes 与服务端测试，不得依赖前端隐藏或 trusted 字段近似授权。
6. GeoGebra 代码/AI 输出/分享按不可信内容处理；AI 仅服务端调用现有 provider，输出经 schema/长度验证、预览和现有脚本预检后再执行。图片/AI/公开分享分别按实际数据分类接 featureConsent 与 privacy-data-map。不要把 Scamalytics 与 Synapse proxycheck 混作同一信号。
7. 复用 Synapse Express/TypeScript、单 Mongo 连接、共享 axios、Mongoose、runtime config、route modules、audit/error/policy/CSP/queue 等；先查是否已有等价实体/服务。候选 API route 仅是建议，需做 collision 搜索后定名并更新 generated OpenAPI。不要保留 `/api/{*path}` 开放代理。
8. 页面 lazy load；按功能拆组件/API/hooks/services/models，不写 mega-file；heavy Monaco/GeoGebra/导出库隔离；遵守 studioTheme、无障碍、移动端触控、reduced motion 和 bundle budget。
9. 更新 data map 中的数据类别、收集目的、接收方、Retention/Deletion/Export/userFacing/evidence；维护 FeatureConsent categories/requirements/keys 和配置自检测试；维护 adminPages/adminModules、限流、API文档、用户文档及回滚方案。生成文件只走指定脚本/CI，不手改伪造生成结果。

交付步骤：
A. 先做只读现状核查，给本需求每条 ID 标记复用/适配/新增/阻断；核查外部上游授权、准确 API 与 GeoGebra/源码 license。记录发现到本 PRD 的 implementation status，不得先动架构代码。
B. 明确对上游未命中 CDK 的处理、Pixel 登录与授权策略、GeoGebra 外部脚本许可、AI provider/上传后端/项目协作是否已有现成能力等关键决策。可以由代码/官方文档核实的自己核实；真正需要产品批准的逐项列出并建议安全默认，其他工作继续做。
C. 以小 PR 批次实现：基础 GeoGebra 本地工作台 → 项目/版本/协作/分享 → AI/上传/异步导出/管理诊断 → Pixel 用户代理/任务 → Pixel 管理/溯源/配置 → 隐私/安全/CI 收尾。每批修改后核对 git diff 和显式文件清单；只覆盖自己改动。
D. 对每类行为添加纯函数/服务/路由/前端/集成测试。测试替身也必须匹配真实代码契约；写断言证明权限拒绝、跨用户隔离、撤回 consent 即时生效、上游失败/重试幂等、额度与取消回补、敏感字段日志不存在、public share 删除失效、队列任务到期和下载授权。不能删除/放宽原有测试来制造绿灯。
E. 本机禁止 pnpm install、构建、测试、lint；依赖只改 package.json，不手改 pnpm-lock.yaml。提交后用项目唯一通路由 GitHub Actions 更新 lockfile（如需要），并以 GitHub Actions 的真 job/step/check-runs 为验证来源；检查 `skipped`、`continue-on-error`、advisory 和未运行测试，不能仅看绿色 job 或 combined status。
F. 遵循 AGENTS.md：显式 git add 文件；提交 GPG 签名并校验 `%G?` 为 G；push 使用 `GIT_TERMINAL_PROMPT=0`；提交/推送前核实暂存区只含本任务文件。不要提交 `.env`、secrets、keystore、签名脚本或凭据。除仓库 rules 强制且已授权的范围外不触发部署/修改外部服务。
G. 最终逐 ID 更新本 PRD 状态（实现/验证 CI run/未完成及阻断证据），列出 API/数据模型/权限/同意/隐私变更、相关 CI jobs/steps、仍未解决的决定和回滚方式。只有真实达到验收标准的条目才能勾选完成。

禁止：本地构建/测试/lint/装依赖；复制无许可源码；添加 open proxy；将账号凭据写入持久化、localStorage、审计或日志；前端单独鉴权；默认授权 trusted/admin；弱化 fail-closed、限流、policy consent、测试或隐私数据地图；把营销设想算作用户要求；把 CI skipped/advisory 当成已验证；将未实现功能隐藏后宣称“全量合并完成”。
```

---

## 11. 实现状态记录模板

> 后续实现时逐批更新此处；当前全部留空，表示尚未在 Synapse 实现/验收。

| 功能域 | 状态（未开始/进行中/完成/阻断） | PR/commit | CI run 与真实 job/step 结论 | 未完成/阻断证据 |
|---|---|---|---|---|
| Phase 0：现状、授权、API、license | 未开始 | — | — | — |
| GeoGebra 本地工作台（GEO-01…08） | 未开始 | — | — | — |
| GeoGebra 项目与版本（GEO-09…14） | 未开始 | — | — | — |
| GeoGebra AI/资产/协作/分享/导出（GEO-15…21） | 未开始 | — | — | — |
| GeoGebra 管理/诊断（GEO-22…24） | 未开始 | — | — | — |
| Pixel 用户工作台（PIX-01…09） | 未开始 | — | — | — |
| Pixel 管理端（PIX-10…14） | 未开始 | — | — | — |
| 安全、隐私、OpenAPI、CI、回滚 | 未开始 | — | — | — |

---

## 12. 参考文件

### 来源仓库

- `geograba/README.md`
- `geograba/src/components/App.jsx`
- `geograba/src/engine/GeoGebraEngine.js`
- `geograba/src/engine/Preprocessor.js`
- `geograba/src/engine/Dispatcher.js`
- `geograba/src/utils/studio.js`
- `geograba/src/api/backend.js`
- `GGGGGG/README.md`
- `GGGGGG/docs/pixel-site-spec.md`
- `GGGGGG/docs/openapi.yaml`
- `GGGGGG/docs/synapse-oauth-integration.md`
- `GGGGGG/frontend/src/App.tsx`
- `GGGGGG/backend/src/{main,admin,config_admin,oauth,proxy,models}.rs`

### Synapse

- `CLAUDE.md`、`AGENTS.md`
- `docs/governance/repository-governance.md`
- `docs/governance/privacy-data-map.json`
- `src/config/featureConsent.ts`
- `src/config/adminPages.ts`
- `src/app/assembly.ts`
- `frontend/src/App.tsx`
- `frontend/src/api/api.ts`
- `src/middleware/routeLimiters.ts`
- `src/services/runtimeConfigService.ts`
- `docs/plans/2026-10-11-lottery-platform-prd.md`（PRD/分阶段追踪格式参考）
