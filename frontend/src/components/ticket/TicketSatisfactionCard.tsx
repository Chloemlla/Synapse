import React, { useEffect, useState } from 'react';
import { FiStar } from 'react-icons/fi';
import type { ITicket } from '../../api/ticketApi';
import { cn } from '../../utils/cn';
import {
  TICKET_CSAT_LABELS,
  formatTicketStarRating,
} from './ticketConstants';
import {
  studioEyebrowClassName,
  studioGhostButtonClassName,
  studioPrimaryButtonClassName,
  studioTextareaClassName,
} from '../studioTheme';

/**
 * 满意度评价卡：属主可填写/修改，客服（超管）只读查看。
 *
 * 属主侧只在 `resolved` / `closed` 状态出现，按「展示 / 编辑」两态切换；
 * 客服侧只要有评价就展示星级、补充说明与提交时间 —— 用户写了什么必须能被回访的人看到，
 * 否则这条内容只存在于属主界面，客服既无法据此改进，也不知道差评原因。
 */

interface TicketSatisfactionCardProps {
  ticket: ITicket;
  currentUserId?: string;
  isAdmin: boolean;
  /** 返回 true 表示提交成功（父组件已刷新工单）；false 时保留编辑态与输入。 */
  onSubmit: (rating: number, comment: string) => Promise<boolean>;
}

const RATINGS = [1, 2, 3, 4, 5] as const;
const MAX_COMMENT_LEN = 500;

const TicketSatisfactionCard: React.FC<TicketSatisfactionCardProps> = ({
  ticket,
  currentUserId,
  isAdmin,
  onSubmit,
}) => {
  const [editing, setEditing] = useState(() => !ticket.csatRating);
  const [rating, setRating] = useState(ticket.csatRating ?? 0);
  const [comment, setComment] = useState(ticket.csatComment ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 父组件提交成功后会回填工单视图；同步本地态，避免展示旧星级。
  useEffect(() => {
    setRating(ticket.csatRating ?? 0);
    setComment(ticket.csatComment ?? '');
    setEditing(!ticket.csatRating);
    setError(null);
  }, [ticket._id, ticket.csatRating, ticket.csatComment, ticket.csatSubmittedAt]);

  const isOwner = !isAdmin && Boolean(currentUserId) && ticket.userId === currentUserId;
  const canRate = isOwner && (ticket.status === 'resolved' || ticket.status === 'closed');
  // 客服视角：已评价就展示内容（只读）。未评价时不出卡片 —— 客服不能替用户打分。
  const canView = canRate || (isAdmin && Boolean(ticket.csatRating));
  if (!canView) return null;

  const handleSubmit = async () => {
    if (submitting || rating < 1) return;
    setSubmitting(true);
    setError(null);
    try {
      const success = await onSubmit(rating, comment.trim());
      if (!success) {
        setError('评价提交失败，请重试');
        return;
      }
      setEditing(false);
    } catch {
      setError('评价提交失败，请重试');
    } finally {
      setSubmitting(false);
    }
  };

  const startEdit = () => {
    setRating(ticket.csatRating ?? 0);
    setComment(ticket.csatComment ?? '');
    setError(null);
    setEditing(true);
  };

  const cancelEdit = () => {
    setRating(ticket.csatRating ?? 0);
    setComment(ticket.csatComment ?? '');
    setError(null);
    setEditing(false);
  };

  const hasExistingRating = Boolean(ticket.csatRating);

  return (
    <section className="shrink-0 rounded-2xl border border-slate-200 bg-white/80 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className={studioEyebrowClassName}>满意度评价</div>
          <h3 className="mt-1 text-sm font-semibold text-slate-900">
            {isAdmin ? '用户评价' : hasExistingRating ? '感谢你的评价' : '这个工单解决了吗？'}
          </h3>
        </div>
        {canRate && hasExistingRating && !editing ? (
          <button type="button" onClick={startEdit} className={cn(studioGhostButtonClassName, 'shrink-0')}>
            修改评价
          </button>
        ) : null}
      </div>

      {editing ? (
        <div className="mt-3 space-y-3">
          <fieldset className="min-w-0">
            <legend className="sr-only">满意度评分（1–5 星）</legend>
            <div role="radiogroup" aria-label="满意度评分" className="flex items-center gap-1">
              {RATINGS.map((value) => {
                const active = rating === value;
                return (
                  <label
                    key={value}
                    className="cursor-pointer rounded-full p-1 transition focus-within:ring-2 focus-within:ring-slate-400 focus-within:ring-offset-2"
                  >
                    <input
                      type="radio"
                      name={`ticket-csat-${ticket._id}`}
                      value={value}
                      checked={active}
                      aria-checked={active}
                      onChange={() => setRating(value)}
                      className="sr-only"
                    />
                    <FiStar
                      size={24}
                      aria-hidden
                      className={active ? 'fill-amber-400 text-amber-500' : 'text-slate-300 hover:text-amber-400'}
                    />
                    <span className="sr-only">
                      {value} 星 · {TICKET_CSAT_LABELS[value]}
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>
          <p className="text-xs text-slate-500">
            {rating > 0 ? `${rating} 星 · ${TICKET_CSAT_LABELS[rating]}` : '请选择 1–5 星'}
          </p>

          <div>
            <div className="mb-1 flex items-center justify-between gap-2">
              <label htmlFor={`ticket-csat-comment-${ticket._id}`} className="text-xs font-semibold text-slate-600">
                补充说明（可选）
              </label>
              <span className="text-[10px] text-slate-400">
                {comment.length}/{MAX_COMMENT_LEN}
              </span>
            </div>
            <textarea
              id={`ticket-csat-comment-${ticket._id}`}
              rows={3}
              maxLength={MAX_COMMENT_LEN}
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              placeholder="可以告诉我们要改进的地方（最多 500 字）"
              className={studioTextareaClassName}
            />
          </div>

          {error ? (
            <p role="alert" className="text-xs text-rose-600">
              {error}
            </p>
          ) : null}

          <div className="flex flex-col gap-2 sm:flex-row">
            <button
              type="button"
              onClick={() => void handleSubmit()}
              disabled={submitting || rating < 1}
              className={studioPrimaryButtonClassName}
            >
              {submitting ? '提交中...' : hasExistingRating ? '保存修改' : '提交评价'}
            </button>
            {hasExistingRating ? (
              <button type="button" onClick={cancelEdit} className={studioGhostButtonClassName}>
                取消
              </button>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="mt-3 space-y-2">
          <div
            role="img"
            className="flex items-center gap-1"
            aria-label={`当前评分：${formatTicketStarRating(ticket.csatRating)}`}
          >
            {RATINGS.map((value) => (
              <FiStar
                key={value}
                size={18}
                aria-hidden
                className={value <= (ticket.csatRating ?? 0) ? 'fill-amber-400 text-amber-500' : 'text-slate-300'}
              />
            ))}
            <span className="ml-2 text-xs font-semibold text-slate-700">
              {formatTicketStarRating(ticket.csatRating)}
            </span>
          </div>
          {ticket.csatComment ? (
            <p className="whitespace-pre-line break-words text-xs leading-6 text-slate-600">
              {ticket.csatComment}
            </p>
          ) : null}
          {ticket.csatSubmittedAt ? (
            <p className="text-[10px] text-slate-400">
              评价于{' '}
              <time dateTime={ticket.csatSubmittedAt} title={new Date(ticket.csatSubmittedAt).toLocaleString()}>
                {new Date(ticket.csatSubmittedAt).toLocaleString()}
              </time>
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
};

export default TicketSatisfactionCard;
