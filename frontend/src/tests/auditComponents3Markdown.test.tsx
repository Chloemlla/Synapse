import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn(), update: vi.fn(), confirm: vi.fn(), notify: vi.fn() }));
vi.mock('../hooks/useAuth', () => ({ useAuth: () => ({ user: { role: 'superadmin' } }) }));
vi.mock('../components/Notification', () => ({ useNotification: () => ({ setNotification: h.notify }) }));
vi.mock('../components/confirm/ConfirmDialogProvider', () => ({ useConfirm: () => h.confirm }));
vi.mock('../api/markdownArticles', () => ({ markdownArticleApi: { listAdmin: h.list, getAdmin: h.get, update: h.update } }));
vi.mock('../components/Mermaid', () => ({ default: () => <div>diagram</div> }));
vi.mock('../utils/codeHighlight', () => ({ resolveCodeLanguage: () => null, CodeHighlighter: () => null }));

import MarkdownRenderer from '../components/MarkdownRenderer';
import MarkdownArticleManager from '../components/MarkdownArticleManager';

const article = (id: string) => ({ id, title: `Article ${id}`, slug: id, content: `Body ${id}`, excerpt: '', status: 'draft' as const });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  h.list.mockResolvedValue({ articles: [article('a'), article('b')] });
  h.get.mockImplementation(async (id: string) => ({ article: article(id) }));
  h.confirm.mockResolvedValue(false);
});
afterEach(cleanup);

describe('audit markdown rendering and editor state', () => {
  it('keeps inline code inside its paragraph and gives only fenced code a toolbar', () => {
    const { container } = render(<MarkdownRenderer content={'Hello `inline` world.\n\n```text\nblock\n```'} />);
    expect(container.querySelector('p code')).toHaveTextContent('inline');
    expect(container.querySelector('p [data-markdown-code]')).toBeNull();
    expect(container.querySelectorAll('[data-markdown-code]')).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: /Copy .* code/ })).toHaveLength(1);
  });

  it('keeps an edited article when switching is cancelled', async () => {
    render(<MarkdownArticleManager />);
    fireEvent.click(await screen.findByRole('button', { name: /Article a/ }));
    await screen.findByDisplayValue('Body a');
    fireEvent.change(screen.getByPlaceholderText('输入文章标题'), { target: { value: 'Unsaved title' } });
    fireEvent.click(screen.getByRole('button', { name: /Article b/ }));
    await waitFor(() => expect(h.confirm).toHaveBeenCalledTimes(1));
    expect(screen.getByDisplayValue('Unsaved title')).toBeInTheDocument();
    expect(h.get).not.toHaveBeenCalledWith('b');
  });

  it('ignores an older article response after a later selection completes', async () => {
    const first = deferred<{ article: ReturnType<typeof article> }>();
    h.get.mockImplementation((id: string) => id === 'a' ? first.promise : Promise.resolve({ article: article(id) }));
    render(<MarkdownArticleManager />);
    fireEvent.click(await screen.findByRole('button', { name: /Article a/ }));
    fireEvent.click(screen.getByRole('button', { name: /Article b/ }));
    await screen.findByDisplayValue('Body b');
    await act(async () => { first.resolve({ article: article('a') }); });
    expect(screen.getByDisplayValue('Body b')).toBeInTheDocument();
  });

  it('prevents stacked keyboard saves and editing or switching while saving', async () => {
    const save = deferred<{ article: ReturnType<typeof article> }>();
    h.update.mockReturnValue(save.promise);
    render(<MarkdownArticleManager />);
    fireEvent.click(await screen.findByRole('button', { name: /Article a/ }));
    await screen.findByDisplayValue('Body a');
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    expect(h.update).toHaveBeenCalledTimes(1);
    expect(screen.getByPlaceholderText('输入文章标题')).toBeDisabled();
    expect(screen.getByRole('button', { name: /Article b/ })).toBeDisabled();
    await act(async () => { save.resolve({ article: article('a') }); });
    await waitFor(() => expect(screen.getByPlaceholderText('输入文章标题')).toBeEnabled());
  });
});
