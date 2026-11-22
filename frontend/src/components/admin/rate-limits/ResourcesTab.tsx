import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FaShieldAlt } from 'react-icons/fa';
import { rateLimitsApi, type ResourcesResponse } from '@/api/rateLimits';
import { InfoBadge, InfoPanel } from '@/components/studioTheme';
import { StudioErrorState, StudioLoadingState } from '@/components/studioFeedback';
import { getBackendErrorMessage } from '@/utils/backendError';
import { formatBytes } from './format';
import { DataPanel, FieldGrid, FieldRow, RefreshButton, TableWrap, Td, Th } from './ui';

/**
 * 资源闸门生效值（RC-39 / RC-27 的沙箱与看门狗部分）。
 *
 * 每条都给「env 名 / 生效值 / 默认值」三列：管理员看到的必须是当前进程真在用的值，
 * 而不是 `.env.example` 里的示例值。页面只读 —— 改限制要动部署配置或运行时配置，且会改变全站行为。
 */
const USAGE_HINTS: Record<string, string> = {
  maxFileBytes: '单文件字节上限；超过直接拒绝（不是截断）',
  maxFilesPerJob: '单个转写任务的文件数上限',
  maxUserDirBytes: '单用户工作目录总字节（含 inbox 与产物）',
  maxUserDirFiles: '单用户工作目录文件数（防病态写入）',
  maxUploadBytes: 'doc-tool 单次上传 .md 总大小',
  maxActiveJobs: 'doc-tool 单用户排队+运行任务数',
  maxFileBytesDoc: 'doc-tool 单个 .md 大小',
  maxFilesPerJobDoc: 'doc-tool 单任务文件数',
  retentionDays: 'doc-tool 产物保留天数（与 Mongo TTL 一致）',
};

const RATE_LIMITS: Record<string, (value: number) => string> = {
  maxFileBytes: formatBytes,
  maxUserDirBytes: formatBytes,
  maxUploadBytes: formatBytes,
  maxUserDirFiles: (value) => `${value} 个`,
  maxFilesPerJob: (value) => `${value} 个`,
  maxActiveJobs: (value) => `${value} 个`,
  retentionDays: (value) => `${value} 天`,
};

const RateLimitsResourcesTab: React.FC<{ refreshNonce: number }> = ({ refreshNonce }) => {
  const [data, setData] = useState<ResourcesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestRef.current;
    setLoading(true);
    try {
      const res = await rateLimitsApi.resources();
      if (requestId !== requestRef.current) return;
      setData(res);
      setError(null);
    } catch (err) {
      if (requestId !== requestRef.current) return;
      setError(getBackendErrorMessage(err, '读取资源闸门配置失败'));
    } finally {
      if (requestId === requestRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshNonce]);

  if (error && !data) return <StudioErrorState message={error} onRetry={() => void load()} />;
  if (loading && !data) return <StudioLoadingState minHeightClassName="min-h-[240px]" text="正在读取资源闸门配置…" />;
  if (!data) return null;

  const renderGroup = (
    key: 'mediaSandbox' | 'docTool',
    title: string,
    note: string,
    defaults?: Record<string, number>,
  ) => {
    const group = data[key];
    const entries = Object.entries(group.effective);
    return (
      <InfoPanel compact key={key}>
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
          <InfoBadge tone="slate">{entries.length} 项</InfoBadge>
        </div>
        <p className="mt-1 text-xs leading-5 text-slate-500">{note}</p>
        <TableWrap minWidth="min-w-[720px]">
          <thead>
            <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-400">
              <Th>项</Th>
              <Th>env</Th>
              <Th>生效值</Th>
              {defaults ? <Th>默认值</Th> : null}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {entries.map(([field, value]) => {
              const formatter = RATE_LIMITS[field] ?? ((raw: number) => String(raw));
              const fallback = defaults?.[field];
              return (
                <tr key={field}>
                  <Td>
                    <div className="flex flex-col gap-0.5">
                      <span className="text-[11px] text-slate-700">{USAGE_HINTS[field] ?? field}</span>
                      <span className="font-mono text-[10px] text-slate-400">{field}</span>
                    </div>
                  </Td>
                  <Td><span className="font-mono text-[11px] text-slate-600">{group.env[field] ?? '-'}</span></Td>
                  <Td><span className="tabular-nums text-slate-800">{formatter(Number(value))}</span></Td>
                  {defaults ? (
                    <Td>
                      <span className="tabular-nums text-slate-500">
                        {typeof fallback === 'number' ? formatter(fallback) : '-'}
                      </span>
                    </Td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </TableWrap>
      </InfoPanel>
    );
  };

  return (
    <div className="space-y-4">
      <InfoPanel compact>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
            <InfoBadge tone={data.processWatchdog.mode === 'enforce' ? 'rose' : 'amber'}>
              看门狗 {data.processWatchdog.mode}
            </InfoBadge>
            <span>读自当前进程 env 解析结果，重启后随配置变化</span>
          </div>
          <RefreshButton onClick={() => void load()} loading={loading} />
        </div>
      </InfoPanel>

      {renderGroup('mediaSandbox', '文件沙箱（媒体工具）', data.mediaSandbox.note, data.mediaSandbox.defaults)}
      {renderGroup('docTool', '文档转换限额', data.docTool.note)}

      <DataPanel>
        <div className="flex items-start gap-2 text-xs leading-5 text-slate-600">
          <FaShieldAlt className="mt-0.5 shrink-0 text-slate-400" aria-hidden />
          <div className="min-w-0">
            <p className="font-semibold text-slate-700">子进程看门狗</p>
            <p className="mt-1">{data.processWatchdog.note}</p>
            <FieldGrid className="mt-2">
              <FieldRow label="模式" value={data.processWatchdog.mode} />
              {Object.entries(data.processWatchdog.env).map(([key, envName]) => (
                <FieldRow key={key} label={key} value={envName} mono />
              ))}
            </FieldGrid>
          </div>
        </div>
      </DataPanel>
    </div>
  );
};

export default RateLimitsResourcesTab;
