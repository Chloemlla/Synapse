import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api/api';
import { useLibreChatQuota } from './useLibreChatQuota';

vi.mock('../api/api', () => ({ api: { get: vi.fn() } }));

const quota = (overrides: Record<string, unknown> = {}) => ({
  dailyLimit: 5,
  used: 1,
  remaining: 4,
  banned: false,
  bannedUntil: null,
  warnings: 0,
  maxWarnings: 3,
  ...overrides,
});

function respondWith(view: Record<string, unknown>) {
  vi.mocked(api.get).mockResolvedValueOnce({ data: { success: true, quota: view } } as any);
}

describe('useLibreChatQuota', () => {
  beforeEach(() => vi.mocked(api.get).mockReset());

  it('挂载即读取一次额度', async () => {
    respondWith(quota());
    const { result } = renderHook(() => useLibreChatQuota());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.quota?.remaining).toBe(4);
    expect(result.current.error).toBeNull();
  });

  it('刷新失败时保留上一次已知额度，只标记错误', async () => {
    respondWith(quota());
    const { result } = renderHook(() => useLibreChatQuota());
    await waitFor(() => expect(result.current.quota?.remaining).toBe(4));

    vi.mocked(api.get).mockRejectedValueOnce(new Error('unavailable'));
    await act(() => result.current.refresh());

    expect(result.current.quota?.remaining).toBe(4);
    expect(result.current.error).toBeTruthy();
  });

  it('登录态未就绪时不发请求，就绪后才读', async () => {
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useLibreChatQuota(enabled),
      { initialProps: { enabled: false } },
    );
    expect(api.get).not.toHaveBeenCalled();

    respondWith(quota());
    rerender({ enabled: true });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.quota?.remaining).toBe(4);
  });

  it('登出（enabled=false）会清掉上一个账号的额度', async () => {
    respondWith(quota());
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useLibreChatQuota(enabled),
      { initialProps: { enabled: true } },
    );
    await waitFor(() => expect(result.current.quota?.remaining).toBe(4));

    rerender({ enabled: false });
    await waitFor(() => expect(result.current.quota).toBeNull());
  });

  it('发送响应内联的新额度会作废在途的旧查询，剩余次数不回退', async () => {
    let finishStale!: (value: unknown) => void;
    vi.mocked(api.get).mockImplementationOnce(
      () => new Promise<any>((resolve) => { finishStale = resolve; }),
    );
    const { result } = renderHook(() => useLibreChatQuota()); // 首次查询仍悬挂

    act(() => result.current.applyQuota(quota({ used: 2, remaining: 3 }) as any));
    await act(async () => {
      finishStale({ data: { success: true, quota: quota({ used: 1, remaining: 4 }) } });
    });

    expect(result.current.quota?.remaining).toBe(3);
    expect(result.current.loading).toBe(false);
  });
});
