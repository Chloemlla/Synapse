import React from 'react';
import { cn } from '@/lib/utils';
import { InfoBadge } from '@/components/studioTheme';
import { utilizationBarClass, utilizationTone } from './format';

/**
 * 限流/配额页的本地原语。
 *
 * 表格、筛选、分页、四态继续复用 `admin/ip-risk-log/ui.tsx`（同一类问题的同一套密度），
 * 这里只补「占用率进度条」这一个本页独有的组件。
 */
export {
  Badge,
  Chip,
  Collapsible,
  DataPanel,
  FieldGrid,
  FieldRow,
  FilterSelect,
  InlineError,
  JsonBlock,
  Pager,
  RefreshButton,
  TableState,
  TableWrap,
  Td,
  Th,
  useUrlFilters,
} from '../account-risk/ui';

export { useErrorNotice } from '../ip-risk-log/ui';

/** 占用率条：`active / max`，超顶时条满并标红。 */
export const UtilizationBar: React.FC<{ active: number; max: number; className?: string }> = ({
  active,
  max,
  className,
}) => {
  const ratio = max > 0 ? Math.min(1, active / max) : 0;
  const percent = Math.round(ratio * 100);
  const tone = utilizationTone(ratio);
  return (
    <div className={cn('flex min-w-0 items-center gap-2', className)}>
      <div
        className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-slate-100"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-label={`占用 ${percent}%`}
      >
        <div className={cn('h-full rounded-full transition-all', utilizationBarClass(ratio))} style={{ width: `${Math.max(percent, active > 0 ? 3 : 0)}%` }} />
      </div>
      <InfoBadge tone={tone} className="shrink-0 whitespace-nowrap tabular-nums">
        {active} / {max}
      </InfoBadge>
    </div>
  );
};
