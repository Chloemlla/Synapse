/**
 * 设备指纹**分量摘要**的纯函数层（RC-16）。
 *
 * 为什么单独一层：前端 `frontend/src/utils/fingerprint.ts` 此前把 Canvas / WebGL / 时区 / 屏幕
 * 五路信号一起哈希成一个复合 id，服务端只拿到最终 id —— 能回答「是不是同一台」，回答不了
 * 「换浏览器沙箱 / 伪装 canvas 后 id 变了，但对方是同一硬件」。分量摘要（各路各自的 hash，
 * 不含原始图像）让服务端可以比对分量。
 *
 * 本文件不碰 Mongo、不读配置，只做「规范化 + 是否漂移」的算术，便于表驱动单测
 *（与 `accountRiskScoring` 同范式：I/O 留在 service，判定留在纯函数）。
 */

export interface FingerprintComponentHashes {
  /** Canvas 渲染结果的摘要（前端已哈希，服务端不回读原图）。 */
  can: string;
  /** WebGL vendor/renderer/参数集合的摘要。 */
  wgl: string;
  /** `Intl` 时区 + UTC 偏移的摘要。 */
  tz: string;
  /** 屏幕尺寸 / 色彩深度 / 像素比的摘要。 */
  scr: string;
}

export const FINGERPRINT_COMPONENT_KEYS = ["can", "wgl", "tz", "scr"] as const;

/**
 * 单个分量摘要的长度上限。
 * 前端的 `safeHash` 正常产出 64 位 hex；兜底 base64 更短，200 是防御性上界。
 */
export const MAX_FINGERPRINT_COMPONENT_LENGTH = 200;

const COMPONENT_HASH_PATTERN = /^[A-Za-z0-9_+/=-]+$/;

/**
 * 规范化单路分量：只接受可见字符子集（hex / base64 / urlsafe），并截断。
 * 不合法或空值一律归零成空串 —— 「取不到」与「取到了但值不同」必须区分，
 * 否则一个伪造的空值就能把漂移判定搅乱。
 */
export function normalizeFingerprintComponentHash(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_FINGERPRINT_COMPONENT_LENGTH) return "";
  if (!COMPONENT_HASH_PATTERN.test(trimmed)) return "";
  return trimmed;
}

/** 规范化整组分量；四路全空时返回 null（调用方据此不写记录）。 */
export function normalizeFingerprintComponents(input: unknown): FingerprintComponentHashes | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const source = input as Record<string, unknown>;
  const components: FingerprintComponentHashes = {
    can: normalizeFingerprintComponentHash(source.can),
    wgl: normalizeFingerprintComponentHash(source.wgl),
    tz: normalizeFingerprintComponentHash(source.tz),
    scr: normalizeFingerprintComponentHash(source.scr),
  };
  return Object.values(components).some(Boolean) ? components : null;
}

/**
 * 同一个 `fingerprintId` 的分量是否发生漂移。
 *
 * 判定口径是**逐路比**，且只在「前后都有值且不同」时才算漂移：
 * - 任一侧为空不判（分量采集失败、旧记录没有分量，都不该被当成换机器）；
 * - `tz` / `scr` 会随浏览器更新正常变化，因此漂移只是**加权信号**，不是封禁判据。
 */
export function hasFingerprintComponentDrift(
  previous: FingerprintComponentHashes | null | undefined,
  next: FingerprintComponentHashes,
): boolean {
  if (!previous) return false;
  return FINGERPRINT_COMPONENT_KEYS.some((key) => {
    const before = normalizeFingerprintComponentHash(previous[key]);
    const after = normalizeFingerprintComponentHash(next[key]);
    return Boolean(before && after && before !== after);
  });
}
