// 批量转换的「来源文件」列表：相对路径 + 大小/时间 + 新旧徽章 + 筛选与勾选。
//
// 徽章文案只讲状态（待生成 / 待更新 / 已是最新 / 会另存为 xxx (2).docx），
// 不讲「为什么」——判定逻辑在后端，前端照抄服务端给的 status / willRename 即可。

import React, { useMemo, useState } from 'react';
import { FaSearch } from 'react-icons/fa';
import type { DocFileEntry, DocFileFreshness } from '../../api/docTool';
import { fmtBytes, fmtTime } from '../admin/media-tool/ui';
import { studioBadgeClassName, studioFieldClassName, studioSurfaceClassName } from '../studioTheme';

const FRESHNESS_VIEW: Record<DocFileFreshness, { label: string; tone: 'blue' | 'yellow' | 'green' }> = {
  new: { label: '待生成', tone: 'blue' },
  stale: { label: '待更新', tone: 'yellow' },
  fresh: { label: '已是最新', tone: 'green' },
};

const SELECT_BUTTON_CLASS =
  'inline-flex items-center rounded-xl border border-slate-200 bg-white/80 px-2.5 py-1.5 text-[11px] font-semibold text-slate-600 transition hover:border-slate-300 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-50';

const baseName = (rel: string): string => rel.replace(/\\/g, '/').split('/').pop() || rel;

export interface DocFileListProps {
  files: DocFileEntry[];
  /** 已勾选的相对路径（与 files[].rel 同一套命名）。 */
  selected: string[];
  loading: boolean;
  onToggle: (rel: string) => void;
  onSelectAll: () => void;
  onSelectNone: () => void;
  onSelectNeeded: () => void;
}

const DocFileList: React.FC<DocFileListProps> = ({
  files,
  selected,
  loading,
  onToggle,
  onSelectAll,
  onSelectNone,
  onSelectNeeded,
}) => {
  const [query, setQuery] = useState('');

  const visible = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return files;
    return files.filter((entry) => entry.rel.toLowerCase().includes(keyword));
  }, [files, query]);

  return (
    <section className={`${studioSurfaceClassName} overflow-hidden`}>
      <div className="flex flex-col gap-3 border-b border-slate-100 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="text-sm font-semibold text-slate-700">
          文件列表
          <span className="ml-2 text-xs font-normal text-slate-400">
            {`共 ${files.length} 个 · 已勾选 ${selected.length} 个`}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="relative min-w-[180px] flex-1 sm:flex-none">
            <FaSearch className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[11px] text-slate-400" />
            <input
              type="search"
              aria-label="筛选文件"
              placeholder="按名称或路径筛选"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className={`${studioFieldClassName} py-2 pl-8 text-xs`}
            />
          </label>
          <button type="button" onClick={onSelectAll} className={SELECT_BUTTON_CLASS} disabled={files.length === 0}>
            全选
          </button>
          <button type="button" onClick={onSelectNone} className={SELECT_BUTTON_CLASS} disabled={files.length === 0}>
            全不选
          </button>
          <button type="button" onClick={onSelectNeeded} className={SELECT_BUTTON_CLASS} disabled={files.length === 0}>
            只选需要生成的
          </button>
        </div>
      </div>

      <div className="max-h-80 overflow-y-auto">
        {loading ? (
          <div className="px-4 py-10 text-center text-sm text-slate-400">正在读取文件列表…</div>
        ) : visible.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-slate-400">
            {files.length === 0 ? '还没有文件，先上传一些 .md 文件。' : '没有匹配的文件。'}
          </div>
        ) : (
          visible.map((entry) => {
            const badge = FRESHNESS_VIEW[entry.status] ?? { label: entry.status, tone: 'slate' as const };
            return (
              <label
                key={entry.rel}
                className="flex cursor-pointer items-start gap-3 border-b border-slate-50 px-4 py-2.5 last:border-b-0 hover:bg-slate-50/60"
              >
                <input
                  type="checkbox"
                  aria-label={entry.rel}
                  className="mt-1 size-4 shrink-0"
                  checked={selected.includes(entry.rel)}
                  onChange={() => onToggle(entry.rel)}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="truncate font-mono text-xs text-slate-700" title={entry.rel}>
                      {entry.rel}
                    </span>
                    <span className={studioBadgeClassName(badge.tone)}>{badge.label}</span>
                    {entry.willRename ? (
                      <span className={studioBadgeClassName('violet')}>
                        {`会另存为 ${baseName(entry.destRel)}`}
                      </span>
                    ) : null}
                  </span>
                  <span className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-slate-400">
                    <span>{fmtBytes(entry.sizeBytes)}</span>
                    <span>{fmtTime(entry.mtime)}</span>
                    <span className="truncate" title={entry.destRel}>
                      {`输出：${entry.destRel}`}
                    </span>
                  </span>
                </span>
              </label>
            );
          })
        )}
      </div>
    </section>
  );
};

export default DocFileList;
