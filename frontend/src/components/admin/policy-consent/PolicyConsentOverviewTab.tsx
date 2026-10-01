import React, { useState } from 'react';
import {
  FaCheckCircle,
  FaCopy,
  FaExclamationTriangle,
  FaFileSignature,
  FaHourglassHalf,
  FaUndoAlt,
} from 'react-icons/fa';
import type { PolicyConsentOverviewResponse } from '@/api/policyConsents';
import { InfoBadge, InfoMetricCard, InfoPanel } from '@/components/studioTheme';
import { cn } from '@/lib/utils';
import { formatCount } from '../ip-risk-log/format';
import { SectionNote } from '../ip-risk-log/ui';
import { sourceLabel } from './shared';

/** 可复制的条文指纹：合规对账时经常要把它粘到工单/报告里。 */
const CopyableHash: React.FC<{ value: string }> = ({ value }) => {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <span className="inline-flex items-center gap-2">
      <code className="break-all font-mono text-[11px] text-slate-600">{value}</code>
      <button
        type="button"
        onClick={() => void copy()}
        aria-label="复制条文指纹"
        className={cn(
          'inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold transition',
          copied
            ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
            : 'border-slate-200 bg-white/80 text-slate-500 hover:border-slate-300 hover:text-slate-700',
        )}
      >
        {copied ? <FaCheckCircle className="text-[9px]" /> : <FaCopy className="text-[9px]" />}
        {copied ? '已复制' : '复制'}
      </button>
    </span>
  );
};

/** 政策同意面板的概览 tab（计数 / 版本与来源分布 / 趋势 / 集合索引）。 */
const PolicyConsentOverviewTab: React.FC<{
  overview: PolicyConsentOverviewResponse | null;
  loading: boolean;
  error: string | null;
  /** 点「勾选不完整」卡片时跳到记录 tab 并带上该筛选 */
  onFocusIncomplete: () => void;
}> = ({ overview, loading, error, onFocusIncomplete }) => {
  const counts = overview?.counts;
  const maxVersion = Math.max(1, ...(overview?.versions.map((row) => row.count) ?? [1]));
  const maxSource = Math.max(1, ...(overview?.sources.map((row) => row.count) ?? [1]));
  const maxTrend = Math.max(1, ...(overview?.recentTrend.map((row) => row.count) ?? [1]));
  const trendDays = overview?.trendDays ?? 7;

  return (
    <div className="space-y-5">
      <SectionNote>
        {loading && !overview
          ? '正在读取同意记录统计……'
          : '每一条记录 = 一个设备指纹对某个版本政策的一次同意。同一指纹 + 版本已有有效记录时原地续期（不新增行）。'}
        {overview ? (
          <>
            {' '}当前版本 <code>{overview.currentVersion}</code>，同意有效期 {overview.validityDays} 天；
            版本号变化会让旧同意不再覆盖新条文，依赖同意的功能会要求重新同意。
          </>
        ) : null}
      </SectionNote>

      {error ? (
        <InfoPanel compact>
          <div className="px-4 py-3 text-sm text-rose-600">{error}</div>
        </InfoPanel>
      ) : null}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <InfoMetricCard
          label="记录总量（含已过期）"
          value={counts ? formatCount(counts.total) : '—'}
          detail={overview ? `集合 ${overview.collection.name}` : '等待概览'}
          icon={FaFileSignature}
          tone="sky"
        />
        <InfoMetricCard
          label="当前有效"
          value={counts ? formatCount(counts.valid) : '—'}
          detail="isValid 且未过期，且勾满四份文件"
          icon={FaCheckCircle}
          tone="teal"
        />
        <InfoMetricCard
          label="已过期 / 失效"
          value={counts ? formatCount(counts.expired) : '—'}
          detail="过期或被撤销顶替；TTL 索引会陆续清理"
          icon={FaHourglassHalf}
          tone="slate"
        />
        <InfoMetricCard
          label="用户主动撤回"
          value={counts ? formatCount(counts.revoked) : '—'}
          detail="带撤回留痕（时间 / IP）的记录"
          icon={FaUndoAlt}
          tone="amber"
        />
        <button
          type="button"
          onClick={onFocusIncomplete}
          title="这些记录名义上仍有效，但勾选没覆盖四份文件，功能门禁不会认它们；点击查看并导出"
          className="text-left transition hover:-translate-y-0.5"
        >
          <InfoMetricCard
            label="有效但勾选不完整"
            value={counts ? formatCount(counts.incomplete) : '—'}
            detail="门禁不认这些记录 → 点击查看明细"
            icon={FaExclamationTriangle}
            tone="rose"
          />
        </button>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <InfoPanel compact>
          <div className="mb-3 flex items-center gap-2 px-1">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">按版本分布</span>
          </div>
          {overview && overview.versions.length > 0 ? (
            <div className="space-y-2">
              {overview.versions.map((row) => (
                <div key={row.key} className="flex items-center gap-3">
                  <span className="w-16 shrink-0 font-mono text-xs text-slate-600">{row.key}</span>
                  <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-slate-100">
                    <div
                      className="h-full rounded-full bg-sky-400"
                      style={{ width: `${Math.round((row.count / maxVersion) * 100)}%` }}
                    />
                  </div>
                  <span className="w-16 shrink-0 text-right text-xs font-semibold text-slate-700">
                    {formatCount(row.count)}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="px-1 text-xs text-slate-400">暂无数据</p>
          )}
        </InfoPanel>

        <InfoPanel compact>
          <div className="mb-3 flex items-center gap-2 px-1">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">按来源分布</span>
            <span className="text-xs text-slate-400">登录 / 注册 / 功能门禁</span>
          </div>
          {overview && overview.sources.length > 0 ? (
            <div className="space-y-2">
              {overview.sources.map((row) => (
                <div key={row.key} className="flex items-center gap-3">
                  <span className="w-20 shrink-0 text-xs text-slate-600">{sourceLabel(row.key)}</span>
                  <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-slate-100">
                    <div
                      className="h-full rounded-full bg-violet-400"
                      style={{ width: `${Math.round((row.count / maxSource) * 100)}%` }}
                    />
                  </div>
                  <span className="w-16 shrink-0 text-right text-xs font-semibold text-slate-700">
                    {formatCount(row.count)}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="px-1 text-xs text-slate-400">暂无数据</p>
          )}
        </InfoPanel>
      </div>

      <InfoPanel compact>
        <div className="mb-3 flex items-center gap-2 px-1">
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            近 {trendDays} 天同意趋势
          </span>
          <span className="text-xs text-slate-400">按 recordedAt 分日计数（窗口可在右上角切换）</span>
        </div>
        {overview && overview.recentTrend.length > 0 ? (
          <div className="flex items-end gap-1.5 overflow-x-auto px-1 pb-1">
            {overview.recentTrend.map((row) => (
              <div key={row.date} className="flex min-w-[2rem] flex-1 flex-col items-center gap-1">
                <span className="text-[10px] font-semibold text-slate-600">{formatCount(row.count)}</span>
                <div
                  className="w-full rounded-t-lg bg-emerald-400"
                  style={{ height: `${Math.max(4, Math.round((row.count / maxTrend) * 96))}px` }}
                  title={`${row.date}：${row.count} 条`}
                />
                <span className="text-[10px] text-slate-400">{row.date.slice(5)}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="px-1 text-xs text-slate-400">该窗口内暂无新增同意记录</p>
        )}
      </InfoPanel>

      {overview ? (
        <InfoPanel compact>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-1">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">集合索引</span>
            <span className="text-xs text-slate-400">{overview.collection.name}</span>
            {overview.collection.exists ? (
              <InfoBadge tone="emerald" className="text-[10px]">存在</InfoBadge>
            ) : (
              <InfoBadge tone="amber" className="text-[10px]">集合尚未创建</InfoBadge>
            )}
            <span className="text-xs text-slate-400">需勾选：{overview.agreementKeys.join(', ')}</span>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 px-1">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">当前条文指纹</span>
            {overview.documentHash ? (
              <CopyableHash value={overview.documentHash} />
            ) : (
              <span className="text-xs text-slate-400">未提供</span>
            )}
            <span className="text-[11px] text-slate-400">
              每条记录的「条文指纹」列是它的前 12 位；不一致说明那条同意对应的是另一份文本。
            </span>
          </div>
          {overview.collection.indexes.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1.5 px-1">
              {overview.collection.indexes.map((index) => (
                <span
                  key={index}
                  className="rounded-full border border-slate-200 bg-white/80 px-2.5 py-0.5 font-mono text-[11px] text-slate-600"
                >
                  {index}
                </span>
              ))}
            </div>
          ) : (
            <p className="mt-2 px-1 text-xs text-slate-400">无可读取的索引信息</p>
          )}
        </InfoPanel>
      ) : null}
    </div>
  );
};

export default PolicyConsentOverviewTab;
