import React from 'react';
import { InfoBadge } from './studioTheme';
import type { LibreChatQuotaView } from '../api/librechatQuota';

interface IndicatorProps {
  quota: LibreChatQuotaView | null;
  loading: boolean;
  error?: string | null;
  isAdmin?: boolean;
}

/** 与后端 403 文案同一时区（额度按上海自然日归桶），避免同一件事出现两个恢复时刻。 */
function formatBannedUntil(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/**
 * 今日额度徽标：只讲「现在什么状态」（剩余几次 / 暂停到何时），不铺实现原理。
 * 主页 hero 的 meta 区用。
 */
export const LibreChatQuotaBadge: React.FC<IndicatorProps> = ({ quota, loading, isAdmin }) => {
  if (isAdmin) return <InfoBadge tone="slate">管理员不受对话额度限制</InfoBadge>;
  if (quota?.banned) {
    const until = formatBannedUntil(quota.bannedUntil);
    return <InfoBadge tone="rose">{until ? `对话权限已暂停，${until} 恢复` : '对话权限已暂停'}</InfoBadge>;
  }
  if (quota) {
    return (
      <InfoBadge tone={quota.remaining > 0 ? 'emerald' : 'amber'}>
        {`今日剩余 ${quota.remaining} / ${quota.dailyLimit} 次`}
      </InfoBadge>
    );
  }
  return <InfoBadge tone="slate">{loading ? '额度加载中…' : '额度暂时未知'}</InfoBadge>;
};

/**
 * 发送区的额度明细：剩余次数 + 进度条 + 超额警告 / 暂停提示。
 * 发送或重试后端返回后由页面把新额度写回，因此这里的数字会即时变化。
 */
export const LibreChatQuotaPanel: React.FC<IndicatorProps> = ({ quota, loading, error, isAdmin }) => {
  if (isAdmin) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white/80 p-3 text-sm text-slate-600">
        管理员不受每日对话额度限制。
      </div>
    );
  }

  if (!quota) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white/80 p-3 text-sm text-slate-500">
        {loading ? '正在读取今日额度…' : '今日额度暂时获取不到，发送消息或收到回复后会自动重试。'}
      </div>
    );
  }

  const usedRatio = quota.dailyLimit > 0 ? Math.min(1, Math.max(0, quota.used / quota.dailyLimit)) : 0;
  const barTone = quota.banned
    ? 'bg-rose-500'
    : quota.remaining > 0
      ? 'bg-emerald-500'
      : 'bg-amber-500';
  const bannedUntilLabel = formatBannedUntil(quota.bannedUntil);

  return (
    <div className="space-y-2 rounded-2xl border border-slate-200 bg-white/80 p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium text-slate-700">今日对话额度</span>
        <span className="text-slate-600">剩余 {quota.remaining} / {quota.dailyLimit} 次</span>
      </div>
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100"
        role="progressbar"
        aria-label="今日对话额度已用比例"
        aria-valuemin={0}
        aria-valuemax={quota.dailyLimit}
        aria-valuenow={quota.used}
      >
        <div className={`h-full rounded-full transition-all ${barTone}`} style={{ width: `${usedRatio * 100}%` }} />
      </div>
      {quota.banned ? (
        <p className="text-rose-600">
          {bannedUntilLabel
            ? `对话权限已暂停，将于 ${bannedUntilLabel} 恢复。期间仍可查看与管理历史记录。`
            : '对话权限已暂停，期间仍可查看与管理历史记录。'}
        </p>
      ) : quota.warnings > 0 ? (
        <p className="text-amber-600">
          已收到 {quota.warnings} / {quota.maxWarnings} 次超额警告，继续对话将被暂停一天。
        </p>
      ) : null}
      {error ? <p className="text-xs text-slate-400">{error}，当前显示的是最近一次的额度。</p> : null}
    </div>
  );
};
