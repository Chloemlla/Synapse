import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ config: vi.fn(), deeplx: vi.fn(), languages: vi.fn(), cdict: vi.fn(), speech: vi.fn(), donation: vi.fn(), notify: vi.fn(), user: { id: 'user', isTranslationEnabled: true } }));
vi.mock('../../hooks/useAuth', () => ({ useAuth: () => ({ user: mocks.user }) }));
vi.mock('../Notification', () => ({ useNotification: () => ({ setNotification: mocks.notify }) }));
vi.mock('../../api/deeplx', () => ({ fetchDeepLXConfig: mocks.config, translateWithDeepLX: mocks.deeplx }));
vi.mock('../../api/cdict', () => ({ fetchCDictLanguages: mocks.languages, translateWithCDict: mocks.cdict, fetchCDictSpeech: mocks.speech,
  fetchCDictDonation: mocks.donation, fetchCDictDonationImage: vi.fn(), claimCDictDonation: vi.fn() }));
import { DeepLXTranslatorPage } from '../DeepLXTranslatorPage';

const translated = { translatedText: 'target result', sourceLang: 'en', targetLang: 'en', alternatives: [], dictionary: ['释义'], phonetic: '/test/' };
const players: Array<{ pause: ReturnType<typeof vi.fn> }> = [];
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); players.length = 0; mocks.user.isTranslationEnabled = true;
  mocks.config.mockResolvedValue({ enabled: false });
  mocks.languages.mockResolvedValue([{ code: 'en', label: '英语' }, { code: 'zh-CHS', label: '中文（简体）' }, { code: 'hi', label: '印地语' }]);
  mocks.cdict.mockResolvedValue(translated); mocks.donation.mockResolvedValue(null);
  mocks.speech.mockResolvedValue(new Blob(['wav'], { type: 'audio/wav' }));
  vi.stubGlobal('Audio', class {
    onended = null; onerror = null; play = vi.fn().mockResolvedValue(undefined); pause = vi.fn(); removeAttribute = vi.fn(); load = vi.fn();
    constructor() { players.push(this); }
  });
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:test-voice') });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });
async function setupManual() {
  render(<DeepLXTranslatorPage />);
  await waitFor(() => expect(mocks.languages).toHaveBeenCalledOnce());
  await act(async () => {});
  fireEvent.click(screen.getByRole('checkbox', { name: '自动翻译' }));
  fireEvent.change(screen.getByRole('textbox', { name: '待翻译文本' }), { target: { value: 'hello' } });
}
describe('CDict translator interface', () => {
  it('works independently of disabled DeepLX, showing metadata and source/target pronunciation', async () => {
    await setupManual();
    expect(screen.getByRole('combobox', { name: '翻译服务' })).toHaveValue('cdict');
    fireEvent.click(screen.getByRole('button', { name: '立即翻译' }));
    await screen.findByLabelText('翻译结果');
    expect(mocks.cdict).toHaveBeenCalledWith({ text: 'hello', from: 'auto', to: 'en' }, expect.any(AbortSignal));
    expect(screen.getByLabelText('音标')).toHaveTextContent('/test/');
    expect(screen.getByRole('region', { name: '词典释义' })).toHaveTextContent('释义');
    expect(screen.getByRole('button', { name: '朗读原文' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '朗读译文' })).toBeEnabled();
    await waitFor(() => expect(JSON.parse(localStorage.getItem('synapse_deeplx_history') || '[]')[0]?.provider).toBe('cdict'));
  });
  it('converts language codes when switching providers and preserves text', async () => {
    mocks.config.mockResolvedValue({ enabled: true });
    mocks.deeplx.mockResolvedValue({ success: true, translatedText: 'DeepLX result', sourceLang: 'ZH', targetLang: 'EN', alternatives: [] });
    await setupManual();
    fireEvent.change(screen.getByRole('combobox', { name: '原文语言' }), { target: { value: 'zh-CHS' } });
    fireEvent.change(screen.getByRole('combobox', { name: '翻译服务' }), { target: { value: 'deeplx' } });
    expect(screen.getByRole('combobox', { name: '原文语言' })).toHaveValue('ZH');
    expect(screen.getByRole('combobox', { name: '译文语言' })).toHaveValue('EN');
    expect(screen.getByRole('textbox', { name: '待翻译文本' })).toHaveValue('hello');
    fireEvent.click(screen.getByRole('button', { name: '立即翻译' }));
    await waitFor(() => expect(mocks.deeplx).toHaveBeenCalledWith({ text: 'hello', sourceLang: 'ZH', targetLang: 'EN' }, expect.any(AbortSignal)));
    fireEvent.change(screen.getByRole('combobox', { name: '翻译服务' }), { target: { value: 'cdict' } });
    expect(screen.getByRole('combobox', { name: '原文语言' })).toHaveValue('zh-CHS');
    expect(screen.getByRole('combobox', { name: '译文语言' })).toHaveValue('en');
  });
  it('uses Ctrl/Command+Enter and discards stale translation after language changes', async () => {
    let resolve!: (value: typeof translated) => void;
    mocks.cdict.mockReturnValue(new Promise(done => { resolve = done; }));
    await setupManual();
    fireEvent.keyDown(screen.getByRole('textbox', { name: '待翻译文本' }), { key: 'Enter', metaKey: true });
    await waitFor(() => expect(mocks.cdict).toHaveBeenCalledOnce());
    const signal = mocks.cdict.mock.calls[0][1] as AbortSignal;
    fireEvent.change(screen.getByRole('combobox', { name: '译文语言' }), { target: { value: 'zh-CHS' } });
    expect(signal.aborted).toBe(true);
    await act(async () => resolve(translated));
    expect(screen.queryByLabelText('翻译结果')).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('synapse_deeplx_history')!)).toEqual([]);
  });
  it('loads a dynamic language list, shows fallback errors, and retries without blocking CDict', async () => {
    mocks.languages.mockRejectedValueOnce(new Error('offline'));
    render(<DeepLXTranslatorPage />);
    await screen.findByText(/语言列表读取失败/);
    expect(screen.getByRole('combobox', { name: '译文语言' })).toHaveValue('en');
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(mocks.languages).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText(/语言列表读取失败/)).not.toBeInTheDocument());
    fireEvent.change(screen.getByRole('combobox', { name: '译文语言' }), { target: { value: 'hi' } });
    expect(screen.getByRole('combobox', { name: '译文语言' })).toHaveValue('hi');
  });
  it('selects UK/US dictionary pronunciation on either side and stops when input changes', async () => {
    await setupManual();
    fireEvent.click(screen.getByRole('button', { name: '立即翻译' }));
    await screen.findByLabelText('翻译结果');
    fireEvent.change(screen.getByRole('combobox', { name: '原文发音方式' }), { target: { value: 'uk' } });
    fireEvent.click(screen.getByRole('button', { name: '朗读原文' }));
    await waitFor(() => expect(mocks.speech).toHaveBeenLastCalledWith({ text: 'hello', source: 'youdao', type: 1 }, expect.any(AbortSignal)));
    await waitFor(() => expect(players).toHaveLength(1));
    fireEvent.change(screen.getByRole('combobox', { name: '译文发音方式' }), { target: { value: 'us' } });
    fireEvent.click(screen.getByRole('button', { name: '朗读译文' }));
    await waitFor(() => expect(mocks.speech).toHaveBeenLastCalledWith({ text: 'target result', source: 'youdao', type: 2 }, expect.any(AbortSignal)));
    await waitFor(() => expect(players).toHaveLength(2));
    expect(players[0].pause).toHaveBeenCalled();
    fireEvent.change(screen.getByRole('textbox', { name: '待翻译文本' }), { target: { value: 'new text' } });
    expect(players[1].pause).toHaveBeenCalled();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
  });
  it('offers both engine accents on both text panels as well as dictionary voices', async () => {
    await setupManual();
    fireEvent.click(screen.getByRole('button', { name: '立即翻译' }));
    await screen.findByLabelText('翻译结果');
    for (const [side, text] of [['原文', 'hello'], ['译文', 'target result']]) {
      fireEvent.change(screen.getByRole('combobox', { name: `${side}发音方式` }), { target: { value: 'engine-uk' } });
      fireEvent.click(screen.getByRole('button', { name: `朗读${side}` }));
      await waitFor(() => expect(mocks.speech).toHaveBeenLastCalledWith({ text, source: 'engine', langType: 'en-GBR' }, expect.any(AbortSignal)));
      await screen.findByRole('button', { name: `停止${side}朗读` });
      fireEvent.change(screen.getByRole('combobox', { name: `${side}发音方式` }), { target: { value: 'engine' } });
      fireEvent.click(screen.getByRole('button', { name: `朗读${side}` }));
      await waitFor(() => expect(mocks.speech).toHaveBeenLastCalledWith({ text, source: 'engine', langType: 'en-USA' }, expect.any(AbortSignal)));
    }
  });
  it('debounces automatic translation and does not request speech for more than 300 characters', async () => {
    render(<DeepLXTranslatorPage />);
    await act(async () => {});
    vi.useFakeTimers();
    fireEvent.change(screen.getByRole('textbox', { name: '待翻译文本' }), { target: { value: 'hello' } });
    await act(async () => vi.advanceTimersByTime(549));
    expect(mocks.cdict).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(1));
    expect(mocks.cdict).toHaveBeenCalledOnce();
    vi.useRealTimers();
    fireEvent.change(screen.getByRole('textbox', { name: '待翻译文本' }), { target: { value: 'x'.repeat(301) } });
    fireEvent.change(screen.getByRole('combobox', { name: '原文语言' }), { target: { value: 'en' } });
    expect(screen.getByRole('button', { name: '朗读原文' })).toBeDisabled();
    expect(screen.getByText(/不会截取内容/)).toBeInTheDocument();
    expect(mocks.speech).not.toHaveBeenCalled();
  });
  it('preserves legacy DeepLX history and switches back to that provider on restore', async () => {
    localStorage.setItem('synapse_deeplx_history', JSON.stringify([{ id: 'old', sourceText: 'old source', translatedText: 'old target', sourceLang: 'ZH', targetLang: 'EN', createdAt: 'today' }]));
    await setupManual();
    fireEvent.click(screen.getByRole('button', { name: /DeepLX.*old source.*old target/ }));
    expect(screen.getByRole('combobox', { name: '翻译服务' })).toHaveValue('deeplx');
    expect(screen.getByRole('textbox', { name: '待翻译文本' })).toHaveValue('old source');
    expect(screen.getByLabelText('翻译结果')).toHaveTextContent('old target');
  });
  it('does not start protected API work for an account without translation permission', async () => {
    mocks.user.isTranslationEnabled = false;
    render(<DeepLXTranslatorPage />);
    expect(screen.getByRole('alert')).toHaveTextContent('未开放翻译功能');
    expect(mocks.languages).not.toHaveBeenCalled();
    expect(mocks.config).not.toHaveBeenCalled();
  });
});

it('keeps paste, copy, and detected-language swapping usable', async () => {
  const readText = vi.fn().mockResolvedValue('clipboard text');
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText, writeText } });
  mocks.cdict.mockResolvedValue({ ...translated, sourceLang: 'zh-CHS', targetLang: 'en' });
  await setupManual();
  fireEvent.click(screen.getByRole('button', { name: '粘贴' }));
  await waitFor(() => expect(screen.getByRole('textbox', { name: '待翻译文本' })).toHaveValue('clipboard text'));
  fireEvent.click(screen.getByRole('button', { name: '立即翻译' }));
  await screen.findByLabelText('翻译结果');
  fireEvent.click(screen.getByRole('button', { name: '复制' }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith('target result'));
  fireEvent.click(screen.getByRole('button', { name: '交换语言' }));
  expect(screen.getByRole('combobox', { name: '原文语言' })).toHaveValue('en');
  expect(screen.getByRole('combobox', { name: '译文语言' })).toHaveValue('zh-CHS');
  expect(screen.getByRole('textbox', { name: '待翻译文本' })).toHaveValue('target result');
  expect(screen.getByLabelText('翻译结果')).toHaveTextContent('clipboard text');
});
