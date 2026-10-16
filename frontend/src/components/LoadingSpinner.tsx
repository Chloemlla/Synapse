import React from 'react';
import { motion } from 'framer-motion';
import { useReducedMotion } from '../hooks/useReducedMotion';

// 配色基准：frontend/src/components/studioTheme.tsx。
// 旋转弧 = slate-900 主操作色 + sky 轻装饰（与 studioAccentBlobSkyClassName 同族），
// 不再使用 indigo/violet 十六进制或 rgb() 字面量（历史遗留见
// docs/audit/audit-2026-10-16-frontend-design-language.md FD-058 / FD-063）。
const SPINNER_TRACK = 'rgba(148, 163, 184, 0.22)'; // slate-400/22
const SPINNER_PRIMARY = 'rgb(15, 23, 42)'; // slate-900
const SPINNER_ACCENT = 'rgb(14, 165, 233)'; // sky-500
const SPINNER_HALO =
  'radial-gradient(circle, rgba(15,23,42,0.16) 0%, rgba(14,165,233,0.16) 45%, transparent 72%)';

// 轻量级加载组件（用于组件级别的懒加载），支持 size
export const SimpleLoadingSpinner: React.FC<{ size?: number }> = ({ size = 1 }) => {
  const reducedMotion = useReducedMotion();
  const spin = reducedMotion ? undefined : { rotate: 360 };
  const spinReverse = reducedMotion ? undefined : { rotate: -360 };
  const pulse = reducedMotion ? undefined : { opacity: [0.55, 0.95, 0.55], scale: [0.9, 1.04, 0.9] };
  const compact = size <= 0.75;
  const ringSize = compact ? Math.round(34 * size) : Math.round(56 * size);
  const ringStroke = Math.max(2, Math.round(2.6 * size));
  const haloSize = ringSize + Math.round(10 * size);
  const dotSize = Math.max(4, Math.round(ringSize * 0.26));
  const labelSize = 13 * size;
  const hintSize = 11 * size;

  const Spinner = (
    <div
      className="relative inline-flex items-center justify-center"
      style={{ width: ringSize, height: ringSize }}
      role="status"
      aria-label="加载中"
    >
      {/* 外发光光晕 */}
      <motion.div
        className="pointer-events-none absolute rounded-full"
        style={{
          width: haloSize,
          height: haloSize,
          background: SPINNER_HALO,
          filter: 'blur(6px)',
        }}
        animate={pulse}
        transition={{ duration: 2.6, repeat: Infinity, ease: 'easeInOut' }}
      />

      {/* 静态轨道环 */}
      <div
        className="absolute inset-0 rounded-full"
        style={{
          borderWidth: ringStroke,
          borderStyle: 'solid',
          borderColor: SPINNER_TRACK,
        }}
      />

      {/* 旋转主弧 */}
      <motion.div
        className="absolute inset-0 rounded-full"
        style={{
          borderWidth: ringStroke,
          borderStyle: 'solid',
          borderColor: 'transparent',
          borderTopColor: SPINNER_PRIMARY,
          borderRightColor: SPINNER_ACCENT,
          boxShadow: '0 0 12px rgba(15,23,42,0.22)',
        }}
        animate={spin}
        transition={{ duration: 1.05, repeat: Infinity, ease: 'linear' }}
      />

      {/* 反向次弧，叠出细节层次 */}
      <motion.div
        className="absolute rounded-full"
        style={{
          inset: ringStroke + 2,
          borderWidth: Math.max(1, ringStroke - 1),
          borderStyle: 'solid',
          borderColor: 'transparent',
          borderBottomColor: 'rgba(14, 165, 233, 0.55)',
        }}
        animate={spinReverse}
        transition={{ duration: 1.7, repeat: Infinity, ease: 'linear' }}
      />

      {/* 中心律动小点 */}
      <motion.div
        className="relative rounded-full"
        style={{
          width: dotSize,
          height: dotSize,
          background: `linear-gradient(135deg, ${SPINNER_PRIMARY}, ${SPINNER_ACCENT})`,
          boxShadow: '0 0 10px rgba(15,23,42,0.4)',
        }}
        animate={reducedMotion ? undefined : { scale: [0.78, 1.08, 0.78], opacity: [0.78, 1, 0.78] }}
        transition={{ duration: 1.4, repeat: Infinity, ease: 'easeInOut' }}
      />
    </div>
  );

  if (compact) {
    return Spinner;
  }

  return (
    <motion.div
      className="inline-flex flex-col items-center"
      style={{ gap: 14 * size }}
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.32, ease: 'easeOut' }}
    >
      {Spinner}
      <div className="flex flex-col items-center" style={{ gap: 4 * size }}>
        <motion.span
          className="font-semibold uppercase tracking-[0.26em] text-slate-500"
          style={{ fontSize: labelSize }}
          animate={reducedMotion ? undefined : { opacity: [0.78, 1, 0.78] }}
          transition={{ duration: 2.4, repeat: Infinity, ease: 'easeInOut' }}
        >
          Loading
        </motion.span>
        <span className="text-slate-400" style={{ fontSize: hintSize }}>
          正在整理页面内容
        </span>
      </div>
    </motion.div>
  );
};

// 统一的加载状态组件（类似 AnnouncementManager 的实现）
export const UnifiedLoadingSpinner: React.FC<{ 
  size?: 'sm' | 'md' | 'lg';
  text?: string;
  className?: string;
}> = ({ 
  size = 'md', 
  text = '加载中...',
  className = ''
}) => {
  const sizeClasses = {
    sm: 'h-6 w-6',
    md: 'h-8 w-8',
    lg: 'h-12 w-12'
  };

  return (
    <div className={`text-center py-8 text-slate-500 ${className}`}>
      <svg 
        className={`animate-spin ${sizeClasses[size]} mx-auto mb-4 text-slate-900`}
        fill="none" 
        viewBox="0 0 24 24"
      >
        <circle 
          className="opacity-25" 
          cx="12" 
          cy="12" 
          r="10" 
          stroke="currentColor" 
          strokeWidth="4"
        />
        <path 
          className="opacity-75" 
          fill="currentColor" 
          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
        />
      </svg>
      {text}
    </div>
  );
};

// 骨架屏加载组件
export const SkeletonLoader: React.FC = () => {
  return (
    <div className="animate-pulse">
      <div className="h-4 bg-slate-200 rounded w-3/4 mb-4"></div>
      <div className="h-4 bg-slate-200 rounded w-1/2 mb-4"></div>
      <div className="h-4 bg-slate-200 rounded w-5/6"></div>
    </div>
  );
}; 
