import { studioBadgeClassName } from '../studioTheme';

/**
 * 工单状态 / 优先级徽标。
 *
 * 抽成独立模块只因为它们服务于详情头部，而 TicketSystem.tsx 已贴着 1500 行源码体积闸门。
 * 返回 JSX，所以文件后缀必须是 .tsx（不是 .ts）。
 */
export function ticketStatusBadge(status: string) {
  switch (status) {
    case 'open':
      return <span className={studioBadgeClassName('blue')}>待处理</span>;
    case 'in-progress':
      return <span className={studioBadgeClassName('yellow')}>处理中</span>;
    case 'resolved':
      return <span className={studioBadgeClassName('green')}>已解决</span>;
    case 'closed':
      return <span className={studioBadgeClassName('slate')}>已关闭</span>;
    default:
      return null;
  }
}

export function ticketPriorityBadge(priority: string) {
  switch (priority) {
    case 'high':
      return <span className={studioBadgeClassName('rose')}>紧急</span>;
    case 'medium':
      return <span className={studioBadgeClassName('yellow')}>一般</span>;
    case 'low':
      return <span className={studioBadgeClassName('green')}>低</span>;
    default:
      return null;
  }
}
