# fe-admin 静态审查（2026-10-07）

基线：`main@15f6c1a27492c41e04d1f233d3ff293c5c84ec66`。仅静态读源码和契约，未运行应用、构建、测试、lint 或安装依赖；未修改源码，未暂存、提交、推送。范围：`frontend/src/components/admin/**`。

## 1. 确认缺陷

| ID | 严重度 | 类别 | 位置（相对仓库根） | 症状、根因与触发 | 证据（每项不超过三行） | 具体改法 |
|---|---|---|---|---|---|---|
| fe-admin-01 | 高 | 失败态 / 授权配置误覆盖 | `frontend/src/components/admin/AdminScopeManager.tsx:278`、`:287`、`:542` | 首次 GET 授权配置失败后，loading 会归 false，添加用户仍可用并置 dirty；保存会把未加载的空 defaultPages 与仅含新用户的 perUser 整体写回，收回全体现有普通管理员授权。 | 初值 `draftDefaults=[]; draftPerUser={}`；添加后 `setDirty(true)`；保存只判断 `saving/loading/dirty`，服务端 `src/services/adminScopeConfigService.ts:129-150` 以 `$set` 覆盖两字段。 | 保存及草稿编辑必须要求本轮成功读取的 setting；错误状态保留重试，禁止以初始空值写入。 |
| fe-admin-02 | 中 | 异步响应串目标 | `frontend/src/components/admin/MediaToolAdmin.tsx:143`、`:168` | A 后端 health 请求未返回时切到 B，旧 A 响应仍可 setHealth；页面显示 B 地址但使用 A 的健康状态和默认任务参数，B 失败时甚至仍显示已连接。 | `await mediaToolApi.health(target); setHealth(h)` 无序号/取消；effect cleanup 只清 debounce timer；子面板 `target={target}` 与 `settings={health.settings}` 可来自不同目标。 | 为探测绑定 target generation，切目标即递增并取消旧请求；仅最新目标结果可写入状态。 |
| fe-admin-03 | 中 | 重试后缓存失效 | `frontend/src/components/admin/media-tool/JobsPanel.tsx:99`、`:124`、`:212` | 打开失败/取消任务的详情后点击重试，detail 仍保留终态。列表已显示运行中，但详情轮询优先读取旧 detail.status，直接 return；旧日志/产物一直显示，直到手动折叠重开。 | `detail[expandedId] ?? jobs.find(...)` 决定是否轮询；retry 只 `refreshList()`；后端 `src/mediaTool/http/mediaToolHttp.ts:533` 已把同一 job 改成 queued 并清 result。 | 重试成功用返回 job 替换 detail、清 transcripts，并立即拉详情；轮询生命周期以最新列表状态或版本为准。 |
| fe-admin-04 | 中 | admin / superadmin UI 契约 | `frontend/src/components/admin/media-tool/SettingsPanel.tsx:405`、`:457`；`frontend/src/components/admin/media-tool/JobsPanel.tsx:269` | 普通 admin 获授 media-tool 页面后能编辑全部设置、上传 cookies、确认删除任务，最终必被 403 拒绝；昂贵填写工作在最后一步才暴露无写权限。独立后端则允许这些操作，必须区分运行模式。 | UI 没有 canWrite/角色判断；导航 `navConfig.ts:428-430` 允许 admin；后端 settings PUT、cookies PUT/DELETE、jobs DELETE 均 `requireSuper`。 | 从父级传入 `canManage = standalone || isSuperAdmin`，这些入口禁用并说明原因；普通任务创建/取消/重试保持后端现有权限。 |
| fe-admin-05 | 中 | 配置草稿丢失 | `frontend/src/components/admin/CaptchaProviderAdmin.tsx:164`、`:408` | 在供应商/策略/外观留下未保存草稿，然后单独保存或删除 trycap 凭据：成功回读 loadAll 无条件 applyOverview，把三个草稿覆盖为旧服务端值，dirty 同时消失。 | `saveCapKey/deleteCapKey → loadAll({silent:true})`；`applyOverview` 同时 `setDrafts/setPolicy/setWidgets`；凭据操作与“保存全部”是不同按钮。 | 凭据写入后仅刷新 capConfig/凭据相关状态；其他配置的刷新合并需保留 dirty 草稿，或先明确确认放弃。 |
| fe-admin-06 | 中 | 键盘不可达 | `frontend/src/components/admin/media-tool/JobsPanel.tsx:221` | 任务行展开只有 div.onClick；仅键盘用户能点取消/重试/删除，却无法展开日志、结果下载与转写正文。 | 可点击 div 没有 tabIndex、role、onKeyDown；详情和下载按钮只在 `expanded` 分支渲染。 | 将展开部分改为真实 button，加入 aria-expanded/aria-controls，行级危险操作作为同级按钮。 |
| fe-admin-07 | 低 | 刷新控制未接线 | `frontend/src/components/admin/MobileTokenLineagePanel.tsx:662`、`:697` | “血缘时间线”查出结果后点“刷新全部”或开启自动刷新，当前时间线始终不重新请求；只刷新隐藏的概览。 | 父级递增 refreshNonce；ReuseTab 接收 nonce，LineageTab 无 props/effect 订阅。 | 传入 refreshNonce，保存已提交查询后按 nonce 刷新；编辑中的输入不应自动替换当前查询。 |
| fe-admin-08 | 中 | 探测销毁未提交工作 | `frontend/src/components/admin/MediaToolAdmin.tsx:146`、`:212` | 已填写下载地址或选好待转写文件后点“测试连接”，probe 先清 health，使 panelKey 从 h1→h0→h1；整棵子面板反复卸载，尚未提交的地址/文件选择无提示丢失。初次慢探测结束也会清掉等待期间输入。 | `setHealth(null)`；`panelKey = targetSig + (health ? h1 : h0)`；`<div key={panelKey}>` 包含持有草稿状态的面板。 | 仅真正切换目标时重挂载；首次加载完成通过受控默认值更新未编辑字段，探测期间保留原面板与草稿。 |

## 2. 已检查区域

- 路由与页面权限：共享 AdminGuard、超管守卫、模块注册、AdminHub 深链、页面授权编辑。
- 媒体工具：目标切换、设置与 cookies、下载、上传转写、任务重试/删除/轮询。
- 验证码控制台：整组保存与独立凭据保存、失败状态、草稿回读。
- QQ 管理总览与命令、抛硬币列表、政策记录、崩溃报告加载器、移动令牌血缘。
- 已对照 2026-10-03 总索引、中低处置与 2026-10-04 IP 风控报告：不重报已修的 QQ 撤回确认、AdminScope 筛选清空、验证码首载失败、旧焦点条目；本次 01 不同于已撤销的 F4-07（此处是未加载草稿写入）。

## 3. 存疑，不算确认

- AdminGuard 定期复查把临时 5xx/429 也当成权限失效跳登录；初次验证已区分该情况。尚未确认服务端临时故障重试产品约定，未列确认缺陷。
- `adminModules.isAdminModuleKey` 使用 `in` 接受继承属性；恶意/误输 constructor 深链可能进入错误渲染，但当前全局错误边界及实际异常呈现未验证。
- 健康探测返回值被静态类型强制视为完整结构；未把假设后端畸形响应导致崩溃算确认缺陷。
- useAdminScope 的跨账户缓存和 useAuth 首次加载并发由协调者归入 fe-api，本报告去重。

## 4. 覆盖面与局限

审查尚在继续；逐文件阅读清单与未读项将于本轮结束补齐。未访问任何 .env/凭据；未改动现有 `.gitignore` 或其他会话文件。静态证明代表代码路径可达，不等于 CI 或浏览器运行结果。
