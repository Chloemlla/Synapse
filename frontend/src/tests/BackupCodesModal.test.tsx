import React from 'react';
import { render } from '@testing-library/react';
import { screen, waitFor } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { vi } from 'vitest';

/**
 * 备用恢复码弹窗：区分「一个都不剩」与「还有 N 个但明文不可取回」。
 *
 * 背景（真实回归）：恢复码以哈希入库，明文只在生成那一刻返回一次。重新打开弹窗时
 * 后端返回 `backupCodes: []` + `remainingCount: N`，旧实现只看 `backupCodes.length`
 * 就渲染空状态 —— 生成过恢复码的用户再打开会看到「当前没有可用的恢复码」，
 * 以为生成失败。
 */

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  notify: vi.fn(),
}));

vi.mock('../api/api', () => ({
  api: { get: mocks.get, post: mocks.post },
  getApiBaseUrl: () => '',
}));
vi.mock('../components/Notification', () => ({
  useNotification: () => ({ setNotification: mocks.notify }),
}));
vi.mock('../hooks/useSecuritySession', () => ({
  useSecuritySession: () => ({ verificationToken: 'session-token', isActive: true }),
}));
// ModalPortal 在 jsdom 里没有真实 portal 宿主，直接透传子节点。
vi.mock('../components/ModalPortal', () => ({
  ModalPortal: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));

import BackupCodesModal from '../components/BackupCodesModal';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('BackupCodesModal', () => {
  it('还有恢复码但明文已不可取回时，显示剩余数量而不是空状态', async () => {
    mocks.get.mockResolvedValue({
      data: {
        backupCodes: [],
        remainingCount: 8,
        message: '备用恢复码仅在生成时显示一次',
      },
    });

    render(<BackupCodesModal isOpen onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('8')).toBeInTheDocument();
    });
    // 关键断言：不能出现「当前没有可用的恢复码」这句空状态文案。
    expect(screen.queryByText(/当前没有可用的恢复码/)).not.toBeInTheDocument();
    expect(screen.getByText(/只在生成时显示一次/)).toBeInTheDocument();
    // 没有明文可展示，「查看恢复码」必须禁用而不是静默无效。
    expect(screen.getByRole('button', { name: /查看恢复码/ })).toBeDisabled();
  });

  it('一个都不剩（后端 404）时渲染空状态，且不弹错误通知', async () => {
    mocks.get.mockRejectedValue({ response: { status: 404, data: { error: '没有可用的备用恢复码' } } });

    render(<BackupCodesModal isOpen onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText(/当前没有可用的恢复码/)).toBeInTheDocument();
    });
    // 404 是「用完了」，不是故障：不该当成错误横幅或通知。
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it('重新生成后展示明文并同步剩余数量', async () => {
    mocks.get.mockResolvedValue({ data: { backupCodes: [], remainingCount: 0, message: '' } });
    mocks.post.mockResolvedValue({
      data: { backupCodes: ['AAAA-1111', 'BBBB-2222'], remainingCount: 2, message: 'ok' },
    });

    render(<BackupCodesModal isOpen onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByText(/当前没有可用的恢复码/)).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /重新生成/ }));
    await userEvent.click(await screen.findByRole('button', { name: /确认生成/ }));

    await waitFor(() => {
      expect(screen.getByText('AAAA-1111')).toBeInTheDocument();
    });
    expect(screen.getByText('BBBB-2222')).toBeInTheDocument();
  });

  it('网络故障仍然走错误态并提供重试', async () => {
    mocks.get.mockRejectedValue({ response: { status: 500, data: { error: '获取备用恢复码失败' } } });

    render(<BackupCodesModal isOpen onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('获取备用恢复码失败')).toBeInTheDocument();
    });
    expect(mocks.notify).toHaveBeenCalled();
  });
});
