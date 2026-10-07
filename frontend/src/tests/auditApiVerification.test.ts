import { describe, expect, it, vi } from 'vitest';
import { getApiBaseUrl } from '../api/api';
import '../hooks/useTts';

const mocks = vi.hoisted(() => ({ failures: [] as Array<(error: any) => Promise<unknown>>, clear: vi.fn(), emit: vi.fn() }));
vi.mock('axios', () => ({
  default: { create: () => ({ interceptors: { request: { use: vi.fn() }, response: { use: (_success: unknown, failure: any) => mocks.failures.push(failure) } } }) },
  AxiosHeaders: class {},
  AxiosError: class extends Error {},
}));
vi.mock('../utils/ipVerification', () => ({ buildIpVerificationHeaders: vi.fn(), clearIpVerificationToken: mocks.clear, emitIpVerificationRequired: mocks.emit, isExemptPath: () => false }));
vi.mock('../utils/fingerprint', () => ({ reportFingerprintOnce: vi.fn(), getFingerprint: vi.fn() }));
vi.mock('../utils/penaltyAppeal', () => ({ maybeEmitPenaltyAppealFromError: vi.fn() }));
vi.mock('../utils/captchaRecovery', () => ({ notifyCaptchaFailure: () => false }));
vi.mock('../utils/sign', () => ({ verifyContent: vi.fn() }));

describe('verification token and API URL contracts', () => {
  it('both axios clients keep a newer verification token after a delayed 403', async () => {
    expect(mocks.failures).toHaveLength(2);
    const error = { config: { url: '/api/tts', baseURL: 'https://example.com' }, response: { status: 403, data: { errorCode: 'IP_VERIFICATION_REQUIRED' } } };
    for (const failure of mocks.failures) await expect(failure(error)).rejects.toBe(error);
    expect(mocks.clear).not.toHaveBeenCalled();
    expect(mocks.emit).toHaveBeenCalledTimes(2);
  });
  it('normalizes a configured API base URL before callers append /api', () => {
    vi.stubEnv('VITE_API_URL', 'https://example.com///');
    try { expect(`${getApiBaseUrl()}/api/auth/me`).toBe('https://example.com/api/auth/me'); }
    finally { vi.unstubAllEnvs(); }
  });
});
