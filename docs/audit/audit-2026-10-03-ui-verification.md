# Nielsen 启发式审计 — 验证 / 人机校验 / 安全组件组

> 审计日期：2026-10-03 ｜ 模式：MODE-AUDIT（只读审查，未改动仓库文件）
> 方法论：`verified-methodology.md`（并行只读审查 → 先落盘发现 → 最小化修复）
> 同批报告：`audit-2026-10-03-ui-*.md`、`audit-2026-10-03-backend-*.md`；总索引 `audit-2026-10-03-index.md`。

范围：`frontend/src/components/` 下验证码 / 人机校验 / 指纹 / 防篡改 / 安全面板等 19 个文件及其直接 import。
只读审查，未修改任何仓库文件。

| ID | 文件:行 | 启发式 | 严重度 | 证据（读到什么） | 用户影响 | 建议改法 |
|---|---|---|---|---|---|---|
| F2-01 | FingerprintRequestModal.tsx:140,152,214 | H03/H10 B01+B12 | 阻断(B01) | `hasDismissedOnce` 为真时：关闭按钮不渲染（152）、遮罩 `onClick={hasDismissedOnce ? undefined : handleClose}`（140）、跳过按钮不渲染（214）、全文无 keydown/Esc 监听 | 被判定「已关闭过一次」的用户被永久锁死在一个不可关闭的弹窗里，无键盘/无指针出路 | 保留一个始终可用的退出（如「稍后处理」）或至少提供 Esc；强制态改为「限制入口不可用」而非囚禁弹窗 |
| F2-02 | SmartHumanCheck.tsx:594-614 | ♿ B07 | 阻断(B07) | 滑块 `role="button"` 仅绑定 `onMouseDown`/`onTouchStart`，无 `onKeyDown`、无 `tabIndex`、无禁用拖动等价操作；`onComplete` 只在拖动到最右 350ms 后触发 | 纯键盘/辅助技术用户无法完成验证，被卡在验证环节 | 增加方向键+回车提交的等价操作（WCAG 2.5.7），或提供「无需拖动」的替代验证通道 |
| F2-03 | CaptchaVerificationPage.tsx:396-418 | B05 | 阻断(B05) | 结果面板直接渲染 `错误代码: {error_codes.join(', ')}`、`验证分数: {score}`、`主机名: {hostname}` | 用户看到厂商错误码与风控分数，无法据此行动，并暴露风控实现 | 折叠进「详情」，主文案改为「验证未通过，请重试」 |
| F2-04 | SmartHumanCheckTraces.tsx:216,521 | B05 | 阻断(B05) | `throw new Error(\`加载失败: ${res.status}\`)` / `删除失败: ${res.status}`，经 `setNotification` 原文展示 | 通知里直接出现 HTTP 状态码 | 改成原因+下一步的人类文案，状态码只进 console/详情 |
| F2-05 | NexAISecurityDashboard.tsx:151,187 | B05 | 阻断(B05) | `getRiskLevelBadge` 直接渲染 `{level}`（SAFE/LOW/MEDIUM/HIGH/CRITICAL）；柱状图 `labels` 用 `Object.keys(eventTypeDistribution)` 原始枚举 | 中文界面里出现英文枚举值，用户读不懂等级 | 复用同一份中文映射表（风险等级与事件类型） |
| F2-06 | TamperDetectionDemo.tsx:576,679,693 | B05 | 阻断(B05) | 事件严重度徽章渲染 `{event.severity \|\| 'low'}`；分布区渲染 `byType`/`bySeverity` 的原始 key（`manual_test`、`dom`、`critical`…） | 运维看到的是内部枚举名而非「高危/严重」 | 统一中文映射后再渲染，原始值留给 tooltip |
| F2-07 | NexAISecurityDashboard.tsx:435-454 | H05 B14 | 阻断(B14) | `searchQuery`、`filterRiskLevel` 仅在输入控件里出现，设备表始终渲染未过滤的 `devices`，且不重新请求 | 搜索/筛选框是装饰品，用户以为已筛选，实际看到全量数据 | 接入过滤或移除控件；若要服务端筛选则加请求参数 |
| F2-08 | FirstVisitVerification.tsx:205（同 CaptchaVerificationPage.tsx:124） | B05 | 阻断(B05) | 选择层错误原文呈现：`useSecureCaptchaSelection.ts:107` 抛 `HTTP ${status}: ${statusText}`，两端都把它当 `configError`/`selectionFailure` 直接显示 | 用户看到 `HTTP 500: Internal Server Error` | 映射为「验证服务暂不可用，请稍后重试」+ 重试按钮，原文只进 console |
| F2-09 | SmartHumanCheck.tsx:1334（含 594） | B05 | 阻断(B05) | 控件底部可见文案 `PoW {difficulty}` / `Managed challenge` / `Loading` / `Protected`；滑块 `aria-label="slider-handle"` | 面向用户暴露 PoW、Managed challenge 等实现词，且中英混杂 | 改为「安全校验」类用户语；滑块给出可读名称（如「拖动完成验证」） |
| F2-10 | SmartHumanCheck.tsx:1259,1332 | ♿ B06 | 阻断(B06) | `text-[#777]`：8px 文字在 `#fafafa` 上约 4.3:1，10px 文字在 `#f5f5f5` 上约 4.1:1，均低于 4.5:1 | 小字对比不足，低视力用户读不到「隐私 · 条款」与底部状态 | 提深到 `#5b6470` 级别或加大字号，达标 4.5:1 |
| F2-11 | NexAISecurityDashboard.tsx:197-203 | H01 B09 | 阻断(B09) | 加载态只有 `animate-spin` 圆环，无文字、无 `role="status"`、无 `aria-busy` | 超过 1s 的无标签转圈，屏幕阅读器无播报 | 加文字（「正在加载安全数据…」）与 `role="status" aria-live="polite"` |
| F2-12 | SmartHumanCheckTraces.tsx:222-230,633-670 | H09/H01 | 高 | 拉取失败只 `setNotification({type:'error'})`（4.5s 自动消失），`items` 保持空 → 表格持久显示「暂无数据」 | 网络失败被呈现成「没有日志」，用户不知道是坏了还是没数据 | 区分瞬时错误态与空态：行内错误条 + 重试按钮，保留空态文案于成功但零结果时 |
| F2-13 | NexAISecurityDashboard.tsx:127-133 | H01/H09 | 高 | catch 里只 `setNotification('加载数据失败')`，随后 `setLoading(false)`，`stats` 仍为 null → 四张卡片全部渲染 `\|\| 0` | 加载失败后仪表盘显示「总设备数 0 / 高风险 0」，等于给出错误结论 | 增加持久错误态与重试；未知数据不得渲染成 0 |
| F2-14 | TamperDetectionDemo.tsx:322-339,469-483 | H01 B09 | 高 | `updateStatus()` 内部 catch 只 `console.error`，`status` 保持 null → 永久停留在「正在加载防篡改控制面板...」，无超时、无错误、无重试 | 检测器初始化异常时页面永久转圈 | catch 里落错误态并提供重试；加载态加超时兜底 |
| F2-15 | TamperDetectionDemo.tsx:271,289,318,367,396,422 | H09/B05 | 高 | 错误与成功一律用 `alert()`；错误文本走 `getBackendErrorMessage(error, String(error))`，兜底即原始异常字符串 | 阻塞式原生弹窗 + `Error: ...` 原始文本，不可复制、无上下文 | 改成站内通知/行内错误，文案给出原因与下一步，原文进折叠详情 |
| F2-16 | TamperDetectionDemo.tsx:764-778 | H03/H05 | 高 | 「禁用」（关闭前端防篡改检测）与「紧急恢复」均在 `canWrite` 下单次点击直接执行，无确认、无影响说明 | 一次误点即关闭安全检测能力 | 危险开关加确认对话框，写明影响范围与恢复方式 |
| F2-17 | CloudflareChallengePage.tsx:34-57 | H01 B09 | 高 | `verifyToken` 的 `fetch` 无超时/无 AbortController，失败或挂起后永久停在「正在确认验证结果…」 | 卡在验证页，无任何出路 | 加超时(≤10s)+abort，失败落可重试错误态 |
| F2-18 | CloudflareChallengePage.tsx:52-56 | H09/B10 | 高 | 响应里的 `data.error` / `reason` 被丢弃，失败只回笼统文案 | 不知为何失败、不知下一步 | 透出后端原因 + 重试按钮 |
| F2-19 | CloudflareChallengePage.tsx:94-119 | H01 | 高 | 页面判失败，内嵌 ManagedCaptcha 仍显示「人机验证通过」，两态并存矛盾 | 用户无所适从 | 单一真相源：失败即隐藏/重置通过态 |
| F2-20 | CloudflareChallengePage.tsx:127-144 | H01/B01 | 中 | 成功态只显示「验证通过」，无继续/进入动作、无自动跳转 | 不知如何前进 | 给明确「继续」按钮或自动跳转 |
| F2-21 | CaptchaVerificationPage.tsx:196-218,476-483 | H01/B02 | 高 | 全部 provider 失败后「重新验证」只 bump `widgetKey`，无法重选 provider | 死循环失败、无出路 | 提供「切换验证方式」/重置 selection |
| F2-22 | CaptchaVerificationPage.tsx:124 | H09/B10 | 中 | `selectionError` 原样透传，含 `HTTP 500` 等技术串 | 只见技术串，无原因/下一步 | 映射成中文可读原因+下一步 |
| F2-23 | FirstVisitVerification.tsx 全文件 | H10 | 中 | 整页英文（Network scan / Session token 等），与同族中文页不一致 | 中文用户理解成本高 | 统一中文文案 |
| F2-24 | FirstVisitVerification.tsx:463-466,656-660 | H10 | 中 | 步骤叙述实现细节（network scan / session token）当面铺开 | 认知负担 | 收进可展开「详情」 |
| F2-25 | FirstVisitVerification.tsx:648-650 | H10/B05 | 中 | 直接展示 fingerprint hash 原文 | 隐私暴露+难理解 | 折叠/脱敏展示 |
| F2-26 | CapWidget.tsx:95-132 | H01/B09 | 中 | `loadScript()` 无超时，CDN 挂起时只留空白框无任何提示 | 看到空白不知发生了什么 | 加超时+错误提示+重试 |
| F2-27 | ManagedCaptcha.tsx:192-197 | H01 | 低 | trycap 在 `TRYCAP_REARM_LIMIT` 内静默 rearm，无任何用户提示 | 困惑为何重来 | 给一句「正在重试」文案 |
| F2-28 | SmartHumanCheck.tsx:216-224,1100-1143 | H01/B09 | 高 | 主线程 `solvePow` 最多 250k 次 SHA-256，无文字进度/取消 | 页面冻结像卡死 | 移入 Worker + 进度 + 取消 |
| F2-29 | SmartHumanCheck.tsx:1306 | H01/B02 | 中 | 重试按钮被 `retryCount >= 3` 门控，早期失败无重试入口 | 干等不知可重试 | 失败即给重试 |
| F2-30 | SmartHumanCheck.tsx:1259 | H10 | 低 | 「隐私 · 条款」看起来可点但不可点击 | 误导点击无响应 | 加真实链接或去掉可点观感 |
| F2-31 | SmartHumanCheckTraces.tsx:222-230 | H01/B02 | 中 | 请求失败仅弹 toast，随后渲染空态「暂无数据」 | 把出错当无数据 | 区分错误态/空态并给重试（与 F2-12 同一缺陷） |
| F2-32 | SmartHumanCheckTraces.tsx:686-752 | H02 | 中 | Portal 弹窗无 `role=dialog`/`aria-modal`/Esc/焦点返回 | 键盘·读屏用户无法正常退出 | 补 dialog 语义与 Esc |
| F2-33 | NexAISecurityDashboard.tsx:127-133 | H01/B02 | 高 | 加载失败渲染全 0 指标，无错误态 | 把失败当真实零数据 | 区分错误态+重试（与 F2-13 同一缺陷） |
| F2-34 | TamperDetectionDemo.tsx:322-339,469-483 | H01/B09 | 高 | `updateStatus()` 抛错时永久停留在 loading | 永久卡住 | catch 落错误态+重试（与 F2-14 同一缺陷） |
| F2-35 | TamperDetectionDemo.tsx:271,289,318,367,396,422 | H05/H09 | 中 | 大量 `alert()` 与 `String(error)` 直接弹出 | 体验粗糙且泄技术细节 | 换内联错误+中文文案（与 F2-15 同一缺陷） |
| F2-36 | TamperDetectionDemo.tsx:764-778 | H05/B04 | 中 | 「禁用 / 紧急恢复」危险操作无二次确认 | 误触不可逆 | 加确认对话框（与 F2-16 同一缺陷） |
| F2-37 | FingerprintManager.tsx:180-184 | H01/B02 | 中 | fetch 失败渲染空表+0 统计，与真实空态混同 | 以为没有指纹数据 | 区分错误态 |
| F2-38 | FBIWantedPublic.tsx:303-321 | H01 | 低 | 错误横幅与「没有匹配记录」空态同时出现 | 信息自相矛盾 | 错误时隐藏空态 |
| F2-39 | FBIWantedPublic.tsx:195-202,269-275 | H01 | 低 | 搜索无防抖，每次击键即发请求 | 卡顿、浪费请求 | 加防抖 |
| F2-40 | CaptchaVerificationExample.tsx:37-41 | H10 | 低 | 用 `alert()` 报成功 | 打断流程、风格不一致 | 改内联成功提示 |

> 去重说明：F2-31/33/34/35/36 与 F2-12/13/14/15/16 是同一缺陷的重复条目（报告在传输截断后重发时重推导所致）。修复时以 F2-12..F2-16 为准，去重后有效条数 35。
> 严重度分布：阻断(B0x) 11 条（F2-01..F2-11）、高 11 条、中 11 条、低 6 条，合计 40 行（去重后 35 条）。

## 已核实无缺陷的关键路径

- `FirstVisitVerification.tsx:154/272/286/300` `succeededRef` 终态守卫正确，widget 卸载后自派的 reset/expired 事件不会清掉已通过态。
- `ManagedCaptcha.tsx:113/186` `solvedRef` 守卫 + `192-197` 有界 rearm 正确，无自激循环。
- `CaptchaVerificationPage.tsx:190` 同样存在 `succeededRef` 守卫，成功不被后续失败覆盖。
- `CapWidget.tsx:194-205` 以 `cancelled || !element.isConnected` 丢弃卸载后回调，无幽灵事件。
- `TurnstileWidget.tsx` / `HCaptchaWidget.tsx` 未读到状态或文案缺陷。
- `FingerprintManager.tsx` 的删除确认对话框语义正确（无 B04）。
- `DebugInfoModal.tsx` 具备 `role=dialog`/`aria-modal`/Esc/焦点返回。
- `PenaltyAppealActions.tsx` 申诉入口 `mailOnly` fail-closed 正确，`code` 契约可识别。
- `studioTheme.tsx` 按钮禁用态样式齐全（`disabled:opacity-50`），无「禁用仍可点」。
- 三个验证面均未读到「把验证过期当验证失败」的混淆分支。
