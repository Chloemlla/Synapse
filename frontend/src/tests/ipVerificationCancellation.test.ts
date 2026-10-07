import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../utils/fetchWithTimeout', () => ({ fetchWithTimeout: (...args: unknown[]) => h.fetch(...args) }));
vi.mock('../utils/fingerprint', () => ({ getFingerprint: async () => 'fp' }));
vi.mock('../utils/firstVisitVerificationConfig', () => ({ isFirstVisitVerificationEnabled: () => true }));
vi.mock('../api/api', () => ({ getApiBaseUrl: () => 'https://synapse.example' }));
vi.mock('../utils/penaltyAppeal', () => ({ maybeEmitPenaltyAppealFromResponse: vi.fn() }));

import { completeIpVerification, getStoredIpVerificationToken, storeIpVerificationToken } from '../utils/ipVerification';

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe('IP verification cancellation', () => {
  it('does not send a previously cancelled challenge', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(completeIpVerification('fp', 'challenge', 'turnstile', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('does not replace a newer stored session after cancellation during response decoding', async () => {
    const controller = new AbortController();
    let resolveBody!: (body: unknown) => void;
    const json = vi.fn(() => new Promise((resolve) => { resolveBody = resolve; }));
    h.fetch.mockResolvedValueOnce({ ok: true, json });
    const pending = completeIpVerification('old-fp', 'old-challenge', 'turnstile', controller.signal);
    await Promise.resolve();
    expect(json).toHaveBeenCalled();
    controller.abort();
    storeIpVerificationToken({
      success: true, verified: true, requiresVerification: false,
      fingerprint: 'new-fp', token: 'new-session', ipAddress: '127.0.0.1',
      expiresAt: new Date(Date.now() + 60000).toISOString(), tokenTtlMinutes: 1,
    });
    resolveBody({ success: true, verified: true, token: 'old-session', fingerprint: 'old-fp', expiresAt: new Date(Date.now() + 60000).toISOString() });
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(getStoredIpVerificationToken()).toBe('new-session');
    expect(h.fetch.mock.calls[0][1].signal).toBe(controller.signal);
  });
});
