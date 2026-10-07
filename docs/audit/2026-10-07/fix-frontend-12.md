# fe-comp-1 / fe-comp-2 修复处置

工作目录：独立 worktree Synapse-audit-all-20261007；起点 cb9fb199，已包含另一会话 CAPTCHA-01～19 修复。仅处理两份报告已确认的 27 项，未继续扩大审查。以下组件路径均相对 frontend/src/components/。

| 编号 | 处置 | 文件、修复与核验理由 | 验证局限 |
| --- | --- | --- | --- |
| fe-comp-1-01 | 修复 | CommandManager.tsx：队列、下一条预览、历史三条读取均先经 maybeDecryptCommandResponse/resolveCommandPayload 解包 Cookie 的 payload，再区分单条/数组；删除重复分支。 | 静态对照 commandRoutes Cookie 包装；未发真实命令请求。 |
| fe-comp-1-02 | 修复 | CDKStoreManager.tsx：统一页码 effect 查询，删除重复首屏入口，回到第一页也请求对应数据。 | 静态确认 effect 包含全部页码；未浏览器翻页。 |
| fe-comp-1-03 | 修复 | ApiKeyManager.tsx：编辑会话初始化 expiryChanged=false；仅有效期输入被编辑才提交 expiresInDays，名称/限流编辑不改变原绝对到期时间，包括已过期 Key；输入说明明确重新计时与清空语义。 | 已写过期 Key 无关编辑及显式续期回归测试，待 CI。 |
| fe-comp-1-04 | 修复 | EcoEnchantsOpsPanel.tsx：六个操作入口统一 runJob，每次逻辑操作生成 Idempotency-Key；结果不明确时保留键，重试复用；已受理操作按 jobId 恢复轮询，终态后下一操作才换键。适配真实任务状态与详情包装，读取 result，写入提交 UTF-8 base64/SHA-256；目录、原因、托管命令 params、备份范围与恢复路径遵循服务契约。只有 succeeded 才提示完成；failed/canceled/expired 显示失败；两分钟仍未终结提示继续查询；离开详情中止轮询。 | 已写受理不等于完成、幂等重试、失败写入、备份/恢复、托管命令契约测试，待 CI；无远程 Minecraft 实例实测。 |
| fe-comp-1-05 | 修复 | CDKStoreManager.tsx：datetime-local 以本地年月日时分填充；未修改日期时省略 expiresAt，保留秒/毫秒和原到期时刻。 | 静态追踪本地输入与 Date 序列化；未跨时区浏览器执行。 |
| fe-comp-1-06 | 修复 | CDKStoreManager.tsx：从有到期时间改为空时显式发送 expiresAt:null。协调者负责 frontend/src/api/cdks.ts 类型、src/controllers/cdkController.ts 和 src/services/cdkService.ts 的 null 清空契约；组件不再把清空编码为字段省略。 | 跨组后端实际持久化与 CI 由协调者统一验证。 |
| fe-comp-1-07 | 修复 | CDKStoreManager.tsx：生成/编辑共用资源选项加载，使用协调者新增的 resourcesApi.getAdminResources(page) 逐页加载，包含停用资源；编辑缺失的当前资源再单独取详情。1000 页保护或中途空页未达 total 时明确报加载不完整，不悄悄展示前十项。 | API 新入口由协调者/后端组负责；未请求生产资源，静态确认分页迭代与错误态。 |
| fe-comp-1-08 | 修复 | ArticleCommandPalette.tsx：增加 loaded 状态，成功空数组同样结束自动加载，显式重试仍可重新请求。 | 已写空列表关闭/重新打开只请求一次用例，待 CI。 |
| fe-comp-1-09 | 已修 | CapWidget.tsx：当前 loadCapScript 的 fail 会清理监听、移除失败 script、设 failed 并拒绝；Promise 的失败分支清空 capScriptPromise，后续挂载可新建脚本。已由基线 CAPTCHA 修复覆盖，本组未重复修改。 | 静态核对当前实现与既有 CaptchaWidgets 用例；未重跑测试。 |
| fe-comp-1-10 | 修复 | AuditLogViewer.tsx：日志和统计分别使用请求版本，effect 清理使旧版本失效；旧成功/失败/finally 均不能覆盖新数据/页码/加载态。新统计查询清空旧统计。 | 静态核对所有响应提交点；无真实乱序网络重放。 |
| fe-comp-1-11 | 修复 | ApiKeyManager.tsx：切 Key 时清空流水并递增版本，只接受当前请求；关闭时失效旧请求，余额调整后仅在仍选择同一 Key 时刷新其流水。 | 静态追踪响应、失败、finally 和调整后刷新；未真实计费请求。 |
| fe-comp-1-12 | 修复 | BilibiliDataAdmin.tsx：列表请求版本绑定请求及 tab effect 生命周期，旧 tab 的成功、失败和 finally 都不能再覆盖当前 tab。 | 静态核对当前表与分页写入点；未真实网络乱序重放。 |
| fe-comp-1-13 | 修复 | BilibiliSyncAdmin.tsx：保留全库总数，三个比例以 records.length 为分母，说明明确标注“本页”。 | 静态核对计数与分母均来自当前页。 |
| fe-comp-1-14 | 修复 | DeepLXTranslatorPage.tsx：原文/方向 setter 统一中止旧请求并递增版本，清空、历史加载、交换语言均经过这些入口；只有未中止且版本匹配的响应可回填译文与历史，旧 finally 不再清掉新请求状态。 | 已写忽略 abort 的慢响应在清空后仍不得回填用例，待 CI。 |
| fe-comp-1-15 | 修复 | DeepLXTranslatorPage.tsx：历史从安全读取函数惰性初始化；state updater 保持纯计算，独立 effect 持久化；存储失败捕获降级保留内存结果。 | 已写 quota 异常后译文仍可复制用例，待 CI。 |
| fe-comp-1-16 | 修复 | DataCollectionManager.tsx：两个创建入口的默认 datetime-local 均使用本地年月日时分，不再截断 UTC ISO。 | 静态验证本地输入到 ISO 提交路径；未跨时区浏览器执行。 |
| fe-comp-1-17 | 修复 | DataCollectionManager.tsx：三处触摸复制按钮立即保存 currentTarget 并交给计时函数；每个元素仅保留一个延迟隐藏计时器，触摸重新显示时取消旧计时，卸载统一清理。 | 静态核对异步函数不再读取 React 事件对象；无触摸设备实测。 |
| fe-comp-1-18 | 修复 | AgeCalculatorPage.tsx：截止日期按本地年月日输出，输入和提交解析为本地零点，避免 UTC 午夜导致昨天/偏移一天。 | 静态验证双向日期转换；未跨时区运行。 |
| fe-comp-2-01 | 修复 | FBIWantedManager.tsx：只有 ok===true 才发删除请求；仅“删除所有记录”显式加入 confirmAll:true，普通死亡记录筛选不带该字段，与后端组防空筛选协议一致。 | 已写 false/null/undefined 不请求及两种删除 body 契约测试，待 CI；Escape/关闭的布尔返回由确认 Provider 负责。 |
| fe-comp-2-02 | 修复 | FBIWantedManager.tsx：三个筛选 onChange 同步置第一页并使旧查询失效；最新列表响应钳制当前页到至少为 1 的有效页范围，删除后页数缩短可自动回到有效页。 | 静态确认筛选/删除刷新与页码 effect；未浏览器分页实测。 |
| fe-comp-2-03 | 修复 | FBIWantedManager.tsx：创建/编辑开启、关闭、取消和成功结束统一 resetForm 清图片草稿；上传绑定 draftVersion，上一编辑会话晚到的上传结果不能污染下一条记录。 | 静态核对所有 modal 开关与上传完成入口；未实际上传照片。 |
| fe-comp-2-04 | 修复 | FBIWantedManager.tsx：chargesDraft 保存原始文本，提交时统一 split/trim/filter；创建和编辑可连续输入逗号及下一项，创建必填校验使用解析后的语义。 | 已写末尾逗号保留与重新打开清草稿用例，待 CI。 |
| fe-comp-2-05 | 修复 | EmailSender.tsx：按域名缓存数据和成功时间；切域名先恢复对应缓存/空占位，再按 TTL 请求；响应检查当前域名及该域名请求版本，失败不写成功时间；fetchQuota 使用稳定 callback，避免 effect 因每次渲染重建循环。 | 静态核对 A→B→A 缓存与乱序响应；未实际发送或调用邮件接口。 |
| fe-comp-2-06 | 修复 | EmailSender.tsx：发送时保存包括表单、模式、纯文本/Markdown 与白名单选项的草稿签名；成功时仅当前草稿仍等于发送快照才清空，发送期间新编辑保留。 | 静态追踪校验/发送 await 前后快照；未实际发信。 |
| fe-comp-2-07 | 修复 | EmailVerifyPage.tsx：effect 清理 abort 请求并取消导航计时器；指纹等待、响应解析和异常路径检查 cancelled，卸载后不再通知或导航。 | 静态核对所有 await 与 timer 清理；未真实验证邮件链接。 |
| fe-comp-2-08 | 修复 | Footer.tsx：去重共享 Response 的每位消费者在解析前检查 cancelled，使用 response.clone().json()，避免同一 body 被多个挂载实例消费。 | 静态确认两条去重请求均克隆后解析；未浏览器外壳切换重放。 |
| fe-comp-2-09 | 修复 | FingerprintManager.tsx：详情请求持有独立 AbortController，切用户和卸载中止旧请求，旧响应/异常/finally 均不能替换新选择或结束新加载。 | 静态核对详情提交路径；未真实指纹数据请求。 |

合计：26 项本组修复、1 项基线已修、0 项不成立。变更组件共 16 个；新增测试文件 auditComponents12Safety.test.tsx、auditComponents12Async.test.tsx、auditComponents12Ops.test.tsx，均在 frontend/src/tests/。

本机只做静态读取、差异检查；没有构建、运行测试、lint 或安装依赖。已写的回归用例不能计作通过，GitHub Actions 结果由协调者提交后统一回填。跨组 API/控制器/服务的最终一致性也由协调者检查。本组不暂存、提交或推送。
