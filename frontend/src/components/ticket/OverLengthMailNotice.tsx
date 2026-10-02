import React, { useCallback, useState } from 'react';
import { FiAlertCircle, FiMail } from 'react-icons/fi';
import { cn } from '../../utils/cn';
import { studioGhostButtonClassName, studioPrimaryButtonClassName } from '../studioTheme';
import { SUPPORT_EMAIL } from '../PenaltyAppealActions';

export type OverLengthDraft = { kind: 'create' | 'reply'; title: string; content: string } | null;

/** 超长内容改走邮件：主题带工单标题，正文预填账号 + 聊天通道放不下的完整原文 */
export function buildOverLengthMailHref(draft: NonNullable<OverLengthDraft>, account: string): string {
  const kindLabel = draft.kind === 'create' ? '新建工单' : '向已有工单追加回复';
  const subject = encodeURIComponent(`[工单内容超长] ${draft.title.slice(0, 60)}`);
  const body = encodeURIComponent(
    `账号：${account}\n`
      + `类型：${kindLabel}\n`
      + `工单标题：${draft.title || '（未填写）'}\n\n`
      + `以下内容超过聊天通道 4000 字上限，无法通过工单提交，请代为处理：\n\n${draft.content}`,
  );
  return `mailto:${SUPPORT_EMAIL}?subject=${subject}&body=${body}`;
}

/** 超长拦截后的 inline 引导：给出管理员邮箱，提供一键写信与复制原文 */
export function OverLengthMailNotice({ draft, account, onDismiss }: {
  draft: NonNullable<OverLengthDraft>;
  account: string;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(draft.content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }, [draft.content]);
  return (
    <div className="rounded-2xl border border-amber-300 bg-amber-50 p-3 sm:p-4 text-xs sm:text-sm text-amber-900">
      <p className="font-semibold flex items-center gap-2">
        <FiAlertCircle className="shrink-0" /> 内容超过 4000 字，工单通道无法提交
      </p>
      <p className="mt-1.5 leading-relaxed">
        工单消息设长度上限以保证能及时处理。较长内容请直接发送至管理员邮箱{' '}
        <span className="font-mono font-semibold break-all">{SUPPORT_EMAIL}</span>
        ，并注明您的账号（{account || '未登录'}）与标题“{draft.title || '未填写'}”，
        管理员收到后会将完整内容创建为工单或追加到该工单。
      </p>
      <div className="mt-2.5 flex flex-wrap gap-2">
        <a
          href={buildOverLengthMailHref(draft, account)}
          target="_blank"
          rel="noreferrer"
          className={cn(studioPrimaryButtonClassName, 'px-3 py-1.5 text-xs')}
        >
          <FiMail className="mr-1" /> 打开邮件客户端发送
        </a>
        <button
          type="button"
          onClick={() => { void handleCopy(); }}
          className={cn(studioGhostButtonClassName, 'px-3 py-1.5 text-xs')}
        >
          {copied ? '已复制原文' : '复制完整内容'}
        </button>
        <button type="button" onClick={onDismiss} className={cn(studioGhostButtonClassName, 'px-3 py-1.5 text-xs')}>
          返回编辑
        </button>
      </div>
    </div>
  );
}
