import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  FaBan,
  FaChartLine,
  FaExclamationTriangle,
  FaKey,
  FaShieldAlt,
  FaSync,
  FaUserShield,
  FaUsers,
} from 'react-icons/fa';

import { api } from '@/api';
import { cn } from '@/utils/cn';
import {
  InfoBadge,
  InfoMetricCard,
  InfoPanel,
  InfoSectionTitle,
  studioSecondaryButtonClassName,
} from './studioTheme';

/**
 * 管理总览的系统级汇总卡片。
 *
 * 消费 `GET /api/admin/overview`。该接口默认只对超管开放（页面授权里的 `overview`），
 * 因此这里对 403 的处理是**整块隐藏**而不是显示 0：普通管理员看到一排 0 会以为
 * 「系统里没有失败请求 / 没有被封 IP」，那是仪表盘最坏的失效方式。
 */

interface OverviewUserStats {
  total: number;
  users: number;
  admins: number;
  superadmins: number;
  trusted: number;
  active: number;
  suspended: number;
  totpEnabled: number;
  passkeyEnabled: number;
  fingerprintRequired: number;
  withFingerprints: number;
  ticketBanned: number;
  totalDailyUsage: number;
}

interface AdminOverviewSnapshot {
  generatedAt: string;
  users: OverviewUserStats | null;
  apiKeys: { total: number; enabled: number; disabled: number } | null;
  auditLogs: { total: number; last24h: number; failures24h: number } | null;
  ipBans: { total: number; active: number; expired: number } | null;
  warnings: string[];
}

type LoadState = 'idle' | 'loading' | 'ready' | 'forbidden' | 'error';

const readErrorStatus = (error: unknown): number | null => {
  if (!error || typeof error !== 'object') return null;
  const response = (error as { response?: { status?: unknown } }).response;
  return typeof response?.status === 'number' ? response.status : null;
};

const AdminOverviewPanel: React.FC = () => {
  const [state, setState] = useState<LoadState>('idle');
  const [snapshot, setSnapshot] = useState<AdminOverviewSnapshot | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await api.get('/api/admin/overview');
      const overview = res.data?.overview as AdminOverviewSnapshot | undefined;
      if (!overview) {
        setState('error');
        return;
      }
      setSnapshot(overview);
      setState('ready');
    } catch (error) {
      // 403 = 当前账号没有 overview 页面授权：这是常规状态，不该在控制台报错、也不该渲染 0。
      setState(readErrorStatus(error) === 403 ? 'forbidden' : 'error');
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (state === 'forbidden') return null;

  if (state === 'idle' || (state === 'loading' && !snapshot)) {
    return (
      <InfoPanel>
        <InfoSectionTitle eyebrow="Overview" title="系统概览" icon={FaChartLine} />
        <div className="flex items-center justify-center py-8">
          <div className="size-6 animate-spin rounded-full border-4 border-slate-200 border-t-slate-900" />
        </div>
      </InfoPanel>
    );
  }

  if (state === 'error' && !snapshot) {
    return (
      <InfoPanel>
        <InfoSectionTitle
          eyebrow="Overview"
          title="系统概览"
          icon={FaChartLine}
          action={
            <button type="button" onClick={() => void load()} className={studioSecondaryButtonClassName}>
              <FaSync className="size-3.5" />
              重试
            </button>
          }
        />
        <p className="text-sm text-slate-500">系统概览暂时取不到数据，可稍后重试；其它面板不受影响。</p>
      </InfoPanel>
    );
  }

  const users = snapshot?.users;
  const apiKeys = snapshot?.apiKeys;
  const auditLogs = snapshot?.auditLogs;
  const ipBans = snapshot?.ipBans;
  const failures = auditLogs?.failures24h ?? 0;

  return (
    <InfoPanel>
      <InfoSectionTitle
        eyebrow="Overview"
        title="系统概览"
        description="跨模块的只读汇总，用于一眼确认「有没有异常」。数据缺失时显示为「—」而不是 0。"
        icon={FaChartLine}
        action={
          <div className="flex items-center gap-2">
            {snapshot ? (
              <span className="hidden text-xs text-slate-400 sm:inline">
                更新于 {new Date(snapshot.generatedAt).toLocaleTimeString('zh-CN', { hour12: false })}
              </span>
            ) : null}
            <button
              type="button"
              onClick={() => void load()}
              disabled={refreshing}
              className={cn(studioSecondaryButtonClassName, refreshing && 'opacity-60')}
            >
              <FaSync className={cn('size-3.5', refreshing && 'animate-spin')} />
              刷新
            </button>
          </div>
        }
      />

      {snapshot && snapshot.warnings.length > 0 ? (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-2xl border border-amber-200 bg-amber-50 px-3 py-2">
          <FaExclamationTriangle className="size-3.5 text-amber-600" aria-hidden="true" />
          {snapshot.warnings.map((warning) => (
            <InfoBadge key={warning} tone="amber">
              {warning}
            </InfoBadge>
          ))}
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
        <InfoMetricCard
          label="用户"
          value={users ? users.total : '—'}
          detail={users ? `停用 ${users.suspended} · 管理员 ${users.admins + users.superadmins}` : '暂无数据'}
          icon={FaUsers}
        />
        <InfoMetricCard
          label="双重验证覆盖率"
          value={users ? `${Math.round(((users.totpEnabled + users.passkeyEnabled) / Math.max(1, users.total)) * 100)}%` : '—'}
          detail={users ? `TOTP ${users.totpEnabled} · Passkey ${users.passkeyEnabled}` : '暂无数据'}
          icon={FaShieldAlt}
          tone={users && users.totpEnabled + users.passkeyEnabled === 0 ? 'amber' : 'slate'}
        />
        <InfoMetricCard
          label="API Key"
          value={apiKeys ? apiKeys.total : '—'}
          detail={apiKeys ? `启用 ${apiKeys.enabled} · 停用 ${apiKeys.disabled}` : '暂无数据'}
          icon={FaKey}
        />
        <InfoMetricCard
          label="近 24h 审计失败"
          value={auditLogs ? auditLogs.failures24h : '—'}
          detail={auditLogs ? `近 24h 共 ${auditLogs.last24h} 条 · 累计 ${auditLogs.total}` : '暂无数据'}
          icon={FaExclamationTriangle}
          tone={failures > 0 ? 'rose' : 'emerald'}
        />
        <InfoMetricCard
          label="生效中的 IP 封禁"
          value={ipBans ? ipBans.active : '—'}
          detail={ipBans ? `累计 ${ipBans.total} · 已过期 ${ipBans.expired}` : '暂无数据'}
          icon={FaBan}
          tone={ipBans && ipBans.active > 0 ? 'amber' : 'slate'}
        />
        <InfoMetricCard
          label="待上报指纹"
          value={users ? users.fingerprintRequired : '—'}
          detail={users ? `已上报 ${users.withFingerprints}` : '暂无数据'}
          icon={FaUserShield}
        />
      </div>

      {failures > 0 && auditLogs ? (
        <p className="mt-4 flex flex-wrap items-center gap-2 text-xs text-slate-600">
          <InfoBadge tone="rose">需要关注</InfoBadge>
          近 24 小时有 {failures} 条失败审计记录
          <Link to="/admin/audit-log" className="font-semibold text-indigo-600 hover:underline">
            查看审计日志
          </Link>
          <Link to="/admin/ip-ban" className="font-semibold text-indigo-600 hover:underline">
            查看封禁名单
          </Link>
        </p>
      ) : null}
    </InfoPanel>
  );
};

export default AdminOverviewPanel;
