import { describe, expect, it } from 'vitest';
import { fuzzyIncludes, fuzzyMatch } from './fuzzyMatch';

describe('fuzzyMatch', () => {
  it('按顺序子序列命中，并给出高亮下标', () => {
    const result = fuzzyMatch('用户管理', '用户管');
    expect(result).not.toBeNull();
    expect(result!.indexes).toEqual([0, 1, 2]);
  });

  it('支持跳字命中（输入缩写）', () => {
    const result = fuzzyMatch('审计日志', '审志');
    expect(result).not.toBeNull();
    expect(result!.indexes).toEqual([0, 3]);
  });

  it('顺序不对、或字符不存在时不命中', () => {
    expect(fuzzyMatch('用户管理', '理管')).toBeNull();
    expect(fuzzyMatch('用户管理', 'zzz')).toBeNull();
  });

  it('空查询命中一切且不产生高亮', () => {
    expect(fuzzyMatch('任意文字', '   ')).toEqual({ score: 0, indexes: [] });
  });

  it('完全相等 > 前缀 > 普通子序列', () => {
    const exact = fuzzyMatch('系统配置', '系统配置')!.score;
    const prefix = fuzzyMatch('系统配置', '系统')!.score;
    const scattered = fuzzyMatch('系统配置', '系配')!.score;
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(scattered);
  });

  it('短候选在同等命中下排前（避免长标题吃分）', () => {
    const short = fuzzyMatch('日志', '日')!.score;
    const long = fuzzyMatch('日志分享与运维审计记录', '日')!.score;
    expect(short).toBeGreaterThan(long);
  });

  it('大小写不敏感，且忽略查询里的空格', () => {
    expect(fuzzyIncludes('Audit Log', 'auditlog')).toBe(true);
    expect(fuzzyIncludes('Audit Log', 'AUDIT')).toBe(true);
  });
});
