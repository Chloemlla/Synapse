import React, { Suspense, createContext, use, useState, useCallback } from 'react';
import { type ConfigurationNoticeIssue } from './env-manager/configurationNotice';

// ========== 类型 ==========

// 性能：视图层（framer-motion + react-icons + DOMPurify + MarkdownRenderer→mermaid/katex/Prism）
// 与 Provider 分离。Provider 挂在应用根部（App.tsx），静态引用会让每个路由都背这套依赖；
// 视图只在真的有广播时才需要，所以这里 React.lazy。
// 见 docs/perf/2026-10-01-captcha-verify-trace-analysis.md。
const BroadcastModalView = React.lazy(() => import('./BroadcastModalView'));

export type BroadcastFormat = 'text' | 'html' | 'markdown';
export type BroadcastLevel = 'info' | 'warn' | 'error';

export interface BroadcastModalData {
  title?: string;
  content: string;
  format?: BroadcastFormat;
  level?: BroadcastLevel;
  issueIds?: string[];
  issues?: ConfigurationNoticeIssue[];
}

interface BroadcastModalContextProps {
  showBroadcastModal: (data: BroadcastModalData) => void;
}

const BroadcastModalContext = createContext<BroadcastModalContextProps>({
  showBroadcastModal: () => {},
});

export const useBroadcastModal = () => use(BroadcastModalContext);

// ========== Provider ==========

export const BroadcastModalProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [modal, setModal] = useState<(BroadcastModalData & { open: boolean }) | null>(null);

  const showBroadcastModal = useCallback((data: BroadcastModalData) => {
    setModal({ ...data, open: true });
  }, []);

  const handleClose = useCallback(() => {
    setModal(null);
  }, []);

  return (
    <BroadcastModalContext.Provider value={{ showBroadcastModal }}>
      {children}
      {modal?.open && (
        <Suspense fallback={null}>
          <BroadcastModalView
            title={modal.title}
            content={modal.content}
            format={modal.format}
            level={modal.level}
            issueIds={modal.issueIds}
            issues={modal.issues}
            onClose={handleClose}
          />
        </Suspense>
      )}
    </BroadcastModalContext.Provider>
  );
};
