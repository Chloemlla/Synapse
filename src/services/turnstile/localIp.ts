import { isIP } from "node:net";

/** Only RFC1918 IPv4 ranges and loopback qualify for development relaxation. */
export function isLocalCaptchaIp(ip: string): boolean {
  if (ip === "::1") return true;
  const normalized = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  if (isIP(normalized) !== 4) return false;
  const [first, second] = normalized.split(".").map(Number);
  return first === 127 || first === 10 || (first === 192 && second === 168) ||
    (first === 172 && second >= 16 && second <= 31);
}
