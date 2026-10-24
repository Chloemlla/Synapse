import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ fetch: vi.fn(), securityToken: 'verified-session' as string | null }));
vi.mock('../../api', () => ({ default: () => 'https://synapse.example.test' }));
vi.mock('../../hooks/useSecuritySession', () => ({ getSecuritySessionToken: () => h.securityToken }));

import { CDICT_UPSTREAM_API, authFetch, getAuthHeaders } from './api';

beforeEach(() => {
  h.fetch.mockReset(); h.fetch.mockResolvedValue({ ok: true });
  h.securityToken = 'verified-session';
  vi.stubGlobal('fetch', h.fetch);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('CDict upstream authenticated transport', () => {
  it('uses exactly the admin upstream setting endpoint', () => {
    expect(CDICT_UPSTREAM_API).toBe('https://synapse.example.test/api/admin/cdict-upstream/setting');
  });

  it.each(['GET', 'POST', 'DELETE'])('carries cookie authentication and the shared security session for %s', async (method) => {
    const controller = new AbortController();
    const payload = { translateBaseUrl: '', translateAppId: '', ttsUrl: '', ttsAppId: '', ttsAppKey: 'new-key' };
    const init: RequestInit = {
      method, headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' }, signal: controller.signal,
      ...(method === 'POST' ? { body: JSON.stringify(payload) } : {}),
    };
    await authFetch(CDICT_UPSTREAM_API, init);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    const [url, sent] = h.fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(CDICT_UPSTREAM_API);
    expect(sent.credentials).toBe('include');
    expect(sent.signal).toBe(controller.signal);
    expect(sent.method).toBe(method);
    expect(sent.body).toBe(init.body);
    const headers = new Headers(sent.headers);
    expect(headers.get('x-verification-token')).toBe('verified-session');
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(headers.has('Authorization')).toBe(false);
  });

  it('does not invent a bearer token or security session when the shared session is unavailable', async () => {
    h.securityToken = null;
    await authFetch(CDICT_UPSTREAM_API, { method: 'GET', headers: getAuthHeaders() });
    const sent = h.fetch.mock.calls[0][1] as RequestInit;
    expect(sent.credentials).toBe('include');
    expect(new Headers(sent.headers).has('x-verification-token')).toBe(false);
    expect(new Headers(sent.headers).has('Authorization')).toBe(false);
  });

  it('does not persist credentials or read an auth token from browser storage', async () => {
    const readStorage = vi.spyOn(Storage.prototype, 'getItem');
    const writeStorage = vi.spyOn(Storage.prototype, 'setItem');
    await authFetch(CDICT_UPSTREAM_API, {
      method: 'POST', headers: getAuthHeaders(), body: JSON.stringify({ ttsAppKey: 'memory-only-key' }),
    });
    expect(readStorage).not.toHaveBeenCalled();
    expect(writeStorage).not.toHaveBeenCalled();
  });
});
