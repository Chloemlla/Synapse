import { describe, expect, it, vi } from 'vitest';
import { ticketApi } from '../api/ticketApi';

/**
 * `ticketApi` 与后端契约的字段级对照。
 *
 * 为什么值得单独钉：
 * - TP-09 的教训是「字段靠变量多余属性被放行」——类型没写全时，调用方改成对象字面量
 *   就会静默丢字段。这里用完整对象字面量调用，字段名/方法名任何一侧漂移都会失败；
 * - 分页元信息在响应头（X-Total-Count / X-Page / X-Page-Size / X-Has-More），
 *   解析错会让「加载更多」永远停在第 1 页；
 * - 附件上传的 multipart 字段名（`file`）与链接更新接口的 body 形状是跨端契约。
 */

const { mockGet, mockPost, mockPut, mockDelete, mockPatch } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPost: vi.fn(),
  mockPut: vi.fn(),
  mockDelete: vi.fn(),
  mockPatch: vi.fn(),
}));

vi.mock('../api/api', () => ({
  api: {
    get: mockGet,
    post: mockPost,
    put: mockPut,
    delete: mockDelete,
    patch: mockPatch,
  },
}));

describe('ticketApi 创建工单契约', () => {
  it('sends every ticket-face field the backend reads', async () => {
    mockPost.mockResolvedValue({ data: { _id: 'ticket-1' } });

    const payload = {
      title: '语音合成失败',
      description: '点击合成后提示 500',
      priority: 'high',
      category: 'bug' as const,
      type: 'incident' as const,
      relatedService: 'tts' as const,
      relatedServiceRef: 'job-123',
      contactEmail: 'alice@example.com',
      relatedTicketIds: ['0123456789abcdef01234567'],
      attachmentLinks: [{ url: 'https://img.example.com/shot.png', label: '报错截图' }],
    };

    await ticketApi.createTicket(payload);

    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockPost).toHaveBeenCalledWith('/api/tickets', payload);
  });
});

describe('ticketApi 管理端列表契约（TP-08 / TP-10）', () => {
  it('passes the date range and page size through, and reads pagination headers', async () => {
    mockGet.mockResolvedValue({
      data: [],
      headers: {
        'x-total-count': '240',
        'x-page': '2',
        'x-page-size': '200',
        'x-has-more': 'true',
      },
    });

    const page = await ticketApi.getAllTickets({
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-10-16T23:59:59.999Z',
      limit: 200,
      page: 2,
      type: 'incident',
      service: 'tts',
    });

    expect(mockGet).toHaveBeenCalledWith('/api/tickets/admin/all', {
      params: {
        from: '2026-10-01T00:00:00.000Z',
        to: '2026-10-16T23:59:59.999Z',
        limit: 200,
        page: 2,
        type: 'incident',
        service: 'tts',
        summary: 1,
      },
    });
    expect(page.meta).toEqual({ total: 240, page: 2, pageSize: 200, hasMore: true });
  });
});

describe('ticketApi 附件契约', () => {
  it('uploads multipart under the field name the route expects', async () => {
    mockPost.mockResolvedValue({
      data: {
        attachment: { id: 'att-1', fileName: 'shot.png' },
        attachmentCount: 1,
      },
    });
    const file = new File(['png-bytes'], 'shot.png', { type: 'image/png' });

    const result = await ticketApi.uploadAttachment('ticket-1', file);

    expect(mockPost).toHaveBeenCalledTimes(1);
    const [url, form] = mockPost.mock.calls[0];
    expect(url).toBe('/api/tickets/ticket-1/attachments');
    expect(form).toBeInstanceOf(FormData);
    expect((form as FormData).get('file')).toBe(file);
    expect(result.attachmentCount).toBe(1);
  });

  it('replaces attachment links through the documented endpoint', async () => {
    mockPut.mockResolvedValue({ data: { _id: 'ticket-1' } });
    const links = [{ url: 'https://img.example.com/shot.png', label: null }];

    await ticketApi.updateAttachmentLinks('ticket-1', links);

    expect(mockPut).toHaveBeenCalledWith('/api/tickets/ticket-1/attachment-links', { links });
  });

  it('reads the capability switch the create form renders from', async () => {
    mockGet.mockResolvedValue({
      data: {
        canUploadAttachments: false,
        attachmentUploadPolicy: '附件上传暂未开放',
        limits: {
          maxAttachments: 5,
          maxAttachmentBytes: 1024 * 1024,
          allowedExts: ['jpg', 'jpeg', 'png', 'gif', 'txt', 'pdf'],
          maxAttachmentLinks: 5,
          maxAttachmentLinkLength: 2048,
          maxAttachmentLinkLabelLength: 120,
        },
      },
    });

    const capabilities = await ticketApi.getCapabilities();

    expect(mockGet).toHaveBeenCalledWith('/api/tickets/capabilities');
    expect(capabilities.canUploadAttachments).toBe(false);
    expect(capabilities.limits.maxAttachmentBytes).toBe(1024 * 1024);
  });
});
