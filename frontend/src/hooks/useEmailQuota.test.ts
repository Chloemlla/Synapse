import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api/api';
import { useEmailQuota } from './useEmailQuota';

vi.mock('../api/api', () => ({ api: { get: vi.fn() } }));

describe('useEmailQuota', () => {
  beforeEach(() => vi.mocked(api.get).mockReset());

  it('keeps quota unknown on failure and recovers through refresh', async () => {
    vi.mocked(api.get).mockRejectedValueOnce(new Error('unavailable'));
    const { result } = renderHook(() => useEmailQuota('/api/email/quota'));
    expect(result.current.quota).toBeNull();
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.quota).toBeNull();

    vi.mocked(api.get).mockResolvedValueOnce({ data: { used: 20, quotaTotal: 20 } });
    await act(() => result.current.refresh());
    expect(result.current.quota).toMatchObject({ used: 20, total: 20 });
  });

  it('ignores an older response after a newer refresh has completed', async () => {
    let finishFirst!: (value: unknown) => void;
    vi.mocked(api.get).mockImplementationOnce(() => new Promise<any>((resolve) => {
      finishFirst = resolve;
    }));
    const { result } = renderHook(() => useEmailQuota('/api/email/quota'));
    vi.mocked(api.get).mockResolvedValueOnce({ data: { used: 9, quotaTotal: 100 } });
    await act(() => result.current.refresh());
    await act(async () => { finishFirst({ data: { used: 1, quotaTotal: 100 } }); });
    expect(result.current.quota?.used).toBe(9);
    expect(api.get).toHaveBeenNthCalledWith(1, '/api/email/quota');
  });
});
