import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSecureCaptchaSelection } from '../hooks/useSecureCaptchaSelection';
import { CaptchaType, type CaptchaScenario } from '../utils/captchaSelection';

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../api', () => ({ default: () => '' }));
vi.mock('../utils/fetchWithTimeout', () => ({ fetchWithTimeout: mocks.fetch }));
vi.mock('../utils/captchaSelection', async (importOriginal) => ({
  ...await importOriginal<typeof import('../utils/captchaSelection')>(),
  generateSecureCaptchaSelection: (fingerprint: string) => ({
    encryptedData: fingerprint, timestamp: Date.now(), hash: 'hash',
  }),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function response(siteKey: string) {
  return {
    ok: true,
    json: async () => ({
      success: true,
      captchaType: CaptchaType.TURNSTILE,
      config: { enabled: true, siteKey },
    }),
  } as Response;
}

const flush = async () => { await act(async () => {}); };
const body = (index: number) => JSON.parse(mocks.fetch.mock.calls[index][1].body);
const signal = (index: number): AbortSignal => mocks.fetch.mock.calls[index][1].signal;

beforeEach(() => {
  vi.useFakeTimers();
  mocks.fetch.mockReset();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useSecureCaptchaSelection request ownership', () => {
  it.each(['success', 'failure'] as const)('refresh supersedes a pending request and ignores its late %s', async (outcome) => {
    const old = deferred<Response>();
    const fresh = deferred<Response>();
    mocks.fetch.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const { result } = renderHook(() => useSecureCaptchaSelection({ fingerprint: 'fp' }));
    act(() => result.current.regenerateSelection({ exclude: [CaptchaType.TURNSTILE] }));
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(signal(0).aborted).toBe(true);
    expect(body(1).exclude).toEqual([CaptchaType.TURNSTILE]);

    await act(async () => {
      if (outcome === 'success') old.resolve(response('old'));
      else old.reject(new Error('old failure'));
    });
    expect(result.current.loading).toBe(true);
    expect(result.current.captchaConfig).toBeNull();
    expect(result.current.error).toBeNull();
    await act(async () => { fresh.resolve(response('fresh')); });
    expect(result.current.siteKey).toBe('fresh');
    expect(result.current.loading).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it('ignores a superseded response whose JSON body finishes after the replacement', async () => {
    const json = deferred<unknown>();
    mocks.fetch.mockResolvedValueOnce({ ok: true, json: () => json.promise });
    const { result } = renderHook(() => useSecureCaptchaSelection({ fingerprint: 'fp' }));
    await flush();
    mocks.fetch.mockResolvedValueOnce(response('fresh'));
    act(() => result.current.regenerateSelection());
    await flush();
    await act(async () => { json.resolve(await response('old').json()); });
    expect(result.current.siteKey).toBe('fresh');
  });

  it.each(['fingerprint', 'scenario'] as const)('reallocates initialized configuration when %s changes', async (field) => {
    mocks.fetch.mockResolvedValue(response('first'));
    const initialProps: { fingerprint: string; scenario: CaptchaScenario } = { fingerprint: 'fp', scenario: 'default' };
    const { result, rerender } = renderHook((props) => useSecureCaptchaSelection(props), { initialProps });
    await flush();
    act(() => result.current.regenerateSelection({ exclude: [CaptchaType.HCAPTCHA] }));
    await flush();
    const next = deferred<Response>();
    mocks.fetch.mockReturnValueOnce(next.promise);
    rerender(field === 'fingerprint'
      ? { ...initialProps, fingerprint: 'new-fp' }
      : { ...initialProps, scenario: 'standalone' });
    expect(result.current.captchaConfig).toBeNull();
    expect(result.current.excluded).toEqual([]);
    expect(body(2)).toMatchObject(field === 'fingerprint' ? { fingerprint: 'new-fp' } : { scenario: 'standalone' });
    expect(body(2)).not.toHaveProperty('exclude');
    await act(async () => { next.resolve(response('new')); });
    expect(result.current.siteKey).toBe('new');
  });

  it('clears failed providers on a manual retry', async () => {
    mocks.fetch.mockResolvedValue(response('key'));
    const { result } = renderHook(() => useSecureCaptchaSelection({ fingerprint: 'fp' }));
    await flush();
    act(() => result.current.regenerateSelection({ exclude: [CaptchaType.TURNSTILE, CaptchaType.HCAPTCHA] }));
    await flush();
    act(() => result.current.regenerateSelection());
    expect(body(2)).not.toHaveProperty('exclude');
    expect(result.current.excluded).toEqual([]);
    await flush();
  });

  it('caps automatic attempts, then allows a fresh manual round', async () => {
    mocks.fetch.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useSecureCaptchaSelection({ fingerprint: 'fp' }));
    await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(120000); });
    expect(mocks.fetch).toHaveBeenCalledTimes(5);
    mocks.fetch.mockResolvedValueOnce(response('recovered'));
    act(() => result.current.regenerateSelection());
    await flush();
    expect(result.current.siteKey).toBe('recovered');
  });

  it('cancels a previous retry timer when manually refreshed', async () => {
    mocks.fetch.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(response('recovered'));
    const { result } = renderHook(() => useSecureCaptchaSelection({ fingerprint: 'fp' }));
    await flush();
    act(() => result.current.regenerateSelection());
    await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(result.current.siteKey).toBe('recovered');
  });

  it('cancels retry timers on unmount', async () => {
    mocks.fetch.mockRejectedValue(new Error('offline'));
    const { unmount } = renderHook(() => useSecureCaptchaSelection({ fingerprint: 'fp' }));
    await flush();
    unmount();
    expect(signal(0).aborted).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it('aborts an in-flight request and ignores its rejection after unmount', async () => {
    const pending = deferred<Response>();
    mocks.fetch.mockReturnValueOnce(pending.promise);
    const { unmount } = renderHook(() => useSecureCaptchaSelection({ fingerprint: 'fp' }));
    unmount();
    expect(signal(0).aborted).toBe(true);
    await act(async () => { pending.reject(new Error('late failure')); });
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it('waits for a fingerprint without reporting a service error', async () => {
    mocks.fetch.mockResolvedValue(response('key'));
    const { result, rerender } = renderHook(({ fingerprint }) => useSecureCaptchaSelection({ fingerprint }), {
      initialProps: { fingerprint: '' },
    });
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(result.current.error).toBeNull();
    rerender({ fingerprint: 'fp' });
    await flush();
    expect(result.current.siteKey).toBe('key');
    rerender({ fingerprint: '' });
    expect(result.current.captchaConfig).toBeNull();
  });
});
