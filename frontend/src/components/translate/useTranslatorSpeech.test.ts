import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ speech: vi.fn() }));
vi.mock('../../api/cdict', () => ({ fetchCDictSpeech: mocks.speech }));
import { useTranslatorSpeech } from './useTranslatorSpeech';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { resolve, promise };
}
const players: Array<{ play: ReturnType<typeof vi.fn>; pause: ReturnType<typeof vi.fn>; load: ReturnType<typeof vi.fn>; removeAttribute: ReturnType<typeof vi.fn>; onended: (() => void) | null; onerror: (() => void) | null }> = [];
beforeEach(() => {
  vi.clearAllMocks(); players.length = 0;
  vi.stubGlobal('Audio', class {
    play = vi.fn().mockResolvedValue(undefined); pause = vi.fn(); load = vi.fn(); removeAttribute = vi.fn();
    onended = null; onerror = null;
    constructor() { players.push(this); }
  });
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:voice') });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  mocks.speech.mockResolvedValue(new Blob(['audio'], { type: 'audio/wav' }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const payload = { text: 'hello', source: 'engine' as const, langType: 'en-USA' };
describe('pronunciation resource ownership', () => {
  it('stops playback and revokes audio resources on text/language/provider context changes and unmount', async () => {
    const { result, rerender, unmount } = renderHook(({ context }) => useTranslatorSpeech(context), { initialProps: { context: 'cdict:en:hello' } });
    await act(async () => { await result.current.play('source', payload); });
    expect(result.current.state.status).toBe('playing');
    rerender({ context: 'deeplx:ZH:你好' });
    expect(players[0].pause).toHaveBeenCalledOnce();
    expect(players[0].removeAttribute).toHaveBeenCalledWith('src');
    expect(players[0].load).toHaveBeenCalledOnce();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:voice');
    expect(result.current.state.status).toBe('idle');
    await act(async () => { await result.current.play('target', payload); });
    unmount();
    expect(players[1].pause).toHaveBeenCalledOnce();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
  });
  it('aborts stale fetches and ignores their blobs even when the transport does not honor abort', async () => {
    const first = deferred<Blob>();
    mocks.speech.mockReturnValueOnce(first.promise);
    const { result } = renderHook(() => useTranslatorSpeech('context'));
    let pending!: Promise<void>;
    act(() => { pending = result.current.play('source', payload); });
    const signal = mocks.speech.mock.calls[0][1] as AbortSignal;
    await act(async () => { await result.current.play('target', payload); });
    expect(signal.aborted).toBe(true);
    await act(async () => { first.resolve(new Blob(['old'], { type: 'audio/wav' })); await pending; });
    expect(players).toHaveLength(1);
    expect(result.current.state.key).toBe('target');
    expect(URL.createObjectURL).toHaveBeenCalledOnce();
  });
  it('cleans up on media errors, provides a visible error, and does not invoke browser speech', async () => {
    const { result } = renderHook(() => useTranslatorSpeech('context'));
    const synthesize = vi.fn(); vi.stubGlobal('speechSynthesis', { speak: synthesize });
    const pending = deferred<Blob>(); mocks.speech.mockReturnValueOnce(pending.promise);
    let work!: Promise<void>;
    act(() => { work = result.current.play('source', payload); });
    await act(async () => { pending.resolve(new Blob(['audio'], { type: 'audio/wav' })); await Promise.resolve(); });
    // The fetched player already fulfilled play; its media error still releases it.
    act(() => { players[0].onerror?.(); });
    await work;
    expect(result.current.state.error).toBeTruthy();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:voice');
    expect(synthesize).not.toHaveBeenCalled();
  });
  it('rejects 301 characters without IO and releases completed audio', async () => {
    const { result } = renderHook(() => useTranslatorSpeech('context'));
    await act(async () => { await result.current.play('source', { ...payload, text: 'x'.repeat(301) }); });
    expect(mocks.speech).not.toHaveBeenCalled();
    expect(result.current.state.error).toContain('300');
    await act(async () => { await result.current.play('source', payload); });
    act(() => players[0].onended?.());
    await waitFor(() => expect(result.current.state.status).toBe('idle'));
    expect(players[0].onended).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledOnce();
  });
});

it('releases the URL when browser play rejects and when a pending fetch is unmounted', async () => {
  vi.stubGlobal('Audio', class {
    onended = null; onerror = null; pause = vi.fn(); load = vi.fn(); removeAttribute = vi.fn();
    play = vi.fn().mockRejectedValue(new Error('Autoplay rejected'));
    constructor() { players.push(this); }
  });
  const first = renderHook(() => useTranslatorSpeech('first'));
  await act(async () => { await first.result.current.play('source', payload); });
  expect(first.result.current.state.error).toBeTruthy();
  expect(players[0].pause).toHaveBeenCalledOnce();
  expect(URL.revokeObjectURL).toHaveBeenCalledOnce();
  first.unmount();
  const pending = deferred<Blob>();
  mocks.speech.mockReturnValueOnce(pending.promise);
  const second = renderHook(() => useTranslatorSpeech('second'));
  let work!: Promise<void>;
  act(() => { work = second.result.current.play('target', payload); });
  const signal = mocks.speech.mock.lastCall![1] as AbortSignal;
  second.unmount();
  expect(signal.aborted).toBe(true);
  await act(async () => { pending.resolve(new Blob(['wav'], { type: 'audio/wav' })); await work; });
  expect(URL.createObjectURL).toHaveBeenCalledOnce();
});
