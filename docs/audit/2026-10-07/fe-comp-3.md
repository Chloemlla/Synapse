# 前端组件静态审查：fe-comp-3（2026-10-07）

基线：`main` / `15f6c1a2`。范围为工作区 `fe-comp-3.txt` 的 42 个文件。仅静态阅读，没有运行构建、测试、lint、依赖安装或应用。审查期间发现另一会话正在修改验证码相关源码；以下位置和判断以基线为准，不把在飞修复当作已验证结果。用户要求停止审查、进入修复时立即冻结本报告。

## 1. 缺陷清单

| ID | 严重度 | 类别 | 位置 file:line | 症状与根因 | 证据（不超过 3 行） | 建议改法 |
| --- | --- | --- | --- | --- | --- | --- |
| fe-comp-3-01 | 高 | 响应契约 / 静默空列表 | `frontend/src/components/ShortLinkManager.tsx:99`；`src/routes/admin/shortlinks.ts:62` | 管理员进入短链管理，即使数据库有短链也始终显示空列表。服务端返回加密包，页面却当成明文分页对象读取，`decryptAES256` 只是未调用的遗留函数；导出、删除等依赖列表非空的入口也被禁用。 | 前端 :105–108 读 `data.total` / `data.items`；后端 :76–79 返回 `{success:true,data:encrypted,iv}`；全局 fetch 包装仅做 IP 验证处理，不解密。 | Web 会话已使用 HttpOnly Cookie，优先让受保护列表直接返回 `{total,items}`，同步删除失效的客户端解密约定；检查 HTTP 状态并给出独立错误态。 |
| fe-comp-3-02 | 高 | 失败降级 / 配置覆盖 | `frontend/src/components/MailSystemConfigManager.tsx:179`、`:232`；`frontend/src/components/RuntimeConfigSections.tsx:495`、`:923` | 首次加载失败后，邮件配置和管理员安全配置仍允许保存初始值。管理员恢复网络后填写一个字段并保存，会把邮件启用状态或公共短链开关写成 false，并覆盖配额等线上配置。RuntimeConfig 仅 IPQS 实施了加载失败禁止保存，其他分区未沿用。 | Mail :206–212 只通知并结束 loading，:334 保存不检查加载结果；Runtime :516–523 同形，:1083 只检查 saving/权限；后端 `setEmailSetting` / `setAdminSecuritySetting` 接受显式 false。 | 各分区分别保留 loaded/error 状态，首次失败时阻止保存；从最后成功快照生成差量载荷，重试成功后才开放提交。与历史 F4-08 的 IPQS 问题同族，但本次是尚未覆盖的分区。 |
| fe-comp-3-03 | 高 | 草稿丢失 | `frontend/src/components/MarkdownArticleManager.tsx:157`、`:198` | 编辑已有文章后直接点击列表里的另一篇，未保存正文、标题和摘要被覆盖，没有确认、撤销或本地副本。历史 F5-06 只给“新建”加了确认，切换文章仍绕过保护。 | :198–203 `getAdmin` 后直接 `setCurrent(result.article)`；:378 列表按钮直接调用；:159–162 仅新文章保存本地草稿，已有文章删除草稿。 | 以原始文章快照计算 dirty；切换文章先保存/丢弃确认，或按文章 ID 保留编辑草稿。 |
| fe-comp-3-04 | 高 | 请求竞态 / 编辑覆盖 | `frontend/src/components/MarkdownArticleManager.tsx:198`、`:230`、`:261` | 保存等待期间仍可输入或切文章；晚到保存响应无条件替换当前编辑器，丢掉提交之后输入的内容或刚打开的另一篇。快速选择 A、B 时也可能由较晚返回的 A 把 B 覆盖。Ctrl+S 直接调用无忙碌守卫的保存函数，使在途保存还可继续叠加。 | :250 无条件 `setCurrent(result.article)`；:419/:440/:506 编辑框只按权限禁用；:265 快捷键调用保存、:231 无 isSaving 判断，详情请求无序列检查。 | 给详情和保存操作绑定文章 ID/编辑版本与请求序号；仅更新匹配快照，保留保存期间新增编辑；统一同步单飞守卫，明确保存中的切换策略。 |
| fe-comp-3-05 | 中 | 第三方组件契约 | `frontend/src/components/MarkdownRenderer.tsx:307`、`:314` | 行内反引号代码也被渲染成带工具栏的块级代码框，破坏段落布局，影响文章、聊天和预览等共享调用方。使用的 react-markdown 10 不再提供旧版 `inline` 参数，`undefined !== true` 恒成立。 | `frontend/package.json:70` 为 `react-markdown:^10.1.0`；renderer :307 读取自行声明的可选 inline；:314 `const isBlockCode = inline !== true`。 | 在 `pre` 渲染器处理围栏/缩进代码块，`code` 默认处理行内代码；避免依赖已移除的额外属性。 |
| fe-comp-3-06 | 高 | 导出内容结构损失 | `frontend/src/components/MarkdownExportPage.tsx:127`、`:191`、`:280`；`frontend/src/components/MarkdownRenderer.tsx:419` | DOCX 导出时，多段正文、标题、列表和表格被归并成一个段落，标题级别和列表/表格结构分支实际上不可达。导出器只分派临时容器的直接子节点，但其唯一实质子节点是 MarkdownRenderer 的外层 div。 | export :128 复制完整 renderer DOM；:191 仅遍历 `tempDiv.childNodes`，:280–283 div 递归收集 TextRun 后只建一个 Paragraph；renderer :420 外包 div。 | 从实际 Markdown 内容根节点遍历块结构，递归保留块边界；跳过复制标题按钮、代码工具栏等 UI 节点，并明确表格/公式导出语义。 |
| fe-comp-3-07 | 中 | 输入引发运行时异常 | `frontend/src/components/RegisterPage.tsx:125`、`:149` | 邮箱和密码已填写时，把用户名编辑为 `[`、`(` 或尾随反斜杠，会在密码强度 effect 中直接抛 SyntaxError，注册表单进入错误边界或中断。输入框的 pattern 只参与提交校验，不能保护逐次输入 effect。 | :125 `new RegExp(username,'i')`；:149–152 effect 在非空用户名/邮箱/密码时调用；:249 onChange 接受未校验输入。 | 用户名包含检查改为大小写归一后的字符串 includes，或完整转义正则字面量；无效用户名编辑期间仍应安全显示表单。 |
| fe-comp-3-08 | 中 | 分页状态错配 | `frontend/src/components/ResourceStoreManager.tsx:451`、`:486` | 从第 2 页返回第 1 页时，页码变成 1，但数据仍是第 2 页；随后首页按钮被禁用，用户只能刷新纠正。 | :453 仅 `currentPage > 1` 时 fetch；:488 只 setCurrentPage；:918/:933 的首页/上一页共用该路径。 | 用一个依赖 currentPage 的 effect 覆盖所有页码，包括 1；删除独立首次重复加载 effect。 |
| fe-comp-3-09 | 高 | 管理接口选型 / 操作失去入口 | `frontend/src/components/ResourceStoreManager.tsx:458`；`src/services/resourceService.ts:31` | 管理员把资源设为停用后，资源从管理列表消失，再无入口重新启用或编辑；新增停用资源同样不可见。管理页复用了仅公开上架资源的列表接口。 | manager :462 调 `resourcesApi.getResources(page)`；同组件编辑表单 :367–372 支持 isActive=false；service :31 固定 `{isActive:true}`。 | 增加受管理员授权的资源列表能力并明确 active/all 筛选，管理页使用它；保持公开商店只返回上架资源。 |
| fe-comp-3-10 | 中 | 分页遗漏 | `frontend/src/components/ResourceStoreList.tsx:129`、`:627` | 商店或任一分类超过 10 个资源后，较早资源不可浏览，页面把第一页数量当作“在架资源”总数；没有翻页或加载更多入口。 | :131 固定 `getResources(1,selectedCategory)`；:629 只渲染返回数组；`resourceService.ts:22,37` 固定 pageSize=10 并 limit。 | 保存 total/page/pageSize，提供翻页或加载更多；指标使用 total。与 fe-comp-1-07 的 CDK 资源选择器是不同调用入口。 |
| fe-comp-3-11 | 中 | 滚动容器契约 | `frontend/src/components/PolicyPage.tsx:143`；`frontend/src/components/MarkdownArticlePage.tsx:95`；`frontend/src/layout/DesktopShell.tsx:145` | 已登录桌面布局中，滚动政策或文章正文不会更新阅读进度、活动目录和阅读位置，政策“回顶部”也作用于错误容器。实际滚动的是桌面内容 pane，两个页面仅监听 window。 | DesktopShell :145–151 `#app-main-content` 为 `overflow-auto`；Policy :151/:178 读取 window.scrollY/监听 window；Article :102/:126 同形。 | 统一获取实际滚动容器，读取其 scrollTop/scrollHeight/clientHeight 并在其上监听、滚动；移动端保留 window 路径。 |
| fe-comp-3-12 | 低 | 持久化顺序 | `frontend/src/components/PolicyPage.tsx:143`、`:196` | 重新进入政策页时，上次读到的章节在恢复读取之前就被首屏进度 effect 改写成第一章，“继续阅读”入口通常不会出现。 | 前面的 effect :177 同步 `update()`，:166 写 LAST_SECTION；后面的 effect :203 才 `readStoredSection()`；:208 排除第一章。 | 在任何写入前捕获上次章节，初始化完成后再写新的阅读进度；不要把初次布局测量当作用户阅读进展。 |
| fe-comp-3-13 | 中 | 键盘关闭失效 | `frontend/src/components/Mermaid.tsx:168`、`:190` | 键盘打开图表放大层后，若先按 Tab/方向键再按 Escape，放大层不会关闭，且没有可聚焦的关闭按钮。监听器对任意第一次 keydown 都被 once 移除。 | :190–197 keydown `{once:true}`，仅 Escape 调 close；:173–181 纯 DOM div 层无关闭按钮；:189 只另设鼠标点击关闭。 | 保持具名 Escape 监听至关闭时再 remove，补关闭按钮与焦点管理；组件卸载也清理放大层。与历史 F5-08 的“放大入口不可达”不同。 |
| fe-comp-3-14 | 中 | 请求失败伪装空态 | `frontend/src/components/MarkdownArticlePage.tsx:78`、`:228` | `/articles` 的列表请求失败时显示“暂无已发布文章”，没有显示已记录的 error，也没有重试入口。只有带 slug 的详情路径检查 error。 | :83 写 error；:228 无 slug 分支先 return；:239 根据空数组显示空态，:262 error 分支在它之后。 | 列表分支独立渲染加载失败和重试，保留已成功的列表；仅成功且 articles 为空时显示空态。 |
| fe-comp-3-15 | 中 | 筛选请求竞态 | `frontend/src/components/NexAISecurityDashboard.tsx:142`、`:148` | 快速把时间范围从 30 天切到 1 小时，若 30 天请求较晚返回，它会覆盖当前 1 小时标签下的图表和指标；下一次定时刷新前统计口径错误。清 interval 不会取消已发出的请求。 | :146 effect 依赖 timeRange；:152 请求闭包带该范围；:157–159 无请求代次检查直接 setStats/setDevices/setEvents。 | 每轮请求使用 AbortController 或递增请求序号，只有匹配当前范围的响应可提交；刷新期间避免并行叠加。 |
| fe-comp-3-16 | 中 | 在途编辑生命周期 | `frontend/src/components/OAuthClientManager.tsx:248`、`:704` | 保存客户端 A 期间仍可通过行首编辑图标打开 B；A 完成后 `cancelEdit()` 无条件清掉 B 的新编辑表单，B 未保存输入丢失。下方“取消”虽禁用，行首切换入口没有同样保护。 | :274 保存完成调用 cancelEdit；:233–236 清 editingClientId/editForm；:706 行首编辑图标未 disabled 且可 beginEdit(B)。 | 保存期间统一禁用切换/关闭，或记录保存的 clientId、仅关闭仍属于 A 的编辑器；编辑数据按客户端 ID 隔离。 |
| fe-comp-3-17 | 低 | 派生状态失效 | `frontend/src/components/RegistrationInviteManager.tsx:173`、`:196`、`:252` | 创建、单项停用/修改或删除邀请码成功后，列表更新但顶部总数、可用数、剩余次数仍沿用旧 stats；直到手动刷新才纠正，运营人员会看到相互矛盾的配额。 | :185/:205/:262 只更新 invites；:119–120 仅 loadInvites 更新 stats；:310/:314/:332 优先展示 stats。 | 单项写入成功后重新获取聚合统计，或统一失效并刷新列表+stats，避免旧聚合值覆盖新本地列表。 |
| fe-comp-3-18 | 中 | 失败反馈错误 | `frontend/src/components/OutEmail.tsx:363` | 服务状态刷新收到 403/500 或解析失败时，页面仍提示“已刷新”，沿用旧的正常/异常状态，管理员无法判断状态数据是否更新。 | :367–375 仅 ok 且 payload 有效时更新；:377 无条件 success 通知；fetch 对 HTTP 错误不 reject。 | 非 2xx 或无效响应进入失败态，保留旧状态但标为过期；只有成功更新数据后通知刷新完成。 |

无超出 20 条的新增主缺陷。下面的跨报告重复项不重新编号：

- 验证码一次性令牌、成功后 terminal solved、失败重试和控件清理：另一会话的 [captcha-lifecycle 报告](../../audit-2026-10-07-captcha-lifecycle.md) 已列 `CAPTCHA-01`、`CAPTCHA-07` 等并正在修复。基线 RegisterPage 失败后不 reset、ResourceStoreList 仅清父级 token 的问题归入该报告，避免重报；后端字段映射错误也会先阻断启用验证码后的成功兑换，不能把所有下游分支当成当前独立可达。
- PasskeySetup 删除失败仍提示成功：`usePasskey.removeAuthenticator` 吞异常由协调者的 `fe-api` 报告登记（通知编号 `fe-api-04`），本组不重复统计。
- OutEmail 远程附件仍可突破 10 个后被 `.slice(0,10)` 截断：属于历史 `F5-28` 未完整覆盖的路径，修复时应同时检查 URL 输入，而非另计新发现。

## 2. 已核对区域

- 阅读了所有清单组件的状态声明、effects、事件处理器、完整 JSX 和条件分支；查看请求失败、loading/disabled、修改对象切换和成功收尾；普通静态 className 字符串在阅读输出中折叠，不据此做样式结论。
- 核对 App 的路由和 `Routes key={location.pathname}`，排除了 ResourceStoreDetail 因跨 pathname 复用状态而出现的竞态假设；ResetPasswordPage 旧验证码页面没有生产路由，不把其中问题作为独立可达缺陷。
- 核对 shared axios 的 15s timeout、幂等请求重试，global fetch 的 IP 验证包装和 signedFetch 的 Cookie 行为；它们不会替 ShortLinkManager 解密或把普通 HTTP 失败变成抛错。
- 核对文章读写 API、资源服务的分页和 isActive 条件、短链加密响应与删除全量操作、邮件和管理员安全配置写入、注册服务的验证码与邀请码顺序。
- PasskeySetup 只检查平台认证器不是本次确认缺陷：服务端注册明确 `authenticatorAttachment: 'platform'`，不能据此声称应支持 USB 安全密钥。
- ModListPage 明确临时屏蔽 ModListEditor，后者虽完整阅读但未把未接线行为列为当前用户可触发缺陷。MusicPlayerDemo / MeditationAppDemo 明确是 UI 演示，不把静态示例、未接业务按钮或模拟数据视作生产功能缺失。
- 历史查重覆盖 `audit-2026-10-03-ui-{tools,admin,core,auth-2fa}.md`、`audit-2026-10-03-medium-low.md`、`legacy-codebase-report.md`，并对 `docs/audit` 检索相关文件名及根因；已修复的标签、角色说明、普通错误态等未重复列入。

## 3. 存疑（不算确认）

- **短链全量删除的确认范围错配，当前被 fe-comp-3-01 遮蔽。** `ShortLinkManager.tsx:442` 用当前页 `links.length` 告知删除数量，:443 明称“当前列表范围”；实际 :450 发无 filter 的 `/api/shorturl/admin/deleteall`，后端 `shortUrlService.ts:549` 是 `deleteMany({})`。基线列表恒空使该按钮 disabled，故不当作当前可点击的新主缺陷；修复列表时必须同时纠正确认范围，否则会扩大用户预期删除范围。成功通知 :464 还从顶层取 deletedCount，而控制器把它包在 data 内，应一并对齐。
- **MeditationAppDemo 动画生命周期。** 父 effect :87–328 只运行一次且未取消 rAF，而 canvas 位于初始 hidden 的 Activity 内。是否是初始化时 refs 为空导致后续无动画、或已启动画面卸载后仍绘制，取决于 React 19 Activity 实际挂载时序；本次未运行应用，不在确认数内。
- **短信/旧密码页面及其它无生产入口路径。** 仅保留完整阅读结果，不因测试引用或孤立组件函数可调用，就断言生产用户可触发。

## 4. 覆盖面

以下 42 个文件均完整阅读，目录前缀均为 `frontend/src/components/`：

```text
MailSystemConfigManager.tsx
ManagedCaptcha.tsx
MarkdownArticleManager.tsx
MarkdownArticlePage.tsx
MarkdownExportPage.tsx
MarkdownPreview.tsx
MarkdownRenderer.tsx
MeditationAppDemo.tsx
Mermaid.tsx
MobileLoginPanel.tsx
MobileNav.tsx
ModalPortal.tsx
ModListEditor.tsx
ModListPage.tsx
MusicPlayerDemo.tsx
NexAISecurityDashboard.tsx
Notification.tsx
NotificationTestPage.tsx
OAuthAuthorizePage.tsx
OAuthClientManager.tsx
OAuthOidcEndpointPanel.tsx
OutEmail.tsx
PasskeySetup.tsx
PasskeyVerifyModal.tsx
PenaltyAppealActions.tsx
PenaltyAppealHost.tsx
PolicyConsentChecklist.tsx
PolicyPage.tsx
ProductDetails.tsx
ProductQueryForm.tsx
PromptModal.tsx
ProviderBindPage.tsx
PublicShortLinkCreator.tsx
RegisterPage.tsx
RegistrationInviteManager.tsx
ResetPasswordLinkPage.tsx
ResetPasswordPage.tsx
ResourceStoreDetail.tsx
ResourceStoreList.tsx
ResourceStoreManager.tsx
RuntimeConfigSections.tsx
ShortLinkManager.tsx
```

只读关联核查（相关区段，并非全文件审计）：`frontend/src/App.tsx`、`layout/DesktopShell.tsx`、`api/resources.ts`、`api/api.ts`、`utils/ipVerification.ts`、`utils/requestSigner.ts`、`frontend/package.json`；后端 `routes/admin/shortlinks.ts`、`routes/shortUrlRoutes.ts`、`routes/admin/config.ts`、`controllers/resourceController.ts`、`controllers/shortUrlController.ts`、`controllers/adminController.ts`、`controllers/auth/registrationHandlers.ts`、`controllers/auth/passwordResetHandlers.ts`、`services/resourceService.ts`、`services/shortUrlService.ts`、`services/runtimeConfigService.ts`、`services/cdkService.ts`、`services/passkeyService.ts`。

未跳过清单中的组件文件；未展开第三方库源码、所有后端实现、真实数据库内容或浏览器布局。读取时先核查 frontend 子目录 AGENTS/CLAUDE，未发现额外子级规则。后续校验应针对修复后的提交由 GitHub Actions 完成；本报告中的静态推导不表示运行验证通过。
