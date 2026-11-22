import React from 'react';
import type { AuditLogMeta, AuditLogQuery, AuditLogStats } from '@/api/auditLog';
import { cn } from '@/utils/cn';
import { studioTileClassName } from '@/components/studioTheme';
import { moduleLabel, roleLabel } from './labels';

export interface AuditLogStatsPanelsProps {
  stats: AuditLogStats | null;
  meta: AuditLogMeta | null;
  /** 点分布条直接把它加成筛选条件（值班时最常见的一条路径）。 */
  onSelect: (key: keyof AuditLogQuery, value: string) => void;
}

const formatDuration = (value: number | string) => {
  const ms = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(ms)) return '-';
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${Math.round(ms)}ms`;
};

const StatCard: React.FC<{ label: string; value: number | string; hint?: string; color?: string }> = ({
  label,
  value,
  hint,
  color = 'text-slate-800',
}) => (
  <div className={cn(studioTileClassName, 'p-3 text-center')} title={hint}>
    <div className={`text-xl font-bold ${color}`}>{typeof value === 'number' ? value.toLocaleString() : value}</div>
    <div className="mt-0.5 text-xs text-slate-500">{label}</div>
  </div>
);

/**
 * 分布面板。条目可点击 → 直接变成筛选条件。
 * 只显示前 `limit` 条，余量用「另有 N 项」说明，避免面板无限长。
 */
const DistributionPanel: React.FC<{
  title: string;
  items: Array<{ key?: keyof AuditLogQuery; value: string; label: string; count: number }>;
  limit?: number;
  emptyText?: string;
  onSelect: (key: keyof AuditLogQuery, value: string) => void;
}> = ({ title, items, limit = 8, emptyText = '暂无统计', onSelect }) => {
  const shown = items.slice(0, limit);
  const maxCount = shown.reduce((max, item) => Math.max(max, item.count), 0);

  return (
    <div className={cn(studioTileClassName, 'p-3')}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="min-w-0 truncate text-sm font-medium text-slate-800">{title}</div>
        <div className="shrink-0 text-[11px] text-slate-400">共 {items.length} 类</div>
      </div>
      {shown.length === 0 ? (
        <div className="py-4 text-center text-xs text-slate-400">{emptyText}</div>
      ) : (
        <div className="space-y-2">
          {shown.map((item) => {
            const clickable = Boolean(item.key);
            const content = (
              <>
                <div className="min-w-0">
                  <div className="truncate text-slate-600">{item.label || '未知'}</div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-100">
                    <div
                      className="h-full rounded-full bg-slate-500"
                      style={{ width: maxCount > 0 ? `${Math.max(6, (item.count / maxCount) * 100)}%` : '0%' }}
                    />
                  </div>
                </div>
                <div className="font-medium text-slate-700">{item.count.toLocaleString()}</div>
              </>
            );

            if (!clickable || !item.key) {
              return (
                <div key={`${item.value}-${item.label}`} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 text-xs">
                  {content}
                </div>
              );
            }

            return (
              <button
                key={`${item.value}-${item.label}`}
                type="button"
                onClick={() => onSelect(item.key as keyof AuditLogQuery, item.value)}
                title={`按「${item.label}」筛选`}
                className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-2xl px-1 py-0.5 text-left text-xs transition hover:bg-slate-50"
              >
                {content}
              </button>
            );
          })}
          {items.length > shown.length ? (
            <div className="pt-1 text-[11px] text-slate-400">另有 {items.length - shown.length} 项未显示</div>
          ) : null}
        </div>
      )}
    </div>
  );
};

/**
 * 审计统计区：指标卡 + 六个分布面板。
 *
 * 之前 `byMethod` / `byStatusCode` 统计了却没展示，`byRole` / `topIps` 干脆没统计。
 * 现在分布条可以点，点完就是一次筛选 —— 值班复盘不必再手动抄 IP。
 */
export const AuditLogStatsPanels: React.FC<AuditLogStatsPanelsProps> = ({ stats, meta, onSelect }) => {
  if (!stats) return null;

  const successCount = stats.byResult.find((item) => item.result === 'success')?.count || 0;
  const failureCount = stats.byResult.find((item) => item.result === 'failure')?.count || 0;
  const failureRate = stats.total ? `${((failureCount / stats.total) * 100).toFixed(1)}%` : '0%';

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <StatCard label="匹配记录" value={stats.total} />
        <StatCard label="近 24 小时" value={stats.last24h} />
        <StatCard label="成功" value={successCount} color="text-emerald-600" />
        <StatCard label="失败" value={failureCount} color="text-rose-500" />
        <StatCard
          label="失败率"
          value={failureRate}
          color={failureCount > 0 ? 'text-amber-600' : 'text-slate-800'}
        />
        <StatCard
          label="平均耗时"
          value={formatDuration(stats.averageDurationMs)}
          hint={`最大 ${formatDuration(stats.maxDurationMs)}`}
        />
      </div>

      <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-3">
        <DistributionPanel
          title="模块分布"
          items={stats.byModule.map((item) => ({
            key: 'module' as const,
            value: item.module,
            label: moduleLabel(item.module, meta),
            count: item.count,
          }))}
          onSelect={onSelect}
        />
        <DistributionPanel
          title="高频操作"
          items={stats.topActions.map((item) => ({
            key: 'action' as const,
            value: item.action,
            label: item.action,
            count: item.count,
          }))}
          onSelect={onSelect}
          emptyText="暂无操作统计"
        />
        <DistributionPanel
          title="角色分布"
          items={(stats.byRole || []).map((item) => ({
            key: 'role' as const,
            value: item.role,
            label: roleLabel(item.role, meta),
            count: item.count,
          }))}
          onSelect={onSelect}
          emptyText="暂无角色统计"
        />
        <DistributionPanel
          title="来源 IP Top"
          items={(stats.topIps || []).map((item) => ({
            key: 'ip' as const,
            value: item.ip,
            label: item.ip,
            count: item.count,
          }))}
          onSelect={onSelect}
          emptyText="暂无 IP 统计"
        />
        <DistributionPanel
          title="请求方法"
          items={stats.byMethod.map((item) => ({
            key: 'method' as const,
            value: item.method,
            label: item.method,
            count: item.count,
          }))}
          onSelect={onSelect}
          emptyText="暂无方法统计"
        />
        <DistributionPanel
          title="响应状态码"
          items={stats.byStatusCode.map((item) => ({
            key: 'statusCode' as const,
            value: String(item.statusCode),
            label: `${item.statusCode} ${statusLabel(item.statusCode)}`,
            count: item.count,
          }))}
          onSelect={onSelect}
          emptyText="暂无状态码统计"
        />
      </div>
    </div>
  );
};

function statusLabel(code: number): string {
  if (code >= 500) return '服务端错误';
  if (code === 403) return '无权限';
  if (code === 401) return '未登录';
  if (code === 404) return '未找到';
  if (code === 429) return '限流';
  if (code >= 400) return '请求错误';
  if (code >= 300) return '重定向';
  return '成功';
}

export default AuditLogStatsPanels;
