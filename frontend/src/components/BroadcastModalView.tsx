/**
 * 广播弹窗的视图层（独立模块，按需加载）。
 *
 * 性能：本文件会连带 framer-motion / react-icons / DOMPurify / MarkdownRenderer（mermaid+katex+Prism）。
 * 它挂在应用根部的 BroadcastModalProvider 下，但只在真的有广播弹窗时才渲染，
 * 因此必须与 Provider 分离成独立模块，由 Provider 用 React.lazy 加载，
 * 否则这些依赖会跟着入口进首屏（见 docs/perf/2026-10-01-captcha-verify-trace-analysis.md）。
 */
import { useCallback, useMemo, useState } from 'react';
import { FaBullhorn, FaExclamationTriangle, FaInfoCircle, FaCheckCircle } from 'react-icons/fa';
import DOMPurify from 'dompurify';
import { useNavigate } from 'react-router-dom';
import MarkdownRenderer from './MarkdownRenderer';
import {
  type ConfigurationNoticeIssue,
  type ConfigurationNoticeWorkflow,
  readConfigurationWorkflow,
  writeConfigurationWorkflow,
} from './env-manager/configurationNotice';
import { studioPrimaryButtonClassName, studioSecondaryButtonClassName } from './studioTheme';
import { StudioModal, StudioModalHeader } from './studioFeedback';
import { cn } from '../utils/cn';
import type { BroadcastFormat, BroadcastLevel } from './BroadcastModal';

interface BroadcastModalViewProps {
  title?: string;
  content: string;
  format?: BroadcastFormat;
  level?: BroadcastLevel;
  issueIds?: string[];
  issues?: ConfigurationNoticeIssue[];
  onClose: () => void;
}

const TITLE_ID = 'broadcast-modal-title';

// 弹窗外壳（层级、Escape、focus trap、恢复焦点）统一由 StudioModal 提供，这里只留内容与语义色。
const LEVEL_CONFIG = {
  info: {
    icon: <FaInfoCircle className="h-4 w-4" aria-hidden />,
    iconClassName: 'bg-sky-50 text-sky-600',
    badge: 'bg-sky-100 text-sky-700',
    label: '系统通知',
  },
  warn: {
    icon: <FaExclamationTriangle className="h-4 w-4" aria-hidden />,
    iconClassName: 'bg-amber-50 text-amber-600',
    badge: 'bg-amber-100 text-amber-700',
    label: '重要提醒',
  },
  error: {
    icon: <FaExclamationTriangle className="h-4 w-4" aria-hidden />,
    iconClassName: 'bg-rose-50 text-rose-600',
    badge: 'bg-rose-100 text-rose-700',
    label: '紧急通知',
  },
} as const;

function BroadcastModalView({ title, content, format = 'text', level = 'info', issues = [], onClose }: BroadcastModalViewProps) {
  const cfg = LEVEL_CONFIG[level] || LEVEL_CONFIG.info;
  const navigate = useNavigate();
  const isConfigurationNotice = title === '服务配置待完善' && issues.length > 0;
  const [ignoredIds, setIgnoredIds] = useState<string[]>(() => readConfigurationWorkflow()?.ignoredIds || []);
  const activeIssues = issues.filter((issue) => !ignoredIds.includes(issue.id));

  const handleConfigureIssue = useCallback((issue: ConfigurationNoticeIssue) => {
    const workflow: ConfigurationNoticeWorkflow = {
      issues,
      ignoredIds,
    };
    writeConfigurationWorkflow(workflow);
    onClose();
    navigate(`/admin/env?configIssue=${encodeURIComponent(issue.id)}`);
  }, [ignoredIds, issues, navigate, onClose]);

  const handleIgnoreIssue = useCallback((issueId: string) => {
    const nextIgnoredIds = Array.from(new Set([...ignoredIds, issueId]));
    setIgnoredIds(nextIgnoredIds);
    writeConfigurationWorkflow({ issues, ignoredIds: nextIgnoredIds });
  }, [ignoredIds, issues]);

  const renderedHtml = useMemo(() => {
    if (format === 'html') {
      return DOMPurify.sanitize(content, {
        ALLOWED_TAGS: [
          'p', 'br', 'strong', 'em', 'b', 'i', 'u', 'a', 'ul', 'ol', 'li',
          'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'code',
          'span', 'div', 'hr', 'img', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
        ],
        ALLOWED_ATTR: ['href', 'target', 'rel', 'src', 'alt', 'class', 'style', 'width', 'height'],
      });
    }
    return '';
  }, [content, format]);

  return (
    <StudioModal
      open
      onClose={onClose}
      titleId={TITLE_ID}
      maxWidthClassName="max-w-lg"
      closeLabel="关闭通知"
    >
      <StudioModalHeader
        title={title || '管理员通知'}
        titleId={TITLE_ID}
        icon={cfg.icon}
        iconClassName={cfg.iconClassName}
        onClose={onClose}
        closeLabel="关闭通知"
        description={
          <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-semibold', cfg.badge)}>
            <FaBullhorn className="h-3 w-3" aria-hidden />
            {cfg.label}
          </span>
        }
      />

      <div className="mt-5">
        {isConfigurationNotice ? (
          <div className="space-y-4">
            <div className="flex items-center justify-between text-sm text-slate-600">
              <span>待处理配置</span>
              <span>{activeIssues.length} / {issues.length}</span>
            </div>
            {activeIssues.length > 0 ? (
              <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
                <div className="flex items-start gap-3">
                  <FaExclamationTriangle className="mt-0.5 shrink-0 text-amber-500" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold text-slate-800">{activeIssues[0].label}</div>
                    <div className="mt-1 break-words font-mono text-xs text-slate-600">
                      {activeIssues[0].settingNames.join(' / ')}
                    </div>
                    <p className="mt-2 text-sm leading-relaxed text-slate-700">{activeIssues[0].impact}</p>
                  </div>
                </div>
                <div className="mt-4 flex flex-wrap justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => handleIgnoreIssue(activeIssues[0].id)}
                    className={cn(studioSecondaryButtonClassName, 'min-h-11')}
                  >
                    忽略此项
                  </button>
                  <button
                    type="button"
                    onClick={() => handleConfigureIssue(activeIssues[0])}
                    className={studioPrimaryButtonClassName}
                  >
                    <FaCheckCircle aria-hidden />
                    前往配置
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-700">
                <FaCheckCircle aria-hidden />
                已忽略当前列表中的配置项。
              </div>
            )}
          </div>
        ) : (
          <div className="max-h-[50vh] overflow-y-auto">
            {format === 'text' && (
              <p className="whitespace-pre-wrap leading-relaxed text-slate-700">{content}</p>
            )}
            {format === 'markdown' && (
              <MarkdownRenderer content={content} density="compact" />
            )}
            {format === 'html' && (
              <div
                className="prose prose-sm max-w-none text-slate-700"
                dangerouslySetInnerHTML={{ __html: renderedHtml }}
              />
            )}
          </div>
        )}
      </div>

      <div className="mt-6 flex justify-center">
        <button type="button" onClick={onClose} className={studioPrimaryButtonClassName}>
          {isConfigurationNotice && activeIssues.length > 0 ? '稍后处理' : '知道了'}
        </button>
      </div>
    </StudioModal>
  );
}

export default BroadcastModalView;
