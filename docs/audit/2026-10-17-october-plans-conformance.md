# 十月计划/审计文档落地核查（只读，代码面）

> 核查日期：2026-10-17。范围：`docs/plans` 下 2026-10-10 / 10-11 / 10-16 的各份计划与 PRD，
> 加三份 captcha 计划、`docs/audit/audit-2026-10-16-ticket-field-parity.md`、`docs/audit/10-10.md` §9。
> 目标：核对文档声称「已实现」的能力是否真的在代码里全量落地（文件、符号、路由、前后端接线、测试）。
>
> **口径与限制**
> - 纯只读：只用了 `rg` / `fd` / `ls` / `sed` / `stat`，未改任何源码，未跑构建/测试/lint/装依赖，未碰 git。
> - 不评判 CI：文档里「已实现（待 CI 验证）」只核代码面，本文件不声称任何 job 绿/红，也不复述文档自报的 CI 结论。
> - 「声称」列摘自对应文档的原始文字；「实际」列是核查当时的代码事实（2026-10-17 约 14:00）。
> - 仓库存在并发编辑：核查期间 `docs/audit/audit-2026-10-16-ticket-field-parity.md` 的 mtime 变为 14:04
>   （状态列从「待修」改成「已修 + 证据」）。本文件按读到的最新内容记录，后续回填前请重新对一次 mtime。
> - 行号以核查时文件为准；`rg -n` 只报首个命中位置时已注明。

---

## 0. 结论速览

- **实质代码/功能缺口 7 项**（GEO-G1/G2/G3/G4/G8/G9、LQ-G1；其中 3 项是「声称已实现、实际缺一块」，4 项是「已登记的部分实现」），
  另 **测试缺口 1 项**（GEO-G6）。
- **外部阻断 1 项**（GeoGebra / Pixel 上游授权与 license；文档自己标为 Phase 0 阻断，本轮仍未解除）。
- **文档口径漂移 12 项**（计划/PRD 的勾选或状态描述与实际代码不一致，最集中的是抽奖 PRD）。
- 未发现「声称已实现但完全不存在」的整体功能域：RB、feature consent、captcha 三份、ticket 票面对齐
  的代码面基本全量落地；Geo/Pixel 是「主体已落地 + 少量边角未落地」。
- 10-10 的 ✅ 抽查（25 个符号）全部命中；发现 3 处文档口径问题，未发现假的 ✅。

---

## 1. `docs/plans/2026-10-10-admin-redis-data-browser.md`（RB-01…RB-15）

| 编号 | 声称 | 实际 | 证据 | 缺口 | 建议 |
|---|---|---|---|---|---|
| RB-01 | `redisService` 新增四个只读原语 | 已实现 | `src/services/redisService.ts:329`（scanKeysPage）、`:346`（readKeyMeta）、`:363`（readKeyContent）、`:486`（dumpKeyForExport） | 无 | 收尾回填 |
| RB-02 | `redisAdminService.ts` 新服务 | 已实现（范围解析、概览、分页、单键、流式导出、钳制） | `src/services/redisAdminService.ts:43,52,82,125,203,274,333,347`；测试 `src/tests/redisAdminService.test.ts:20-23` | 无 | 回填 |
| RB-03 | `/api/admin/system/redis/{overview,keys,value,export}` + 两道守卫 + 显式审计 | 已实现；**但 `value` 是 POST 不是计划写的 GET**，其余三个是 GET | `src/routes/admin/system.ts:94,115,152,197`；守卫 `:30,:36`；审计 `auditRedisAdmin` 在每个端点内 | 文档写「GET /api/admin/system/redis/*」，实际单键读取为 `POST /redis/value`（键名不进 URL，属安全改进） | 把计划里的方法改成 POST 并写明理由；这是口径修正，不建议改代码 |
| RB-04 | `admin/index.ts` 挂载 `/system` | 已实现 | `src/routes/admin/index.ts:27,101-102` | 无 | 回填 |
| RB-05 | `adminRedisLimiter` + `adminRedisExportLimiter` | 已实现：40/min 与 3/10min | `src/middleware/routeLimiters.ts:412-417,419-426,768-769` | 计划 §2 写 30/min、§3 表写 40/min，代码取 40；文档内部自相矛盾（非代码缺陷） | 统一为 40/min 并删掉 §2 的 30 |
| RB-06 | `.env.example` 说明 | 已实现 | `.env.example:25` | 无 | 回填 |
| RB-07 | `redisAdminService.test.ts` | 已存在，覆盖范围/钳制/截断/降级/导出 | `src/tests/redisAdminService.test.ts`（20+ 断言点） | 无 | 回填 |
| RB-08 | `adminRedisRoutes.test.ts`（401/403/会话缺失 403/501/NDJSON） | 已存在且断言对应行为 | `src/tests/adminRedisRoutes.test.ts:114,119,136-141,185,195-211,220` | 无 | 回填 |
| RB-09 | 前端类型化客户端，令牌走 header，导出 blob + timeout 0 | 已实现 | `frontend/src/api/adminRedis.ts:95,129-145` | 无 | 回填 |
| RB-10 | `RedisDataBrowser.tsx` | 已实现 | `frontend/src/components/admin/RedisDataBrowser.tsx:198-214`（导出） | 无 | 回填 |
| RB-11 | `SystemManager.tsx` 引入面板 | 已实现，且对全员渲染（服务端仍只认超管） | `frontend/src/components/SystemManager.tsx:27,672` | 无（仅前端可见性，不是授权边界） | 回填 |
| RB-12 | 前端测试三件事：「会话未建立不发请求 / 建立后渲染 / 超管可见性」 | 前两条有；「超管可见性」没有独立用例（mock 直接固定为 superadmin） | `frontend/src/tests/redisDataBrowser.test.tsx:19,55,67,75,89` | 计划声称的第三个断言缺用例 | 补一条非超管角色下的用例（断言不渲染/无请求），或把计划改为两条 |
| RB-13 | `CLAUDE.md` 补位置与两层守卫 | 已实现 | `CLAUDE.md:171` | 无 | 回填 |
| RB-14 | `AGENTS.md` 补前缀与只读定位 | 已实现 | `AGENTS.md:183` | 无 | 回填 |
| RB-15 | `scripts/redis-restore-snapshot.js` 默认 dry-run、`--apply`/`--replace` | 已实现 | `scripts/redis-restore-snapshot.js:23-24,36-37,155` | 无 | 回填 |

**本节缺口：2 项（均为低）。**

---

## 2. `docs/plans/2026-10-10-feature-consent-gate.md`

| 条目 | 声称 | 实际 | 证据 | 缺口 | 建议 |
|---|---|---|---|---|---|
| §3/§4.1 配置叶节点 | `featureConsent.ts` 含键表、需求表、类型守卫 | 已实现，且已扩展到 15 个功能键 | `src/config/featureConsent.ts:52,69,71,85,208,213,218` | 无 | 回填 |
| §4.2 模型 | `userId/username` 字段、`{userId,recordedAt}` 索引、`findValidConsentForUser` | 已实现 | `src/models/policyConsentModel.ts:17-18,135,162` | 无 | 回填 |
| §4.3 服务 | `writePolicyConsent` / `hasValidUserConsent` / `resolveFeatureConsentViews` / 空缓存重置 | 已实现，且只认 userId、要求勾满 | `src/services/policyConsentService.ts:161,283,316,354` | 无 | 回填 |
| §4.4 中间件 | 401 / 403 + 稳定 code + 缺失项 | 已实现 | `src/middleware/featureConsent.ts:24-25,27,35,46-62` | 无 | 回填 |
| §4.5 路由 | `GET /api/policy/feature-consent`；doc-tool 与 image-upload 挂门禁 | 已实现，且 15 个键全部已在路由层接上（含 ipfs/transcribe/tts/shorturl/api-access/cdk/data-report/geo/pixel） | `src/routes/policyRoutes.ts:618`；`src/routes/docToolRoutes.ts:50`；`src/routes/imageDataRoutes.ts:17-27`；其余见 `rg -l requireFeatureConsent src/routes` | 无 | 回填 |
| §4.6 前端 | `fetchFeatureConsent` / `useFeatureConsent` / `FeatureConsentGate` / DocConvertPage / 403 兜底 | 已实现（403 事件 `POLICY_CONSENT_REQUIRED_EVENT` 回弹清单） | `frontend/src/api/policy.ts:283`；`hooks/useFeatureConsent.ts`；`components/FeatureConsentGate.tsx:39-51`；`DocConvertPage.tsx:45`；`docTool/DocBatchPanel.tsx:80-85` | 无 | 回填 |
| §5 隐私地图 | `policy_consents` 增 `userId/username` 并重生生成物 | 已实现 | `docs/governance/privacy-data-map.json:176` | 无 | 回填 |
| §6.1 401/403/放行 | 用例 | 已实现 | `src/tests/featureConsent.test.ts:131,142,159,168,198` | 无 | 回填 |
| §6.2 撤销立即生效 | 用例 | 已实现 | `src/tests/featureConsentRevocation.test.ts:73` | 无 | 回填 |
| §6.3 用户 A 不替 B 通行 | 核心判据用例 | 已实现（含指纹不兜底、B 不满足） | `src/tests/featureConsent.test.ts:178,235,244,275` | 无 | 回填 |
| §6.4 前端清单/放行 | 组件用例 | 已实现 | `frontend/src/tests/featureConsentGate.test.tsx:61,71,81,102` | 无 | 回填 |

**本节缺口：0。** 唯一口径差异：`policyRoutes.ts:618` 的中间件顺序是 `policyRateLimit` 在前、
`authenticateToken` 在后（计划文字相反），不构成行为缺陷，可在回填时顺带改正文字。

---

## 3. `docs/plans/2026-10-10-librechat-quota-ban.md`（§5 后续项）

| 条目 | 声称 | 实际 | 证据 | 缺口 | 建议 |
|---|---|---|---|---|---|
| §5 只读 `GET /api/librechat/quota` | 已实现 | 已实现，不消耗额度 | `src/routes/libreChatRoutes.ts:144-148`；`src/services/libreChatQuotaService.ts:355` | 无 | 回填 |
| §5 `/send`、`/retry` 成功响应内联 `quota` | 已实现 | 已实现 | `src/routes/libreChatRoutes.ts:92-106,281,499` | 无 | 回填 |
| §5 页面额度徽标/进度条/暂停到何时 | 已实现 | 组件 + hook 均在，页面已接 | `frontend/src/components/LibreChatQuotaIndicator.tsx`；`frontend/src/hooks/useLibreChatQuota.ts:15`；`LibreChatPage.tsx:34-37,332-339` | 无 | 回填 |
| §5 管理面板用户详情可见四个字段 | 「走既有用户字段白名单/详情渲染，若已有通用渲染自动生效则不改」 | API 已回字段（白名单含四个），**但管理端 UI 不渲染**：只显示 `dailyUsage` 与 `ticketViolationCount`，没有任何 `libreChat*` | `src/services/userService.ts:190-194`（字段在 select）；`frontend/src/components/UserManagement.tsx:988,1019`（仅这两类） | 计划声称的「用户详情可见」缺前端展示；不是通用渲染，所以「自动生效」的前提不成立 | 在 `UserManagement.tsx` 用户行/详情加「LibreChat 今日用量 / 警告 / 暂停到」三项；或把计划改成「仅 API 可见」并登记为不做 |
| §6 判据 1–7 | 后端单测 | 测试文件在；工单连坐走 `banTicketsBySpillover`，文案不含申诉 | `src/tests/libreChatQuota.test.ts`；`src/services/libreChatQuotaService.ts:207-345`；`src/services/moderationService.ts:346` | 无（未逐条跑测试，只核断言对象存在） | 回填时附 CI 断言 |

**本节缺口：1 项（P2）。**

---

## 4. `docs/plans/2026-10-11-lottery-platform-prd.md`（全部 `[ ]` / `[~]`）

### 4.1 状态与代码相反（文档漂移，需优先改文档）

PRD 开头写明「未打勾的即为未落地」，但 §3/§4 有多处未打勾条目在 §6 已被标 `[x]` 且代码确实存在：

| 编号 | 声称（位置） | 实际 | 证据 | 缺口 | 建议 |
|---|---|---|---|---|---|
| LOT-D1 | §3.2 Pacing `[ ]`（`prd:89`） | 已实现 | `src/services/lottery/pacing.ts:24,32`；`src/tests/lotteryPacing.test.ts:31,38`；§6 `prd:266` | 文档自相矛盾 | 把 `prd:89` 改 `[x]` |
| LOT-D2 | §4.1 三层库存 `[ ]`（`prd:139-142`） | 三层全在 | 内存标记 `src/services/lottery/stock.ts:13-41`；Redis Lua `stock.ts:57-83` + `redisService.ts:282`；DB 前置校验 `lotteryService.ts:650-656`；§6 `prd:267-269` | 文档自相矛盾（且「现状」注释仍说缺显式约束） | 三条改 `[x]` 并删掉过时的「现状」括号 |
| LOT-D3 | §4.2「中奖与履约解耦」`[ ]`（`prd:148`） | 异步履约队列已接 | `src/services/lotteryService.ts:735-738`（enqueue）；`src/services/lotteryFulfillmentService.ts`；§6 `prd:284-288` | 文档自相矛盾（仅 CDN 缓存那一半确实没做） | 拆成两条：解耦标 `[x]`，Redis/CDN 缓存保留 `[ ]` |
| LOT-D4 | §4.3 T+0 / T+1 `[ ]`（`prd:152-153`） | 均实现：T+0 每 5 分钟定时 + 超管端点；T+1 含外部财务源 | `src/services/lottery/reconciliation.ts:30,76`；`src/services/lottery/finance.ts:31,63`；`lotteryService.ts:220,328,1060`；`src/routes/lotteryRoutes.ts:68-69`；§6 `prd:270-273` | 文档自相矛盾 | 两条改 `[x]` |
| LOT-D5 | §3.3 资格来源 `[~]`（`prd:95`，正文称行为任务/汇率「待决策」） | 行为任务、每日限领、积分兑换、超管发积分均已实现 | `src/routes/lotteryRoutes.ts:59,61,63,65-66`；`lotteryService.ts:874-1050`；§6 `prd:259-263` | 文档漂移（欠报实现） | 把 `[~]` 改 `[x]`，把「待决策」限定为「任务种类/汇率取值」而非机制 |

### 4.2 仍未落地（`[ ]` 且代码确实没有；属诚实挂起，不是假声称）

| 编号 | 条目（位置） | 实际 | 缺口类型 | 建议 |
|---|---|---|---|---|
| LOT-O1 | §3.1 六种玩法皮肤（`prd:66-71`） | 只有 `presentation.blocks` 区块渲染，没有转盘/九宫格/盲盒/集卡/老虎机/拼团引擎 | 真实缺失（`[决策]` 皮肤协议未定） | 保留 `[ ]`，等皮肤契约 |
| LOT-O2 | §3.2 多奖池分层（`prd:82`） | 只有「暗池=空奖」语义（软风控走暗池），没有主池/新手回归池 | 真实缺失 | 保留 `[ ]` |
| LOT-O3 | §3.3 社交裂变（`prd:99`） | 无助力/战队/里程碑实体与路由 | 真实缺失 | 保留 `[ ]` |
| LOT-O4 | §3.4 设备与网络、行为轨迹（`prd:106-107`） | `risk.ts` 只吃「同用户/同指纹/同 IP 的短窗计数」，没有 Canvas/OAID/Root/模拟器/代理识别，也没有点击坐标/按压/间隔标准差 | 真实缺失 | 保留 `[ ]` |
| LOT-O5 | §4.2 配置/奖品 Redis+CDN 缓存（`prd:147`） | 无轮次/奖品缓存；Redis 只用于库存计数 | 真实缺失 | 保留 `[ ]` |
| LOT-O6 | §4.4 / Stage 2「下游履约绝对幂等」（`prd:190,245`） | 履约记录只有自身 `id` 唯一索引；没有以「抽奖流水号」为幂等键的下游拦截（重复投递会二次调上游） | 真实缺失（依赖奖励服务对接方） | 保留 `[ ]`；若先做，至少用 `roundId+drawRecordId` 建唯一键 |
| LOT-O7 | Stage 5 ERP/WMS、拖拽画布/画像/QPS（`prd:289,297`） | 无对应实现 | 真实缺失（`[决策]`） | 保留 `[ ]` |

**本节缺口：5 条文档漂移（P2）+ 7 条已登记的未落地（不算假声称）。**

---

## 5. `docs/plans/2026-10-16-geograba-gggggg-synapse-integration-prd-prompt.md`

### 5.1 GeoGebra（GEO-01…24）

| 编号 | 声称 | 实际 | 证据 | 缺口 | 建议 |
|---|---|---|---|---|---|
| GEO-01 | 独立懒加载入口、四模式、切换前提示丢弃拖拽点 | 已实现 | `App.tsx:133,756`；`navConfig.ts:142`；`GeoGebraPage.tsx:55-60,296` | 无 | 回填 |
| GEO-02 | Monaco、行号/折叠/括号/高亮、Ctrl+Enter、不首屏加载 | 已实现（路由级 lazy，Monaco 只在页面 chunk） | `GeoGebraEditor.tsx:5-6,100-111,120` | 无 | 回填 |
| GEO-03 | 预处理、变量统计、定义/引用、风险函数、可配阈值 | 已实现 | `frontend/src/components/geogebra/script.ts:191,226-228,382`；后端 `src/geogebra/scriptValidation.ts` | 无 | 回填 |
| GEO-04 | 生命周期、超时、resize、模式切换销毁旧实例、事件注销 | 已实现（`mode` 变化重建，清理 unregister + 清容器） | `GeoGebraApplet.tsx:184-250` | 无 | 回填 |
| GEO-05 | 顺序执行、单条失败停止、进度/耗时、重复点击不并发 | 已实现 | `GeoGebraApplet.tsx:262-300`；`GeoGebraPage.tsx:223,645,721` | 无 | 回填 |
| GEO-06 | 拖动识别、原/新指令、锁定、冲突确认、不静默覆盖 | 已实现 | `GeoGebraPage.tsx:305-333,382-384`；`script.ts:453` | 无 | 回填 |
| GEO-07 | 四类示例、运行/清空/重置、PNG/GGB/文本导出 | 已实现 | `GeoGebraPage.tsx:49-53,617-624,722-725` | 无 | 回填 |
| GEO-08 | 响应式、移动端、aria、reduced-motion | 基本实现（有 aria/focus/移动布局）；无专门的无障碍测试 | `GeoGebraPage.tsx:631-710` | 测试缺口（并入 GEO-G6） | 补一条 axe/aria 冒烟或登记不做 |
| GEO-09 | 本地项目、元数据、最近 6 个、容错、不存凭据 | 已实现 | `localProjects.ts:4,20-28,70-103,115`；`GeoGebraProjectPanel.tsx:61-64` | 无 | 回填 |
| GEO-10 | 云项目 CRUD、5 分钟自动同步默认关、三态冲突 | 已实现（自动同步默认关，冲突三按钮） | `GeoGebraCloudPanel.tsx:38,58,221-222,382-384` | 无 | 回填 |
| GEO-11 | 版本快照/列表/diff/回滚/撤销/重做、默认保留 24 版 | 快照/列表/diff/应用/撤销重做有；**没有任何 24 版上限或清理**（列表 100，创建时不裁剪） | `projectService.ts:224-248`；`GeoGebraCloudPanel.tsx:509-524`；`GeoGebraProjectPanel.tsx:156-157` | 保留上限未实现，云端版本无界增长 | 在 `createGeoGebraVersion` 后按 `projectId` 裁剪到 24（或 env 配置），或把「24」降级为 `[决策]` 并在 PRD 删掉默认值 |
| GEO-12 | 数字/布尔/字符串参数、滑块、回写/回写+重跑、不误识别 | 已实现 | `script.ts:253-330`；`GeoGebraPage.tsx:777-784` | 无 | 回填 |
| GEO-13 | 全体/选中样式、部分成功/失败反馈、网格/坐标轴 | 已实现（逐对象汇报 skipped 原因） | `GeoGebraPage.tsx:527-540,806-819`；`GeoGebraApplet.tsx:341-360` | 无 | 回填 |
| GEO-14 | 逐条重放、上一步/下一步/自动/停止、演示模式、安全退出全屏 | 已实现 | `GeoGebraPage.tsx:547-600,863` | 无 | 回填 |
| GEO-15 | 图片转脚本异步 job、状态/进度、摘要/命令/置信度、人工确认后预检 | 已实现 | `src/geogebra/aiService.ts:68,96-167`；`jobService.ts:52-141`；`GeoGebraAiPanel.tsx:196-201,321-322` | 无 | 回填 |
| GEO-16 | 概要/关键点/标注/讲解/讲稿；**概要写入注释**；对象级标注勾选；依赖解释 | 四类 AI 能力 + 对象选择 + 写回预览都在；**没有「把概要写入注释」的入口**（摘要只展示，注释面板只能手写） | `aiService.ts:68,103-110`；`GeoGebraAiPanel.tsx:40,275-280,307`；`GeoGebraCommentsPanel.tsx:53` | 概要→注释未实现 | 在 AI 结果区加「写入评论」按钮，调 `createGeoGebraComment({body: summary})`；或从 PRD 删掉该句 |
| GEO-17 | 发布得到 slug、分享 URL、**embed URL**；支持 `?share=<slug>` 载入；fork；公开提示 | 发布/slug/URL/fork/撤销/公开提示都有；**没有 embed URL**；**没有 `?share=` 载入**（只有 `/geogebra/share/:slug` 路由与 `?projectId=`） | `shareService.ts:24-35`（shareView 无 embed 字段）；`GeoGebraSharePanel.tsx:108,138`；`GeoGebraSharePage.tsx:16`；`GeoGebraPage.tsx:65-66` | 两个入口缺失；状态文档未登记为偏差 | 加 `embedUrl`（如 `/geogebra/share/:slug?embed=1`）+ 一个只读嵌入壳；在主工作台读 `?share=` 并转 `/geogebra/share/<slug>`；改文档注明替代 |
| GEO-18 | 上传大小/MIME/扩展/用途/配额；目的限定资产服务；清理与下载权限 | 已实现（魔数、体积、TTL、owner 过滤、清理 sweep） | `assetService.ts:23-32,116-147,163,193-230` | 无 | 回填 |
| GEO-19 | 团队创建、成员列表/添加、项目绑定、四角色、服务端校验 | 已实现（复用 `workspaceService` + `/api/workspaces`，角色 admin/editor/reviewer/viewer） | `workspaceRoutes.ts:57-388`；`workspaceService.ts:88,181,193,206`；`projectService.ts:82-115,120-139` | 无 | 回填 |
| GEO-20 | 评论关联版本/对象、列表/新建/resolved、只能读有权项目 | 已实现 | `reviewCommentService.ts:11-56,67-70`；`GeoGebraCommentsPanel.tsx:53,92-112` | 无 | 回填 |
| GEO-21 | SVG/PDF/GIF/MP4/PPTX/GGB 矩阵；不可用的不放假按钮 | 服务端只做 `zip-bundle`；其余在 capability 表标为画布侧并在 UI 里分区展示（不撒谎） | `jobService.ts:27-40,210-212`；`GeoGebraExportPanel.tsx:17,126,154,161` | 与 PRD「支持这些格式」有差距，但已按 PRD 允许的方式降级；**PRD §9.1 验收表未写入这条缺口说明** | 把能力矩阵补进 PRD §9.1（「服务端仅 zip-bundle，其余画布侧」） |
| GEO-22 | 服务/Mongo/配置/队列/计数/分位/上传分布/最近任务资产分享 | 部分：服务、Mongo、AI 配置、计数、最近任务、最近分享有；**缺 worker/队列、静态资源、最近资产**；分位与上传分布显式 null | `adminDiagnosticsService.ts:53-105`；`src/routes/admin/geogebra.ts:22`；`GeoGebraAdminPanel.tsx:120-130,174` | 三项字段缺失（不是谎报：UI 对 null 有说明） | 补 `queue: {tts, jobs}` 与 `recentAssets`、`staticAssets` 状态；或把 PRD 列表按「已实现/无数据源」两栏改写 |
| GEO-23 | Scamalytics 复用、不混写 proxycheck | 已实现为复用（无第二套 provider） | `src/utils/scamalytics.ts`；`ipVerificationService.ts:9,15-22` | 无 | 回填 |
| GEO-24 | 读 admin + 页面授权、写 superadmin、限流/审计 | 已实现 | `src/routes/admin/geogebra.ts:22,34`；`src/config/adminPages.ts:35` | 无 | 回填 |

### 5.2 Pixel（PIX-01…14）

| 编号 | 声称 | 实际 | 证据 | 缺口 | 建议 |
|---|---|---|---|---|---|
| PIX-01 | 首次提示、读完才可勾选、今天不再弹、只是浏览器便利状态 | 已实现 | `PixelNoticeDialog.tsx:8-78`；`pixelPreferences.ts:8-27` | 无 | 回填 |
| PIX-02 | 卡密验证、Enter、额度新旧字段、valid=false 仍可看历史 | 已实现 | `PixelCardPanel.tsx:55,70-76`；`cardService.ts:46,86-93,158-161`；`types.ts:122-131` | 无 | 回填 |
| PIX-03 | 三服务枚举、0.5/1/1.5、开关、关闭回退并通知 | 已实现 | `types.ts:14,22-24`；`PixelWorkbenchPage.tsx:69,100`；`PixelCardPanel.tsx:112-115` | 无 | 回填 |
| PIX-04 | 每行一账号、格式、行数/大小/重复校验、凭据不落盘 | 已实现（整批拒绝、重复检测、只回行号） | `src/pixel/accountText.ts:1-80`；`runtime.ts:46-50`；`src/tests/pixelAccountText.test.ts` | 无 | 回填 |
| PIX-05 | task id、5s 轮询、终态停止、全状态枚举、排队位 | 已实现 | `PixelWorkbenchPage.tsx:38,131-133`；`types.ts:27-39,71-92`；`PixelTaskPanel.tsx:80,89-91` | 无 | 回填 |
| PIX-06 | 按卡密+账号关键字、每页 10、分页、导出入口、空/错态 | 已实现 | `PixelHistoryPanel.tsx:22,37-41,52,97-104`；`pixelRoutes.ts:270-286` | 无 | 回填 |
| PIX-07 | 单任务/按卡密导出 `email----result_link`、文件名、服务端复验 | 已实现（`task_<id>_success.txt` / `all_tasks_success_<ts>.txt`） | `upstreamViews.ts:109-123`；`taskService.ts:505-519`；`pixelRoutes.ts:390` | 无 | 回填 |
| PIX-08 | 只允许 pending、确认、幂等、刷新 | 已实现（已取消幂等返回、非 pending 409） | `taskService.ts:604-627`；`PixelWorkbenchPage.tsx:232` | 无 | 回填 |
| PIX-09 | 20/10/60 限流、双键、上游错误不泄漏、重试幂等 | 已实现（`userIpDualKey`；幂等键客户端生成） | `routeLimiters.ts:382-403`；`pixelPreferences.ts:29-33` | 无 | 回填 |
| PIX-10 | 去掉独立 admin OAuth/session，走 Synapse 认证 | 已实现（`src/pixel` 与 pixel 路由无 admin/auth、callback、admin_sessions） | `rg` 无命中；`pixelRoutes.ts:104` 整树 `authenticateToken` | 无 | 回填 |
| PIX-11 | 创建（自填/自动生成）、列表、复制、删除、遮罩、加密、唯一 | 已实现 | `cdkMappingService.ts:88,118-148,187`；`pixelCdkMappingModel.ts:39-40`；`PixelAdminPanel.tsx:164,191,219-222` | 无（没有启停开关，但 UI 也不显示假按钮，符合「不放假按钮」） | 回填 |
| PIX-12 | 按分发 CDK 过滤、默认 50/1–200、脱敏、详情不显示原文 | 已实现（游标分页；只存遮罩/大小/状态） | `usageLogService.ts:44-48,90-140`；`pixelRoutes.ts:296,325` | 无 | 回填 |
| PIX-13 | 运行时配置分组、effective value/来源/是否覆盖/热更分类、允许字段保存与恢复默认、禁止受保护字段 | **部分**：独立集合 `pixel_integration_configs`，只有 `GET/PUT /api/admin/pixel/configs`；没有「恢复默认」端点、没有来源/是否覆盖/热更分类展示，也没有与 `runtimeConfigService` 的分组整合 | `integrationConfigService.ts:9-12,195-235`；`admin/pixelRoutes.ts:361,370` | 与 PRD 的接口与语义都有差距；状态文档只登记了「独立集合」，未登记缺「恢复默认/来源分类」 | 二选一：把该配置并入 `runtimeConfigService` 分组（按文档已写的迁移路径），并补 `DELETE /configs`（恢复默认）与 `source/overridden/reload` 字段；或把 PIX-13 明确拆成「已实现的子集」写进状态表 |
| PIX-14 | proxy/worker/queue/upstream 状态、任务/错误/延迟/请求大小；无数据源要显式说明 | **部分**：只有 config/mappings/usage/tasks；没有 proxy/worker/queue、错误率、延迟、请求大小分位，也没有「无数据」占位（字段本身不存在） | `dashboardService.ts:18-57`；`PixelAdminPanel.tsx:376-399` | 指标面缺一半 | 按 PRD 要求补 `proxy/worker/queue` 与 `errors/latency/size` 区块（无数据时显式 null + 原因），或在状态表标为「本阶段不做」 |

### 5.3 Phase 0…5

| 阶段 | 声称 | 实际（代码面） | 缺口 |
|---|---|---|---|
| Phase 0 | 进行中；阻断项：geograba license、GeoGebra Web API 许可、Pixel 上游授权/正式 API | 仓库内没有新增 license 证据；上游适配器确实 fail-closed（未配置即 `PIXEL_UPSTREAM_NOT_CONFIGURED`，有 allowlist） | **外部阻断未解除**（GEO-G7）：上线前必须拿到书面许可/正式 API 契约；代码不能替代 |
| Phase 1 | 已实现（待 CI） | GEO-01…08 均落地（见上），无前端测试 | 测试缺口 GEO-G6 |
| Phase 2 | 已实现（待 CI） | GEO-09…14 落地；GEO-11 缺 24 版上限 | GEO-G3 |
| Phase 3 | 已实现（待 CI） | GEO-15…21 落地；GEO-16/17/22 有边角缺口 | GEO-G1/2/4/5 |
| Phase 4 | 已实现（待 CI） | PIX-01…09 全部落地 | 无 |
| Phase 5 | 已实现（待 CI） | PIX-10…14 落地；PIX-13/14 为部分 | GEO-G8/9 |

### 5.4 测试面（PRD 明确要求、当前没有的部分）

| 编号 | 声称 | 实际 | 证据 | 缺口 | 建议 |
|---|---|---|---|---|---|
| GEO-G6 | Phase 1「浏览器状态/销毁/切换冒烟规格」；§10-D「权限拒绝、跨用户隔离、public share 删除失效、队列任务到期、下载授权」都要用例 | 后端只有 AI/资产/job/脚本校验四个套件；**project/version/comment/share/workspace 权限、share 撤销后失效、fork、资产越权、job 归属均无测试**；**前端 Geo/Pixel 页面测试为零** | `src/tests/geogebra{ScriptValidation,AiService,AssetService,JobService}.test.ts`；`frontend/src/tests` 下无 geo/pixel（pixel 只有后端套件 `pixelRoutes`、`pixelAdminRoutes`、`pixelCredentialPolicy` 等） | 隔离/撤销/越权这类安全断言没有任何自动化证据 | 至少补：`geogebraAccess.test.ts`（他人项目/评论/资产 404、viewer 不能写、fork 关拒绝）、`geogebraShareRevoke.test.ts`（撤销后 `getShare`/cover/fork 全 404）、一条 React 冒烟（页面懒加载 + 模式切换） |

**本节缺口：10 项（1 项外部阻断、6 项代码/功能、1 项测试、2 项文档口径）。**

---

## 6. captcha 三份计划（2026-10-01）

### 6.1 `captcha-providers-trycap-2026-10-01.md`

| 条目 | 声称 | 实际 | 证据 | 缺口 | 建议 |
|---|---|---|---|---|---|
| B1 供应商模型 | 三家常量、`enabled`/`weight` 解耦、凭据状态与原因 | 已实现 | `providers.ts:73-129,265-361`；`models.ts` | 无 | 回填 |
| B2 概率引擎 | `crypto.randomInt` 加权、全 0 回退、纯函数可注入 | 已实现 | `providers.ts:325-361`；`allocation.ts` | 无 | 回填 |
| B3 trycap | siteverify、10s、fail-closed、widget 固定 0.1.58、CSP | 已实现 | `cap.ts:120-206,211-233`；`CapWidget.tsx:16`；`contentSecurityPolicy.ts:27-30,69-72` | 无 | 回填 |
| B4 管理端 | 新面板、三卡片、平均/仅此/全下线/批量/自检/离开提醒/即时生效 | 已实现（四页签控制台，含预设、Ctrl/Cmd+S、未保存提醒、自检） | `CaptchaProviderAdmin.tsx:42-47,289,333-346,473`；`admin/captcha-providers/*` | 无 | 回填 |
| B5 月度额度 | 月粒度、hcaptcha 10000、0=不限、用尽摘出候选、历史接口 | 已实现 | `quota.ts:20,100-114`；`captchaQuotaModel.ts:35`；`turnstileRoutes.ts:388`；`providers.ts:288-291` | 无 | 回填 |
| B6 治理 | openapi 注释、生成物、≤1500 行、单测 | 代码面满足；未跑漂移闸门（不评 CI） | `src/tests/captchaProviderSelection.test.ts`、`captchaQuota.test.ts` | 无 | 回填 |
| P1–P7 文件清单 | P4 列 `frontend/src/hooks/useCapConfig.ts`(新) | **该文件不存在**；能力由 `CapWidget` 的 `siteKey/apiEndpoint` props 完成 | `ls frontend/src/hooks` 无 cap 相关文件；`CapWidget.tsx:45-55` | 计划文件清单与实现不一致（无功能影响） | 改计划删掉该 hook，注明配置由 `useSecureCaptchaSelection`/`ManagedCaptcha` 下发 |

### 6.2 `captcha-allocation-console-2026-10-01.md`

| 条目 | 声称 | 实际 | 证据 | 缺口 |
|---|---|---|---|---|
| B1 场景/策略/修饰 | scenario、weighted/round_robin/failover、sticky、rollout、failoverMaxAttempts | 已实现（纯函数 + 可注入随机源） | `allocation.ts:42-47,92-96,152-315`；`providers.ts:285-361` | 无 |
| B2 外观统一 | 全局 theme/size/language/署名 + 公开下发 | 已实现 | `captchaSelection.ts`；`CaptchaProviderAdmin` 外观页签；CSP | 无 |
| B3 四页签控制台 | 总览/策略（模拟器+当前选谁）/外观（实机预览）/额度统计；粘性保存栏、快捷键、徽标、提醒 | 已实现 | `admin/captcha-providers/{OverviewTab,AllocationTab,...}.tsx`；`CaptchaProviderAdmin.tsx:54-57,289,333-346,665` | 无 |
| B4 新接口 | providers 扩字段、policy/widgets/simulate/selection/stats、secure-config 扩参 | 已实现 | `turnstileRoutes.ts:330,345,388,417,451,470,484,498` | 无 |
| B5 治理/测试 | 纯引擎单测 | 已实现 | `src/tests/captchaAllocation.test.ts`、`captchaProviderSelection.test.ts` | 无 |

### 6.3 `captcha-page-takeover-2026-10-01.md`

| 条目 | 声称 | 实际 | 证据 | 缺口 |
|---|---|---|---|---|
| 请求契约 | `captchaProvider` + `captchaToken` 回退链 | 已实现 | `challenge.ts:9-12` | 无 |
| 统一闸门/校验 | `getCaptchaRequestPolicy` + `verifyCaptchaChallenge` + `verifyRequiredCaptcha` | 已实现 | `providers.ts`；`verify.ts:51`；`auth/_state.ts:112-148`；`turnstileService.ts:47,69` | 无 |
| 后端接管清单 | 登录/注册/忘记/重置/TTS/图床/抽奖/CDK/Cloudflare | 全部接上 | `loginHandlers.ts:109`；`passwordResetHandlers.ts:41`；`registrationHandlers.ts:74`；`tts.pipeline.ts:306`；`ipfsService.ts:473`；`lotteryService.ts:538`；`cdkService.ts:388` | 无（Cloudflare 页前端已用 `ManagedCaptcha`） |
| 前端组件 | `ManagedCaptcha` + 各页接管 + failover | 已实现 | `ManagedCaptcha.tsx`；`LoginPage/RegisterPage/ForgotPasswordPage/ResetPasswordPage/TTSForm/ImageUploadPage/LotteryPage/ResourceStoreList/CloudflareChallengePage` 均引用 | 无 |
| 管理端接管范围 | 面板 + 直达诊断 | 已实现 | `OverviewTab.tsx:162`；`admin/captcha-providers/types.ts:248` | 无 |

**本节缺口：1 项（低，文件清单漂移）。**

---

## 7. `docs/audit/audit-2026-10-16-ticket-field-parity.md`（TP 交叉验证）

> 该文件在核查期间被并发更新（mtime `2026-10-17 14:04`）；当前 §三 状态列已全部填「已修/挂起」，
> §七 有逐条对账。以下按代码独立复核，供交叉验证。

| 编号 | 文档结论 | 代码复核 | 证据 | 缺口 |
|---|---|---|---|---|
| TP-01 联系邮箱 | 已修 | 字段在模型/视图/创建/管理端改 | `src/models/ticketModel.ts:135`；`ticketApi.ts:225` | 无 |
| TP-02 类型 | 已修 | `type` 枚举 + 筛选/徽标 | `ticketModel.ts:124`；`TicketFilters.tsx:221` | 无 |
| TP-03 相关服务 | 已修 | `relatedService` + `relatedServiceRef` | `ticketModel.ts:126-128` | 无 |
| TP-04 关联工单 | 已修 | `relatedTicketId` 等 | `ticketModel.ts:136-137` | 无 |
| TP-05 附件 | 已修 | 独立集合、上传/下载/删除路由、白名单/1MB/5 个 | `ticketAttachmentModel.ts`；`ticketAttachments.ts`；`ticketRoutes.ts:115-124` | 无 |
| TP-06 includeInternal | 已修 | 改/删消息响应带 `includeInternal` | `ticketController.ts:1208,1236` | 无 |
| TP-07 ageHours | 已修 | 本地投影按时间锚计算 | `TicketSystem.tsx:263-279,305` | 无 |
| TP-08 日期区间 | 已修 | 前端控件 + API 透传 | `TicketFilters.tsx:33-34,98-99`；`ticketApi.ts:261-263` | 无 |
| TP-09 createTicket 类型 | 已修 | 形参声明全部字段 | `ticketApi.ts:217-228` | 无 |
| TP-10 每页条数 | 已修 | `limit` 控件 | `TicketFilters.tsx:36,52` | 无 |
| TP-11 assignee 筛选 | 挂起 | 前端仍无入口，后端保留 | `TicketFilters.tsx` 无 assignee 选择 | 按原计划挂起，不算缺口 |
| TP-12 隐私地图 | 已修 | 两数据集 + 生成物 | `privacy-data-map.json:1451,1481`；`privacyDataMap.ts:532` | 无 |
| TP-13 上传开关 | 已修 | 运行时分区默认 false + 管理端点 + 403 码 | `runtimeConfigDefaults.ts:641`；`ticketController.ts:1268` | 无 |
| TP-14 链接输入框双态 | 已修 | 两种状态都渲染 | `TicketCreateForm.tsx:287-298`；`TicketAttachments.tsx:66-101` | 无 |

**本节缺口：0（TP-11 为已声明的挂起）。**

---

## 8. `docs/audit/10-10.md` §9 落地点抽查

抽查方式：对 §8 中标记 ✅ 的编号机械搜符号/文件，共抽 25 项。

| 抽查项 | 声称 | 实际 | 证据 | 结论 |
|---|---|---|---|---|
| RC-02 账户级 step-up | ✅ | 符号在 | `src/middleware/accountStepUpGuard.ts` | 通过 |
| RC-03 单次令牌 | ✅ | 在 | `src/models/stepUpChallengeModel.ts`（`step_up_challenges` 集合） | 通过 |
| RC-04 风险字段/聚合 | ✅ | 在 | `riskScore/riskFlags/...` + `evaluateAccountRisk` | 通过 |
| RC-05 emailCanonical/注册配额 | ✅ | 在 | `src/utils/userRepository.ts`、`registration_attempts` | 通过 |
| RC-06 登录 IP 沉淀 | ✅ | 在 | `account_ip_signals` | 通过 |
| RC-07 六个动作 | ✅ | 六个枚举齐全 | `accountRiskService.ts:613-618,670-686` | 通过 |
| RC-08 前端编排 | ✅ | 在 | `StepUpGate.tsx`、`utils/stepUp.ts` | 通过 |
| RC-12 security_events 索引 | ✅ | 在 | `securityEventModel.ts:42` | 通过 |
| RC-13 地区策略 | ✅ | 前后端都在 | `regionGuard`、`/admin/region-policy/setting`、`EnvManager` 的 `RegionPolicySection` | 通过 |
| RC-16 指纹分量 | ✅ | 在 | `device_fingerprints`、`FP_*` | 通过 |
| RC-17 拼车检测 | ✅ | 在 | `loadSharingFacts`、`detectAccountSharingSuspected` | 通过 |
| RC-18 API 节奏 | ✅ | 在 | `api_usage_windows`、`evaluateApiUsageFlags` | 通过 |
| RC-19 Key 三态 | ✅ | 在 | `apiKeyModel.ts:20-26,53-56`；`apiKeyAuth.ts:75-79` | 通过 |
| RC-23 保留文档 | ✅ | 在 | `docs/reference/data-retention-and-legal-hold.md` | 通过 |
| RC-34 邮件预览沙箱 | ✅ | 在（实现位于前端 EmailSender，非服务端文件） | `frontend/src/components/EmailSender.tsx:1133-1142,1528-1534` | 通过 |
| RC-36 PoW | ✅ | 在 | `stepUpService.ts:195,207,226`；`stepUp.test.ts` | 通过 |
| RC-40 安全会话 TTL | ✅ | 在 | `securitySession.ts` 读运行时 `ttlSeconds` | 通过 |
| RC-42 蜜罐 | ✅ | 在 | `src/security/honeypot.ts:22-115`；`securityPolicy.ts:66-67,81-82` | 通过 |
| RC-43 Tarpit | ✅ | 在 | `honeypot.ts`（`getActiveTarpitConnections`） | 通过 |
| RC-44 超管豁免 | ✅ | 在 | `riskExemption.ts:59`；`accountRiskService.ts:479` | 通过 |
| RC-45 routeKey | ✅ | 在（无独立测试文件，断言在 stepUp 测试里） | `src/utils/routeKey.ts`；`src/tests/stepUp.test.ts:41-52` | 通过 |
| RC-47 墓碑/部分唯一索引 | ✅ | 在 | `src/services/migrations/rc47UserDataPartialUniqueIndexes.ts:39,50,208` | 通过 |
| RC-49 设计语言 | ✅ | 两个文件 hex 归零 | `rg -c "#[0-9a-fA-F]{3,8}"` 无命中 | 通过 |
| RC-59 TOTP 单次 | ✅ | 在 | `totpVerificationService.ts`；`TOTP_CODE_REUSED` 于 `totpController.ts:216` | 通过 |
| RC-60 updatePipeline | ✅ | 9 处站点均带 | `rg "updatePipeline: true" src` | 通过 |
| RC-62 公开 FBI 页 | ✅ | 在 | `postTamperModules.ts:487-498`（`publicEndpoints` 三项） | 通过 |

发现的文档口径问题：

| 编号 | 位置 | 问题 | 建议 |
|---|---|---|---|
| AUD-G1 | `10-10.md:2112-2117` | §9.1 说「声称待修的条目反向抽检（如 `quotaLadderService` / `regionGuard` / `legal_holds` 应当不存在）」，但 `regionGuard`（RC-13 ✅）与 `legal_holds`（RC-22 🟡）都真实存在，反向抽检前提写错 | 改成只把真正「待修」的符号列进去，或删掉该反向抽检说明 |
| AUD-G2 | `10-10.md:2076,2156` | RC-31 仍称 `image-upload/ipfs-upload/transcribe/tts-generate/deeplx-translate/shorturl/api-access/cdk-redeem/data-report` 九个键「仍未挂」；实际 15 个键已全部在路由层接上 | 把 RC-31 改 ✅ 并注明接线位置（`imageDataRoutes.ts:17-27`、`ipfsRoutes.ts:143`、`postTamperModules.ts:642`、`ttsRoutes.ts:124`、`deeplxRoutes.ts:10`、`shortUrlRoutes.ts:92`、`apiKeyRoutes.ts:55`、`cdkRoutes.ts:47`、`dataCollectionRoutes.ts:34`） |
| AUD-G3 | `10-10.md:2045,2066` | RC-15、RC-57 标 ✅，但同一格仍留「待做」（`geoRisk` 单一入口 / `navigator.webdriver` 接入），状态词自相矛盾 | 统一为「✅（行为已统一；重构项另记）」或降为 🟡 |

**本节缺口：3 项（均为低，文档口径）。**

---

## 9. 汇总

### 9.1 必须修复（按严重度）

| 序 | 编号 | 严重度 | 一句话 | 证据 | 可编辑范围提示 |
|---|---|---|---|---|---|
| 1 | GEO-G1 | P1 | GEO-17 声称的 embed URL 完全没有；`?share=<slug>` 也不能载入 | `src/geogebra/shareService.ts:24-35`；`GeoGebraPage.tsx:65-66` | `src/geogebra/shareService.ts`、`src/routes/geogebraRoutes.ts`、`frontend/src/components/geogebra/{GeoGebraSharePage,GeoGebraSharePanel,GeoGebraPage}.tsx`、`frontend/src/App.tsx` |
| 2 | GEO-G6 | P1 | Geo 的跨用户/团队/分享撤销/资产越权没有任何测试；Geo/Pixel 前端测试为零，PRD 明确要求 | `src/tests` 仅 4 个 geo 套件；`frontend/src/tests` 无 geo/pixel | `src/tests/geogebra*.test.ts`、`frontend/src/tests/`（新文件） |
| 3 | GEO-G8 | P1 | PIX-13 的「运行时配置」实际是独立集合，缺恢复默认、来源/覆盖/热更分类，未并入 `runtimeConfigService` | `src/pixel/integrationConfigService.ts:9-12`；`admin/pixelRoutes.ts:361,370` | `src/pixel/integrationConfigService.ts`、`src/routes/admin/pixelRoutes.ts`、`src/services/runtimeConfigService.ts`、`src/components/admin/PixelAdminPanel.tsx` |
| 4 | LOT-D1…D5 | P1（文档） | 抽奖 PRD 是「唯一事实源」，但 5 处 `[ ]`/`[~]` 与 §6 的 `[x]` 及代码相反 | `prd:89,95,139-142,148,152-153` vs `:264-273` | 只改 `docs/plans/2026-10-11-lottery-platform-prd.md` |
| 5 | GEO-G7 | P1（外部） | Phase 0 的 license / 上游授权仍无仓库内证据，不能上线 | 状态表 `prd:383`；无新增证据文件 | 文档 + 法务/上游沟通，不是代码 |
| 6 | LQ-G1 | P2 | 管理端用户详情看不到 LibreChat 四个配额字段（计划声称可见） | `UserManagement.tsx:988,1019`；`userService.ts:190-194` | `frontend/src/components/UserManagement.tsx` |
| 7 | GEO-G3 | P2 | GEO-11 的「默认保留 24 个版本」没有实现，云端版本无界增长 | `src/geogebra/projectService.ts:224-248` | `src/geogebra/projectService.ts`（+ env 常量） |
| 8 | GEO-G2 | P2 | GEO-22 概览缺 worker/队列、静态资源、最近资产 | `adminDiagnosticsService.ts:53-105` | `src/geogebra/adminDiagnosticsService.ts`、`frontend/src/components/admin/GeoGebraAdminPanel.tsx` |
| 9 | GEO-G9 | P2 | PIX-14 总览缺 proxy/worker/queue 与错误/延迟/请求大小 | `src/pixel/dashboardService.ts:18-57` | 同上 + `src/pixel/usageLogService.ts`（聚合） |
| 10 | GEO-G4 | P3 | GEO-16 缺「概要写入注释」 | `GeoGebraAiPanel.tsx:307` | `frontend/src/components/geogebra/GeoGebraAiPanel.tsx` |
| 11 | GEO-G5（文档） | P3 | GEO-21 服务端只有 zip-bundle，PRD §9.1 验收表没写这个缺口 | `jobService.ts:27-40`；`prd:311` | PRD §9.1 |
| 12 | RB-G1/RB-G2 | P3 | RB 计划写 GET 而实际 POST；RB-12 第三条测试缺失 | `routes/admin/system.ts:152`；`frontend/src/tests/redisDataBrowser.test.tsx` | 计划文档 + 前端测试 |
| 13 | CAP-G1 | P3 | 计划的 `useCapConfig.ts` 不存在（无功能影响） | `CapWidget.tsx:45-55` | 计划文档 |
| 14 | AUD-G1…G3 | P3 | 10-10 §9.1 反向抽检前提错、RC-31 漏登清单过期、RC-15/57 状态词自相矛盾 | 见 §8 | `docs/audit/10-10.md` |

### 9.2 可挂起（需 owner 裁决）

| 编号 | 内容 | 挂起理由 | 需要谁裁决 |
|---|---|---|---|
| LOT-O1 | 六种玩法皮肤 | 皮肤契约/动效/素材未定，属产品设计 | 产品 |
| LOT-O2 | 主池/新手回归池/暗池分层 | 需要用户生命周期标签与预算模型 | 产品 + 运营 |
| LOT-O3 | 社交裂变 | 需要活动运营规则与反作弊设计 | 产品 |
| LOT-O4 | 设备指纹/行为轨迹风控 | 涉及隐私采集与误杀，需与现有 RC-16/17 的设备台账口径对齐 | 安全 + 产品 |
| LOT-O5 | 轮次/奖品 Redis+CDN 缓存 | 当前量级未压测，先观察；接入 CDN 涉及部署 | 运维 |
| LOT-O6 | 下游履约绝对幂等 | 依赖奖励服务对接方给出的流水号契约 | 奖励服务对接方 |
| LOT-O7 | ERP/WMS、拖拽画布、画像/QPS 指标 | 外部系统/指标平台未定 | 运维 + 产品 |
| GEO-G7 | GeoGebra/Pixel 上游授权与 license | 需要法务与上游书面许可，代码不能替代 | 法务/owner |
| GEO-G5 | GEO-21 非 zip 格式 | 已按「画布侧能力」降级，是否要做服务端编码（GIF/MP4/PPTX）需成本评估 | 产品 |
| TP-11 | 按指定客服筛选 | 需要新的管理员检索接口，超出票面对齐范围 | 产品 |
| RB-G1 | `/redis/value` 用 GET 还是 POST | 安全上 POST 更优，建议改文档而非改代码 | owner 一句话确认 |
| GEO-G3 的「24」 | 版本保留上限取 24 还是别的数 | PRD 把它写成「默认行为」，但数据保留策略未定 | 产品/数据保留 |

### 9.3 按文档分布

| 文档 | 实质代码缺口 | 文档漂移/口径 | 备注 |
|---|---|---|---|
| `2026-10-10-admin-redis-data-browser.md` | 0 | 2 | RB-12 测试少一条；value 方法口径 |
| `2026-10-10-feature-consent-gate.md` | 0 | 0 | 全部落地（含 15 个功能键接线） |
| `2026-10-10-librechat-quota-ban.md` | 1 | 0 | 管理端 UI 字段 |
| `2026-10-11-lottery-platform-prd.md` | 0（7 项已诚实登记为 `[ ]`） | 5 | §3/§4 勾选与 §6 相反 |
| `2026-10-16-geograba-gggggg-...-prompt.md` | 6（GEO-11/16/17×2/22、PIX-13/14，归并为 G1–G4/G8/G9） | 1（GEO-21 验收表） | 另含 1 项外部阻断（G7）、1 项测试缺口（G6） |
| 三份 `captcha-*2026-10-01.md` | 0 | 1 | 仅文件清单漂移 |
| `audit-2026-10-16-ticket-field-parity.md` | 0 | 0 | TP 全部落地（TP-11 挂起） |
| `10-10.md` §9 | 0（抽查 25 项皆命中） | 3 | §9.1 前提、RC-31、RC-15/57 |
| **合计** | **7 代码 + 1 测试 + 1 外部** | **12** | 另有 7 条自登记 `[ ]` 未算缺口；合计 21 条需动作 |

### 9.4 未核查 / 不可在只读模式下判定

- 任何 CI job 的结论（`Node Verification`、`Quality Guardrails`、`openapi-drift`、`admin-spa-paths`、
  `privacy-contract`、bundle 预算、Docker）——按约束不跑、不查。
- 文档自报的「本地闸门全 PASS」「265 条路径对账一致」：未复现，不作为结论。
- 真实浏览器行为（Cap `instrumentation` CSP、GeoGebra 脚本/CDN 可用性、GeoGebra applet 生命周期）
  ——只核了代码路径，没有实跑。
- 生成物与 `privacy-data-map.json` 的字节级一致性（只看字段/条目存在）。

### 9.5 回填提示

- RB 与 consent 两节可以直接按 §1/§2 的证据行号回填「已实现」。
- 抽奖 PRD 建议先只改勾选（LOT-D1…D5），不要因为「代码在」就把 §4.2 的 CDN 缓存也一起打勾。
- Geo 的六项代码/功能缺口里，GEO-17 的 embed 与 `?share=` 是最容易被用户直接撞到的；
  其余五项（版本上限、诊断字段、概要写注释、PIX-13/14）可以分批。
- 10-10 的三处文档问题改文字即可，不涉及代码。
