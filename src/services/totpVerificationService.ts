import { SecurityEvent } from "../models/securityEventModel";
import logger from "../utils/logger";
import { UserStorage } from "../utils/userStorage";
import { mongoose } from "./mongoService";
import { TOTPService } from "./totpService";

/**
 * TOTP **单次使用**的统一入口（G2-13 加固 / 用户回报「同一时期的验证码可以重复使用」）。
 *
 * 为什么必须收成一个函数：重放防护原先散在三个控制器里，写法都是
 *
 *     let isValid = check.valid;
 *     if (isValid && Number.isFinite(check.counter)) isValid = await consume(counter);
 *
 * 这个 `if` 是**静默放行**的形状 —— 一旦 counter 缺失（上游实现变化、`verifyDelta` 改形状、
 * 或某个新路径忘了传），条件不成立就跳过消费，`isValid` 保持 true，于是同一枚验证码
 * 可以无限次通过。安全闸门不允许出现「判据缺失 ⇒ 放行」的分支。
 *
 * 本模块的三条硬规则：
 * 1. `valid === true` 而 counter 不可用时 → **拒绝**（fail-closed，记为 `unavailable`）；
 * 2. 消费失败 → `reused`（同一 counter 已用过），与「验证码本身就是错的」区分开，
 *    API 层据此回稳定 `code`，前端提示「请等待新的验证码」而不是「验证码错误」；
 * 3. 每次重放都写 `security_events`（`TOTP_CODE_REPLAY`）并 warn 级日志 ——
 *    同一枚码被提交两次，要么是客户端重复提交，要么是有人在重放，两种都值得留痕。
 */

export type TotpVerificationOutcome =
  /** 验证通过且 counter 已被原子消费；同一枚码第二次提交必为 `reused`。 */
  | { ok: true; counter: number }
  /** 验证码本身不匹配（或格式/密钥问题）。 */
  | { ok: false; reason: "invalid" }
  /** 验证通过但该 counter 已被使用（重放）。 */
  | { ok: false; reason: "reused"; counter: number }
  /** 重放防护不可用（counter 非法 / 存储层未实现消费）—— 拒绝，绝不放行。 */
  | { ok: false; reason: "unavailable" };

function mongoReady(): boolean {
  return mongoose.connection.readyState === 1;
}

export async function verifyAndConsumeTotpCode(params: {
  userId: string;
  token: string;
  secret: string | null | undefined;
  /** 留痕上下文（谁在哪里提交的），可选。 */
  ipAddress?: string;
  userAgent?: string;
  fingerprint?: string;
}): Promise<TotpVerificationOutcome> {
  const { userId, token, secret } = params;
  const check = TOTPService.verifyTokenWithCounter(token, secret || "");

  if (!check.valid) return { ok: false, reason: "invalid" };

  // 规则 1：验证通过但没有可消费的 counter ⇒ 拒绝（不可静默跳过重放防护）。
  if (typeof check.counter !== "number" || !Number.isFinite(check.counter)) {
    logger.error("[TOTP] 验证通过但 counter 不可用，拒绝该次验证（fail-closed）", {
      userId,
      counter: check.counter,
    });
    return { ok: false, reason: "unavailable" };
  }

  let consumed: boolean;
  try {
    consumed = await UserStorage.consumeTotpCounter(userId, check.counter);
  } catch (error) {
    // 规则 3 的兄弟：存储层没有实现消费能力时，userRepository 会抛错（fail-closed）。
    logger.error("[TOTP] 重放防护不可用（存储层拒绝消费），拒绝该次验证", {
      userId,
      counter: check.counter,
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, reason: "unavailable" };
  }

  if (!consumed) {
    logger.warn("[TOTP] 检测到验证码重放：该 counter 已被使用", { userId, counter: check.counter });
    recordTotpReplay({
      userId,
      counter: check.counter,
      ipAddress: params.ipAddress,
      userAgent: params.userAgent,
      fingerprint: params.fingerprint,
    });
    return { ok: false, reason: "reused", counter: check.counter };
  }

  return { ok: true, counter: check.counter };
}

/** 重放留痕（fire-and-forget）：这是高置信度的「客户端重复提交 / 有人在重放」信号。 */
function recordTotpReplay(params: {
  userId: string;
  counter: number;
  ipAddress?: string;
  userAgent?: string;
  fingerprint?: string;
}): void {
  if (!mongoReady()) return;
  void SecurityEvent.create({
    deviceFingerprint: params.fingerprint || "totp",
    userId: params.userId,
    eventType: "TOTP_CODE_REPLAY",
    eventData: { counter: params.counter },
    riskScore: 40,
    ipAddress: params.ipAddress || "",
    userAgent: params.userAgent || "",
    createdAt: new Date(),
  }).catch((error) => {
    logger.warn("[TOTP] 重放事件写入失败", {
      userId: params.userId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}
