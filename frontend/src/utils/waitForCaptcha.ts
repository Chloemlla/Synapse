/** Wait for one batch-upload challenge without retaining listeners from earlier files. */
export function waitForCaptcha<T>(
  resolverRef: { current: ((challenge: T) => void) | null },
  reset: () => void,
  signal?: AbortSignal,
  timeoutMs = 30000,
): Promise<T | null> {
  if (signal?.aborted) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      window.clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      if (resolverRef.current === onSolved) resolverRef.current = null;
    };
    const settle = (challenge: T | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(challenge);
    };
    const onAbort = () => settle(null);
    const onSolved = (challenge: T) => settle(challenge);
    const timeout = window.setTimeout(() => settle(null), timeoutMs);
    resolverRef.current = onSolved;
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      // Install the resolver first: a widget may solve synchronously during reset.
      reset();
    } catch (error) {
      if (!settled) {
        settled = true;
        cleanup();
        reject(error);
      }
    }
  });
}
