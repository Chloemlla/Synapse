import React from 'react';
import { FaCheckCircle } from 'react-icons/fa';
import type { PolicyConsentRow, PolicyConsentSource, PolicyConsentState } from '@/api/policyConsents';
import type { BadgeStyle } from '../ip-risk-log/format';

/**
 * 政策同意面板的共享展示件（格式、徽标、来源文案）。
 * 概览与逐条记录两个 tab 都要用，拆出来避免各写一份而慢慢分叉。
 */

export const VALID_BADGE: BadgeStyle = {
  label: '有效',
  badgeClass: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  dotClass: 'bg-emerald-500',
};
export const EXPIRED_BADGE: BadgeStyle = {
  label: '已过期',
  badgeClass: 'border-slate-200 bg-slate-100 text-slate-500',
  dotClass: 'bg-slate-400',
};
export const INVALID_BADGE: BadgeStyle = {
  label: '已失效',
  badgeClass: 'border-orange-200 bg-orange-50 text-orange-700',
  dotClass: 'bg-orange-500',
};

/** 一条记录的状态徽标：先判是否置无效（撤回/顶替），再判是否过期，否则有效。 */
export const consentBadge = (row: PolicyConsentRow): BadgeStyle => {
  if (!row.isValid) return row.revokedAt ? { ...INVALID_BADGE, label: '已撤回' } : INVALID_BADGE;
  if (row.expired) return EXPIRED_BADGE;
  return VALID_BADGE;
};

const SOURCE_LABELS: Record<string, string> = {
  login: '登录',
  register: '注册',
  feature: 'TTS 门禁',
};

export const sourceLabel = (source: string): string => SOURCE_LABELS[source] ?? (source || '（未知）');

export const SOURCE_FILTER_OPTIONS: ReadonlyArray<{ value: PolicyConsentSource | ''; label: string }> = [
  { value: '', label: '全部来源' },
  { value: 'login', label: '登录' },
  { value: 'register', label: '注册' },
  { value: 'feature', label: 'TTS 门禁' },
];

export const STATE_FILTER_OPTIONS: ReadonlyArray<{ value: PolicyConsentState; label: string }> = [
  { value: 'valid', label: '仅有效' },
  { value: 'expired', label: '仅已过期/失效' },
  { value: 'all', label: '全部' },
];

export const TREND_WINDOW_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 7, label: '近 7 天' },
  { value: 30, label: '近 30 天' },
  { value: 90, label: '近 90 天' },
];

export const formatIso = (value: string | null): string =>
  value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '-';

export const Mono: React.FC<{ value: string | null | undefined; title?: string; max?: number }> = ({
  value,
  title,
  max,
}) => {
  const display = value && max && value.length > max ? `${value.slice(0, max)}…` : value;
  return (
    <span className="font-mono text-[11px] text-slate-600" title={title ?? value ?? undefined}>
      {display || '-'}
    </span>
  );
};

/** 勾选完整性单元格：四份齐全 / 缺哪几份 / 老记录没有该字段。 */
export const AgreementsCell: React.FC<{ row: PolicyConsentRow }> = ({ row }) => {
  if (row.agreementsComplete) {
    return (
      <span className="inline-flex items-center gap-1.5 text-emerald-700">
        <FaCheckCircle className="text-[11px]" />
        <span className="text-xs font-semibold">四项齐全</span>
      </span>
    );
  }
  if (row.agreements.length === 0) {
    return (
      <span className="text-xs text-slate-400" title="老记录没有 agreements 字段">
        未记录
      </span>
    );
  }
  return (
    <span className="text-xs text-amber-700" title={row.agreements.join(', ')}>
      {row.agreements.length} / 4 项
    </span>
  );
};
