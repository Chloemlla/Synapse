import React from 'react';
import DOMPurify from 'dompurify';
import MarkdownRenderer from './MarkdownRenderer';
import { FaBullhorn } from 'react-icons/fa';
import { cn } from '../utils/cn';
import {
  studioDangerButtonClassName,
  studioPrimaryButtonClassName,
  studioSecondaryButtonClassName,
} from './studioTheme';
import { StudioModal, StudioModalHeader } from './studioFeedback';
import { useConfirm } from './confirm/ConfirmDialogProvider';

interface AnnouncementModalProps {
  open: boolean;
  onClose: () => void;
  onCloseToday: () => void;
  onCloseForever: () => void;
  content: string;
  format: 'markdown' | 'html';
  contentClassName?: string;
}

const TITLE_ID = 'announcement-modal-title';

// 弹窗外壳（z-[10050] 压过 MobileNav、Escape、focus trap、关闭后恢复焦点）走 StudioModal，
// 原先自建的 z-[9999] + bg-black 遮罩会被底部导航与确认弹窗互相盖住。
const AnnouncementModal: React.FC<AnnouncementModalProps> = ({
  open,
  onClose,
  onCloseToday,
  onCloseForever,
  content,
  format,
  contentClassName,
}) => {
  const confirm = useConfirm();

  // F5-17：「永久不再提示」不可撤销，先二次确认再落动作
  const handleCloseForever = async () => {
    const confirmed = await confirm({
      title: '永久不再提示这条公告？',
      description: '确认后这条公告将不再出现，之后也无法在页面上恢复查看。',
      confirmLabel: '永久不再提示',
      tone: 'danger',
    });
    if (!confirmed) return;
    onCloseForever();
  };

  return (
    <StudioModal open={open} onClose={onClose} titleId={TITLE_ID} maxWidthClassName="max-w-lg">
      <StudioModalHeader
        title="最新公告"
        titleId={TITLE_ID}
        icon={<FaBullhorn className="h-5 w-5" aria-hidden />}
        onClose={onClose}
        closeLabel="关闭公告"
      />
      <div className={cn('mt-5 mb-6 min-h-[60px]', contentClassName)}>
        {content ? (
          format === 'markdown' ? (
            <MarkdownRenderer content={content} density="compact" />
          ) : (
            <div className="prose max-w-none" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(content) }} />
          )
        ) : (
          <span className="text-slate-400">这条公告暂时没有正文，可先关闭。</span>
        )}
      </div>
      <div className="flex flex-col gap-3 sm:flex-row">
        <button
          type="button"
          onClick={() => onCloseToday()}
          className={cn(studioSecondaryButtonClassName, 'min-h-11 flex-1')}
        >
          今日不再提示
        </button>
        <button type="button" onClick={() => onClose()} className={cn(studioPrimaryButtonClassName, 'flex-1')}>
          关闭
        </button>
        <button
          type="button"
          onClick={() => void handleCloseForever()}
          className={cn(studioDangerButtonClassName, 'min-h-11 flex-1')}
        >
          永久不再提示
        </button>
      </div>
    </StudioModal>
  );
};

export default AnnouncementModal;
