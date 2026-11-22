import { describe, expect, it } from 'vitest';
import type { AuditLogMeta } from '@/api/auditLog';
import {
  buildModuleOptionGroups,
  localDateStamp,
  matchesQuickTimeRange,
  moduleLabel,
  quickTimeRangeBounds,
  resultLabel,
  resultTone,
  roleLabel,
  roleTone,
  statusTone,
} from '@/components/admin/audit-log/labels';

/**
 * 审计面板展示层字典的用例。
 *
 * 这里只钉两件事：①后端目录到达后以它为准（中文名跟着后端走，不在前端再抄一份）；
 * ②目录缺失/有未登记模块时，筛选器不能把模块「弄丢」——那会让管理端筛不到刚写出来的记录。
 */

const buildMeta = (): AuditLogMeta => ({
  success: true,
  modules: ['modlist', 'lumen-config', 'tts', 'brand-new'],
  moduleCatalog: [
    { value: 'modlist', label: '模组列表', group: 'service', groupLabel: '业务服务', hint: '模组条目的增删改' },
    { value: 'lumen-config', label: 'Lumen 客户端配置', group: 'service', groupLabel: '业务服务' },
    { value: 'tts', label: '语音合成', group: 'service', groupLabel: '业务服务' },
    // 目录里没有 group 的项要落到「其他模块」，而不是从下拉框消失。
    { value: 'brand-new', label: '新模块', group: '', groupLabel: '' },
  ],
  moduleGroups: [
    { value: 'service', label: '业务服务' },
    { value: 'security', label: '安全与风控' },
  ],
  roles: [
    { value: 'superadmin', label: '超级管理员' },
    { value: 'admin', label: '管理员' },
  ],
  results: ['success', 'failure'],
  resultLabels: { success: '成功', failure: '失败' },
  methods: ['GET', 'POST'],
  sortOptions: [
    { value: 'desc', label: '最新在前' },
    { value: 'asc', label: '最早在前' },
  ],
  maxPageSize: 100,
  maxExportRows: 5000,
  retentionDays: 60,
  payloadCaptureEnabled: false,
  successPayloadCaptureEnabled: false,
});

describe('audit-log labels', () => {
  it('prefers the server catalog and falls back to the built-in table', () => {
    const meta = buildMeta();
    expect(moduleLabel('lumen-config', meta)).toBe('Lumen 客户端配置');
    // 目录里没有的模块：用兜底表（不是把代号直接铺出去）。
    expect(moduleLabel('security', meta)).toBe('安全风控');
    // 两边都没有的未知值：保留原值，避免管理端看到一片空白。
    expect(moduleLabel('totally-unknown', meta)).toBe('totally-unknown');
    expect(moduleLabel('tts', null)).toBe('语音合成');
    expect(roleLabel('superadmin', meta)).toBe('超级管理员');
    expect(roleLabel('user', null)).toBe('普通用户');
    expect(resultLabel('failure', null)).toBe('失败');
  });

  it('groups modules by the server order and keeps ungrouped ones visible', () => {
    const groups = buildModuleOptionGroups(buildMeta());
    expect(groups.map((group) => group.value)).toEqual(['service', 'ungrouped']);

    const service = groups[0];
    expect(service.label).toBe('业务服务');
    expect(service.options.map((option) => option.value)).toEqual(['modlist', 'lumen-config', 'tts']);
    expect(service.options[0].hint).toBe('模组条目的增删改');

    expect(groups[1].options.map((option) => option.value)).toEqual(['brand-new']);
  });

  it('exposes a usable dropdown before the catalog request resolves', () => {
    const groups = buildModuleOptionGroups(null);
    expect(groups).toHaveLength(1);
    const values = groups[0].options.map((option) => option.value);
    // 回归点：这两个模块曾因漏登记而筛不到。
    expect(values).toContain('modlist');
    expect(values).toContain('lumen-config');
    expect(values).toContain('geogebra');
  });

  it('turns quick time ranges into local-day or absolute bounds', () => {
    const now = new Date('2026-11-22T10:30:00+08:00');
    const today = quickTimeRangeBounds('today', now);
    expect(today.startDate).toBe(localDateStamp(now));
    expect(today.endDate).toBe(localDateStamp(now));

    const lastHour = quickTimeRangeBounds('1h', now);
    // 相对窗口用绝对时间戳：后端把日期串按 UTC 日界解析，会与本地面板差 8 小时。
    expect(lastHour.startDate).toBe('2026-11-22T01:30:00.000Z');
    expect(lastHour.endDate).toBe('2026-11-22T02:30:00.000Z');
  });

  it('matches an applied filter against a quick range', () => {
    const now = new Date('2026-11-22T10:30:00+08:00');
    expect(matchesQuickTimeRange(quickTimeRangeBounds('7d', now), '7d', now)).toBe(true);
    expect(matchesQuickTimeRange({ startDate: '2026-01-01', endDate: '' }, 'today', now)).toBe(false);
  });

  it('uses the shared semantic palette instead of red/green', () => {
    expect(resultTone('success')).toContain('emerald');
    expect(resultTone('failure')).toContain('rose');
    expect(statusTone(500)).toContain('rose');
    expect(statusTone(404)).toContain('amber');
    expect(statusTone(200)).toContain('emerald');
    expect(roleTone('superadmin')).toContain('slate-900');
    for (const className of [resultTone('failure'), statusTone(500), roleTone('admin')]) {
      expect(className).not.toMatch(/\b(red|green|indigo|purple|gray|zinc)-/);
    }
  });
});
