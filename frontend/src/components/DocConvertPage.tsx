// 批量转换的独立深链页（/doc-convert）。
//
// 这里静态 import DocBatchPanel 是安全的：App.tsx 用 React.lazy 载入本页，
// 本页及其依赖只落在独立 chunk 里，不会进首屏静态闭包（首屏有 800 KiB gzip 预算）。

import React from 'react';
import { motion } from 'framer-motion';
import { FaFileWord } from 'react-icons/fa';
import { studioEyebrowPillClassName } from './studioTheme';
import DocBatchPanel from './docTool/DocBatchPanel';

const DocConvertPage: React.FC = () => (
  <section className="mx-auto max-w-6xl px-4 py-10 sm:py-12">
    <motion.div
      className="relative overflow-hidden rounded-2xl border border-slate-200 bg-white/88 p-6 shadow-sm backdrop-blur-xl sm:p-10"
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
    >
      <div className="pointer-events-none absolute -right-16 top-0 h-48 w-48 rounded-full bg-[radial-gradient(circle,_rgba(59,130,246,0.22),_transparent_68%)]" />
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

    <div className="mt-6">
      <DocBatchPanel />
    </div>
  </section>
);

export default DocConvertPage;
