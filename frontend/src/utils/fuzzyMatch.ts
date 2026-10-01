/**
 * 轻量模糊匹配（顺序子序列 + 连续/词首加成）。
 *
 * 用途：管理员命令面板（⌘K）里筛模块名 / 快速动作标题。没有引入第三方
 * 依赖：需求只是「输几个字母能命中」，而不是完整 fzf 语义；这样也能被单测钉住。
 *
 * 约定：
 * - 空查询命中一切（`indexes` 为空，调用方可据此跳过高亮）；
 * - 不匹配返回 `null`；
 * - `score` 越大约可能是意图目标，排序用，不保证跨版本稳定。
 */

export type FuzzyMatchResult = {
  score: number;
  /** 命中的字符下标（升序），用于高亮渲染 */
  indexes: number[];
};

/** 词首/词边界加成：命中这些位置说明输入的是词首字母 */
const BOUNDARY_CHARS = /[\s/_\-.[\]()（）·:：]/;

export function fuzzyMatch(text: string, query: string): FuzzyMatchResult | null {
  const target = text.toLowerCase();
  const needle = query.trim().toLowerCase().replace(/\s+/g, "");
  if (!needle) return { score: 0, indexes: [] };
  if (needle.length > target.length) return null;

  const indexes: number[] = [];
  let score = 0;
  let cursor = 0;
  let lastHit = -2;

  for (const ch of needle) {
    const hit = target.indexOf(ch, cursor);
    if (hit === -1) return null;
    // 连续命中比跳着命中更符合直觉
    score += hit === lastHit + 1 ? 6 : 1;
    const previous = hit > 0 ? target[hit - 1] : "";
    if (hit === 0 || (previous && BOUNDARY_CHARS.test(previous))) score += 4;
    indexes.push(hit);
    lastHit = hit;
    cursor = hit + 1;
  }

  // 短候选更可能是目标；完全相等/前缀命中再额外加权。
  score += Math.max(0, 24 - target.length);
  if (target === needle) score += 40;
  else if (target.startsWith(needle)) score += 16;

  return { score, indexes };
}

/**
 * 便捷封装：只要判定是否命中、不需要高亮时用它。
 */
export function fuzzyIncludes(text: string, query: string): boolean {
  return fuzzyMatch(text, query) !== null;
}
