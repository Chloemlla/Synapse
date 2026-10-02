import React, { useMemo } from 'react';
import {
  FaExclamationTriangle,
  FaFingerprint,
  FaKey,
  FaShieldAlt,
  FaUserShield,
  FaUsersSlash,
} from 'react-icons/fa';
import { cn } from '../../utils/cn';
import type { UserListStats } from './UserFormControls';
import { studioFieldClassName, studioPanelClassName } from '../studioTheme';

/** 列表行里本面板用到的最小字段集合（其它字段由页面自己渲染）。 */
export interface AdminSecurityUserRow {
  id: string;
  username: string;
  securitySummary?: {
    score: number;
    riskLevel: 'good' | 'watch' | 'risk';
    mfaEnabled: boolean;
    recommendations?: Array<{ id: string; label: string; severity: 'info' | 'warning' | 'critical' }>;
  };
}

export interface AdminSecurityPosturePanelProps {
  stats: UserListStats;
  /** 当前页用户（用于列出本页风险最高的几个账号）。 */
  users: AdminSecurityUserRow[];
  /** 快速筛选：立即套用管理端用户列表的筛选条件。 */
  onQuickFilter: (patch: {
    security?: 'all' | 'totp' | 'passkey' | 'fingerprintRequired' | 'noMfa';
    accountStatus?: 'all' | 'active' | 'suspended';
  }) => void;
  /** 打开某个用户的详情表单。 */
  onOpenUser?: (userId: string) => void;
}

const RISK_BADGE: Record<'good' | 'watch' | 'risk', string> = {
  good: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  watch: 'border-amber-200 bg-amber-50 text-amber-700',
  risk: 'border-rose-200 bg-rose-50 text-rose-700',
};

const RISK_LABEL: Record<'good' | 'watch' | 'risk', string> = {
  good: '良好',
  watch: '待加固',
  risk: '高风险',
};

const percent = (part: number, total: number): number => (total > 0 ? Math.round((part / total) * 100) : 0);

interface MeterProps {
  label: string;
  value: number;
  total: number;
  tone: 'emerald' | 'sky' | 'amber';
  icon: React.ReactNode;
  onFilter?: () => void;
  filterLabel?: string;
}

const METER_TONE: Record<MeterProps['tone'], string> = {
  emerald: 'bg-emerald-500',
  sky: 'bg-sky-500',
  amber: 'bg-amber-500',
};

function CoverageMeter({ label, value, total, tone, icon, onFilter, filterLabel }: MeterProps) {
  const ratio = percent(value, total);
  return (
    <div className="min-w-0 rounded-2xl border border-slate-200 bg-white/80 px-3.5 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2 text-[13px] font-semibold text-slate-700">
          <span className="shrink-0 text-slate-400">{icon}</span>
          <span className="truncate">{label}</span>
        </div>
        <span className="shrink-0 text-[13px] font-semibold tabular-nums text-slate-900">
          {value}
          <span className="text-slate-400"> / {total}</span>
        </span>
      </div>
      <div
        className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-100"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={ratio}
        aria-label={`${label}覆盖率 ${ratio}%`}
      >
        <div className={cn('h-full rounded-full transition-all', METER_TONE[tone])} style={{ width: `${ratio}%` }} />
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-[11px] text-slate-500">覆盖率 {ratio}%</span>
        {onFilter && (
          <button type="button" onClick={onFilter} className="text-[11px] font-semibold text-slate-600 underline-offset-2 hover:underline">
            {filterLabel || '查看相关账号'}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * 管理员安全态势：把用户列表里已经算好的安全统计（TOTP / Passkey / 需指纹 / 封停）
 * 与每行用户的 `securitySummary` 汇总成一眼能看懂的结论，并提供一键筛选入口。
 *
 * 为什么放在用户列表页而不是新开一页：这套数据的来源就是用户列表接口，
 * 换页只会多一次全表聚合；放在这里可以「看到结论 → 立刻筛出对应账号 → 处理」一步完成。
 */
const AdminSecurityPosturePanel: React.FC<AdminSecurityPosturePanelProps> = ({
  stats,
  users,
  onQuickFilter,
  onOpenUser,
}) => {
  const mfaCovered = Math.max(stats.totpEnabled, stats.passkeyEnabled);

  const riskyUsers = useMemo(() => {
    return users
      .map((user) => ({ user, summary: user.securitySummary }))
      .filter((item): item is { user: AdminSecurityUserRow; summary: NonNullable<AdminSecurityUserRow['securitySummary']> } =>
        Boolean(item.summary) && item.summary!.riskLevel !== 'good',
      )
      .sort((a, b) => a.summary.score - b.summary.score)
      .slice(0, 5);
  }, [users]);

  const hasAnyStatistic = stats.total > 0;

  return (
    <section className={cn(studioPanelClassName, 'mb-6')} aria-labelledby="admin-security-posture-title">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
            <FaUserShield aria-hidden />
            <span id="admin-security-posture-title">安全态势</span>
          </div>
          <p className="mt-2 max-w-3xl text-[13px] leading-6 text-slate-600 sm:text-sm">
            二次验证覆盖率与需要跟进的账号。数字来自当前用户列表的整体统计，点击右侧入口可直接筛出对应账号。
          </p>
        </div>
        <button
          type="button"
          onClick={() => onQuickFilter({ security: 'noMfa' })}
          disabled={!hasAnyStatistic}
          className={cn(
            studioFieldClassName,
            'inline-flex w-auto shrink-0 items-center justify-center gap-2 px-3 py-2 text-xs font-semibold text-slate-700 disabled:opacity-50',
          )}
        >
          <FaUsersSlash aria-hidden />
          查看未启用 MFA
        </button>
      </div>

      {!hasAnyStatistic ? (
        <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 px-3.5 py-4 text-sm text-slate-500">
          暂无用户数据，统计会在用户加载完成后显示。
        </div>
      ) : (
        <>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <CoverageMeter
              label="TOTP"
              value={stats.totpEnabled}
              total={stats.total}
              tone="emerald"
              icon={<FaKey aria-hidden />}
              onFilter={() => onQuickFilter({ security: 'totp' })}
              filterLabel="查看已启用 TOTP"
            />
            <CoverageMeter
              label="Passkey"
              value={stats.passkeyEnabled}
              total={stats.total}
              tone="sky"
              icon={<FaShieldAlt aria-hidden />}
              onFilter={() => onQuickFilter({ security: 'passkey' })}
              filterLabel="查看已配置 Passkey"
            />
            <CoverageMeter
              label="需指纹上报"
              value={stats.fingerprintRequired}
              total={stats.total}
              tone="amber"
              icon={<FaFingerprint aria-hidden />}
              onFilter={() => onQuickFilter({ security: 'fingerprintRequired' })}
              filterLabel="查看待上报账号"
            />
            <CoverageMeter
              label="封停账号"
              value={stats.suspended}
              total={stats.total}
              tone="amber"
              icon={<FaUsersSlash aria-hidden />}
              onFilter={() => onQuickFilter({ accountStatus: 'suspended' })}
              filterLabel="只看封停账号"
            />
          </div>

          <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50/70 px-3.5 py-3 text-[13px] leading-6 text-slate-600">
            TOTP 与 Passkey 可能落在同一账号上，所以聚合统计只能分别给出各自的覆盖数（TOTP{' '}
            <span className="font-semibold text-slate-900">{stats.totpEnabled}</span> / Passkey{' '}
            <span className="font-semibold text-slate-900">{stats.passkeyEnabled}</span>，至少一项覆盖{' '}
            <span className="font-semibold text-slate-900">{mfaCovered}</span>）。要精确拿到「一个都没启用」的清单，
            请点右上方的「查看未启用 MFA」——那走的是数据库筛选，不是这里的三元估计。
          </div>

          <div className="mt-4">
            <div className="flex items-center gap-2 text-[13px] font-semibold text-slate-700">
              <FaExclamationTriangle className="text-amber-500" aria-hidden />
              本页需要跟进的账号
              <span className="font-normal text-slate-400">（按安全评分从低到高，最多 5 个）</span>
            </div>
            {riskyUsers.length === 0 ? (
              <p className="mt-2 rounded-2xl border border-emerald-200 bg-emerald-50/70 px-3.5 py-3 text-[13px] text-emerald-700">
                本页账号的安全评分都在「良好」区间。
              </p>
            ) : (
              <ul className="mt-2 space-y-2">
                {riskyUsers.map(({ user, summary }) => (
                  <li
                    key={user.id}
                    className="flex min-w-0 flex-col gap-2 rounded-2xl border border-slate-200 bg-white/80 px-3.5 py-3 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold text-slate-900">{user.username}</span>
                        <span className={cn('rounded-full border px-2 py-0.5 text-[10px] font-semibold', RISK_BADGE[summary.riskLevel])}>
                          {summary.score} 分 · {RISK_LABEL[summary.riskLevel]}
                        </span>
                      </div>
                      <p className="mt-1 break-words text-[12px] leading-5 text-slate-500">
                        {summary.recommendations && summary.recommendations.length > 0
                          ? summary.recommendations.map((item) => item.label).join('、')
                          : '暂无针对性建议'}
                      </p>
                    </div>
                    {onOpenUser && (
                      <button
                        type="button"
                        onClick={() => onOpenUser(user.id)}
                        className={cn(studioFieldClassName, 'w-full shrink-0 px-3 py-2 text-xs font-semibold text-slate-700 sm:w-auto')}
                      >
                        查看并处理
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </section>
  );
};

export default AdminSecurityPosturePanel;
