import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ notify: vi.fn(), config: vi.fn(), translate: vi.fn(), articles: vi.fn() }));
vi.mock('../hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'user' } }) }));
vi.mock('../components/Notification', () => ({ useNotification: () => ({ setNotification: mocks.notify }) }));
vi.mock('../api/deeplx', () => ({ fetchDeepLXConfig: mocks.config, translateWithDeepLX: mocks.translate }));
vi.mock('../api/markdownArticles', () => ({ markdownArticleApi: { listPublished: mocks.articles } }));

import { DeepLXTranslatorPage } from '../components/DeepLXTranslatorPage';
import ArticleCommandPalette from '../components/ArticleCommandPalette';

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mocks.config.mockResolvedValue({ enabled: true, baseUrl: 'example', endpointPath: '/translate' });
  mocks.articles.mockResolvedValue({ articles: [] });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

async function startManualTranslation() {
  render(<DeepLXTranslatorPage />);
  await screen.findByText('服务可用');
  fireEvent.click(screen.getByRole('checkbox', { name: '自动翻译' }));
  fireEvent.change(screen.getByPlaceholderText('输入想翻译的内容，或者直接把整段文案粘贴进来。'), { target: { value: 'original' } });
  fireEvent.click(screen.getByRole('button', { name: '立即翻译' }));
  await waitFor(() => expect(mocks.translate).toHaveBeenCalledOnce());
}

describe('translation request ownership', () => {
  it('clearing input discards a late result even when the transport ignores abort', async () => {
    let resolve!: (value: unknown) => void;
    mocks.translate.mockReturnValue(new Promise(done => { resolve = done; }));
    await startManualTranslation();
    const signal = mocks.translate.mock.calls[0][1] as AbortSignal;
    fireEvent.click(screen.getByRole('button', { name: '清空' }));
    expect(signal.aborted).toBe(true);
    await act(async () => resolve({ translatedText: 'stale result', alternatives: [], sourceLang: 'ZH', targetLang: 'EN' }));
    expect(screen.queryByText('stale result')).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('synapse_deeplx_history') || '[]')).toEqual([]);
  });

  it('keeps a successful translation usable when history storage is unavailable', async () => {
    mocks.translate.mockResolvedValue({ translatedText: 'translated result', alternatives: [], sourceLang: 'ZH', targetLang: 'EN' });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    await startManualTranslation();
    expect((await screen.findAllByText('translated result')).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: '复制' })).toBeEnabled();
  });
});

it('treats an empty article response as loaded across closing and reopening', async () => {
  render(<MemoryRouter><ArticleCommandPalette /></MemoryRouter>);
  fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
  await screen.findByText('没有匹配的文章。');
  fireEvent.keyDown(window, { key: 'Escape' });
  fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
  await act(async () => {});
  expect(mocks.articles).toHaveBeenCalledOnce();
});
