export function firstString(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    const first = value[0];
    return typeof first === "string" ? first : undefined;
  }

  return undefined;
}

export function firstStringOr(value: unknown, fallback = ""): string {
  return firstString(value) ?? fallback;
}

/**
 * 查询串里的整数参数统一入口。
 *
 * 为什么需要它：这类参数在本仓有两种写法——逐处 `Math.min(Math.max(...))`（多数服务层）
 * 与裸 `parseInt(...) || N`（少数路由）。后者不是「宽松」而是「未定义」：`-1` 会原样落到
 * Mongo 的 `.limit()`（负值抛错 → 500），`1e9` 会变成一次大查询。收敛到一个函数可以让
 * 「同一个参数在 A 处有界、B 处无界」这种不一致不再复现。
 *
 * 语义：非数字/缺失 → `fallback`；数字越界 → 夹到 `min`/`max`（而不是回退到 fallback，
 * 这样 `limit=-5` 得到 `min` 而不是「假装客户端没传」）。
 */
export interface BoundedIntOptions {
  min?: number;
  max?: number;
  fallback?: number;
}

export function boundedInt(value: unknown, options: BoundedIntOptions = {}): number {
  const min = options.min ?? 0;
  const max = options.max ?? Number.MAX_SAFE_INTEGER;
  const fallback = options.fallback ?? min;

  // query 参数可能是数组（`?limit=1&limit=2`）或对象（`?limit[gte]=1`）；
  // 前者取第一个字符串，后者一律视为非法。
  const raw = firstString(value);
  const text = raw !== undefined ? raw.trim() : typeof value === "number" ? String(value) : "";
  if (!text) return fallback;

  const parsed = Number(text);
  if (!Number.isFinite(parsed)) return fallback;

  const truncated = Math.trunc(parsed);
  if (truncated < min) return min;
  if (truncated > max) return max;
  return truncated;
}
