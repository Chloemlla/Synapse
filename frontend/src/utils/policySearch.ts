import type { PolicySection } from '../types/policy';

/**
 * 政策页站内搜索的纯函数实现。
 *
 * 条文有十几章、上百条，滚动查找成本很高（见 docs/audit-2026-09-30-policy-system.md P-13）。
 * 这里只做「与 UI 无关」的两件事：找出命中的章节/条目，以及把一段文本按命中切成可高亮的片段。
 * 逻辑独立成模块是为了能直接被 vitest 覆盖，而不是塞在 700 行的页面组件里。
 */

export const normalizePolicyQuery = (query: string): string => query.trim().toLowerCase();

const includesQuery = (text: string, normalizedQuery: string): boolean =>
  text.toLowerCase().includes(normalizedQuery);

export interface PolicySearchResult {
  /** 归一化后的查询串（空串表示未搜索） */
  query: string;
  /** 命中的条文条目总数（标题/摘要命中不计入，单独用 sectionIds 表示） */
  itemMatchCount: number;
  /** 有命中的章节 id，按条文顺序 */
  matchedSectionIds: string[];
  /** sectionId -> 命中的条目序号（0 起），按条文顺序 */
  matchedItemIndexes: Record<string, number[]>;
}

const EMPTY_RESULT: PolicySearchResult = {
  query: '',
  itemMatchCount: 0,
  matchedSectionIds: [],
  matchedItemIndexes: {},
};

/**
 * 在章节标题、摘要与条文条目里搜索。
 * 空查询返回空结果（调用方据此渲染全部章节，而不是「零命中」空态）。
 */
export function searchPolicySections(
  sections: readonly PolicySection[],
  rawQuery: string,
): PolicySearchResult {
  const query = normalizePolicyQuery(rawQuery);
  if (!query) return { ...EMPTY_RESULT };

  const matchedSectionIds: string[] = [];
  const matchedItemIndexes: Record<string, number[]> = {};
  let itemMatchCount = 0;

  for (const section of sections) {
    const sectionHit =
      includesQuery(section.title, query) || includesQuery(section.summary, query);

    const indexes: number[] = [];
    section.items.forEach((item, index) => {
      if (includesQuery(item, query)) indexes.push(index);
    });

    if (sectionHit || indexes.length > 0) {
      matchedSectionIds.push(section.id);
      matchedItemIndexes[section.id] = indexes;
      itemMatchCount += indexes.length;
    }
  }

  return { query, itemMatchCount, matchedSectionIds, matchedItemIndexes };
}

export interface HighlightSegment {
  text: string;
  hit: boolean;
}

/**
 * 把文本按查询串切成「命中 / 未命中」片段（大小写不敏感）。
 * 查询为空或没有命中时返回单个未命中片段，调用方无需分支。
 */
export function splitHighlight(text: string, rawQuery: string): HighlightSegment[] {
  const query = normalizePolicyQuery(rawQuery);
  if (!query || !text) return [{ text, hit: false }];

  const haystack = text.toLowerCase();
  const segments: HighlightSegment[] = [];
  let cursor = 0;

  for (;;) {
    const found = haystack.indexOf(query, cursor);
    if (found < 0) break;
    if (found > cursor) segments.push({ text: text.slice(cursor, found), hit: false });
    segments.push({ text: text.slice(found, found + query.length), hit: true });
    cursor = found + query.length;
  }

  if (cursor === 0) return [{ text, hit: false }];
  if (cursor < text.length) segments.push({ text: text.slice(cursor), hit: false });
  return segments;
}
