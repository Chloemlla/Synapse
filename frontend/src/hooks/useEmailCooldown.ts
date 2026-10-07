import { useCallback, useEffect, useState } from 'react';

export function useEmailCooldown() {
  const [retryAt, setRetryAt] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const applyCooldown = useCallback((data: unknown) => {
    if (!data || typeof data !== 'object') return;
    const value = Number((data as { retryAfterSeconds?: unknown }).retryAfterSeconds);
    if (!Number.isFinite(value) || value <= 0) return;
    const delay = Math.ceil(value);
    setRetryAt(Date.now() + delay * 1000);
    setSeconds(delay);
  }, []);

  useEffect(() => {
    if (!retryAt) return;
    const update = () => {
      const remaining = Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
      setSeconds(remaining);
      if (remaining === 0) setRetryAt(0);
    };
    const timer = setInterval(update, 500);
    return () => clearInterval(timer);
  }, [retryAt]);

  return { seconds, applyCooldown };
}
