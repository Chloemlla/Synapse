import React, { useCallback, useRef, useState } from 'react';
import { FiAlertCircle, FiDownload, FiFile, FiFileText, FiImage, FiLink, FiLoader, FiPaperclip, FiPlus, FiTrash2, FiUpload, FiX } from 'react-icons/fi';
import { cn } from '../../utils/cn';
import { useConfirm } from '../confirm/ConfirmDialogProvider';
import {
  studioEyebrowClassName,
  studioFieldClassName,
  studioGhostButtonClassName,
} from '../studioTheme';
import type { ITicketAttachment } from '../../api/ticketApi';
import { ticketApi } from '../../api/ticketApi';
import {
  MAX_TICKET_ATTACHMENTS,
  MAX_TICKET_ATTACHMENT_BYTES,
  MAX_TICKET_ATTACHMENT_LINKS,
  MAX_TICKET_ATTACHMENT_LINK_LABEL_LEN,
  TICKET_ATTACHMENT_ACCEPT,
  TICKET_ATTACHMENT_RULE_HINT,
  attachmentLinkHost,
  formatAttachmentSize,
  normalizeTicketAttachmentLinkUrl,
  validateTicketAttachmentFile,
} from './ticketConstants';

/**
 * 工单附件的三个视图：
 *
 * - `TicketAttachmentLinks`：**链接编辑器**（创建与详情都用）。附件上传默认对普通用户关闭，
 *   链接就是提交截图的通道；开关打开后也保留（图床/网盘地址不占本站存储）。
 * - `TicketAttachmentPicker`：**创建工单时**用。工单还不存在，所以只把 File 攒在内存里，
 *   提交成功后再逐个上传（后端上传端点要 ticketId）。校验口径与后端一致，
 *   但只是即时提示 —— 真正生效的边界在服务端。
 * - `TicketAttachmentList`：**工单详情**用。直接上传到已存在的工单，支持下载/删除。
 *   仅在 `canUploadFiles` 为真（超管，或管理员已开启开关）时渲染上传入口。
 * 两者都只接受白名单类型（jpg/jpeg/png/gif/txt/pdf）、单文件 ≤1MB、单工单 ≤5 个、
 * 文件名仅 ASCII（票面明确「不支持中文名称」）。
 */

function attachmentIcon(ext: string) {
  if (['jpg', 'jpeg', 'png', 'gif'].includes(ext)) return <FiImage size={14} />;
  if (ext === 'txt') return <FiFileText size={14} />;
  return <FiFile size={14} />;
}

interface LinksProps {
  links: Array<{ url: string; label?: string | null }>;
  /**
   * 链接列表变化（受控组件）。
   *
   * 创建时由表单状态承接；详情里由页面乐观更新 + 调接口（每次增/删一个链接=一次请求，
   * 因为这是离散动作而不是连续输入）。
   */
  onChange: (links: Array<{ url: string; label: string | null }>) => void;
  canEdit: boolean;
  /** 为什么需要填链接（上传关闭时显示），null 表示不额外提示。 */
  policyHint?: string | null;
  onError?: (message: string) => void;
}

/**
 * 附件链接编辑器：URL 输入框 + 可选说明 + 列表。
 *
 * 这个输入框在上传开关**关闭与打开时都展示**（票面要求）：关闭时它是提交截图的主通道，
 * 打开时它仍是补充（图床/网盘地址不占本站存储，也不必等上传）。
 */
export const TicketAttachmentLinks: React.FC<LinksProps> = ({
  links,
  onChange,
  canEdit,
  policyHint,
  onError,
}) => {
  const [url, setUrl] = useState('');
  const [label, setLabel] = useState('');

  const add = useCallback(() => {
    const parsed = normalizeTicketAttachmentLinkUrl(url);
    if (!parsed.ok) {
      onError?.(parsed.reason);
      return;
    }
    if (links.length >= MAX_TICKET_ATTACHMENT_LINKS) {
      onError?.(`附件链接最多 ${MAX_TICKET_ATTACHMENT_LINKS} 条`);
      return;
    }
    if (links.some((link) => link.url === parsed.url)) {
      onError?.('这条链接已经添加过了');
      return;
    }
    onChange([...links, { url: parsed.url, label: label.trim() || null }]);
    setUrl('');
    setLabel('');
  }, [label, links, onChange, onError, url]);

  return (
    <div className="space-y-2">
      <span className={cn(studioEyebrowClassName, 'flex items-center gap-1 text-[10px] text-slate-500')}>
        <FiLink size={10} /> 附件链接 {links.length}/{MAX_TICKET_ATTACHMENT_LINKS}
      </span>

      {canEdit && links.length < MAX_TICKET_ATTACHMENT_LINKS && (
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            type="url"
            value={url}
            inputMode="url"
            placeholder="粘贴图片或文件的链接（https://…）"
            aria-label="附件链接地址"
            maxLength={2048}
            className={cn(studioFieldClassName, 'min-w-0 flex-1 py-2 text-xs')}
            onChange={(event) => setUrl(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                add();
              }
            }}
          />
          <input
            type="text"
            value={label}
            placeholder="说明（可选）"
            aria-label="附件链接说明"
            maxLength={MAX_TICKET_ATTACHMENT_LINK_LABEL_LEN}
            className={cn(studioFieldClassName, 'py-2 text-xs sm:w-40')}
            onChange={(event) => setLabel(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                add();
              }
            }}
          />
          <button
            type="button"
            onClick={add}
            disabled={!url.trim()}
            className={cn(studioGhostButtonClassName, 'h-9 shrink-0 gap-1 px-3 py-0 text-[11px] normal-case tracking-normal')}
          >
            <FiPlus size={12} /> 添加
          </button>
        </div>
      )}

      {policyHint && (
        <p className="flex items-start gap-1 text-[10px] leading-4 text-amber-600">
          <FiAlertCircle className="mt-0.5 shrink-0" size={10} />
          <span>{policyHint}</span>
        </p>
      )}

      {links.length === 0 ? (
        <p className="text-[11px] text-slate-400">
          暂无附件链接。链接只会原样展示，本站不会代为下载或转存。
        </p>
      ) : (
        <ul className="space-y-2">
          {links.map((link) => (
            <li
              key={link.url}
              className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-3 py-2"
            >
              <FiLink className="shrink-0 text-slate-400" size={13} />
              <span className="min-w-0 flex-1 truncate text-xs text-slate-700" title={link.url}>
                {link.label ? `${link.label} · ` : ''}
                <span className="text-slate-400">{attachmentLinkHost(link.url)}</span>
              </span>
              <a
                href={link.url}
                target="_blank"
                // noopener + noreferrer：外部链接不得拿到 window.opener，也不带上来源页
                rel="noopener noreferrer nofollow"
                className="shrink-0 text-[10px] font-semibold text-slate-500 underline decoration-slate-300 underline-offset-2 transition hover:text-slate-900"
              >
                打开
              </a>
              {canEdit && (
                <button
                  type="button"
                  aria-label={`删除附件链接 ${link.url}`}
                  onClick={() => onChange(links.filter((item) => item.url !== link.url))}
                  className="shrink-0 rounded-full p-1 text-slate-400 transition hover:bg-slate-100 hover:text-rose-600"
                >
                  <FiX size={13} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

interface PickerProps {
  files: File[];
  onChange: (files: File[]) => void;
  /** 工单已存在的附件数（编辑场景），不参与上传前的数量校验时传 0。 */
  existingCount?: number;
  disabled?: boolean;
  onError?: (message: string) => void;
}

/**
 * 创建表单里的附件选择器：攒文件 + 本地校验，提交时才真正上传。
 */
export const TicketAttachmentPicker: React.FC<PickerProps> = ({
  files,
  onChange,
  existingCount = 0,
  disabled,
  onError,
}) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);

  const remaining = Math.max(0, MAX_TICKET_ATTACHMENTS - existingCount - files.length);

  const addFiles = useCallback(
    (incoming: FileList | File[] | null) => {
      if (!incoming || incoming.length === 0) return;
      const list = Array.from(incoming);
      const accepted: File[] = [];
      const rejected: string[] = [];
      for (const file of list) {
        const reason = validateTicketAttachmentFile(file);
        if (reason) {
          rejected.push(`${file.name}：${reason}`);
          continue;
        }
        // 同名同大小视为重复，避免用户连点两次选到同一个文件
        if (files.some((existing) => existing.name === file.name && existing.size === file.size)) continue;
        if (existingCount + files.length + accepted.length >= MAX_TICKET_ATTACHMENTS) {
          rejected.push(`${file.name}：最多 ${MAX_TICKET_ATTACHMENTS} 个附件`);
          continue;
        }
        accepted.push(file);
      }
      if (accepted.length > 0) onChange([...files, ...accepted]);
      if (rejected.length > 0) onError?.(rejected.join('；'));
    },
    [existingCount, files, onChange, onError],
  );

  return (
    <div className="space-y-2">
      <div
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled}
        onClick={() => {
          if (!disabled) inputRef.current?.click();
        }}
        onKeyDown={(event) => {
          if (disabled) return;
          if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
            event.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDragOver={(event) => {
          if (disabled) return;
          event.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={(event) => {
          if (disabled) return;
          event.preventDefault();
          setDragActive(false);
          addFiles(event.dataTransfer?.files ?? null);
        }}
        className={cn(
          'flex cursor-pointer flex-col items-center justify-center gap-1 rounded-2xl border border-dashed px-4 py-5 text-center transition',
          dragActive ? 'border-slate-900 bg-slate-50' : 'border-slate-200 bg-white hover:border-slate-300',
          disabled && 'cursor-not-allowed opacity-60',
        )}
      >
        <FiPaperclip className="text-slate-400" size={16} />
        <span className="text-xs font-semibold text-slate-700">
          {remaining > 0 ? '点击或拖拽添加附件（可选）' : `附件已达上限（${MAX_TICKET_ATTACHMENTS} 个）`}
        </span>
        <span className="text-[10px] leading-4 text-slate-400">{TICKET_ATTACHMENT_RULE_HINT}</span>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={TICKET_ATTACHMENT_ACCEPT}
          className="hidden"
          aria-label="选择工单附件"
          disabled={disabled}
          onChange={(event) => {
            addFiles(event.target.files);
            // 清空 value：否则再次选择同一个文件不会触发 change
            event.target.value = '';
          }}
        />
      </div>

      {files.length > 0 && (
        <ul className="space-y-2">
          {files.map((file) => (
            <li
              key={`${file.name}-${file.size}-${file.lastModified}`}
              className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-3 py-2"
            >
              <span className="text-slate-400">{attachmentIcon(file.name.split('.').pop()?.toLowerCase() ?? '')}</span>
              <span className="min-w-0 flex-1 truncate text-xs text-slate-700" title={file.name}>
                {file.name}
              </span>
              <span className="shrink-0 text-[10px] text-slate-400">{formatAttachmentSize(file.size)}</span>
              <button
                type="button"
                aria-label={`移除附件 ${file.name}`}
                onClick={() => onChange(files.filter((item) => item !== file))}
                className="shrink-0 rounded-full p-1 text-slate-400 transition hover:bg-slate-100 hover:text-rose-600"
              >
                <FiX size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

interface ListProps {
  ticketId: string;
  attachments: ITicketAttachment[];
  /** 当前用户是否可以上传（属主或 superadmin，且工单未关闭）。 */
  canUpload: boolean;
  /** 已关闭工单的提示文案（不可上传时展示）。 */
  uploadDisabledReason?: string;
  canDelete: (attachment: ITicketAttachment) => boolean;
  onUploaded: (payload: { attachment: ITicketAttachment; attachmentCount: number }) => void;
  onDeleted: (attachmentId: string, attachmentCount: number) => void;
  onError?: (message: string) => void;
}

/**
 * 工单详情里的附件区：上传（进度 + 失败重试）、下载、删除。
 */
export const TicketAttachmentList: React.FC<ListProps> = ({
  ticketId,
  attachments,
  canUpload,
  uploadDisabledReason,
  canDelete,
  onUploaded,
  onDeleted,
  onError,
}) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const confirm = useConfirm();
  const [uploadingName, setUploadingName] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [busyId, setBusyId] = useState<string | null>(null);

  const visible = attachments ?? [];

  const upload = useCallback(
    async (file: File) => {
      const reason = validateTicketAttachmentFile(file);
      if (reason) {
        onError?.(`${file.name}：${reason}`);
        return;
      }
      setUploadingName(file.name);
      setProgress(0);
      try {
        const result = await ticketApi.uploadAttachment(ticketId, file, setProgress);
        onUploaded(result);
      } catch (error) {
        const message =
          (error as { response?: { data?: { error?: string } } })?.response?.data?.error || '附件上传失败，请重试';
        onError?.(`${file.name}：${message}`);
      } finally {
        setUploadingName(null);
        setProgress(0);
      }
    },
    [onError, onUploaded, ticketId],
  );

  const download = useCallback(
    async (attachment: ITicketAttachment) => {
      setBusyId(attachment.id);
      try {
        await ticketApi.downloadAttachment(ticketId, attachment);
      } catch {
        onError?.('附件下载失败，请稍后重试');
      } finally {
        setBusyId(null);
      }
    },
    [onError, ticketId],
  );

  const remove = useCallback(
    async (attachment: ITicketAttachment) => {
      const ok = await confirm({
        title: '确认删除该附件？',
        description: `「${attachment.fileName}」删除后无法恢复，需要重新上传。`,
        tone: 'danger',
        confirmLabel: '删除附件',
      });
      if (!ok) return;
      setBusyId(attachment.id);
      try {
        const count = await ticketApi.deleteAttachment(ticketId, attachment.id);
        onDeleted(attachment.id, count);
      } catch (error) {
        const message =
          (error as { response?: { data?: { error?: string } } })?.response?.data?.error || '删除附件失败';
        onError?.(message);
      } finally {
        setBusyId(null);
      }
    },
    [confirm, onDeleted, onError, ticketId],
  );

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className={cn(studioEyebrowClassName, 'flex items-center gap-1 text-[10px] text-slate-500')}>
          <FiPaperclip size={11} /> 附件 {visible.length}/{MAX_TICKET_ATTACHMENTS}
        </div>
        {canUpload && visible.length < MAX_TICKET_ATTACHMENTS && (
          <>
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={Boolean(uploadingName)}
              className={cn(studioGhostButtonClassName, 'h-8 gap-1 px-2.5 py-0 text-[11px] normal-case tracking-normal')}
            >
              {uploadingName ? <FiLoader className="animate-spin" size={12} /> : <FiUpload size={12} />}
              {uploadingName ? `上传中 ${progress}%` : '添加附件'}
            </button>
            <input
              ref={inputRef}
              type="file"
              accept={TICKET_ATTACHMENT_ACCEPT}
              className="hidden"
              aria-label="添加工单附件"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) void upload(file);
              }}
            />
          </>
        )}
      </div>

      {!canUpload && uploadDisabledReason && (
        <p className="text-[10px] leading-4 text-slate-400">{uploadDisabledReason}</p>
      )}

      {visible.length === 0 ? (
        <p className="text-[11px] text-slate-400">暂无附件。{TICKET_ATTACHMENT_RULE_HINT}</p>
      ) : (
        <ul className="space-y-2">
          {visible.map((attachment) => (
            <li
              key={attachment.id}
              className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-3 py-2"
            >
              <span className="text-slate-400">{attachmentIcon(attachment.ext)}</span>
              <button
                type="button"
                onClick={() => void download(attachment)}
                disabled={busyId === attachment.id}
                title="下载附件"
                className="min-w-0 flex-1 truncate text-left text-xs text-slate-700 underline decoration-slate-300 underline-offset-2 transition hover:text-slate-900"
              >
                {attachment.fileName}
              </button>
              <span className="shrink-0 text-[10px] text-slate-400">
                {formatAttachmentSize(attachment.size)}
                {attachment.uploadedByName ? ` · ${attachment.uploadedByName}` : ''}
              </span>
              <button
                type="button"
                aria-label={`下载附件 ${attachment.fileName}`}
                onClick={() => void download(attachment)}
                disabled={busyId === attachment.id}
                className="shrink-0 rounded-full p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-900 disabled:opacity-50"
              >
                {busyId === attachment.id ? <FiLoader className="animate-spin" size={13} /> : <FiDownload size={13} />}
              </button>
              {canDelete(attachment) && (
                <button
                  type="button"
                  aria-label={`删除附件 ${attachment.fileName}`}
                  onClick={() => void remove(attachment)}
                  disabled={busyId === attachment.id}
                  className="shrink-0 rounded-full p-1 text-slate-400 transition hover:bg-slate-100 hover:text-rose-600 disabled:opacity-50"
                >
                  <FiTrash2 size={13} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {visible.length > 0 && (
        <p className="flex items-center gap-1 text-[10px] leading-4 text-slate-400">
          <FiAlertCircle size={10} /> 单个文件不超过 {formatAttachmentSize(MAX_TICKET_ATTACHMENT_BYTES)}，
          仅工单属主与超级管理员可下载。
        </p>
      )}
    </div>
  );
};
