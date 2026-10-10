import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LibreChatQuotaBadge, LibreChatQuotaPanel } from './LibreChatQuotaIndicator';
import type { LibreChatQuotaView } from '../api/librechatQuota';

const view = (overrides: Partial<LibreChatQuotaView> = {}): LibreChatQuotaView => ({
  dailyLimit: 5,
  used: 1,
  remaining: 4,
  banned: false,
  bannedUntil: null,
  warnings: 0,
  maxWarnings: 3,
  ...overrides,
});

describe('LibreChatQuotaIndicator', () => {
  it('徽标显示今日剩余次数', () => {
    render(<LibreChatQuotaBadge quota={view()} loading={false} />);
    expect(screen.getByText('今日剩余 4 / 5 次')).toBeInTheDocument();
  });

  it('额度未知时显示「未知」，而不是剩余 0 次', () => {
    render(<LibreChatQuotaBadge quota={null} loading={false} />);
    expect(screen.getByText('额度暂时未知')).toBeInTheDocument();
  });

  it('管理员不受日额度限制', () => {
    render(<LibreChatQuotaPanel quota={view({ used: 5, remaining: 0 })} loading={false} isAdmin />);
    expect(screen.getByText('管理员不受每日对话额度限制。')).toBeInTheDocument();
  });

  it('接近上限时给出超额警告，暂停时给出恢复时刻', () => {
    const { unmount } = render(
      <LibreChatQuotaPanel quota={view({ used: 5, remaining: 0, warnings: 1 })} loading={false} />,
    );
    expect(screen.getByText(/已收到 1 \/ 3 次超额警告/)).toBeInTheDocument();
    unmount();

    render(
      <LibreChatQuotaPanel
        quota={view({ used: 5, remaining: 0, banned: true, bannedUntil: '2026-10-11T04:00:00.000Z' })}
        loading={false}
      />,
    );
    expect(screen.getByText(/对话权限已暂停，将于/)).toBeInTheDocument();
  });
});
