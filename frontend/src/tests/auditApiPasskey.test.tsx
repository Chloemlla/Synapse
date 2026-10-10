import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { usePasskey } from '../hooks/usePasskey';

const mocks = vi.hoisted(() => ({ remove: vi.fn(), list: vi.fn() }));
vi.mock('../api/passkey', () => ({ passkeyApi: { removeCredential: mocks.remove, getCredentials: mocks.list } }));
vi.mock('../hooks/useAuth', () => ({ useAuth: () => ({ loginWithToken: vi.fn() }) }));
vi.mock('../hooks/useSecuritySession', () => ({ getSecuritySessionToken: () => 'security-session' }));
vi.mock('@simplewebauthn/browser', () => ({ startRegistration: vi.fn(), startAuthentication: vi.fn() }));
vi.mock('../utils/passkeyDebugLog', () => ({ passkeyDebugLog: { append: vi.fn() } }));

describe('Passkey removal result', () => {
  afterEach(() => { cleanup(); vi.clearAllMocks(); });
  it('rejects failed deletion so the caller cannot report successful revocation', async () => {
    const failure = new Error('forbidden');
    mocks.remove.mockRejectedValue(failure);
    const { result } = renderHook(() => usePasskey());
    await act(async () => { await expect(result.current.removeAuthenticator('credential')).rejects.toBe(failure); });
    expect(mocks.list).not.toHaveBeenCalled();
    expect(result.current.isLoading).toBe(false);
  });
  it('does not report a completed deletion as failed when only the list refresh fails', async () => {
    mocks.remove.mockResolvedValue({ data: { success: true } });
    mocks.list.mockRejectedValue(new Error('temporary read failure'));
    const { result } = renderHook(() => usePasskey());
    await act(async () => { await expect(result.current.removeAuthenticator('credential')).resolves.toBeUndefined(); });
    expect(result.current.isLoading).toBe(false);
  });
});
