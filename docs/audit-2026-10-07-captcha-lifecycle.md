# 人机验证生命周期审查（2026-10-07）

范围：ManagedCaptcha、三家供应商控件、配置选择 hook、所有前端调用页面及后端验证入口。按 verified-methodology.md 执行；本地不构建、测试、lint 或安装依赖，回归测试交 GitHub Actions。

## 已确认缺陷与修复计划

| 编号 | 位置（审查时行号） | 类型、触发与根因 | 修复 |
| --- | --- | --- | --- |
| CAPTCHA-01 | frontend/src/components/ManagedCaptcha.tsx:221, 322 | 生命周期：成功后卸载控件并忽略所有过期回调，长时间填写表单仍显示通过，提交失效令牌。 | 保留成功控件以接收真实过期信号，重置时隔离旧轮回调。 |
| CAPTCHA-02 | frontend/src/hooks/useSecureCaptchaSelection.ts:70,125,175,195 | 竞态：请求中 reset 被丢弃，旧请求能回写；切换指纹/场景保留旧配置。 | 可取消请求与轮次校验，切换上下文重新分配。 |
| CAPTCHA-03 | frontend/src/hooks/useSecureCaptchaSelection.ts:184 | 恢复失败：手动重试仍沿用上轮供应商排除名单。 | 空参重试清名单，显式故障转移才保留排除项。 |
| CAPTCHA-04 | frontend/src/components/HCaptchaWidget.tsx:79,119,158 | 生命周期与并发：回调身份变化反复销毁控件；多个组件争用全局 onload；加载无超时，失败无法可靠重试。 | 稳定回调 ref、共享可重试脚本 promise、超时与清理。 |
| CAPTCHA-05 | frontend/src/components/TurnstileWidget.tsx:193,250,345 | 生命周期：已失败脚本留在 DOM 导致每次重试再超时；闭包持有旧回调；配置重渲染未 remove 老实例。 | 失败移除脚本，稳定回调与每轮清理实例。 |
| CAPTCHA-06 | frontend/src/components/CapWidget.tsx:167,307 | 恢复失败：脚本失败残留阻断重试；异步 solve 拒绝未捕获。 | 清理失败脚本、捕获异步拒绝。 |
| CAPTCHA-07 | 前端 ForgotPassword / ResetPassword / Register / TTS / ResourceStore / ImageUpload 提交处理器 | 一次性令牌复用：部分成功/失败路径不 reset；资源商店只清页面 token，控件却保持 solved，后续无法操作。 | 请求完成统一重新准备挑战；覆盖重复成功、失败和异常响应。 |
| CAPTCHA-08 | src/services/cdkService.ts:375、ipfsService.ts:467、lotteryService.ts:237、src/controllers/auth/_state.ts:156 | 接口契约：向 reader 传 token/provider，而 reader 要求 captchaToken/captchaProvider，启用验证后合法请求被误拒。 | 对齐标准字段并添加服务回归测试。 |
| CAPTCHA-09 | src/controllers/auth/_state.ts:135、src/tts/tts.pipeline.ts:312 | 验证绕过：客户端指定已停用供应商时直接放行。 | 根据服务端是否要求验证决定禁用态；不信任客户端 provider 决定豁免。 |

本清单在修复前落盘；后端与其余页面的逐项审查结果继续追加。所有编号完成后记录 CI 与最终去向。

补充已确认（修复前记录）：

- CAPTCHA-10：src/services/turnstile/verify.ts:454 将重复/过期令牌、配置错误及上游故障均累计为违规，正常重试会触发处罚；应区分可重试故障与真实滥用。:488 返回封禁时间写死 24h，与 BAN_DURATION=1h 不符，改用同一常量。
- CAPTCHA-11：verify.ts:223–562 的详细验证遗漏 hCaptcha score 阈值；hcaptcha.ts:147 在低分拒绝前记成功。统一评分门槛与成功记录顺序。
- CAPTCHA-12：verify.ts 各 trace 漏 verificationMethod，trace.ts:26 把 hCaptcha/trycap 统计为 Turnstile；补实际供应商。
- CAPTCHA-13：src/services/turnstile/ipBan.ts:74 同次 Mongo 更新对 violationCount 同时使用 $inc 与 $setOnInsert，路径冲突被吞掉，违规无法累计；消除冲突并补回归。
- CAPTCHA-07 补充：LoginPage.tsx:279–301 进入双因素流程仍保留已消费令牌，退出双因素再登录会复用；收到双因素响应即刷新。
- CAPTCHA-14：上述七个表单及 FirstVisit/Cloudflare 验证入口仅靠按钮 disabled，事件重入可并发消费同一令牌；增加同步单飞锁并隔离旧响应。
- CAPTCHA-01 补充：ManagedCaptcha 指纹 Promise 拒绝未捕获，指纹为空误报无需验证；捕获失败并显示可恢复错误，换场景清除旧成功状态。
- CAPTCHA-15：ManagedCaptcha 故障转移排除最后一家后收到 enabled:false，误把加载失败当作无需验证，页面隐藏控件但后端仍要求令牌；保留错误与重试入口。启用配置缺 siteKey/未知供应商同样按错误处理。
- CAPTCHA-16：用户补充要求统一自动识别后端“人机验证失败，请重试”等返回。共享 Axios/fetch 请求响应层识别结构化验证码错误及兼容文案，按请求令牌通知 ManagedCaptcha 自动换挑战；隔离同页多控件、迟到响应，防重复刷新，不自动重发业务请求。
- CAPTCHA-17：utils/ipVerification.ts:328 在调用页面核对响应代际之前写入本地会话；旧请求可能覆盖新会话。提供取消信号/有效性判据并在持久化前检查。
- CAPTCHA-18：ImageUploadPage.tsx:596 批量等待器遗留 abort listener，旧回调会清除新等待器，reset 在 resolver 安装前且无已取消预检；改为一次性 settle、清理计时器/监听器、先安装等待再 reset，卸载释放。
- CAPTCHA-19：LotteryPage.tsx:538 多轮抽奖卡片共享单一 captcha/status/ref，提交后重置最后一卡而非消费令牌的一卡；卡片隔离状态/ref，请求收尾刷新自己的挑战。
