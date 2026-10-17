# GeoGebra Studio 全量收口（2026-10-17）

> 依据：`docs/plans/2026-10-16-geograba-gggggg-synapse-integration-prd-prompt.md`（GEO-15…22）、
> `docs/audit/2026-10-17-geo-pixel-gaps.md` §9「需要协调者应用的注册/接线补丁」、
> `docs/audit/2026-10-17-october-plans-conformance.md` §5.1。
> 本轮只改 GeoGebra 域；未触碰同一工作树里其他会话的 WIP（`runtimeConfig*`、`adminController`、
> `ticketController`、`ticketAttachmentGrant.test.ts`）。本机未执行构建/测试/lint/装依赖。

---

## 1. 嵌入分享真正可用（GEO-17）

| 文件 | 改动 |
|---|---|
| `src/security/embedFramePolicy.ts`（新） | 识别 `/geogebra/share/<slug>?embed=1`；解析 `GEOGEBRA_EMBED_FRAME_ANCESTORS`（默认 `*`，逗号分隔白名单，空串=关闭）；非法来源一律丢弃并 fail-closed |
| `src/security/contentSecurityPolicy.ts` | `frame-ancestors` 改为按请求求值：只有嵌入壳拿到配置值，其它路径仍是 `'none'` |
| `src/app/assembly.ts` | helmet 之后、只对命中嵌入策略的请求摘除 `X-Frame-Options`（老浏览器以 XFO 为准） |
| `frontend/src/components/geogebra/GeoGebraSharePage.tsx` | 嵌入模式隐藏编辑器/封面/复制等跳出画布的动作；画布就绪后自动运行一次；新增 SVG 下载 |
| `frontend/src/components/geogebra/GeoGebraSharePanel.tsx` | 使用服务端 `embedUrl`；封面改为可选（未运行画布也能发布，只是没有预览图） |
| `frontend/src/types/geogebra.ts` | `GeoGebraShare` 增加 `embedUrl: string \| null` |

**取舍**：公开分享本身就是「持有链接即可查看」，嵌入模式的页面没有任何登录/管理动作，
因此默认允许任意来源 iframe；需要收紧时配置白名单即可。普通分享页与全站其它页面不变。

## 2. 工作台 UI/UX 重排

| 文件 | 改动 |
|---|---|
| `frontend/src/components/geogebra/GeoGebraPage.tsx` | 编辑器 + 画布保持并排，画布在桌面端 `sticky`；下方功能区收进 5 个标签页（项目与版本 / 协作与分享 / 参数与样式 / AI 与导出 / 讲解与记录）。标签页只隐藏不卸载，AI 轮询等状态不会被切走中断 |
| `frontend/src/components/geogebra/GeoGebraTabBar.tsx`（新） | `tablist` 语义 + roving tabindex + 方向键/Home/End 切换 |
| `frontend/src/components/geogebra/workbenchTabs.ts`（新） | `?tab=` 合法值唯一真相源；未知值回落 `project` |
| 页面工具栏 | 运行/停止（新增真正的停止能力）、保存快照、清空、重置、PNG/SVG/GGB、复制脚本、拖动锁、演示模式；示例模板从独立大面板收进编辑器头部的小按钮 |
| `frontend/src/components/geogebra/GeoGebraApplet.tsx` | `run()` 增加运行令牌，`stop()` 在两条指令之间退出；新增 `exportSvg()`；卸载时让正在跑的循环失效 |
| `frontend/src/components/geogebra/GeoGebraProjectPanel.tsx` | 本地项目支持搜索与「显示全部」（默认仍只展示最近 6 个） |
| `frontend/src/components/geogebra/GeoGebraCommentsPanel.tsx` | 评论支持「只看待处理」与计数 |
| `frontend/src/components/geogebra/GeoGebraExportPanel.tsx` | 新增「画布直接导出」区（PNG/SVG/GGB/脚本文本），服务端打包与画布侧能力分区展示 |

## 3. 管理诊断补齐（GEO-22）

- `frontend/src/api/geogebraAdmin.ts`：补 `worker/queue/staticAssets/recentAssets` 类型（后端
  `adminDiagnosticsService` 早已返回，前端一直没接线）。
- `frontend/src/components/admin/GeoGebraAdminPanel.tsx`：新增「任务队列与处理进程」「静态资源」
  「最近资源」三个只读区块；无数据时仍按空态渲染，不编造分位数字。

## 4. 清理与配置

- `src/services/schedulerService.ts`：把 GeoGebra 过期资产文件清理与过期任务标记并入既有
  5 分钟清理轮（此前只有管理页手动按钮会触发，磁盘与 `queued/running` 状态会长期滞留）。
- `.env.example`：新增 `GEOGEBRA_VERSION_RETENTION_LIMIT`、AI 回退变量、资产/临时目录、
  `GEOGEBRA_EMBED_FRAME_ANCESTORS`。

## 4.1 后续补充（同一轮内）

| 提交 | 内容 |
|---|---|
| `20e5e3be` | 分享封面 data URL 解码失败改为 `400 GEOGEBRA_SHARE_COVER_INVALID`（原先落成 500），且校验失败前不落库 |
| `eae04c20` | 系统管理页的清理面板显示 GeoGebra 资产/任务回收数（定时清理轮已并入这两项，面板原先看不到） |
| `2941ed41` | 诊断页新增区块对旧后端响应做可见降级（滚动发布时前端先更新不会把整页打成空白） |
| `d316f9d4` | AI 结果逐条勾选写回；对象依赖解释旁补本地依赖树（`components/geogebra/dependency.ts`），断网可用、循环引用标记 |
| `e4faf4b1` | 功能区标签同步到 `?tab=`（replace 写入，刷新/分享可回到同一面板） |
| `24e1a5e9` | 管理页「清理过期资源」只对超管显示（服务端仍是唯一判据） |
| `0b92aba0` | 云端面板显示最近保存时间与「尚未保存到云端」状态 |
| `f32bee9a` | 画布界面语言改为 `zh_CN`，与工作台其余中文文案一致 |

## 5. 测试

| 文件 | 覆盖 |
|---|---|
| `src/tests/geogebraEmbedFramePolicy.test.ts`（新） | 仅 `embed=1` 命中；默认 `*`；白名单/非法项/空串；CSP 只为嵌入壳放行 |
| `frontend/src/tests/geogebraWorkbench.test.ts`（新） | `?tab=` 合法值与未知值回落 |
| `frontend/src/tests/geogebraTabBar.test.tsx`（新） | 标签栏点击、方向键/Home/End 与 roving tabindex |
| `frontend/src/tests/geogebraDependency.test.ts`（新） | 依赖图：多层展开、循环、未定义对象、注释与字符串 |
| `src/tests/geogebraShareCover.test.ts`（新） | 封面解码失败返回 400 且不落库 |

## 6. 本轮执行的静态验证

| 命令 | 结果 |
|---|---|
| `node scripts/governance/check-frontend-design-language.js` | 通过（命中 78 处，上限 319） |
| `node scripts/governance/check-ts-file-size.js` | 通过（`GeoGebraPage.tsx` 988 行，未超 1500） |
| 花括号/圆括号/方括号配平检查 | 全部相关文件配平 |
| `typescript` 解析器语法检查（仅 parse，不做类型检查） | 本轮涉及的 20 个 TS/TSX 文件全部解析通过 |

未执行：`tsc`、Jest、Vitest、lint、构建、依赖安装（按仓库约束由 CI 执行）。

## 7. 仍未完成（需产品或外部条件）

1. **GIF / MP4 / PPTX 服务端导出**：需要帧录制与编码器，仓库没有可复用的渲染管线；
   目前按 PRD 允许的方式标记为画布侧能力，不保留不可用按钮。SVG 已补为画布侧直接导出，
   PDF 仍建议用浏览器打印。
2. **GeoGebra / geograba 上游许可**（conformance §5.1 GEO-G7）：代码不能替代书面许可。
3. **页面级 React 冒烟**（conformance GEO-G6 的剩余部分）：本轮补了纯函数用例；
   「懒加载 + 模式切换 + iframe 自动运行」仍需要真实浏览器或 jsdom 下更完整的 GeoGebra 替身。
