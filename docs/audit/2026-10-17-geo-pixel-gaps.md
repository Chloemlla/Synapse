# GeoGebra / Pixel 代码缺口落地记录（2026-10-17）

> 依据：`docs/audit/2026-10-17-october-plans-conformance.md` §5（GEO-11/16/17/22、PIX-13/14、GEO-G6）。
> 本轮只做代码与测试，不改 `docs/plans/*`、`10-10.md`、conformance 报告、运行时配置默认值/服务、
> 隐私地图生成物、`adminPages` 配置。未运行构建/测试/lint/安装依赖，未执行任何写 git 操作。
>
> 环境说明：核查/编辑期间工作树里 `src/services/registrationRiskService.ts` 也有他人改动（非本轮产生）；
> 本轮未触碰该文件。

---

## 1. GEO-11 云端版本保留上限

**改动位置**

| 文件 | 内容 |
|---|---|
| `src/geogebra/projectService.ts` | 新增 `DEFAULT_GEOGEBRA_VERSION_RETENTION = 24`、`geoGebraVersionRetentionLimit()`（env `GEOGEBRA_VERSION_RETENTION_LIMIT`，钳制 1..500）、`pruneGeoGebraVersions(projectId, limit)`；`createGeoGebraVersion()` 在落库后调用裁剪 |
| `src/tests/geogebraVersionRetention.test.ts`（新） | 默认 24、env 覆盖与钳制、按最旧裁剪、跳过评论引用、全部被引用时不删、创建后触发裁剪 |

**口径（已写进代码注释）**

- 仓库没有 GeoGebra 版本级 legal hold（只有账号级 Pixel 取证保全），因此按**项目内最旧**裁剪；
- **被评论引用的版本不删除**：`GeoGebraReviewCommentModel.distinct("versionId", …)` 过滤，宁可临时超限也不制造悬空引用；
- 裁剪为硬删除（与 `deleteGeoGebraProject` 删除私有历史同口径），否则存储仍无界增长；
- 裁剪失败不回滚已创建的版本（`catch(() => undefined)`），下一轮创建继续收敛。

**验证点**

- 创建第 N+1 个版本后，`geogebra_project_versions` 中该项目最多保留 N 条（N 默认 24）；
- 被评论引用的旧版本仍在，且 `pruneGeoGebraVersions` 返回 `{removed, protected}` 计数；
- `GEOGEBRA_VERSION_RETENTION_LIMIT=0` 被钳成 1（不会删光），非法值回落 24。

---

## 2. GEO-17 embed URL + 嵌入壳 + `?share=<slug>`

**改动位置**

| 文件 | 内容 |
|---|---|
| `src/geogebra/shareService.ts` | `shareView()` 新增 `embedUrl: "/geogebra/share/<slug>?embed=1"`；撤销/软删除后返回 `null`（不给出必然 404 的链接） |
| `frontend/src/components/geogebra/embed.ts`（新） | `geoGebraShareUrl` / `geoGebraShareEmbedUrl` / `resolveGeoGebraEmbedUrl`：优先用服务端相对 `embedUrl` 并补全为绝对地址，缺失或不可解析时本地推导 |
| `frontend/src/components/geogebra/GeoGebraSharePanel.tsx` | 分享条目显示 embed 地址，新增「复制嵌入」按钮；普通复制改用同一 helper |
| `frontend/src/components/geogebra/GeoGebraSharePage.tsx` | 新增 `embedded?: boolean`；嵌入模式隐藏复制/登录/fork，只保留画布与导出 |
| `frontend/src/components/geogebra/GeoGebraEmbedShell.tsx`（新） | 只读嵌入壳，复用 `GeoGebraSharePage embedded`，不引入第二套画布 |
| `frontend/src/App.tsx` | 新增懒加载 `GeoGebraEmbedShell`；`/geogebra/share/:slug?embed=1` 走独立分支，不渲染 DesktopShell/MobileNav/Footer；首访验证闸门对**未封禁**的嵌入访问豁免（否则 iframe 内会被 CAPTCHA 挡住），IP 封禁仍然生效 |
| `frontend/src/components/geogebra/GeoGebraPage.tsx` | 读取 `?share=<slug>`，校验 `^[a-z0-9-]{10,100}$` 后 `navigate(..., {replace:true})` 到只读分享页 |
| `frontend/src/tests/geogebraShareEmbed.test.tsx`（新） | URL 口径、slug 编码、服务端相对地址补全、坏值回落 |
| `src/tests/geogebraShareRevoke.test.ts`（新） | `embedUrl` 契约 + 撤销后 getShare/cover/fork 全 404 |

**验证点**

- 发布响应与分享列表都带 `embedUrl`；面板可复制绝对 embed 地址；
- 打开 `/geogebra/share/<slug>?embed=1` 时页面无站点导航/页脚，且不显示 fork/登录按钮；
- 打开 `/geogebra?share=<slug>` 会落到 `/geogebra/share/<slug>`；
- 撤销后 `embedUrl` 为 null，分享页/封面/fork 均 404。

---

## 3. GEO-16 AI 概要写入评论

**改动位置**

| 文件 | 内容 |
|---|---|
| `frontend/src/components/geogebra/GeoGebraAiPanel.tsx` | 结果区新增「写入评论」按钮；`handleWriteSummaryComment()` 调用 `createGeoGebraComment({projectId, body: summary.slice(0,4000)})`；仅用户点击触发（无 effect），写入中禁用，失败走 `StudioErrorNote`，成功显示状态文案。仅云端项目（`cloudRevision`）可写，本地草稿给出说明 |

**验证点**

- 生成结果没有自动写评论（无 effect/自动调用）；
- 点击后评论出现在 `GeoGebraCommentsPanel` 列表（同一 projectId）；
- 无权限/失败时按钮恢复且错误可见。

---

## 4. GEO-22 管理诊断补 worker/队列、静态资源、最近资产

**改动位置**

| 文件 | 内容 |
|---|---|
| `src/geogebra/jobService.ts` | 新增 `getGeoGebraJobRunnerStatus()`：`scheduler/running/pid/tickMs/leaseMs/maxActiveJobsPerUser`（只报可核对事实，不造「空闲 worker 数」） |
| `src/geogebra/adminDiagnosticsService.ts` | 新增 `worker`、`queue`（queued/running/totalActive/单用户并发上限/租约）、`staticAssets`（分享封面数、AI 参考图与导出包的 count/bytes；不回显磁盘路径）、`recentAssets`（最近 10 条，owner 短哈希，不含 storageKey）；原有延迟/体积分位仍为显式 `null + unavailableReason` |
| `src/routes/admin/geogebra.ts` | 无需改动（仍返回整个诊断对象） |

**验证点**

- `GET /api/admin/geogebra/overview` 返回 `worker.scheduler === "in-process"`、`queue.queued/running` 与 Mongo 真实计数一致；
- `staticAssets.aiReferenceAssets` / `exportBundles` 来自 `$group` 聚合，`recentAssets` 条数 ≤10 且无存储键；
- 无数据源的分位指标仍为 `null`，不出现编造数值。

---

## 5. PIX-13 运行时配置：来源/覆盖/热更 + 恢复默认 + 受保护字段

**改动位置**

| 文件 | 内容 |
|---|---|
| `src/pixel/types.ts` | `PixelIntegrationConfigView` 增 `source: "db"|"env"|"default"`、`overridden`、`reload: "runtime"|"restart"`；新增错误/延迟/大小指标类型与 dashboard 的 `runtime`、`metrics` 区块 |
| `src/pixel/integrationConfigService.ts` | 读取来源优先级 **db > env > default**；`env` 来自 `PIXEL_UPSTREAM_BASE_URL` / `PIXEL_UPSTREAM_ALLOWED_HOSTS` / `PIXEL_UPSTREAM_ENABLED` / `PIXEL_UPSTREAM_TIMEOUT_MS`（显式配置，无默认地址，仍 fail-closed）；env 来源 `reload=restart`，db 来源 `reload=runtime`；新增 `resetPixelIntegrationConfig()`（删除 `key:"default"` 并失效缓存）；写接口改为 **allowlist**：只允许 `upstreamBaseUrl/allowedHosts/enabled/requestTimeoutMs`，其余字段（含 Mongo URI、主密钥等）一律 `400 PIXEL_CONFIG_PROTECTED_FIELD` |
| `src/routes/admin/pixelRoutes.ts` | `PixelAdminRouterDeps.config` 增 `reset`；PUT 原样透传 body 给 service（allowlist 必须在服务层生效）；新增 `DELETE /api/admin/pixel/configs`（`authenticateSuperAdmin`），成功后写 `pixel.config.reset` 审计（只记恢复后的 source，不记地址） |
| `frontend/src/components/admin/PixelAdminPanel.tsx` | 配置页显示「来源 / 是否被数据库覆盖 / 热更分类」徽标；新增「恢复默认」按钮（确认框 + 仅超管），成功后刷新表单与总览 |
| `src/tests/pixelIntegrationConfig.test.ts`（新） | default/db/env 三种来源、env 显式关闭 fail-closed、恢复默认调用 `deleteOne`、受保护字段 400 且不落库、合法保存归一化 |
| `src/tests/pixelAdminRoutes.test.ts`（扩展） | DELETE 路由权限与审计、PUT 至少把未知字段原样交给 service、dashboard 新字段固定值 |

**验证点**

- `GET /api/admin/pixel/configs`：无记录且无 env → `source=default && overridden=false`；有记录 → `source=db && overridden=true`；仅 env → `source=env && reload=restart`；
- `DELETE /api/admin/pixel/configs`：普通管理员 403 且不调用 service；超管 200 且 `configured=false`（fail-closed），审计存在且不含上游地址；
- `PUT` 带 `mongoUri` 等字段返回 400 `PIXEL_CONFIG_PROTECTED_FIELD`，数据库无写入。

---

## 6. PIX-14 总览：proxy/worker/queue + errors/latency/size

**改动位置**

| 文件 | 内容 |
|---|---|
| `src/pixel/usageLogService.ts` | 新增 `pixelUsageLogService.metrics()`：单次 `$facet` 聚合 `byOutcome`、耗时（avg/P95/P99/max）、请求字节（avg/P95/max）；0 样本时三项均为 `null` 并返回原因；分位用 MongoDB 7+ `$percentile`（Mongo 8 镜像） |
| `src/pixel/dashboardService.ts` | 返回 `runtime`（upstream 状态 + `proxy/worker/queue` 固定 `null` + 各自原因）与 `metrics`（错误/延迟/请求大小 + 无样本原因）；`config` 带 `source/reload` |
| `frontend/src/components/admin/PixelAdminPanel.tsx` | 总览新增「运行时状态」「错误 / 延迟 / 请求大小」面板；无数据渲染服务端原因而不是空白；错误分类以徽标展示 |
| `src/tests/pixelDashboard.test.ts`（新） | 无数据源时 proxy/worker/queue 为 null 且有原因；无样本时三项指标为 null；有样本时透传真实聚合与来源分类 |

**验证点**

- `GET /api/admin/pixel/dashboard` 永远包含 `runtime` 与 `metrics` 键；proxy/worker/queue 固定 `null`；
- 溯源为空时 `metrics.errors/latency/requestSize === null`，`unavailableReasons` 有中文原因；
- 有数据时数值与 `pixel_usage_logs` 聚合一致（P95/P99 由 `$percentile` 给出）。

---

## 7. GEO-G6 测试

| 文件 | 覆盖 |
|---|---|
| `src/tests/geogebraAccess.test.ts`（新） | 他人项目 404（不泄漏存在性）、viewer 可读不可写/不可评论、editor 可写不可评论、无权限列版本不查版本表、他人项目评论 404、资产查询带 ownerUserId 且他人 404、fork 关闭 403、撤销 fork 404 |
| `src/tests/geogebraShareRevoke.test.ts`（新） | `embedUrl` 契约；撤销后 getShare/cover/fork 全 404；撤销写入 `revokedAt` 并删封面；非所有者撤销 404 且无副作用 |
| `src/tests/geogebraVersionRetention.test.ts`（新） | GEO-11 裁剪与保护口径 |
| `src/tests/pixelIntegrationConfig.test.ts`（新） | PIX-13 来源/恢复默认/受保护字段 |
| `src/tests/pixelDashboard.test.ts`（新） | PIX-14 null 语义 |
| `frontend/src/tests/geogebraShareEmbed.test.tsx`（新） | GEO-17 embed URL 口径 |

仍缺（本任务未要求、可另批）：前端 Geo/Pixel 页面级 React 冒烟（懒加载 + 模式切换）、share 撤销的后端 HTTP 层用例。

---

## 8. 本轮实际执行的验证

| 命令 | 结果 |
|---|---|
| `node scripts/governance/check-frontend-design-language.js` | 通过；命中 77 处，远低于基线上限 319 |
| `node scripts/governance/check-ts-file-size.js` | 通过；唯一超 1500 行的 `App.tsx` 在 legacy 增长预算内（1810→1836，+26/300） |
| `node scripts/generate-privacy-data-map.js --check` | 通过（46 个数据集 / 6 个类别，生成物已同步） |

未运行：`tsc`、Jest、Vitest、lint、构建、依赖安装（按约束由 CI 执行）。

---

## 9. 需要协调者应用的注册/接线补丁

以下文件不在本轮可编辑范围，代码已按「不依赖它们也能工作」的方式落地（本地交叉类型 / 直接 `api.delete`），
建议后续统一收口，避免前后端类型漂移：

1. **`frontend/src/api/pixelAdmin.ts`**
   - `PixelIntegrationConfigView` 增 `source: "db"|"env"|"default"`、`overridden: boolean`、`reload: "runtime"|"restart"`；
   - 新增 `deletePixelIntegrationConfig(): Promise<PixelIntegrationConfigView>`（`DELETE /api/admin/pixel/configs`），
     并在 `PixelAdminPanel.tsx` 用该函数替换当前的 `api.delete`；
   - `PixelAdminDashboardView` 增 `config.source/reload`、`runtime`、`metrics`，即可移除面板里的本地交叉类型。
2. **`frontend/src/types/geogebra.ts` / `frontend/src/api/geogebra.ts`**
   - `GeoGebraShare` 增 `embedUrl: string | null`，`GeoGebraSharePanel` 可去掉 `ShareWithEmbed` 断言。
3. **`frontend/src/api/geogebraAdmin.ts` + `frontend/src/components/admin/GeoGebraAdminPanel.tsx`**
   - 补 `worker/queue/staticAssets/recentAssets` 类型与只读区块（GEO-22 的后端字段已就绪）。
4. **`.env.example`**
   - 新增 `GEOGEBRA_VERSION_RETENTION_LIMIT`（默认 24，钳制 1..500）；
   - 新增 `PIXEL_UPSTREAM_BASE_URL`、`PIXEL_UPSTREAM_ALLOWED_HOSTS`（逗号分隔）、`PIXEL_UPSTREAM_ENABLED`；
     `PIXEL_UPSTREAM_TIMEOUT_MS` 已存在，注释补充它同时作为集成配置的 env 默认值。
5. **OpenAPI 生成物**
   - `src/routes/admin/pixelRoutes.ts` 新增了 `DELETE /api/admin/pixel/configs` 的 `@openapi` 注释；
     需在 CI 前跑 `pnpm run generate:openapi` 更新 `src/generated/openapi*`（生成物不在本轮可编辑范围）。
6. **`docs/plans/2026-10-16-geograba-gggggg-synapse-integration-prd-prompt.md`**
   - GEO-11 可标为「默认 24 版 + env 可覆盖」；GEO-17 补 embed URL 与 `?share=`；GEO-16/22、PIX-13/14
     按本记录回填；GEO-21 的「服务端仅 zip-bundle」缺口说明仍需按审计 §5 写入 §9.1。
7. **`src/services/registrationRiskService.ts`**：工作树中的改动非本轮产生，提交时请与其他协作者对齐，切勿混入本批。
8. **`src/app/assembly.ts`（需 owner 裁决，未改）**
   - 全局 helmet `frameguard: { action: "deny" }` 会给所有响应加 `X-Frame-Options: DENY`。
     嵌入壳本身已就绪，但**跨站 iframe 嵌入仍会被浏览器拦下**。是否对 `/geogebra/share/:slug?embed=1`
     放开 `frame-ancestors` 属于 clickjacking 安全策略变更，建议由 owner 决定（推荐：仅对该路径放宽并加
     `Content-Security-Policy: frame-ancestors <白名单>`，而不是全局放开）。
