import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useFingerprintRequest } from '../hooks/useFingerprintRequest';
import { useAuthStore } from '../stores/authStore';
import type { User } from '../types/auth';

vi.mock('../api/api', () => ({ getApiBaseUrl: () => 'https://example.com', api: {} }));
vi.mock('../utils/fingerprint', () => ({ getFingerprint: vi.fn() }));

describe('fingerprint request identity', () => {
  afterEach(() => { cleanup(); useAuthStore.getState().reset(); vi.unstubAllGlobals(); });
  it('ignores an old prompt after logout and re-login as the same account', async () => {
    let resolveOld!: (value: any) => void;
    const old = new Promise<any>(resolve => { resolveOld = resolve; });
    vi.stubGlobal('fetch', vi.fn().mockReturnValueOnce(old).mockResolvedValue({ ok: true, json: async () => ({ requireFingerprint: false }) }));
    useAuthStore.getState().setUser({ id: 'same', role: 'user' } as User);
    const { result } = renderHook(() => useFingerprintRequest());
    act(() => {
      useAuthStore.getState().logout();
      useAuthStore.getState().setUser({ id: 'same', role: 'user' } as User);
    });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { resolveOld({ ok: true, json: async () => ({ requireFingerprint: true, requireFingerprintAt: Date.now() }) }); });
    expect(result.current.shouldShowRequest).toBe(false);
    expect(result.current.requestStatus.requireFingerprint).toBe(false);
  });
});
