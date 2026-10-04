import {
  DEFAULT_USER_LIST_FILTERS,
  PAGE_SIZE_OPTIONS,
  type UserListAccountStatusFilter,
  type UserListFilters,
  type UserListPagination,
  type UserListRoleFilter,
  type UserListSecurityFilter,
  type UserListStats,
  type UserListTicketFilter,
  type UserListTranslationFilter,
} from './UserFormControls';

export const SECURITY_RISK_BADGE_CLASS: Record<'good' | 'watch' | 'risk', string> = {
  good: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  watch: 'border-amber-200 bg-amber-50 text-amber-700',
  risk: 'border-rose-200 bg-rose-50 text-rose-700',
};

export const SECURITY_RISK_LABEL: Record<'good' | 'watch' | 'risk', string> = {
  good: '良好',
  watch: '待加固',
  risk: '高风险',
};

/** 第三方登录来源的中文展示名；原值仍保留在 title 里供排障。 */
export const AUTH_PROVIDER_LABELS: Record<string, string> = {
  local: '本地账号',
  linuxdo: 'LinuxDo 登录',
  google: 'Google 登录',
};

export const getErrorMessage = (error: unknown, fallback: string): string => {
  if (typeof error === 'object' && error !== null) {
    const maybe = error as { response?: { data?: { error?: string } }; message?: string };
    return maybe.response?.data?.error || maybe.message || fallback;
  }
  return fallback;
};

export interface FingerprintRecord {
  id: string;
  ts: number;
  ua?: string;
  ip?: string;
  deviceInfo?: {
    screen?: { w?: number; h?: number };
    timezone?: { tz?: string };
    navigator?: { userAgent?: string };
    [key: string]: unknown;
  };
}

export interface User {
  id: string;
  username: string;
  email: string;
  password: string;
  role: string;
  createdAt: string;
  dailyUsage?: number;
  lastUsageDate?: string;
  // G11-01: 列表接口不再返回会话级敏感字段（token/totpSecret/backupCodes 出参、
  // passkeyCredentials/pendingChallenge/currentChallenge 等），类型声明同步收窄。
  totpEnabled?: boolean;
  backupCodes?: string[];
  passkeyEnabled?: boolean;
  passkeyVerified?: boolean;
  avatarUrl?: string;
  authProvider?: 'local' | 'linuxdo' | 'google';
  linuxdoId?: string;
  linuxdoUsername?: string;
  linuxdoAvatarUrl?: string;
  requireFingerprint?: boolean;
  requireFingerprintAt?: number;
  // 服务端在用户列表每行已经算好安全评分 / 建议（services/accountSecuritySummaryService.ts），
  // 之前前端没有消费，这份逐行计算被白白丢弃；安全态势面板与列表徽标现在直接消费它。
  securitySummary?: {
    score: number;
    riskLevel: 'good' | 'watch' | 'risk';
    mfaEnabled: boolean;
    totpEnabled: boolean;
    passkeyEnabled: boolean;
    linkedProviderCount: number;
    fingerprintCount: number;
    lastLoginIp: string | null;
    accountStatus: 'active' | 'suspended';
    recommendations: Array<{
      id: string;
      label: string;
      detail: string;
      severity: 'info' | 'warning' | 'critical';
      action?: string;
    }>;
  };
  fingerprintRequestDismissedOnce?: boolean;
  fingerprintRequestDismissedAt?: number;
  fingerprints?: FingerprintRecord[];
  fingerprintCount?: number;
  latestFingerprint?: FingerprintRecord | null;
  lastLoginIp?: string;
  lastLoginAt?: string;
  ticketViolationCount?: number;
  ticketBannedUntil?: string;
  isTranslationEnabled?: boolean;
  translationAccessUntil?: string;
  accountStatus?: 'active' | 'suspended';
}

export interface UserListEnvelope {
  users: User[];
  pagination: UserListPagination;
  stats?: UserListStats;
  filteredStats?: UserListStats;
}

export const emptyUser: User = {
  id: '',
  username: '',
  email: '',
  password: '',
  role: 'user',
  createdAt: '',
  dailyUsage: 0,
  lastUsageDate: '',
  totpEnabled: false,
  backupCodes: [],
  passkeyEnabled: false,
  passkeyVerified: false,
  avatarUrl: '',
  requireFingerprint: false,
  requireFingerprintAt: 0,
  fingerprintRequestDismissedOnce: false,
  fingerprintRequestDismissedAt: 0,
  ticketViolationCount: 0,
  ticketBannedUntil: '',
  isTranslationEnabled: true,
  translationAccessUntil: '',
  accountStatus: 'active',
};

/** 把 URL 查询串还原成用户列表筛选条件（刷新/分享链接后不丢筛选）。 */
export const readUserListFilters = (params: URLSearchParams): UserListFilters => {
  const filters: UserListFilters = { ...DEFAULT_USER_LIST_FILTERS };
  const keyword = params.get('q');
  if (keyword) filters.keyword = keyword;
  const role = params.get('role');
  if (role) filters.role = role as UserListRoleFilter;
  const accountStatus = params.get('accountStatus');
  if (accountStatus) filters.accountStatus = accountStatus as UserListAccountStatusFilter;
  const security = params.get('security');
  if (security) filters.security = security as UserListSecurityFilter;
  const ticket = params.get('ticket');
  if (ticket) filters.ticket = ticket as UserListTicketFilter;
  const translation = params.get('translation');
  if (translation) filters.translation = translation as UserListTranslationFilter;
  const sortBy = params.get('sortBy');
  if (sortBy) filters.sortBy = sortBy;
  const sortOrder = params.get('sortOrder');
  if (sortOrder === 'asc' || sortOrder === 'desc') filters.sortOrder = sortOrder;
  const pageSize = Number(params.get('pageSize'));
  if (PAGE_SIZE_OPTIONS.includes(pageSize)) filters.pageSize = pageSize;
  return filters;
};

export const readUserListPage = (params: URLSearchParams): number => {
  const page = Number(params.get('page'));
  return Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1;
};

export const ROW_INITIAL = { opacity: 0, x: -20 } as const;
export const ROW_ANIMATE = { opacity: 1, x: 0 } as const;

export const cardClass =
  'rounded-2xl border border-slate-200 bg-white/82 shadow-sm backdrop-blur-xl';

export const glassInputClass =
  'w-full rounded-2xl border border-slate-200 bg-white/80 px-4 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 transition focus:border-slate-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-slate-300';

export const glassSelectClass =
  'w-full rounded-2xl border border-slate-200 bg-white/80 px-4 py-2.5 text-sm text-slate-900 transition focus:border-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-300';
