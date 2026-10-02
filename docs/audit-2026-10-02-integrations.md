# 集成层审查汇总：Svix Webhook / Resend 邮件 / OpenAI API / Redis 缓存 / 推荐系统 / 邀请系统

- 审查日期：2026-10-02
- 范围：`src/services/webhookEventService.ts`、`src/controllers/webhookController.ts`、`src/routes/webhookRoutes.ts`、
  `src/routes/webhookEventRoutes.ts`、`src/services/emailService.ts`、`src/services/emailSender.ts`、
  `src/routes/emailRoutes.ts`、`src/routes/outemailRoutes.ts`、`src/services/emailSender.ts`、
  `src/services/redisService.ts`、`src/services/sharedStateStore.ts`、`src/services/recommendationService.ts`、
  `src/models/recommendationHistoryModel.ts`、`src/routes/invitationRoutes.ts`、`src/services/workspaceService.ts`、
  `src/services/registrationInviteService.ts`、`src/tts/tts.provider-router.ts`
- 判据：本机不做构建/测试（仓库硬性约束），静态读码定位；最终正确性以 `main` 上 CI 为准。
- 说明：每条含编号、文件、类型、详情、改法；编号在实现提交里可追溯。

---

## 一、Svix Webhook（`WH`）

| 编号 | 文件 | 类型 | 详情 | 改法 |
| --- | --- | --- | --- | --- |
| WH-1 | `src/controllers/webhookController.ts`、`src/services/webhookEventService.ts` | 幂等/重放 | `handleResendWebhook` 直接 `WebhookEventService.create(...)`。Svix 对非 2xx 会重投，同一 `svix-id` 会被反复落库；`WebhookEventSchema.index({provider,routeKey,eventId}, {unique:false})` 也不拦重。列表/统计被重试放大，`replay` 又造新记录，无法区分「真事件」与「重投」。 | 新增 `WebhookEventService.ingest()`：按 `(provider, routeKey, eventId)` `findOneAndUpdate` upsert，累加 `deliveryCount`，记录 `firstReceivedAt/lastReceivedAt`；HTTP 入口改走 `ingest`。`create` 保留给手工/测试/replay。 |
| WH-2 | `src/controllers/adminController.ts:194-206`、`src/services/webhookEventService.ts:185-197` | 重复定义 | 两个文件各自 `mongoose.model("WebhookSecret", schema)`，同 collection `webhook_settings`。运行时靠 `mongoose.models` 缓存兜住，但 schema 形状一旦漂移会按「先加载者」结算，静默不一致。 | 由 `webhookEventService` 暴露 `listResendWebhookSecrets()`，管理端只读列表走服务层；不强行改动既有 set/delete 契约，避免连带回归。 |
| WH-3 | `src/services/webhookEventService.ts` | 隐私/保留期 | `webhook_events` 无 TTL、无清理接口。第三方 payload（收件人邮箱、邮件主题、正文片段）无限期留存，且未登记进 `docs/governance/privacy-data-map.json`。 | 新增 `prune(days, {routeKey?, provider?, dryRun?})` + 超管端点；默认保留期常量，先 dryRun 预览再删。 |
| WH-4 | `src/routes/webhookEventRoutes.ts` | 运维可见性 | 只有全局 `stats/groups`，没有「某个 routeKey 最近一次事件、失败率、签名是否已配置」的端点级健康视图；排障只能翻列表。 | 新增 `WebhookEventService.health()`（按 routeKey 聚合 24h/7d、最近事件、失败率）+ `GET /api/webhook-events/health`。 |
| WH-5 | `src/controllers/webhookController.ts:17-24` | 错误语义 | `getResendSecret(routeKey)` 因未配置而抛错时，被同一个 try 当成「签名验证失败」→ 400。运维侧看到的是客户端错误，实际是服务端配置缺失。 | 先取密钥，密钥缺失/未配置 → 503 + 明确文案；签名不合 → 400。 |
| WH-6 | `src/services/webhookEventService.ts:list()` | 性能 | `q` 用 `$or` + 全字段正则，无 text 索引；`page` 无上限，深分页 `skip` 成本线性上升。 | `page` 收敛上限（如 1000），并在响应里带 `hasMore`；不引入新索引（写放大）但收敛输入。 |
| WH-7 | `src/routes/webhookRoutes.ts` | 资源 | `express.raw({ type: "application/json" })` 未设 `limit`，单请求可提交超大 body 占内存；限流在签名之前，伪造 IP 可绕过配额成本。 | `limit: "256kb"`；签名验证失败也计数（限流已在最外层）。 |

## 二、Resend 邮件（`EM`）

| 编号 | 文件 | 类型 | 详情 | 改法 |
| --- | --- | --- | --- | --- |
| EM-1 | `src/controllers/webhookController.ts`、`src/services/emailService.ts` | 合规/送达率 | `email.bounced` / `email.complained` 只落 `webhook_events`，后续发送**不会**跳过该地址。持续向硬退信地址发送会拉低域名声誉，并违反主流 ESP 的合规要求。 | 新增 `email_suppressions` 集合 + `emailSuppressionService`；webhook 收到 bounce/complaint 自动入名单；发送前检查。 |
| EM-2 | `src/services/emailService.ts` | 合规 | 无退订机制，也没有 `List-Unsubscribe` / `List-Unsubscribe-Post` 头。 | 新增一次性退订 token（HMAC）+ `GET/POST /api/email/unsubscribe`；`EmailData.headers` 已支持透传，营销类发信方可挂头（本次先落地端点与名单）。 |
| EM-3 | `src/services/emailService.ts:sendEmail` | 可观测性 | 发送失败只 `logger.error`，无聚合计数；管理端无法看「成功率 / 退信率」。 | 复用 `webhook_events` 的 `email.*` 事件 + 新增抑制统计端点，形成「发送 → 投递事件 → 抑制名单」闭环。 |
| EM-4 | `src/services/emailService.ts` | 抑制前置 | `sendEmail` / `sendBatchEmail` 未做地址抑制检查。 | 在两个入口做 `isEmailSuppressed` 前置；批量逐个过滤，全被抑制则直接返回失败原因。 |

## 三、OpenAI API / TTS 提供方（`OA`）

| 编号 | 文件 | 类型 | 详情 | 改法 |
| --- | --- | --- | --- | --- |
| OA-1 | `src/tts/tts.provider-router.ts` | 可观测性 | OpenAI 的 `baseUrl/model/voice` 只来自运行时配置，管理端没有「连通性自检 + 最近错误」视图。 | 在集成健康中心登记 OpenAI 提供方状态（配置是否齐全、最近失败计数），只读展示，不触发真实外呼。 |
| OA-2 | `src/services/integrationHealthService.ts`（新增） | 凭据泄漏 | 汇总凭据状态时必须只回布尔/掩码，不能回密钥原文。 | 健康视图统一只输出 `configured: boolean` 与掩码前缀。 |

> 注：TTS 生成链路的额度、队列、失败重试在 `src/tts/` 内已有实现，本轮不在范围内改动，只做只读可见性。

## 四、Redis 缓存（`RD`）

| 编号 | 文件 | 类型 | 详情 | 改法 |
| --- | --- | --- | --- | --- |
| RD-1 | `src/services/redisService.ts` | 能力缺口 | 只实现了 IP 封禁；没有通用 `get/set/del/incr/前缀删除/状态` 原语，「Redis 缓存层」实际无法被其他服务复用。 | 扩展通用原语 + `getStatus()` / `getServerStats()`。 |
| RD-2 | `src/services/redisService.ts` | 降级 | `REDIS_URL` 缺失直接 `isEnabled=false`，调用方各自处理 null，没有统一的内存兜底缓存。 | 新增 `cacheService`：Redis 优先、进程内存兜底（带 TTL 与容量上限），缓存层降级不写 Mongo。 |
| RD-3 | `src/services/redisService.ts:33-66` | 就绪判定 | `isConnected` 只在 `connect` 事件置真；`connect` 与 `ready` 之间存在短暂窗口，`isAvailable()` 可能返回真但命令尚未就绪。 | 增加 `ready` / `end` 事件维护 `isReady`，`isAvailable()` 以 `ready` 为准。 |
| RD-4 | 各服务 | 未命中率 | 无命中/未命中统计，无法判断缓存是否有效。 | `cacheService.stats()` 暴露 hits/misses/entries/tier，管理端可视化。 |

## 五、推荐系统（`RC`）

| 编号 | 文件 | 类型 | 详情 | 改法 |
| --- | --- | --- | --- | --- |
| RC-1 | `src/services/recommendationService.ts:recordSelection` | 资源/正确性 | `$push: { generations: record }` 无 `$slice`；长期用户文档无界增长，逼近 MongoDB 16MB 文档上限，且每次读写放大。 | `$slice: -MAX_GENERATIONS`（保留最近 N 条）；`totalCount` 仍单调累加。 |
| RC-2 | `src/models/recommendationFeedbackModel.ts`（新增） | 功能缺失 | 没有显式反馈（喜欢/不喜欢/不感兴趣），偏好只靠隐式历史推断，无法修正。 | 新增反馈集合 + `recordFeedback` / `listFeedback`；推荐时排除「不喜欢/不感兴趣」的风格。 |
| RC-3 | `src/services/recommendationService.ts:getPopularStyles` | 性能 | 每次调用都全表 `$unwind` 聚合，热门列表是热点路径却无缓存。 | 用 `cacheService` 缓存（短 TTL + 前缀失效）。 |
| RC-4 | `src/services/recommendationService.ts:detectLanguage` | 正确性 | `text.length === 0` 时 `chineseChars.length / text.length` → `NaN`，`NaN > 0.3` 为假 → 落到 `en-US`，空串被判英文。 | 空文本直接返回默认语言。 |
| RC-5 | `src/services/recommendationService.ts` | 死配置 | `recommendationSettings.enabledCategories / preferredLanguages / preferredVoices` 被写入但没有任何逻辑读取。 | 让筛选逻辑同时消费这三项（白名单优先、语言/声音偏好加权）。 |
| RC-6 | `src/services/recommendationService.ts` | 输入校验 | `recordSelection` 不校验 `styleId` 长度/字符，任意字符串都会作为风格 id 落库。 | 长度与字符白名单校验。 |
| RC-7 | `src/routes/recommendationRoutes.ts` | 管理端 | 无任何管理端视图（热门风格、反馈分布、活跃度）。 | 新增超管只读分析端点。 |

## 六、邀请系统（`IN`）

| 编号 | 文件 | 类型 | 详情 | 改法 |
| --- | --- | --- | --- | --- |
| IN-1 | `src/routes/invitationRoutes.ts`、`src/services/workspaceService.ts` | 功能缺失 | 工作空间邀请只有 `accept`。`status` 枚举里有 `declined`，但没有任何写入路径，被邀请人只能忽略；邀请人无法撤回/重发。 | 新增 `declineInvitation`（被邀请人）、`revokeInvitation`（邀请人/工作空间管理员）、`listWorkspaceInvitations`；路由补 `POST /invitations/:id/decline`。 |
| IN-2 | `src/services/workspaceService.ts:acceptInvitation` | 正确性 | 已实现邮箱归属校验（G7-10），但 `decline` 也必须做同样的归属校验，否则任何人可凭 invitation id 替他人拒绝。 | `decline` 复用同一邮箱归属校验。 |
| IN-3 | `src/services/registrationInviteService.ts` | 管理端 | 无统计视图（使用趋势、顶级邀请人、过期/停用计数）。 | 新增 `getRegistrationInviteStats()`。 |
| IN-4 | `src/routes/admin/registrationInvites.ts` | 批量 | 只能逐条 `PATCH/DELETE`，停用一批要发 N 次请求。 | 新增批量停用 / 批量删除端点。 |
| IN-5 | `src/models/registrationInviteModel.ts` | 过期 | 过期靠查询时惰性判定；`expiresAt` 有普通索引但无 TTL 任务。 | 统计里按 `expiresAt` 聚合出「已过期」计数；不引入 TTL（保留审计痕迹）。 |

## 七、通用 / 合规（`CO`）

| 编号 | 文件 | 类型 | 详情 | 改法 |
| --- | --- | --- | --- | --- |
| CO-1 | `docs/governance/privacy-data-map.json` | 合规 | 新增的 `email_suppressions`、`recommendation_feedback`、`webhook_events` 未登记数据地图。 | 补登记（用途、保留期、可导出/删除）。 |
| CO-2 | `src/config/adminPages.ts` | 权限登记 | 新增管理页面若未登记 `apiPrefixes`，普通管理员只能看到入口、请求全 403。 | 新增 `integrations` 页面并登记其 API 前缀。 |
| CO-3 | 全局 | 隐私 | 缓存层可能缓存含个人标识的推荐结果；必须用不透明 key（userId 哈希或直接 userId 但不可枚举），并且不缓存凭据。 | 缓存 key 命名空间显式声明；只缓存可重建的派生数据。 |

---

## 去向记录（收尾核对）

| 编号 | 状态 | 落点 |
| --- | --- | --- |
| WH-1 | 已修 | `webhookEventService.ingest()` + controller |
| WH-2 | 已修 | `listResendWebhookSecrets()` |
| WH-3 | 已修 | `prune()` + 管理端点 |
| WH-4 | 已修 | `health()` + `/api/admin/integrations/webhooks` |
| WH-5 | 已修 | controller 503/400 分流 |
| WH-6 | 已修 | `list()` page 上限 |
| WH-7 | 已修 | `express.raw({ limit })` |
| EM-1 | 已修 | `emailSuppressionService` + webhook 自动入名单 |
| EM-2 | 已修 | HMAC 退订 token + `/api/email/unsubscribe` |
| EM-3 | 已修 | 抑制统计端点 |
| EM-4 | 已修 | `sendEmail` / `sendBatchEmail` 前置检查 |
| OA-1 | 已修 | 集成健康中心只读状态 |
| OA-2 | 已修 | 只输出布尔/掩码 |
| RD-1 | 已修 | `redisService` 通用原语 |
| RD-2 | 已修 | `cacheService` 内存兜底 |
| RD-3 | 已修 | `ready`/`end` 事件 |
| RD-4 | 已修 | `cacheService.stats()` |
| RC-1 | 已修 | `$slice: -MAX_GENERATIONS` |
| RC-2 | 已修 | 反馈集合 + 端点 |
| RC-3 | 已修 | 热门风格缓存 |
| RC-4 | 已修 | 空文本短路 |
| RC-5 | 已修 | 白名单 + 偏好加权 |
| RC-6 | 已修 | styleId 校验 |
| RC-7 | 已修 | 管理端分析端点 |
| IN-1 | 已修 | decline/revoke/list |
| IN-2 | 已修 | decline 归属校验 |
| IN-3 | 已修 | stats |
| IN-4 | 已修 | 批量端点 |
| IN-5 | 已修 | 统计口径 |
| CO-1 | 已修 | privacy-data-map |
| CO-2 | 已修 | adminPages `integrations` |
| CO-3 | 已修 | 缓存 key 命名空间 |
