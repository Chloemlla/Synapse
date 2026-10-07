# 前端组件、管理面板与功能模块修复处置

范围：`fe-comp-3` 18 项、`fe-admin` 8 项、`fe-features` 8 项，共 34 项。基于独立 worktree `Synapse-audit-all-20261007`，保留已存在的验证码生命周期修复。本组没有新增审查编号，没有运行本地构建、类型检查、测试、lint 或安装依赖，也没有暂存、提交或推送。

下表“已修复”表示修复已落盘并逐项静态核对，**不表示 CI 已通过**。CI 运行与最终提交由协调者记录。

| 编号 | 状态 | 文件（均相对 frontend/src/components） | 处置原因与结果 | 验证 / 局限 |
| --- | --- | --- | --- | --- |
| fe-comp-3-01 | 已修复（前后端协同） | ShortLinkManager.tsx | 受保护的 `/api/admin/shortlinks` 按 Cookie 会话明文 `{items,total}` 校验并消费；移除无效客户端解密。失败独立展示并可刷新。删除确认明确全站所有页面、用户、筛选外记录，返回数量读取 `data.deletedCount`。 | 后端 Cookie/Bearer 分支由 controllers 组修改；本组静态核对消费形状，待 CI 与浏览器验证。 |
| fe-comp-3-02 | 已修复 | MailSystemConfigManager.tsx、RuntimeConfigSections.tsx | 邮件与全部运行时分区保存必须持有本轮成功读取的配置，加载中或首载失败禁用保存与相关输入。失败提示保留刷新入口；邮件、管理员开关按成功快照生成差量，避免默认值覆盖。 | 静态检查每个保存入口及 callback 依赖；无本地运行。 |
| fe-comp-3-03 | 已修复 | MarkdownArticleManager.tsx | 保存原始文章快照，按真实差异判断 dirty；切换现有文章与新建均确认放弃未保存内容。 | 新增取消切换后保留输入用例；待 CI。 |
| fe-comp-3-04 | 已修复 | MarkdownArticleManager.tsx | 详情响应按请求代次接收。保存用同步 ref 单飞，保存时禁用编辑、切换与新建；发布状态更新仅合并状态，不覆盖正文草稿。 | 新增 A/B 乱序详情和重复 Ctrl+S 用例；待 CI。 |
| fe-comp-3-05 | 已修复 | MarkdownRenderer.tsx | `code` 只渲染行内代码，`pre` 负责围栏及缩进块，不读取 react-markdown 已移除的 inline 属性。 | 新增行内代码段落与围栏工具栏行为用例；待 CI。 |
| fe-comp-3-06 | 已修复 | MarkdownExportPage.tsx、MarkdownRenderer.tsx | 从实际 Markdown 内容根提取 DOM；展开结构容器、过滤标题/复制按钮，将高亮代码还原正文，标题/段落/列表分别写入，表格生成 DOCX Table。公式沿用明确的文本占位语义。 | 静态核对块分派和 docx 类型；复杂公式、嵌套列表及版式仍需 CI/人工打开导出件验证。 |
| fe-comp-3-07 | 已修复 | RegisterPage.tsx | 用户名相似密码检测改为大小写归一字符串 includes，任意编辑字符不再创建正则。 | 静态核对仅修改密码强度条件，保留当前验证码修复。 |
| fe-comp-3-08 | 已修复 | ResourceStoreManager.tsx | 统一页码 effect 包含第 1 页，删除重复首次加载路径。 | 静态核对首页/上一页共用状态流；待 CI。 |
| fe-comp-3-09 | 已修复（前后端协同） | ResourceStoreManager.tsx | 改用协调者新增的 `resourcesApi.getAdminResources` → `/api/resources/admin`，管理员列表包含停用资源，公开商店仍只展示上架资源。 | API/service 由协调者、controller/routes 由后端组落盘；待 CI。 |
| fe-comp-3-10 | 已修复 | ResourceStoreList.tsx | 保存总数与分页大小，增加上一页/下一页；分类切换回第一页，总数指标读取 total，请求代次阻止旧页覆盖新页。 | 静态核对分页和验证码代码共存；待 CI/浏览器。 |
| fe-comp-3-11 | 已修复 | PolicyPage.tsx、MarkdownArticlePage.tsx、policy/readingScrollContainer.ts | 依据实际 overflowY 识别桌面内容 pane；进度、目录阈值、监听与回顶部使用同一容器，移动文档仍使用 window。 | 静态对照 DesktopShell 与移动 App 同名容器的不同 overflow；浏览器布局待验证。 |
| fe-comp-3-12 | 已修复 | PolicyPage.tsx | mount 时先捕获上次阅读章节；首次布局测量不写阅读位置，滚动后才持久化，避免恢复入口被覆盖。 | 静态核对 effect 顺序；待 CI/浏览器。 |
| fe-comp-3-13 | 已修复 | Mermaid.tsx | 放大层有可聚焦关闭按钮，Escape 持续监听直到关闭；Tab 圈定，关闭恢复焦点，卸载清理层和监听器。 | 静态核对 Tab 后 Escape 与卸载路径；待浏览器。 |
| fe-comp-3-14 | 已修复 | MarkdownArticlePage.tsx | 列表请求错误独立显示并提供重试；只有成功且空列表时显示“暂无文章”。 | 静态核对无 slug 分支；待 CI。 |
| fe-comp-3-15 | 已修复 | NexAISecurityDashboard.tsx | 每次刷新分配代次，切时间范围清理时使旧代次失效；旧响应与旧错误都不得写当前指标。 | 静态核对成功和失败两条异步路径；待 CI。 |
| fe-comp-3-16 | 已修复 | OAuthClientManager.tsx | 保存期间禁止行首切换/取消编辑；beginEdit 与重复保存另有处理函数守卫。 | 静态核对行首和表单两处入口；待 CI。 |
| fe-comp-3-17 | 已修复 | RegistrationInviteManager.tsx | 单项创建、修改、删除后清旧聚合并独立刷新统计，不通过全列表回读覆盖其他行的未保存草稿。 | 静态核对三类写入；统计失败保留提示及本地列表派生值。 |
| fe-comp-3-18 | 已修复 | OutEmail.tsx | 非 2xx、解析失败、缺少 available 布尔值均失败；仅有效状态更新后通知成功，失败将旧状态标为未刷新。 | 静态核对 HTTP 及无效 JSON 分支；待 CI。 |
| fe-admin-01 | 已修复 | admin/AdminScopeManager.tsx | 需要成功 setting 且无读取错误才可添加覆盖、编辑或保存；初始空数组不能写回授权。保留失败重试。 | 静态核对 save/add 和各编辑控件；跨账号缓存 fe-api-01 由协调者处理。 |
| fe-admin-02 | 已修复 | admin/MediaToolAdmin.tsx | 探测请求绑定递增代次，切目标、卸载使旧请求失效；只接受当前探测的成功、失败和结束状态。 | 静态核对 debounce cleanup 与手动探测；待 CI。 |
| fe-admin-03 | 已修复 | admin/media-tool/JobsPanel.tsx | 重试用返回 job 替换详情并清 transcript，再回读；轮询优先列表状态，终态切换也回读，详情请求按任务代次接收。 | 静态核对终态→queued→终态；待 CI。 |
| fe-admin-04 | 已修复 | admin/MediaToolAdmin.tsx、admin/media-tool/SettingsPanel.tsx、admin/media-tool/JobsPanel.tsx | 父级按独立后端或 superadmin 计算 canManage，内置普通管理员配置 fieldset 只读、删除禁用；处理函数也校验，任务创建/取消/重试沿用现有权限。 | 静态对照后端权限；需 CI/双运行模式验证。 |
| fe-admin-05 | 已修复 | admin/CaptchaProviderAdmin.tsx | 独立保存/删除 trycap 凭据仅回读 capConfig，不再 applyOverview 覆盖供应商、策略和外观草稿。 | 静态核对两个凭据成功分支；原验证码生命周期修复保留。 |
| fe-admin-06 | 已修复 | admin/media-tool/JobsPanel.tsx | 展开改成真实 button，带 aria-expanded/controls，操作按钮为同级，键盘可进入详情。 | 静态核对 DOM 不嵌套操作按钮；待浏览器。 |
| fe-admin-07 | 已修复 | admin/MobileTokenLineagePanel.tsx | 时间线订阅 refreshNonce，刷新使用已提交查询；编辑中的输入不改变当前自动刷新目标。 | 静态核对保存查询与输入状态分离；待 CI。 |
| fe-admin-08 | 已修复 | admin/MediaToolAdmin.tsx | 面板 key 只绑定目标，同目标探测保留 health 与草稿；首次连接成功前显示等待状态，让面板首次以真实设置初始化。 | 静态核对无 h0/h1 key、重复探测不卸载；待浏览器。 |
| fe-features-01 | 已修复 | env-manager/SelfContainedRegistrationInviteConfigSection.tsx、env-manager/RegistrationInviteConfigSection.tsx | loaded/error 三态；读取成功且 required 为布尔值才允许保存，未知状态不显示“邀请码可选”；失败可刷新。 | 新增失败后禁写和成功重试恢复用例；待 CI。 |
| fe-features-02 | 已修复 | env-manager/RevealKeysSection.tsx | 关闭、会话变化/失效、主动结束与轮换使揭示请求代次失效并清明文；响应还需匹配当前令牌、展开及活跃状态。 | 静态核对所有清除和晚到响应路径；待 CI。 |
| fe-features-03 | 已修复 | speech-to-text/SpeechToTextPage.tsx | 展开的详情随任务列表刷新重取，不把运行中的空数组视为永久缓存；每任务响应序号防止旧空结果覆盖终态正文。 | 新增运行空结果→完成正文的轮询用例；待 CI。 |
| fe-features-04 | 已修复 | speech-to-text/SpeechToTextPage.tsx | 上传期间禁用提交且处理函数守卫；提交捕获路径快照，仅从队列移除本次已提交路径。 | 新增第二文件在途时禁提交、最终两个一起提交用例；待 CI。 |
| fe-features-05 | 已修复 | speech-to-text/SpeechToTextPage.tsx | 捕获 File[] 后立即清空 file input，失败/移除后选择相同文件仍触发 change。 | 上传用例断言 input.value 清空；真实文件选择器需浏览器。 |
| fe-features-06 | 已修复 | ip-ban/BanListPanel.tsx | 查询请求代次校验成功、错误、loading，条件切换清选择；筛选处理时批量重置页码，移除额外页码 effect。 | 静态核对 URL 初始页码保留、乱序不会写结果；待 CI。 |
| fe-features-07 | 已修复 | ticket/TicketComposer.tsx | 每工单 keyed editor 从本工单初始化；卸载同步 flush 最后快照，发送/丢弃先清快照，避免 cleanup 复活旧稿。 | 新增立即卸载持久化与发送后不复活用例；待 CI。 |
| fe-features-08 | 已修复 | confirm/ConfirmDialogProvider.tsx | Tab/Shift+Tab 环绕，focusin 纠正外部焦点；保留默认取消及关闭后焦点恢复，Escape 在捕获阶段处理。 | 新增两向 Tab 和 Escape 焦点回归用例；待 CI/辅助技术验证。 |

## 新增回归文件

- `frontend/src/tests/auditComponents3Markdown.test.tsx`：行内/块代码、文章未保存切换、详情乱序、键盘重复保存。
- `frontend/src/tests/auditAdminFeaturesState.test.tsx`：邀请码 GET 失败、上传批次、转写终态刷新、草稿 flush、确认焦点。

本组只执行源码/契约阅读和 `git diff --check`；该检查不是编译、测试或运行时验证。

## 操作偏差记录

一次批量换行归一化错误地使用了“当前所有已修改的 frontend/src/components 路径”，触及其他组文件。操作仅执行 `readFileSync(...).replace(/\r\n/g, '\n')` 后原路径写回，没有内容替换、截断命令或回滚；已立即通知协调者，后续严格限定明确白名单。无法从事后快照精确重建当时各组新增路径，需协调者结合各组 diff 核对；不能把语义未改当作已经完成并发写安全验证。可见其他组路径包括 AgeCalculatorPage.tsx、ApiKeyManager.tsx、ArticleCommandPalette.tsx、AuditLogViewer.tsx、BilibiliDataAdmin.tsx、BilibiliSyncAdmin.tsx、CDKStoreManager.tsx、CommandManager.tsx、DataCollectionManager.tsx、DeepLXTranslatorPage.tsx、EcoEnchantsOpsPanel.tsx、EmailSender.tsx、EmailVerifyPage.tsx、FBIWantedManager.tsx、FingerprintManager.tsx、Footer.tsx。本组不将这些路径列入自己的修复文件或提交范围。
