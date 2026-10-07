import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitForCaptcha } from '../utils/waitForCaptcha';

afterEach(() => vi.useRealTimers());

describe('batch captcha wait lifecycle', () => {
  it('accepts synchronous solve during reset and removes the abort listener', async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const ref = { current: null as ((token: string) => void) | null };
    await expect(waitForCaptcha(ref, () => ref.current?.('fresh'), controller.signal)).resolves.toBe('fresh');
    expect(ref.current).toBeNull();
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('does not reset or install a resolver when already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const reset = vi.fn();
    const ref = { current: null as ((token: string) => void) | null };
    await expect(waitForCaptcha(ref, reset, controller.signal)).resolves.toBeNull();
    expect(reset).not.toHaveBeenCalled();
    expect(ref.current).toBeNull();
  });

  it('cancels the current wait without retaining previous listeners', async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const ref = { current: null as ((token: string) => void) | null };
    const first = waitForCaptcha(ref, () => {}, controller.signal);
    const oldCallback = ref.current;
    oldCallback?.('first');
    await expect(first).resolves.toBe('first');
    const second = waitForCaptcha(ref, () => {}, controller.signal);
    const currentCallback = ref.current;
    oldCallback?.('late');
    expect(ref.current).toBe(currentCallback);
    controller.abort();
    await expect(second).resolves.toBeNull();
    expect(remove).toHaveBeenCalledTimes(2);
    expect(ref.current).toBeNull();
  });

  it('cleans up on timeout and reset failure', async () => {
    vi.useFakeTimers();
    const ref = { current: null as ((token: string) => void) | null };
    const pending = waitForCaptcha(ref, () => {}, undefined, 100);
    await vi.advanceTimersByTimeAsync(100);
    await expect(pending).resolves.toBeNull();
    await expect(waitForCaptcha(ref, () => { throw new Error('Reset failed'); })).rejects.toThrow('Reset failed');
    expect(ref.current).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});
