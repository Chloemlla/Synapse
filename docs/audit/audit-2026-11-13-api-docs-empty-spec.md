# API 文档页空白（openapi.json 零路径）— 定位与修复 — 2026-11-13

> 依据 `F:\Repositories\GitHub\verified-methodology.md`：先取证定位根因、落盘清单，再按编号修；
> 本机**不构建 / 不测试 / 不装依赖**，结论以 GitHub Actions 与线上容器实测为准。

## 一、症状

前端 `frontend/src/components/ApiDocs.tsx`（`/api-docs`）打开后渲染不出任何接口，
页头「N 个路径」为 0；直接取 `GET /api/openapi.json` 得到：

```json
{ "openapi": "3.0.0", "info": { … }, "paths": {}, "components": {}, "tags": [], "x-audit-log": { … } }
```

即接口返回 200、内容却是**空清单**，Swagger UI 只能显示一张空白页。

## 二、取证链（每一环都是实测，不是推断）

| # | 取证 | 结论 |
|---|---|---|
| 1 | 线上 `raksmart` 容器 `tts-node`（镜像 `happyclo/tts-node:5f31241-amd64`）：`ls -la /app/openapi.json` = **205 字节**，`Object.keys(paths).length` = **0** | 空 spec 是**镜像构建期**产生的，不是运行时改造 |
| 2 | CI `Node Verification`（run `43155382482`）的 drift gate 日志：`Documented paths: 281 \| spec paths: 0` → `spec declares zero paths` | 同一个缺陷在 CI 里也复现，与镜像无关 |
| 3 | 容器内复现：`swagger-jsdoc@6.3.0` + `glob@11.1.0` + `minimatch@11.0.5`，喂一个带 `@openapi` 注释的临时文件 → `swaggerJSDoc(…).paths` 为空 | 空 spec 由「一条注释都没扫到」造成 |
| 4 | 容器内单独测 `glob.sync`：字面路径能命中，**任何 magic 模式（`/x/*.ts`、`/x/**/*.ts`、`cwd`+`**/*.ts`）恒返回 `[]`** | glob 的目录遍历整体失效，不是 swagger-jsdoc 的锅 |
| 5 | 同一容器内把 glob 的 `minimatch` 换成 `9.0.9`（把 `/app/node_modules/.pnpm/glob@11.1.0` 整棵树拷到 `/tmp` 后替换依赖）→ 同一批 magic 模式全部正常返回 | 变量只有 minimatch 版本，**glob@11.1.0 与 minimatch@11 不兼容** |
| 6 | `pnpm-lock.yaml`：`glob@11.1.0 → minimatch: 11.0.5`；而 `glob@11.1.0` 自己的 `package.json` 声明 `minimatch: ^10.1.1` | 锁文件把 glob 配到了它没声明支持的 major |
| 7 | `pnpm-workspace.yaml`：`overrides: minimatch: '>=10.2.1'`（无上界） | 根因：上限缺失，pnpm 把 glob@11 的 minimatch 一路顶到 11.0.5 |
| 8 | 本机同一份代码用 glob 11 + minimatch 9 生成 → **274** paths；修掉两个 YAML 报错块后 → **281** paths，与 drift gate 的 `Documented paths: 281` 相等 | 修复判据可本地只读复算 |

## 三、根因

`pnpm-workspace.yaml` 的 `minimatch: '>=10.2.1'` 只给了安全下限（GHSA-23c5-xmqv-rm74 修在 10.2.1）、
没给上界。`swagger-jsdoc@6.3.0` 硬依赖 `glob@11.1.0`（其声明 `minimatch: ^10.1.1`），被这条 override
解到 `minimatch@11.0.5` 后，glob 的 magic 匹配整套静默失效（返回 `[]`，不抛错）。于是：

`scripts/generate-openapi.js` 扫不到任何 `@openapi` 注释 → 写出一份 `paths: {}` 的 `openapi.json`
（205 字节）→ Docker 阶段 `COPY --from=backend-builder /app/openapi.json` 把它带进镜像 →
`GET /api/openapi.json` 返回 200 + 空清单 → `ApiDocs.tsx` 的 Swagger UI 空白。

两个放大器让这个故障一直没被发现：

- 生成脚本对「零命中」不报错，镜像构建全绿；
- 服务端把空 paths 的 spec 当正常文档下发，前端也照单渲染。

## 四、修复清单

| 编号 | 位置 | 处置 |
|---|---|---|
| AD-01 | `pnpm-workspace.yaml` | 根因：保留 `minimatch: '>=10.2.1'` 的安全下限，另加 `'glob@^11>minimatch': '>=10.2.1 <11'`，让 glob@11 回到 10.x（glob@13 继续用 11.x），并写清来龙去脉 |
| AD-02 | `scripts/generate-openapi.js` | **零命中即失败**（`process.exit(1)`，不覆盖既有 `openapi.json`）：镜像构建从此不会再静默产出空 spec |
| AD-03 | `src/services/openapiDocumentService.ts` | 空 paths 的候选文件判为不可用并跳过（warn 记录来源）；运行期兜底生成若仍是零路径则抛错，`/api/openapi.json` 明确 500，而不是把空清单发给前端 |
| AD-04 | `frontend/src/components/ApiDocs.tsx` | 新增「接口清单为空」态（说明 + 重试），不再把空白 Swagger UI 抛给用户；零路径时「下载 openapi.json」按钮置灰 |
| AD-05 | `src/routes/cdictRoutes.ts`、`src/routes/cdictWebRoutes.ts` | 两处 `@openapi` 块把含 `` `{key}: true` `` 的描述写成裸 plain scalar，YAML 直接解析失败 → 整个块被 swagger-jsdoc 丢弃，CDict 的 7 个端点从 spec 里消失（drift gate 的另外 7 条）。改成块标量 `>-` 后 281/281 对齐 |

锁文件按 §十七 处理：本地只改清单（`pnpm-workspace.yaml`），`pnpm-lock.yaml` 交给
`Security Alert Maintenance` 工作流（`-f action=repair-lockfiles`）重生。

## 五、复验判据

1. drift gate：`Documented paths: 281 | spec paths: 281` → `OpenAPI drift check passed.`（本机只读复算已过）
2. 镜像内 `/app/openapi.json` 不再是 205 字节；`GET /api/openapi.json` 的 `paths` 非空
3. `/api-docs` 页头显示 `281 个路径`，Swagger UI 列出端点
4. 反向验证：故意把 `minimatch` 退回 11.x（或临时把 glob 的 minimatch 指向 11）时，
   `pnpm run generate:openapi` 必须**失败退出**而不是写出空 spec

## 六、存量红灯（与本次无关，未动）

- `Quality Guardrails`：`src/tests/viteBuildConfig.test.ts` 断言 manualChunks 分组 `priority: 0` 失败（前端构建配置，非本次范围）
- `Node Verification / CDict web regression`：另一条独立 job 的存量红
