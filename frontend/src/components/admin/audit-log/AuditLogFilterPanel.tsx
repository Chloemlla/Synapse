import React, { useMemo } from 'react';
import { motion } from 'framer-motion';
import { FaTimes } from 'react-icons/fa';
import type { AuditLogMeta, AuditLogQuery } from '@/api/auditLog';
import { cn } from '@/utils/cn';
import { studioTileClassName } from '@/components/studioTheme';
import {
  buildModuleOptionGroups,
  moduleLabel,
  QUICK_TIME_RANGES,
  quickTimeRangeBounds,
  roleLabel,
  type QuickTimeRange,
} from './labels';

const FALLBACK_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const FALLBACK_ROLES = [
  { value: 'superadmin', label: '超级管理员' },
  { value: 'admin', label: '管理员' },
  { value: 'user', label: '普通用户' },
];
const FALLBACK_SORT_OPTIONS = [
  { value: 'desc', label: '最新在前' },
  { value: 'asc', label: '最早在前' },
];

const FIELD_CLASS = cn(studioTileClassName, 'px-3 py-2 text-sm text-slate-900');

export interface AuditLogFilterPanelProps {
  filters: AuditLogQuery;
  meta: AuditLogMeta | null;
  onChange: (key: keyof AuditLogQuery, value: string) => void;
  /** 传入 patch 时按「当前草稿 + patch」立即应用（快捷时间窗就是一条点击完成的筛选）。 */
  onApply: (patch?: Partial<AuditLogQuery>) => void;
  onReset: () => void;
  onKeyDown: (event: React.KeyboardEvent) => void;
}

/**
 * 审计日志的高级筛选面板。
 *
 * 分组模块下拉是这一版的重点：模块清单由后端 `/meta` 下发（含中文名与分组），
 * 涵盖库里的全部类别 —— 之前漏了 `lumen-config` / `modlist`，选了还会静默返回全部日志。
 * 快捷时间窗把「值班复盘最常说的那几句话」变成一次点击，不用手填日期。
 */
export const AuditLogFilterPanel: React.FC<AuditLogFilterPanelProps> = ({
  filters,
  meta,
  onChange,
  onApply,
  onReset,
  onKeyDown,
}) => {
  const moduleGroups = useMemo(() => buildModuleOptionGroups(meta), [meta]);
  const roleOptions = meta?.roles?.length ? meta.roles : FALLBACK_ROLES;
  const methodOptions = useMemo(
    () => [{ value: '', label: '全部方法' }, ...(meta?.methods?.length ? meta.methods : FALLBACK_METHODS).map((method) => ({
      value: method,
      label: method,
    }))],
    [meta],
  );
  const sortOptions = meta?.sortOptions?.length ? meta.sortOptions : FALLBACK_SORT_OPTIONS;

  const applyQuickRange = (range: QuickTimeRange) => {
    // 快捷窗点一下就算「筛好了」：日期手填才需要再点「应用筛选」。
    const bounds = quickTimeRangeBounds(range);
    onApply({ startDate: bounds.startDate, endDate: bounds.endDate });
  };

  const activeModuleHint = filters.module
    ? meta?.moduleCatalog?.find((item) => item.value === filters.module)?.hint
    : undefined;

  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      className="space-y-3 rounded-2xl bg-slate-50/80 p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold text-slate-400">时间窗</span>
        {QUICK_TIME_RANGES.map((range) => (
          <button
            key={range.value}
            type="button"
            onClick={() => applyQuickRange(range.value)}
            className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-600 transition hover:border-slate-300 hover:text-slate-900"
          >
            {range.label}
          </button>
        ))}
        {filters.startDate || filters.endDate ? (
          <button
            type="button"
            onClick={() => onApply({ startDate: '', endDate: '' })}
            className="text-xs font-medium text-slate-400 transition hover:text-slate-600"
          >
            清除时间窗
          </button>
        ) : null}
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className="min-w-0">
          <select
            aria-label="按模块筛选"
            className={cn(FIELD_CLASS, 'w-full')}
            value={filters.module}
            onChange={(event) => onChange('module', event.target.value)}
          >
            <option value="">全部模块</option>
            {moduleGroups.map((group) => (
              <optgroup key={group.value} label={group.label}>
                {group.options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          {activeModuleHint ? (
            <p className="mt-1 truncate text-[11px] text-slate-400" title={activeModuleHint}>
              {activeModuleHint}
            </p>
          ) : null}
        </div>

        <select
          aria-label="按结果筛选"
          className={FIELD_CLASS}
          value={filters.result}
          onChange={(event) => onChange('result', event.target.value)}
        >
          <option value="">全部结果</option>
          <option value="success">成功</option>
          <option value="failure">失败</option>
        </select>

        <select
          aria-label="按操作者角色筛选"
          className={FIELD_CLASS}
          value={filters.role}
          onChange={(event) => onChange('role', event.target.value)}
        >
          <option value="">全部角色</option>
          {roleOptions.map((role) => (
            <option key={role.value} value={role.value}>
              {role.label}
            </option>
          ))}
        </select>

        <select
          aria-label="按请求方法筛选"
          className={FIELD_CLASS}
          value={filters.method}
          onChange={(event) => onChange('method', event.target.value)}
        >
          {methodOptions.map((method) => (
            <option key={method.value || 'all'} value={method.value}>
              {method.label}
            </option>
          ))}
        </select>

        <select
          aria-label="按时间排序"
          className={FIELD_CLASS}
          value={filters.sort || 'desc'}
          onChange={(event) => onChange('sort', event.target.value)}
        >
          {sortOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>

        <input
          value={filters.statusCode}
          onChange={(event) => onChange('statusCode', event.target.value)}
          onKeyDown={onKeyDown}
          inputMode="numeric"
          placeholder="状态码（如 403）"
          aria-label="状态码"
          className={FIELD_CLASS}
        />
        <input
          value={filters.requestId}
          onChange={(event) => onChange('requestId', event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="请求 ID"
          aria-label="请求 ID"
          className={FIELD_CLASS}
        />
        <input
          value={filters.action}
          onChange={(event) => onChange('action', event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="操作（如 user.create）"
          aria-label="操作"
          className={FIELD_CLASS}
        />
        <input
          value={filters.userId}
          onChange={(event) => onChange('userId', event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="用户 ID"
          aria-label="用户 ID"
          className={FIELD_CLASS}
        />
        <input
          value={filters.username}
          onChange={(event) => onChange('username', event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="用户名"
          aria-label="用户名"
          className={FIELD_CLASS}
        />
        <input
          value={filters.ip}
          onChange={(event) => onChange('ip', event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="IP"
          aria-label="IP"
          className={FIELD_CLASS}
        />
        <input
          value={filters.path}
          onChange={(event) => onChange('path', event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="请求路径"
          aria-label="请求路径"
          className={FIELD_CLASS}
        />
        <input
          value={filters.targetId}
          onChange={(event) => onChange('targetId', event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="目标 ID"
          aria-label="目标 ID"
          className={FIELD_CLASS}
        />
        <input
          value={filters.targetName}
          onChange={(event) => onChange('targetName', event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="目标名称"
          aria-label="目标名称"
          className={FIELD_CLASS}
        />
        <input
          value={filters.minDurationMs}
          onChange={(event) => onChange('minDurationMs', event.target.value)}
          onKeyDown={onKeyDown}
          inputMode="numeric"
          placeholder="最小耗时 ms"
          aria-label="最小耗时（毫秒）"
          className={FIELD_CLASS}
        />
        <input
          value={filters.maxDurationMs}
          onChange={(event) => onChange('maxDurationMs', event.target.value)}
          onKeyDown={onKeyDown}
          inputMode="numeric"
          placeholder="最大耗时 ms"
          aria-label="最大耗时（毫秒）"
          className={FIELD_CLASS}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex min-w-0 flex-col gap-1">
          <span className="text-[11px] text-slate-400">开始时间</span>
          <input
            type="date"
            className={FIELD_CLASS}
            value={filters.startDate}
            onChange={(event) => onChange('startDate', event.target.value)}
          />
        </label>
        <label className="flex min-w-0 flex-col gap-1">
          <span className="text-[11px] text-slate-400">结束时间</span>
          <input
            type="date"
            className={FIELD_CLASS}
            value={filters.endDate}
            onChange={(event) => onChange('endDate', event.target.value)}
          />
        </label>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11px] text-slate-400">
          {filters.module ? `模块：${moduleLabel(filters.module, meta)}` : '未选模块时覆盖全部类别'}
          {filters.role ? ` · 角色：${roleLabel(filters.role, meta)}` : ''}
        </p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onReset}
            className="inline-flex items-center gap-1 rounded-2xl px-3 py-2 text-sm text-slate-500 transition hover:bg-white hover:text-slate-700"
          >
            <FaTimes className="h-3 w-3" aria-hidden />
            重置
          </button>
          <button
            type="button"
            onClick={() => onApply()}
            className="rounded-2xl bg-slate-900 px-4 py-2 text-sm text-white transition hover:bg-slate-800"
          >
            应用筛选
          </button>
        </div>
      </div>
    </motion.div>
  );
};

export default AuditLogFilterPanel;
