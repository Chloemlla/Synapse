import { FaSync } from 'react-icons/fa';
import { studioPanelClassName, studioSecondaryButtonClassName } from '@/components/studioTheme';
import {
  PROVIDER_ORDER,
  formatQuota,
  toDateText,
  type ProviderRow,
  type QuotaHistoryEntry,
  type QuotaSnapshot,
  type TabActions,
} from './types';

export interface QuotaTabProps extends TabActions {
  rows: ProviderRow[];
  quotas: QuotaSnapshot[] | null;
  history: QuotaHistoryEntry[];
  months: number;
  onMonthsChange: (months: number) => void;
  loading: boolean;
  onRefresh: () => void;
}

const MONTH_CHOICES = [3, 6, 12] as const;

export default function QuotaTab(props: QuotaTabProps) {
  const { canWrite, rows, history, months, onMonthsChange, loading, onRefresh } = props;

  const maxCount = Math.max(1, ...history.map((entry) => entry.count));

  return (
    <div className="space-y-6">
      <section className={`${studioPanelClassName} p-5`}>
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold text-slate-800">本月额度</h3>
            <p className="mt-1 text-sm leading-6 text-slate-600">
              口径与 proxycheck 限额一致：<b>先算额度再外呼</b>，用尽即不再调用并落一条 trace；
              下月 1 日 00:00（北京时间）自动归零。0 = 不限额（只计数不拦截）。
            </p>
          </div>
          <div className="flex items-center gap-2">
            {MONTH_CHOICES.map((choice) => (
              <button
                key={choice}
                type="button"
                onClick={() => onMonthsChange(choice)}
                className={`rounded-full border px-3 py-1 text-xs ${
                  months === choice ? 'border-slate-800 bg-slate-800 text-white' : 'border-slate-200 text-slate-600'
                }`}
              >
                {choice} 个月
              </button>
            ))}
            <button type="button" onClick={onRefresh} disabled={loading} className={studioSecondaryButtonClassName}>
              <FaSync className="mr-2 inline h-3 w-3" /> {loading ? '刷新中...' : '刷新'}
            </button>
          </div>
        </header>

        <div className="mt-4 grid gap-4 lg:grid-cols-3">
          {PROVIDER_ORDER.map((provider) => {
            const row = rows.find((entry) => entry.provider === provider);
            const quota = row?.quota;
            return (
              <div key={provider} className="rounded-2xl border border-slate-200 p-4">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold text-slate-800">{row?.label ?? provider}</p>
                  <span className={quota?.exhausted ? 'text-xs text-rose-600' : 'text-xs text-slate-500'}>
                    {quota?.exhausted ? '已用尽' : quota && quota.limit > 0 ? `${quota.percentage}%` : '不限额'}
                  </span>
                </div>
                {quota && (
                  <>
                    <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-slate-100">
                      <div
                        className={`h-full rounded-full ${quota.exhausted ? 'bg-rose-500' : 'bg-emerald-500'}`}
                        style={{ width: `${quota.limit > 0 ? Math.min(100, quota.percentage) : 0}%` }}
                      />
                    </div>
                    <p className="mt-2 text-xs text-slate-600">{formatQuota(quota)}</p>
                    <dl className="mt-2 space-y-1 text-[11px] text-slate-500">
                      <div className="flex justify-between gap-2">
                        <dt>重置时间</dt>
                        <dd>{toDateText(quota.resetsAt)}</dd>
                      </div>
                      <div className="flex justify-between gap-2">
                        <dt>最近一次外呼</dt>
                        <dd>{toDateText(quota.lastUsedAt)}</dd>
                      </div>
                      {quota.exhaustedAt && (
                        <div className="flex justify-between gap-2">
                          <dt>用尽时间</dt>
                          <dd>{toDateText(quota.exhaustedAt)}</dd>
                        </div>
                      )}
                    </dl>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <section className={`${studioPanelClassName} p-5`}>
        <h3 className="text-base font-semibold text-slate-800">逐月用量（近 {months} 个月）</h3>
        {history.length === 0 ? (
          <p className="mt-3 text-xs text-slate-500">
            还没有用量记录。{canWrite ? '' : '（只读账号也能看到这里的数据）'}
          </p>
        ) : (
          <div className="mt-4 space-y-4">
            {PROVIDER_ORDER.map((provider) => {
              const entries = history.filter((entry) => entry.provider === provider).slice(0, months);
              if (entries.length === 0) return null;
              return (
                <div key={provider}>
                  <p className="text-xs font-medium text-slate-700">{rows.find((row) => row.provider === provider)?.label ?? provider}</p>
                  <div className="mt-2 flex items-end gap-3">
                    {entries
                      .slice()
                      .reverse()
                      .map((entry) => (
                        <div key={`${entry.provider}-${entry.monthKey}`} className="flex w-16 flex-col items-center gap-1">
                          <div className="flex h-24 w-full items-end justify-center rounded-lg bg-slate-50">
                            <div
                              className="w-6 rounded-t bg-slate-700"
                              style={{ height: `${Math.max(2, Math.round((entry.count / maxCount) * 96))}px` }}
                              title={`${entry.count} 次`}
                            />
                          </div>
                          <span className="text-[11px] text-slate-600">{entry.count}</span>
                          <span className="text-[10px] text-slate-400">{entry.monthKey}</span>
                        </div>
                      ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
