import React from 'react';
import { cn } from '@/utils/cn';
import { studioFieldClassName } from '../studioTheme';

/**
 * 基准表单输入。
 *
 * 视觉基准：frontend/src/components/studioTheme.tsx 的 studioFieldClassName
 * （`rounded-2xl` + slate-200 边框 + white/80 底 + slate-300 focus ring）。
 * 这里只做包装，不再自带一套颜色/圆角——历史上这个文件是个裸 `<input>`，
 * 导致 `components/ui` 系页面与 studio 系页面的输入框观感不同
 * （docs/audit/audit-2026-10-16-frontend-design-language.md FD-004 / FD-045）。
 */
export const Input: React.FC<React.InputHTMLAttributes<HTMLInputElement>> = ({
  className,
  ...props
}) => <input {...props} className={cn(studioFieldClassName, className)} />;

export default Input;
