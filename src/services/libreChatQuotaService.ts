import logger from "../utils/logger";
import type { User as UserType } from "../utils/userStorageTypes";
import {
  banHoursForOffense as banHoursFromTable,
  createQuotaLadder,
  readHourTableEnv,
  readPositiveIntEnv,
  type QuotaLadderConfig,
  type QuotaLadderState,
  type QuotaLadderStore,
} from "./quotaLadderService";
import { mongoose } from "./mongoService";
import { ModerationService } from "./moderationService";
import { getUserUsageDay, UserModel, updateUser } from "./userService";

/**
 * LibreChat 每日生成额度 + 超额自动封禁（方案：docs/plans/2026-10-10-librechat-quota-ban.md）。
 *
 * RC-29：额度/警告/封禁三段逻辑已迁移到 `quotaLadderService`，本文件只剩
 * **持久化适配 + LibreChat 专属文案**。响应体（`LibreChatQuotaView` / `LibreChatQuotaDecision`）
 * 与状态码/错误码保持原样，调用方不需要改。
 *
 * 为什么不复用 TTS 的 `dailyUsage`：那是翻译/TTS 的当日计数，同一字段再给 LibreChat 用会让两个
 * 功能互吃额度；这里另开一组字段，只把「按上海自然日归桶」的语义照搬
 * userService.incrementUserDailyUsageAtomic。
 */

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
  | "LIBRECHAT_DAILY_LIMIT" // 超额（警告阶段）
  | "LIBRECHAT_BANNED"; // 封禁中（含刚被封）

export interface LibreChatQuotaDecision {
  allowed: boolean;
  view: LibreChatQuotaView;
  code?: LibreChatQuotaCode;
  /** 被拒时的中文说明：讲清「现在什么状态、什么时候能再用」，不提申诉 */
  message?: string;
  /** 封禁剩余秒数（封禁时给，供 Retry-After） */
  retryAfterSeconds?: number;
}

/** 限额与阈值来源（env，带默认值）：LIBRECHAT_DAILY_LIMIT=5 / LIBRECHAT_MAX_WARNINGS=3 / LIBRECHAT_BAN_HOURS_TABLE=24,168,720 */
export const LIBRECHAT_QUOTA_DEFAULTS: { dailyLimit: number; maxWarnings: number; banHours: number } = {
  dailyLimit: 5,
  maxWarnings: 3,
  banHours: 24,
};

/** 与 incrementUserDailyUsageAtomic 相同的角色豁免口径：只排除 admin / superadmin（trusted 照常计数）。 */
const ADMIN_ROLES = ["admin", "superadmin"];

const QUOTA_SELECT =
  "id role libreChatDailyUsage libreChatUsageDay libreChatViolationCount libreChatBannedUntil libreChatBanCount";

/** 本模块读写的那几个用户字段。 */
interface LibreChatQuotaDocument {
  id?: string;
  role?: string;
  libreChatDailyUsage?: number;
  libreChatUsageDay?: string;
  libreChatViolationCount?: number;
  libreChatBannedUntil?: string;
  /** RC-37：累计被自动封禁的次数（跨自然日不清零），用于升级封禁时长。 */
  libreChatBanCount?: number;
}

// env 在模块加载时读一次：额度属于运营参数，改它随重启生效（与本仓库其它 env 开关一致）。
const LIBRECHAT_DAILY_LIMIT = readPositiveIntEnv(
  "LIBRECHAT_DAILY_LIMIT",
  LIBRECHAT_QUOTA_DEFAULTS.dailyLimit,
  1000,
);
const LIBRECHAT_MAX_WARNINGS = readPositiveIntEnv(
  "LIBRECHAT_MAX_WARNINGS",
  LIBRECHAT_QUOTA_DEFAULTS.maxWarnings,
  100,
);
const LIBRECHAT_BAN_HOURS = readPositiveIntEnv(
  "LIBRECHAT_BAN_HOURS",
  LIBRECHAT_QUOTA_DEFAULTS.banHours,
  24 * 365,
);

/**
 * RC-37：封禁时长按**累计封禁次数**递增（而不是写死一个常量）。
 *
 * 为什么用“封禁次数”而不是“警告次数”：警告按上海自然日归零（那是用量语义），
 * 拿它当升级依据的话“第二次违规”永远不会发生。封禁计数是跨日累计的事实。
 * 表长之外一律用最后一档（默认 24h → 7d → 30d）。env `LIBRECHAT_BAN_HOURS_TABLE` 可覆盖。
 */
const LIBRECHAT_BAN_HOURS_TABLE = readHourTableEnv("LIBRECHAT_BAN_HOURS_TABLE", [
  LIBRECHAT_BAN_HOURS,
  24 * 7,
  24 * 30,
]);

/** 第 n 次封禁（1 起）对应的小时数（保留旧导出，行为不变）。 */
export function banHoursForOffense(offenseIndex: number): number {
  return banHoursFromTable(LIBRECHAT_BAN_HOURS_TABLE, offenseIndex);
}

/**
 * 统一账户风险出口的接线强度（RC-29 / RC-07）。
 *
 * 默认 `off`：本批次按「新增开关默认观察期」落地 —— 额度滥用是**产品额度**问题，
 * 不是账户被入侵的证据；直接升到 `restrict`（全 Key 降速 + 全站逐步验证）会让
 * 「今天多聊了几句」被判成风险账户。观察期先只落模块封禁与事件，确认误伤率后再开。
 * 可用 `QUOTA_LADDER_ACCOUNT_RISK_ACTION=require_step_up|restrict|suspend` 打开。
 */
type AccountRiskActionForQuota = "off" | "require_step_up" | "restrict" | "suspend";
const QUOTA_LADDER_ACCOUNT_RISK_ACTION: AccountRiskActionForQuota = (() => {
  const raw = String(process.env.QUOTA_LADDER_ACCOUNT_RISK_ACTION || "off").trim().toLowerCase();
  return raw === "require_step_up" || raw === "restrict" || raw === "suspend" ? raw : "off";
})();

/** 「同一天」的判据：字段里直接存上海天键（getUserUsageDay），管道里 $eq 即可。 */
function sameUsageDayExpr(today: string) {
  return { $eq: [{ $ifNull: ["$libreChatUsageDay", ""] }, today] };
}

/**
 * 把库里的 ISO 封禁到期时间转成 Date；字段缺失或解析失败都得到 null（= 未封禁）。
 */
const BANNED_UNTIL_DATE = {
  $convert: { input: "$libreChatBannedUntil", to: "date", onError: null, onNull: null },
};

function isDatabaseReady(): boolean {
  return mongoose.connection.readyState === 1;
}

function toState(doc: LibreChatQuotaDocument | null): QuotaLadderState | null {
  if (!doc) return null;
  return {
    role: doc.role,
    usageDay: doc.libreChatUsageDay,
    used: doc.libreChatDailyUsage,
    warnings: doc.libreChatViolationCount,
    bannedUntil: doc.libreChatBannedUntil ?? null,
    banCount: doc.libreChatBanCount,
  };
}

async function readQuotaDocument(userId: string): Promise<LibreChatQuotaDocument | null> {
  const doc = await UserModel.findOne({ id: userId }).select(QUOTA_SELECT).lean();
  return (doc ?? null) as unknown as LibreChatQuotaDocument | null;
}

/** LibreChat 字段持久化适配：查询形状与迁移前逐字一致（既有用例钉着这些形状）。 */
const libreChatStore: QuotaLadderStore = {
  isAvailable: isDatabaseReady,
  read: async (userId) => toState(await readQuotaDocument(userId)),

  consume: async (userId, today, dailyLimit) => {
    const sameDay = sameUsageDayExpr(today);
    const consumed = (await UserModel.findOneAndUpdate(
      {
        id: userId,
        role: { $nin: ADMIN_ROLES },
        $and: [
          // 封禁中的请求绝不命中（因此不消耗额度）：到期时间比较放进 filter，避免与封禁写入竞争。
          {
            $expr: {
              $or: [{ $eq: [BANNED_UNTIL_DATE, null] }, { $lte: [BANNED_UNTIL_DATE, new Date()] }],
            },
          },
          // 跨日或额度未满才可能命中：跨日分支同时把用量与警告一起归零。
          { $or: [{ $expr: { $not: [sameDay] } }, { libreChatDailyUsage: { $lt: dailyLimit } }] },
        ],
      },
      [
        {
          $set: {
            libreChatUsageDay: today,
            libreChatDailyUsage: {
              $cond: [sameDay, { $add: [{ $ifNull: ["$libreChatDailyUsage", 0] }, 1] }, 1],
            },
            libreChatViolationCount: { $cond: [sameDay, { $ifNull: ["$libreChatViolationCount", 0] }, 0] },
          },
        },
      ],
      { returnDocument: "after", updatePipeline: true },
    )
      .select(QUOTA_SELECT)
      .lean()) as unknown as LibreChatQuotaDocument | null;
    return toState(consumed);
  },

  addWarning: async (userId, today) => {
    const sameDay = sameUsageDayExpr(today);
    const warned = (await UserModel.findOneAndUpdate(
      { id: userId, role: { $nin: ADMIN_ROLES } },
      [
        {
          $set: {
            libreChatUsageDay: today,
            libreChatViolationCount: {
              $add: [{ $cond: [sameDay, { $ifNull: ["$libreChatViolationCount", 0] }, 0] }, 1],
            },
          },
        },
      ],
      { returnDocument: "after", updatePipeline: true },
    )
      .select(QUOTA_SELECT)
      .lean()) as unknown as LibreChatQuotaDocument | null;
    return toState(warned);
  },

  applyBan: async (userId, bannedUntilIso) => {
    const banned = (await UserModel.findOneAndUpdate(
      { id: userId, role: { $nin: ADMIN_ROLES } },
      { $set: { libreChatBannedUntil: bannedUntilIso }, $inc: { libreChatBanCount: 1 } },
      { returnDocument: "after" },
    )
      .select(QUOTA_SELECT)
      .lean()) as unknown as LibreChatQuotaDocument | null;
    return toState(banned);
  },

  clearBan: async (userId) => {
    await updateUser(userId, {
      libreChatBannedUntil: undefined,
      libreChatViolationCount: undefined,
    } as Partial<UserType>);
  },
};

/** 用户可见文案统一按上海时间写，避免用户按 UTC 算出错误的恢复时刻。 */
function formatBannedUntilLabel(bannedUntil: Date): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(bannedUntil);
}

/**
 * 封禁动作的**账户风险统一出口**（RC-07）。
 *
 * 动态 import 而不是顶层 import：`accountRiskService` 会经 apiKey/auth 服务拉进一大片
 * 模块图，而额度闸门是聊天热路径上的模块；更重要的是默认关闭时完全不该加载它。
 */
async function applyAccountRiskActionForBan(context: {
  userId: string;
  banHours: number;
  reason: string;
}): Promise<void> {
  if (QUOTA_LADDER_ACCOUNT_RISK_ACTION === "off") return;
  const { applyAccountRiskAction } = await import("./accountRiskService.js");
  const result = await applyAccountRiskAction({
    userId: context.userId,
    action: QUOTA_LADDER_ACCOUNT_RISK_ACTION as "require_step_up" | "restrict" | "suspend",
    reason: context.reason,
    operatorId: "auto",
    durationHours: context.banHours,
  });
  if (!result.ok) {
    // 统一出口拒绝（如目标是超管/账户已封停）不该把模块封禁回滚，但必须留下线索。
    logger.warn("[LibreChatQuota] 账户风险统一出口未执行", {
      userId: context.userId,
      action: QUOTA_LADDER_ACCOUNT_RISK_ACTION,
      code: result.code,
    });
  }
}

const ladderConfig: QuotaLadderConfig & {
  codes: { dailyLimit: LibreChatQuotaCode; banned: LibreChatQuotaCode };
} = {
  // 持久化适配口（RC-29 抽公共件后由引擎反向依赖）：漏传会让 createQuotaLadder
  // 解构出 undefined，第一次 consume 就抛错 —— 类型上它是必填字段。
  store: libreChatStore,
  resource: "LibreChat",
  dailyLimit: LIBRECHAT_DAILY_LIMIT,
  maxWarnings: LIBRECHAT_MAX_WARNINGS,
  banHoursTable: LIBRECHAT_BAN_HOURS_TABLE,
  exemptRoles: ADMIN_ROLES,
  dayKey: getUserUsageDay,
  codes: { dailyLimit: "LIBRECHAT_DAILY_LIMIT", banned: "LIBRECHAT_BANNED" },
  messages: {
    dailyLimit: (warnings, remainingWarnings) =>
      `今天 ${LIBRECHAT_DAILY_LIMIT} 次已用完，再继续将被封禁一天（第 ${warnings} 次警告，还剩 ${remainingWarnings} 次警告）`,
    banned: (bannedUntil) =>
      `LibreChat 权限已被暂停，将于 ${formatBannedUntilLabel(bannedUntil)} 恢复`,
  },
  // 工单封禁走 moderationService 的**连坐**入口：允许停用高成本通道，
  // 但不递增 ticketViolationCount —— 那个计数只代表工单系统自身的违规次数，
  // 被 LibreChat 推动会让从不在工单里违规的用户被工单梯级判成「多次违规、永久封禁」。
  onBan: async (context) => {
    try {
      await ModerationService.banTicketsBySpillover(
        context.userId,
        context.banHours,
        context.reason,
        "librechat-quota",
      );
    } catch (error) {
      // LibreChat 侧封禁已经落库：工单侧写失败不该把已决定的 403 变成 500。
      logger.error("[LibreChatQuota] 自动封禁：工单权限封禁写入失败", {
        userId: context.userId,
        error,
      });
    }
  },
  onBanApplied: applyAccountRiskActionForBan,
};

const ladder = createQuotaLadder(ladderConfig);

/** 消耗一次额度；超额走警告/自动封禁。所有分支都返回完整 view 便于前端展示状态。 */
export async function consumeLibreChatQuota(userId: string): Promise<LibreChatQuotaDecision> {
  const decision = await ladder.consume(userId);
  return decision as LibreChatQuotaDecision;
}

/**
 * 只读查询（不消耗额度）：页面/状态端点用。当前由被拒的 403 响应内联返回 quota 字段，
 * 端点按需再接，不是漏接线。封禁期间照样可读——被停的是一天里「跟模型对话」的权限，
 * 不是查看自己状态的能力。
 */
export async function readLibreChatQuota(userId: string): Promise<LibreChatQuotaView> {
  return (await ladder.read(userId)) as LibreChatQuotaView;
}

/**
 * 管理员解封：封禁时间与警告计数一起清掉。只清封禁时间的话，残留的警告计数会让下一次超额
 * 立刻再次触发自动封禁，等于没解封。
 */
export async function clearLibreChatBan(userId: string): Promise<void> {
  await ladder.clearBan(userId);
}
