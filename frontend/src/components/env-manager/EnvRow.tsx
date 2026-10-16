import React, { useMemo } from 'react';
import { m } from 'framer-motion';
import { FaInfoCircle } from 'react-icons/fa';
import { NO_DURATION } from './motion';
import type { EnvItem } from './types';

interface EnvRowProps {
  item: EnvItem;
  idx: number;
  prefersReducedMotion: boolean;
  onSourceClick: (source: string) => void;
}

const EnvRow = React.memo(function EnvRow({ item, idx, prefersReducedMotion, onSourceClick }: EnvRowProps) {
  const rowTransition = useMemo(() => (
    prefersReducedMotion ? NO_DURATION : { duration: 0.3, delay: idx * 0.05 }
  ), [prefersReducedMotion, idx]);

  return (
    <m.tr
      className={`border-b border-slate-100 last:border-b-0 transition-colors hover:bg-slate-100/70 ${idx % 2 === 0 ? 'bg-white' : 'bg-slate-50'
        }`}
      initial={{ opacity: 0, x: -20 }}
      animate={{ opacity: 1, x: 0 }}
      transition={rowTransition}
    >
      <td className="px-4 py-3 font-mono text-sm font-medium text-slate-900 align-top">
        <div className="break-words whitespace-normal leading-relaxed flex items-start gap-1">
          {item.source && (
            <button
              type="button"
              onClick={() => onSourceClick(item.source!)}
              aria-label="查看数据来源"
              className="mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-500 transition-colors hover:bg-slate-200 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300 focus-visible:ring-offset-1"
            >
              <FaInfoCircle className="h-3 w-3" aria-hidden />
            </button>
          )}
          <span>{item.key.split(':').pop() || item.key}</span>
        </div>
      </td>
      <td className="px-4 py-3 font-mono text-sm text-slate-700 align-top">
        <div className="break-words whitespace-pre-wrap leading-relaxed">
          {item.value}
        </div>
      </td>
    </m.tr>
  );
});

export default EnvRow;
