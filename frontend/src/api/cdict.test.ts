import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('./api', () => ({ api: mocks }));
import { claimCDictDonation, fetchCDictDonation, fetchCDictDonationImage, fetchCDictLanguages, fetchCDictSpeech,
  safeDonationImageUrl, translateWithCDict } from './cdict';

beforeEach(() => { vi.clearAllMocks(); });
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
      expect(mocks.get).toHaveBeenLastCalledWith('/api/translate/cdict/tts', { params: payload, signal, responseType: 'blob' });
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
