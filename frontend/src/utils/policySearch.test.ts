import { describe, expect, it } from 'vitest';
import { normalizePolicyQuery, searchPolicySections, splitHighlight } from './policySearch';
import type { PolicySection } from '../types/policy';

const sections: PolicySection[] = [
  {
    id: 'overview',
    title: '协议范围与生效',
    summary: '本页同时构成服务条款与隐私政策',
    icon: 'info',
    items: ['本协议自 2026-09-29 起生效', '你需要年满 13 周岁'],
  },
  {
    id: 'retention',
    title: '数据保存期限与删除',
    summary: '不同数据有不同的保存期限',
    icon: 'retention',
    items: ['审计日志：默认保留 90 天', '政策同意记录：默认有效期 30 天'],
  },
];

describe('normalizePolicyQuery', () => {
  it('trims and lowercases so searches ignore case and surrounding spaces', () => {
    expect(normalizePolicyQuery('  Cookie  ')).toBe('cookie');
    expect(normalizePolicyQuery('')).toBe('');
  });
});

describe('searchPolicySections', () => {
  it('returns an empty result for a blank query (页面据此渲染全部章节)', () => {
    const result = searchPolicySections(sections, '   ');
    expect(result.query).toBe('');
    expect(result.matchedSectionIds).toEqual([]);
    expect(result.itemMatchCount).toBe(0);
  });

  it('matches items and records their indexes per section', () => {
    const result = searchPolicySections(sections, '默认');
    expect(result.matchedSectionIds).toEqual(['retention']);
    expect(result.matchedItemIndexes.retention).toEqual([1]);
    expect(result.itemMatchCount).toBe(1);
  });

  it('matches titles and summaries even without item hits', () => {
    const result = searchPolicySections(sections, '服务条款');
    expect(result.matchedSectionIds).toEqual(['overview']);
    expect(result.matchedItemIndexes.overview).toEqual([]);
    expect(result.itemMatchCount).toBe(0);
  });

  it('is case-insensitive and can hit several sections at once', () => {
    const result = searchPolicySections(sections, '13');
    expect(result.matchedSectionIds).toEqual(['overview']);
    expect(result.itemMatchCount).toBe(1);
  });

  it('keeps section order from the document', () => {
    const result = searchPolicySections(sections, '政策');
    expect(result.matchedSectionIds).toEqual(['overview', 'retention']);
  });

  it('reports zero matches instead of throwing', () => {
    const result = searchPolicySections(sections, '不存在的关键词');
    expect(result.matchedSectionIds).toEqual([]);
    expect(result.itemMatchCount).toBe(0);
  });
});

describe('splitHighlight', () => {
  it('returns a single plain segment for an empty query', () => {
    expect(splitHighlight('审计日志', '')).toEqual([{ text: '审计日志', hit: false }]);
  });

  it('splits around every occurrence, case-insensitively', () => {
    expect(splitHighlight('Cookie 与本地存储，cookie 不追踪', 'cookie')).toEqual([
      { text: 'Cookie', hit: true },
      { text: ' 与本地存储，', hit: false },
      { text: 'cookie', hit: true },
      { text: ' 不追踪', hit: false },
    ]);
  });

  it('returns a plain segment when nothing matches', () => {
    expect(splitHighlight('审计日志', 'xyz')).toEqual([{ text: '审计日志', hit: false }]);
  });

  it('handles a match at the very end without dropping the tail', () => {
    expect(splitHighlight('保留 90 天', '天')).toEqual([
      { text: '保留 90 ', hit: false },
      { text: '天', hit: true },
    ]);
  });
});
