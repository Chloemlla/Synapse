import { describe, expect, it } from 'vitest';
import type { NavGroup } from '@/layout/types';
import {
  buildAdminPrefGroups,
  findAdminModuleNeighbors,
  flattenAdminNavItems,
  indexAdminNavByUrl,
  resolveActiveAdminItem,
} from './adminNavIndex';

const groups: NavGroup[] = [
  {
    id: 'admin-hub',
    title: '总览',
    items: [{ title: '管理总览', url: '/admin' }],
  },
  {
    id: 'content',
    title: '内容',
    items: [
      { title: '用户管理', url: '/admin/users' },
      { title: '资源管理', url: '/admin/store/resources' },
      { title: '商店总览', url: '/admin/store' },
    ],
  },
  {
    id: 'ops',
    title: '运维',
    items: [
      { title: '审计日志', url: '/admin/audit-log' },
      {
        title: '嵌套分组',
        items: [{ title: '嵌套子项', url: '/admin/nested-child' }],
      } as unknown as NavGroup['items'][number],
    ],
  },
];

describe('flattenAdminNavItems', () => {
  it('摊平分组并保留展示顺序', () => {
    expect(flattenAdminNavItems(groups).map((item) => item.url)).toEqual([
      '/admin',
      '/admin/users',
      '/admin/store/resources',
      '/admin/store',
      '/admin/audit-log',
      '/admin/nested-child',
    ]);
  });

  it('indexAdminNavByUrl 能按 url 回查标题', () => {
    expect(indexAdminNavByUrl(groups).get('/admin/users')?.title).toBe('用户管理');
  });
});

describe('resolveActiveAdminItem', () => {
  it('取最长匹配，子路径不会退化成父路径', () => {
    expect(resolveActiveAdminItem('/admin/store/resources', groups)?.title).toBe('资源管理');
    expect(resolveActiveAdminItem('/admin/store', groups)?.title).toBe('商店总览');
  });

  it('未命中时返回 null', () => {
    expect(resolveActiveAdminItem('/tts', groups)).toBeNull();
  });
});

describe('findAdminModuleNeighbors', () => {
  it('给出前后模块并在首尾之间循环', () => {
    const first = findAdminModuleNeighbors('/admin', groups);
    expect(first.index).toBe(0);
    expect(first.total).toBe(6);
    expect(first.prev?.url).toBe('/admin/nested-child');
    expect(first.next?.url).toBe('/admin/users');

    const last = findAdminModuleNeighbors('/admin/nested-child', groups);
    expect(last.next?.url).toBe('/admin');
    expect(last.prev?.url).toBe('/admin/audit-log');
  });

  it('未命中或只有一个模块时不给前后项', () => {
    expect(findAdminModuleNeighbors('/tts', groups).next).toBeNull();
    expect(
      findAdminModuleNeighbors('/admin/users', [
        { id: 'only', title: '只有一个', items: [{ title: '用户管理', url: '/admin/users' }] },
      ]).next,
    ).toBeNull();
  });
});

describe('buildAdminPrefGroups', () => {
  it('置顶优先，且从最近访问里去掉已置顶项', () => {
    const result = buildAdminPrefGroups(groups, {
      pinned: [{ url: '/admin/users', title: '用户管理' }],
      recent: [
        { url: '/admin/users', title: '用户管理' },
        { url: '/admin/audit-log', title: '审计日志' },
      ],
    });

    expect(result.map((group) => group.id)).toEqual(['admin-pinned', 'admin-recent']);
    expect(result[0].items.map((item) => item.url)).toEqual(['/admin/users']);
    expect(result[1].items.map((item) => item.url)).toEqual(['/admin/audit-log']);
  });

  it('丢弃当前角色看不到或不存在的模块（避免死链）', () => {
    const result = buildAdminPrefGroups(groups, {
      pinned: [{ url: '/admin/super-secret', title: '超管专属' }],
      recent: [{ url: '/admin/users', title: '用户管理' }],
    });

    expect(result.map((group) => group.id)).toEqual(['admin-recent']);
    expect(result[0].items.map((item) => item.url)).toEqual(['/admin/users']);
  });

  it('空偏好时不出空分组', () => {
    expect(buildAdminPrefGroups(groups, { pinned: [], recent: [] })).toEqual([]);
  });
});
