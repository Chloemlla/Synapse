# LibreChat 每日额度 + 自动封禁（普通用户 5 次/日）

> 状态：**方案冻结，待实现**。日期：2026-10-10。
> 触发：普通用户每天 5 次对话；超出后多次警告；无视警告继续 → 自动封禁 LibreChat 权限**一天**，
> 且**同时封禁工单权限**（不给申诉通道）。

## 1. 复用既有机制（不另造一套）

| 需要的能力 | 既有实现 | 本次怎么用 |
|---|---|---|
| 每日额度的原子 check-and-increment（按上海自然日归桶、管理员豁免） | `services/userService.ts` 的 `incrementUserDailyUsageAtomic(id, dailyLimit)` + `getUserUsageDay()` | **照它的形状写一份 LibreChat 专用计数**（见 §3），不直接调它 |
| 工单封禁 | `services/moderationService.ts`（写 `ticketBannedUntil`、`ticketViolationCount`） | 自动封禁时走它的路径，不自己拼字段 |
| 用户字段白名单 | `services/userService.ts` 的字段清单（line ~102/106） | 新字段必须登记进去，否则读出来是 undefined |
| LibreChat 端点 | `routes/libreChatRoutes.ts`（`/api/librechat`，router 内 `authenticateToken`，挂载层 `libreChatLimiter`） | 在「会产生一次生成」的端点上加配额闸门 |

**为什么不直接复用 `dailyUsage`**：那是 TTS 的当日计数（同一个字段再给 LibreChat 用，会让两个功能互吃额度）。
必须另开字段，并把「跨日重置」的语义照搬过来。

## 2. 规则（判定顺序，唯一依据）

1. **封禁中**（`libreChatBannedUntil > now`）→ 403 `LIBRECHAT_BANNED`，带剩余秒数与到期时间；**文案不给申诉入口**。
2. **今日已用 < 5** → 消耗一次（`libreChatDailyUsage += 1`），放行。
3. **今日已用 = 5**（超额请求）→ 记一次警告（`libreChatViolationCount += 1`）：
   - 警告次数 < 3 → 403 `LIBRECHAT_DAILY_LIMIT`，带「这是第 N 次警告，再继续将被封禁一天」与剩余警告次数；
   - 警告次数 ≥ 3 → **自动封禁**：`libreChatBannedUntil = now + 24h` **且** 工单封禁 24h → 返回 `LIBRECHAT_BANNED`。
4. **跨日**（`libreChatUsageDay != 今天`）→ 当日用量与警告次数一起归零后按上面重判。
5. **管理员/超管豁免**（与 `incrementUserDailyUsageAtomic` 同样的 `role` 排除口径）。

只读端点（history / export / clear / messages 删除）**不消耗额度、封禁期间也允许**：
用户被封的是一天里「跟模型对话」的权限，不是自己的历史记录。

## 3. 新增：`src/services/libreChatQuotaService.ts`（冻结接口）

```ts
export interface LibreChatQuotaView {
  dailyLimit: number;
  used: number;
  remaining: number;
  banned: boolean;
  bannedUntil: string | null;
  warnings: number;
  maxWarnings: number;
}

export type LibreChatQuotaCode =
  | "LIBRECHAT_DAILY_LIMIT"      // 超额（警告阶段）
  | "LIBRECHAT_BANNED";          // 封禁中（含刚被封）

export interface LibreChatQuotaDecision {
  allowed: boolean;
  view: LibreChatQuotaView;
  code?: LibreChatQuotaCode;
  /** 被拒时的中文说明：讲清「现在什么状态、什么时候能再用」，不提申诉 */
  message?: string;
  /** 封禁剩余秒数（封禁时给，供 Retry-After） */
  retryAfterSeconds?: number;
}

/** 消耗一次额度；超额走警告/自动封禁。所有分支都返回完整 view 便于前端展示状态。 */
export async function consumeLibreChatQuota(userId: string): Promise<LibreChatQuotaDecision>;

/** 只读查询（不消耗）：页面/状态端点用。 */
export async function readLibreChatQuota(userId: string): Promise<LibreChatQuotaView>;

/** 管理员解封（可选导出，供管理端点复用）。 */
export async function clearLibreChatBan(userId: string): Promise<void>;

/** 限额与阈值来源（env，带默认值）：LIBRECHAT_DAILY_LIMIT=5 / LIBRECHAT_MAX_WARNINGS=3 / LIBRECHAT_BAN_HOURS=24 */
export const LIBRECHAT_QUOTA_DEFAULTS: { dailyLimit: number; maxWarnings: number; banHours: number };
```

存储（用户文档，必须登记进 `userService` 字段清单）：
`libreChatDailyUsage?: number`、`libreChatUsageDay?: string`、`libreChatViolationCount?: number`、`libreChatBannedUntil?: string`。

## 4. 端点接入（`src/routes/libreChatRoutes.ts`）

- `POST /send`、`POST /retry`：进入业务逻辑前调 `consumeLibreChatQuota(req.user.id)`；
  被拒 → 403 + `{ code, error, quota: view, retryAfterSeconds? }`，并设置 `Retry-After`。
- 只读端点不动。
- 网关（`/sse` 之类）若只是转发状态也归类为只读，不消耗额度。

## 5. 前端（最小改动）

- LibreChat 相关页面在发消息前/收到 403 时把 `quota` 与文案展示出来（讲状态、不提申诉）。
- 管理面板可在用户详情看到这四个字段（走既有用户字段白名单/详情渲染，若已有通用渲染自动生效则不改）。

## 6. 判据（后端单测，CI 裁决）

1. 今日第 1~5 次放行，`used` 递增；
2. 第 6 次 → `LIBRECHAT_DAILY_LIMIT` + 警告计数 1，文案含「第 1 次警告」与剩余警告次数；
3. 连续警告到第 3 次 → 自动封禁：`libreChatBannedUntil ≈ now+24h`，**且工单封禁被写入**（断言走了 moderationService 的路径）；
4. 封禁中的请求 → `LIBRECHAT_BANNED`，带 `retryAfterSeconds`，文案**不含**申诉/支持邮箱字样；
5. 跨日 → 用量与警告归零后重新放行；
6. 管理员 → 不受限（`allowed: true` 且不写用量）；
7. 只读端点在被封禁时仍可用（不消耗额度）。
