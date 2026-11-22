import type { BadgeStyle } from '../ip-risk-log/format';

/**
 * 限流/配额页的展示口径。
 *
 * 通用格式化（时间、计数、相对时间）复用 `ip-risk-log/format.ts`；这里只放本页独有的映射。
 * 配色只允许 slate 中性色 + sky / emerald / amber / rose 语义色。
 */

export const QUOTA_SCOPE_LABELS: Record<string, string> = {
  key: 'API Key',
  account: '账户预算',
  upstream: '上游额度',
};

export const quotaScopeLabel = (scope: string): string => QUOTA_SCOPE_LABELS[scope] ?? scope;

/** 资源名 → 可读名；未知值原样显示（新资源先上线时不至于空白）。 */
export const QUOTA_RESOURCE_LABELS: Record<string, string> = {
  'api-key-balance': 'API Key 余额',
  'account-daily-budget': '账户日预算',
  'account-monthly-budget': '账户月预算',
  'upstream-quota': '上游额度',
};

export const quotaResourceLabel = (resource: string): string => QUOTA_RESOURCE_LABELS[resource] ?? resource;

export const QUOTA_SCOPE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: '全部范围' },
  { value: 'key', label: 'API Key' },
  { value: 'account', label: '账户预算' },
  { value: 'upstream', label: '上游额度' },
];

export const QUOTA_THRESHOLD_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: '全部阈值' },
  { value: '0.8', label: '80% 预警' },
  { value: '1', label: '100% 用尽' },
];

export const SINCE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: '全部时间' },
  { value: '1', label: '最近 24 小时' },
  { value: '7', label: '最近 7 天' },
  { value: '30', label: '最近 30 天' },
  { value: '180', label: '最近 180 天（事件保留期）' },
];

export const LADDER_STATE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: '全部账户' },
  { value: 'banned', label: '封禁中' },
  { value: 'active', label: '未封禁' },
];

export const sinceToIso = (days: string): string | undefined => {
  if (!days) return undefined;
  const num = Number(days);
  if (!Number.isFinite(num) || num <= 0) return undefined;
  return new Date(Date.now() - num * 24 * 60 * 60 * 1000).toISOString();
};

/** 阈值徽标：0.8 = 预警（amber），1 = 用尽（rose）。 */
export const thresholdStyle = (threshold: number | null): BadgeStyle => {
  if (threshold === null) {
    return { label: '未知', badgeClass: 'border-slate-200 bg-slate-100 text-slate-600', dotClass: 'bg-slate-400' };
  }
  if (threshold >= 1) {
    return { label: '100% 用尽', badgeClass: 'border-rose-200 bg-rose-50 text-rose-700', dotClass: 'bg-rose-500' };
  }
  return { label: '80% 预警', badgeClass: 'border-amber-200 bg-amber-50 text-amber-700', dotClass: 'bg-amber-500' };
};

/** 窗口时长：限流器窗口用人类的说法（秒 / 分 / 时）。 */
export const formatWindow = (windowMs: number): string => {
  if (!Number.isFinite(windowMs) || windowMs <= 0) return '-';
  if (windowMs < 60_000) return `${Math.round(windowMs / 1000)} 秒`;
  if (windowMs < 3_600_000) return `${Math.round(windowMs / 60_000)} 分钟`;
  return `${Math.round((windowMs / 3_600_000) * 10) / 10} 小时`;
};

/** 字节：沿用 GeoGebra 面板的 1024 进制写法，但保留 KiB/MiB/GiB 语义。 */
export const formatBytes = (bytes: number | null | undefined): string => {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
};

/** 占用率 → 语义色（≥90% rose，≥60% amber，其余 emerald）。 */
export const utilizationTone = (ratio: number): 'rose' | 'amber' | 'emerald' =>
  ratio >= 0.9 ? 'rose' : ratio >= 0.6 ? 'amber' : 'emerald';

export const utilizationBarClass = (ratio: number): string =>
  ratio >= 0.9 ? 'bg-rose-500' : ratio >= 0.6 ? 'bg-amber-500' : 'bg-emerald-500';
