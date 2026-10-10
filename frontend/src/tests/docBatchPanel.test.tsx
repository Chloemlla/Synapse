// DocBatchPanel 的行为测试：文件列表徽章、冲突策略切换、进度轮询与失败重试。
//
// 只验证与后端契约挂钩的交互；网络层整体 mock 掉（本机不真发请求）。

import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocFileEntry, DocJobRecord } from '../api/docTool';

const api = vi.hoisted(() => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  listFiles: vi.fn(),
  uploadFiles: vi.fn(),
  createJob: vi.fn(),
  getJob: vi.fn(),
  cancelJob: vi.fn(),
  fetchReport: vi.fn(),
  downloadReport: vi.fn(),
  downloadBundle: vi.fn(),
  downloadFile: vi.fn(),
  downloadExistingBundle: vi.fn(),
  createTemplate: vi.fn(),
}));

vi.mock('../api/docTool', () => ({
  docToolApi: api,
  DEFAULT_DOC_PREFS: { conflict: 'rename', outMode: 'custom', outDir: 'out', recursive: true, referenceDoc: '' },
  CONFLICT_MODES: ['skip', 'rename', 'overwrite'],
  OUT_MODES: ['alongside', 'custom'],
}));

import DocBatchPanel from '../components/docTool/DocBatchPanel';

const SETTINGS = {
  pandoc: { available: true, version: 'pandoc 3.12.1', bin: 'pandoc' },
  limits: {
    maxUploadBytes: 64 * 1024 * 1024,
    maxFileBytes: 8 * 1024 * 1024,
    maxFilesPerJob: 300,
    maxActiveJobs: 3,
    retentionDays: 7,
  },
  prefs: { conflict: 'rename', outMode: 'custom', outDir: 'out', recursive: true, referenceDoc: '' },
  templates: [],
};

const FILES: DocFileEntry[] = [
  { rel: 'a.md', sizeBytes: 1024, mtime: 1_700_000_000_000, destRel: 'out/a.docx', status: 'new', willRename: false },
  {
    rel: 'notes/b.md',
    sizeBytes: 2048,
    mtime: 1_700_000_100_000,
    destRel: 'out/notes/b.docx',
    status: 'stale',
    willRename: false,
  },
  {
    rel: 'c.md',
    sizeBytes: 512,
    mtime: 1_700_000_200_000,
    destRel: 'out/c (2).docx',
    status: 'new',
    willRename: true,
    // 磁盘上已有产物（旧名字）：重命名模式下 destRel 指向新名字，existingRel 才是能直接下载的那份
    existingRel: 'out/c.docx',
  },
  {
    rel: 'done.md',
    sizeBytes: 300,
    mtime: 1_700_000_300_000,
    destRel: 'out/done.docx',
    status: 'fresh',
    willRename: false,
  },
];

const jobBase = {
  userId: 'user-1',
  createdBy: 'tester',
  createdAt: '2026-10-10T00:00:00.000Z',
  input: { files: ['a.md', 'report.md'], outMode: 'custom' as const, outDir: 'out', conflict: 'rename' as const, referenceDoc: '' },
  logs: [],
  cancelRequested: false,
};

const RUNNING_JOB: DocJobRecord = {
  ...jobBase,
  id: 'job-1',
  status: 'running',
  stage: '正在转换 report.md',
  progress: 50,
  total: 2,
  done: 1,
  ok: 1,
  skipped: 0,
  failed: 0,
  items: [{ rel: 'a.md', destRel: 'out/a (2).docx', status: 'ok', sizeBytes: 4096, ms: 1200, renamed: true }],
};

const FINISHED_JOB: DocJobRecord = {
  ...jobBase,
  id: 'job-1',
  status: 'partial',
  stage: '转换结束',
  progress: 100,
  total: 2,
  done: 2,
  ok: 1,
  skipped: 0,
  failed: 1,
  items: [
    { rel: 'a.md', destRel: 'out/a (2).docx', status: 'ok', sizeBytes: 4096, ms: 1200, renamed: true },
    { rel: 'report.md', destRel: 'out/report.docx', status: 'failed', error: '磁盘空间不足' },
  ],
};

/** 推进假定时器并顺手跑完微任务；React 的 act 队列也在这一步收尾。 */
const flush = async (ms = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  api.getSettings.mockResolvedValue(SETTINGS);
  api.listFiles.mockResolvedValue({ files: FILES });
  api.createJob.mockResolvedValue('job-1');
  api.getJob.mockResolvedValue(FINISHED_JOB);
  api.fetchReport.mockResolvedValue('报告正文');
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('DocBatchPanel', () => {
  it('renders freshness badges and the rename target for each uploaded file', async () => {
    render(<DocBatchPanel />);
    await flush();

    expect(screen.getByText('a.md')).toBeInTheDocument();
    expect(screen.getAllByText('待生成')).toHaveLength(2);
    expect(screen.getByText('待更新')).toBeInTheDocument();
    expect(screen.getByText('已是最新')).toBeInTheDocument();
    expect(screen.getByText('会另存为 c (2).docx')).toBeInTheDocument();
    expect(screen.getByText('共 4 个 · 已勾选 4 个')).toBeInTheDocument();
  });

  it('reloads the file list with the chosen conflict strategy', async () => {
    render(<DocBatchPanel />);
    await flush();
    // 用 objectContaining：列文件的入参还包括 outMode/outDir（两者都会改变 destRel 预告），
    // 写死整对象会让每次加入参都变成一次用例返修。
    expect(api.listFiles).toHaveBeenCalledWith(expect.objectContaining({ recursive: true, conflict: 'rename' }));

    api.listFiles.mockClear();
    fireEvent.click(screen.getByRole('button', { name: '覆盖' }));
    await flush();
    expect(api.listFiles).toHaveBeenCalledWith(expect.objectContaining({ recursive: true, conflict: 'overwrite' }));

    api.listFiles.mockClear();
    fireEvent.click(screen.getByRole('button', { name: '跳过' }));
    await flush();
    expect(api.listFiles).toHaveBeenCalledWith(expect.objectContaining({ recursive: true, conflict: 'skip' }));

    api.listFiles.mockClear();
    fireEvent.click(screen.getByRole('button', { name: '自动重命名' }));
    await flush();
    expect(api.listFiles).toHaveBeenCalledWith(expect.objectContaining({ recursive: true, conflict: 'rename' }));
  });

  it('downloads an existing converted document straight from the list', async () => {
    render(<DocBatchPanel />);
    await flush();

    // 「已是最新」那条在磁盘上有产物（existingRel）—— 应该能直接下载，不必再转一次
    fireEvent.click(screen.getByRole('button', { name: '下载 c.docx' }));
    expect(api.downloadFile).toHaveBeenCalledWith('out/c.docx');

    // 「待生成」那条没有产物，因此不给下载按钮
    expect(screen.queryByRole('button', { name: '下载 b.docx' })).not.toBeInTheDocument();
  });

  it('bundles every existing output in one click', async () => {
    render(<DocBatchPanel />);
    await flush();

    fireEvent.click(screen.getByRole('button', { name: '下载已转换的（1）' }));
    expect(api.downloadExistingBundle).toHaveBeenCalledWith(['out/c.docx']);
  });

  it('polls the job to a terminal state and shows statistics with failure details', async () => {
    api.getJob.mockResolvedValueOnce(RUNNING_JOB).mockResolvedValue(FINISHED_JOB);

    render(<DocBatchPanel />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: /开始转换/ }));
    await flush();
    expect(api.createJob).toHaveBeenCalledTimes(1);

    await flush(1000);
    expect(screen.getByText('转换中')).toBeInTheDocument();
    expect(screen.getByText('正在转换 report.md')).toBeInTheDocument();

    // 再推进两轮：一轮让任务进终态，另一轮兜住 effect 重新挂表的时点。
    await flush(1000);
    await flush(1000);
    expect(screen.getByText('部分完成')).toBeInTheDocument();
    expect(screen.getByText('成功 1')).toBeInTheDocument();
    expect(screen.getByText('跳过 0')).toBeInTheDocument();
    expect(screen.getByText('失败 1')).toBeInTheDocument();
    expect(screen.getByText('失败明细（1）')).toBeInTheDocument();
    expect(screen.getByText('磁盘空间不足')).toBeInTheDocument();
    expect(screen.getByText('另存为 a (2).docx')).toBeInTheDocument();

    // 终态后不再轮询。
    const callsAfterTerminal = api.getJob.mock.calls.length;
    expect(callsAfterTerminal).toBeGreaterThanOrEqual(2);
    await flush(5000);
    expect(api.getJob.mock.calls.length).toBe(callsAfterTerminal);
  });

  it('submits only the failed items when retrying', async () => {
    render(<DocBatchPanel />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: /开始转换/ }));
    await flush();
    await flush(1000);
    await flush(1000);

    expect(screen.getByText('失败明细（1）')).toBeInTheDocument();
    api.createJob.mockClear();

    fireEvent.click(screen.getByRole('button', { name: /只重试失败项/ }));
    await flush();

    expect(api.createJob).toHaveBeenCalledTimes(1);
    expect(api.createJob.mock.calls[0][0]).toEqual(expect.objectContaining({ files: ['report.md'] }));
  });
});
