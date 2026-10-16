import React, { useCallback, useEffect, useState } from 'react';
import { FaListUl, FaRedo, FaSearch } from 'react-icons/fa';
import { qqGuardApi } from '../../../api/qqGuard';
import type { QqGuardAuditRow } from '../../../api/qqGuard';
import {
  InfoSectionTitle,
  studioFieldClassName,
  studioPrimaryButtonClassName,
  studioSecondaryButtonClassName,
  studioSurfaceClassName,
} from '../../studioTheme';
import {
  StudioEmptyState,
  StudioErrorNote,
  StudioErrorState,
  StudioLoadingState,
  StudioPager,
} from '../../studioFeedback';
import { cx, eventBadge, formatDateTime, shortText, rowGhostButtonClassName } from './ui';

const PAGE_SIZE = 30;

const EVENT_OPTIONS = [
  'message',
  'moderate',
  'violation',
  'recalled',
  'recall_failed',
  'dm_sent',
  'dm_suppressed',
  'dm_failed',
  'pass',
  'review_pending',
  'review_clean',
  'review_violated',
  'exempted',
  'command',
  'bot_offline',
  'bot_recovered',
];

/** 事件枚举的中文展示名；原始值保留在 option 的 title 里供排障搜索。 */
const EVENT_LABELS: Record<string, string> = {
  message: '收到消息',
  moderate: 'AI 裁决',
  violation: '判定违规',
  recalled: '已撤回',
  recall_failed: '撤回失败',
  dm_sent: '已私信通知',
  dm_suppressed: '私信已抑制',
  dm_failed: '私信发送失败',
  pass: '放行',
  review_pending: '待复核',
  review_clean: '复核通过',
  review_violated: '复核违规',
  exempted: '豁免',
  command: '面板命令',
  bot_offline: 'Bot 离线',
  bot_recovered: 'Bot 恢复',
};

const VERDICT_LABELS: Record<string, string> = {
  violated: '违规',
  clean: '正常',
  undetermined: '未判定',
};

interface FilterState {
  fTrace: string;
  fUser: string;
  fGroup: string;
  fEvent: string;
  fVerdict: string;
}

const EMPTY_FILTERS: FilterState = { fTrace: '', fUser: '', fGroup: '', fEvent: '', fVerdict: '' };

interface AuditLogPanelProps {
  onOpenTrace: (traceId: string) => void;
}

export const AuditLogPanel: React.FC<AuditLogPanelProps> = ({ onOpenTrace }) => {
  const [rows, setRows] = useState<QqGuardAuditRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [fTrace, setFTrace] = useState('');
  const [fUser, setFUser] = useState('');
  const [fGroup, setFGroup] = useState('');
  const [fEvent, setFEvent] = useState('');
  const [fVerdict, setFVerdict] = useState('');
  const [page, setPage] = useState(1);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const currentFilters = (): FilterState => ({ fTrace, fUser, fGroup, fEvent, fVerdict });

  const load = useCallback(async (targetPage: number, params: FilterState) => {
    setLoading(true);
    setError(null);
    try {
      const { audits, total: t } = await qqGuardApi.audits({
        page: targetPage,
        limit: PAGE_SIZE,
        traceId: params.fTrace || undefined,
        userId: params.fUser || undefined,
        groupId: params.fGroup || undefined,
        event: params.fEvent || undefined,
        verdict: params.fVerdict || undefined,
      });
      setRows(audits);
      setTotal(t);
    } catch (err) {
      setError('审计加载失败，请稍后重试');
      console.error('加载 QQ 群审计失败:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(1, EMPTY_FILTERS);
  }, [load]);

  const applySearch = (e: React.FormEvent) => {
    e.preventDefault();
    setPage(1);
    void load(1, currentFilters());
  };

  const refresh = () => void load(page, currentFilters());

  const goTo = (p: number) => {
    if (p < 1 || p > totalPages) return;
    setPage(p);
    void load(p, currentFilters());
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <InfoSectionTitle
          title="审计日志"
          description="bot 回推 + AI 裁决 + 面板命令的完整留痕。点 traceId 看单条消息的操作时间线。"
          icon={FaListUl}
          tone="slate"
        />
        <button type="button" onClick={refresh} disabled={loading} className={studioSecondaryButtonClassName}>
          <FaRedo className="text-sm" />
          刷新
        </button>
      </div>

      <form
        onSubmit={applySearch}
        className="grid grid-cols-2 gap-2.5 rounded-2xl border border-slate-100 bg-white p-3 sm:grid-cols-3 lg:grid-cols-6"
      >
        <input
          value={fTrace}
          onChange={(e) => setFTrace(e.target.value)}
          placeholder="traceId"
          aria-label="按 traceId 筛选"
          className={`${studioFieldClassName} col-span-2 py-2 text-xs sm:col-span-1`}
        />
        <input
          value={fUser}
          onChange={(e) => setFUser(e.target.value)}
          placeholder="QQ号"
          aria-label="按 QQ 号筛选"
          className={`${studioFieldClassName} py-2 text-xs`}
        />
        <input
          value={fGroup}
          onChange={(e) => setFGroup(e.target.value)}
          placeholder="群号"
          aria-label="按群号筛选"
          className={`${studioFieldClassName} py-2 text-xs`}
        />
        <select
          value={fEvent}
          onChange={(e) => setFEvent(e.target.value)}
          aria-label="按事件类型筛选"
          className={`${studioFieldClassName} py-2 text-xs`}
        >
          <option value="">全部事件</option>
          {EVENT_OPTIONS.map((ev) => (
            <option key={ev} value={ev} title={ev}>
              {EVENT_LABELS[ev] ?? ev}
            </option>
          ))}
        </select>
        <select
          value={fVerdict}
          onChange={(e) => setFVerdict(e.target.value)}
          aria-label="按 AI 判定筛选"
          className={`${studioFieldClassName} py-2 text-xs`}
        >
          <option value="">全部判定</option>
          <option value="violated" title="violated">{VERDICT_LABELS.violated}</option>
          <option value="clean" title="clean">{VERDICT_LABELS.clean}</option>
          <option value="undetermined" title="undetermined">{VERDICT_LABELS.undetermined}</option>
        </select>
        <button type="submit" className={cx(studioPrimaryButtonClassName, 'col-span-2 sm:col-span-1')}>
          <FaSearch className="text-xs" />
          查询
        </button>
      </form>

      {error ? (
        <StudioErrorNote className="flex flex-wrap items-center gap-3">
          <span className="min-w-0 flex-1">{error}</span>
          <button type="button" onClick={refresh} className={rowGhostButtonClassName}>
            重试
          </button>
        </StudioErrorNote>
      ) : null}

      <div className={cx(studioSurfaceClassName, 'overflow-hidden')}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                <th className="px-4 py-3">时间</th>
                <th className="px-4 py-3">事件</th>
                <th className="px-4 py-3">traceId</th>
                <th className="px-4 py-3">成员</th>
                <th className="px-4 py-3">内容摘要</th>
                <th className="px-4 py-3">说明</th>
              </tr>
            </thead>
            <tbody>
              {loading && rows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-6">
                    <StudioLoadingState minHeightClassName="min-h-[180px]" text="正在读取审计日志…" />
                  </td>
                </tr>
              ) : error && rows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-6">
                    <StudioErrorState message={error} onRetry={refresh} />
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-6">
                    <StudioEmptyState
                      className="py-10"
                      message="还没有审计记录。等到机器人在群里处理过消息（或下发过命令）后，回本页点「刷新」。"
                    />
                  </td>
                </tr>
              ) : (
                rows.map((row, i) => {
                  const badge = eventBadge(row.event, row.verdict);
                  return (
                    <tr
                      key={row._id ?? `${row.traceId}-${i}`}
                      className="border-b border-slate-100 hover:bg-slate-50/60"
                    >
                      <td className="whitespace-nowrap px-4 py-2.5 text-xs text-slate-500">
                        {formatDateTime(row.createdAt)}
                      </td>
                      <td className="px-4 py-2.5">
                        <span className={badge.className}>{badge.label}</span>
                      </td>
                      <td className="px-4 py-2.5">
                        <button
                          type="button"
                          onClick={() => onOpenTrace(row.traceId)}
                          className="max-w-[190px] truncate rounded-2xl px-1 font-mono text-xs text-slate-500 underline decoration-slate-300 underline-offset-2 transition hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300"
                          title="查看时间线"
                        >
                          {row.traceId}
                        </button>
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs text-slate-600">
                        {row.userId ?? '-'}
                        {row.groupId ? <span className="text-slate-400"> / {row.groupId}</span> : null}
                      </td>
                      <td className="max-w-[220px] truncate px-4 py-2.5 text-xs text-slate-600">
                        {shortText(row.content, 60)}
                      </td>
                      <td className="max-w-[200px] truncate px-4 py-2.5 text-xs text-slate-500">
                        {row.error ? (
                          <span className="text-amber-700">{shortText(row.error, 80)}</span>
                        ) : (
                          shortText(row.reason, 80)
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        <StudioPager
          page={page}
          pageSize={PAGE_SIZE}
          total={total}
          loading={loading}
          label="审计日志分页"
          className="px-4 pb-4"
          onPageChange={goTo}
        />
      </div>
    </div>
  );
};
