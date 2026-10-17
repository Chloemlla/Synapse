import React, { useEffect, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { FiChevronDown, FiPlus, FiSend, FiX } from 'react-icons/fi';
import { cn } from '../../utils/cn';
import type { TicketCapabilities } from '../../api/ticketApi';
import { TicketAttachmentLinks, TicketAttachmentPicker } from './TicketAttachments';
import {
  MAX_TICKET_ATTACHMENT_LINKS,
  MAX_TICKET_DESC_LEN,
  MAX_TICKET_TITLE_LEN,
  TICKET_CATEGORY_META,
  TICKET_CATEGORY_ORDER,
  TICKET_CREATE_TEMPLATES,
  TICKET_SERVICE_META,
  TICKET_SERVICE_ORDER,
  TICKET_TYPE_META,
  TICKET_TYPE_ORDER,
  ticketServiceLabel,
} from './ticketConstants';
import { useConfirm } from '../confirm/ConfirmDialogProvider';
import {
  studioDisplayFont,
  studioEyebrowClassName,
  studioFieldClassName,
  studioGhostButtonClassName,
  studioPillClassName,
  studioPrimaryButtonClassName,
  studioStrongBadgeClassName,
  studioTextareaClassName,
} from '../studioTheme';

/**
 * 发起工单表单（票面字段：标题 / 问题分类 / 类型 / 相关服务 / 联系邮箱 / 关联工单 / 附件 / 紧急程度 / 详细描述）。
 *
 * 为什么从 `TicketSystem.tsx` 抽出来：那个文件本来就贴着体积闸门上限（1500 行 + 遗留增速预算），
 * 把整张表单搬进来会直接触发 `check:ts-file-size`。这里承接表单状态（受控组件），
 * 页面只负责提交与状态放置。
 *
 * v2 的结构取舍：
 * - 默认只露出「必须填」的五项 + 模板；类型/服务/邮箱/关联/附件收进「更多信息（可选）」，
 *   避免首次提交被 7 组字段劝退；
 * - 折叠不等于隐藏 —— summary 行会显示已填写的可选项摘要，用户能一眼看到自己填过什么；
 * - 草稿只持久化可 JSON 序列化的字段（File 对象无法序列化，重新进入后需要重新选择）。
 */

export interface TicketCreateFormValue {
  title: string;
  description: string;
  priority: string;
  category: string;
  type: string;
  relatedService: string;
  relatedServiceRef: string;
  contactEmail: string;
  attachmentLinks: Array<{ url: string; label?: string | null }>;
  relatedTicketIds: string[];
}

interface TicketCreateFormProps {
  value: TicketCreateFormValue;
  /** 局部更新（等价于 `setState(prev => ({ ...prev, ...patch }))`）。 */
  onChange: (patch: Partial<TicketCreateFormValue>) => void;
  /** 工单还没创建，附件只能先攒在内存里（提交成功后再逐个上传）。 */
  pendingFiles: File[];
  onPendingFilesChange: (files: File[]) => void;
  /** 「关联工单」候选（页面在自己最近工单里取）。 */
  linkingCandidates: Array<{ _id: string; title: string }>;
  capabilities: TicketCapabilities | null;
  isMobile: boolean;
  isSubmitting: boolean;
  /** 超长描述的邮件引导（由页面决定是否渲染）。 */
  overlengthNotice?: React.ReactNode;
  onSubmit: (event: React.FormEvent) => void;
  onCancel: () => void;
  onError: (message: string) => void;
  /**
   * 提交成功后由页面递增的信号。表单在成功时通常会被卸载，单靠「value 变空」检测
   * 可能来不及触发，所以页面在成功后把该值 +1，用于可靠地清掉草稿。
   */
  resetSignal?: number;
}

const MAX_RELATED_TICKETS = 5;
const DRAFT_STORAGE_KEY = 'synapse.ticket-create-draft';
const DRAFT_SAVE_DEBOUNCE_MS = 500;

const DEFAULT_CREATE_FORM_VALUE: TicketCreateFormValue = {
  title: '',
  description: '',
  priority: 'medium',
  category: 'other',
  type: 'inquiry',
  relatedService: 'other',
  relatedServiceRef: '',
  contactEmail: '',
  attachmentLinks: [],
  relatedTicketIds: [],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}

function asLimitedString(value: unknown, maxLength: number): string | undefined {
  return typeof value === 'string' ? value.slice(0, maxLength) : undefined;
}

function isOneOf(value: unknown, allowed: readonly string[]): value is string {
  return typeof value === 'string' && allowed.includes(value);
}

/** 表单里是否有值得恢复/保存的内容（只选默认分类不算）。 */
function hasMeaningfulContent(value: TicketCreateFormValue): boolean {
  return Boolean(
    value.title.trim()
    || value.description.trim()
    || value.relatedServiceRef.trim()
    || value.contactEmail.trim()
    || value.attachmentLinks.length > 0
    || value.relatedTicketIds.length > 0,
  );
}

/**
 * 清空创建草稿。导出给页面在提交成功后调用：表单此时已经卸载，
 * 组件内的清理 effect 不会再有执行机会。
 */
export function clearTicketCreateDraft(): void {
  clearStoredDraft();
}

function clearStoredDraft(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(DRAFT_STORAGE_KEY);
  } catch {
    // 隐私模式/禁用存储：清不掉也没有副作用，下次成功提交会再尝试。
  }
}

/** 读取并逐字段校验草稿；任何非法形状都按「没有草稿」处理，不让脏数据进表单。 */
function readStoredDraft(): Partial<TicketCreateFormValue> | null {
  if (typeof window === 'undefined') return null;
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(DRAFT_STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    clearStoredDraft();
    return null;
  }
  if (!isRecord(parsed)) {
    clearStoredDraft();
    return null;
  }

  const draft: Partial<TicketCreateFormValue> = {};
  const title = asLimitedString(parsed.title, MAX_TICKET_TITLE_LEN);
  if (title !== undefined) draft.title = title;
  const description = asLimitedString(parsed.description, MAX_TICKET_DESC_LEN + 200);
  if (description !== undefined) draft.description = description;
  if (isOneOf(parsed.priority, ['low', 'medium', 'high'])) draft.priority = parsed.priority;
  if (isOneOf(parsed.category, TICKET_CATEGORY_ORDER)) draft.category = parsed.category;
  if (isOneOf(parsed.type, TICKET_TYPE_ORDER)) draft.type = parsed.type;
  if (isOneOf(parsed.relatedService, TICKET_SERVICE_ORDER)) draft.relatedService = parsed.relatedService;
  const serviceRef = asLimitedString(parsed.relatedServiceRef, 120);
  if (serviceRef !== undefined) draft.relatedServiceRef = serviceRef;
  const contactEmail = asLimitedString(parsed.contactEmail, 254);
  if (contactEmail !== undefined) draft.contactEmail = contactEmail;
  if (Array.isArray(parsed.attachmentLinks)) {
    draft.attachmentLinks = parsed.attachmentLinks
      .filter(isRecord)
      .map((item) => ({
        url: typeof item.url === 'string' ? item.url : '',
        label: typeof item.label === 'string' ? item.label : null,
      }))
      .filter((item) => item.url)
      .slice(0, MAX_TICKET_ATTACHMENT_LINKS);
  }
  if (Array.isArray(parsed.relatedTicketIds)) {
    draft.relatedTicketIds = parsed.relatedTicketIds
      .filter((id): id is string => typeof id === 'string' && Boolean(id))
      .slice(0, MAX_RELATED_TICKETS);
  }

  const merged = { ...DEFAULT_CREATE_FORM_VALUE, ...draft };
  if (!hasMeaningfulContent(merged)) {
    clearStoredDraft();
    return null;
  }
  return draft;
}

const TicketCreateForm: React.FC<TicketCreateFormProps> = ({
  value,
  onChange,
  pendingFiles,
  onPendingFilesChange,
  linkingCandidates,
  capabilities,
  isMobile,
  isSubmitting,
  overlengthNotice,
  onSubmit,
  onCancel,
  onError,
  resetSignal,
}) => {
  const prefersReducedMotion = useReducedMotion();
  const hoverScale = (scale: number) => (prefersReducedMotion ? undefined : { scale });
  const tapScale = (scale: number) => (prefersReducedMotion ? undefined : { scale });
  const confirm = useConfirm();

  const canUploadFiles = capabilities?.canUploadAttachments === true;

  const [draftRestored, setDraftRestored] = useState(false);
  // 首次渲染不写草稿：父组件的初始 value 可能就是默认空值，先写会把上一次草稿覆盖掉。
  const persistArmedRef = useRef(false);
  const restoreAttemptedRef = useRef(false);
  const resetSignalArmedRef = useRef(false);
  const lastResetSignalRef = useRef<number | undefined>(resetSignal);

  // 恢复草稿：只尝试一次；附件 File 对象无法序列化，保留父组件当前选择不动。
  useEffect(() => {
    if (restoreAttemptedRef.current) return;
    restoreAttemptedRef.current = true;
    const draft = readStoredDraft();
    if (!draft) return;
    onChange(draft);
    setDraftRestored(true);
  }, [onChange]);

  // 页面在提交成功后递增 resetSignal：此时表单可能已被卸载，仍要可靠地清掉草稿。
  // 第一次拿到已知值只「上膛」，不把它当成一次成功提交（否则会把刚恢复的草稿清掉）。
  useEffect(() => {
    if (resetSignal === undefined) return;
    if (!resetSignalArmedRef.current) {
      resetSignalArmedRef.current = true;
      lastResetSignalRef.current = resetSignal;
      return;
    }
    if (lastResetSignalRef.current === resetSignal) return;
    lastResetSignalRef.current = resetSignal;
    clearStoredDraft();
    setDraftRestored(false);
  }, [resetSignal]);

  useEffect(() => {
    if (!persistArmedRef.current) {
      persistArmedRef.current = true;
      return undefined;
    }
    const timer = window.setTimeout(() => {
      if (!hasMeaningfulContent(value)) {
        clearStoredDraft();
        return;
      }
      try {
        window.localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(value));
      } catch {
        // 存储不可用/超额：草稿退化成「本次会话内保留」，不影响提交。
      }
    }, DRAFT_SAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [value]);

  const discardDraft = () => {
    clearStoredDraft();
    setDraftRestored(false);
    onChange({ ...DEFAULT_CREATE_FORM_VALUE });
  };

  const applyTemplate = async (template: (typeof TICKET_CREATE_TEMPLATES)[number]) => {
    if (value.title.trim() || value.description.trim()) {
      const ok = await confirm({
        title: '套用模板会覆盖已填写的标题和描述',
        description: '只会替换标题、问题分类与详细描述，其他字段和已选附件保持不变。',
        confirmLabel: '套用模板',
      });
      if (!ok) return;
    }
    onChange({
      title: template.title,
      category: template.category,
      description: template.description,
    });
  };

  const attachmentCount = value.attachmentLinks.length + pendingFiles.length;
  const optionalSummary = [
    value.type === 'incident' ? `类型：${TICKET_TYPE_META.incident.label}` : null,
    value.relatedService && value.relatedService !== 'other'
      ? `相关服务：${ticketServiceLabel(value.relatedService)}`
      : null,
    value.relatedServiceRef.trim() ? `服务说明：${value.relatedServiceRef.trim()}` : null,
    value.contactEmail.trim() ? `联系邮箱：${value.contactEmail.trim()}` : null,
    value.relatedTicketIds.length > 0 ? `关联 ${value.relatedTicketIds.length} 个` : null,
    attachmentCount > 0 ? `附件 ${attachmentCount} 个` : null,
  ]
    .filter((item): item is string => Boolean(item))
    .join(' · ');

  return (
    <div className="max-w-xl mx-auto">
      <div className="mb-5 flex items-center gap-3">
        <div className={studioStrongBadgeClassName}>
          <FiPlus aria-hidden />
        </div>
        <div className="min-w-0">
          <div className={studioEyebrowClassName}>New Ticket</div>
          <h3 className="text-xl font-semibold text-slate-900" style={{ fontFamily: studioDisplayFont }}>
            发起新工单
          </h3>
        </div>
      </div>

      <form onSubmit={onSubmit} className="space-y-4 sm:space-y-5">
        {draftRestored ? (
          <div
            role="status"
            aria-live="polite"
            className="flex flex-col gap-2 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs text-emerald-800 sm:flex-row sm:items-center sm:justify-between"
          >
            <span className="min-w-0">已恢复上次未提交的草稿（附件文件需重新选择）</span>
            <span className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={discardDraft}
                className="rounded-full border border-emerald-300 bg-white px-3 py-1 text-[11px] font-semibold text-emerald-700 transition hover:bg-emerald-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
              >
                丢弃草稿
              </button>
              <button
                type="button"
                onClick={() => setDraftRestored(false)}
                aria-label="关闭草稿提示"
                title="关闭提示"
                className="rounded-full p-1 text-emerald-600 transition hover:text-emerald-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
              >
                <FiX size={12} aria-hidden />
              </button>
            </span>
          </div>
        ) : null}

        <div>
          <div className="mb-2 flex items-center justify-between">
            <label className={cn(studioEyebrowClassName, 'block')}>工单标题</label>
            <span className="text-[10px] text-slate-400">
              {value.title.length}/{MAX_TICKET_TITLE_LEN}
            </span>
          </div>
          <input
            type="text"
            required
            maxLength={MAX_TICKET_TITLE_LEN}
            placeholder="请输入简明扼要的标题"
            className={studioFieldClassName}
            value={value.title}
            onChange={(event) => onChange({ title: event.target.value })}
          />
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className={studioEyebrowClassName}>常见问题模板</span>
            <span className="text-[10px] text-slate-400">点击套用标题与描述</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {TICKET_CREATE_TEMPLATES.map((template) => (
              <button
                key={template.key}
                type="button"
                onClick={() => void applyTemplate(template)}
                aria-label={`套用模板：${template.label}`}
                className={cn(
                  studioPillClassName(false),
                  'inline-flex items-center normal-case tracking-normal',
                )}
              >
                {template.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className={cn(studioEyebrowClassName, 'mb-2 block')}>问题分类</label>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {TICKET_CATEGORY_ORDER.map((category) => {
              const meta = TICKET_CATEGORY_META[category];
              const isActive = value.category === category;
              return (
                <label key={category} className="min-w-0">
                  <input
                    type="radio"
                    name="category"
                    value={category}
                    checked={isActive}
                    onChange={(event) => onChange({ category: event.target.value })}
                    className="hidden peer"
                  />
                  <div
                    className={cn(
                      'cursor-pointer rounded-2xl border px-3 py-2 text-left transition',
                      isActive ? 'border-slate-900 bg-white' : 'border-slate-200 bg-white hover:border-slate-300',
                    )}
                  >
                    <span className="block text-xs font-semibold text-slate-900">{meta.label}</span>
                    <span className="mt-0.5 block text-[10px] leading-4 text-slate-500">{meta.hint}</span>
                  </div>
                </label>
              );
            })}
          </div>
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <label className={cn(studioEyebrowClassName, 'block')}>详细描述</label>
            <span
              className={cn(
                'text-[10px]',
                value.description.length > MAX_TICKET_DESC_LEN ? 'text-rose-500 font-semibold' : 'text-slate-400',
              )}
            >
              {value.description.length}/{MAX_TICKET_DESC_LEN}
            </span>
          </div>
          <textarea
            required
            rows={isMobile ? 6 : 8}
            maxLength={MAX_TICKET_DESC_LEN + 200}
            placeholder="请尽可能详细地说明您遇到的问题或建议，以便我们能更快为您处理..."
            className={studioTextareaClassName}
            value={value.description}
            onChange={(event) => onChange({ description: event.target.value })}
          />
        </div>

        <div>
          <label className={cn(studioEyebrowClassName, 'mb-2 block')}>紧急程度</label>
          <div className="flex gap-2 sm:gap-3">
            {(['low', 'medium', 'high'] as const).map((priority) => {
              const isActive = value.priority === priority;
              const toneActiveClass =
                priority === 'high'
                  ? 'bg-rose-50 border-rose-300 text-rose-700'
                  : priority === 'medium'
                    ? 'bg-amber-50 border-amber-300 text-amber-700'
                    : 'bg-emerald-50 border-emerald-300 text-emerald-700';
              return (
                <label key={priority} className="min-w-0 flex-1">
                  <input
                    type="radio"
                    name="priority"
                    value={priority}
                    checked={isActive}
                    onChange={(event) => onChange({ priority: event.target.value })}
                    className="hidden peer"
                  />
                  <div
                    className={cn(
                      'text-center py-2.5 rounded-2xl border cursor-pointer transition-all text-xs sm:text-sm font-semibold',
                      isActive
                        ? toneActiveClass
                        : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300 hover:text-slate-700',
                    )}
                  >
                    {priority === 'high' ? '紧急' : priority === 'medium' ? '一般' : '低'}
                  </div>
                </label>
              );
            })}
          </div>
        </div>

        {overlengthNotice}

        <details className="group rounded-2xl border border-slate-200 bg-white/80 px-4 py-3">
          <summary className="cursor-pointer list-none rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-2">
            <span className="flex items-center justify-between gap-2">
              <span className="min-w-0 text-sm font-semibold text-slate-900">更多信息（可选）</span>
              <FiChevronDown
                className="shrink-0 text-slate-400 transition group-open:rotate-180"
                size={14}
                aria-hidden
              />
            </span>
            <span
              className={cn(
                'mt-1 block min-w-0 truncate text-[11px] text-slate-500',
                optionalSummary ? '' : 'text-slate-400',
              )}
              title={optionalSummary || undefined}
            >
              {optionalSummary || '工单类型、相关服务、联系邮箱、关联工单与附件'}
            </span>
          </summary>

          <div className="mt-4 space-y-4">
            <div>
              <span className={cn(studioEyebrowClassName, 'mb-2 block')}>工单类型</span>
              <div className="flex gap-2 sm:gap-3">
                {TICKET_TYPE_ORDER.map((type) => {
                  const meta = TICKET_TYPE_META[type];
                  const isActive = value.type === type;
                  return (
                    <label key={type} className="min-w-0 flex-1">
                      <input
                        type="radio"
                        name="type"
                        value={type}
                        checked={isActive}
                        onChange={(event) => onChange({ type: event.target.value })}
                        className="hidden peer"
                      />
                      <div
                        className={cn(
                          'cursor-pointer rounded-2xl border px-3 py-2 text-left transition',
                          isActive
                            ? type === 'incident'
                              ? 'border-rose-300 bg-rose-50'
                              : 'border-slate-900 bg-white'
                            : 'border-slate-200 bg-white hover:border-slate-300',
                        )}
                      >
                        <span className="block text-xs font-semibold text-slate-900">{meta.label}</span>
                        <span className="mt-0.5 block text-[10px] leading-4 text-slate-500">{meta.hint}</span>
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="min-w-0">
                <span className={cn(studioEyebrowClassName, 'mb-2 block')}>相关服务</span>
                <select
                  aria-label="相关服务"
                  className={cn(studioFieldClassName, 'py-2.5 text-sm')}
                  value={value.relatedService}
                  onChange={(event) => onChange({ relatedService: event.target.value })}
                >
                  {TICKET_SERVICE_ORDER.map((service) => (
                    <option key={service} value={service}>{TICKET_SERVICE_META[service].label}</option>
                  ))}
                </select>
              </label>
              <label className="min-w-0">
                <span className={cn(studioEyebrowClassName, 'mb-2 block')}>服务说明 / 任务 ID（可选）</span>
                <input
                  type="text"
                  maxLength={120}
                  placeholder="例如任务 ID、订单号、资源名"
                  className={studioFieldClassName}
                  value={value.relatedServiceRef}
                  onChange={(event) => onChange({ relatedServiceRef: event.target.value })}
                />
              </label>
            </div>

            <label className="block min-w-0">
              <span className={cn(studioEyebrowClassName, 'mb-2 block')}>联系邮箱</span>
              <input
                type="email"
                maxLength={254}
                placeholder="用于接收进展通知，留空则用账号邮箱"
                className={studioFieldClassName}
                value={value.contactEmail}
                onChange={(event) => onChange({ contactEmail: event.target.value })}
              />
              <span className="mt-1 block text-[10px] text-slate-400">
                通知仍优先发往账号邮箱；这里填写的地址仅作为客服回访的备用联系方式。
              </span>
            </label>

            <div>
              <span className={cn(studioEyebrowClassName, 'mb-2 block')}>
                关联工单（可选，最多 {MAX_RELATED_TICKETS} 个）
              </span>
              {value.relatedTicketIds.length > 0 && (
                <div className="mb-2 flex flex-wrap gap-2">
                  {value.relatedTicketIds.map((relatedId) => {
                    const candidate = linkingCandidates.find((item) => item._id === relatedId);
                    return (
                      <span
                        key={relatedId}
                        className="inline-flex max-w-[16rem] items-center gap-1 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11px] text-slate-700"
                      >
                        <span className="min-w-0 truncate">{candidate?.title || relatedId}</span>
                        <button
                          type="button"
                          aria-label={`取消关联 ${candidate?.title || relatedId}`}
                          onClick={() =>
                            onChange({
                              relatedTicketIds: value.relatedTicketIds.filter((id) => id !== relatedId),
                            })
                          }
                          className="shrink-0 rounded-full p-0.5 text-slate-400 transition hover:text-rose-600"
                        >
                          <FiX size={11} aria-hidden />
                        </button>
                      </span>
                    );
                  })}
                </div>
              )}
              <select
                aria-label="添加关联工单"
                className={cn(studioFieldClassName, 'py-2.5 text-sm')}
                value=""
                disabled={value.relatedTicketIds.length >= MAX_RELATED_TICKETS}
                onChange={(event) => {
                  const selected = event.target.value;
                  if (!selected || value.relatedTicketIds.includes(selected)) return;
                  onChange({ relatedTicketIds: [...value.relatedTicketIds, selected] });
                }}
              >
                <option value="">
                  {linkingCandidates.length === 0 ? '暂无可关联的工单' : '选择要关联的历史工单…'}
                </option>
                {linkingCandidates
                  .filter((item) => !value.relatedTicketIds.includes(item._id))
                  .map((item) => (
                    <option key={item._id} value={item._id}>{item.title}</option>
                  ))}
              </select>
            </div>

            <div>
              <div className="mb-2 flex items-center justify-between">
                <span className={cn(studioEyebrowClassName, 'block')}>附件</span>
                <span className="text-[10px] text-slate-400">
                  {canUploadFiles ? '可上传文件或粘贴链接' : '仅支持粘贴链接'}
                </span>
              </div>
              <div className="space-y-3">
                <TicketAttachmentLinks
                  links={value.attachmentLinks}
                  canEdit
                  policyHint={canUploadFiles ? null : capabilities?.attachmentUploadPolicy ?? null}
                  onError={onError}
                  onChange={(links) => onChange({ attachmentLinks: links })}
                />
                {canUploadFiles && (
                  <TicketAttachmentPicker
                    files={pendingFiles}
                    onChange={onPendingFilesChange}
                    disabled={isSubmitting}
                    onError={onError}
                  />
                )}
              </div>
            </div>
          </div>
        </details>

        <div className="flex flex-col gap-2 pt-2 sm:flex-row">
          <motion.button
            type="submit"
            disabled={isSubmitting}
            className={cn(studioPrimaryButtonClassName, 'flex-1')}
            whileHover={hoverScale(1.01)}
            whileTap={tapScale(0.99)}
          >
            <FiSend size={14} aria-hidden />
            {isSubmitting ? '提交中...' : '提交工单'}
          </motion.button>
          <motion.button
            type="button"
            onClick={onCancel}
            className={cn(studioGhostButtonClassName, 'px-6 py-3')}
            whileHover={hoverScale(1.01)}
            whileTap={tapScale(0.99)}
          >
            取消
          </motion.button>
        </div>
      </form>
    </div>
  );
};

export default TicketCreateForm;
