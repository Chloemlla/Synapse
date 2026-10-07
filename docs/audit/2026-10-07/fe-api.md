# fe-api — 前端请求、认证状态与共享工具审查

> 基线：`main@15f6c1a27492c41e04d1f233d3ff293c5c84ec66`；2026-10-07。
> 本轮只读审查，未修改源码、运行程序、构建、测试或安装依赖。下列是静态可达性结论，未声称浏览器复现或 CI 已覆盖这些场景。
> 依据：工作区 `verified-methodology.md`、`code-audit-methodology.md` 和仓库 `AGENTS.md`。原计划组名沿用 `fe-api`；当前覆盖记录见末节。

## 1. 缺陷清单

| ID | 严重度 | 类别 | 位置(file:line) | 症状与根因 | 证据 | 建议改法 |
| --- | --- | --- | --- | --- | --- | --- |
| fe-api-01 | 中 | F 跨账号状态污染 | `frontend/src/hooks/useAdminScope.ts:17`、`:26`、`:87`；`hooks/useAuth.ts:311` | 管理员 A 拉取页面授权后，在同一 SPA 登出并登录管理员 B，仍会读到 A 的页面集合。模块缓存与在途请求均不含用户 ID；登出不清该缓存，同角色切换也不触发 effect。结果是 B 的入口错误显示/缺失及不必要的 403；后端范围守卫仍存在，不能称为服务端越权。 | `if (cached) return Promise.resolve(cached)`；effect 依赖 `[adminUser, role]`；invalidate 仅管理授权编辑页面主动调用。 | 缓存/请求按 userId 隔离；账号或认证代次变化时丢弃旧结果；更新授权时让所有订阅者刷新。 |
| fe-api-02 | 中 | A 认证异步结果覆盖新会话 | `frontend/src/hooks/useAuth.ts:150`、`:162`、`:311`；`stores/authStore.ts:108` | `/auth/me` 已在服务器完成但响应较慢时，用户登出/切换账号/完成新登录，旧检查仍直接 `setUser(data)`。旧成功可恢复旧身份 UI，旧 401/403 可清掉新登录。节流只限制发送数量，没有把结果绑定到发起时的会话；这不代表服务端被重新登录。 | `const response = await api.get<User>('/api/auth/me')` 后无身份代次检查即 `setUser(data)`；logout 不取消或失效检查。 | 统一认证检查的 in-flight promise 与 session generation；登录、登出、换号推进代次，旧代次不得写 store，包括 catch/finally。 |
| fe-api-03 | 中 | C WebSocket 身份生命周期 | `frontend/src/hooks/useWsNotifications.ts:96`；`hooks/useWebSocket.ts:150`；`App.tsx:1487` | 游客打开登录页时已建立匿名 WS；登录成功只更新 store，常驻 WsConnector 的连接 effect 不依赖身份，仍沿用匿名连接。后台只在握手时解析 cookie、绑定 user channel，因此新登录用户持续收不到个人 TTS/工单/指纹推送，直到连接重建或刷新页面。 | `useWebSocket({ onMessage })`；effect 依赖 `[autoConnect, connect, disconnect]`；`src/services/wsAuthentication.ts:39` 无 cookie 返回匿名身份；`wsService.ts:227` 仅建连时订阅 user。 | 将连接生命周期绑定已确认的 userId/会话代次，身份变化先关闭旧连接再握手；保留游客公共通知能力。 |
| fe-api-04 | 中 | G 安全操作失败显示成功 | `frontend/src/hooks/usePasskey.ts:472`；`frontend/src/components/PasskeySetup.tsx:158` | 删除 Passkey 遇会话过期、403、服务错误或网络失败，hook catch 只打印日志且正常 resolve；调用页面随后无条件提示“Passkey 已删除”并关闭确认框。凭据实际仍在，用户被误导为撤销成功。 | hook `catch { console.error(...) }`；页面 `await removeAuthenticator(confirmDeleteId)` 后 `setNotification({ message: 'Passkey 已删除', type: 'success' })`。 | 删除失败向上抛出/返回明确失败；只有后端确认删除后提示成功。列表刷新失败应另行展示，不能混为删除失败。 |
| fe-api-05 | 中 | B 超时仅覆盖响应头 | `frontend/src/utils/fetchWithTimeout.ts:27`、`:31`、`:43`；`utils/ipVerification.ts:269` | fetch 在收到响应头后即 resolve，finally 随即清掉超时与调用方 abort 监听；调用方接着等待 `res.json()`。若响应头已到但正文停止传输，验证码配置/IP 握手等页面可无限 loading；调用方稍后取消也无法经已移除的监听取消正文。 | `return await fetch(...)`；finally `clearTimeout(timeoutId)` / `removeEventListener`；JSON helper 在外层 `await res.json()`。 | 为 JSON 场景提供覆盖 fetch+消费正文的有界 helper，并在整个正文消费结束后释放信号/计时器；保留原始 Response API 时明确其生命周期契约。 |
| fe-api-06 | 中 | A 旧 403 删除新验证令牌 | `frontend/src/api/api.ts:168`；`frontend/src/hooks/useTts.ts:69`；`utils/ipVerification.ts:204` | 页面并发请求中的旧请求未携带令牌，在用户刚完成验证并落盘新令牌后才返回 403。两个 axios 拦截器不比较请求携带值，直接清掉当前令牌，使已完成验证作废、再次弹挑战。raw fetch transport 已特意避免这种清理，同项目两条传输路径行为不一致。 | axios `clearIpVerificationToken(); emitIpVerificationRequired(...)`；fetch `maybeHandleBlockedResponse` 注释明确“不抹掉本地令牌”，由握手判定。 | 对齐 fetch 的权威握手失效策略，或只有请求令牌仍等于存储令牌时才失效；不要让旧响应清掉后写入的新会话。 |
| fe-api-07 | 中 | D API 基址与调用方契约 | `frontend/src/api/api.ts:17`；`frontend/src/api/lottery.ts:14`；`stores/authProviderStore.ts:47` | 配置合法的 `VITE_API_URL=https://host/` 后 getApiBaseUrl 原样返回尾斜杠；多处手动追加 `/api/...` 产生 `//api/...`。浏览器 URL 不折叠中间双斜杠，路径规范化器也不修它；服务端不重写时接口404，fetch transport 的 `/api/` 判定亦失配。 | `if (configuredUrl) return configuredUrl`；`const API_BASE = getApiBaseUrl() + '/api/lottery'`；providers 同形拼接。 | 出口统一移除基址尾斜杠，或全量调用使用一致 URL join；覆盖显式配置而非仅默认值。 |
| fe-api-08 | 高 | F 导入破坏旧数据且假成功 | `frontend/src/utils/logShareStorage.ts:98`、`:235`；`frontend/src/components/LogShare.tsx:737` | 实际 LogShare 导入先单独提交 clear，再逐条 put，任一条因无效 IndexedDB key/配额等失败就只打印日志。旧历史已删除、仅部分新数据写入，但 importHistoryData 仍 resolve 新条数，UI报“导入成功”。例如合法旧备份外混入 `id:true` 的条目可通过 truthy 校验后触发 DataError。 | `await db.clear(LOGSHARE_STORE)` 后循环 `await db.put(...)`，catch 不抛；上层 `await importHistoryToDB(mergedHistory); resolve(newHistory.length)`。 | 在同一个 readwrite 事务内读现有数据并按键增量合并，校验输入主键，失败回滚且向上抛出。已修过的 `utils/localStorage.ts` 事务逻辑没有被此页面调用，不能代替修复真实链路。 |
| fe-api-09 | 中 | C 登出后指纹提示残留 | `frontend/src/hooks/useFingerprintRequest.ts:169`、`:207`、`:219`；`App.tsx:1716` | 已收到强制指纹请求时登出，初始化分支只 setLoading(false)；专门清理 effect 仅依赖稳定的 isUserLoggedIn callback，不随 user 变化运行；shouldShowRequest 又不要求登录。常驻 App 因而可继续向已登出用户弹属于上个账号的提示；在途状态请求也可在登出后重新写回。 | 清理 effect 依赖 `[isUserLoggedIn]`；`isOpen={!isArtifactSharePath && shouldShowRequest}` 无 user 守卫。 | effect 按 userId/已认证状态重置；结果写入检查身份代次/取消状态，未登录直接禁止展示。 |
| fe-api-10 | 低 | G 临时错误永久伪装成禁用 | `frontend/src/stores/authProviderStore.ts:43`、`:65`、`:72` | 首次第三方登录配置请求遇临时网络故障后，google/linuxdo 留在 enabled=false、initialized=true；store 不暴露错误或 reload，重进登录页也不再拉取。可用的第三方登录方式在整个 SPA 会话中消失，必须整页刷新才能恢复。 | catch 只 `set({ loading: false, initialized: true })`；唯一 init 在创建 store 时 `void init()`。 | 区分服务端明确禁用与配置未知；暴露有退避的 retry/error，并在登录页提供重试。 |
| fe-api-11 | 中 | B 重连生成多个活连接 | `frontend/src/hooks/useWebSocket.ts:66`、`:72`、`:96`；`components/WsConnector.tsx:172` | WS 正在 CONNECTING 时重试按钮仍可点击。connect 只清定时器，既不检查 readyState，也不关闭旧 ws；第二次覆盖 wsRef 后，旧连接仍会 open 并各建心跳。旧 close 回调还能清掉新连接的计时器并启动额外重连，导致重复通知、孤儿连接及错误状态。 | `cleanup(); const ws = new WebSocket(url); wsRef.current = ws`；按钮仅由 `!connected` 控制，没有连接中禁用。 | connect 幂等化，CONNECTING/OPEN 时复用；替换前关闭并解绑旧 socket；所有回调核对连接代次，cleanup只清自身资源。 |

所有条目当前去向均为“已登记、未修复”。本轮没有把静态修复建议标为验证通过。

## 2. 已核对区域与排除项

- 共享 axios 默认 cookie、有限次数重试且不自动重试 POST/PATCH；不能泛称“所有写请求会被自动重试”。
- raw fetch 有全局 `installIpVerificationTransport()`，正常后端 API 请求会注入验证头；不能只看调用点没写 header 就报漏验证。
- authStore 持久化只保存身份展示元数据，merge 不恢复 isAuthenticated；单独修改 localStorage role 不能证明后端越权。
- Passkey 后端完成认证仍返回 token，与 loginWithToken 契约相符；未报“cookie-only 导致 Passkey 必失败”。
- `useTwoFactorStatus` 计算 error 却不返回，但全树未找到调用方；登记观察，不计当前用户缺陷。
- `utils/localStorage.ts` 导入虽存在事务外旧快照问题，但全树未找到页面调用；本报告只计实际被 LogShare 调用的 `logShareStorage.ts`。
- `useTts` 生成具有 ref 防重、取消信号和有界轮询；取消不撤销后台任务是明确行为，不当成实现缺陷。

## 3. 存疑 / 需继续验证

- `useAuth` 节流分支在其他检查仍 in-flight 时将 loading 提前置 false；StrictMode 开发双 effect 明确会走该路径，但生产 App 有外层启动等待，具体生产触发链尚未锁定，不列确认条目。
- `useSecuritySession` 单例不含 userId，且 expiresAt 没有独立驱动订阅刷新；需要逐消费者确认是否统一在身份变更/到期时清理。后端 token 绑定 userId，不能直接认定跨账号越权。
- `useSecureCaptchaSelection` 改 fingerprint/scenario 时只重置 exclude，没有重置已加载配置；需证明当前可达组件会在不卸载的情况下改变这些 props。
- IP 握手 `verified=true` 但无可用 token 的畸形响应需要与服务端所有分支对齐；不凭类型断言单独判安全绕过。

## 4. 覆盖记录

完整读取或已分段补齐的主文件：

- `api/`：api、index、adminScope、passkey、lottery、markdownArticles、mobileLogin、resources、securitySummary、crashReports、translationAudit、imageData、deeplx、coinFlip、qqGuard。
- `stores/`：authStore、authProviderStore。
- `hooks/`：useAuth、useAdminScope、useSecuritySession、useTwoFactorStatus、useRBAC、useWebSocket、useWsNotifications、useFirstVisitDetection、useFingerprintRequest、useLottery、usePolicyDocument、useSecureCaptchaSelection、useConfigurationNoticeTrigger。
- `utils/`：authSession、webSocketUrl、fetchWithTimeout、fetchWithFallback、apiPath、adminVerifyCache、ipVerification；localStorage 和 logShareStorage 的导入/导出/持久化链路；penaltyAppeal 的分类/派发链路。

抽读：`hooks/usePasskey.ts` 的认证、注册、加载、删除；`hooks/useTts.ts` 请求实例、取消、历史读取、生成与结果处理；`utils/fingerprint.ts` 指纹生成、缓存、获取 IP；`utils/imageCache.ts` 连接与 get/set/delete；`App.tsx` 启动门禁、身份、WS与指纹提示；`main.tsx` 入口与 StrictMode。抽读不等于整文件逐行覆盖。

跨组可达性核对：`components/PasskeySetup.tsx` 删除处理、`components/WsConnector.tsx`、`components/admin/AdminGuard.tsx`、`components/LogShare.tsx` 导入调用；后端 `wsAuthentication.ts`、`wsService.ts` 握手/频道绑定、passkeyRoutes 认证响应。已按旧审计索引/处置表检索同类问题，未把已修的 G9/GF 条目原样重报。

继续审查中的原计划其余文件：剩余 API、hooks、工具、大型 integrityCheck、App/main 其余段落、types/tests、前端构建配置。下一次追加覆盖必须同步更新此节，不能以报告文件存在宣称该组全量完成。
