/**
 * 工单筛选 ↔ URL 的纯函数。
 *
 * 为什么单独一层：筛选条件要能刷新保留、复制分享、浏览器后退恢复，但它们与页面状态
 * 又必须只同步一次（双向绑定会在用户输入时互相覆盖）。这里只做「字符串 ↔ 对象」，
 * 不依赖 React、不读 `window`（`writeTicketUrlState` 例外，它会 guard 掉非浏览器环境），
 * 因而可以直接单测。
 *
 * 只写非默认值：默认视图保持干净的 `/support`，而不是挂一长串空参数。
 */
import {
  TICKET_CATEGORY_ORDER,
  TICKET_SERVICE_ORDER,
  TICKET_STATUS_ORDER,
  TICKET_TYPE_ORDER,
} from './ticketConstants';

export interface TicketUrlState {
  /** 深链工单 ID（URL 参数名是 `ticket`，与既有通知/邮件链接一致）。 */
  ticketId: string;
  q: string;
  status: string;
  priority: string;
  category: string;
  type: string;
  service: string;
  assignee: string;
  /** '1' = 只看待回复。 */
  awaitingReply: string;
  /** '1' = 只看未读。 */
  unread: string;
  /** 'low' = 满意度 ≤2 星。 */
  csat: string;
  sort: string;
  /** 创建时间区间（yyyy-mm-dd）。 */
  from: string;
  to: string;
  /** 每页条数（字符串形态，空串 = 默认）。 */
  limit: string;
}

export const EMPTY_TICKET_URL_STATE: TicketUrlState = {
  ticketId: '',
  q: '',
  status: '',
  priority: '',
  category: '',
  type: '',
  service: '',
  assignee: '',
  awaitingReply: '',
  unread: '',
  csat: '',
  sort: 'updated',
  from: '',
  to: '',
  limit: '',
};

const SORT_VALUES = ['updated', 'created', 'oldest'] as const;
const PRIORITY_VALUES = ['low', 'medium', 'high'] as const;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

function readParam(search: URLSearchParams, key: string): string {
  return (search.get(key) ?? '').trim();
}

function readEnum(raw: string, allowed: readonly string[]): string {
  return allowed.includes(raw) ? raw : '';
}

function readSort(raw: string): string {
  return readEnum(raw, SORT_VALUES) || EMPTY_TICKET_URL_STATE.sort;
}

function readDate(raw: string): string {
  if (!DATE_RE.test(raw)) return '';
  // 正则只保证形状；2 月 31 日这类「形状合法但不存在」的日期同样要回落默认值。
  const [year, month, day] = raw.split('-').map((part) => Number.parseInt(part, 10));
  const probe = new Date(year, month - 1, day);
  if (
    probe.getFullYear() !== year
    || probe.getMonth() !== month - 1
    || probe.getDate() !== day
  ) {
    return '';
  }
  return raw;
}

function readLimit(raw: string): string {
  if (!/^\d{1,3}$/.test(raw)) return '';
  const parsed = Number.parseInt(raw, 10);
  return parsed >= 1 && parsed <= 200 ? String(parsed) : '';
}

function readAssignee(raw: string): string {
  // `me` / `unassigned` 是语义值；其余只接受合法用户 ID（避免把任意文本带进请求）。
  return raw === 'me' || raw === 'unassigned' || OBJECT_ID_RE.test(raw) ? raw : '';
}

function readFlag(raw: string): string {
  return raw === '1' ? '1' : '';
}

/**
 * 从 `location.search`（带不带前导 `?` 都行）解析筛选。
 * 任何未知 / 非法值一律忽略并回落到默认值，绝不把 URL 里的垃圾带进请求。
 */
export function readTicketUrlState(search: string): TicketUrlState {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const q = readParam(params, 'q').slice(0, 120);
  return {
    ticketId: readParam(params, 'ticket'),
    q,
    status: readEnum(readParam(params, 'status'), TICKET_STATUS_ORDER),
    priority: readEnum(readParam(params, 'priority'), PRIORITY_VALUES),
    category: readEnum(readParam(params, 'category'), TICKET_CATEGORY_ORDER),
    type: readEnum(readParam(params, 'type'), TICKET_TYPE_ORDER),
    service: readEnum(readParam(params, 'service'), TICKET_SERVICE_ORDER),
    assignee: readAssignee(readParam(params, 'assignee')),
    awaitingReply: readFlag(readParam(params, 'awaitingReply')),
    unread: readFlag(readParam(params, 'unread')),
    csat: readEnum(readParam(params, 'csat'), ['low'] as const),
    sort: readSort(readParam(params, 'sort')),
    from: readDate(readParam(params, 'from')),
    to: readDate(readParam(params, 'to')),
    limit: readLimit(readParam(params, 'limit')),
  };
}

/**
 * 序列化为查询串（**不带**前导 `?`）。
 * 只写非默认值，保持链接短且可读。
 */
export function buildTicketSearchParams(state: TicketUrlState): string {
  const params = new URLSearchParams();
  if (state.ticketId) params.set('ticket', state.ticketId);
  if (state.q) params.set('q', state.q);
  if (state.status) params.set('status', state.status);
  if (state.priority) params.set('priority', state.priority);
  if (state.category) params.set('category', state.category);
  if (state.type) params.set('type', state.type);
  if (state.service) params.set('service', state.service);
  if (state.assignee) params.set('assignee', state.assignee);
  if (state.awaitingReply === '1') params.set('awaitingReply', '1');
  if (state.unread === '1') params.set('unread', '1');
  if (state.csat === 'low') params.set('csat', 'low');
  if (state.sort && state.sort !== EMPTY_TICKET_URL_STATE.sort) params.set('sort', state.sort);
  if (state.from) params.set('from', state.from);
  if (state.to) params.set('to', state.to);
  if (state.limit) params.set('limit', state.limit);
  return params.toString();
}

/**
 * 用 `history.replaceState` 写入当前视图（不新增历史记录，避免每敲一个字就多一条后退项）。
 *
 * `dropTicket` 用于「关闭详情但不离开筛选视图」：仅移除 `ticket` 深链参数，其余筛选保留。
 * 本身不监听 `popstate` —— 从 URL 读状态只应在页面初始化时做一次，否则会覆盖用户输入。
 */
export function writeTicketUrlState(
  next: TicketUrlState,
  options: { dropTicket?: boolean } = {},
): void {
  if (typeof window === 'undefined') return;
  const state = options.dropTicket ? { ...next, ticketId: '' } : next;
  const query = buildTicketSearchParams(state);
  const { pathname, hash } = window.location;
  const nextUrl = `${pathname}${query ? `?${query}` : ''}${hash}`;
  try {
    window.history.replaceState(window.history.state, '', nextUrl);
  } catch {
    // 隐私模式 / 被嵌入时可能禁止改写历史；筛选本身仍在内存里，不影响使用。
  }
}
