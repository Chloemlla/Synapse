# IP 风控模块审计与处置（2026-10-04）

审计对象：proxycheck.io 风险查询链路 + 首访验证闸门 + 管理端只读面板 + env-manager 配置表单。
方法：6 个只读 subagent 按不相交文件组并行审查（结论落盘在 `.audit-iprisk/`），每一条由我逐条回到代码复核后登记。
本文件是**缺陷登记册**，处置列在每条末尾；末节「最终处置」记录实际落地的改动。

触发事件：线上 `payloadVerificationKey` 与本服务自建 `hmacSecret` 被填成同一串，而该账号的上游响应
根本不带 `http_x_signature` 头，导致每一次查询都在 `readVerifiedPayload` 抛
`proxycheck_signature_header_missing` → `settleFailure` → `fail_open` 放行。
最后一次成功外呼 2026-10-02T22:21:27Z，`PROXYCHECK` 配置于 22:22:22Z 被改写，此后全部失败。

---

## 一、核心链路（rc = risk-core）

### [RC-01] 高 | src/services/proxycheckHttp.ts:76-86 | 批量查询会把邻居 IP 的结论安到本 IP 头上
- **症状/触发**：批量响应含多个 IP 形态键时，若 `payload[ip]` 未直接命中（上游回显压缩后的 IPv6），回退分支扫描全表返回**第一个** IP 形态的键，拿到同批邻居的记录；`ipRiskService.ts:614` 随即以本 IP 为键写 `proxycheck_risk_cache`，24h TTL 内闸门读到的都是污染结论。
- **根因**：回退分支只校验「键是合法 IP」，不校验「该键确属本次所查地址」。
- **改法**：收集全部候选，仅当恰好 1 个时返回，否则 `return null`。单地址查询仍被救回，批量宁可失败也不认错数据。
- **处置**：修复。

### [RC-02] 中 | src/services/ipRiskService.ts:209-215,509-517 | 缓存读无兜底，getIpRisk 会抛异常
- **症状/触发**：`ProxycheckRiskCacheModel.findOne()` 在 Mongo 抖动时 reject；该 IO 点是 `getIpRisk` 里唯一没有 try/catch 的，异常经 `evaluateIpRisk` → `ipVerificationService.ts:610`（无 try/catch）传出，本该 fail-open 降级的 `/api/ip-verification/session` 变成 500。
- **根因**：与本文件 174-178 行「绝不抛错」的承诺、以及批量路径 643 行的兜底不一致。
- **改法**：取缓存处包 try/catch，读失败按「缓存未命中」继续走后续流程。
- **处置**：修复。

### [RC-03] 中 | src/services/ipRiskService.ts:402,448,592 | 失败的外呼不计配额
- **症状/触发**：只有完全成功才 `incrementQuota`（448）；拿到 HTTP 200 但验签失败时本地 count 不涨、上游额度却在消耗，日配额闸门（402）永不触发，故障期间整日持续外呼。批量路径 592 行是「请求发出即计」，两路口径不一致。
- **根因**：配额自增被放在解析成功之后；而 proxycheck 自身按请求计费，本地按成功计费天然对不上。
- **改法**：`incrementQuota` 移到发起上游请求之前（按「尝试」计），单址与批量统一口径；注释写明这是保守记账（宁可早停，不在故障期空烧额度）。
- **处置**：修复。

### [RC-04] 中 | src/services/proxycheckHttp.ts:53-74 + src/services/ipRiskService.ts:430-444 | 配置错误与网络抖动同码，无可告警信号
- **症状/触发**：验签失败 / `proxycheck_hmac_key_malformed` 与 ECONNRESET 同写 `status="failed"`、同走 failOpen，唯一区别只在 error 文本；key 填错的表现就是「每次都放行 + 满屏 warn」，没有独立信号可供告警聚合。
- **根因**：降级路径只按「有没有结论」二分，丢了失败类别。
- **改法**：识别配置类前缀（`proxycheck_signature_*`、`proxycheck_hmac_key_malformed`、`proxycheck_status_auth|denied`）改用 `logger.error` 并带稳定文案，供告警匹配；`status` 字段保持不变以免波及筛选项契约。
- **处置**：修复。

### [RC-05] 低 | src/services/ipRiskService.ts:485-495,523-533 | deduped 行恒 ok:true
- **症状/触发**：被合并的查询底层是 `unavailable`（上游失败/配额耗尽/未配置）时，该行仍写 `ok:true / risk:null`，面板 `ok` 过滤器把它算作成功。
- **根因**：`logDedupedLookup` 的 `ok` 硬编码 `true`。
- **改法**：`logDedupedLookup` 增加 `ok` 入参，取 `result.source !== "unavailable"`；合并 promise 被拒的 catch 分支保持无法判定（写 false）。
- **处置**：修复。

### [RC-06] 低 | src/services/ipRiskService.ts:431,444 | error.cause 被丢弃
- **症状/触发**：undici 一律抛 `TypeError("fetch failed")`，真实原因（拒重定向/DNS/TLS/超时）只在 `error.cause`，日志与落库的 `error` 只剩 "fetch failed"，线上无法归因（与 2026-10-03 审计 B2-02 同源，仍未修）。
- **根因**：只取 `error.message`。
- **改法**：拼 `cause?.message` 后再过 `redactSecret`，落库与打日志共用同一条串。
- **处置**：修复。

---

## 二、HTTP 接口层与配置读写通路（ra = risk-api）

### [RA-01] 中 | src/config/runtimeConfigDefaults.ts:494 | 服务端 apiKey 默认值写成字面量 "api"
- **症状/触发**：未设 `PROXYCHECK_API_KEY`、或超管点了「重置」后，`apiKey` 是字符串 `"api"`；`hasApiKey` 因此为 true、面板显示「已设置」，`ipRiskService.ts:385` 的 `!apiKey` 判据被绕过，带 `key=api` 真打上游换来 failed，而不是走 `not_configured`。
- **根因**：占位符被当成默认值；「是否已配置」两侧都以「非空」为判据。
- **改法**：默认值改回 `""`（同组的 `publicApiKey` / `payloadVerificationKey` 都是空串）。
- **处置**：修复。

### [RA-02] 中 | src/services/runtimeConfigService.ts:1575-1625 | 保存时无格式与跨字段一致性校验
- **症状/触发**：`payloadVerificationKey` 传任意串（不限 64 位）、或直接填成本服务 `hmacSecret` 的同一串，一律 200 落库——这正是本次事故形态；接口只回 hasXxx 布尔，没有任何矛盾检测。
- **根因**：`updateSecret` 只做 `trim` + `slice(0,1024)`，无数值/跨字段断言。
- **改法**：保存时校验 `payloadVerificationKey`（非空时）必须 64 字符且 `!== hmacSecret`，违反抛 `Error` → 控制器 400 `{success:false,error}`；`usePublicKeyForClient=true` 而 `publicApiKey` 为空时不阻断（保持既有降级语义）但由前端提示。
- **处置**：修复。

### [RA-03] 中 | src/services/runtimeConfigService.ts:1583-1592 | 已存密钥永远清不掉
- **症状/触发**：`if (!value) return currentValue`——空串表示「保留原值」，故误填的 `payloadVerificationKey` 无法清空（换个垃圾值仍算「已配置验签」），唯一出路是 DELETE 整段 PROXYCHECK，连带清掉 `apiKey` / `hmacSecret`。**这是线上事故的必要补救通路**。
- **根因**：`updateSecret` 只有「留空保留」一条语义，缺「显式清除」表达。
- **改法**：约定 `null`（JSON）为显式清除，`updateSecret` 传 `null` 时返回 `""`；前端密钥字段加「清除」开关，保存时把该键置 `null`。
- **处置**：修复。

### [RA-04] 中 | src/controllers/ipRiskLogController.ts:168-174 | overview 每次打开都触发无界全表扫描
- **症状/触发**：`countDocuments({status:{$ne:"cache"}})`——`status` 无索引，集合又刻意不加 TTL、行数随查询增长，每打开一次面板就是一次无界 COLLSCAN。
- **根因**：计数写成 `$ne` 形态，现有 `{createdAt:-1}` 索引用不上。
- **改法**：改为两个可走索引的计数 `total − count({status:"cache"})`，并补 `{status:1, createdAt:-1}` 复合索引支撑 `status+时间窗` 计数（同时供故障信号使用）。
- **处置**：修复。

### [RA-05] 低 | src/config/adminPages.ts:51 + src/controllers/adminController.ts:2112-2118 | 普通管理员可读到密钥掩码
- **症状**：页面 `ip-risk-logs` 的 `apiPrefixes: ["/api/admin/proxycheck"]` 覆盖了 `/proxycheck/setting`，而该 GET 只要求 `isAdminRole`（掩码前 2 + 后 4 + hasXxx）；同前缀下五个日志端点却是 superadmin，授权面自相矛盾。
- **改法**：`getProxycheckSetting` 改挂 `authenticateSuperAdmin`（或收窄 `apiPrefixes`）。
- **处置**：**登记，待决策**——改鉴权档位会影响被授予该页面的普通管理员能否加载配置区块；需先确认 env-manager 的既有授权约定。

### [RA-06] 低 | src/controllers/ipRiskController.ts:220-221 | 出口比对未归一化，产生假告警
- **症状**：同文件 175 行的 `normalizeExitForCompare` 只用在 webrtc 轴；`ipv4vsWs` / `ipvEvsV6` 直接比原始串，`httpExitIp="1.2.3.4"` 与 `wsExitIp="::ffff:1.2.3.4"` 会被判 mismatch。
- **改法**：两轴比较前也走 `normalizeExitForCompare`。
- **处置**：修复。

### [RA-07] 低 | src/controllers/ipRiskController.ts:295 + src/services/clientProbeService.ts:84,169 | 探测会话的 IP 绑定形同虚设
- **症状**：会话存了 `primaryIp`，但 `verifyProbeSignature(probeId,nonce,payload,signature)` 不接收请求 IP、从不比对；用 IP A 领的 probeId/nonce/probeKey 从 IP B 上报仍 200，报告 `ip` 记成 B。
- **改法**：`verifyProbeSignature` 增 `requesterIp` 入参并与 `session.primaryIp` 比对（两者都过 `normalizeIp`）。
- **处置**：修复。

---

## 三、闸门后端（gb = gate-be）

### [GB-01] 高 | src/services/ipVerificationService.ts:590-605 | 令牌可凭「指纹+IP」无凭据重新领取
- **症状/触发**：`POST /api/ip-verification/session` 无鉴权；命中 `getReusableToken` 时把库里的**原始 token** 放进 200 响应。指纹是 FingerprintJS visitorId（非机密），IP 只要求同出口；同一 NAT 上攻击者用「已在该 IP 通过验证的指纹」调 `/session` 即可拿到有效令牌，再直通闸门，零人机验证。
- **根因**：把非机密的「指纹+IP」当成可换取凭证的能力；令牌本应是客户端持有的秘密。
- **改法**：复用分支不返回 `token`，只回 `verified:true`（客户端换 `token` 时自然会带）。
- **处置**：**登记，待决策**——改动闸门的令牌复用契约会影响全部访客的前端流程与刷新体验，blast radius 大，不在本批静默改。

### [GB-02] 中 | src/app/assembly.ts:363 vs 365 + src/routes/routeModules/preTamperModules.ts:141-147 | preDocs 相位路由整段绕开闸门
- **症状**：`/api/tts`、`/api/librechat` 在 preDocs（363）先注册，闸门 `app.use("/api", ipVerificationMiddleware)` 在 preTamper（365）才挂，前者 router 终结响应后请求永不到达闸门；其模块声明 `ipVerification:"mixed"`（reason 写「仅 /assets 豁免」）因此不生效。
- **改法**：把闸门提到 `preDocsRouteModules` 之前；或对这些路由显式声明豁免并加相位顺序断言。
- **处置**：**登记，待决策**——前置闸门会要求 `/api/tts`、`/api/librechat` 携带指纹与令牌头，API-key / Bearer 客户端并不发送，生产上会打断直连客户端。需 owner 先定策略。

### [GB-03] 中 | src/routes/ipVerificationRoutes.ts:32-36 | 自动封禁响应缺稳定 code
- **症状**：风险分达 `blockRiskScore` 的自动封禁只回 `error:"IP已被封禁"`，不带 `errorCode`；前端只能靠中文文案匹配才能识别并弹申诉。系统其它封禁出口均用 `errorCode:"IP_BANNED"`（`security/ipBlockPage.ts:130`、`services/turnstile/verify.ts:282`），前端 `utils/ipVerification.ts:173` 已兼容该码。
- **改法**：该响应补 `errorCode:"IP_BANNED"`（前端无需改）。
- **处置**：修复。

### [GB-04] 中 | src/services/clientProbeService.ts:231-245 | 客户端可伪造的代理头被当作「观测到的出口」
- **症状**：`observed.ipv4` / `observed.ipv6` 的候选含 `cf-connecting-ip` / `x-real-ip` / `x-forwarded-for`（取 `split(",")[0]`，即客户端最左值）；`primary` 与 `socket` 缺失时伪造头直接填充返回值，可压制前端的出口比对。
- **根因**：函数注释写「代理头仅作展示、不参与判权」，实现却把它们放进了取值候选。
- **改法**：`ipv4`/`ipv6` 只从 `primary` 与 `socket` 取；代理头只留在 `headers`。
- **处置**：修复。

### [GB-05] 低 | src/services/clientProbeService.ts:69-84 | `usedNonces` 无条数上限
- **症状**：重放表只靠 60s 定时清扫 + TTL 回收，无容量上限。
- **改法**：加条数上限（超出按插入顺序淘汰；Map 保序）。
- **处置**：修复。（与 RA-07 同一文件/同组，合并处理）

### [GB-06] 低 | src/services/ipVerificationService.ts:311-326 | 并发签发互踩导致间歇 403
- **症状**：`issueToken` 先 `deleteMany({fingerprint,ipAddress})` 再 `create`；两个并发 `/session` 后一个会删掉前一个已随响应返回的令牌，客户端随后 403（表现为刷新一次就好）。
- **改法**：改用 `findOneAndUpdate(..., {upsert:true})` 原子替换。
- **处置**：修复。

### [GB-07] 低 | src/routes/ipVerificationRoutes.ts:50,80 | catch 分支硬编码 tokenTtlMinutes: 40
- **症状**：两个路由兜底 500 写死 40，而服务层各分支返回 `config.ipqs.tokenTtlMinutes`（超管可改 1-1440），调小后出错响应仍说 40，前后端认知分叉。
- **改法**：改用 `config.ipqs.tokenTtlMinutes`。
- **处置**：修复。

---

## 四、管理面板前端（ru = risk-ui）

### [RU-01] 中 | ip-risk-log/ui.tsx:362（另 LookupsTab.tsx:305、RiskCacheTab.tsx:238-241） | 降级放行被渲染成「低风险」
- **症状**：`source:'unavailable'` / `risk:0` / `level:'low'` 的行，level 徽标渲染绿色「低风险」、risk 显示 `0`，旁边才是「失败放行」。运维会读成「判定为低风险」而非「没拿到结论、按配置降级放行」。
- **改法**：`source==='unavailable'`（或 action 为 fail_open/fail_closed）时，level 渲染灰色「未取得结论」、risk 显示「—（未取得）」，不给绿色低风险标。
- **处置**：修复。

### [RU-02] 中 | ui.tsx:206-217 + LookupsTab.tsx:283 / RiskCacheTab.tsx:218 / ProbesTab.tsx:290 | 有数据时刷新失败在页面上不可见
- **症状**：三个 tab 都写 `error={rows.length === 0 ? error : null}`，表里已有行时刷新失败不进错误态，只剩一条自动消失的 toast；`useErrorNotice` 的 `lastMessageRef` 成功时不清空，同一文案只弹一次（自动刷新开着时用户以为数据是新的）。
- **改法**：仿 QuotasTab.tsx:89-93 在 tab 顶部常驻错误条（不依赖 rows 是否为空）；成功回调里复位错误通知。
- **处置**：修复。

### [RU-03] 中 | ip-risk-log/ui.tsx:322,324,341 | DecisionBlock 字段无兜底，可白屏整个前端
- **症状**：`decision.flags` 为 null/缺省时 `.filter` 抛 TypeError；`decision.action` 取到映射表外的值时 `ACTION_CONFIG[...]` 为 undefined，随后 `style.badgeClass` 抛 TypeError。两处都在渲染期抛错，被 App.tsx:1771 顶层 ErrorBoundary 接管 → 整站「页面加载失败」。
- **改法**：`(decision.flags ?? [])` 兜底；`ACTION_CONFIG[decision.action] ?? 兜底项`。
- **处置**：修复。

### [RU-04] 中 | ip-risk-log/format.ts:44-49 | 「未计时」显示成 0ms
- **症状**：cache / quota_exhausted / not_configured / deduped 行 `durationMs` 为 0，耗时列渲染「0ms」，像一次极快的外呼（而 cache 行的正确含义是「零外呼」）；与该函数自身注释矛盾。
- **改法**：`millis <= 0` 返回 `'-'`。
- **处置**：修复。

### [RU-05] 中 | IpRiskLogPanel.tsx:141-177 / OverviewTab.tsx:114-136 / api/ipRiskLogs.ts:51-61 | 概览区分不出「上游全挂」与「一切正常」
- **症状**：概览只有总量与「真的打到上游 N 次」，而该数把失败的调用也算作打到上游；验签头缺失导致 100% 失败时四张卡片仍显示正常活动量——而这是运维最先看到的一屏。
- **改法**：概览 counts 增 `failed24h`、`upstreamOk24h`、`lastError{message,at}`；面板加「上游失败（24h）」卡片与最近错误行，故障时肉眼可见并可跳转预筛。
- **处置**：修复。

### [RU-06] 低 | ip-risk-log/format.ts:16-20 | 时间未钉 Asia/Shanghai
- **症状**：`toLocaleString('zh-CN',{hour12:false})` 不带 `timeZone`，用浏览器本地时区渲染；非 UTC+8 运维看到的绝对时间与 dayKey 对不上，跨天边界出现「今天的日志显示为昨天」。
- **改法**：加 `{ timeZone: 'Asia/Shanghai' }`。
- **处置**：修复。

---

## 五、闸门前端（gf = gate-fe）

### [GF-01] 高 | utils/ipVerification.ts:256 → hooks/useFirstVisitDetection.ts:103 → App.tsx:1450 → components/FirstVisitVerification.tsx:182,583 | 握手失败的原始错误串直铺验证页
- **症状**：后端 5xx / 网关 502 / 断网 / 超时 → 抛 `IP verification session failed: HTTP 500` / `signal is aborted without reason` → 直出红框，用户拿不到可行动文案，且暴露状态码与异常类型。同类：`hooks/useSecureCaptchaSelection.ts:114-116` 把后端原文当用户文案。
- **改法**：只抛稳定 code（`SESSION_INIT_FAILED` 等），文案在组件侧映射；原文只进 console。
- **处置**：修复。

### [GF-02] 中 | utils/ipVerification.ts:116-134,259-268 + hooks/useFirstVisitDetection.ts:93-94 | 握手返回「未验证也未要求验证」被当作已通过
- **症状**：session 端点返回 `success:true` 但 verified/requiresVerification 均缺失或 false（`Boolean(undefined)===false`）→ 门禁为 false 直接放行且无令牌落盘；此后每个 `/api` 请求 403，每次 403 触发一次静默握手又得同一形状 → 闸门永不弹，用户只见请求失败。
- **改法**：`!verified && !requiresVerification` 时置 `requiresVerification=true`（fail-closed）。
- **处置**：修复。

### [GF-03] 中 | utils/ipVerification.ts:34-41,176-178,290-311 | `/api/ip-verification/complete` 的 403 封禁被完全吞掉
- **症状**：用户解完验证码时 IP 已被封（或此刻生效）→ complete 返 403 `IP_BANNED`；该路径命中 `EXEMPT_PATH_PREFIXES`，`maybeHandleBlockedResponse` 第 178 行直接 return，`completeIpVerification` 也不解析封禁载荷、不调 `maybeEmitPenaltyAppealFromResponse` → 只显示 "Verification was not accepted"，不切封禁页、不弹申诉。
- **改法**：complete 复用 initialize 侧的封禁载荷解析并抛出 / 补一次申诉分类调用。
- **处置**：修复。

### [GF-04] 中 | App.tsx:1439-1455（对比 1473、1476） | 闸门早返回分支没挂 PenaltyAppealHost / ClientOriginProbe
- **症状**：闸门分支只包 NotificationProvider + LazyMotion，而申诉宿主（1473）与匿名出口探测（1476）都渲染在主 shell 里；闸门期间 `api.ts` 派发的处罚申诉事件无人监听。
- **改法**：把 `<PenaltyAppealHost />` 与 `<ClientOriginProbe />` 提到 App 顶层或闸门分支内。
- **处置**：修复。

### [GF-05] 中 | utils/integrityCheck.ts:1037-1065 + 178-289 | MutationObserver 每条 attributes 记录都跑一次昂贵的 isExemptPage()
- **症状**：observer 开 `attributes:true,subtree:true`，回调对每条记录先跑只看 childList 的 `isSafeDOMChange`（必为 false）再跑 `isExemptPage()`（13 个标记各一次 6 路合并选择器 + 约 80 条关键词扫描）；闸门页 Spinner 由 framer-motion 每帧写 style → 每秒约 60 次空转。
- **改法**：回调开头算一次并缓存，或只处理 childList/characterData。
- **处置**：**登记，待决策**——integrityCheck 是防篡改模块，`attributes:true` 可能是有意为之（检测属性篡改），削弱前需确认检测覆盖面。

### [GF-06] 中 | components/FirstVisitVerification.tsx:61-65,463-466,656-676 | 界面直讲实现原理
- **症状**："before your session token can be renewed"、"Every API request carries the fingerprint and the verification token"、"Backend fraud scoring marked the current network as risky"、进度条 "Network scan / Human check / Session token"——把令牌签发、请求头字段、内部风控判据直接讲给用户。
- **改法**：改为状态型文案（如「需要完成一次人机验证才能继续」）。
- **处置**：修复。

### [GF-07] 低 | utils/fetchWithTimeout.ts:19-25 | 调用方 signal 的 abort 监听器永不摘除
- **症状**：长生命周期 signal 上反复调用时 `addEventListener('abort',…)` 持续累积（`{once:true}` 只在 abort 真发生时才生效）。
- **改法**：保存 handler，在 finally 里 `removeEventListener`。
- **处置**：修复。

---

## 六、env-manager 配置表单（ef = env-forms）

### [EF-01] 高 | env-manager/ProxycheckConfigSection.tsx:153-187,355 | 两把方向相反的密钥零互检
- **症状**：`payloadVerificationKey`（验上游）与 `hmacSecret`（验浏览器上报）并排渲染却从不互相比较；被填成同一串（本次事故形态）时两处脱敏串完全相同，面板无任何告警，运维无从察觉填反。
- **改法**：两字段 `has` 均为真且掩码串相等时，区块顶部渲染红色告警；并在 `payloadVerificationKey` 描述里写明获取路径（Dashboard → API Payload Verification Key）。
- **处置**：修复（前端告警）+ 后端 RA-02 双向兜底。

### [EF-02] 高 | env-manager/SelfContainedProxycheckConfigSection.tsx:121-126,147-164 + ProxycheckConfigSection.tsx:241 | 加载失败仍可保存，把默认值写回线上
- **症状**：GET 500 / 超时 / 断网时 `inputs` 停在 `DEFAULT_PROXYCHECK_INPUTS`、`current` 保持 null；运维点「保存」即 POST 全量 payload（enabled:false、failOpen:true、TTL 24 / 超时 8000 / 配额 1000 / 阈值 66 与 90），线上真实开关与阈值被静默重置；密钥因「留空=保留」而幸存，症状更隐蔽。
- **改法**：`current === null` 时禁用保存按钮，并在区块内显示「配置未加载，禁止保存」。
- **处置**：修复。

### [EF-03] 中 | env-manager/ProxycheckConfigSection.tsx:246-251,354-356 | 加载失败伪装成「未设置」
- **症状**：加载失败后四把密钥一律显示「未设置」，样式与「已加载且确实没配」一样；运维据此以为密钥丢失而重新粘贴，正是误填入口（与 EF-01 叠加成事故链路）。
- **改法**：区分「未加载 / 已配置 / 未配置」三态；`current === null && !loading` 显示「—（未加载）」。
- **处置**：修复。

### [EF-04] 中 | env-manager/ProxycheckConfigSection.tsx:36-51,201-204,299 | 矛盾组合写在默认值里，且该开关是空承诺
- **症状**：默认 `usePublicKeyForClient=true` 而 `publicApiKey=''`，全新/重置后天然矛盾且零提示；另外前端没有任何代码消费 probe-config 的 `publicApiKey`，204 行描述不成立；299 行「四把密钥都只留在服务端」又与 publicApiKey 自身描述矛盾。
- **改法**：开启但 publicApiKey 为空时给黄条「未配置公开 API Key，本开关不会生效」；修正 299 行措辞。
- **处置**：修复（提示 + 措辞）。**是否下线该开关**登记待决策（涉及后端 probe-config 契约）。

### [EF-05] 中 | env-manager/ProxycheckConfigSection.tsx:174-179,306 | 64 字符不校验，保存报「已保存」
- **症状**：输入非 64 字符的验签密钥，POST 成功并提示「已保存」，直到真实外呼才抛 `proxycheck_hmac_key_malformed` → failOpen 放行、风控静默失效。
- **改法**：保存前校验 `payloadVerificationKey` 为 64 字符，文案写明「须来自官方 Dashboard，共 64 字符」。
- **处置**：修复（前端）+ RA-02（后端，防 API 直连绕过）。

### [EF-06] 低 | env-manager/SelfContainedProxycheckConfigSection.tsx:225 + ProxycheckConfigSection.tsx:268 | 刷新静默丢弃未保存编辑
- **症状**：输入框有未保存改动时点「刷新」，服务器值直接覆盖 `inputs`，无提示。
- **改法**：检测到 dirty 且与服务器值不同时，刷新前二次确认。
- **处置**：修复。

### [EF-07] 低 | env-manager/SelfContainedFirstVisitVerificationConfigSection.tsx:36,68-93 | 同一类「未加载即可保存」
- **症状**：`enabled` 初值 true；GET 失败后点「保存」会 POST `{enabled:true}`，可能把刻意关闭的首访验证闸门重新打开。
- **改法**：加载成功前禁用保存；失败时明确提示当前显示值不代表服务器状态。
- **处置**：修复。

---

## 已验证为正确的点（不登记为缺陷）

- `normalizeIp` 正确剥除 `::ffff:`；`currentDayKey` 用固定 `Asia/Shanghai`；`resolveRiskScore` / `docToParsed` 取不到分时回 null / 用 `max()` 自愈，不会「读一次一个分」。
- `verifyPayloadSignature` 先钉 64 位小写 hex 再 `timingSafeEqual`，规避 `Buffer.from(x,"hex")` 静默截断与长度不等抛错。
- `buildIpRiskDecision` 是唯一判据，block 优先于 challenge，消费端 `ipVerificationService.ts:615/644` 顺序一致。
- 闸门中间件无 fail-open 分支；Mongo 不可用时 `verifyRequestToken` 返回 false；令牌查询绑定 token+fingerprint+ipAddress+expiresAt。
- 面板查询已下推 Mongo，`escapeRegexLiteral` + 字符集白名单，limit ≤ 200；日志 `error` 落库前经 `redactSecret`；配置写审计 `captureBody:false`。
- 掩码永不回写；数值双层钳制；保存/重置有重入守卫；写操作前后端双重 `superadmin` 把关。
- B2-01（scamalytics 静默 0 分）确已修复（`resolveFraudScore`/`toFiniteNumber` 返回 null 并收紧为 challenge）。

---

## 最终处置

本批共 **38 条**修复落地（6 组 subagent 并行改 24 个文件 + 1 处测试替身），**5 条**登记待决策未动。
所有改动经逐文件 `git diff` 复核；未跑任何本地构建/测试（CI 是唯一判据）。

### 已修复（38）

| 组 | 条目 | 落点 |
| --- | --- | --- |
| rc | RC-01 | `proxycheckHttp.ts:80-88` 回退分支收集全部候选，仅 1 个才返回 |
| rc | RC-02 | `ipRiskService.ts:554-568` 缓存读取包 try/catch，失败按未命中降级 |
| rc | RC-03 | `ipRiskService.ts:450/642` 配额改为「发起请求前按尝试计」，单址与批量统一 |
| rc | RC-04 | `ipRiskService.ts:389-397/469-487` 配置类前缀改 `logger.error` 稳定文案（`status` 仍 `failed`） |
| rc | RC-05 | `ipRiskService.ts:529/579/588` `logDedupedLookup` 增 `ok` 入参（`source!=="unavailable"`） |
| rc | RC-06 | `ipRiskService.ts:375-386/464` `describeError` 拼 `cause.message` 再过 `redactSecret` |
| ra | RA-01 | `runtimeConfigDefaults.ts:494` `apiKey` 默认 `"api"` → `""` |
| ra | RA-02 | `runtimeConfigService.ts:1626-1642` 保存时校验 64 字符且 `!== hmacSecret`，违规抛错→控制器 400 |
| ra | RA-03 | `runtimeConfigService.ts:1584-1597` `updateSecret` 支持 `null` 显式清除；前端密钥字段加「清除」开关 |
| ra | RA-04 | `proxycheckLookupLogModel.ts:96-100` 新增 `{status:1,createdAt:-1}` 索引；`readCounts` 改「总数 − cache 数」 |
| ra | RA-06 | `ipRiskController.ts:205/224-225` 两轴比较前过 `normalizeExitForCompare` |
| ra | RA-07 | `clientProbeService.ts:172` `verifyProbeSignature` 增 `requesterIp` 并与会话 `primaryIp` 比对；`ipRiskController.ts:301` 传参 |
| gb | GB-03 | `ipVerificationRoutes.ts:36` 自动封禁响应补 `errorCode:"IP_BANNED"` |
| gb | GB-04 | `clientProbeService.ts:251` `ipv4/ipv6` 候选只留 `primary`/`socket`，代理头只进 `headers` |
| gb | GB-05 | `clientProbeService.ts:184` `usedNonces` 加 10000 上限按插入序淘汰 |
| gb | GB-06 | `ipVerificationService.ts:311-337` `deleteMany`+`create` → `findOneAndUpdate(upsert)` 原子替换 |
| gb | GB-07 | `ipVerificationRoutes.ts:56/88` catch 兜底 TTL 改 `config.ipqs.tokenTtlMinutes` |
| ru | RU-01 | `format.ts` `isNoVerdictDecision`/`decisionLevelStyle`；Lookups/RiskCache/DecisionBlock 未取得结论渲染灰标「—（未取得）」 |
| ru | RU-02 | `ui.tsx` `useErrorNotice` 增 `reset()`；四 tab 加常驻错误条并在成功时 `notice.reset()` |
| ru | RU-03 | `format.ts` `actionStyle` 兜底未知 action；`ui.tsx` `flags ?? []` |
| ru | RU-04 | `format.ts:48` `durationMs<=0` 返回 `'-'` |
| ru | RU-05 | 后端 `counts.{failed24h,upstreamOk24h,lastError}`；`IpRiskLogPanel`/`OverviewTab` 加「上游失败（24h）」卡片；`api/ipRiskLogs.ts` 补三字段（可选，向后兼容） |
| ru | RU-06 | `format.ts:20` 加 `timeZone:'Asia/Shanghai'` |
| gf | GF-01 | `ipVerification.ts:266` 握手失败改抛稳定 code `SESSION_INIT_FAILED`；`useFirstVisitDetection.ts:23-34` 映射中文文案；captcha 选择与验证页去原文 |
| gf | GF-02 | `ipVerification.ts:118-125` `normalizeSessionPayload` fail-closed（`!verified` 即要求验证） |
| gf | GF-03 | `ipVerification.ts` `createIpBanError` + `completeIpVerification` 非 2xx 解析封禁/派发申诉；`FirstVisitVerification` 读 `banData` 切阻断页 |
| gf | GF-04 | `App.tsx:1427-1456` 两个闸门分支补 `PenaltyAppealHost` + `ClientOriginProbe` |
| gf | GF-06 | `FirstVisitVerification.tsx` 四组文案改状态型（REVIEW_STEPS / 引导段 / Token policy / Why 列表） |
| gf | GF-07 | `fetchWithTimeout.ts:19-32` 保存 handler 并在 `finally` `removeEventListener` |
| ef | EF-01 | `ProxycheckConfigSection.tsx` 两把密钥脱敏值相同时渲红色告警；`payloadVerificationKey` 描述补获取路径 |
| ef | EF-02 | `SelfContainedProxycheckConfigSection.tsx:158` `current===null` 禁用保存并提示；`ProxycheckConfigSection` 保存按钮同判 |
| ef | EF-03 | `secretCurrentValue` 三态：加载中 / `—（未加载）` / 已配置 / 未配置 |
| ef | EF-04 | 开启但无公开 key 时黄条「不会生效」；修正「四把密钥」措辞（开关是否下线待决策） |
| ef | EF-05 | 前端保存前校验 payload key 64 字符 + 后端 RA-02 兜底 |
| ef | EF-06 | 有未保存改动时刷新走二次确认（`useConfirm`） |
| ef | EF-07 | `SelfContainedFirstVisitVerificationConfigSection` 加载成功前禁止保存并提示 |

### 连带的测试替身修复（1）

- `src/tests/ipVerificationService.test.ts`：令牌模型替身补 `findOneAndUpdate`（GB-06 换了写法，替身缺件会让生产代码在调用点抛 `TypeError` 被吞成 5xx）。该套件另有 2 例走 `issueToken`，替身补上后不受影响。

### 新增跨端契约

- 概览 `counts` 增 `failed24h:number` / `upstreamOk24h:number` / `lastError:{message,at}|null`（前端按可选读取，兼容旧响应）。
- 写配置 `POST .../proxycheck/setting` 的密钥字段接受 `null` 表示显式清除（空串仍为保留原值）。

### 登记待决策（5，未改动）

- **GB-01** 令牌可凭「指纹+IP」无凭据重新领取——改闸门令牌复用契约，影响全体访客前端流程，blast radius 大。
- **GB-02** `/api/tts`、`/api/librechat` 因相位顺序整段绕过闸门——前置会打断 API-key/Bearer 客户端，需先定策略。
- **RA-05** `getProxycheckSetting` 的鉴权档位（普通管理员可读掩码）——影响 env-manager 既有授权约定。
- **GF-05** integrityCheck 的 `attributes:true` observer 性能——防篡改模块，削弱前需确认检测覆盖面。
- **EF-04（下线项）** `usePublicKeyForClient` 开关在前端无消费者，是否下线涉及后端 probe-config 契约。

### 生产数据修正（需 owner 确认，未执行）

线上 `PROXYCHECK.payloadVerificationKey` 被误填为本服务 `hmacSecret`（同串），而该账号上游响应不带 `http_x_signature`，
导致每次查询在 `readVerifiedPayload` 抛 `proxycheck_signature_header_missing` → `fail_open` 静默放行。
代码侧已提供「显式清除」通路（本批 RA-03），但**清空线上该键属于共享生产数据变更，须 owner 确认后执行**；
在清空前，风控对该账号持续处于 fail-open 降级。
