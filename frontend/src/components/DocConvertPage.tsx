// 批量转换的独立深链页（/doc-convert）。
//
// 这里静态 import DocBatchPanel 是安全的：App.tsx 用 React.lazy 载入本页，
// 本页及其依赖只落在独立 chunk 里，不会进首屏静态闭包（首屏有 800 KiB gzip 预算）。

import React from 'react';
import { motion } from 'framer-motion';
import { FaFileWord } from 'react-icons/fa';
import { useReducedMotion } from '../hooks/useReducedMotion';
import { cn } from '../utils/cn';
import {
  studioAccentBlobBlueClassName,
  studioEyebrowPillClassName,
  studioHeroCardClassName,
  studioPageClassName,
} from './studioTheme';
import FeatureConsentGate from './FeatureConsentGate';
import DocBatchPanel from './docTool/DocBatchPanel';

const DocConvertPage: React.FC = () => {
  const reducedMotion = useReducedMotion();

  return (
    <div className={studioPageClassName}>
      <div className="mx-auto max-w-6xl min-w-0">
        <motion.div
          className={cn('mb-5 sm:mb-8', studioHeroCardClassName)}
          initial={reducedMotion ? false : { opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
        >
          <div className={cn(studioAccentBlobBlueClassName, '-right-16 top-0')} aria-hidden />
          <div className="relative">
            <div className={studioEyebrowPillClassName}>
              <FaFileWord className="text-[10px]" /> Doc Convert
            </div>
            <h1 className="mt-5 text-3xl font-semibold leading-tight text-slate-900 sm:text-4xl">Markdown 转 Word</h1>
            <p className="mt-4 max-w-2xl text-sm leading-7 text-slate-600 sm:text-base">
              上传多个 Markdown 文件，一次转换成带统一中文字体与标题样式的 Word 文档。
            </p>
          </div>
        </motion.div>

        {/* 上传的文件会由服务端处理：未同意使用政策与服务专项条款时先给出同意清单，而不是功能面板 */}
        <FeatureConsentGate feature="doc-tool">
          <DocBatchPanel />
        </FeatureConsentGate>
      </div>
    </div>
  );
};

export default DocConvertPage;
