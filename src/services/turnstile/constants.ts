export const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
export const HCAPTCHA_VERIFY_URL = "https://api.hcaptcha.com/siteverify";
// Cap Standalone：仅作未配置时的兜底默认值，实际以 Mongo 里的 CAP_API_ENDPOINT 为准。
export const CAP_DEFAULT_API_ENDPOINT = "https://cap.chloemlla.com";
export const CAP_VERIFY_TIMEOUT_MS = 10_000;
export const MAX_VIOLATIONS = 3;
export const BAN_DURATION = 60 * 60 * 1000;

/**
 * 封禁时长硬顶：30 天（原为 24 小时）。
 *
 * 蜜罐自动封禁需要 30 天量级的处置力（见 honeypotBan.ts），而手工封禁与自动封禁共用
 * `manualBanIp` 的夹紧逻辑；两处各自硬编码上限会让「自动能封 30 天、手工只能 24 小时」
 * 变成说不清的不对称，因此上限只在这里定义一次，服务层与控制器校验都读它。
 */
export const MAX_BAN_DURATION_MINUTES = 30 * 24 * 60;

/**
 * 蜜罐连续命中判据（owner 2026-11-26 裁决，推翻 RC-42 的「只留痕不封禁」）。
 *
 * 语义：同一 IP 在 `HONEYPOT_REPEAT_WINDOW_MS` 内命中 `HONEYPOT_REPEAT_THRESHOLD` 次
 * ⇒ 自动封禁 `HONEYPOT_BAN_DURATION_MINUTES`，来源记 `auto`，原因以
 * `HONEYPOT_BAN_REASON_PREFIX` 开头（后台据此在名单里区分「蜜罐判的」与「管理员封的」）。
 * 判据与证据同源：命中事件写在 `SecurityEvent`（`eventType: HONEYPOT_HIT`），
 * 统计、封禁、`/api/turnstile/ip-ban-trace` 溯源读的都是这一份。
 */
export const HONEYPOT_REPEAT_WINDOW_MS = 2 * 60 * 60 * 1000;
export const HONEYPOT_REPEAT_THRESHOLD = 2;
export const HONEYPOT_BAN_DURATION_MINUTES = MAX_BAN_DURATION_MINUTES;
export const HONEYPOT_BAN_REASON_PREFIX = "蜜罐连续命中";
// 未达到封禁阈值前的违规记录冷却时间：保留计数但不会被 isIpBanned 命中
export const VIOLATION_COOLDOWN = 5 * 60 * 1000;
