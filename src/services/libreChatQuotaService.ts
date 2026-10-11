import logger from "../utils/logger";
import type { User as UserType } from "../utils/userStorageTypes";
import { mongoose } from "./mongoService";
import { ModerationService } from "./moderationService";
import { getUserUsageDay, UserModel, updateUser } from "./userService";

/**
 * LibreChat 每日生成额度 + 超额自动封禁（方案：docs/plans/2026-10-10-librechat-quota-ban.md）。
 *
 * 为什么不复用 TTS 的 `dailyUsage`：那是翻译/TTS 的当日计数，同一字段再给 LibreChat 用会让两个
 * 功能互吃额度；这里另开一组字段，只把「按上海自然日归桶」的语义照搬
 * userService.incrementUserDailyUsageAtomic。
 *
 * 判定顺序（方案 §2，唯一依据）：封禁中 → 额度内放行 → 超额警告 → 警告到阈值自动封禁
 * → 跨日归零 → 管理员豁免。所有分支都返回完整 view，便于前端讲清「现在什么状态」。
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
// 未配置 / 空串 / NaN / 0 / 负数一律回落默认，并收敛上限：把 NaN 或天文数字带进 $lt 条件，
// 会让闸门恒真（等于没有额度）或恒假（所有普通用户都被拦）。
function readPositiveIntEnv(name: string, fallback: number, max: number): number {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed) || Math.floor(parsed) < 1) {
    return fallback;
  }
  return Math.min(Math.floor(parsed), max);
}

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
 * 拿它当升级依据的话“第二次违规”永远不会发生。封禁次数是跨日累计的事实。
 * 表长之外一律用最后一档（默认第三档起 30 天）。env `LIBRECHAT_BAN_HOURS_TABLE` 可覆盖。
 */
function readBanHoursTable(): number[] {
  const raw = (process.env.LIBRECHAT_BAN_HOURS_TABLE || "").trim();
  if (!raw) return [LIBRECHAT_BAN_HOURS, 24 * 7, 24 * 30];
  const parsed = raw
    .split(",")
    .map((entry) => Number(entry.trim()))
    .filter((hours) => Number.isFinite(hours) && hours >= 1)
    .map((hours) => Math.min(Math.floor(hours), 24 * 365));
  return parsed.length > 0 ? parsed : [LIBRECHAT_BAN_HOURS, 24 * 7, 24 * 30];
}

const LIBRECHAT_BAN_HOURS_TABLE = readBanHoursTable();

/** 第 n 次封禁（1 起）对应的小时数；超出表长用最后一档。 */
export function banHoursForOffense(offenseIndex: number): number {
  const index = Math.max(0, Math.floor(offenseIndex) - 1);
  return LIBRECHAT_BAN_HOURS_TABLE[Math.min(index, LIBRECHAT_BAN_HOURS_TABLE.length - 1)];
}

/**
 * 「同一天」的判据：字段里直接存上海天键（getUserUsageDay），管道里 $eq 即可，
 * 不必再对时间戳做 $convert/$dateToString 时区换算。
 */
function sameUsageDayExpr(today: string) {
  return { $eq: [{ $ifNull: ["$libreChatUsageDay", ""] }, today] };
}

/**
 * 把库里的 ISO 封禁到期时间转成 Date；字段缺失或解析失败都得到 null（= 未封禁）。
 * 脏数据一律视为未封禁：解析失败就把人挡在门外，比放行危险得多。
 */
const BANNED_UNTIL_DATE = {
  $convert: { input: "$libreChatBannedUntil", to: "date", onError: null, onNull: null },
};

/** 额度闸门依赖 Mongo；连接不可用时放行而不是拒绝（见 consumeLibreChatQuota 的说明）。 */
function isDatabaseReady(): boolean {
  return mongoose.connection.readyState === 1;
}

async function readQuotaDocument(userId: string): Promise<LibreChatQuotaDocument | null> {
  const doc = await UserModel.findOne({ id: userId }).select(QUOTA_SELECT).lean();
  return (doc ?? null) as unknown as LibreChatQuotaDocument | null;
}

/** 只有「解析成功且仍在未来」才算封禁中；已过期与脏数据都按未封禁处理。 */
function resolveBannedUntil(doc: LibreChatQuotaDocument | null, now: Date): Date | null {
  const raw = doc?.libreChatBannedUntil;
  if (typeof raw !== "string" || !raw.trim()) return null;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime()) || parsed.getTime() <= now.getTime()) return null;
  return parsed;
}

function buildQuotaView(doc: LibreChatQuotaDocument | null, now: Date): LibreChatQuotaView {
  const sameDay = doc?.libreChatUsageDay === getUserUsageDay(now);
  const used = sameDay ? Math.max(0, Math.floor(Number(doc?.libreChatDailyUsage) || 0)) : 0;
  const warnings = sameDay ? Math.max(0, Math.floor(Number(doc?.libreChatViolationCount) || 0)) : 0;
  const isAdmin = ADMIN_ROLES.includes(String(doc?.role || ""));
  const bannedUntil = resolveBannedUntil(doc, now);

  return {
    dailyLimit: LIBRECHAT_DAILY_LIMIT,
    // 跨日的数据在读数时就算成 0：归零由下一次消费的管道落库，但状态展示不该等到那时候。
    used,
    // 管理员不受日额度限制，剩余按整额展示（不写用量，见 §2.5）。
    remaining: isAdmin ? LIBRECHAT_DAILY_LIMIT : Math.max(0, LIBRECHAT_DAILY_LIMIT - used),
    banned: bannedUntil !== null,
    bannedUntil: bannedUntil ? bannedUntil.toISOString() : null,
    warnings,
    maxWarnings: LIBRECHAT_MAX_WARNINGS,
  };
}

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

function buildDailyLimitMessage(warnings: number, remainingWarnings: number): string {
  return `今天 ${LIBRECHAT_DAILY_LIMIT} 次已用完，再继续将被封禁一天（第 ${warnings} 次警告，还剩 ${remainingWarnings} 次警告）`;
}

function buildBannedDecision(
  doc: LibreChatQuotaDocument,
  bannedUntil: Date,
  now: Date,
): LibreChatQuotaDecision {
  return {
    allowed: false,
    code: "LIBRECHAT_BANNED",
    message: `LibreChat 权限已被暂停，将于 ${formatBannedUntilLabel(bannedUntil)} 恢复`,
    retryAfterSeconds: Math.max(1, Math.ceil((bannedUntil.getTime() - now.getTime()) / 1000)),
    view: buildQuotaView(doc, now),
  };
}

/** 消耗一次额度；超额走警告/自动封禁。所有分支都返回完整 view 便于前端展示状态。 */
export async function consumeLibreChatQuota(userId: string): Promise<LibreChatQuotaDecision> {
  const now = new Date();
  const today = getUserUsageDay(now);

  // 额度计数依赖 Mongo：连接不可用时**放行**而不是拒绝。额度不是安全边界（网关侧还有 libreChatLimiter），
  // 在此处 fail-closed 会把「数据库抖动」放大成整站聊天不可用；与 moderationService.logEvent 的
  // readyState 前置判断同一取舍。
  if (!isDatabaseReady()) {
    return { allowed: true, view: buildQuotaView(null, now) };
  }

  const sameDay = sameUsageDayExpr(today);

  // G2-29 同款写法：单条 findOneAndUpdate + 聚合管道一次完成「封禁判断 + 跨日重置 + 增量 + 管理员豁免」。
  // 先读再写会在并发请求下超支（多个请求都读到 used=4 再各自 +1），所以这里不做「读一次再写一次」。
  // 命中即「放行且已扣一次」；未命中再去分辨是封禁中、管理员，还是额度已满。
  const consumed = (await UserModel.findOneAndUpdate(
    {
      id: userId,
      role: { $nin: ADMIN_ROLES },
      $and: [
        // 封禁中的请求绝不命中（因此不消耗额度）：到期时间比较放进 filter，避免与封禁写入竞争。
        // 未设置 / 解析失败都得到 null，与它比较即「未封禁」。
        {
          $expr: {
            $or: [{ $eq: [BANNED_UNTIL_DATE, null] }, { $lte: [BANNED_UNTIL_DATE, now] }],
          },
        },
        // 跨日或额度未满才可能命中：跨日分支同时把用量与警告一起归零（见下面的 $set）。
        { $or: [{ $expr: { $not: [sameDay] } }, { libreChatDailyUsage: { $lt: LIBRECHAT_DAILY_LIMIT } }] },
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

  if (consumed) {
    return { allowed: true, view: buildQuotaView(consumed, now) };
  }

  // 未命中：分辨是封禁中、管理员豁免，还是额度已满需要记一次警告。
  const current = await readQuotaDocument(userId);
  if (!current) {
    // 账号已不存在之类的边界：auth 层已拒绝未知账号，这里不代它做拦截，也不写库。
    logger.warn("[LibreChatQuota] 未找到用户文档，跳过额度判定", { userId });
    return { allowed: true, view: buildQuotaView(null, now) };
  }
  const bannedUntil = resolveBannedUntil(current, now);
  if (bannedUntil) {
    return buildBannedDecision(current, bannedUntil, now);
  }
  if (ADMIN_ROLES.includes(String(current.role || ""))) {
    // 管理员豁免：不消耗额度、也不写库。
    return { allowed: true, view: buildQuotaView(current, now) };
  }

  // 到这里只剩「非管理员 + 未封禁 + 今日额度已满」：记一次警告（原子 +1，跨日先归零）。
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

  if (!warned) {
    // 并发窗口：读取与警告自增之间用户被改角色或删除。按最新事实回答，不凭过期判断写库。
    const latest = await readQuotaDocument(userId);
    const latestBannedUntil = latest ? resolveBannedUntil(latest, now) : null;
    if (latest && latestBannedUntil) {
      return buildBannedDecision(latest, latestBannedUntil, now);
    }
    return { allowed: true, view: buildQuotaView(latest, now) };
  }

  const warnings = Math.max(1, Math.floor(Number(warned.libreChatViolationCount) || 0));
  if (warnings < LIBRECHAT_MAX_WARNINGS) {
    return {
      allowed: false,
      code: "LIBRECHAT_DAILY_LIMIT",
      message: buildDailyLimitMessage(warnings, LIBRECHAT_MAX_WARNINGS - warnings),
      view: buildQuotaView(warned, now),
    };
  }

  // 警告到阈值：LibreChat 权限停用 banHours 小时，并同时停用工单权限（方案 §2.3）。
  const currentBanCount = Math.max(0, Math.floor(Number(warned.libreChatBanCount) || 0));
  // RC-37：本次是第 currentBanCount + 1 次封禁 → 查表得到时长（默认 24h → 7d → 30d）。
  const banHours = banHoursForOffense(currentBanCount + 1);
  const bannedUntilAt = new Date(now.getTime() + banHours * 60 * 60 * 1000);
  const bannedUntilIso = bannedUntilAt.toISOString();
  const banned = (await UserModel.findOneAndUpdate(
    { id: userId, role: { $nin: ADMIN_ROLES } },
    { $set: { libreChatBannedUntil: bannedUntilIso }, $inc: { libreChatBanCount: 1 } },
    { returnDocument: "after" },
  )
    .select(QUOTA_SELECT)
    .lean()) as unknown as LibreChatQuotaDocument | null;

  // 工单封禁走 moderationService 的**连坐**入口：允许停用高成本通道，
  // 但不递增 ticketViolationCount —— 那个计数只代表工单系统自身的违规次数，
  // 被 LibreChat 推动会让从不在工单里违规的用户被工单梯级判成「多次违规、永久封禁」。
  try {
    await ModerationService.banTicketsBySpillover(
      userId,
      banHours,
      "LibreChat 每日额度内多次警告后继续使用",
      "librechat-quota",
    );
  } catch (error) {
    // LibreChat 侧封禁已经落库：工单侧写失败不该把已决定的 403 变成 500，
    // 否则用户看到的是「服务器错误」而不是「权限已被暂停」。
    logger.error("[LibreChatQuota] 自动封禁：工单权限封禁写入失败", { userId, error });
  }

  return buildBannedDecision(
    banned ?? { ...warned, libreChatBannedUntil: bannedUntilIso },
    bannedUntilAt,
    now,
  );
}

/**
 * 只读查询（不消耗额度）：页面/状态端点用。当前由被拒的 403 响应内联返回 quota 字段，
 * 端点按需再接，不是漏接线。封禁期间照样可读——被停的是一天里「跟模型对话」的权限，
 * 不是查看自己状态的能力。
 */
export async function readLibreChatQuota(userId: string): Promise<LibreChatQuotaView> {
  const now = new Date();
  if (!isDatabaseReady()) {
    return buildQuotaView(null, now);
  }
  return buildQuotaView(await readQuotaDocument(userId), now);
}

/**
 * 管理员解封：封禁时间与警告计数一起清掉。只清封禁时间的话，残留的警告计数会让下一次超额
 * 立刻再次触发自动封禁，等于没解封。
 *
 * 注：四个 libreChat* 字段还没登记进 utils/userStorageTypes 的 User 类型（不在本次改动范围），
 * 故用类型断言让 updateUser 接受；写路径仍复用 userService（含缓存失效）。
 */
export async function clearLibreChatBan(userId: string): Promise<void> {
  await updateUser(userId, {
    libreChatBannedUntil: undefined,
    libreChatViolationCount: undefined,
  } as Partial<UserType>);
}
