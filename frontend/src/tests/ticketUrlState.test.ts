import { describe, expect, it } from 'vitest';
import {
  EMPTY_TICKET_URL_STATE,
  buildTicketSearchParams,
  readTicketUrlState,
  type TicketUrlState,
} from '../components/ticket/ticketUrlState';

// URL 是筛选条件的唯一持久化载体：默认视图必须保持干净，非默认字段必须能往返，
// URL 里的未知/非法值一律忽略（不能把垃圾带进请求）。
describe('ticketUrlState', () => {
  it('默认状态不写入任何参数', () => {
    expect(buildTicketSearchParams(EMPTY_TICKET_URL_STATE)).toBe('');
    expect(readTicketUrlState('')).toEqual(EMPTY_TICKET_URL_STATE);
  });

  it('非默认字段可往返且只写非默认值', () => {
    const state: TicketUrlState = {
      ticketId: '507f1f77bcf86cd799439011',
      q: '合成 失败',
      status: 'in-progress',
      priority: 'high',
      category: 'bug',
      type: 'incident',
      service: 'tts',
      assignee: 'me',
      awaitingReply: '1',
      unread: '1',
      csat: 'low',
      sort: 'created',
      from: '2026-10-01',
      to: '2026-10-17',
      limit: '100',
    };
    const query = buildTicketSearchParams(state);
    expect(query).toContain('ticket=507f1f77bcf86cd799439011');
    expect(query).toContain('sort=created');
    expect(query).not.toContain('sort=updated');
    expect(readTicketUrlState(query)).toEqual(state);
  });

  it('未知或非法值回落默认值', () => {
    const parsed = readTicketUrlState(
      '?status=weird&priority=urgent&category=x&type=x&service=x'
      + '&assignee=bob&awaitingReply=0&unread=yes&csat=high&sort=newest'
      + '&from=2026-02-31&to=17-10-2026&limit=999',
    );
    expect(parsed).toEqual(EMPTY_TICKET_URL_STATE);
  });

  it('保留深链工单 ID，且带不带前导问号都能解析', () => {
    expect(readTicketUrlState('?ticket=abc').ticketId).toBe('abc');
    expect(readTicketUrlState('ticket=abc&q=x').ticketId).toBe('abc');
    // ticket 与筛选参数共存：打开工单不丢筛选。
    const parsed = readTicketUrlState('?ticket=abc&status=resolved&sort=oldest');
    expect(parsed).toMatchObject({ ticketId: 'abc', status: 'resolved', sort: 'oldest' });
  });

  it('只接受合法的日期与每页条数', () => {
    expect(readTicketUrlState('?from=2026-10-01&to=2026-10-17&limit=100')).toMatchObject({
      from: '2026-10-01',
      to: '2026-10-17',
      limit: '100',
    });
    expect(readTicketUrlState('?from=2026-02-31&limit=0').from).toBe('');
    expect(readTicketUrlState('?limit=999').limit).toBe('');
  });
});
