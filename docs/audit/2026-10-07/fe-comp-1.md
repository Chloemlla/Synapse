# 前端组件静态审计：fe-comp-1（2026-10-07）

基线：`main` / `15f6c1a2`。仅静态读取，未修改源码，未运行应用、构建、测试或 lint。位置均为仓库相对路径。严重度依据实际影响，不以代码风格计数。

## 1. 缺陷清单

| ID | 严重度 | 类别 | 位置 file:line | 症状与根因 | 证据（不超过 3 行） | 建议改法 |
| --- | --- | --- | --- | --- | --- | --- |
| fe-comp-1-01 | 高 | 响应契约 | `frontend/src/components/CommandManager.tsx:279`、`:325`、`:391` | Cookie 登录管理员加载命令队列、查看下一条和加载历史时，接口有数据仍显示空。组件只在旧加密格式分支调用解包函数，正常 Cookie 分支直接读顶层 command/数组。 | `src/routes/commandRoutes.ts:109,306` 返回 `{success:true,payload:...,mode:'cookie-session'}`；前端 `:300,345,412` 只判断 response.data；`resolveCommandPayload` 已支持该包装却未调用。 | 三条读取路径先统一解包再判定形状；分别处理队列单条预览与历史数组。 |
| fe-comp-1-02 | 中 | 分页状态 | `frontend/src/components/CDKStoreManager.tsx:723` | 从第 2 页或更后页点击首页/上一页回到第 1 页时，数字变成 1，仍显示上一页 CDK。加载 effect 被 `currentPage > 1` 排除了第一页。 | `:765` 仅 setCurrentPage；`:723-727` 仅 page > 1 才 fetchCDKs；首屏 effect `:717` 只执行一次。 | 所有页码统一由一个 effect 查询，包括第一页，去掉重复首屏请求入口。 |
| fe-comp-1-03 | 高 | 有效期意外改写 | `frontend/src/components/ApiKeyManager.tsx:182`、`:433`、`:465` | 仅修改 Key 名称/限流也会延长有效期；已过期但 enabled=true 的 Key 被重新激活一天。编辑把剩余时间向上取整成天，提交又总是从当前时间重新计算。 | `daysUntil` 过期返回 1；每次 PUT 均传 expiresInDays；`src/routes/apiKeyRoutes.ts:273` 收到字段即 `Date.now()+days`。 | 有效期未改时省略字段；编辑绝对 expiresAt 或提供明确续期动作，并保留原始时间。 |
| fe-comp-1-04 | 高 | 请求契约 / 功能阻断 | `frontend/src/components/EcoEnchantsOpsPanel.tsx:397`、`:425`、`:451`、`:466`、`:486`、`:501` | 创建任务、文件读写删、创建/恢复备份全部缺少必需幂等键，有效超管会话也会被服务端拒绝，运维写功能不可用。 | 所有 POST 无第三参数 headers；`ecoEnchantsController.ts:527,576,598,620,664,699` 调 withIdempotency；`ecoEnchantsService.ts:687` 强制 `ensureRequiredText(params.key,'Idempotency-Key',200)`。 | 每次逻辑操作生成键并随请求发送；同一操作的重试复用同一键，收到结果后再换键。 |
| fe-comp-1-05 | 中 | 时区 / 数据完整性 | `frontend/src/components/CDKStoreManager.tsx:465`、`:503` | UTC+8 用户编辑有过期时间的 CDK，仅修改代码后保存也会把到期时间提前 8 小时；临近到期还可能被后端拒绝。ISO UTC 截掉 Z 后放入 datetime-local，再按本地时间解析。 | 初始化 `toISOString().slice(0,16)`；提交 `new Date(formData.expiresAt)`；`cdkController.ts:125` 与 `cdkService.ts:721` 持久化该时间。 | 用本地年月日时分格式填充 datetime-local，提交转 ISO；无关编辑不改时间字段。 |
| fe-comp-1-06 | 中 | 清空值契约 | `frontend/src/components/CDKStoreManager.tsx:503` | 编辑时清空「过期时间」并保存，提示成功但旧到期时间保留，无法改为永不过期。空值被变成 undefined，序列化后字段消失。 | 前端 `expiresAt: ... : undefined`；控制器 `:125` 只处理非 undefined；服务 `:721` 也只处理非 undefined。 | 定义显式清空协议（如 null）并在后端用 `$unset`；不要以省略字段表示清空。 |
| fe-comp-1-07 | 中 | 分页遗漏 | `frontend/src/components/CDKStoreManager.tsx:227`、`:476` | 资源超过 10 个后，生成/编辑 CDK 的资源下拉只能选最近 10 个，较老资源无法选择。 | 两处仅 `resourcesApi.getResources()`；`frontend/src/api/resources.ts:24` 默认 page=1；`src/services/resourceService.ts:22,37` 每页固定 10。 | 使用支持搜索/翻页的资源选择器，或专用受限选项接口；编辑时额外加载当前绑定资源。 |
| fe-comp-1-08 | 中 | effect 请求循环（历史修复遗漏） | `frontend/src/components/ArticleCommandPalette.tsx:45` | 没有已发布文章时打开 Ctrl+K，成功空响应仍持续重发请求，列表反复 loading。历史 F5-07 修复了失败循环，遗漏成功空数组分支。 | effect 依赖 isLoading；守卫只看 articles.length/isLoading/loadError；成功 `[]` 后 finally 置 false，守卫再次通过。 | 用独立 loaded/请求状态标记；打开时只发一次，空结果也算已完成。 |
| fe-comp-1-09 | 中 | 失败重试不可恢复 | `frontend/src/components/CapWidget.tsx:128`、`:153` | CDN 首次明确触发 error 后，用户重新验证仍只能超时，网络恢复也不会重新下载该脚本。失败脚本留在 DOM，新实例只监听已结束脚本的 load/error。 | error 只将全局状态设 failed；existing 分支不识别 failed；后续超时 ownScript=null，不移除遗留元素。 | 失败时移除脚本并清状态；复用分支按 loading/ready/failed 区分，重试失败状态需新建 script。 |
| fe-comp-1-10 | 中 | 请求竞态 / 错页 | `frontend/src/components/AuditLogViewer.tsx:150` | 快速翻页或切筛选时，旧请求后到覆盖新数据并写回旧 page；写 page 又触发查询，可把用户拉回旧页，统计与日志也可能来自不同筛选。 | query 完成无序号/取消保护；`:157 setPage(response.page)`；`:186` 依赖 page；搜索与分页按钮未锁 loading。 | 每条查询使用版本号/AbortController，仅最新请求可提交数据与页码；统计与筛选版本绑定。 |
| fe-comp-1-11 | 中 | 跨对象结果串用 | `frontend/src/components/ApiKeyManager.tsx:480` | 依次打开 A、B 两个 Key 的计费流水，A 慢请求后到会显示在 B 标题下，管理员据错误账目判断或调整 B 余额。 | `setEventsKey(key)` 在请求前，`setBillingEvents` 在请求后无 key 校验；`:1230` 可随时切另一 Key。 | 流水按 key 缓存/存储，提交响应前核对当前 key 与请求版本；旧请求取消。 |
| fe-comp-1-12 | 中 | 切页竞态 / 假空 | `frontend/src/components/BilibiliDataAdmin.tsx:172` | 「Cookie 上报」尚在请求时切「账号绑定」，旧上报响应后到会清空账号列表并替换分页；当前账号页显示暂无记录。 | currentTab 闭包决定写 reports/accounts 并清另一数组（`:185-192`）；tab 按钮 `:281` 加载时仍可切；无取消或版本判断。 | 按 tab 保存各自数据与分页，或只让当前 tab 最新请求写状态。 |
| fe-comp-1-13 | 中 | 统计分母错误 | `frontend/src/components/BilibiliSyncAdmin.tsx:197`、`:268` | 超过一页时「凭据有效率/绑定率/活跃数据率」显著偏低：当前页计数除以全库总数，所有记录有效也可能只显示 20%。 | active/bound/withRecords 由 records 当前页计算；分母 `pagination.total`；列表请求 limit=20。 | 明确显示本页比例并除以 records.length，或由服务端返回全量聚合。 |
| fe-comp-1-14 | 中 | 已清空状态被旧请求回填 | `frontend/src/components/DeepLXTranslatorPage.tsx:188`、`:496` | 翻译请求进行中点击清空，原文已空但稍后旧译文重新出现并写入历史。清空只清 state；自动翻译 effect 遇空文本直接 return，没有取消旧请求。 | `:497-499` 无 abort；`:257` 空输入 return；`:227-238` 对旧请求结果无版本检查。 | 清空、换历史和换方向时取消旧请求并递增版本；仅最新输入对应的响应可写入结果。 |
| fe-comp-1-15 | 中 | 存储异常导致页面错误 | `frontend/src/components/DeepLXTranslatorPage.tsx:86`、`:178` | 浏览器禁用存储或 quota 耗尽时，翻译成功后的历史持久化可能让组件渲染抛错。setHistory updater 内直接调用会抛错的 localStorage.setItem，外围异步请求 catch 无法可靠捕获后续渲染中的 updater。 | saveHistory 无 try/catch；`:180-184` updater 里执行存储；loadHistory 却已对读取异常降级。 | updater 保持纯函数；在 effect/独立安全函数写存储并捕获异常，失败仍保留内存译文。 |
| fe-comp-1-16 | 中 | 时间错误 | `frontend/src/components/DataCollectionManager.tsx:526`、`:224` | 新建采集记录采用默认时间时，UTC+8 用户写入的时间比点击创建早 8 小时，影响时间筛选/审计排序。 | 默认值 `new Date().toISOString().slice(0,16)`；输入为 datetime-local；提交按本地解析再 toISOString。 | 默认字段使用本地时间格式；或未改默认时间时直接以提交时刻生成 ISO。 |
| fe-comp-1-17 | 低 | 事件生命周期 / 运行时异常 | `frontend/src/components/DataCollectionManager.tsx:1020`、`:1057`、`:1164` | 手机触摸复制按钮两秒后异步回调抛 TypeError，按钮透明度恢复失败。React 事件 currentTarget 只在当前处理器执行期间有效，不能在定时器里重新取。 | 三处均 `setTimeout(() => { e.currentTarget.style.opacity='0'; },2000)`。 | 处理器内先保存 `const button=e.currentTarget`，定时器引用该元素，并在卸载时清理。 |
| fe-comp-1-18 | 低 | 日期默认值错误 | `frontend/src/components/AgeCalculatorPage.tsx:121` | UTC+8 午夜至早上 8 点打开页面，「截止日期（默认今日）」实际显示昨天，并把昨天提交给年龄计算。 | endDate 初始为 new Date；formatDateForInput 用 `toISOString().split('T')[0]`；`:228` 提交该字符串。 | 用本地年月日格式化日期输入；日期型值优先保存 YYYY-MM-DD 字符串，避免混用 UTC 时刻。 |

## 2. 已核对区域

- 逐文件检查了 39 个清单组件的状态、effect、请求、清理、按钮/输入和条件渲染；大型组件的纯 CSS 类串、SVG path、动画与重复静态介绍未作为缺陷依据。
- 历史查重使用实际路径 `docs/audit/audit-2026-10-03-ui-{admin,tools,auth-2fa,verification,core}.md`、`audit-2026-10-03-medium-low.md`、`audit-2026-10-03-index.md` 与 `audit-2026-10-04-ip-risk.md`（并无 2026-10-03/04 子目录）。F4-04、F4-06、F3-03、F3-10/11/20、F5-20/43 等已修旧问题未重复列入；08 明示 F5-07 的未覆盖分支。
- 共享 axios 会补 IP 验证头并处理处罚事件；原生 fetch 已被 `installIpVerificationTransport()` 包装，故不因组件没有显式加 IP 验证头而报错。
- ConfirmModal/AlertModal 已有 Escape、Tab 环与焦点恢复；公告 HTML、SVG 分享、广播 HTML 经过 DOMPurify；Cap 卸载 reset 的 isConnected 保护存在；CoinFlip 使用 settlingRef 避免跳过动画重复落结果；DataCollection 列表已有 abort 机制，未笼统报告所有请求缺少取消。

## 3. 存疑（不算确认）

- EcoEnchantsOpsPanel 在修复 04 后还需核对异步任务模型：文件读/写/删返回的是创建任务的 201，当前代码把响应当内容/最终成功，没有轮询任务完成。当前请求被必需幂等键提前拒绝，因此不把后续分支计为已触发缺陷。
- AgeCalculator 的 useActionState dispatcher 在普通 onClick 中调用、未显式 startTransition；pending 语义需以 React 对应版本 CI 用例核实，本轮不按框架推断另加确认项。
- AudioPreview 的 canplay 每次触发都会 play，seek 时 onPause 又改变 isPlaying；实际拖动/缓冲事件顺序需浏览器验证，未计入确认项。
- ArtifactSharePage 获取内容后 await recordView，再结束 loading；统计请求慢会延迟展示。已读到依赖，但本轮不把尚无生产延迟证据的体验问题单列。
- AdminLogin 未检出 App 中直接调用；其独立登录/多因素流程问题不按可达问题计数。

## 4. 覆盖面

清单内确切读过（39 文件；仓库相对路径，均位于 `frontend/src/components/`）：

`AdminDashboard.tsx`、`AdminLogin.tsx`、`AdminStoreDashboard.tsx`、`AgeCalculatorPage.tsx`、`AiErrorDetailsPanel.tsx`、`AlertModal.tsx`、`AnnouncementManager.tsx`、`AnnouncementModal.tsx`、`AntiCounterfeitPage.tsx`、`ApiDocs.tsx`、`ApiKeyManager.tsx`、`ArticleCommandPalette.tsx`、`ArtifactSharePage.tsx`、`AudioPreview.tsx`、`AuditLogViewer.tsx`、`authStudioTheme.ts`、`BackupCodesModal.tsx`、`BilibiliDataAdmin.tsx`、`BilibiliSyncAdmin.tsx`、`BroadcastManager.tsx`、`BroadcastModal.tsx`、`BroadcastModalView.tsx`、`CampusEmergencyPage.tsx`、`CaptchaVerificationExample.tsx`、`CaptchaVerificationPage.tsx`、`CapWidget.tsx`、`CaseConverter.tsx`、`CDKStoreManager.tsx`、`ClientOriginProbe.tsx`、`CloudflareChallengePage.tsx`、`CoinFlip.tsx`、`CommandManager.tsx`、`ConfirmModal.tsx`、`DataCollectionManager.tsx`、`DebugInfoModal.tsx`、`DeepLXTranslatorPage.tsx`、`DemoHub.tsx`、`EcoEnchantsAdminPage.tsx`、`EcoEnchantsOpsPanel.tsx`。

额外只读契约/调用核查：`frontend/src/api/{api,cdks,resources,deeplx,markdownArticles}.ts`、`frontend/src/utils/ipVerification.ts`、`frontend/src/App.tsx` 相关路由与挂载；`src/routes/{apiKeyRoutes,commandRoutes,ecoEnchantsRoutes}.ts`、`src/controllers/{cdkController,resourceController,ecoEnchantsController}.ts`、`src/services/{apiKeyService,cdkService,resourceService,commandService,ecoEnchantsService,ecoEnchantsOpsService}.ts` 的关联区段。

静态局限：无真实请求、浏览器焦点/触摸/媒体事件重放；未读取每个组件全部间接依赖。展示样式和静态文案重复段不构成视觉审计覆盖。结论是可复核的代码路径分析，不能替代后续 GitHub Actions 或经授权的运行验证。

并发变动：本组报告落盘后，另一会话在工作树修改 `CapWidget.tsx`、`CloudflareChallengePage.tsx`、`frontend/src/api/api.ts`、`frontend/src/utils/ipVerification.ts`、`src/services/cdkService.ts` 等验证码/传输链文件。本报告结论对应审查基线，不代表这些未提交改动后的状态；尤其 09 需由协调者与并发修复对账。遵照用户转入修复的新指令，未继续扩展审查。
