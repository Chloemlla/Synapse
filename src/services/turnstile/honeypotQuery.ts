import { HONEYPOT_REPEAT_WINDOW_MS } from "./constants";

/**
 * 蜜罐连续命中的**判据查询条件**（唯一实现源）。
 *
 * 单独一个文件而不是放在 `honeypotBan.ts` 里：处分（`honeypotBan`）与溯源复核
 * （`ipBan.getIpBanTrace`）都要用它，而 `honeypotBan` 反过来要用 `ipBan.manualBanIp` ——
 * 放在 `honeypotBan` 里会形成 `ipBan ⇄ honeypotBan` 循环依赖。
 *
 * 关键语义：`userId: null` 在 MongoDB 里同时匹配「字段缺失」与「值为 null」，因此只统计
 * **匿名命中**。带令牌访问 `/api/debug/*` 的管理员工具/旧客户端属于已登录的已知主体
 * （见 `docs/audit/10-10.md` RC-42 的误伤顾虑），归账户风险处置，不靠 IP 封禁。
 */
export function buildHoneypotRepeatQuery(ip: string, windowStart: Date): Record<string, unknown> {
  return {
    eventType: "HONEYPOT_HIT",
    ipAddress: ip,
    createdAt: { $gte: windowStart },
    userId: null,
  };
}

/** 统计窗口起点（`now - 2h`）。抽出来是为了让调用方与判据用同一个窗口定义。 */
export function honeypotRepeatWindowStart(now: Date): Date {
  return new Date(now.getTime() - HONEYPOT_REPEAT_WINDOW_MS);
}
