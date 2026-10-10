import { SecurityEvent } from "../models/securityEventModel";
import logger from "../utils/logger";

/**
 * 超级管理员风控豁免（RC-44 / §3.2）。**跨批次不变量**：所有「自动强制」类风控
 * （账户升档、step-up、PoW 加压、交叉株连、配额阶梯、登录退避、蜜罐、Tarpit、全站踢出）
 * 都必须调用这里的同一个判据，否则一套自动风控可以把运维者自己踢出平台 ——
 * 而那时平台里已经没有任何人能把它改回来。
 *
 * ⚠ 三条刻意不提供的“便利”：
 * 1. **只认 `role === "superadmin"`**。不接受 `trusted`、邮箱后缀、用户 ID 白名单：
 *    那些会把豁免变成可配置的“免死金牌”，是提权面。
 * 2. **不豁免交互式二次认证**（安全会话 Passkey/TOTP/密码，RC-32/RC-40）：
 *    它不依赖风险判定，而是“本人确认”的取证链，豁免它等于把零信任挖空。
 * 3. **不豁免审计与告警**：每次豁免拦截都要留痕（`SUPERADMIN_RISK_EXEMPT`），
 *    否则出事时无法回答“那十分钟管理员绕过了什么”。
 */

/** 被豁免的判据名。加新闸门时在这里加一条，保证“豁免点可枚举、可审计”。 */
export type RiskExemptionScope =
  | "accountRisk"
  | "stepUp"
  | "pow"
  | "crossModule"
  | "quotaLadder"
  | "loginBackoff"
  | "honeypot"
  | "tarpit"
  | "sessionKick"
  | "regionGuard"
  | "apiKeyPenalty";

const EXEMPT_ROLE = "superadmin";

let disabledWarningLogged = false;

/**
 * 豁免的降级开关（用于故障注入：验证风控本身是否按预期工作）。
 * 默认开启；`RISK_EXEMPTION_DISABLED=true` 时关闭，此时超级管理员与普通用户同待遇
 * —— 这正是「当前风控可能锁死你自己」的状态，因此必须显式告警而不是静默生效。
 */
export function isRiskExemptionEnabled(): boolean {
  const disabled = (process.env.RISK_EXEMPTION_DISABLED || "").trim().toLowerCase() === "true";
  if (disabled && !disabledWarningLogged) {
    disabledWarningLogged = true;
    logger.error(
      "[RiskExemption] 超管风控豁免已被 RISK_EXEMPTION_DISABLED 关闭：当前风控可能锁死超级管理员自身，请确认这是有意的故障注入",
    );
  }
  return !disabled;
}

/**
 * 唯一判据源：是否为「风控豁免」账户。
 *
 * 只读 `role`，因此调用方无法用邮箱/ID/`trusted` 伪造豁免；传 null/undefined 一律 false
 * （匿名请求不该走豁免分支）。
 */
export function isRiskExempt(user: { role?: string | null } | null | undefined): boolean {
  if (!isRiskExemptionEnabled()) return false;
  return user?.role === EXEMPT_ROLE;
}

/** 测试用：重置一次性告警标记（用例里切换环境变量时避免互相影响）。 */
export function resetRiskExemptionWarningForTests(): void {
  disabledWarningLogged = false;
}

/**
 * 记一次豁免留痕。**失败不影响业务**：留痕是“事后解释”用的，不能因为审计写不进去
 * 就拒绝管理员的合法操作（那会制造一个新的锁死路径）。
 */
export function noteRiskExemption(params: {
  userId?: string;
  scope: RiskExemptionScope;
  detail?: Record<string, unknown>;
}): void {
  const { userId, scope, detail } = params;
  void SecurityEvent.create({
    // SecurityEvent.deviceFingerprint 必填，但豁免事件与设备无关；用固定标识而不是空串，
    // 便于管理端一眼筛出这一类记录。
    deviceFingerprint: "risk-exemption",
    userId,
    eventType: "SUPERADMIN_RISK_EXEMPT",
    eventData: { scope, ...(detail || {}) },
    riskScore: 0,
    ipAddress: "",
    userAgent: "",
    createdAt: new Date(),
  }).catch((error) => {
    logger.warn("[RiskExemption] 豁免留痕写入失败", {
      scope,
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

/**
 * 组合判据：命中豁免时顺带留痕。闸门里只调这一个，避免「判了但忘了记」。
 */
export function shouldExemptFromRiskControl(
  user: { id?: string; role?: string | null } | null | undefined,
  scope: RiskExemptionScope,
  detail?: Record<string, unknown>,
): boolean {
  if (!isRiskExempt(user)) return false;
  noteRiskExemption({ userId: user?.id, scope, detail });
  return true;
}
