import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * P8b 回归：邮件 HTML 预览的隔离方式（RC-34 / D15(a)）。
 *
 * 邮件正文来自外部输入，预览必须是 sandbox iframe + srcDoc：
 * - 不用 dangerouslySetInnerHTML（同源 DOM 注入面）；
 * - sandbox 必须为空串，不给 allow-scripts / allow-same-origin；
 * - 预览仍要渲染邮件自身的样式（内联 style 由浏览器在 iframe 内正常应用）。
 */

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  fetch: vi.fn(),
  notify: vi.fn(),
}));

vi.mock('../api/api', () => ({
  api: { get: mocks.get, post: mocks.post },
  getApiBaseUrl: () => '',
}));
// EmailTraceability 走 `@/api`（src/api/index.ts），与 EmailSender 的 `../api/api` 是两个模块。
vi.mock('@/api', () => ({
  api: { get: mocks.get, post: mocks.post },
  getApiBaseUrl: () => '',
}));
vi.mock('../components/Notification', () => ({
  useNotification: () => ({ setNotification: mocks.notify }),
}));
vi.mock('../components/MarkdownPreview', () => ({ default: () => null }));
vi.mock('../hooks/useAuth', () => ({ useAuth: () => ({ user: null }) }));
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }: { children?: React.ReactNode; to: string }) => (
    <a href={to} {...rest}>{children}</a>
  ),
}));

import EmailSender from '../components/EmailSender';
import EmailTraceability from '../components/EmailTraceability';

const record = {
  _id: 'mail-1',
  to: 'user@example.com',
  subject: '测试邮件',
  content: '<p>hello <strong>world</strong></p>',
  sentAt: '2026-10-17T08:00:00.000Z',
  ip: '203.0.113.10',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/outemail/records/')) {
      return { data: { success: true, record } };
    }
    if (url.startsWith('/api/outemail/records')) {
      return { data: { success: true, records: [record], total: 1, page: 1 } };
    }
    if (url === '/api/outemail/status') return { data: { available: true, domain: 'example.com' } };
    if (url === '/api/outemail/quota') return { data: { success: true, used: 1, total: 10 } };
    if (url === '/api/email/quota') return { data: { used: 3, total: 100 } };
    if (url === '/api/email/domains') return { data: { domains: ['chloemlla.com'] } };
    if (url === '/api/email/status') return { data: { available: true } };
    return { data: { success: true } };
  });
  mocks.post.mockResolvedValue({ data: { success: true } });
  mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ available: true }) });
  vi.stubGlobal('fetch', mocks.fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('P8 email preview isolation', () => {
  it('EmailSender renders the HTML preview as a sandboxed iframe with srcDoc', async () => {
    render(<EmailSender />);
    fireEvent.click(await screen.findByRole('button', { name: '站内发信' }));

    const preview = await screen.findByTitle('邮件 HTML 预览') as HTMLIFrameElement;
    expect(preview.tagName).toBe('IFRAME');
    // 空 sandbox = 不执行脚本、不共享源；任何 allow-* 都会削弱邮件正文的隔离。
    expect(preview.getAttribute('sandbox')).toBe('');
    expect(preview.getAttribute('srcdoc')).toContain('Hello World');
  });

  it('EmailSender template previews use the same sandboxed iframe contract', async () => {
    render(<EmailSender />);
    fireEvent.click(await screen.findByRole('button', { name: '模板与说明' }));

    const frames = await screen.findAllByTitle(/模板预览：/);
    expect(frames).toHaveLength(4);
    for (const frame of frames) {
      expect(frame.tagName).toBe('IFRAME');
      expect(frame.getAttribute('sandbox')).toBe('');
      expect(frame.getAttribute('srcdoc')).toMatch(/<div/);
    }
  });

  it('EmailTraceability detail view keeps the same sandbox policy', async () => {
    render(<EmailTraceability />);
    fireEvent.click(await screen.findByRole('button', { name: /查看详情/ }));

    fireEvent.click(await screen.findByRole('button', { name: 'HTML' }));
    const preview = await screen.findByTitle('邮件 HTML 预览') as HTMLIFrameElement;
    expect(preview.tagName).toBe('IFRAME');
    expect(preview.getAttribute('sandbox')).toBe('');
    expect(preview.getAttribute('srcdoc')).toBe(record.content);
  });
});
