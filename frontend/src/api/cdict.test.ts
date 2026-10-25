import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('./api', () => ({ api: mocks }));
import { claimCDictDonation, fetchCDictDonation, fetchCDictDonationImage, fetchCDictLanguages, fetchCDictSpeech, fetchMicrosoftTranslatorSpeech,
  safeDonationImageUrl, translateWithCDict } from './cdict';

beforeEach(() => { vi.resetAllMocks(); vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); });
describe('CDict website APIs use the authenticated singleton', () => {
  it('posts only business translation fields to the website namespace and normalizes the response', async () => {
    const payload = { text: 'Hello', from: 'auto', to: 'zh-CHS' };
    const signal = new AbortController().signal;
    mocks.post.mockResolvedValue({ data: { success: true, code: 0, data: { translation: '你好', from: 'en', to: 'zh-CHS' } } });
    expect(await translateWithCDict(payload, signal)).toMatchObject({ translatedText: '你好', sourceLang: 'en' });
    expect(mocks.post).toHaveBeenCalledWith('/api/translate/cdict/translate', payload, { signal });
  });
  it('uses the languages endpoint with cancellation and rejects logical HTTP 200 failures', async () => {
    const signal = new AbortController().signal;
    mocks.get.mockResolvedValue({ data: { data: { list: ['en', 'zh-CHS'] } } });
    expect(await fetchCDictLanguages(signal)).toHaveLength(2);
    expect(mocks.get).toHaveBeenCalledWith('/api/translate/cdict/languages', { signal });
    mocks.post.mockResolvedValue({ data: { code: 7, data: { translation: 'bad' } } });
    await expect(translateWithCDict({ text: 'hello', from: 'en', to: 'zh-CHS' })).rejects.toThrow();
  });
  it('retrieves engine and dictionary audio as blobs without vendor headers or direct media URLs', async () => {
    const blob = new Blob(['audio'], { type: 'audio/wav' });
    mocks.get.mockResolvedValue({ data: blob });
    const signal = new AbortController().signal;
    for (const payload of [{ text: 'hello', source: 'engine' as const, langType: 'en-USA' }, { text: 'hello', source: 'youdao' as const, type: 1 as const }]) {
      expect(await fetchCDictSpeech(payload, signal)).toBe(blob);
      expect(mocks.get).toHaveBeenLastCalledWith('/api/translate/cdict/tts', { params: payload, signal, responseType: 'blob', timeout: 60000 });
    }
  });
  it('rejects oversized speech before IO and does not treat JSON error bytes as audio', async () => {
    await expect(fetchCDictSpeech({ text: 'x'.repeat(301), source: 'engine' })).rejects.toThrow('300');
    expect(mocks.get).not.toHaveBeenCalled();
    mocks.get.mockResolvedValue({ data: new Blob(['{"error":"no"}'], { type: 'application/json' }) });
    await expect(fetchCDictSpeech({ text: 'hello', source: 'engine' })).rejects.toThrow();
  });
  it('handles disabled donation quietly and filters unsafe channel IDs and image URLs', async () => {
    mocks.get.mockRejectedValueOnce({ response: { status: 404 } });
    expect(await fetchCDictDonation()).toBeNull();
    mocks.get.mockResolvedValue({ data: { success: true, channels: [{ id: 'wechat', name: '微信', hint: '扫一扫' }, { id: '../escape' }], supporters: ['张同学'] } });
    expect(await fetchCDictDonation()).toMatchObject({ channels: [{ id: 'wechat', name: '微信', hint: '扫一扫' }], supporters: ['张同学'] });
    await expect(fetchCDictDonationImage('../escape')).rejects.toThrow();
  });
  it('fetches bundled images with session authentication and rejects nonimage content', async () => {
    const blob = new Blob(['png'], { type: 'image/png' });
    const signal = new AbortController().signal;
    mocks.get.mockResolvedValue({ data: blob });
    expect(await fetchCDictDonationImage('wechat', signal)).toEqual({ kind: 'blob', blob });
    expect(mocks.get).toHaveBeenCalledWith('/api/translate/cdict/donate/wechat', { signal, responseType: 'blob' });
    mocks.get.mockResolvedValue({ data: new Blob(['<svg/>'], { type: 'image/svg+xml' }) });
    await expect(fetchCDictDonationImage('wechat')).rejects.toThrow();
  });
  it('reads authenticated external image metadata without sending the singleton to the image host', async () => {
    mocks.get.mockResolvedValue({ data: new Blob([JSON.stringify({ success: true, imageUrl: 'https://images.example.org/code.png' })], { type: 'application/json' }) });
    expect(await fetchCDictDonationImage('wechat')).toEqual({ kind: 'remote', url: 'https://images.example.org/code.png' });
    expect(mocks.get).toHaveBeenCalledOnce();
    expect(mocks.get.mock.calls[0][0]).toBe('/api/translate/cdict/donate/wechat');
  });
  it.each(['javascript:alert(1)', 'http://images.example.org/a.png', 'https://name:password@images.example.org/a.png', 'https://127.0.0.1/a.png', 'https://localhost/a.png'])('rejects unsafe external image URLs: %s', url => {
    expect(() => safeDonationImageUrl(url)).toThrow();
  });
  it('posts validated claims and preserves duplicate acknowledgement', async () => {
    const signal = new AbortController().signal;
    mocks.post.mockResolvedValue({ data: { success: true, duplicated: true, message: '正在核实' } });
    expect(await claimCDictDonation({ transactionId: ' 123456 ', displayName: ' 同学 ' }, signal)).toEqual({ duplicated: true, message: '正在核实' });
    expect(mocks.post).toHaveBeenCalledWith('/api/translate/cdict/donate/claim', { transactionId: '123456', displayName: '同学' }, { signal });
    await expect(claimCDictDonation({ transactionId: 'bad', displayName: '同学' })).rejects.toThrow();
    await expect(claimCDictDonation({ transactionId: '123456', displayName: 'x'.repeat(33) })).rejects.toThrow();
    expect(mocks.post).toHaveBeenCalledOnce();
  });
});

describe('short Microsoft speech uses the website API, not generation jobs', () => {
  it.each([
    [{ text: 'hello', source: 'engine' as const, langType: 'en-GBR' }, 'en-GBR'],
    [{ text: 'hello', source: 'engine' as const, langType: 'en-USA' }, 'en-USA'],
    [{ text: '你好', source: 'engine' as const, langType: 'zh-CHS' }, 'zh-CHS'],
    [{ text: 'bonjour', source: 'engine' as const, langType: 'fr' }, 'fr'],
    [{ text: 'hello', source: 'youdao' as const, type: 1 as const }, 'en-GBR'],
    [{ text: 'hello', source: 'youdao' as const, type: 2 as const }, 'en-USA'],
  ] as const)('maps the original speech language/voice without vendor fields: %j', async (payload, langType) => {
    const blob = new Blob(['mp3'], { type: 'audio/mpeg' });
    const signal = new AbortController().signal;
    mocks.get.mockResolvedValue({ data: blob });
    expect(await fetchMicrosoftTranslatorSpeech(payload, signal)).toBe(blob);
    expect(mocks.get).toHaveBeenCalledExactlyOnceWith('/api/translate/cdict/tts', {
      params: { source: 'microsoft', text: payload.text, langType }, signal, responseType: 'blob', timeout: 60000,
    });
  });
  it('validates both sources at the 300 character boundary without truncation', async () => {
    mocks.get.mockResolvedValue({ data: new Blob(['audio'], { type: 'audio/wav' }) });
    for (const fetchSpeech of [fetchCDictSpeech, fetchMicrosoftTranslatorSpeech]) {
      await expect(fetchSpeech({ text: 'x'.repeat(301), source: 'engine', langType: 'en-USA' })).rejects.toThrow('300');
      await expect(fetchSpeech({ text: '   ', source: 'engine', langType: 'en-USA' })).rejects.toThrow('300');
    }
    expect(mocks.get).not.toHaveBeenCalled();
    for (const fetchSpeech of [fetchCDictSpeech, fetchMicrosoftTranslatorSpeech]) {
      await fetchSpeech({ text: `  ${'x'.repeat(300)}  `, source: 'engine', langType: 'en-USA' });
      expect(mocks.get.mock.lastCall![1].params.text).toBe('x'.repeat(300));
    }
    expect(mocks.get).toHaveBeenCalledTimes(2);
  });
  it('does not silently default a missing or automatic engine language to Chinese', async () => {
    for (const langType of [undefined, '', 'auto']) {
      await expect(fetchMicrosoftTranslatorSpeech({ text: 'hello', source: 'engine', langType })).rejects.toThrow('语言');
    }
    expect(mocks.get).not.toHaveBeenCalled();
  });
  it.each([new Blob([], { type: 'audio/wav' }), new Blob(['secret'], { type: 'application/json' })])(
    'rejects invalid Microsoft audio without reading error bytes', async blob => {
      const text = vi.fn(); Object.defineProperty(blob, 'text', { value: text });
      mocks.get.mockResolvedValue({ data: blob, status: 200, headers: { 'x-request-id': 'speech-req' } });
      await expect(fetchMicrosoftTranslatorSpeech({ text: 'private spoken text', source: 'engine', langType: 'en-USA' }))
        .rejects.toMatchObject({ code: 'INVALID_AUDIO_RESPONSE', httpStatus: 200, requestId: 'speech-req' });
      expect(text).not.toHaveBeenCalled();
    });
  it('honors an aborted signal even when a speech transport returns audio', async () => {
    const request = new AbortController(); request.abort();
    mocks.get.mockResolvedValue({ data: new Blob(['audio'], { type: 'audio/wav' }) });
    for (const fetchSpeech of [fetchCDictSpeech, fetchMicrosoftTranslatorSpeech]) {
      await expect(fetchSpeech({ text: 'hello', source: 'engine', langType: 'en-USA' }, request.signal))
        .rejects.toMatchObject({ name: 'AbortError' });
    }
  });
});

describe('language failures have safe API boundary diagnostics', () => {
  it('logs only fixed context for HTTP failure, never Axios or user/credential data', async () => {
    const error = { code: 'ERR_BAD_RESPONSE', message: 'token=SECRET', config: { headers: { Authorization: 'SECRET' } },
      response: { status: 502, headers: { 'x-request-id': 'languages-req', 'set-cookie': 'SECRET' },
        data: { code: 502, error: 'private text SECRET', credentials: 'SECRET' } } };
    mocks.get.mockRejectedValue(error);
    await expect(fetchCDictLanguages()).rejects.toBe(error);
    expect(console.error).toHaveBeenCalledExactlyOnceWith('[翻译] 语言列表读取失败', {
      path: '/api/translate/cdict/languages', httpStatus: 502, errorCode: 502, requestId: 'languages-req', stage: 'http',
    });
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('SECRET');
  });
  it.each([
    [{ success: false, code: 10000, data: null }, 10000],
    [{ retcode: '7', data: null }, 7],
    [{ code: 0, retcode: -1, data: null }, -1],
    [{ success: true, code: 0, data: null }, 0],
    [{ data: { list: [] } }, null],
    [null, null],
  ] as const)('logs HTTP 200 business/empty collection failures as invalid-response: %j', async (data, errorCode) => {
    mocks.get.mockResolvedValue({ data, status: 200, headers: { 'x-request-id': 'empty-req' } });
    await expect(fetchCDictLanguages()).rejects.toThrow();
    expect(console.error).toHaveBeenCalledExactlyOnceWith('[翻译] 语言列表读取失败', {
      path: '/api/translate/cdict/languages', httpStatus: 200, errorCode, requestId: 'empty-req', stage: 'invalid-response',
    });
  });
  it('drops unrecognized codes, unbounded numbers and unsafe request IDs', async () => {
    mocks.get.mockRejectedValue({ code: 'private-text', message: 'SECRET', response: { status: '502',
      data: { code: 1000000, retcode: 'token=SECRET' }, headers: { 'x-request-id': 'SECRET\nAuthorization' } } });
    await expect(fetchCDictLanguages()).rejects.toBeDefined();
    expect(console.error).toHaveBeenCalledExactlyOnceWith('[翻译] 语言列表读取失败', {
      path: '/api/translate/cdict/languages', httpStatus: null, errorCode: null, requestId: null, stage: 'http',
    });
  });
  it('keeps a controlled network error code and logs no arbitrary error message', async () => {
    mocks.get.mockRejectedValue({ code: 'ERR_NETWORK', message: 'private input' });
    await expect(fetchCDictLanguages()).rejects.toBeDefined();
    expect(console.error).toHaveBeenCalledExactlyOnceWith('[翻译] 语言列表读取失败', {
      path: '/api/translate/cdict/languages', httpStatus: null, errorCode: 'ERR_NETWORK', requestId: null, stage: 'http',
    });
  });
  it.each([{ code: 'ERR_CANCELED' }, new DOMException('private input', 'AbortError')])('does not log cancellation: %j', async error => {
    mocks.get.mockRejectedValue(error);
    await expect(fetchCDictLanguages()).rejects.toBe(error);
    expect(console.error).not.toHaveBeenCalled();
  });
  it('does not log aborted responses or unrelated late transport errors', async () => {
    const request = new AbortController(); request.abort();
    mocks.get.mockResolvedValueOnce({ status: 200, data: null });
    await expect(fetchCDictLanguages(request.signal)).rejects.toMatchObject({ name: 'AbortError' });
    mocks.get.mockRejectedValueOnce(new Error('offline'));
    await expect(fetchCDictLanguages(request.signal)).rejects.toThrow('offline');
    expect(console.error).not.toHaveBeenCalled();
  });
});
