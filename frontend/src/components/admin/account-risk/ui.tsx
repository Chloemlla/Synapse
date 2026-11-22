import React, { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { FaExclamationTriangle } from 'react-icons/fa';
import { cn } from '@/lib/utils';
import { InfoBadge } from '@/components/studioTheme';
import { StudioErrorNote } from '@/components/studioFeedback';
import { Badge } from '../ip-risk-log/ui';
import { formatCount } from '../ip-risk-log/format';
import { riskFlagLabel, RISK_FLAG_HINTS, tierConfig } from './format';

/**
 * 账户风险页的本地 UI 原语。
 *
 * 绝大多数表格/筛选/四态原语直接复用 `admin/ip-risk-log/ui.tsx`：两个页面解决的是同一类问题
 * （把某个集合摊开给管理员排查），复制一套只会让两边的密度与无障碍行为慢慢分叉。
 * 这里只补本页独有的：URL 筛选同步、风险档徽标、风险分与旗标展示。
 */

export {
  Badge,
  Chip,
  Collapsible,
  DataPanel,
  FieldGrid,
  FieldRow,
  FilterSelect,
  JsonBlock,
  Pager,
  RefreshButton,
  TableState,
  TableWrap,
  Td,
  Th,
} from '../ip-risk-log/ui';

export { CopyIconButton } from '../crash-reports/ui';

/**
 * 筛选状态 ↔ URL 查询串双向同步。
 *
 * 为什么要同步：管理员排查时会把「受限档 + 某用户」的链接发给同事，刷新后筛选也必须还在。
 * 用 `replace` 而不是 `push`：筛选是同一个页面的视图变化，不该在浏览器历史里堆几十条记录。
 *
 * `defaults` 必须是模块级常量（对象身份稳定），否则 memo 每次都会失效。
 */
export function useUrlFilters<K extends string>(
  defaults: Record<K, string>,
): readonly [Record<K, string>, (patch: Partial<Record<K, string>>) => void] {
  const [searchParams, setSearchParams] = useSearchParams();

  const value = useMemo(() => {
    const next: Record<K, string> = { ...defaults };
    for (const key of Object.keys(defaults) as K[]) {
      const raw = searchParams.get(key);
      if (raw !== null) next[key] = raw;
    }
    return next;
  }, [searchParams, defaults]);

  const patch = useCallback(
    (next: Partial<Record<K, string>>) => {
      const params = new URLSearchParams(searchParams);
      for (const [key, raw] of Object.entries(next) as Array<[K, string | undefined]>) {
        if (raw === undefined || raw === '') {
          params.delete(key);
          continue;
        }
        if (raw === defaults[key]) params.delete(key);
        else params.set(key, raw);
      }
      setSearchParams(params, { replace: true });
    },
    [defaults, searchParams, setSearchParams],
  );

  return [value, patch] as const;
}

/** 风险档徽标：配色与文案来自 format.ts，避免各页签各写一份。 */
export const TierBadge: React.FC<{ tier: string | null | undefined; className?: string }> = ({ tier, className }) => {
  const config = tierConfig(tier);
  return <Badge style={config} className={className} title={config.hint} />;
};

/** 风险分展示：`null`（没有结论）与 `0`（确认无风险）必须区分开。 */
export const RiskScoreCell: React.FC<{ score: number | null | undefined; className?: string }> = ({
  score,
  className,
}) => {
  if (score === null || score === undefined) {
    return (
      <span className={cn('text-slate-400', className)} title="该条没有风险结论（缓存未命中且未补查）">
        无结论
      </span>
    );
  }
  const tone = score >= 80 ? 'text-rose-700' : score >= 50 ? 'text-amber-700' : 'text-slate-700';
  return (
    <span className={cn('font-semibold tabular-nums', tone, className)} title={`riskScore ${score}（越高越危险）`}>
      {formatCount(score)}
    </span>
  );
};

/** 旗标列表：超过 `max` 个时折叠成「+N」，完整清单在展开行里。 */
export const FlagList: React.FC<{ flags: string[]; max?: number }> = ({ flags, max = 3 }) => {
  if (!flags || flags.length === 0) return <span className="text-slate-400">-</span>;
  const shown = flags.slice(0, max);
  const rest = flags.length - shown.length;
  return (
    <span className="flex flex-wrap gap-1">
      {shown.map((flag) => (
        <InfoBadge key={flag} tone="slate" className="whitespace-nowrap" >
          <span title={RISK_FLAG_HINTS[flag] ?? flag}>{riskFlagLabel(flag)}</span>
        </InfoBadge>
      ))}
      {rest > 0 ? (
        <InfoBadge tone="slate" className="whitespace-nowrap">{`+${rest}`}</InfoBadge>
      ) : null}
    </span>
  );
};

/** 内联错误条：保留已加载数据时用它，整块失败用 StudioErrorState。 */
export const InlineError: React.FC<{ message: string; onRetry: () => void; retryLabel?: string }> = ({
  message,
  onRetry,
  retryLabel = '重试',
}) => (
  <StudioErrorNote className="flex flex-wrap items-center gap-3">
    <FaExclamationTriangle className="shrink-0" aria-hidden />
    <span className="min-w-0 flex-1 break-words">{message}</span>
    <button
      type="button"
      onClick={onRetry}
      className="shrink-0 rounded-full border border-rose-300 bg-white/70 px-3 py-1 text-xs font-semibold text-rose-700 hover:bg-white"
    >
      {retryLabel}
    </button>
  </StudioErrorNote>
);
