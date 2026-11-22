import React, { useCallback, useEffect, useState } from 'react';
import { FiArrowLeft, FiLock, FiRefreshCw, FiSend, FiStar } from 'react-icons/fi';
import { ticketApi, type ITicket } from '@/api/ticketApi';
import { InfoBadge, studioFieldClassName, studioSecondaryButtonClassName, studioPrimaryButtonClassName } from '@/components/studioTheme';
import { StudioErrorState, StudioLoadingState } from '@/components/studioFeedback';
import { useNotification } from '@/components/Notification';
import { cn } from '@/lib/utils';
import { getBackendErrorMessage } from '@/utils/backendError';
import TicketConversation from '../../ticket/TicketConversation';
import TicketEventTimeline from '../../ticket/TicketEventTimeline';
import TicketSatisfactionCard from '../../ticket/TicketSatisfactionCard';
import { TICKET_PRIORITY_META, TICKET_STATUS_META, TICKET_STATUS_ORDER, formatTicketTime } from '../../ticket/ticketConstants';

/**
 * 工单详情（管理端内嵌视图）。
 *
 * 为什么内嵌而不是跳 `/support`：跳转会丢掉队列筛选与勾选状态，而分诊的真实动作是
 * 「扫列表 → 打开 → 回一句/改状态 → 回到列表继续」，中间任何一次页面切换都在打断这条路径。
 *
 * 复用用户侧的三个组件（会话 / 事件时间线 / 满意度卡）而不是重写：
 *   - 会话组件已经处理了日期分隔、滚动策略、内部备注过滤与按索引编辑；
 *   - 事件时间线的姓名脱敏由服务端视图完成，两端看到的口径一致；
 *   - 满意度卡的「客服只读」分支本来就在组件里。
 *
 * 写操作按角色隐藏（服务端仍要求 superadmin）：回复是管理员权限，改状态/编辑消息是超管。
 */
const TicketAdminDetail: React.FC<{
  ticketId: string;
  canWrite: boolean;
  onBack: () => void;
  onChanged: () => void;
}> = ({ ticketId, canWrite, onBack, onChanged }) => {
  const { setNotification } = useNotification();
  const [ticket, setTicket] = useState<ITicket | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reply, setReply] = useState('');
  const [internal, setInternal] = useState(false);
  const [sending, setSending] = useState(false);
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editValue, setEditValue] = useState('');
  const [statusBusy, setStatusBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setTicket(await ticketApi.getTicket(ticketId));
      setError(null);
    } catch (err) {
      setError(getBackendErrorMessage(err, '读取工单详情失败'));
    } finally {
      setLoading(false);
    }
  }, [ticketId]);

  useEffect(() => {
    void load();
  }, [load]);

  const send = useCallback(async () => {
    const content = reply.trim();
    if (!content) return;
    setSending(true);
    try {
      const updated = await ticketApi.replyTicket(ticketId, content, internal, 'markdown');
      setTicket(updated);
      setReply('');
      setNotification({ message: internal ? '内部备注已保存（用户不可见）' : '已回复用户', type: 'success' });
      onChanged();
    } catch (err) {
      setNotification({ message: getBackendErrorMessage(err, '发送失败'), type: 'error' });
    } finally {
      setSending(false);
    }
  }, [internal, onChanged, reply, setNotification, ticketId]);

  const changeStatus = useCallback(
    async (status: string) => {
      setStatusBusy(true);
      try {
        setTicket(await ticketApi.updateStatus(ticketId, status));
        setNotification({ message: `状态已改为「${TICKET_STATUS_META[status]?.label ?? status}」`, type: 'success' });
        onChanged();
      } catch (err) {
        setNotification({ message: getBackendErrorMessage(err, '状态更新失败'), type: 'error' });
      } finally {
        setStatusBusy(false);
      }
    },
    [onChanged, setNotification, ticketId],
  );

  if (error && !ticket) return <StudioErrorState message={error} onRetry={() => void load()} />;
  if (loading && !ticket) return <StudioLoadingState minHeightClassName="min-h-[220px]" text="正在读取工单详情…" />;
  if (!ticket) return null;

  const statusMeta = TICKET_STATUS_META[ticket.status];
  const priorityMeta = TICKET_PRIORITY_META[ticket.priority];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <button type="button" onClick={onBack} className={cn(studioSecondaryButtonClassName, 'min-h-11 px-3 py-1.5 text-xs sm:min-h-0')}>
            <FiArrowLeft className="mr-1 inline" />返回队列
          </button>
          <span className="min-w-0 truncate text-sm font-semibold text-slate-900" title={ticket.title}>
            {ticket.title}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <InfoBadge tone="slate">{statusMeta?.label ?? ticket.status}</InfoBadge>
          <InfoBadge tone="slate">{priorityMeta?.label ?? ticket.priority}</InfoBadge>
          {ticket.csatRating ? (
            <InfoBadge tone={ticket.csatRating <= 2 ? 'rose' : 'emerald'}>
              <FiStar className="mr-1 inline" />
              {ticket.csatRating} 星
            </InfoBadge>
          ) : null}
          <button type="button" onClick={() => void load()} className={cn(studioSecondaryButtonClassName, 'min-h-11 px-2.5 py-1 text-[11px] sm:min-h-0')}>
            <FiRefreshCw className="mr-1 inline" />刷新
          </button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_260px]">
        <div className="min-w-0 space-y-3">
          <TicketEventTimeline events={ticket.events} defaultOpen />

          <TicketConversation
            ticket={ticket}
            currentUserId={undefined}
            isAdmin
            canWrite={canWrite}
            streamingAiResponse={null}
            editingIdx={editingIdx}
            editValue={editValue}
            isUpdating={sending}
            onStartEdit={(index, content) => {
              setEditingIdx(index);
              setEditValue(content);
            }}
            onCancelEdit={() => setEditingIdx(null)}
            onEditValueChange={setEditValue}
            onSaveEdit={(index) => {
              void (async () => {
                try {
                  setTicket(await ticketApi.adminEditMessage(ticketId, index, editValue));
                  setEditingIdx(null);
                  setEditValue('');
                  onChanged();
                } catch (err) {
                  setNotification({ message: getBackendErrorMessage(err, '编辑消息失败'), type: 'error' });
                }
              })();
            }}
            onDeleteMessage={(index) => {
              void (async () => {
                try {
                  setTicket(await ticketApi.adminDeleteMessage(ticketId, index));
                  onChanged();
                } catch (err) {
                  setNotification({ message: getBackendErrorMessage(err, '删除消息失败'), type: 'error' });
                }
              })();
            }}
            onCopyMarkdown={(success) =>
              setNotification({ message: success ? '已复制 Markdown' : '复制失败', type: success ? 'success' : 'error' })
            }
          />

          {ticket.status !== 'closed' ? (
            <div className="rounded-2xl border border-slate-200 bg-white/80 p-3">
              <textarea
                value={reply}
                onChange={(event) => setReply(event.target.value)}
                rows={3}
                placeholder={internal ? '内部备注：只有客服看得到，用户不可见' : '回复用户…'}
                aria-label={internal ? '内部备注' : '回复用户'}
                className={studioFieldClassName}
              />
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                <label className="flex items-center gap-1.5 text-xs text-slate-600">
                  <input type="checkbox" checked={internal} onChange={(event) => setInternal(event.target.checked)} />
                  <FiLock className="inline" aria-hidden />内部备注
                </label>
                <button
                  type="button"
                  onClick={() => void send()}
                  disabled={sending || reply.trim().length === 0}
                  className={cn(studioPrimaryButtonClassName, 'min-h-11 sm:min-h-0')}
                >
                  <FiSend className="mr-1 inline" />{sending ? '发送中…' : internal ? '保存备注' : '发送回复'}
                </button>
              </div>
            </div>
          ) : (
            <p className="rounded-2xl border border-dashed border-slate-200 px-3 py-2 text-xs text-slate-500">
              工单已关闭。需要继续沟通时先把状态改回「处理中」或「已解决」。
            </p>
          )}
        </div>

        <aside className="min-w-0 space-y-3">
          <div className="rounded-2xl border border-slate-200 bg-white/80 p-3">
            <p className="text-xs font-semibold text-slate-700">状态</p>
            {canWrite ? (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {TICKET_STATUS_ORDER.map((status) => (
                  <button
                    key={status}
                    type="button"
                    disabled={statusBusy || status === ticket.status}
                    onClick={() => void changeStatus(status)}
                    className={cn(
                      'rounded-full border px-2.5 py-1 text-[11px] font-semibold transition',
                      status === ticket.status
                        ? 'border-slate-900 bg-slate-900 text-white'
                        : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:text-slate-900',
                      (statusBusy || status === ticket.status) && 'cursor-not-allowed opacity-60',
                    )}
                  >
                    {TICKET_STATUS_META[status]?.label ?? status}
                  </button>
                ))}
              </div>
            ) : (
              <p className="mt-1 text-xs text-slate-500">改状态需要超级管理员权限。</p>
            )}
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white/80 p-3">
            <p className="text-xs font-semibold text-slate-700">票面</p>
            <dl className="mt-2 space-y-1 text-[11px] text-slate-600">
              <div className="flex justify-between gap-2"><dt className="text-slate-500">工单</dt><dd className="font-mono">{ticket._id}</dd></div>
              <div className="flex justify-between gap-2"><dt className="text-slate-500">属主</dt><dd className="truncate">{ticket.username || ticket.userId}</dd></div>
              <div className="flex justify-between gap-2"><dt className="text-slate-500">受理人</dt><dd className="truncate">{ticket.assigneeName || '未分配'}</dd></div>
              <div className="flex justify-between gap-2"><dt className="text-slate-500">创建</dt><dd>{formatTicketTime(ticket.createdAt)}</dd></div>
              <div className="flex justify-between gap-2"><dt className="text-slate-500">首响</dt><dd>{ticket.firstResponseAt ? formatTicketTime(ticket.firstResponseAt) : '未响应'}</dd></div>
              <div className="flex justify-between gap-2"><dt className="text-slate-500">解决</dt><dd>{ticket.resolvedAt ? formatTicketTime(ticket.resolvedAt) : '未解决'}</dd></div>
            </dl>
          </div>

          <TicketSatisfactionCard
            ticket={ticket}
            currentUserId={undefined}
            isAdmin
            onSubmit={async () => false}
          />
        </aside>
      </div>
    </div>
  );
};

export default TicketAdminDetail;
