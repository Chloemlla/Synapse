# fe-features 静态审查（2026-10-07）

基线：`main@15f6c1a27492c41e04d1f233d3ff293c5c84ec66`。范围：`frontend/src/components/{env-manager,VtRatioExplorer,ticket,user-profile,user-management,policy,ip-ban,ui,confirm,speech-to-text,CommandManager,MarkdownExportPage,webhook-events}/**`。仅静态阅读，未运行应用/构建/测试/lint/装依赖，未修改源码、暂存、提交或推送。

## 1. 确认缺陷

| ID | 严重度 | 类别 | 位置（相对仓库根） | 症状、根因与触发 | 证据（每项不超过三行） | 具体改法 |
|---|---|---|---|---|---|---|
| fe-features-01 | 高 | 失败态导致安全配置误写 | `frontend/src/components/env-manager/SelfContainedRegistrationInviteConfigSection.tsx:35`、`:67`；`RegistrationInviteConfigSection.tsx:107` | 开启着邀请码闸门的站点，首次读取失败只发通知，required 保留默认 false；loading 结束后保存可用，页面还宣称“邀请码可选”。点保存会意外关闭注册邀请码要求。 | 初值 `required=false`；GET 失败不设置 loaded/error；保存 `{required}`，服务端 `runtimeConfigService.ts:1698` 接受显式 false 并更新运行缓存。 | 增加 loaded/error 三态；成功读取前禁止保存/显示真实当前状态，失败常驻提示并提供重试。与 10-04 已修 first-visit/proxycheck 是不同配置。 |
| fe-features-02 | 中 | 敏感明文生命周期 | `frontend/src/components/env-manager/RevealKeysSection.tsx:153`、`:176`、`:207` | 查看 AES 主密钥后折叠再展开仍显示明文；安全会话结束/失效没有统一清理 result。查看请求在途时点“结束本会话”，晚到响应还能重新填回密钥，显示在要求重新验证的界面下。 | 折叠仅改 isOpen；result 渲染不检查 isActive；`onReveal` await 后无会话/请求代次判断。 | 关闭、会话失效/变更、主动结束时清 result 并使旧请求失效；只有匹配当前安全会话且仍展开的响应可落状态。 |
| fe-features-03 | 中 | 结果缓存永不刷新 | `frontend/src/components/speech-to-text/SpeechToTextPage.tsx:137`、`:147` | 任务运行时展开详情，服务端返回空 transcripts；该空数组作为缓存存在。列表轮询显示成功后详情仍“没有可展示的结果”，折叠重开也不重取，必须刷新整个页面才能看到正文/下载。 | `setTranscripts(...[id]: detail.transcripts)`；`if (transcripts[expandedId]) return`；详情 effect 不依赖任务状态。 | 运行态详情按需刷新，终态转换时主动失效/重取；区分“已加载终态空结果”与“运行中暂时为空”。 |
| fe-features-04 | 中 | 上传与提交竞争 | `frontend/src/components/speech-to-text/SpeechToTextPage.tsx:163`、`:184`、`:364` | 批量上传首个文件完成后，开始转写按钮已可点击，后续文件仍上传；任务只捕获当时 chosen。若剩余文件在 createJob 返回前上传完，成功分支 `setChosen([])` 又清掉这些未入任务的文件，用户看到全部上传完成但部分未转写。 | 上传只设置 uploading，submit disabled 不含 uploading；每次上传 `addChosen`；任务成功整体清空 chosen。 | 上传未结束禁用提交；或提交快照并仅移除已提交文件，保留后来入队的文件。 |
| fe-features-05 | 低 | 失败重选不可用 | `frontend/src/components/speech-to-text/SpeechToTextPage.tsx:157`、`:288` | 上传失败或移除文件后立即重新选择同一文件，原 file input.value 未清空，浏览器不触发 change，因此上传重试无动作。 | onFilesPicked finally 只清 uploading；上传按钮直接 `fileRef.current?.click()`；没有重置 input.value。 | 读取 File[] 后清 value，或打开选择器前清空，使相同文件也能重新触发上传。 |
| fe-features-06 | 中 | 筛选请求乱序 | `frontend/src/components/ip-ban/BanListPanel.tsx:146` | 快速切换状态/关键词/排序，在较新的请求先返回、旧请求晚到时，旧 bans/total 覆盖当前条件；列表可被当作新筛选结果导出或批量解封。筛选变化重置页码还会额外产生不同页请求。 | `load()` 无 AbortController/请求序号；每个结果无条件 setBans/setTotal/setSelected；筛选控件加载中仍可操作。 | 每次查询绑定条件快照与递增序号，仅最新请求写入；筛选切换立即清选择，并以单次状态更新重置页码。 |
| fe-features-07 | 低 | 草稿持久化丢尾部 | `frontend/src/components/ticket/TicketComposer.tsx:96` | 输入后不足 400ms 就切工单/离开组件，cleanup 取消待写定时器，却不把最后内容写回，返回时末尾内容丢失；与按工单保留草稿的功能承诺冲突。 | `setTimeout(writeDraft,400)`；cleanup 只有 `clearTimeout(timer)`；切工单先卸载 Composer（`TicketSystem.tsx:445`）。 | 维护最后草稿快照，在 draftKey 变更/卸载前同步 flush；成功发送和显式丢弃需避免旧 cleanup 恢复已清空草稿。 |
| fe-features-08 | 中 | 危险确认的键盘焦点泄漏 | `frontend/src/components/confirm/ConfirmDialogProvider.tsx:80`、`:115` | 全站危险确认打开后仅移动焦点，Tab/Shift+Tab 可进入后方页面并操作被遮罩的控件，可能替换当前确认请求或切换上下文；声明 aria-modal 但未约束焦点。 | keydown 仅处理 Escape；没有 focus trap/inert；children 与对话框同时保留可交互状态。 | 接统一有焦点圈定能力的 Dialog，或实现 Tab 环绕与背景 inert；保留默认取消焦点和关闭回归。旧报告 F1-10 的九个特定弹窗不包含本 Provider。 |

## 2. 已检查区域

- 环境配置包装器及注册邀请码写入；查看密钥的验证会话和明文状态。
- 转写上传、提交、列表/详情缓存及下载；封禁列表筛选、选中、批量解封；工单编辑器草稿生命周期。
- 隐私同意撤回/删除、设备会话展示、密码揭示弹窗、通用确认与 CredentialIdModal。
- Markdown PDF、旧预览/KaTeX helper、资源图表与 webhook 类型辅助。
- 对照 10-03 总索引/中低处置和 10-04 IP 风控：未重报已修的转写配置/列表重试、单工单附件约束、封禁解封确认和 proxycheck/first-visit 加载保护。

## 3. 存疑，不算确认

- TicketComposer 草稿只按工单 ID 保存，内部备注的正文在 canWriteInternal=false 时仍可载入而仅取消 internal 标记；需核对跨账户清理与同工单可访问场景，暂未计入确认。
- `MarkdownExportPage/useKatex.ts` 在后续才出现数学内容时未重置 ready，但现有根 MarkdownExportPage 采用 MarkdownRenderer；此 helper 和 MarkdownPreview 未证实接线，不报不可达缺陷。
- ResourceAnalysisPanel 是空实现，但根 CommandManager 仅声明 lazy import，未发现渲染调用，不报不可达缺陷。
- 未重报 RevealPasswordModal/CredentialIdModal 已在 10-03 登记的焦点圈定遗留。

## 4. 覆盖面与局限

审查继续中，最终逐文件阅读清单与跳过项随后补齐。无浏览器/运行时/CI 验证，异步行为由静态状态转移证明。未读取 .env 或凭据。
