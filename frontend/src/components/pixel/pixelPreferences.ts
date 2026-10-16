// Pixel 工作台的浏览器本地偏好。
//
// 只允许放「便利性状态」：
//  - 操作提示的确认日期（PIX-01 的「今天不再弹出」）；
// 绝不落任何卡密、账号、密码、辅助邮箱或 2FA 秘钥——那些只在内存里存在，
// 一旦写进 localStorage 就等于把凭据留在了磁盘上（PRD 6.1.3）。
const NOTICE_KEY = "synapse-pixel-notice-acknowledged-on";

function today(): string {
  // 用本地日期而不是 UTC：用户判断「今天」用的就是他本机日历。
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export function hasAcknowledgedPixelNoticeToday(): boolean {
  try {
    return window.localStorage.getItem(NOTICE_KEY) === today();
  } catch {
    return false;
  }
}

export function acknowledgePixelNoticeToday(): void {
  try {
    window.localStorage.setItem(NOTICE_KEY, today());
  } catch {
    // 存不了就每次都弹：宁可多提醒一次，也不要静默跳过提示。
  }
}

/** 生成一次提交的幂等键：同一次点击的重试复用同一个键，新的一次提交换新的键。 */
export function newPixelIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `px-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
