import React, { useCallback, useEffect, useState } from 'react';
import { FaExclamationTriangle, FaShieldAlt, FaSync } from 'react-icons/fa';
import { api } from '@/api';
import { InfoBadge, InfoPanel, studioSecondaryButtonClassName } from '@/components/studioTheme';
import { StudioErrorState, StudioLoadingState } from '@/components/studioFeedback';
import { cn } from '@/lib/utils';
import { getBackendErrorMessage } from '@/utils/backendError';
import { formatCount } from '../ip-risk-log/format';
import { formatBytes } from '../rate-limits/format';
import { DataPanel, FieldGrid, FieldRow, TableWrap, Td, Th } from '../account-risk/ui';

/**
 * 媒体工具的资源闸门（RC-39）：文件沙箱四道硬顶 + 子进程看门狗。
 *
 * 为什么放在媒体工具页而不是限流页：这两条限制只影响媒体工具的转写/下载任务，
 * 出问题时排查的一定是媒体工具的使用者。限流页里只留「汇总生效值」，细节在这里。
 *
 * 只读：值来自服务端 env 解析结果，改它们要改部署配置。
 */
interface MediaToolLimitsResponse {
  success: boolean;
  mediaSandbox: {
    effective: Record<string, number>;
    defaults: Record<string, number>;
    env: Record<string, string>;
    note: string;
  };
  processWatchdog: {
    mode: string;
    env: Record<string, string>;
    note: string;
  };
}

const FIELD_LABELS: Record<string, string> = {
  maxFileBytes: '单文件字节上限',
  maxFilesPerJob: '单任务文件数',
  maxUserDirBytes: '单用户目录总字节',
  maxUserDirFiles: '单用户目录文件数',
};

const FIELD_HINTS: Record<string, string> = {
  maxFileBytes: '超过直接拒绝（不是截断）；写盘前按最坏增量判断',
  maxFilesPerJob: '一个转写任务允许上传的文件数',
  maxUserDirBytes: '含 inbox 与产物，超出后上传被拒',
  maxUserDirFiles: '防病态写入；与字节上限同时生效',
};

const formatLimit = (field: string, value: number): string =>
  field.toLowerCase().includes('bytes') ? formatBytes(value) : `${formatCount(value)} 个`;

const MediaToolLimitsPanel: React.FC = () => {
  const [data, setData] = useState<MediaToolLimitsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/api/admin/media-tool/limits');
      setData(res.data as MediaToolLimitsResponse);
      setError(null);
    } catch (err) {
      setError(getBackendErrorMessage(err, '读取资源闸门配置失败'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error && !data) return <StudioErrorState message={error} onRetry={() => void load()} />;
  if (loading && !data) return <StudioLoadingState minHeightClassName="min-h-[200px]" text="正在读取资源闸门配置…" />;
  if (!data) return null;

  return (
    <div className="space-y-4">
      <InfoPanel compact>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
            <InfoBadge tone={data.processWatchdog.mode === 'enforce' ? 'rose' : 'amber'}>
              看门狗 {data.processWatchdog.mode}
            </InfoBadge>
            <span>生效值来自当前进程 env 解析，重启后随配置变化</span>
          </div>
          <button type="button" onClick={() => void load()} disabled={loading} className={cn(studioSecondaryButtonClassName, 'min-h-11 sm:min-h-0')}>
            <FaSync className={cn('mr-1 inline', loading && 'animate-spin')} />刷新
          </button>
        </div>
      </InfoPanel>

      <InfoPanel compact>
        <h3 className="text-sm font-semibold text-slate-900">文件沙箱（四道硬顶）</h3>
        <p className="mt-1 text-xs leading-5 text-slate-500">{data.mediaSandbox.note}</p>
        <TableWrap minWidth="min-w-[760px]">
          <thead>
            <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-400">
              <Th>项</Th>
              <Th>env</Th>
              <Th>生效值</Th>
              <Th>默认值</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {Object.entries(data.mediaSandbox.effective).map(([field, value]) => (
              <tr key={field}>
                <Td>
                  <div className="flex flex-col gap-0.5">
                    <span className="text-[11px] text-slate-700">{FIELD_LABELS[field] ?? field}</span>
                    <span className="text-[10px] text-slate-400">{FIELD_HINTS[field] ?? ''}</span>
                  </div>
                </Td>
                <Td><span className="font-mono text-[11px] text-slate-500">{data.mediaSandbox.env[field] ?? '-'}</span></Td>
                <Td><span className="tabular-nums font-semibold text-slate-800">{formatLimit(field, Number(value))}</span></Td>
                <Td>
                  <span className="tabular-nums text-slate-500">
                    {typeof data.mediaSandbox.defaults[field] === 'number'
                      ? formatLimit(field, data.mediaSandbox.defaults[field])
                      : '-'}
                  </span>
                </Td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      </InfoPanel>

      <DataPanel>
        <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
          <FaShieldAlt className="text-slate-400" aria-hidden />子进程看门狗
        </h3>
        <p className="mt-1 text-xs leading-5 text-slate-500">{data.processWatchdog.note}</p>
        <FieldGrid className="mt-2">
          <FieldRow label="模式" value={data.processWatchdog.mode} />
          {Object.entries(data.processWatchdog.env).map(([key, envName]) => (
            <FieldRow key={key} label={key} value={envName} mono />
          ))}
        </FieldGrid>
        <p className="mt-2 flex items-start gap-1.5 text-[11px] text-amber-700">
          <FaExclamationTriangle className="mt-0.5 shrink-0" aria-hidden />
          observe 只告警不杀进程；enforce 会在超限时向该子进程树发 SIGKILL（绝不杀整个进程组）。
        </p>
      </DataPanel>
    </div>
  );
};

export default MediaToolLimitsPanel;
