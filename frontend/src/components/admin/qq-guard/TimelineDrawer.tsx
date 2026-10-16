import React, { useCallback, useEffect, useState } from 'react';
import { qqGuardApi } from '../../../api/qqGuard';
import type { QqGuardAuditRow } from '../../../api/qqGuard';
import { studioBadgeClassName } from '../../studioTheme';
import {
  StudioEmptyState,
  StudioErrorState,
  StudioLoadingState,
  StudioModal,
  StudioModalHeader,
} from '../../studioFeedback';
import { eventBadge, formatDateTime, shortText } from './ui';

/** 审计行的内部状态值 → 面向人的文案（不把原始枚举直接摆到界面上）。 */
const STATUS_LABELS: Record<string, string> = {
  done: '已完成',
  pending: '待执行',
  failed: '失败',
};

/**
 * 按 traceId 打开完整时间线（倒序展示：最新在上）。
 * 每个 attempt 独立一条，可逐次核对 AI 不可达期间的重试/终态，支撑误判申诉复核。
 *
 * 弹窗行为（Escape / Tab 循环 / 关闭后恢复焦点）由 StudioModal 统一提供（FD-070）。
 */
export const TimelineDrawer: React.FC<{ traceId: string; onClose: () => void }> = ({ traceId, onClose }) => {
  const [events, setEvents] = useState<QqGuardAuditRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setEvents(await qqGuardApi.timeline(traceId));
    } catch (err) {
      setEvents([]);
      setError('时间线暂时读不出来，请稍后重试。');
      console.error('加载 trace 时间线失败:', err);
    } finally {
      setLoading(false);
    }
  }, [traceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const sorted = [...events].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );

  return (
    <StudioModal open onClose={onClose} labelledBy="qq-guard-timeline-title" maxWidthClassName="max-w-3xl">
      <StudioModalHeader
        title="操作时间线"
        titleId="qq-guard-timeline-title"
        description={traceId}
        onClose={onClose}
      />

      <div className="mt-5">
        {loading ? (
          <StudioLoadingState minHeightClassName="min-h-[240px]" text="正在读取时间线…" />
        ) : error ? (
          <StudioErrorState message={error} onRetry={() => void load()} />
        ) : sorted.length === 0 ? (
          <StudioEmptyState
            className="py-12"
            message="这条 trace 还没有审计记录。等机器人处理过这条消息后重新打开即可看到。"
          />
        ) : (
          <ol className="relative space-y-4 border-l-2 border-slate-100 pl-5">
            {sorted.map((ev, i) => {
              const badge = eventBadge(ev.event, ev.verdict);
              return (
                <li key={`${ev._id ?? i}`} className="relative">
                  <span className="absolute -left-[27px] top-2 size-2 rounded-full bg-slate-300 ring-4 ring-white" />
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={badge.className}>{badge.label}</span>
                    <span className="text-xs text-slate-400">{formatDateTime(ev.createdAt)}</span>
                    {typeof ev.attempt === 'number' && (
                      <span className={studioBadgeClassName('slate')}>第 {ev.attempt} 次尝试</span>
                    )}
                    {ev.status && ev.status !== 'done' && (
                      <span className="text-[11px] text-slate-400">状态：{STATUS_LABELS[ev.status] ?? '处理中'}</span>
                    )}
                  </div>
                  {(ev.reason || ev.error) && (
                    <div className="mt-1 text-xs text-slate-600">
                      {ev.error ? <span className="text-rose-600">错误：{shortText(ev.error, 160)}</span> : null}
                      {ev.error && ev.reason ? ' · ' : null}
                      {ev.reason ? <span>原因：{shortText(ev.reason, 160)}</span> : null}
                    </div>
                  )}
                  <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-slate-400">
                    <span>群 {ev.groupId ?? '-'}</span>
                    <span>用户 {ev.userId ?? '-'}</span>
                    {ev.messageId && <span>消息 {ev.messageId}</span>}
                    {ev.action && <span>处置 {ev.action}</span>}
                  </div>
                  {ev.content ? (
                    <div className="mt-1.5 rounded-2xl border border-slate-100 bg-slate-50 px-3 py-2 text-xs leading-6 text-slate-600">
                      {shortText(ev.content, 220)}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </StudioModal>
  );
};
