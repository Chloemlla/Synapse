import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useEmailCooldown } from './useEmailCooldown';

describe('useEmailCooldown', () => {
  afterEach(() => vi.useRealTimers());

  it('uses the backend retry duration and releases the form at expiry', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useEmailCooldown());
    act(() => result.current.applyCooldown({ retryAfterSeconds: 3 }));
    expect(result.current.seconds).toBe(3);
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current.seconds).toBe(2);
    act(() => vi.advanceTimersByTime(2000));
    expect(result.current.seconds).toBe(0);
  });

  it('does not invent a cooldown for ordinary errors or invalid durations', () => {
    const { result } = renderHook(() => useEmailCooldown());
    act(() => {
      result.current.applyCooldown({ error: 'temporarily unavailable' });
      result.current.applyCooldown({ retryAfterSeconds: -5 });
      result.current.applyCooldown({ retryAfterSeconds: 'invalid' });
    });
    expect(result.current.seconds).toBe(0);
  });
});
