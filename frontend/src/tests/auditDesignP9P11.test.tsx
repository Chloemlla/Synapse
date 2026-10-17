import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// FD-071：重依赖必须走动态 import；这里给出的替身同时验证「运行时确实会异步加载」。
vi.mock('../utils/codeHighlight', () => ({
  resolveCodeLanguage: (language: string) => (language ? 'text' : null),
  CodeHighlighter: ({ children }: { children?: React.ReactNode }) => (
    <span data-testid="lazy-code-highlighter">{children}</span>
  ),
}));

import MarkdownRenderer from '../components/MarkdownRenderer';
import PixelNoticeDialog from '../components/pixel/PixelNoticeDialog';

const source = (...segments: string[]) =>
  fs.readFileSync(path.join(__dirname, '..', ...segments), 'utf8');

afterEach(cleanup);

describe('P9/P11 重依赖懒加载（FD-071）', () => {
  it('MarkdownRenderer 异步加载代码高亮器，而不是静态引入', async () => {
    render(<MarkdownRenderer content={'```ts\nconst answer = 42;\n```'} />);

    // 高亮器模块到达前先渲染等宽纯文本，保证内容立即可读。
    expect(screen.getByText('const answer = 42;')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('lazy-code-highlighter')).toBeInTheDocument());

    const markdownSource = source('components', 'MarkdownRenderer.tsx');
    expect(markdownSource).not.toMatch(/from ['"]\.\.\/utils\/codeHighlight['"]/);
    expect(markdownSource).not.toMatch(/from ['"]react-syntax-highlighter/);
    expect(markdownSource).toContain("import('../utils/codeHighlight')");
  });

  it('ArtifactSharePage 与 GeoGebraEditor 也不再静态引入重依赖', () => {
    const artifactSource = source('components', 'ArtifactSharePage.tsx');
    expect(artifactSource).not.toMatch(/from ['"]\.\.\/utils\/codeHighlight['"]/);
    expect(artifactSource).toContain("import('../utils/codeHighlight')");

    const editorSource = source('components', 'geogebra', 'GeoGebraEditor.tsx');
    expect(editorSource).not.toMatch(/^import\s+\*\s+as\s+monaco/m);
    expect(editorSource).not.toMatch(/^import\s+editorWorker/m);
    expect(editorSource).toContain('import("monaco-editor/editor/editor.api.js")');
    expect(editorSource).toContain('import("monaco-editor/editor/editor.worker?worker")');
  });
});

describe('P11 Pixel 操作提示弹窗（FD-037：走 StudioModal）', () => {
  it('Escape 关闭、确认前禁用、确认后回调', () => {
    const onClose = vi.fn();
    const onAcknowledge = vi.fn();
    render(<PixelNoticeDialog open onClose={onClose} onAcknowledge={onAcknowledge} />);

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    const confirm = screen.getByRole('button', { name: '开始使用' });
    expect(confirm).toBeDisabled();

    fireEvent.click(screen.getAllByRole('checkbox')[0]);
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    expect(onAcknowledge).toHaveBeenCalledTimes(1);
  });

  it('Tab 在弹窗内循环（focus trap）', async () => {
    render(<PixelNoticeDialog open onClose={() => undefined} onAcknowledge={() => undefined} />);

    const dialog = screen.getByRole('dialog');
    const checkboxes = screen.getAllByRole('checkbox');
    const confirm = screen.getByRole('button', { name: '开始使用' });

    // 从最后一个可聚焦元素按 Tab，焦点应回到弹窗内第一个元素（不逃到页面背景）。
    confirm.focus();
    fireEvent.keyDown(confirm, { key: 'Tab' });
    expect(document.activeElement).toBe(checkboxes[0]);
    expect(dialog.contains(document.activeElement)).toBe(true);
  });
});

describe('P12 demo 页 reduced motion（FD-068）', () => {
  it.each([
    ['MeditationAppDemo.tsx'],
    ['MusicPlayerDemo.tsx'],
    ['XiaohongshuDemo.tsx'],
    ['TamperDetectionDemo.tsx'],
  ])('%s 的循环/入场动画在 reduced motion 下停用', (file) => {
    const demoSource = source('components', file);
    expect(demoSource).toContain('motion-reduce:animate-none');
  });
});
