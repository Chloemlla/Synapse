/**
 * 工单系统的常量与纯函数：状态/优先级/分类的展示口径、快捷回复、创建模板、SLA 判定。
 *
 * 抽出来是为了让「列表卡片 / 筛选栏 / 统计条 / 详情」共用同一份文案，
 * 避免同一个状态在四处各写一遍中文（历史上就是这么漂移的）。
 */

export const MAX_TICKET_TITLE_LEN = 120;
export const MAX_TICKET_DESC_LEN = 4000;
export const MAX_TICKET_REPLY_LEN = 4000;

/** 管理端「逾期未回复」阈值（小时），与后端 TICKET_SLA_HOURS 对齐。 */
export const TICKET_SLA_HOURS = 24;

export const TICKET_PAGE_SIZE = 50;

export type BadgeTone = 'blue' | 'yellow' | 'green' | 'slate' | 'rose' | 'violet';

export const TICKET_STATUS_META: Record<string, { label: string; tone: BadgeTone }> = {
  open: { label: '待处理', tone: 'blue' },
  'in-progress': { label: '处理中', tone: 'yellow' },
  resolved: { label: '已解决', tone: 'green' },
  closed: { label: '已关闭', tone: 'slate' },
};

export const TICKET_STATUS_ORDER = ['open', 'in-progress', 'resolved', 'closed'] as const;

export const TICKET_PRIORITY_META: Record<string, { label: string; tone: BadgeTone }> = {
  high: { label: '紧急', tone: 'rose' },
  medium: { label: '一般', tone: 'yellow' },
  low: { label: '低', tone: 'green' },
};

export const TICKET_CATEGORY_META: Record<string, { label: string; tone: BadgeTone; hint: string }> = {
  bug: { label: '故障报错', tone: 'rose', hint: '功能异常、报错、无法使用' },
  feature: { label: '功能建议', tone: 'violet', hint: '希望新增或改进的功能' },
  account: { label: '账号问题', tone: 'blue', hint: '登录、绑定、权限、封禁' },
  billing: { label: '计费与额度', tone: 'yellow', hint: '订单、额度、发票' },
  other: { label: '其他', tone: 'slate', hint: '不属于以上分类的问题' },
};

export const TICKET_CATEGORY_ORDER = ['bug', 'feature', 'account', 'billing', 'other'] as const;

export const TICKET_SORT_OPTIONS = [
  { value: 'updated', label: '最近更新' },
  { value: 'created', label: '最新创建' },
  { value: 'oldest', label: '最久未更新' },
] as const;

/** 客服快捷回复：常见结论一键插入，减少重复打字与口径漂移。 */
export const QUICK_REPLIES: ReadonlyArray<{ label: string; content: string }> = [
  {
    label: '已收到，正在排查',
    content: '已收到你的反馈，我们正在排查。有进展会第一时间在这里同步，请留意工单回复。',
  },
  {
    label: '需要补充信息',
    content:
      '为了定位问题，还需要你补充以下信息：\n\n1. 操作步骤（越具体越好）\n2. 出现时间与大致频率\n3. 页面提示或报错截图\n4. 使用的浏览器 / 客户端版本\n\n补充后我们会继续跟进。',
  },
  {
    label: '已修复，请验证',
    content: '相关问题已修复并发布，请刷新页面或重新登录后重试。若仍能复现，请直接回复本工单，我们会继续跟进。',
  },
  {
    label: '属于已知限制',
    content:
      '你遇到的情况属于当前的已知限制，我们已经记录并在评估改进方案，有排期会在此同步。感谢你的理解与反馈。',
  },
  {
    label: '已转人工跟进',
    content: '你的工单已转交人工客服跟进，我们会尽快处理。期间如需补充信息，可直接回复本工单。',
  },
];

/** 创建工单时的常见问题模板：一键填好标题/分类/描述骨架。 */
export const TICKET_CREATE_TEMPLATES: ReadonlyArray<{
  key: string;
  label: string;
  title: string;
  category: string;
  description: string;
}> = [
  {
    key: 'login',
    label: '无法登录',
    title: '无法登录账号',
    category: 'account',
    description: '账号：\n使用的登录方式（密码 / Google / Linux.do / 通行密钥）：\n具体现象：\n页面提示：\n',
  },
  {
    key: 'tts',
    label: '语音合成失败',
    title: '语音合成失败 / 报错',
    category: 'bug',
    description: '使用的音色与模型：\n输入文本长度：\n具体现象与报错：\n出现时间：\n',
  },
  {
    key: 'quota',
    label: '额度/计费异常',
    title: '额度或计费异常',
    category: 'billing',
    description: '账号：\n期望的额度/计费结果：\n实际的额度/计费结果：\n相关订单号或时间：\n',
  },
  {
    key: 'bind',
    label: '第三方账号绑定',
    title: '第三方账号绑定问题',
    category: 'account',
    description: '第三方平台（Google / Linux.do）：\n要绑定的本站账号：\n具体现象与提示：\n',
  },
  {
    key: 'feature',
    label: '功能建议',
    title: '功能建议：',
    category: 'feature',
    description: '希望解决的问题：\n期望的功能形态：\n使用场景与频率：\n',
  },
];

/** 管理端待回复逾期判定：最后一条公开消息是用户发的，且已超过 SLA。 */
export function isTicketSlaBreached(ticket: {
  awaitingReply?: boolean;
  status?: string;
  lastMessageAt?: string | null;
}): boolean {
  if (!ticket.awaitingReply || ticket.status === 'closed' || !ticket.lastMessageAt) return false;
  const at = new Date(ticket.lastMessageAt).getTime();
  if (!Number.isFinite(at)) return false;
  return Date.now() - at > TICKET_SLA_HOURS * 3600 * 1000;
}

/** 列表卡片上的相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前 / 日期。 */
export function formatTicketTime(value?: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const diffMs = Date.now() - date.getTime();
  if (diffMs < 60_000) return '刚刚';
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return date.toLocaleDateString();
}

export function formatTicketAge(hours?: number): string {
  if (hours === undefined || hours === null || !Number.isFinite(hours)) return '';
  if (hours < 1) return '不足 1 小时';
  if (hours < 24) return `${Math.round(hours)} 小时`;
  return `${Math.round((hours / 24) * 10) / 10} 天`;
}
