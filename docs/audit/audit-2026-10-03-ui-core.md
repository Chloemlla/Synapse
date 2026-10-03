# 外壳 / TTS 核心 / 用户与商店 — 启发式审计

> 审计日期：2026-10-03 ｜ 模式：MODE-AUDIT（只读审查，未改动仓库文件）
> 方法论：`verified-methodology.md`（并行只读审查 → 先落盘发现 → 最小化修复）
> 同批报告：`audit-2026-10-03-ui-*.md`、`audit-2026-10-03-backend-*.md`；总索引 `audit-2026-10-03-index.md`。

审计对象：Synapse `frontend/src`（React 19 + Vite + Tailwind 4）。
判据：`nielsen-heuristics-ui-design-prompt.md` §3.1–3.4 / §4 / §6.2–6.3；设计语言基线 `docs/design/app-ui-design-language.md` + `frontend/src/components/studioTheme.tsx`。
范围：仅状态、反馈、退出路径、错误恢复、中文文案、可访问性。**不含**颜色/圆角/间距类视觉统一（2026-09-25 已完成）。
约束：只登记本轮实际读到并能给出 `file:line` 的缺陷；不含重构建议、视觉偏好、已修项。
计数：38 条 — 阻断 4 / 高 7 / 中 21 / 低 6。

| ID | 文件:行 | 启发式 | 严重度 | 证据（读到什么） | 用户影响 | 建议改法 |
| --- | --- | --- | --- | --- | --- | --- |
| F3-01 | `frontend/src/hooks/useTts.ts:239-372` + `frontend/src/components/TTSForm.tsx:1073-1102` | H01 / B09 | 阻断(B09) | 提交后 `generateInFlightRef` 只防重复提交；`abortControllerRef.abort()` 仅在 unmount（useTts.ts:140-141）暴露；轮询固定 `maxAttempts=120`（:272），超时才抛 `任务处理超时，请稍后重试`（:304）。按钮仅有 spinner + `生成中...`，无取消按钮、无阶段文案、无进度、无「可安全离开」提示 | 长耗时生成期间用户被锁死：不能取消、不知道到哪一步、不敢离开页面，失败时唯一出路是等满 120 次轮询 | 暴露 `cancel()`（abort 当前 controller 并置任务为已取消）；UI 加取消按钮 + 阶段文案（排队/合成/校验）+ 已用时；>10s 时显示「可安全离开，稍后回来查看」；失败保留已填表单 |
| F3-02 | `frontend/src/components/speech-to-text/SpeechToTextPage.tsx:381-384` | H03 / B07 | 阻断(B07) | 任务行展开结果是 `<div onClick={...}>`，无 `role="button"`、无 `tabIndex`、无键盘事件 | 纯键盘用户无法展开查看转写结果，功能对其完全不可达 | 换成 `<button>`（或加 `role="button"` + `tabIndex=0` + Enter/Space 处理），并补 `aria-expanded` |
| F3-03 | `frontend/src/components/AudioPreview.tsx:146-161,131-139,164-175` | ♿ / B07 | 阻断(B07) | 播放/暂停按钮（:146-161）与关闭按钮（:131-139）均为纯图标（react-icons）且无 `aria-label`/`title`；进度条 `<input type="range">`（:164-175）无名称、无 `aria-label` | 屏读用户听到「按钮」却不知用途；进度条无法被识别为「播放进度」 | 三个控件分别补 `aria-label="播放"/"暂停"/"关闭预览"/"播放进度"` |
| F3-04 | `frontend/src/components/speech-to-text/SpeechToTextPage.tsx:242-247` | H09 / B02 | 阻断(B02) | 转写配置加载失败只渲染静态错误横幅，正文里没有任何重试/重新加载动作 | 首屏配置拉取失败后页面停在错误态，用户除了刷新整页无路可走 | 错误横幅内加「重新加载配置」按钮，直接重跑 `loadConfig` |
| F3-05 | `frontend/src/components/TTSForm.tsx:995-1003,1015-1023` | H01 / H04 | 高 | 「人机验证」标题 + 红色 `*` 必填标记（:1001-1002）与说明「请完成人机验证以证明您是人类用户」（:1022）**无条件渲染**；而 `ManagedCaptcha` 在管理端关闭验证时返回 `null`（不渲染任何控件） | 验证关闭时用户看到一个带必填星号、却没有任何可操作控件的区块，会反复寻找或以为页面坏了 | 用验证是否启用的状态把标题、`*`、说明与 `<ManagedCaptcha>` 一起条件渲染 |
| F3-06 | `frontend/src/components/Notification.tsx:255-268` | ♿ / H01 | 高 | 吐司容器与卡片都没有 `role="status"`/`role="alert"`/`aria-live`；`duration = 3000` 自动消失 | 屏读用户完全不会被告知出现过的成功/错误吐司——3 秒后它自己消失，信息永久丢失 | 容器加 `aria-live="polite"`（错误用 `assertive` + `role="alert"`）；错误类吐司不自动消失或延长并支持手动关闭 |
| F3-07 | `frontend/src/components/TTSForm.tsx:1026-1038`（同类：`TtsHistoryList.tsx:280-290`、`TtsGenerationManager.tsx:371-375`、`ResourceStoreList.tsx:639-649`、`PrivacyConsentPanel.tsx:261-279`、`SecurityScorecardPanel.tsx:242-257`） | ♿ / H01 | 高 | 生成失败错误块只有样式化的 `motion.div`，无 `role="alert"`/`aria-live`；上列各处错误与成功提示同为裸 `div` | 提交失败时视觉上出现红框，但屏读用户得不到任何播报，无法感知失败 | 统一给错误块加 `role="alert"`，成功/提示块加 `role="status" aria-live="polite"` |
| F3-08 | `frontend/src/components/ResourceStoreList.tsx:564-569,639-649` | H01 / H09 | 高 | 列表接口失败被折叠进空态（:564-569 渲染成「暂无资源」类文案）；`error` 状态只在 CDK 兑换面板内渲染（:639-649） | 网络/服务端失败被误报成「没有资源」，用户以为商店本来就空，不会重试 | 区分 `loading`/首用空/无结果空/错误四态；错误态独立渲染并带重试按钮，不复用 CDK 面板的错误位 |
| F3-09 | `frontend/src/components/ArtifactSharePage.tsx:415-421`（全页文案） | H02 / H01 | 高 | 未登录可访问的公开落地页整页英文：`Loading artifact`、`Password required`、`Unlock`、`Artifact unavailable`、`Back to Synapse`、`Copy/Download/Share`、`Powered by NexAI Artifacts`；加载壳无 `role="status"`；`setError(loadError.message || 'Unable to load this artifact')` 可直接回显 axios 原文（如 `Request failed with status code 404`） | 面向外部访客的首页中英错位、技术报错外泄，降低信任且不告知发生了什么 | 全页文案中文化；错误统一走 `getBackendErrorMessage` 给出人话；加载壳补 `role="status"` |
| F3-10 | `frontend/src/components/AlertModal.tsx:44-58` | H04 / H08 | 高 | `case 'success'` 返回 `<FaTimes className="... text-emerald-500" />`——成功态用叉号图标；弹窗整体无 `role="dialog"`/`aria-modal`/Esc | 绿色叉号语义自相矛盾，用户读完标题才敢确认是成功；键盘无法 Esc 关闭 | 成功态改用 `FaCheckCircle`；补 dialog 语义与 Esc |
| F3-11 | `frontend/src/components/TTSForm.tsx:1107-1177` + `frontend/src/components/PromptModal.tsx:236-243,132-139` + `frontend/src/components/ConfirmModal.tsx:52-66` | ♿ / B07 | 高 | 音色弹窗（TTSForm:1107-1177）为裸 `div`，无 `role="dialog"`/`aria-modal`/Esc/焦点陷阱，关闭用 `&times;` 无 `aria-label`；`PromptModal` 关闭按钮图标无 `aria-label`，Esc 只在输入框 `onKeyDown` 生效；`ConfirmModal` 无 dialog 语义/Esc/焦点陷阱 | 键盘与屏读用户在弹窗内无法可靠关闭或辨认；焦点可逃到背后内容 | 复用已合规的 `confirm/ConfirmDialogProvider.tsx` 实现（其已有 dialog 语义 + Esc + 焦点回归），或为三者补齐同套语义 |
| F3-12 | `frontend/src/components/TtsGenerationManager.tsx:392-395` | H01 / B09 | 中 | 加载态是 `<SimpleLoadingSpinner size={0.75} />`；`LoadingSpinner.tsx` 中 size≤0.75 的紧凑分支只返回转圈、不含任何文字，且此处未传 `role`/`aria-label` | >1s 的加载既无可见文字标签也无无障碍名称，用户不知道在等什么 | 改用带「正在加载生成记录…」文字的分支，或至少补 `role="status" aria-label` |
| F3-13 | `frontend/src/components/TTSForm.tsx:593-617,855-880,895-912,958-970` | ♿ / H04 | 中 | 「输入文本」(`motion.label` :593-601 → `motion.textarea` :617)、「输出格式」(:855-862 → `motion.select` :863)、「语速」(:895-902 → `motion.input type=range` :903)、「生成码」均为 label 与控件**同级兄弟**，无 `htmlFor`/`id` 关联；同一文件的「语言」下拉（:818-832）却是 label 包裹 select 的关联写法 | 屏读用户听不到这些控件的名称；同表单两套写法不一致 | 统一为 label 加 `htmlFor` + 控件加 `id`（或都用包裹写法） |
| F3-14 | `frontend/src/components/ProductQueryForm.tsx:207-229` | ♿ | 中 | `<label>` 只包住图标与文字（:207-211），真正的 `<input>` 在兄弟 `div` 内（:212-229），label 无 `htmlFor`、input 无 `id` | 条码/货号/EAN/尺码四个输入框对屏读用户全部无名 | 补 `htmlFor`/`id` 关联 |
| F3-15 | `frontend/src/components/ProductQueryForm.tsx:287-352` | ♿ / B07 | 中 | 「导入链接」弹窗为裸 `motion.div`：无 `role="dialog"`/`aria-modal`，无 Esc 处理，无焦点陷阱，打开时不把焦点移入，关闭后不回归触发按钮 | 键盘用户打开弹窗后焦点仍在背后页面，可能迷失 | 补 dialog 语义 + Esc + 初始聚焦 + 焦点回归 |
| F3-16 | `frontend/src/components/ProductQueryForm.tsx:236-246` | ♿ | 中 | 校验/接口错误横幅（`validationError \|\| error?.message`）无 `role="alert"` | 提交被拒时屏读用户不知为何没提交 | 补 `role="alert"` |
| F3-17 | `frontend/src/components/TtsHistoryList.tsx:134,271-298` | H03 / H01 | 中 | 标签筛选存于 `useState`（:134）而非 URL，无法深链/刷新保持；无结果空态「「{tagFilter}」标签下暂无记录」（:297）与首用空态「暂无生成记录」（:293）都**没有清除筛选/去生成的出口动作** | 用户切到某标签后看到空列表，不知是「真没有」还是「被筛掉了」，也没有一键清除 | 筛选写入 URL query；无结果空态加「清除筛选」按钮 |
| F3-18 | `frontend/src/components/TtsHistoryList.tsx:377-389` | H09 | 中 | 历史条目内联 `<audio>` 无 `onError`（全文件无 onError 处理） | 音频 404/解码失败时播放器静默无反应，用户反复点击无反馈 | 加 `onError`，显示「音频加载失败」并提供重试/下载 |
| F3-19 | `frontend/src/components/TtsPage.tsx`（结果面板 `<audio controls preload="none">`；`togglePlayPause` 内 `void audio.play().catch(() => setIsPlaying(false))`） | H09 | 中 | 结果播放器无 `onError`；播放失败被 `.catch` 静默吞掉，只把 `isPlaying` 置回 | 生成成功后播放失败时，界面看似正常但没声音，无任何解释 | 加 `onError` 与可见错误提示；区分「未生成」「生成中」「加载失败」 |
| F3-20 | `frontend/src/components/AudioPreview.tsx:52-58,211` | H09 / B10 | 中 | `handleError` 只 `setState` 并把 `isLoading` 置 false，从不渲染任何失败文案；`:211` 的 `onError` 同样只 `setIsLoading(false)` | 预览加载失败时组件恢复成初始外观，用户以为还没点，反复尝试 | 失败态渲染可见说明 + 重试入口 |
| F3-21 | `frontend/src/components/speech-to-text/SpeechToTextPage.tsx:105-111,369-372` | H01 / H09 | 中 | `loadJobs` 的 catch 只 `console.error`，不落错误状态；随后列表为空即渲染首用空态「还没有任务,先上传一段录音试试。」 | 任务列表拉取失败被伪装成「你还没上传过」 | catch 内设置 `jobsError` 并渲染可重试的错误态 |
| F3-22 | `frontend/src/components/speech-to-text/SpeechToTextPage.tsx:439-443` | H02 | 中 | 直接把后端 `job.logs` 原始文本渲染进 `<pre>` | 用户看到面向开发者的原始日志/内部标识，不知如何处理 | 面向用户只给阶段与结论；原始日志收进默认折叠的「诊断详情」 |
| F3-23 | `frontend/src/components/ResourceStoreList.tsx`（`Catalog` / `Owned` / `Security` / `Price` / `Admin bypass` / `Disabled` / `{provider} enabled` 标签） | H02 | 中 | 中文商店界面里混用英文与内部术语（含 `Admin bypass`、`{provider} enabled` 等实现词） | 用户（尤其非技术用户）读不懂分类与状态含义 | 全部改为中文业务词（如「可兑换/已拥有/安全/价格」），移除 `Admin bypass` 这类内部概念或改写为「管理员豁免」 |
| F3-24 | `frontend/src/components/ResourceStoreList.tsx:609-615` | ♿ / H05 | 中 | CDK 兑换输入框只用 `placeholder` 提示，无 `<label>`、无 `aria-label` | 输入后 placeholder 消失，屏读用户也始终不知道这是兑换码输入框 | 加 `<label htmlFor>` 或 `aria-label="兑换码"` |
| F3-25 | `frontend/src/components/ResourceStoreList.tsx:719-778` | ♿ / B07 | 中 | 第二处自研弹窗为裸 `div`，无 `role="dialog"`/Esc/焦点陷阱 | 与 F3-11 同类：键盘用户被困或无法关闭 | 补 dialog 语义 + Esc + 焦点管理 |
| F3-26 | `frontend/src/components/TtsPolicyConsentPanel.tsx:92`（配合 :34-37） | H05 | 中 | 提交按钮 `disabled={busy \|\| !complete}`；而未勾选时想触发的 `if (!complete) setShowInvalid(true)`（:34-37）位于同一个被禁用按钮的 handler 内，**永远到不了** | 用户未勾选时看到的只是一个灰按钮，得不到「请先勾选全部条款」的说明，不知为何不能提交 | 未勾选时不禁用按钮而在提交时校验并给出提示；或按钮旁常驻显示缺失项 |
| F3-27 | `frontend/src/components/user-profile/SecurityScorecardPanel.tsx:176,194` | H09 / B10 | 中 | `setError(err instanceof Error && err.message ? err.message : '安全总览加载失败')`——优先采用原始 `err.message`，仅在为空时才用中文兜底 | axios 错误会把 `Request failed with status code 500` 这类英文技术文案直接显示给用户 | 反转优先级：先给人话，技术细节收进折叠区 |
| F3-28 | `frontend/src/components/user-profile/ProfileSidebarSummary.tsx:25,82` | H01 / H05 | 中 | `accountStatusLabel = profile?.accountStatus === 'suspended' ? '已暂停' : '正常'`——`profile` 为 `null`（加载中或加载失败）时同样落入「正常」分支并渲染（:82） | 资料未加载出来时侧栏仍宣称「账户状态：正常」，把未知当成正常，可能误导被停用用户 | 区分 `profile === null` 的未知态，显示「—/加载中」而非「正常」 |
| F3-29 | `frontend/src/components/user-profile/DeviceSessionsPanel.tsx:170-171` | H02 | 中 | 退出按钮 `title` 恒为「需要安全会话验证」，但按钮文案在 `securitySessionActive` 为真时是「退出此设备全部会话」（:173），此时 title 与实际动作不符 | 鼠标悬停看到「需要验证」而按钮写着可直接退出，用户对当前处于哪种状态产生困惑 | title 随 `securitySessionActive` 分档，或直接去掉该 title 复用按钮文案 |
| F3-30 | `frontend/src/components/Footer.tsx:272-274` | H09 | 中 | 页脚数据拉取失败只显示「获取失败」，无重试入口 | 用户无法在此处恢复，只能整页刷新 | 加「重试」按钮 |
| F3-31 | `frontend/src/components/ProductDetails.tsx:53,90` | H02 / H04 | 中 | 中文界面内使用英文大写 eyebrow「Verification Result」（:53），详情字段标签用 `uppercase tracking-[0.18em]`（:90）排版英文风格 | 中文语境下出现英文标题，术语不统一 | 改为中文标题（如「验证结果」） |
| F3-32 | `frontend/src/components/TtsGenerationManager.tsx:371-375,396-399` | H01 / H09 | 中 | 错误块无 `role`、无重试；空态只有一句「暂无 TTS 生成记录」，与是否应用了筛选无关 | 加载失败无恢复路径；筛选后为空与本来就没有记录无法区分 | 错误态加 `role="alert"` + 重试；空态区分「无记录」与「筛选无结果」并给清除动作 |
| F3-33 | `frontend/src/components/user-profile/PrivacyConsentPanel.tsx:511` | H02 | 低 | `title={entry.consentDocumentHash ?? '早期记录没有条文指纹'}`——hover 会向用户展示原始条文指纹 hash 字符串 | 用户看到一串无意义的哈希，属内部标识外泄 | 移除该 title，或改为「条文指纹与本机记录一致/不一致」的说明文案 |
| F3-34 | `frontend/src/components/user-profile/PrivacyConsentPanel.tsx:281-286` | ♿ / H01 | 低 | 撤回/删除成功后的 notice 为裸 `div`（绿色），无 `role="status"` | 屏读用户得不到「操作已生效」的播报 | 补 `role="status" aria-live="polite"` |
| F3-35 | `frontend/src/components/ProductDetails.tsx:84-91` | ♿ | 低 | `<dt>`/`<dd>`（:90-91）直接放在普通 `<div>` 内，外层不是 `<dl>` | 屏读用户听不到「标签—取值」的语义配对 | 把容器换成 `<dl>`，或改用普通元素并保证可访问名 |
| F3-36 | `frontend/src/components/user-profile/DeviceSessionsPanel.tsx:42-44` | H02 | 低 | `FAILED_LOCATION_SENTINELS` 把 `未找到位置`/`获取位置时出错` 与 `未知` 一起折叠为「未知」 | 定位查询**失败**与**没有记录**显示完全相同，用户无法判断是没查到还是查不到 | 失败态单独文案（如「定位失败」），与「未知」区分 |
| F3-37 | `frontend/src/components/PromptModal.tsx:132-139` | ♿ / B07 | 低 | Esc 关闭只挂在输入框的 `onKeyDown` 上；焦点不在输入框时按 Esc 无效，弹窗又无 dialog 语义兜底 | 焦点移出输入框后键盘用户无法用 Esc 关闭 | 在 document 层监听 Esc（参照 `confirm/ConfirmDialogProvider.tsx`） |
| F3-38 | `frontend/src/components/ProductQueryForm.tsx:305` | H04 | 低 | 导入弹窗顶部使用英文 eyebrow「Import URL」，同弹窗标题为中文「导入查询链接」 | 同一组件内中英混排，术语不统一 | 移除该 eyebrow 或改中文 |

## 已核实无缺陷的关键路径

- `frontend/src/components/confirm/ConfirmDialogProvider.tsx`：`role="dialog"` + `aria-modal` + `aria-labelledby`/`aria-describedby`，document 级 Esc，默认聚焦取消按钮，`previouslyFocusedRef` 做焦点回归——是全仓自研弹窗的**正确范式**（F3-11/F3-15/F3-25/F3-37 建议向它对齐）。
- `frontend/src/components/ManagedCaptcha.tsx`：加载文案「正在加载人机验证…」、错误 `role="alert"` + 重试、通过后 `role="status" aria-live="polite"`，三态齐备（缺陷在调用方 TTSForm 的无条件外壳，见 F3-05）。
- `frontend/src/components/MobileNav.tsx`：`aria-label`/`aria-haspopup`/`aria-expanded`/`aria-controls`、Esc 关闭 + 焦点回归、`role="dialog" aria-modal` 均正确。
- 跳转链接目标 `#app-main-content` 在 `DesktopShell.tsx:145-153` 与移动端外壳分支**均存在**（`role="main" tabIndex={-1}`），跳过导航可用。
- `frontend/src/App.tsx` 路由加载壳（`RouteLoadingShell`）具备 `role="status" aria-live="polite" aria-busy="true"`；`NotFoundPage` 提供「返回上一页」+「回到首页」双出口。
- `speech-to-text/SpeechToTextPage.tsx` 的任务取消/重试/删除均有影响说明式确认，进度用百分比 + 中文阶段标签。
- `user-profile/PrivacyConsentPanel.tsx`、`user-profile/DeviceSessionsPanel.tsx`、`user-profile/SecurityScorecardPanel.tsx` 三面板均有 `aria-busy`、加载态、错误态 + 重试，加载/空/错误/成功四态齐备（其残留问题仅 F3-27/F3-29/F3-33/F3-34/F3-36）。
