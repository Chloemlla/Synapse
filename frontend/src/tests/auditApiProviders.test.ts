import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../api', () => ({ default: () => 'https://example.com' }));
vi.mock('../utils/fetchWithTimeout', () => ({ fetchWithTimeout: mocks.fetch }));

describe('provider configuration retry', () => {
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
  it('recovers from a transient failure and allows later explicit refresh', async () => {
    vi.useFakeTimers();
    const enabled = { ok: true, json: async () => ({ google: { enabled: true, clientId: 'client' }, linuxdo: { enabled: true } }) };
    mocks.fetch.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(enabled);
    const { useAuthProviderStore } = await import('../stores/authProviderStore');
    await vi.advanceTimersByTimeAsync(0);
    expect(useAuthProviderStore.getState().error).toBeTruthy();
    await vi.advanceTimersByTimeAsync(2000);
    expect(useAuthProviderStore.getState()).toMatchObject({ google: { enabled: true }, linuxdo: { enabled: true }, loading: false, error: null });
    await useAuthProviderStore.getState().refresh();
    expect(mocks.fetch).toHaveBeenCalledTimes(3);
  });
});
