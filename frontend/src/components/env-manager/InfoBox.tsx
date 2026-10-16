import React from 'react';
import { cn } from '../../utils/cn';

type InfoBoxTone = 'amber' | 'emerald';

interface InfoBoxProps {
  icon?: React.ReactNode;
  children: React.ReactNode;
  tone?: InfoBoxTone;
  className?: string;
}

// 提示条只有「注意（amber）」与「可用/已生效（emerald）」两种语气；
// 调用方不再各自手写一遍同一串 Tailwind（FD-039）。
const TONE_CLASSES: Record<InfoBoxTone, { box: string; icon: string }> = {
  amber: {
    box: 'rounded-2xl border border-amber-200 bg-amber-50/70 text-amber-900',
    icon: 'text-amber-700',
  },
  emerald: {
    box: 'rounded-2xl border border-emerald-200 bg-emerald-50/70 text-emerald-900',
    icon: 'text-emerald-700',
  },
};

const InfoBox: React.FC<InfoBoxProps> = ({ icon, children, tone = 'amber', className }) => (
  <div className={cn('px-4 py-3 text-xs leading-5 sm:px-5 sm:py-4', TONE_CLASSES[tone].box, className)}>
    <div className="flex items-start gap-2">
      {icon ? (
        <div className={cn('mt-0.5 shrink-0 [&>svg]:h-4 [&>svg]:w-4', TONE_CLASSES[tone].icon)}>{icon}</div>
      ) : null}
      <div>{children}</div>
    </div>
  </div>
);

export default InfoBox;
