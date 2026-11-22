import type { AccountRiskChannel, AccountRiskTier } from '@/api/accountRisk';
import type { BadgeStyle } from '../ip-risk-log/format';

/**
 * 账户风险页的展示口径（纯常量与纯函数）。
 *
 * 与 `ip-risk-log/format.ts` 的分工：通用格式化（时间、计数、相对时间）直接复用那边，
 * 这里只放本页独有的枚举 → 文案/配色映射，避免两套同义常量各自漂移。
 *
 * 配色只允许 slate 中性色 + sky / emerald / amber / rose 语义色（设计语言闸门会卡）。
 */

export const TIER_ORDER: readonly AccountRiskTier[] = ['normal', 'watch', 'restricted', 'danger'];

export const TIER_CONFIG: Record<AccountRiskTier, BadgeStyle & { hint: string }> = {
  normal: {
    label: '正常',
    badgeClass: 'border-slate-200 bg-slate-100 text-slate-600',
    dotClass: 'bg-slate-400',
    hint: '没有任何未处置的风险信号。',
  },
  watch: {
    label: '观察',
    badgeClass: 'border-sky-200 bg-sky-50 text-sky-700',
    dotClass: 'bg-sky-500',
    hint: '有信号但不冻结功能；管理员可以在用户页继续观察或改为受限。',
  },
  restricted: {
    label: '受限',
    badgeClass: 'border-amber-200 bg-amber-50 text-amber-700',
    dotClass: 'bg-amber-500',
    hint: '算力 / 转写 / 兑换 / 上传 / LibreChat 被冻结，工单仍开放作为申诉入口。',
  },
  danger: {
    label: '危险',
    badgeClass: 'border-rose-200 bg-rose-50 text-rose-700',
    dotClass: 'bg-rose-500',
    hint: '连工单一起冻结，只能通过支持邮箱申诉；本档位不会由自动升档产生。',
  },
};

export const tierConfig = (tier: string | null | undefined): BadgeStyle & { hint: string } =>
  TIER_CONFIG[(tier as AccountRiskTier) ?? 'normal'] ?? TIER_CONFIG.normal;

export const ACCOUNT_STATUS_CONFIG: Record<'active' | 'suspended', BadgeStyle & { hint: string }> = {
  active: {
    label: '正常',
    badgeClass: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    dotClass: 'bg-emerald-500',
    hint: '账户可以正常登录。',
  },
  suspended: {
    label: '已封停',
    badgeClass: 'border-rose-200 bg-rose-50 text-rose-700',
    dotClass: 'bg-rose-500',
    hint: '登录返回 403 ACCOUNT_SUSPENDED；解除需走用户管理页的统一处置出口。',
  },
};

export const accountStatusConfig = (status: string | null | undefined): BadgeStyle & { hint: string } =>
  status === 'suspended' ? ACCOUNT_STATUS_CONFIG.suspended : ACCOUNT_STATUS_CONFIG.active;

/** 风险旗标的中文名。缺项回落到原始值（新旗标先出现时不会显示空白）。 */
export const RISK_FLAG_LABELS: Record<string, string> = {
  HIGH_RISK_LOGIN_IP: '高危登录 IP',
  MULTI_HIGH_RISK_IPS: '多个高危 IP',
  DATACENTER_LOGIN_IP: '机房 / IDC 出口',
  NEW_ACCOUNT: '新账号',
  COMPROMISED_DEVICE: '设备疑似失陷',
  ACCOUNT_ABUSE_EVENTS: '账户滥用事件',
  GEO_JUMP: '跨地域跳变',
  AUTOMATION_HINT: '自动化痕迹',
  PROBE_EXIT_MISMATCH: '出口不一致',
  ACCOUNT_SHARING_SUSPECTED: '疑似共享账号',
};

export const riskFlagLabel = (flag: string): string => RISK_FLAG_LABELS[flag] ?? flag;

export const RISK_FLAG_HINTS: Record<string, string> = {
  HIGH_RISK_LOGIN_IP: '登录 IP 的风险分达到 accountRisk.highRiskIpScore（与 proxycheck 挑战阈值同口径）。',
  MULTI_HIGH_RISK_IPS: '不同高危 IP 的数量达到 accountRisk.minDistinctHighRiskIps，单条高危 IP 不判。',
  DATACENTER_LOGIN_IP: '已登录请求命中机房 / IDC 出口（RC-14）；是否升档由 accountRisk.ipRecheckEnabled 控制。',
  NEW_ACCOUNT: '注册不足 accountRisk.newAccountWatchDays 天。',
  COMPROMISED_DEVICE: '设备台账里存在被判定失陷 / 被 root 的设备。',
  ACCOUNT_ABUSE_EVENTS: '窗口内存在已认证路径产生的 ACCOUNT_ABUSE_* 事件。',
  GEO_JUMP: '会话属地跨国家 / 省跳变（RC-15，窗口取 min(windowDays, 7) 天）。',
  AUTOMATION_HINT: '客户端上报 navigator.webdriver 或 Chrome 系 UA 缺 UA-CH（RC-57，固定权重，单独不升档）。',
  PROBE_EXIT_MISMATCH: 'WebRTC 出口与服务端出口不一致（RC-26/56，只作加权；需 ipRecheckEnabled 才读取）。',
  ACCOUNT_SHARING_SUSPECTED: '拼车 / 共享账号三条件联立或同一设备分量跨账户出现（RC-17）。',
};

/** 信号事件类型 → 可读名。前缀规则与 `ACCOUNT_ABUSE_EVENT_PREFIX` 一致。 */
export const EVENT_TYPE_LABELS: Record<string, string> = {
  ACCOUNT_ABUSE_IDC_EGRESS: 'IDC 出口命中',
  ACCOUNT_ABUSE_GEO_JUMP: '跨地域跳变',
  ACCOUNT_ABUSE_CAPTCHA_FAILED: '人机验证失败',
  ACCOUNT_ABUSE_STEP_UP_FAILED: '逐步验证失败',
  ACCOUNT_ABUSE_STEP_UP_EXPIRED: '逐步验证过期',
  ACCOUNT_ABUSE_LIBRECHAT: 'LibreChat 违规',
  ACCOUNT_ABUSE_UNSPECIFIED: '未分类滥用信号',
  AUTOMATION_TRACE: '自动化痕迹',
  ACCOUNT_RISK_ACTION: '风险处置',
  ACCOUNT_RISK_TIER_CHANGED: '档位变化',
};

export const eventTypeLabel = (eventType: string): string => EVENT_TYPE_LABELS[eventType] ?? eventType;

/** 处置动作 → 可读名（与 `applyAccountRiskAction` 的动作集合一一对应）。 */
export const ACTION_LABELS: Record<string, string> = {
  mark_watch: '标记观察',
  restrict: '设为受限',
  require_step_up: '强制逐步验证',
  suspend: '封停账户',
  unban: '解除封停',
  clear_flags: '清除旗标',
};

export const actionLabel = (action: string | null | undefined): string =>
  action ? (ACTION_LABELS[action] ?? action) : '-';

export const ACTION_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: '全部动作' },
  ...Object.entries(ACTION_LABELS).map(([value, label]) => ({ value, label })),
];

export const TIER_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: '全部档位' },
  ...TIER_ORDER.map((tier) => ({ value: tier, label: TIER_CONFIG[tier].label })),
];

export const STATUS_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: '全部状态' },
  { value: 'active', label: '正常' },
  { value: 'suspended', label: '已封停' },
];

export const ACCOUNT_SORT_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'risk_desc', label: '按风险分' },
  { value: 'recent', label: '最近评估' },
  { value: 'created', label: '账号创建时间' },
];

export const SIGNAL_SORT_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'recent', label: '最新在前' },
  { value: 'oldest', label: '最早在前' },
];

export const DATACENTER_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: '全部出口' },
  { value: 'true', label: '仅 IDC / 机房' },
  { value: 'false', label: '排除 IDC' },
];

export const RISK_LEVEL_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: '全部风险等级' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
  { value: 'critical', label: '严重' },
];

/** 通道株连矩阵里的通道名。 */
export const CHANNEL_LABELS: Record<AccountRiskChannel, string> = {
  tts_generate: 'TTS 生成',
  transcribe: '语音转写',
  cdk_redeem: 'CDK 兑换',
  file_upload: '文件上传',
  librechat: 'LibreChat',
  ticket: '工单',
};

/** 一键筛选用：概览卡片点击后跳到对应列表页签的查询串。 */
export interface AccountRiskQuickFilter {
  tab: 'accounts' | 'signals' | 'ip-facts' | 'actions';
  tier?: string;
  status?: string;
  flag?: string;
  eventType?: string;
  datacenter?: 'true' | 'false';
  action?: string;
  anonymous?: boolean;
}

export const RISK_ACTION_EVENT_TYPES = ['ACCOUNT_RISK_ACTION', 'ACCOUNT_RISK_TIER_CHANGED'] as const;

export const isRiskActionEvent = (eventType: string): boolean =>
  (RISK_ACTION_EVENT_TYPES as readonly string[]).includes(eventType);
