import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ notify: vi.fn(), confirm: vi.fn(), get: vi.fn(), post: vi.fn(), digest: vi.fn(), uuid: vi.fn() }));
vi.mock('../hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'admin', role: 'superadmin' } }) }));
vi.mock('../components/Notification', () => ({ useNotification: () => ({ setNotification: mocks.notify }) }));
vi.mock('../components/confirm/ConfirmDialogProvider', () => ({ useConfirm: () => mocks.confirm }));
vi.mock('../api/api', () => ({ default: { get: mocks.get, post: mocks.post } }));

import { EcoEnchantsOpsPanel } from '../components/EcoEnchantsOpsPanel';

const instance = {
  instanceId: 'instance-one', installationId: 'installation-one', status: 'online', serverName: 'Test server',
  platform: 'paper', version: '1', minecraftVersion: '1.21', capabilities: { fileOps: true, backupArchive: true },
};
const complete = { jobId: 'job-one', status: 'succeeded', result: { content: 'file contents' } };
let jobResponse: () => Promise<unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.confirm.mockResolvedValue(true);
  let id = 0;
  mocks.uuid.mockImplementation(() => 'operation-' + ++id);
  mocks.digest.mockResolvedValue(new Uint8Array(32).buffer);
  vi.stubGlobal('crypto', { randomUUID: mocks.uuid, subtle: { digest: mocks.digest } });
  jobResponse = async () => ({ data: complete });
  mocks.get.mockImplementation(async (url: string) => {
    if (url.includes('/ops/jobs/')) return jobResponse();
    if (url.endsWith('/ops/instances')) return { data: { instances: [instance] } };
    if (url.endsWith('/instance-one')) return { data: { instance } };
    if (url.endsWith('/backups')) return { data: { backups: [{ backupId: 'backup-one', status: 'available', sizeBytes: 1 }] } };
    return { data: { jobs: [], logs: [], policies: [] } };
  });
  mocks.post.mockResolvedValue({ status: 201, data: { jobId: 'job-one', status: 'queued' } });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function openDetail(tab = '文件操作') {
  render(<EcoEnchantsOpsPanel />);
  fireEvent.click(await screen.findByRole('button', { name: /Test server/ }));
  await screen.findByText('实例 Test server');
  fireEvent.click(screen.getByRole('button', { name: tab }));
  fireEvent.change(screen.getByLabelText('操作原因（写入、任务与备份必填）'), { target: { value: 'Scheduled maintenance' } });
}

function setReadPath() {
  fireEvent.change(screen.getByPlaceholderText('相对所选目录的路径，如 config.yml'), { target: { value: 'config.yml' } });
}

describe('EcoEnchants job submission contract', () => {
  it('waits for the read job before displaying file contents', async () => {
    let resolve!: (value: unknown) => void;
    jobResponse = () => new Promise(done => { resolve = done; });
    await openDetail();
    setReadPath();
    fireEvent.click(screen.getByRole('button', { name: '读取' }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledOnce());
    await waitFor(() => expect(resolve).toBeDefined());
    expect(mocks.post.mock.calls[0][1]).toEqual({ mount: 'plugin-data', path: 'config.yml' });
    expect(mocks.post.mock.calls[0][2].headers['Idempotency-Key']).toBeTruthy();
    expect(screen.queryByText('file contents')).not.toBeInTheDocument();
    expect(mocks.notify.mock.calls.some(([notice]) => notice.type === 'success')).toBe(false);
    await act(async () => resolve({ data: complete }));
    expect(await screen.findByText('file contents')).toBeInTheDocument();
  });

  it('reuses the operation key after an ambiguous failure, then changes it for the next completed operation', async () => {
    mocks.post.mockRejectedValueOnce(new Error('network disconnected'));
    await openDetail();
    setReadPath();
    fireEvent.click(screen.getByRole('button', { name: '读取' }));
    await waitFor(() => expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    fireEvent.click(screen.getByRole('button', { name: '读取' }));
    await screen.findByText('file contents');
    const key = mocks.post.mock.calls[0][2].headers['Idempotency-Key'];
    expect(mocks.post.mock.calls[1][2].headers['Idempotency-Key']).toBe(key);
    fireEvent.click(screen.getByRole('button', { name: '读取' }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(3));
    expect(mocks.post.mock.calls[2][2].headers['Idempotency-Key']).not.toBe(key);
  });

  it('does not claim a write succeeded when its accepted job fails', async () => {
    jobResponse = async () => ({ data: { jobId: 'job-one', status: 'failed', error: { message: 'write rejected' } } });
    await openDetail();
    fireEvent.change(screen.getAllByPlaceholderText('相对所选目录的路径')[0], { target: { value: 'config.yml' } });
    fireEvent.change(screen.getByPlaceholderText('文件内容...'), { target: { value: 'abc' } });
    fireEvent.click(screen.getByRole('button', { name: '写入' }));
    await waitFor(() => expect(mocks.notify).toHaveBeenCalledWith({ message: 'write rejected', type: 'error' }));
    expect(mocks.post.mock.calls[0][1]).toEqual(expect.objectContaining({
      mount: 'plugin-data', path: 'config.yml', contentBase64: 'YWJj', contentSha256: '0'.repeat(64),
      reason: 'Scheduled maintenance', confirmRisk: true,
    }));
    expect(mocks.notify.mock.calls.some(([notice]) => notice.type === 'success')).toBe(false);
    expect(screen.getByPlaceholderText('文件内容...')).toHaveValue('abc');
  });

  it('provides backup scope and explicit restore paths with separate keys', async () => {
    await openDetail('备份');
    fireEvent.click(screen.getByRole('button', { name: '创建备份' }));
    await waitFor(() => expect(mocks.notify).toHaveBeenCalledWith({ message: '备份创建成功', type: 'success' }));
    expect(mocks.post.mock.calls[0][1]).toEqual({ scope: { mounts: ['plugin-data'], paths: ['config.yml'] }, reason: 'Scheduled maintenance' });
    fireEvent.click(await screen.findByRole('button', { name: '恢复' }));
    await waitFor(() => expect(mocks.notify).toHaveBeenCalledWith({ message: '备份恢复成功', type: 'success' }));
    expect(mocks.post.mock.calls[1][1]).toEqual(expect.objectContaining({ restorePaths: ['config.yml'], confirmRisk: true }));
    expect(mocks.post.mock.calls[1][2].headers['Idempotency-Key']).not.toBe(mocks.post.mock.calls[0][2].headers['Idempotency-Key']);
  });

  it('requires confirmation before submitting a file-removal job', async () => {
    await openDetail();
    fireEvent.change(screen.getAllByPlaceholderText('相对所选目录的路径')[1], { target: { value: 'old.yml' } });
    mocks.confirm.mockResolvedValueOnce(false);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '删除' })); });
    expect(mocks.post).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledOnce());
    expect(mocks.post.mock.calls[0][1]).toEqual({
      mount: 'plugin-data', path: 'old.yml', mode: 'quarantine', reason: 'Scheduled maintenance', confirmRisk: true,
    });
    expect(mocks.post.mock.calls[0][2].headers['Idempotency-Key']).toBeTruthy();
  });

  it('sends managed command parameters inside params', async () => {
    await openDetail('任务');
    fireEvent.click(screen.getByRole('button', { name: '创建任务' }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledOnce());
    expect(mocks.post.mock.calls[0][1]).toEqual({
      method: 'ops.command.runManaged', params: { commandId: 'ecoenchants.reload', arguments: {} },
      reason: 'Scheduled maintenance', confirmRisk: true,
    });
  });
});
