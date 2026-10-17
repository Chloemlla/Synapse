import React, { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import TicketCreateForm, { type TicketCreateFormValue } from '../components/ticket/TicketCreateForm';
import { TicketAttachmentList } from '../components/ticket/TicketAttachments';
import type { ITicketAttachment, TicketCapabilities } from '../api/ticketApi';

/**
 * 创建工单表单的票面字段与附件通道。
 *
 * 重点钉住三件容易在重构里悄悄退化的事：
 * 1. 票面字段（类型 / 相关服务 + 说明 / 联系邮箱 / 关联工单 / 附件链接）一个都不能少；
 * 2. 上传开关关闭（或能力接口拉取失败）时，**链接输入框仍然必须可用** —— 它是票面要求的兜底通道；
 * 3. 链接的本地预校验与后端同口径（仅 http/https），错误要能直接展示给用户。
 */

const EMPTY_VALUE: TicketCreateFormValue = {
  title: '',
  description: '',
  contentFormat: 'markdown',
  priority: 'medium',
  category: 'other',
  type: 'inquiry',
  relatedService: 'other',
  relatedServiceRef: '',
  contactEmail: '',
  attachmentLinks: [],
  relatedTicketIds: [],
};

const CAPABILITIES_ENABLED: TicketCapabilities = {
  canUploadAttachments: true,
  attachmentUploadPolicy: null,
  limits: {
    maxAttachments: 5,
    maxAttachmentBytes: 1024 * 1024,
    allowedExts: ['jpg', 'jpeg', 'png', 'gif', 'txt', 'pdf'],
    maxAttachmentLinks: 5,
    maxAttachmentLinkLength: 2048,
    maxAttachmentLinkLabelLength: 120,
  },
};

const CAPABILITIES_DISABLED: TicketCapabilities = {
  ...CAPABILITIES_ENABLED,
  canUploadAttachments: false,
  attachmentUploadPolicy: '附件上传暂未对普通用户开放：请使用附件链接提交截图，或联系管理员开启。',
};

interface HarnessProps {
  capabilities: TicketCapabilities | null;
  onChangeSpy?: (patch: Partial<TicketCreateFormValue>) => void;
  onSubmit?: (event: React.FormEvent) => void;
  onError?: (message: string) => void;
}

/** 受控包装：表单自身不持有票面字段状态，值由页面传入。 */
function Harness({ capabilities, onChangeSpy, onSubmit, onError }: HarnessProps) {
  const [value, setValue] = useState<TicketCreateFormValue>({ ...EMPTY_VALUE });
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);

  return (
    <TicketCreateForm
      value={value}
      onChange={(patch) => {
        onChangeSpy?.(patch);
        setValue((current) => ({ ...current, ...patch }));
      }}
      pendingFiles={pendingFiles}
      onPendingFilesChange={setPendingFiles}
      linkingCandidates={[{ _id: '0123456789abcdef01234567', title: '上一次的工单' }]}
      capabilities={capabilities}
      isMobile={false}
      isSubmitting={false}
      onSubmit={onSubmit ?? (() => undefined)}
      onCancel={() => undefined}
      onError={onError ?? (() => undefined)}
    />
  );
}

function fillRequiredFields() {
  fireEvent.change(screen.getByPlaceholderText('请输入简明扼要的标题'), {
    target: { value: '语音合成失败' },
  });
  fireEvent.change(screen.getByPlaceholderText(/请尽可能详细地说明/), {
    target: { value: '点击合成后提示 500。' },
  });
}

describe('TicketCreateForm 票面字段', () => {
  it('renders the full ticket-face form', () => {
    render(<Harness capabilities={CAPABILITIES_ENABLED} />);

    // 标题 / 问题分类 / 工单类型 / 详细描述
    expect(screen.getByPlaceholderText('请输入简明扼要的标题')).toBeInTheDocument();
    expect(screen.getByText('问题分类')).toBeInTheDocument();
    expect(screen.getByText('工单类型')).toBeInTheDocument();
    expect(screen.getByText('故障报错')).toBeInTheDocument();
    expect(screen.getByText('故障')).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/请尽可能详细地说明/)).toBeInTheDocument();

    // 正文格式：Markdown / 纯文本二选一（默认 Markdown，与历史渲染行为一致）
    expect(screen.getByRole('group', { name: '描述格式' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Markdown' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '纯文本' })).toHaveAttribute('aria-pressed', 'false');

    // 相关服务 + 具体说明
    expect(screen.getByLabelText('相关服务')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('例如任务 ID、订单号、资源名')).toBeInTheDocument();

    // 联系邮箱
    expect(screen.getByPlaceholderText('用于接收进展通知，留空则用账号邮箱')).toBeInTheDocument();

    // 关联工单
    expect(screen.getByText(/关联工单（可选，最多 5 个）/)).toBeInTheDocument();
    expect(screen.getByLabelText('添加关联工单')).toBeInTheDocument();

    // 附件链接（两种开关状态下都存在）
    expect(screen.getByLabelText('附件链接地址')).toBeInTheDocument();

    // 紧急程度
    expect(screen.getByText('紧急')).toBeInTheDocument();
    expect(screen.getByText('一般')).toBeInTheDocument();
    expect(screen.getByText('低')).toBeInTheDocument();
  });

  it('lets the user choose plain text for the description', () => {
    const onChangeSpy = vi.fn();
    render(<Harness capabilities={CAPABILITIES_ENABLED} onChangeSpy={onChangeSpy} />);

    fireEvent.click(screen.getByRole('button', { name: '纯文本' }));

    expect(onChangeSpy).toHaveBeenCalledWith({ contentFormat: 'plain' });
    // 受控包装会把补丁合并回 value，选中态随之翻转。
    expect(screen.getByRole('button', { name: '纯文本' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Markdown' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('shows the file picker only when uploads are enabled', () => {
    const { unmount } = render(<Harness capabilities={CAPABILITIES_ENABLED} />);
    expect(screen.getByLabelText('选择工单附件')).toBeInTheDocument();
    expect(screen.getByText('可上传文件或粘贴链接')).toBeInTheDocument();
    unmount();

    render(<Harness capabilities={CAPABILITIES_DISABLED} />);
    expect(screen.queryByLabelText('选择工单附件')).not.toBeInTheDocument();
    expect(screen.getByText('仅支持粘贴链接')).toBeInTheDocument();
    expect(screen.getByLabelText('附件链接地址')).toBeInTheDocument();
  });
});

describe('附件链接通道与预校验', () => {
  it('rejects malformed and non-http(s) links before they reach the form state', () => {
    const onChangeSpy = vi.fn();
    const onError = vi.fn();
    render(
      <Harness capabilities={CAPABILITIES_DISABLED} onChangeSpy={onChangeSpy} onError={onError} />,
    );

    fireEvent.change(screen.getByLabelText('附件链接地址'), { target: { value: 'not a url' } });
    fireEvent.click(screen.getByRole('button', { name: /添加/ }));
    expect(onError).toHaveBeenLastCalledWith(expect.stringContaining('链接格式不正确'));

    fireEvent.change(screen.getByLabelText('附件链接地址'), {
      target: { value: 'javascript:alert(1)' },
    });
    fireEvent.click(screen.getByRole('button', { name: /添加/ }));
    expect(onError).toHaveBeenLastCalledWith(expect.stringContaining('只支持 http / https'));

    // 非法链接不得进入 attachmentLinks，避免"看着加上了、提交时被后端拒掉"。
    expect(onChangeSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ attachmentLinks: expect.any(Array) }),
    );
  });

  it('keeps the link channel usable and submit-able when uploads are disabled', () => {
    const onChangeSpy = vi.fn();
    const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault());
    render(
      <Harness
        capabilities={CAPABILITIES_DISABLED}
        onChangeSpy={onChangeSpy}
        onSubmit={onSubmit}
      />,
    );

    fillRequiredFields();
    fireEvent.change(screen.getByLabelText('附件链接地址'), {
      target: { value: 'https://img.example.com/shot.png' },
    });
    fireEvent.click(screen.getByRole('button', { name: /添加/ }));

    expect(onChangeSpy).toHaveBeenCalledWith({
      attachmentLinks: [{ url: 'https://img.example.com/shot.png', label: null }],
    });

    // 直接触发 form 的 submit：jsdom 对「点击 submit 按钮 → 约束校验 → submit 事件」的实现
    // 依赖具体版本，这里要钉的是表单把当前值交给了页面，而不是浏览器的必填校验。
    const form = screen.getByRole('button', { name: '提交工单' }).closest('form');
    expect(form).not.toBeNull();
    fireEvent.submit(form as HTMLFormElement);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('degrades to links-only when the capabilities request fails', () => {
    // 页面在 getCapabilities() 失败时保持 capabilities=null（fail-closed：不显示必然 403 的上传按钮）。
    const onChangeSpy = vi.fn();
    render(<Harness capabilities={null} onChangeSpy={onChangeSpy} />);

    expect(screen.queryByLabelText('选择工单附件')).not.toBeInTheDocument();
    expect(screen.getByText('仅支持粘贴链接')).toBeInTheDocument();
    expect(screen.getByLabelText('附件链接地址')).toBeInTheDocument();

    // 降级状态下链接仍能正常加入表单状态。
    fireEvent.change(screen.getByLabelText('附件链接地址'), {
      target: { value: 'https://img.example.com/shot.png' },
    });
    fireEvent.click(screen.getByRole('button', { name: /添加/ }));
    expect(onChangeSpy).toHaveBeenCalledWith({
      attachmentLinks: [{ url: 'https://img.example.com/shot.png', label: null }],
    });
  });
});

describe('关闭上传后仍可管理历史附件（TP-13）', () => {
  const attachment: ITicketAttachment = {
    id: 'att-1',
    fileName: 'shot.png',
    ext: 'png',
    mimeType: 'image/png',
    size: 1234,
    uploadedById: 'u1',
    uploadedByName: 'alice',
    createdAt: '2026-10-01T00:00:00.000Z',
  };

  it('keeps download/delete available when the upload switch is off', () => {
    render(
      <TicketAttachmentList
        ticketId="ticket-1"
        attachments={[attachment]}
        canUpload={false}
        uploadDisabledReason="附件上传暂未开放；已存在的附件仍可下载与删除"
        canDelete={() => true}
        onUploaded={() => undefined}
        onDeleted={() => undefined}
        onError={() => undefined}
      />,
    );

    // 上传入口必须消失，但历史附件不能跟着消失。
    expect(screen.queryByRole('button', { name: '添加附件' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('下载附件 shot.png')).toBeInTheDocument();
    expect(screen.getByLabelText('删除附件 shot.png')).toBeInTheDocument();
    expect(screen.getByText(/已存在的附件仍可下载与删除/)).toBeInTheDocument();
  });
});
