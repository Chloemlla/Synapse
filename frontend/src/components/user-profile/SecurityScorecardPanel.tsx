import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FaCheckCircle,
  FaExclamationTriangle,
  FaFingerprint,
  FaKey,
  FaShieldAlt,
  FaSyncAlt,
  FaTimesCircle,
  FaUserShield,
} from 'react-icons/fa';
import {
  fetchAccountSecurityOverview,
  type AccountSecurityCheck,
  type AccountSecurityOverview,
  type SecurityCheckStatus,
} from '../../api/securitySummary';
import { cn } from '../../utils/cn';
import { studioEyebrowClassName, studioFieldClassName, studioPanelClassName } from '../studioTheme';

export type SecurityCheckActionTarget = NonNullable<AccountSecurityCheck['action']>;

export interface SecurityScorecardPanelProps {
  /** 点击清单里的「去处理」时把用户带到对应区块；由 UserProfile 决定锚点。 */
  onAction?: (action: SecurityCheckActionTarget) => void;
  /** 数据刷新后回调，便于父级同步「安全会话 / 双因素状态」等派生展示。 */
  onLoaded?: (overview: AccountSecurityOverview) => void;
}

const RISK_META: Record<AccountSecurityOverview['riskLevel'], { label: string; ring: string; text: string; badge: string }> = {
  good: {
    label: '安全状态良好',
    ring: 'text-emerald-500',
    text: 'text-emerald-700',
    badge: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  },
  watch: {
    label: '建议加固',
    ring: 'text-amber-500',
    text: 'text-amber-700',
    badge: 'border-amber-200 bg-amber-50 text-amber-700',
  },
  risk: {
    label: '存在明显风险',
    ring: 'text-rose-500',
    text: 'text-rose-700',
    badge: 'border-rose-200 bg-rose-50 text-rose-700',
  },
};

const STATUS_META: Record<SecurityCheckStatus, { icon: React.ReactNode; tone: string; chip: string; label: string }> = {
  pass: {
    icon: <FaCheckCircle aria-hidden />,
    tone: 'text-emerald-600',
    chip: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    label: '已满足',
  },
  warn: {
    icon: <FaExclamationTriangle aria-hidden />,
    tone: 'text-amber-600',
    chip: 'border-amber-200 bg-amber-50 text-amber-700',
    label: '建议处理',
  },
  fail: {
    icon: <FaTimesCircle aria-hidden />,
    tone: 'text-rose-600',
    chip: 'border-rose-200 bg-rose-50 text-rose-700',
    label: '需要处理',
  },
};

const ACTION_LABEL: Record<SecurityCheckActionTarget, string> = {
  enable_mfa: '去启用二次验证',
  enable_passkey: '去配置 Passkey',
  regenerate_backup_codes: '去重新生成恢复码',
  verify_email: '去绑定邮箱',
  report_fingerprint: '去上报设备指纹',
  review_devices: '去查看登录设备',
};

const FAILED_LOCATION_FALLBACK = '未记录';

function ScoreRing({ score, riskLevel }: { score: number; riskLevel: AccountSecurityOverview['riskLevel'] }) {
  const meta = RISK_META[riskLevel];
  const clamped = Math.max(0, Math.min(100, score));

  return (
    <div
      className="relative flex h-24 w-24 shrink-0 items-center justify-center"
      role="img"
      aria-label={`账号安全评分 ${clamped} 分，共 100 分，${meta.label}`}
    >
      <svg viewBox="0 0 100 100" className="h-24 w-24 -rotate-90" aria-hidden>
        <circle cx="50" cy="50" r="42" fill="none" stroke="#e2e8f0" strokeWidth="10" />
        <circle
          cx="50"
          cy="50"
          r="42"
          fill="none"
          stroke="currentColor"
          strokeWidth="10"
          strokeLinecap="round"
          className={meta.ring}
          strokeDasharray={`${(clamped / 100) * 264} 264`}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className={cn('text-2xl font-semibold tabular-nums', meta.text)}>{clamped}</span>
        <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400">/ 100</span>
      </div>
    </div>
  );
}

function CheckRow({
  check,
  onAction,
}: {
  check: AccountSecurityCheck;
  onAction?: (action: SecurityCheckActionTarget) => void;
}) {
  const meta = STATUS_META[check.status];
  const action = check.action;

  return (
    <li className="flex min-w-0 flex-col gap-2 rounded-2xl border border-slate-200 bg-white/80 px-3.5 py-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex min-w-0 items-start gap-3">
        <span className={cn('mt-0.5 shrink-0 text-base', meta.tone)}>{meta.icon}</span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-slate-900">{check.label}</span>
            <span className={cn('rounded-full border px-2 py-0.5 text-[10px] font-semibold', meta.chip)}>
              {meta.label}
            </span>
          </div>
          <p className="mt-1 break-words text-[13px] leading-6 text-slate-600">{check.detail}</p>
        </div>
      </div>
      {action && onAction && (
        <button
          type="button"
          onClick={() => onAction(action)}
          className={cn(studioFieldClassName, 'w-full shrink-0 px-3 py-2 text-xs font-semibold text-slate-700 sm:w-auto')}
        >
          {ACTION_LABEL[action]}
        </button>
      )}
    </li>
  );
}

/**
 * 账号安全中心：把分散在个人资料页各处的双因素 / 恢复码 / 设备 / 指纹状态收拢成
 * 一个「现在到底安不安全、下一步做什么」的单页结论。
 *
 * 分数与风险等级完全由后端单点计算（与管理员看到的同一份），组件只做展示，
 * 避免前后端各算一套分数。
 */
const SecurityScorecardPanel: React.FC<SecurityScorecardPanelProps> = ({ onAction, onLoaded }) => {
  const [overview, setOverview] = useState<AccountSecurityOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 父级通常传内联箭头函数，直接进依赖数组会让 effect 每次渲染都重跑（自触发拉取循环）。
  const onLoadedRef = useRef(onLoaded);
  onLoadedRef.current = onLoaded;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchAccountSecurityOverview();
      setOverview(data);
      onLoadedRef.current?.(data);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : '安全总览加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchAccountSecurityOverview()
      .then((data) => {
        if (cancelled) return;
        setOverview(data);
        onLoadedRef.current?.(data);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error && err.message ? err.message : '安全总览加载失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const pendingChecks = useMemo(
    () => (overview?.checks ?? []).filter((check) => check.status !== 'pass'),
    [overview],
  );

  return (
    <section
      className={cn(studioPanelClassName, 'mb-4')}
      aria-labelledby="security-scorecard-title"
      aria-busy={loading}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className={cn(studioEyebrowClassName, 'flex items-center gap-2')}>
            <FaUserShield aria-hidden />
            <span id="security-scorecard-title">账号安全中心</span>
          </div>
          <p className="mt-2 text-[13px] leading-6 text-slate-600 sm:text-sm">
            这里汇总当前账号的双因素、恢复码、登录设备与设备指纹状态，并给出下一步要处理的事项。
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            void load();
          }}
          disabled={loading}
          className={cn(
            studioFieldClassName,
            'inline-flex w-auto shrink-0 items-center justify-center gap-2 px-3 py-2 text-xs font-semibold text-slate-600 disabled:opacity-50',
          )}
          aria-label="刷新账号安全总览"
        >
          <FaSyncAlt className={loading ? 'animate-spin' : undefined} aria-hidden />
          刷新
        </button>
      </div>

      {error && (
        <div
          role="alert"
          className="mt-4 flex flex-col gap-3 rounded-2xl border border-rose-200 bg-rose-50 px-3.5 py-3 text-[13px] text-rose-700 sm:flex-row sm:items-center sm:justify-between sm:text-sm"
        >
          <span>{error}</span>
          <button
            type="button"
            onClick={() => {
              void load();
            }}
            disabled={loading}
            className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl bg-white px-3 py-2 text-xs font-semibold text-rose-700 transition hover:bg-rose-100 disabled:opacity-50"
          >
            <FaSyncAlt aria-hidden />
            重试
          </button>
        </div>
      )}

      {loading && !overview ? (
        <div className="mt-4 flex items-center gap-2 rounded-2xl border border-slate-200 bg-slate-50 px-3.5 py-4 text-sm text-slate-500">
          <FaSyncAlt className="animate-spin" aria-hidden />
          正在检查账号安全配置...
        </div>
      ) : null}

      {overview && (
        <>
          <div className="mt-4 flex flex-col gap-4 rounded-2xl border border-slate-200 bg-slate-50/70 p-4 sm:flex-row sm:items-center">
            <ScoreRing score={overview.score} riskLevel={overview.riskLevel} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className={cn('rounded-full border px-2.5 py-1 text-xs font-semibold', RISK_META[overview.riskLevel].badge)}>
                  {RISK_META[overview.riskLevel].label}
                </span>
                <span className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs font-semibold text-slate-600">
                  二次验证 {overview.mfaFactorCount} / 2 项
                </span>
                <span className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs font-semibold text-slate-600">
                  登录设备 {overview.activeDeviceCount} 台
                </span>
              </div>
              <div className="mt-3 grid gap-2 text-[13px] text-slate-600 sm:grid-cols-2">
                <div className="flex items-center gap-2">
                  <FaKey className="shrink-0 text-slate-400" aria-hidden />
                  <span>
                    TOTP：{overview.totpEnabled ? '已启用' : '未启用'} · Passkey：
                    {overview.passkeyCount > 0 ? `已配置 ${overview.passkeyCount} 个` : '未配置'}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <FaShieldAlt className="shrink-0 text-slate-400" aria-hidden />
                  <span>
                    备用恢复码：{overview.backupCodesKnown ? `${overview.backupCodesRemaining} 个` : '—'}
                    {overview.backupCodesKnown && overview.backupCodesLow ? '（偏低）' : ''}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <FaFingerprint className="shrink-0 text-slate-400" aria-hidden />
                  <span>设备指纹：{overview.fingerprintCount} 条</span>
                </div>
                <div className="flex items-center gap-2">
                  <FaCheckCircle className="shrink-0 text-slate-400" aria-hidden />
                  <span>最近登录 IP：{overview.lastLoginIp || FAILED_LOCATION_FALLBACK}</span>
                </div>
              </div>
              {pendingChecks.length === 0 && (
                <p className="mt-3 text-[13px] font-medium text-emerald-700">
                  所有检查项都已满足，保持现状即可。
                </p>
              )}
            </div>
          </div>

          <ul className="mt-4 space-y-3">
            {overview.checks.map((check) => (
              <CheckRow key={check.id} check={check} onAction={onAction} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
};

export default SecurityScorecardPanel;
