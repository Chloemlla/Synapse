# 前端组件静态审计：fe-comp-2（2026-10-07，阶段性报告）

基线：`main` / `15f6c1a2`。本组审查按用户「停止审查、进入修复」的新指令提前结束；以下仅收录停止前已读代码形成的结论。未修改源码、未构建/测试/lint、未运行应用。全部路径相对仓库根目录。

## 1. 缺陷清单

| ID | 严重度 | 类别 | 位置 file:line | 症状与根因 | 证据（不超过 3 行） | 建议改法 |
| --- | --- | --- | --- | --- | --- | --- |
| fe-comp-2-01 | 阻断 | 破坏性操作确认反转 | `frontend/src/components/FBIWantedManager.tsx:295` | 超管点击「删除所有记录」后，在确认框选择取消、Esc 或关闭，反而执行全表删除；选择确认却退出。确认布尔值判断写反，后端无额外确认。 | `if (ok) { return; }` 后才 DELETE `/api/fbi-wanted/multiple`；`:583` 传 filter={}；`src/controllers/fbiWantedController.ts:589` 接受对象并在 `:625` 附近 `FBIWantedModel.deleteMany(safeFilter)`，空过滤即全表。 | 改为 `if (!ok) return`，并核对取消/Esc/遮罩均不发请求、确认才发请求。优先修复。 |
| fe-comp-2-02 | 中 | 筛选分页 / 恢复路径缺失 | `frontend/src/components/FBIWantedManager.tsx:104`、`:541`、`:734` | 在第 2 页以上筛选出不足一页结果时，仍向后端请求旧页，出现空列表；totalPages≤1 时分页入口整体隐藏，用户无法返回第一页查看实际命中项。 | 搜索/状态/危险等级 onChange 只改筛选；fetch 始终传 currentPage；分页只在 `totalPages > 1` 渲染。 | 筛选改变时同步置 page=1，合并为一致查询状态；删除/结果缩短时也钳制页码。 |
| fe-comp-2-03 | 中 | 跨记录陈旧图片 | `frontend/src/components/FBIWantedManager.tsx:190`、`:214`、`:240`、`:593` | 为 A 上传照片后创建成功或通过右上角关闭，再创建/编辑 B，旧 pendingPhoto 仍优先写入 B。成功创建只清 formData，打开创建/编辑也不清照片状态。 | 创建成功 `:214-218` 未清 pendingPhoto/photoPreview；编辑 body 使用 `pendingPhoto || ...`；创建按钮只 setShowCreateModal(true)。 | 每次打开、取消和成功结束编辑会话统一 reset 图片草稿；将图片状态绑定当前编辑对象。 |
| fe-comp-2-04 | 低 | 受控字段输入丢失 | `frontend/src/components/FBIWantedManager.tsx:939` | 创建表单提示多个罪名用逗号分隔，但键入第一个罪名后的逗号立即被清除，无法正常继续键入第二项，只能一次粘贴完整列表。 | input value 为 `charges.join(', ')`；onChange split/trim 后 filter 空项，因此末尾分隔符不能留在输入值里。 | 草稿保留原始字符串，失焦或提交时再 split/trim/filter。 |
| fe-comp-2-05 | 中 | 缓存串用 / 错误配额展示 | `frontend/src/components/EmailSender.tsx:328` | 30 秒内切发件域名 A→B→A，界面保留 B 配额却已选择 A。所谓缓存只记录拉取时间，命中时直接 return，未保存或恢复 A 数据。 | `quotaCacheRef` 类型 Record<string,number>；`:337-340` 命中跳过请求；全部域名响应共用 setQuota。 | 按域名缓存配额数据与时间；切换时恢复该域名数据；响应提交前核对当前域名，失败不记录成功缓存时间。 |
| fe-comp-2-06 | 中 | 进行中编辑被清空 | `frontend/src/components/EmailSender.tsx:472` | 发送 A 邮件期间输入新的收件人、主题或正文，A 成功回包后把新草稿一起清空。只有发送按钮禁用，输入与模式切换仍可编辑，而成功处理无条件重置全部表单。 | `:475-483` setForm 与 setSimpleContent/setMarkdownContent 清空；`:1055,1070,1098,1159,1172,1181` 输入无 loading 禁用；sendingRef 只防重发。 | 发信中锁定该草稿，或保存提交版本，仅当草稿仍等于发送快照时清空；保留之后的新编辑。 |
| fe-comp-2-07 | 中 | 卸载后延迟导航 | `frontend/src/components/EmailVerifyPage.tsx:72`、`:91` | 邮箱验证成功后用户在 3 秒内前往其他页面，旧组件定时器仍把用户强制带回登录页；网络请求离开后完成也可能触发该跳转。 | 成功 `setTimeout(() => navigate('/login'),3000)` 无句柄；effect cleanup 仅清请求超时计时器，没有 controller.abort 或取消标记。 | 清理导航 timer；卸载 abort 并忽略后续回调；只有当前验证页面仍活动才跳转。 |
| fe-comp-2-08 | 中 | 共享 Response 被重复消费 | `frontend/src/components/Footer.tsx:56`、`:139`、`:201` | Footer 在请求未完成时卸载再挂载（例如外壳切换）会复用同一个 Response。旧实例仍先调用 json()，新实例再次解析抛 body-already-used，IP 显示失败、版本回退默认。 | 去重缓存的是 `Promise<Response>`；每个消费者各调用 `response.json()`（`:154,209`）；cancelled 判断在解析之后（`:169,217`）。 | 去重 Promise 应返回已经解析的业务对象，或每位消费者先 clone Response；取消实例在消费响应前退出。 |
| fe-comp-2-09 | 中 | 用户详情请求竞态 | `frontend/src/components/FingerprintManager.tsx:208` | 连续查看 A、B 用户指纹，A 慢响应后到会把已经选中的 B 替换回 A，右侧清空/上报动作随之切换目标，界面与最后点击意图不一致。 | 请求前 setSelectedUser(user)，完成后 `setSelectedUser(response.data.user)` 无 id/版本判定；左表「查看」加载时仍可点击。 | 详情按 userId/请求版本关联，旧响应不覆盖当前选择；切换时 abort 旧请求。 |

## 2. 已核对区域

- FBI 批删已追到路由与控制器：`src/routes/fbiWantedRoutes.ts:95` 的 `/multiple` 与 `fbiWantedController.deleteMultiple`；不是只凭前端推测会删除。历史 2026-10-03 的相似确认反转 F5-01 位于 LogShare，未覆盖 FBIWantedManager，本条是另一可达路径。
- 已读的 EmailSender 发送路径有 sendingRef 防重复；本次 06 是发送中允许编辑但成功清空新草稿，与旧 G11-10 防重问题不同。
- 原生 fetch 的全局 IP 头补充已由 fe-comp-1 核查，不重复报组件没加 IP 头。
- `FirstVisitVerification`、`ForgotPasswordPage`、`GoogleAuthButton`、`HCaptchaWidget` 读取固定提交 `15f6c1a2`；Google 处罚响应已有 maybeEmitPenaltyAppealFromResponse，不报申诉入口遗漏。
- 历史查重沿用 `docs/audit/audit-2026-10-03-*.md`、`audit-2026-10-04-ip-risk.md`；旧 F2-38/39、F5-15/17/34/36/38/41、F4-19 已修内容不重复列入。
- 跨组去重：LogShare 导入存储事务/吞错由 `fe-api-08` 负责；登出后指纹请求状态残留由 `fe-api-09` 负责，本组不重复登记。

## 3. 存疑（不算确认）

- HTML 多收件人批量发送未传 skipWhitelist，但尚未核对批量端点是否支持同一契约，停止审查后不再扩大验证。
- GitHubBillingDashboard 每个缓存客户行的「查看」均调用不带 customerId 的默认账单查询；未核对后端是否支持指定客户及实际多客户配置，暂不列确认项。
- Google 登录裸 fetch 无组件超时，hCaptcha 加载器/不可见尺寸执行、ForgotPassword 验证失败后一次性 token 重用，以及 FirstVisit 过期回调终态判定，均需继续按完整调用链核查；并发会话也正在修改这些文件，未形成新确认项。
- FBIWantedPublic/账单缓存的浏览器存储异常分支值得继续检查，但本次未进一步验证，不计入确认条数。

## 4. 覆盖面

审查提前结束，**不能将本报告视为 fe-comp-2 全组审完**。已读取以下 18 个清单文件的代码，其中通常省略纯 className、SVG path、动画、重复静态布局文字输出；非视觉审计：

- 主要逻辑和交互已读取：`frontend/src/components/EmailSender.tsx`、`EmailTraceability.tsx`、`EmailVerifyPage.tsx`、`ErrorDisplay.tsx`、`EstablishSecuritySession.tsx`、`FBIWantedManager.tsx`、`FBIWantedPublic.tsx`、`FingerprintRequestModal.tsx`、`FirstVisitVerification.tsx`、`Footer.tsx`、`ForgotPasswordPage.tsx`、`GitHubBillingCacheManager.tsx`、`GitHubBillingDashboard.tsx`、`GoogleAuthButton.tsx`、`HCaptchaWidget.tsx`（除首个外均同目录）。
- 部分读取，输出截断的展示/辅助段尚未补全：`frontend/src/components/EnvManager.tsx`（主体配置/请求/编辑逻辑已读）、`FingerprintManager.tsx`（主体请求与操作已读，部分详情渲染段未补齐）、`FinanceAppDemo.tsx`（演示图表和交互段部分读取；未对静态演示功能按真实记账系统报错）。EmailSender 部分静态展示段也未补读，不宣称逐行视觉覆盖。

**以下 17 个文件尚未开始逐文件审查，原因均为用户切换到修复阶段要求立即停止：**

`frontend/src/components/HomeHub.tsx`、`ImageUploadPage.tsx`、`ImageUploadSection.tsx`、`IPBanManager.tsx`、`LegacyApiChoicePage.tsx`、`LibreChatAdminPage.tsx`、`LibreChatContext.tsx`、`LibreChatGuestCleanup.tsx`、`LibreChatPage.tsx`、`LibreChatRealtimeDialog.tsx`、`LinuxDoAuthButton.tsx`、`LinuxDoAuthCallbackPage.tsx`、`LoadingSpinner.tsx`、`LoginPage.tsx`、`LogShare.tsx`、`LotteryAdmin.tsx`、`LotteryPage.tsx`（除首个外均同目录）。

额外只读：FBI 路由/控制器删除链；历史报告查重。所有确认项为静态代码路径结论；无浏览器输入/焦点/触摸验证，无真实 API 删除/发信测试。

并发变动：停止时工作树存在另一会话修改的 `FirstVisitVerification.tsx`、`ForgotPasswordPage.tsx`、`HCaptchaWidget.tsx`、`ImageUploadPage.tsx`、`LoginPage.tsx`、`LotteryPage.tsx` 及验证码/传输相关依赖。此报告基线仍固定旧 HEAD，不把这些未提交修改视为本组修复；未触碰或回滚它们。

