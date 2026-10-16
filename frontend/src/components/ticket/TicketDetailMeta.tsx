import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FiCornerDownRight, FiEdit3, FiLink, FiMail, FiPlus, FiSearch, FiTag, FiType, FiX } from 'react-icons/fi';
import { cn } from '../../utils/cn';
import type { ITicket, ITicketRelation } from '../../api/ticketApi';
import { ticketApi } from '../../api/ticketApi';
import {
  studioBadgeClassName,
  studioEyebrowClassName,
  studioFieldClassName,
  studioGhostButtonClassName,
} from '../studioTheme';
import {
  TICKET_SERVICE_META,
  TICKET_SERVICE_ORDER,
  TICKET_TYPE_META,
  TICKET_TYPE_ORDER,
  ticketServiceLabel,
} from './ticketConstants';

/**
 * 工单详情里的「票面字段」面板：姓名 / 类型 / 相关服务 / 联系邮箱 / 关联工单。
 *
 * 分工：
 * - 属主：只读（票面字段在创建时确定；需要改动可以由客服在管理端调整）；
 * - superadmin：可就地修改类型 / 相关服务 + 说明 / 联系邮箱，并增删关联工单。
 *
 * 「姓名」用 `username`（本站工单都挂在登录账号上，票面的姓名即账号昵称），因此这里只展示。
 */

interface TicketDetailMetaProps {
  ticket: ITicket;
  canEdit: boolean;
  onUpdateFields: (fields: {
    type?: string;
    relatedService?: string;
    relatedServiceRef?: string | null;
    contactEmail?: string | null;
    relatedTickets?: string[];
  }) => Promise<void> | void;
  onOpenTicket: (ticketId: string) => void;
  onError?: (message: string) => void;
}

/** 就地编辑的文本字段：失焦或回车才提交（避免每敲一个字打一次接口）。 */
const InlineTextField: React.FC<{
  label: string;
  icon: React.ReactNode;
  value: string;
  placeholder: string;
  maxLength: number;
  disabled?: boolean;
  onCommit: (next: string) => void;
}> = ({ label, icon, value, placeholder, maxLength, disabled, onCommit }) => {
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setDraft(value);
  }, [focused, value]);

  const commit = () => {
    const next = draft.trim();
    if (next !== (value || '').trim()) onCommit(next);
  };

  return (
    <label className="min-w-0">
      <span className={cn(studioEyebrowClassName, 'mb-1 flex items-center gap-1 text-[10px] text-slate-500')}>
        {icon} {label}
      </span>
      <input
        type="text"
        value={draft}
        maxLength={maxLength}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          commit();
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commit();
          }
        }}
        className={cn(studioFieldClassName, 'py-2 text-xs')}
      />
    </label>
  );
};

const TicketDetailMeta: React.FC<TicketDetailMetaProps> = ({
  ticket,
  canEdit,
  onUpdateFields,
  onOpenTicket,
  onError,
}) => {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [candidates, setCandidates] = useState<Array<{ _id: string; title: string }>>([]);
  const [searching, setSearching] = useState(false);
  const searchSeqRef = useRef(0);

  const related = ticket.relatedTickets ?? [];
  const relatedIds = related.map((item) => item.ticketId);

  // 关联工单搜索：属主在自己的工单里找，superadmin 在全部工单里找。
  // 用递增序号丢弃过期响应：快速输入时先发的请求可能后到，会把结果覆盖成旧关键词。
  useEffect(() => {
    if (!pickerOpen) return;
    const seq = searchSeqRef.current + 1;
    searchSeqRef.current = seq;
    setSearching(true);
    const timer = window.setTimeout(() => {
      const query = keyword.trim();
      const request = canEdit
        ? ticketApi.getAllTickets({ q: query || undefined, limit: 8, page: 1 })
        : ticketApi.getMyTickets({ page: 1, limit: 50 });
      void request
        .then((page) => {
          if (searchSeqRef.current !== seq) return;
          const rows = page.tickets.filter(
            (item) => item._id !== ticket._id && !relatedIds.includes(item._id),
          );
          const filtered = query && !canEdit
            ? rows.filter((item) => item.title.toLowerCase().includes(query.toLowerCase()))
            : rows;
          setCandidates(filtered.slice(0, 8).map((item) => ({ _id: item._id, title: item.title })));
        })
        .catch(() => {
          if (searchSeqRef.current === seq) setCandidates([]);
        })
        .finally(() => {
          if (searchSeqRef.current === seq) setSearching(false);
        });
    }, 300);
    return () => window.clearTimeout(timer);
    // relatedIds 只用于过滤候选，变化时不重新搜索
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canEdit, keyword, pickerOpen, ticket._id]);

  const addRelated = useCallback(
    (candidate: { _id: string; title: string }) => {
      if (related.length >= 5) {
        onError?.('最多关联 5 个工单');
        return;
      }
      void onUpdateFields({ relatedTickets: [...relatedIds, candidate._id] });
      setPickerOpen(false);
      setKeyword('');
    },
    [onError, onUpdateFields, related.length, relatedIds],
  );

  const removeRelated = useCallback(
    (item: ITicketRelation) => {
      void onUpdateFields({ relatedTickets: relatedIds.filter((id) => id !== item.ticketId) });
    },
    [onUpdateFields, relatedIds],
  );

  const typeMeta = TICKET_TYPE_META[ticket.type] ?? TICKET_TYPE_META.inquiry;

  return (
    <section
      aria-label="工单信息"
      className="border-b border-slate-200/80 bg-slate-50/40 px-4 py-3 sm:px-5"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[11px] text-slate-600">
        <span className={cn(studioBadgeClassName(typeMeta.tone), 'gap-1')}>
          <FiType size={10} /> {typeMeta.label}
        </span>
        <span className="inline-flex min-w-0 items-center gap-1">
          <FiTag className="shrink-0 text-slate-400" size={11} />
          <span className="truncate">
            相关服务：{ticketServiceLabel(ticket.relatedService)}
            {ticket.relatedServiceRef ? `（${ticket.relatedServiceRef}）` : ''}
          </span>
        </span>
        <span className="inline-flex min-w-0 items-center gap-1">
          <FiMail className="shrink-0 text-slate-400" size={11} />
          <span className="truncate">{ticket.contactEmail || '未填写联系邮箱'}</span>
        </span>
        <span className="inline-flex items-center gap-1 text-slate-500">
          <FiLink className="shrink-0 text-slate-400" size={11} />
          附件 {ticket.attachmentCount ?? 0} 个
        </span>
      </div>

      {/* 关联工单：两端都能看，只有 superadmin 能增删 */}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span className={cn(studioEyebrowClassName, 'text-[10px] text-slate-500')}>关联工单</span>
        {related.length === 0 && <span className="text-[11px] text-slate-400">无</span>}
        {related.map((item) => (
          <span
            key={item.ticketId}
            className="inline-flex max-w-[16rem] items-center gap-1 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11px] text-slate-700"
          >
            <FiCornerDownRight className="shrink-0 text-slate-400" size={10} />
            <button
              type="button"
              onClick={() => onOpenTicket(item.ticketId)}
              title={`打开关联工单：${item.title}`}
              className="min-w-0 truncate underline decoration-slate-300 underline-offset-2 transition hover:text-slate-900"
            >
              {item.title}
            </button>
            {canEdit && (
              <button
                type="button"
                aria-label={`取消关联 ${item.title}`}
                onClick={() => removeRelated(item)}
                className="shrink-0 rounded-full p-0.5 text-slate-400 transition hover:text-rose-600"
              >
                <FiX size={11} />
              </button>
            )}
          </span>
        ))}
        {canEdit && related.length < 5 && (
          <div className="relative">
            <button
              type="button"
              onClick={() => setPickerOpen((current) => !current)}
              aria-expanded={pickerOpen}
              className={cn(studioGhostButtonClassName, 'h-7 gap-1 px-2 py-0 text-[10px] normal-case tracking-normal')}
            >
              <FiPlus size={11} /> 关联工单
            </button>
            {pickerOpen && (
              <div className="absolute left-0 top-9 z-30 w-72 rounded-2xl border border-slate-200 bg-white p-2 shadow-lg">
                <div className="relative mb-2">
                  <FiSearch className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" size={12} />
                  <input
                    type="search"
                    autoFocus
                    value={keyword}
                    onChange={(event) => setKeyword(event.target.value)}
                    placeholder="搜索标题 / 描述 / 用户名"
                    aria-label="搜索要关联的工单"
                    className={cn(studioFieldClassName, 'py-1.5 pl-7 text-xs')}
                  />
                </div>
                {searching ? (
                  <p className="px-2 py-3 text-[11px] text-slate-400">搜索中…</p>
                ) : candidates.length === 0 ? (
                  <p className="px-2 py-3 text-[11px] text-slate-400">没有可关联的工单</p>
                ) : (
                  <ul className="max-h-56 overflow-y-auto">
                    {candidates.map((candidate) => (
                      <li key={candidate._id}>
                        <button
                          type="button"
                          onClick={() => addRelated(candidate)}
                          className="w-full truncate rounded-2xl px-2 py-1.5 text-left text-[11px] text-slate-700 transition hover:bg-slate-50"
                        >
                          {candidate.title}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* superadmin 就地编辑票面字段 */}
      {canEdit && (
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <label className="min-w-0">
            <span className={cn(studioEyebrowClassName, 'mb-1 flex items-center gap-1 text-[10px] text-slate-500')}>
              <FiEdit3 size={10} /> 工单类型
            </span>
            <select
              aria-label="工单类型"
              value={ticket.type}
              onChange={(event) => void onUpdateFields({ type: event.target.value })}
              className={cn(studioFieldClassName, 'py-2 text-xs')}
            >
              {TICKET_TYPE_ORDER.map((key) => (
                <option key={key} value={key}>{TICKET_TYPE_META[key].label}</option>
              ))}
            </select>
          </label>
          <label className="min-w-0">
            <span className={cn(studioEyebrowClassName, 'mb-1 flex items-center gap-1 text-[10px] text-slate-500')}>
              <FiTag size={10} /> 相关服务
            </span>
            <select
              aria-label="相关服务"
              value={ticket.relatedService}
              onChange={(event) => void onUpdateFields({ relatedService: event.target.value })}
              className={cn(studioFieldClassName, 'py-2 text-xs')}
            >
              {TICKET_SERVICE_ORDER.map((key) => (
                <option key={key} value={key}>{TICKET_SERVICE_META[key].label}</option>
              ))}
            </select>
          </label>
          <InlineTextField
            label="服务说明 / 任务 ID"
            icon={<FiLink size={10} />}
            value={ticket.relatedServiceRef ?? ''}
            placeholder="例如任务 ID、订单号"
            maxLength={120}
            onCommit={(next) => void onUpdateFields({ relatedServiceRef: next || null })}
          />
          <InlineTextField
            label="联系邮箱"
            icon={<FiMail size={10} />}
            value={ticket.contactEmail ?? ''}
            placeholder="未填写"
            maxLength={254}
            onCommit={(next) => void onUpdateFields({ contactEmail: next || null })}
          />
        </div>
      )}
    </section>
  );
};

export default TicketDetailMeta;
