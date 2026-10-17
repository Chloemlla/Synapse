import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import TicketSatisfactionCard from '../components/ticket/TicketSatisfactionCard';
import type { ITicket } from '../api/ticketApi';

/**
 * 满意度评价卡的双视角。
 *
 * 钉住两件事：
 * 1. 客服（超管）必须能读到用户写下的补充说明 —— 只显示星级等于把差评原因藏起来，
 *    回访与改进都无从谈起（此前卡片对管理员整卡隐藏，评价内容在客服侧完全不可见）；
 * 2. 客服侧是只读的：不能替用户打分，也不出现「修改评价」。
 */

function makeTicket(overrides: Partial<ITicket> = {}): ITicket {
  return {
    _id: 'ticket-1',
    userId: 'u1',
    username: 'alice',
    title: '语音合成失败',
    description: '点击合成后提示 500',
    status: 'resolved',
    priority: 'medium',
    type: 'inquiry',
    relatedService: 'tts',
    relatedServiceRef: null,
    contactEmail: null,
    relatedTickets: [],
    attachmentLinks: [],
    attachmentCount: 0,
    messages: [],
    csatRating: 3,
    csatComment: '响应太慢，问题最后解决了',
    csatSubmittedAt: '2026-10-17T08:00:00.000Z',
    createdAt: '2026-10-16T00:00:00.000Z',
    updatedAt: '2026-10-17T08:00:00.000Z',
    ...overrides,
  };
}

describe('TicketSatisfactionCard 客服只读视角', () => {
  it('shows the rating and the comment to admins without edit controls', () => {
    render(
      <TicketSatisfactionCard
        ticket={makeTicket()}
        currentUserId="admin-1"
        isAdmin
        onSubmit={vi.fn()}
      />,
    );

    expect(screen.getByText('用户评价')).toBeInTheDocument();
    expect(screen.getByText('响应太慢，问题最后解决了')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /当前评分/ })).toBeInTheDocument();
    // 只读：没有打分控件、没有修改入口
    expect(screen.queryByRole('radiogroup', { name: '满意度评分' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '修改评价' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '提交评价' })).not.toBeInTheDocument();
  });

  it('renders nothing for an admin when the user has not rated yet', () => {
    const { container } = render(
      <TicketSatisfactionCard
        ticket={makeTicket({ csatRating: null, csatComment: null, csatSubmittedAt: null })}
        currentUserId="admin-1"
        isAdmin
        onSubmit={vi.fn()}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });
});

describe('TicketSatisfactionCard 属主视角', () => {
  it('keeps the rating form editable for the owner of a resolved ticket', () => {
    render(
      <TicketSatisfactionCard
        ticket={makeTicket()}
        currentUserId="u1"
        isAdmin={false}
        onSubmit={vi.fn()}
      />,
    );

    expect(screen.getByText('感谢你的评价')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '修改评价' })).toBeInTheDocument();
  });

  it('offers the rating form once the ticket is resolved', () => {
    render(
      <TicketSatisfactionCard
        ticket={makeTicket({ csatRating: null, csatComment: null, csatSubmittedAt: null })}
        currentUserId="u1"
        isAdmin={false}
        onSubmit={vi.fn()}
      />,
    );

    expect(screen.getByText('这个工单解决了吗？')).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: '满意度评分' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '提交评价' })).toBeInTheDocument();
  });
});
