import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ speech: vi.fn(), microsoft: vi.fn() }));
vi.mock('../../api/cdict', () => ({ fetchCDictSpeech: mocks.speech, fetchMicrosoftTranslatorSpeech: mocks.microsoft }));
import { useTranslatorSpeech } from './useTranslatorSpeech';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { resolve, reject, promise };
}
const playback = vi.fn();
const players: Array<{ play: ReturnType<typeof vi.fn>; pause: ReturnType<typeof vi.fn>; load: ReturnType<typeof vi.fn>; removeAttribute: ReturnType<typeof vi.fn>; onended: (() => void) | null; onerror: (() => void) | null }> = [];
beforeEach(() => {
  vi.resetAllMocks(); players.length = 0;
  playback.mockResolvedValue(undefined);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('Audio', class {
    play = vi.fn().mockImplementation(() => playback()); pause = vi.fn(); load = vi.fn(); removeAttribute = vi.fn();
    onended = null; onerror = null;
    constructor() { players.push(this); }
  });
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn().mockReturnValueOnce('blob:voice').mockReturnValueOnce('blob:fallback').mockReturnValue('blob:next') });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  mocks.speech.mockResolvedValue(new Blob(['audio'], { type: 'audio/wav' }));
  mocks.microsoft.mockResolvedValue(new Blob(['fallback'], { type: 'audio/mpeg' }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
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
    mocks.microsoft.mockRejectedValueOnce(new Error('fallback offline'));
    const pending = deferred<Blob>(); mocks.speech.mockReturnValueOnce(pending.promise);
    let work!: Promise<void>;
    act(() => { work = result.current.play('source', payload); });
    await act(async () => { pending.resolve(new Blob(['audio'], { type: 'audio/wav' })); await Promise.resolve(); });
    // The first player already fulfilled play; decoding failure must try the backup before showing an error.
    act(() => { players[0].onerror?.(); });
    await act(async () => { await work; });
    await waitFor(() => expect(result.current.state.error).toBeTruthy());
    expect(mocks.microsoft).toHaveBeenCalledExactlyOnceWith(payload, mocks.speech.mock.calls[0][1]);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:voice');
    expect(synthesize).not.toHaveBeenCalled();
  });
  it('rejects 301 characters without IO and releases completed audio', async () => {
    const { result } = renderHook(() => useTranslatorSpeech('context'));
    await act(async () => { await result.current.play('source', { ...payload, text: 'x'.repeat(301) }); });
    expect(mocks.speech).not.toHaveBeenCalled();
    expect(mocks.microsoft).not.toHaveBeenCalled();
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
    play = vi.fn().mockRejectedValue(new DOMException('Autoplay rejected', 'NotAllowedError'));
    constructor() { players.push(this); }
  });
  const first = renderHook(() => useTranslatorSpeech('first'));
  await act(async () => { await first.result.current.play('source', payload); });
  expect(first.result.current.state.error).toContain('浏览器');
  expect(mocks.microsoft).not.toHaveBeenCalled();
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

describe('one Microsoft fallback per pronunciation generation', () => {
  it.each([{ code: 'ERR_NETWORK' }, { response: { status: 503 } },
    { code: 'INVALID_AUDIO_RESPONSE', httpStatus: 200 }])('falls back after source failure: %j', async error => {
    mocks.speech.mockRejectedValueOnce(error);
    const { result } = renderHook(() => useTranslatorSpeech('context'));
    await act(async () => { await result.current.play('source', payload); });
    expect(mocks.speech).toHaveBeenCalledOnce();
    expect(mocks.microsoft).toHaveBeenCalledExactlyOnceWith(payload, mocks.speech.mock.calls[0][1]);
    expect(result.current.state).toEqual({ status: 'playing', key: 'source', error: '', provider: 'microsoft' });
    expect(players).toHaveLength(1);
    const signal = mocks.microsoft.mock.calls[0][1] as AbortSignal;
    expect(signal.aborted).toBe(false);
    act(() => result.current.stop());
    expect(signal.aborted).toBe(true);
    expect(players[0].pause).toHaveBeenCalledOnce();
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:voice');
  });
  it('shows a user-facing error only after both services fail and logs only safe context', async () => {
    mocks.speech.mockRejectedValueOnce({ code: 'ERR_NETWORK', message: 'SECRET source text' });
    mocks.microsoft.mockRejectedValueOnce({ response: { status: 502, data: { code: 502, text: 'SECRET', token: 'SECRET' },
      headers: { 'x-request-id': 'fallback-req', Authorization: 'SECRET' } }, config: { text: 'SECRET' } });
    const { result } = renderHook(() => useTranslatorSpeech('context'));
    await act(async () => { await result.current.play('source', { ...payload, text: 'SECRET' }); });
    expect(result.current.state).toEqual({ status: 'idle', key: 'source', error: '语音暂时不可用，请重试或选择另一种发音。' });
    expect(mocks.microsoft).toHaveBeenCalledOnce();
    expect(console.error).toHaveBeenCalledTimes(2);
    expect(console.error).toHaveBeenNthCalledWith(1, '[翻译] 朗读失败', {
      path: '/api/translate/cdict/tts', httpStatus: null, errorCode: 'ERR_NETWORK', requestId: null, stage: 'http', provider: 'cdict',
    });
    expect(console.error).toHaveBeenNthCalledWith(2, '[翻译] 朗读失败', {
      path: '/api/translate/cdict/tts', httpStatus: 502, errorCode: 502, requestId: 'fallback-req', stage: 'http', provider: 'microsoft',
    });
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('SECRET');
    expect(players).toHaveLength(0);
    expect((mocks.microsoft.mock.calls[0][1] as AbortSignal).aborted).toBe(true);
  });
  it('falls back on a decoded player error and releases both audio resources when stopped', async () => {
    const { result } = renderHook(() => useTranslatorSpeech('context'));
    await act(async () => { await result.current.play('source', payload); });
    const firstError = players[0].onerror;
    await act(async () => { firstError?.(); });
    expect(mocks.microsoft).toHaveBeenCalledExactlyOnceWith(payload, mocks.speech.mock.calls[0][1]);
    expect(result.current.state.provider).toBe('microsoft');
    expect(result.current.state.status).toBe('playing');
    expect(players[0].onerror).toBeNull();
    expect(players[0].pause).toHaveBeenCalledOnce();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:voice');
    act(() => { firstError?.(); result.current.stop(); });
    expect(mocks.microsoft).toHaveBeenCalledOnce();
    expect(players[1].pause).toHaveBeenCalledOnce();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
    expect(URL.revokeObjectURL).toHaveBeenLastCalledWith('blob:fallback');
    expect((mocks.microsoft.mock.calls[0][1] as AbortSignal).aborted).toBe(true);
  });
  it('falls back for play NotSupportedError but never tries a third service after backup media failure', async () => {
    playback.mockRejectedValueOnce(new DOMException('unsupported audio', 'NotSupportedError'));
    const { result } = renderHook(() => useTranslatorSpeech('context'));
    await act(async () => { await result.current.play('source', payload); });
    expect(result.current.state.provider).toBe('microsoft');
    expect(players[0].pause).toHaveBeenCalledOnce();
    await act(async () => { players[1].onerror?.(); });
    expect(result.current.state.error).toBe('语音播放失败，请重试。');
    expect(mocks.speech).toHaveBeenCalledOnce();
    expect(mocks.microsoft).toHaveBeenCalledOnce();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
  });
});

it('deduplicates repeated media errors plus a delayed play rejection during pending fallback', async () => {
  const firstPlay = deferred<void>();
  const backup = deferred<Blob>();
  playback.mockReturnValueOnce(firstPlay.promise);
  mocks.microsoft.mockReturnValueOnce(backup.promise);
  const { result } = renderHook(() => useTranslatorSpeech('context'));
  let work!: Promise<void>;
  act(() => { work = result.current.play('source', payload); });
  await waitFor(() => expect(players).toHaveLength(1));
  const firstError = players[0].onerror;
  act(() => { firstError?.(); firstError?.(); });
  expect(mocks.microsoft).toHaveBeenCalledOnce();
  expect(result.current.state).toEqual({ status: 'loading', key: 'source', error: '', provider: 'microsoft' });
  await act(async () => {
    firstPlay.reject(new DOMException('decode failed', 'NotSupportedError'));
    await work;
  });
  expect(mocks.microsoft).toHaveBeenCalledOnce();
  await act(async () => { backup.resolve(new Blob(['backup'], { type: 'audio/mpeg' })); });
  await waitFor(() => expect(result.current.state.status).toBe('playing'));
  expect(result.current.state.provider).toBe('microsoft');
  expect(players).toHaveLength(2);
  expect(console.error).toHaveBeenCalledOnce();
});

it.each([400, 401, 403, 404, 413, 422, 429])('does not bypass HTTP %s by invoking a backup provider', async status => {
  mocks.speech.mockRejectedValueOnce({ response: { status } });
  const { result } = renderHook(() => useTranslatorSpeech('context'));
  await act(async () => { await result.current.play('source', payload); });
  expect(mocks.microsoft).not.toHaveBeenCalled();
  expect(result.current.state.status).toBe('idle');
  expect(result.current.state.error).toBeTruthy();
  expect(players).toHaveLength(0);
  if (status === 429) expect(result.current.state.error).toContain('请求较多');
});

it.each([{ code: 'ERR_CANCELED' }, new DOMException('aborted', 'AbortError')])('does not log or fall back for cancellation: %j', async error => {
  mocks.speech.mockRejectedValueOnce(error);
  const { result } = renderHook(() => useTranslatorSpeech('context'));
  await act(async () => { await result.current.play('source', payload); });
  expect(mocks.microsoft).not.toHaveBeenCalled();
  expect(console.error).not.toHaveBeenCalled();
  expect(result.current.state).toEqual({ status: 'idle', key: '', error: '' });
});

it('rejects nonaudio content at the media boundary and only plays the fallback audio', async () => {
  mocks.speech.mockResolvedValueOnce(new Blob(['PRIVATE'], { type: 'application/json' }));
  const { result } = renderHook(() => useTranslatorSpeech('context'));
  await act(async () => { await result.current.play('source', payload); });
  expect(mocks.microsoft).toHaveBeenCalledOnce();
  expect(players).toHaveLength(1);
  expect(result.current.state.provider).toBe('microsoft');
  expect(console.error).toHaveBeenCalledExactlyOnceWith('[翻译] 朗读失败', {
    path: '/api/translate/cdict/tts', httpStatus: null, errorCode: 'INVALID_AUDIO_RESPONSE', requestId: null,
    stage: 'invalid-response', provider: 'cdict',
  });
});

it.each(['stop', 'context', 'unmount'] as const)('cancels a pending fallback on %s and ignores transport responses after abort', async action => {
  const backup = deferred<Blob>();
  mocks.microsoft.mockReturnValueOnce(backup.promise);
  const hook = renderHook(({ context }) => useTranslatorSpeech(context), { initialProps: { context: 'first' } });
  await act(async () => { await hook.result.current.play('source', payload); });
  const firstError = players[0].onerror;
  act(() => firstError?.());
  expect(mocks.microsoft).toHaveBeenCalledOnce();
  const signal = mocks.microsoft.mock.calls[0][1] as AbortSignal;
  expect(signal).toBe(mocks.speech.mock.calls[0][1]);
  expect(signal.aborted).toBe(false);
  expect(hook.result.current.state.provider).toBe('microsoft');
  if (action === 'stop') act(() => hook.result.current.stop());
  else if (action === 'context') hook.rerender({ context: 'second' });
  else hook.unmount();
  expect(signal.aborted).toBe(true);
  expect(players[0].pause).toHaveBeenCalledOnce();
  expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:voice');
  // Old callbacks must neither create another request nor alter the newer generation.
  act(() => firstError?.());
  await act(async () => { backup.resolve(new Blob(['late backup'], { type: 'audio/mpeg' })); });
  expect(players).toHaveLength(1);
  expect(URL.createObjectURL).toHaveBeenCalledOnce();
  expect(mocks.microsoft).toHaveBeenCalledOnce();
  expect(console.error).toHaveBeenCalledOnce();
  if (action !== 'unmount') expect(hook.result.current.state).toEqual({ status: 'idle', key: '', error: '' });
});

it('ignores a failed backup after stop without cancellation logging or restarting playback', async () => {
  const backup = deferred<Blob>();
  mocks.speech.mockRejectedValueOnce({ code: 'ERR_NETWORK' });
  mocks.microsoft.mockReturnValueOnce(backup.promise);
  const { result } = renderHook(() => useTranslatorSpeech('context'));
  let work!: Promise<void>;
  act(() => { work = result.current.play('source', payload); });
  await waitFor(() => expect(mocks.microsoft).toHaveBeenCalledOnce());
  act(() => result.current.stop());
  await act(async () => { backup.reject({ code: 'ERR_CANCELED' }); await work; });
  expect(result.current.state.error).toBe('');
  expect(console.error).toHaveBeenCalledOnce(); // Only the original network failure.
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});

it('does not let a late fallback replace a new successful pronunciation', async () => {
  const backup = deferred<Blob>();
  mocks.speech.mockRejectedValueOnce({ response: { status: 502 } });
  mocks.microsoft.mockReturnValueOnce(backup.promise);
  const { result } = renderHook(() => useTranslatorSpeech('context'));
  let work!: Promise<void>;
  act(() => { work = result.current.play('source', payload); });
  await waitFor(() => expect(mocks.microsoft).toHaveBeenCalledOnce());
  await act(async () => { await result.current.play('target', payload); });
  expect((mocks.microsoft.mock.calls[0][1] as AbortSignal).aborted).toBe(true);
  await act(async () => { backup.resolve(new Blob(['stale'], { type: 'audio/mpeg' })); await work; });
  expect(result.current.state).toEqual({ status: 'playing', key: 'target', error: '', provider: 'cdict' });
  expect(players).toHaveLength(1);
  expect(URL.createObjectURL).toHaveBeenCalledOnce();
});
