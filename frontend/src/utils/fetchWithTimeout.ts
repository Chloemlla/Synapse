import { notifyCaptchaFailure, readCaptchaRequestToken } from './captchaRecovery';

/**
 * Shared fetch wrapper that unifies timeout + abort behaviour for the bare
 * fetch call-sites that are not routed through the main axios instance
 * (turnstile.ts / fbi.ts / ipVerification.ts / fingerprint.ts / App.tsx mount fetches).
 *
 * It deliberately keeps the same `Response` contract as `fetch`, so callers
 * can be migrated incrementally without changing their error handling shape.
 */
export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = 15000,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);

  // Merge a caller-provided signal with our timeout abort so both can win.
  const callerSignal = init.signal;
  const onCallerAbort = () => controller.abort();
  if (callerSignal) {
    if (callerSignal.aborted) {
      controller.abort();
    } else {
      callerSignal.addEventListener('abort', onCallerAbort, { once: true });
    }
  }

  try {
    const response = await fetch(input, { ...init, signal: controller.signal });
    const contentType = response.headers.get('content-type') || '';
    const isStream = /text\/event-stream|application\/(?:x-ndjson|ndjson|octet-stream)/i.test(contentType);
    if (!isStream && (/\bjson\b/i.test(contentType) || readCaptchaRequestToken(init.body) !== null)) {
      try {
        const body: unknown = await response.clone().json();
        notifyCaptchaFailure(body, init.body, response.status);
      } catch { /* Parsing diagnostics must not consume or replace the original response. */ }
    }
    return response;
  } finally {
    window.clearTimeout(timeoutId);
    // {once:true} 只在 abort 真发生时自动摘除；未触发时监听器会一直挂在调用方的
    // 长生命周期 signal 上累积，必须在这里显式移除（重复移除是空操作）。
    callerSignal?.removeEventListener('abort', onCallerAbort);
  }
}

/** Convenience alias to keep call-sites readable. */
export const fetchWithTimeoutJson = async <T = unknown>(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs?: number,
): Promise<T> => {
  const res = await fetchWithTimeout(input, init, timeoutMs);
  return (await res.json()) as T;
};
