import { describe, expect, it } from 'vitest';
import type { ITicketEvent } from '../api/ticketApi';
import {
  TICKET_CSAT_LABELS,
  TICKET_EVENT_META,
  formatFirstResponse,
  formatTicketStarRating,
  ticketEventDescription,
} from '../components/ticket/ticketConstants';

function makeEvent(
  type: ITicketEvent['type'],
  overrides: Partial<ITicketEvent> = {},
): ITicketEvent {
  return {
    type,
    actorRole: 'system',
    createdAt: '2026-10-17T00:00:00.000Z',
    ...overrides,
  };
}

// 处理记录与满意度文案要面向用户：只讲「什么变成了什么」，不暴露字段名/接口细节。
describe('ticket event copy', () => {
  it('状态、受理人、满意度与服务变更都有中文描述', () => {
    expect(ticketEventDescription(makeEvent('status', { from: 'open', to: 'in-progress' }))).toBe(
      '状态：待处理 → 处理中',
    );
    expect(ticketEventDescription(makeEvent('assignee', { from: null, to: '张三' }))).toBe(
      '受理人：未分配 → 张三',
    );
    expect(ticketEventDescription(makeEvent('assignee', { from: '张三', to: null }))).toBe(
      '受理人：张三 → 未分配',
    );
    expect(ticketEventDescription(makeEvent('csat', { to: '5' }))).toBe('满意度：5 星');
    expect(ticketEventDescription(makeEvent('service', { from: 'tts', to: 'other' }))).toBe(
      '相关服务：语音合成 → 其他 / 不确定',
    );
  });

  it('优先级、分类、类型与创建事件可读', () => {
    expect(ticketEventDescription(makeEvent('priority', { from: 'medium', to: 'high' }))).toBe(
      '优先级：一般 → 紧急',
    );
    expect(ticketEventDescription(makeEvent('category', { from: 'other', to: 'bug' }))).toBe(
      '分类：其他 → 故障报错',
    );
    expect(ticketEventDescription(makeEvent('type', { from: 'inquiry', to: 'incident' }))).toBe(
      '类型：咨询 → 故障',
    );
    expect(ticketEventDescription(makeEvent('created'))).toBe('工单已创建');
  });

  it('事件类型都有标签', () => {
    expect(TICKET_EVENT_META.status.label).toBe('状态变更');
    expect(TICKET_EVENT_META.csat.label).toBe('满意度评价');
  });

  it('CSAT 文案与星级格式', () => {
    expect(TICKET_CSAT_LABELS[1]).toBe('非常不满意');
    expect(TICKET_CSAT_LABELS[5]).toBe('非常满意');
    expect(formatTicketStarRating(4)).toBe('4 星 · 满意');
    expect(formatTicketStarRating(null)).toBe('—');
    expect(formatTicketStarRating(0)).toBe('—');
    expect(formatTicketStarRating(6)).toBe('—');
  });

  it('首响时长按小时/天展示', () => {
    expect(formatFirstResponse(null)).toBe('—');
    expect(formatFirstResponse(undefined)).toBe('—');
    expect(formatFirstResponse(0.5)).toBe('<1 小时');
    expect(formatFirstResponse(6)).toBe('6 小时');
    expect(formatFirstResponse(48)).toBe('2 天');
  });
});
