import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import { fetchLibreChatQuota, parseLibreChatQuota } from './librechatQuota';

vi.mock('./api', () => ({ api: { get: vi.fn() } }));

const validQuota = {
  dailyLimit: 5,
  used: 2,
  remaining: 3,
  banned: false,
  bannedUntil: null,
  warnings: 1,
  maxWarnings: 3,
};

describe('parseLibreChatQuota', () => {
  it('解析完整视图，缺警告次数时按 0 处理', () => {
    const { warnings: _warnings, ...withoutWarnings } = validQuota;
    expect(parseLibreChatQuota(withoutWarnings)).toMatchObject({ remaining: 3, warnings: 0, banned: false });
  });

  it('缺必需数字字段时返回 null，而不是把「未知」当成剩余 0 次', () => {
    expect(parseLibreChatQuota({ used: 0, remaining: 0 })).toBeNull();
    expect(parseLibreChatQuota(null)).toBeNull();
    expect(parseLibreChatQuota('5')).toBeNull();
  });

  it('保留封禁到期时间，空白字符串按未封禁处理', () => {
    const until = '2026-10-11T04:00:00.000Z';
    expect(parseLibreChatQuota({ ...validQuota, banned: true, bannedUntil: until })?.bannedUntil).toBe(until);
    expect(parseLibreChatQuota({ ...validQuota, bannedUntil: '   ' })?.bannedUntil).toBeNull();
  });
});

describe('fetchLibreChatQuota', () => {
  beforeEach(() => vi.mocked(api.get).mockReset());

  it('从 GET /api/librechat/quota 读取并解析额度', async () => {
    vi.mocked(api.get).mockResolvedValueOnce({ data: { success: true, quota: validQuota } } as any);

    await expect(fetchLibreChatQuota()).resolves.toMatchObject({ remaining: 3 });
    expect(api.get).toHaveBeenCalledWith('/api/librechat/quota');
  });

  it('响应缺少额度视图时抛错，交给调用方保留上一次已知值', async () => {
    vi.mocked(api.get).mockResolvedValueOnce({ data: { success: true } } as any);

    await expect(fetchLibreChatQuota()).rejects.toThrow();
  });
});
