import React from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { FiPlus, FiSend, FiX } from 'react-icons/fi';
import { cn } from '../../utils/cn';
import type { TicketCapabilities } from '../../api/ticketApi';
import { TicketAttachmentLinks, TicketAttachmentPicker } from './TicketAttachments';
import {
  MAX_TICKET_DESC_LEN,
  MAX_TICKET_TITLE_LEN,
  TICKET_CATEGORY_META,
  TICKET_CATEGORY_ORDER,
  TICKET_SERVICE_META,
  TICKET_SERVICE_ORDER,
  TICKET_TYPE_META,
  TICKET_TYPE_ORDER,
} from './ticketConstants';
import {
  studioDisplayFont,
  studioEyebrowClassName,
  studioFieldClassName,
  studioGhostButtonClassName,
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
}

const MAX_RELATED_TICKETS = 5;

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
}) => {
  const prefersReducedMotion = useReducedMotion();
  const hoverScale = (scale: number) => (prefersReducedMotion ? undefined : { scale });
  const tapScale = (scale: number) => (prefersReducedMotion ? undefined : { scale });

  const canUploadFiles = capabilities?.canUploadAttachments === true;

  return (
    <div className="max-w-xl mx-auto">
      <div className="mb-5 flex items-center gap-3">
        <div className={studioStrongBadgeClassName}>
          <FiPlus />
        </div>
        <div>
          <div className={studioEyebrowClassName}>New Ticket</div>
          <h3 className="text-xl font-semibold text-slate-900" style={{ fontFamily: studioDisplayFont }}>
            发起新工单
          </h3>
        </div>
      </div>

      <form onSubmit={onSubmit} className="space-y-4 sm:space-y-5">
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
          <label className={cn(studioEyebrowClassName, 'mb-2 block')}>工单类型</label>
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
          <label className={cn(studioEyebrowClassName, 'mb-2 block')}>
            关联工单（可选，最多 {MAX_RELATED_TICKETS} 个）
          </label>
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
                      <FiX size={11} />
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
            <label className={cn(studioEyebrowClassName, 'block')}>附件</label>
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
                <label key={priority} className="flex-1">
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
                      'text-center py-2.5 rounded-2xl border cursor-pointer transition-all text-xs sm:text-sm font-semibold sm:rounded-2xl',
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

        {overlengthNotice}

        <div className="flex flex-col gap-2 pt-2 sm:flex-row">
          <motion.button
            type="submit"
            disabled={isSubmitting}
            className={cn(studioPrimaryButtonClassName, 'flex-1')}
            whileHover={hoverScale(1.01)}
            whileTap={tapScale(0.99)}
          >
            <FiSend size={14} />
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
