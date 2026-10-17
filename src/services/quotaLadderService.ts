import logger from "../utils/logger";

/**
 * 通用「日额度 → 软警告 → 阶梯封禁」引擎（RC-29 / RC-37）。
 *
 * 为什么抽出来：这套逻辑原先写在 `libreChatQuotaService` 里（字段名、上海日键、管理员豁免、
 * 警告计数、封禁时长表全是 LibreChat 专属）。下一个昂贵通道（转写/文档转换/高成本工具）
 * 要复用时只能整段复制，而**复制出来的第二份一定会漂移** —— 尤其是「违规次数跨日累计」
 * 与「封禁时长按次数递增」这两条反直觉规则。
 *
 * 本模块只做**纯编排**：不做 IO、不 import mongoose、不读 env。持久化与字段命名由调用方
 * 通过 `QuotaLadderStore` 提供，因此在单测里可以用内存替身把每条分支钉死。
 *
 * 规则（与 LibreChat 现行实现逐条一致，响应体形状不变）：
 * 1. 封禁中 → 拒绝（且不消耗当日额度）；
 * 2. 当日额度内 → 放行并原子 +1；
 * 3. 超额 → 记一次警告（跨日归零）；
 * 4. 警告达到 maxWarnings → 按**累计封禁次数**查时长表封禁（封禁计数不随自然日归零）；
 * 5. 管理员/超管豁免（不计数、不封禁）。
 */

export type QuotaLadderCode = string;

export interface QuotaLadderState {
  role?: string;
  /** 当前用量归属的日键（如 "2026-10-17"）。与今天不同即视为跨日。 */
  usageDay?: string;
  used?: number;
  /** 当日警告次数（跨日归零）。 */
  warnings?: number;
  /** ISO 时间串；缺失/脏数据按未封禁处理。 */
  bannedUntil?: string | null;
  /** 累计封禁次数（跨自然日不清零）——升档依据。 */
  banCount?: number;
}

export interface QuotaLadderView {
  dailyLimit: number;
  used: number;
  remaining: number;
  banned: boolean;
  bannedUntil: string | null;
  warnings: number;
  maxWarnings: number;
}

export type QuotaLadderDecision<TCode extends QuotaLadderCode = QuotaLadderCode> = {
  allowed: boolean;
  view: QuotaLadderView;
  code?: TCode;
  /** 被拒时的中文说明：讲清「现在什么状态、什么时候能再用」。 */
  message?: string;
  retryAfterSeconds?: number;
};

/**
 * 持久化适配口。四个写操作都必须是**原子**的（调用方用单条 findOneAndUpdate 实现），
 * 因为并发请求会同时越过「读一次再写一次」的缝隙。
 */
export interface QuotaLadderStore {
  /** 存储不可用时是否还能判定。false ⇒ 引擎直接放行（额度不是安全边界）。 */
  isAvailable(): boolean;
  read(userId: string): Promise<QuotaLadderState | null>;
  /** 额度内 → 原子 +1 并返回新状态；超额/封禁/豁免 → null。 */
  consume(userId: string, dayKey: string, dailyLimit: number): Promise<QuotaLadderState | null>;
  /** 原子 +1 一次警告（跨日先归零）；用户已消失等边界 → null。 */
  addWarning(userId: string, dayKey: string): Promise<QuotaLadderState | null>;
  /** 写入封禁到期时间并累计封禁次数。 */
  applyBan(userId: string, bannedUntilIso: string): Promise<QuotaLadderState | null>;
  /** 管理员解封。 */
  clearBan(userId: string): Promise<void>;
}

export interface QuotaLadderBanContext {
  userId: string;
  resource: string;
  banHours: number;
  /** 本次是第几次封禁（1 起）。 */
  offenseIndex: number;
  bannedUntil: Date;
  reason: string;
}

export interface QuotaLadderConfig {
  /** 持久化适配口：四个写操作都必须原子（见 QuotaLadderStore 注释）。 */
  store: QuotaLadderStore;
  /** 资源标识，只用于日志/理由文案（如 "librechat"）。 */
  resource: string;
  dailyLimit: number;
  maxWarnings: number;
  /** 第 n 次封禁对应的小时数；超长取最后一档。 */
  banHoursTable: number[];
  /** 豁免角色（只比 role 字符串，与各模块既有口径一致）。 */
  exemptRoles: string[];
  /** 上海自然日键等；由调用方决定归桶语义。 */
  dayKey(now: Date): string;
  codes: { dailyLimit: QuotaLadderCode; banned: QuotaLadderCode };
  messages: {
    dailyLimit(warnings: number, remainingWarnings: number): string;
    banned(bannedUntil: Date): string;
  };
  /** 写入封禁后的模块内联动（如工单连坐）；失败只告警，不能把已决定的 403 变成 500。 */
  onBan?(context: QuotaLadderBanContext): void | Promise<void>;
  /**
   * 封禁动作走账户风险统一出口（RC-07）。与 onBan 分开：onBan 是模块内连坐，
   * 这里只负责把处罚事实登记到账户风险体系，失败同样只告警。
   */
  onBanApplied?(context: QuotaLadderBanContext): void | Promise<void>;
}

/** 取正整数的环境变量（非法/0/负数一律回落默认，并收敛上限）。 */
export function readPositiveIntEnv(name: string, fallback: number, max: number): number {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed) || Math.floor(parsed) < 1) {
    return fallback;
  }
  return Math.min(Math.floor(parsed), max);
}

/** `A,B,C` 形状的时长表；非法项丢弃，空表回落默认。 */
export function readHourTableEnv(name: string, fallback: number[]): number[] {
  const raw = (process.env[name] || "").trim();
  if (!raw) return [...fallback];
  const parsed = raw
    .split(",")
    .map((entry) => Number(entry.trim()))
    .filter((hours) => Number.isFinite(hours) && hours >= 1)
    .map((hours) => Math.min(Math.floor(hours), 24 * 365));
  return parsed.length > 0 ? parsed : [...fallback];
}

/** 第 n 次封禁（1 起）对应的小时数；超出表长用最后一档。 */
export function banHoursForOffense(table: number[], offenseIndex: number): number {
  const safe = Array.isArray(table) && table.length > 0 ? table : [24];
  const index = Math.max(0, Math.floor(Number(offenseIndex) || 1) - 1);
  return safe[Math.min(index, safe.length - 1)];
}

/**
 * 只有「解析成功且仍在未来」才算封禁中。脏数据一律按未封禁处理 ——
 * 解析失败就把用户永久挡在门外，比放行危险得多。
 */
export function resolveBannedUntil(state: QuotaLadderState | null, now: Date): Date | null {
  const raw = state?.bannedUntil;
  if (typeof raw !== "string" || !raw.trim()) return null;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime()) || parsed.getTime() <= now.getTime()) return null;
  return parsed;
}

function isExempt(state: QuotaLadderState | null, exemptRoles: string[]): boolean {
  return exemptRoles.includes(String(state?.role || ""));
}

export function buildQuotaLadderView(
  state: QuotaLadderState | null,
  now: Date,
  config: Pick<QuotaLadderConfig, "dailyLimit" | "maxWarnings" | "dayKey" | "exemptRoles">,
): QuotaLadderView {
  const sameDay = state?.usageDay === config.dayKey(now);
  const used = sameDay ? Math.max(0, Math.floor(Number(state?.used) || 0)) : 0;
  const warnings = sameDay ? Math.max(0, Math.floor(Number(state?.warnings) || 0)) : 0;
  const exempt = isExempt(state, config.exemptRoles);
  const bannedUntil = resolveBannedUntil(state, now);

  return {
    dailyLimit: config.dailyLimit,
    // 跨日的数据在读数时就算成 0：归零由下一次消费落库，但状态展示不该等到那时候。
    used,
    // 豁免角色不受日额度限制，剩余按整额展示（不写用量）。
    remaining: exempt ? config.dailyLimit : Math.max(0, config.dailyLimit - used),
    banned: bannedUntil !== null,
    bannedUntil: bannedUntil ? bannedUntil.toISOString() : null,
    warnings,
    maxWarnings: config.maxWarnings,
  };
}

async function runHook(
  label: string,
  hook: ((context: QuotaLadderBanContext) => void | Promise<void>) | undefined,
  context: QuotaLadderBanContext,
  userId: string,
): Promise<void> {
  if (!hook) return;
  try {
    await hook(context);
  } catch (error) {
    logger.error(`[QuotaLadder] ${label} 失败（处罚已落库，不回滚）`, {
      userId,
      resource: context.resource,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export interface QuotaLadder<TCode extends QuotaLadderCode = QuotaLadderCode> {
  limits: { dailyLimit: number; maxWarnings: number; banHoursTable: number[] };
  consume(userId: string): Promise<QuotaLadderDecision<TCode>>;
  read(userId: string): Promise<QuotaLadderView>;
  clearBan(userId: string): Promise<void>;
}

/**
 * 构造一个阶梯闸门实例。同一个 config 可以为不同资源各建一份（互不共享内存状态）。
 */
export function createQuotaLadder<TCode extends QuotaLadderCode>(
  config: QuotaLadderConfig & { codes: { dailyLimit: TCode; banned: TCode } },
): QuotaLadder<TCode> {
  const { store, dailyLimit, maxWarnings } = config;

  const viewOf = (state: QuotaLadderState | null, now: Date) =>
    buildQuotaLadderView(state, now, config);

  const bannedDecision = (
    state: QuotaLadderState,
    bannedUntil: Date,
    now: Date,
  ): QuotaLadderDecision<TCode> => ({
    allowed: false,
    code: config.codes.banned,
    message: config.messages.banned(bannedUntil),
    retryAfterSeconds: Math.max(1, Math.ceil((bannedUntil.getTime() - now.getTime()) / 1000)),
    view: viewOf(state, now),
  });

  async function consume(userId: string): Promise<QuotaLadderDecision<TCode>> {
    const now = new Date();
    const today = config.dayKey(now);

    // 额度计数依赖持久层：不可用时**放行**而不是拒绝。额度不是安全边界
    // （网关侧还有限流），在此 fail-closed 会把「数据库抖动」放大成整站功能不可用。
    if (!store.isAvailable()) {
      return { allowed: true, view: viewOf(null, now) };
    }

    const consumed = await store.consume(userId, today, dailyLimit);
    if (consumed) {
      return { allowed: true, view: viewOf(consumed, now) };
    }

    // 未命中：分辨是封禁中、豁免角色，还是额度已满需要记一次警告。
    const current = await store.read(userId);
    if (!current) {
      // 账号已不存在之类的边界：auth 层已拒绝未知账号，这里不代它做拦截，也不写库。
      logger.warn("[QuotaLadder] 未找到用户文档，跳过额度判定", { resource: config.resource, userId });
      return { allowed: true, view: viewOf(null, now) };
    }
    const bannedUntil = resolveBannedUntil(current, now);
    if (bannedUntil) {
      return bannedDecision(current, bannedUntil, now);
    }
    if (isExempt(current, config.exemptRoles)) {
      // 豁免角色：不消耗额度、也不写库。
      return { allowed: true, view: viewOf(current, now) };
    }

    const warned = await store.addWarning(userId, today);
    if (!warned) {
      // 并发窗口：读取与警告自增之间用户被改角色或删除。按最新事实回答，不凭过期判断写库。
      const latest = await store.read(userId);
      const latestBannedUntil = latest ? resolveBannedUntil(latest, now) : null;
      if (latest && latestBannedUntil) {
        return bannedDecision(latest, latestBannedUntil, now);
      }
      return { allowed: true, view: viewOf(latest, now) };
    }

    const warnings = Math.max(1, Math.floor(Number(warned.warnings) || 0));
    if (warnings < maxWarnings) {
      return {
        allowed: false,
        code: config.codes.dailyLimit,
        message: config.messages.dailyLimit(warnings, maxWarnings - warnings),
        view: viewOf(warned, now),
      };
    }

    // 警告到阈值：按累计封禁次数查表得到本次时长（默认 24h → 7d → 30d）。
    const currentBanCount = Math.max(0, Math.floor(Number(warned.banCount) || 0));
    const offenseIndex = currentBanCount + 1;
    const banHours = banHoursForOffense(config.banHoursTable, offenseIndex);
    const bannedUntilAt = new Date(now.getTime() + banHours * 60 * 60 * 1000);
    const bannedUntilIso = bannedUntilAt.toISOString();
    const banned = await store.applyBan(userId, bannedUntilIso);
    const context: QuotaLadderBanContext = {
      userId,
      resource: config.resource,
      banHours,
      offenseIndex,
      bannedUntil: bannedUntilAt,
      reason: `${config.resource} 每日额度内多次警告后继续使用`,
    };

    // 两个联动钩子互不阻塞：任一失败都不能把已决定的 403 变成 500。
    await runHook("模块连坐", config.onBan, context, userId);
    await runHook("账户风险统一出口", config.onBanApplied, context, userId);

    return bannedDecision(
      banned ?? { ...warned, bannedUntil: bannedUntilIso },
      bannedUntilAt,
      now,
    );
  }

  return {
    limits: { dailyLimit, maxWarnings, banHoursTable: config.banHoursTable },
    consume,
    read: async (userId) => {
      const now = new Date();
      if (!store.isAvailable()) return viewOf(null, now);
      return viewOf(await store.read(userId), now);
    },
    clearBan: (userId) => store.clearBan(userId),
  };
}
