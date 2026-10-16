import React from 'react';
import { m, useReducedMotion } from 'framer-motion';
import { FaChevronDown } from 'react-icons/fa';
import { DURATION_06, ENTER_ANIMATE, ENTER_INITIAL, NO_DURATION } from './motion';
import { studioSecondaryButtonClassName, studioSurfaceClassName } from '../studioTheme';

interface CollapsibleSectionProps {
  title: string;
  description?: string;
  sectionKey: string;
  isOpen: boolean;
  onToggle: (key: string) => void;
  children: React.ReactNode;
  headerRight?: React.ReactNode;
  prefersReducedMotion?: boolean | null;
}

const CollapsibleSection = React.memo(function CollapsibleSection({
  title, description, sectionKey, isOpen, onToggle, children, headerRight, prefersReducedMotion
}: CollapsibleSectionProps) {
  // 调用方可能没传 reduced-motion 判定（如自包含分区），此处按系统偏好兜底（FD-063）。
  const reducedMotion = useReducedMotion() ?? prefersReducedMotion;

  return (
    <m.section
      data-env-section={sectionKey}
      className={studioSurfaceClassName}
      initial={ENTER_INITIAL}
      animate={ENTER_ANIMATE}
      transition={reducedMotion ? NO_DURATION : DURATION_06}
    >
      <div className="flex flex-col gap-3 border-b border-slate-100 px-4 py-3 sm:px-5 sm:py-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="text-lg font-semibold text-slate-800">{title}</h3>
          {description ? <p className="mt-1 text-sm text-slate-500">{description}</p> : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {headerRight}
          <button
            type="button"
            onClick={() => onToggle(sectionKey)}
            className={studioSecondaryButtonClassName}
          >
            <FaChevronDown className={`transition-transform ${isOpen ? '' : '-rotate-90'}`} />
            {isOpen ? '收起' : '展开'}
          </button>
        </div>
      </div>
      {isOpen && (
        <div className="space-y-4 px-4 py-4 sm:px-5 sm:py-5">
          {children}
        </div>
      )}
    </m.section>
  );
});

export default CollapsibleSection;
