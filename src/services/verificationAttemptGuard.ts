import { sharedStateStore } from "./sharedStateStore";
import logger from "../utils/logger";

/**
 * 二次验证（TOTP / 备用恢复码）失败计数与锁定。
 *
 * 为什么需要独立一层：同一份「失败额度」要在**两条入口**上生效——
 *  1. 登录的二次验证（`controllers/totpController.ts`）；
 *  2. 建立全站安全会话的步骤验证（`routes/admin/profile.ts` 的 `/user/admin/user/profile/verify`），
 *     它是改密码 / 查看密钥 / 改双因素配置 / 解绑第三方的唯一闸门。
 * 之前两边各写各的：登录路径有 5 次锁定，而安全会话路径**一次都不计数**，
 * 等于把最强的爆破面留给了权限最高的操作。
 *
 * 计数落在共享状态存储（Redis → Mongo → 进程内存分层降级）：
 *   - 多副本部署共享同一份额度（进程内 Map 会让真实额度 = 限制 × 实例数）；
 *   - 进程重启 / 滚动发布不再清零；
 *   - TTL = 锁定窗口，失败计数自然过期，不需要额外的容量上限与清扫。
 */

export interface VerificationAttemptPolicy {
  /** 允许的连续失败次数。 */
  limit: number;
  /** 达到上限后的锁定时长（同时是计数条目的 TTL）。 */
  lockoutMs: number;
  /** 共享状态存储的键前缀（不同用途各自独立）。 */
  keyPrefix: string;
}

/** 二次验证：5 次失败锁 15 分钟（沿用历史参数，避免改变用户可感知的锁定节奏）。 */
export const TWO_FACTOR_ATTEMPT_POLICY: VerificationAttemptPolicy = {
  limit: 5,
  lockoutMs: 15 * 60 * 1000,
  keyPrefix: "totp-attempts:",
};

export interface VerificationAttemptStatus {
  allowed: boolean;
  remainingAttempts: number;
  lockedUntil?: number;
}

interface AttemptState {
  count: number;
  lastAttempt: number;
  lockedUntil?: number;
}

function attemptKey(userId: string, policy: VerificationAttemptPolicy): string {
  return `${policy.keyPrefix}${userId}`;
}

/**
 * 读取当前锁定状态。
 *
 * 存储不可用时按「放行」处理：锁定是防爆破的辅助手段，共享状态存储自身已经分层降级，
 * 不应让存储抖动把正常用户挡在门外。
 */
export async function checkVerificationAttempts(
  userId: string,
  policy: VerificationAttemptPolicy = TWO_FACTOR_ATTEMPT_POLICY,
): Promise<VerificationAttemptStatus> {
  let attempts: AttemptState | null = null;
  try {
    attempts = await sharedStateStore.get<AttemptState>(attemptKey(userId, policy));
  } catch (error) {
    logger.warn("二次验证尝试计数读取失败，按未锁定处理", {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  if (!attempts) {
    return { allowed: true, remainingAttempts: policy.limit };
  }

  if (attempts.lockedUntil && Date.now() < attempts.lockedUntil) {
    return { allowed: false, remainingAttempts: 0, lockedUntil: attempts.lockedUntil };
  }

  // 锁定已过期：清掉计数重新开始
  if (attempts.lockedUntil && Date.now() >= attempts.lockedUntil) {
    await clearVerificationAttempts(userId, policy);
    return { allowed: true, remainingAttempts: policy.limit };
  }

  const remainingAttempts = Math.max(0, policy.limit - attempts.count);
  return { allowed: remainingAttempts > 0, remainingAttempts };
}

/** 成功即清零；失败则累加，达到上限时写入锁定截止时间（多副本共享同一份锁定）。 */
export async function recordVerificationAttempt(
  userId: string,
  success: boolean,
  policy: VerificationAttemptPolicy = TWO_FACTOR_ATTEMPT_POLICY,
): Promise<void> {
  if (success) {
    await clearVerificationAttempts(userId, policy);
    return;
  }

  let attempts: AttemptState | null = null;
  try {
    attempts = await sharedStateStore.get<AttemptState>(attemptKey(userId, policy));
  } catch (error) {
    logger.warn("二次验证尝试计数读取失败", {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const next: AttemptState = {
    count: (attempts?.count ?? 0) + 1,
    lastAttempt: Date.now(),
  };

  if (next.count >= policy.limit) {
    next.lockedUntil = Date.now() + policy.lockoutMs;
    logger.warn("二次验证尝试次数超限，账户被锁定", {
      userId,
      lockoutMs: policy.lockoutMs,
      keyPrefix: policy.keyPrefix,
    });
  }

  try {
    // 读改写不是原子的：极端并发下可能少记一次。记录的是**失败**次数，少记只会更宽松；
    // 而每次失败都要先通过密码并拿到一次性凭证，入口本身还有限流——不为此引入更重的原子方案。
    await sharedStateStore.set(attemptKey(userId, policy), next, policy.lockoutMs);
  } catch (error) {
    logger.warn("二次验证尝试计数写入失败", {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function clearVerificationAttempts(
  userId: string,
  policy: VerificationAttemptPolicy = TWO_FACTOR_ATTEMPT_POLICY,
): Promise<void> {
  try {
    await sharedStateStore.delete(attemptKey(userId, policy));
  } catch (error) {
    logger.warn("二次验证尝试计数清理失败", {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
