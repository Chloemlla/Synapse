import React, { useCallback, useEffect, useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { FaDatabase, FaEnvelope, FaEnvelopeOpenText, FaGlobe, FaShieldAlt, FaSync } from 'react-icons/fa';
import { api } from '@/api';

import { ADMIN_TAB_TO_PATH } from '@/navigation/navConfig';

import { AdminHub } from './admin/AdminHub';
import AdminOverviewPanel from './admin/AdminOverviewPanel';
import { useAuth } from '@/hooks/useAuth';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import { isSuperAdmin } from '@/utils/rbac';
import { cn } from '@/utils/cn';
import { StudioEmptyState, StudioErrorNote, StudioErrorState, StudioLoadingState } from './studioFeedback';
import {
  studioAccentBlobBlueClassName,
  studioAccentBlobSkyClassName,
  studioDisplayFont,
  studioEyebrowPillClassName,
  studioHeroCardClassName,
  studioMetricToneClassName,
  studioPageClassName,
  studioPageFont,
  studioPanelClassName,
  studioPrimaryButtonClassName,
  studioSecondaryButtonClassName,
} from './studioTheme';

interface ServiceStatus {
  available: boolean;
  error?: string;
  domain?: string;
  authConfigured?: boolean;
}

interface QuotaInfo {
  used: number;
  total: number;
  resetAt: string;
}

interface RecordCount {
  total: number;
}

/** 邮件溯源区块自己的四态：403 与「取不到」必须分开，且都不能渲染成一排 0。 */
type EmailOverviewState = 'loading' | 'ready' | 'partial' | 'error' | 'forbidden';

/**
 * Compatibility entry for the legacy `/admin` + `?tab=` deep links.
 *
 * - `/admin?tab=users` → redirect to `/admin/users`
 * - `/admin` (no tab) → render the new AdminHub overview with traceability dashboard
 */
const AdminDashboard: React.FC = () => {
  const [searchParams] = useSearchParams();
  const tab = searchParams.get('tab');
  const { user } = useAuth();
  const reducedMotion = useReducedMotion();
  // 邮件溯源接口是 superadmin 专属：普通管理员调只会拿到 403，前端却会用 allSettled 的回退值
  // 渲染出一排 0（看起来像「今天没发过邮件」）。所以按角色决定是否请求。
  const canReadEmailTraceability = isSuperAdmin(user?.role);

  const [status, setStatus] = useState<ServiceStatus | null>(null);
  const [quota, setQuota] = useState<QuotaInfo>({ used: 0, total: 0, resetAt: '' });
  const [recordCount, setRecordCount] = useState(0);
  const [emailState, setEmailState] = useState<EmailOverviewState>('loading');

  const loadEmailOverview = useCallback(async () => {
    if (!canReadEmailTraceability) {
      setEmailState('forbidden');
      return;
    }
    setEmailState('loading');
    const [statusRes, quotaRes, recordsRes] = await Promise.allSettled([
      api.get('/api/outemail/status'),
      api.get('/api/outemail/quota'),
      api.get('/api/outemail/records?pageSize=1'),
    ]);

    if (statusRes.status === 'fulfilled') setStatus(statusRes.value.data);
    if (quotaRes.status === 'fulfilled' && quotaRes.value.data?.success) {
      setQuota({ used: quotaRes.value.data.used, total: quotaRes.value.data.total, resetAt: quotaRes.value.data.resetAt });
    }
    if (recordsRes.status === 'fulfilled' && recordsRes.value.data?.success) {
      setRecordCount(recordsRes.value.data.total);
    }

    const fulfilled = [statusRes, quotaRes, recordsRes].filter((res) => res.status === 'fulfilled').length;
    setEmailState(fulfilled === 0 ? 'error' : fulfilled === 3 ? 'ready' : 'partial');
  }, [canReadEmailTraceability]);

  useEffect(() => {
    void loadEmailOverview();
  }, [loadEmailOverview]);

  if (tab) {
    const mapped = ADMIN_TAB_TO_PATH[tab];
    return <Navigate to={mapped || '/admin'} replace />;
  }

  const quotaPercent = quota.total > 0 ? Math.min((quota.used / quota.total) * 100, 100) : 0;
  const emailReady = emailState === 'ready' || emailState === 'partial';
  const heroTiles = [
    { label: '邮件服务', value: status ? (status.available ? '正常' : '异常') : emailState === 'forbidden' ? '无权限' : '—' },
    { label: '今日配额', value: emailReady ? `${quota.used} / ${quota.total}` : '—' },
    { label: '发送记录', value: emailReady ? String(recordCount) : '—' },
  ];

  return (
    <div className={studioPageClassName} style={{ fontFamily: studioPageFont }}>
      <div className="mx-auto max-w-7xl min-w-0">
        <motion.div
          initial={reducedMotion ? false : { opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45 }}
          className={cn('mb-5 sm:mb-8', studioHeroCardClassName)}
        >
          <div className={cn(studioAccentBlobBlueClassName, '-right-12 top-0')} aria-hidden />
          <div className={cn(studioAccentBlobSkyClassName, '-left-10 bottom-0')} aria-hidden />
          <div className="relative flex min-w-0 flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl min-w-0">
              <div className={cn('mb-3', studioEyebrowPillClassName)}>
                <FaShieldAlt />
                Admin Console
              </div>
              <h1
                className="text-[2rem] font-semibold leading-[1.05] text-slate-900 sm:text-5xl sm:leading-tight"
                style={{ fontFamily: studioDisplayFont }}
              >
                管理控制台
              </h1>
              <p className="mt-4 max-w-2xl text-sm leading-7 text-slate-600 sm:text-base">
                模块入口、系统概览与邮件溯源汇总。旧版 <code className="font-mono">?tab=</code> 深链会自动跳转到对应模块。
              </p>
            </div>
            <div className="w-full lg:w-auto">
              <div className="grid gap-2 sm:grid-cols-3 sm:gap-3">
                {heroTiles.map((tile) => (
                  <div
                    key={tile.label}
                    className={cn('min-w-0 rounded-2xl border px-3 py-2.5 sm:px-4 sm:py-3', studioMetricToneClassName('slate'))}
                  >
                    <div className="text-[10px] uppercase tracking-[0.24em] text-slate-400">{tile.label}</div>
                    <div className="mt-2 break-words text-sm font-semibold text-slate-800">{tile.value}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </motion.div>

        <div className="grid gap-4 sm:gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,400px)]">
          {/* 主列：AdminHub 自带页面壳与总览 hero，这里不再套第二层 surface 卡。 */}
          <div className="min-w-0 space-y-5">
            <AdminOverviewPanel />
            <AdminHub />
          </div>

          <div className="min-w-0 space-y-4 sm:space-y-6">
            <motion.section
              initial={reducedMotion ? false : { opacity: 0, y: 24 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: reducedMotion ? 0 : 0.1 }}
              className={studioPanelClassName}
            >
              <div className="mb-4 flex items-start gap-3">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-2xl bg-slate-900 text-white">
                  <FaDatabase className="size-4" aria-hidden />
                </div>
                <div className="min-w-0">
                  <h2 className="text-base font-semibold text-slate-900">邮件发信溯源</h2>
                  <p className="mt-1 text-xs leading-5 text-slate-500">对外邮件服务状态与发送记录概览。</p>
                </div>
              </div>

              {emailState === 'forbidden' ? (
                <StudioEmptyState
                  className="py-10"
                  message="当前账号看不到邮件溯源数据。如需查看，请让超级管理员在页面授权里为你开启对应页面。"
                />
              ) : emailState === 'error' ? (
                <StudioErrorState
                  message="邮件溯源数据暂时取不到，其它面板不受影响。"
                  onRetry={() => void loadEmailOverview()}
                />
              ) : emailState === 'loading' ? (
                <StudioLoadingState minHeightClassName="min-h-[220px]" text="正在读取邮件溯源数据…" />
              ) : (
                <>
                  {emailState === 'partial' ? (
                    <StudioErrorNote className="mb-3">部分数据没有取到，下列数字可能不完整。</StudioErrorNote>
                  ) : null}
                  <div className="space-y-3">
                    <div className={cn('rounded-2xl border p-3.5', studioMetricToneClassName('slate'))}>
                      <div className="flex items-center gap-2">
                        <FaGlobe className="size-3.5 text-slate-400" aria-hidden />
                        <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">服务状态</span>
                      </div>
                      <div className="mt-1.5 flex items-center gap-2">
                        <span className={cn('size-2.5 rounded-full', status?.available ? 'bg-emerald-500' : 'bg-rose-500')} />
                        <span className="text-sm font-semibold text-slate-700">
                          {status?.available ? '正常' : status?.error || '异常'}
                        </span>
                      </div>
                      <div className="mt-0.5 text-xs text-slate-400">{status?.domain || '未配置域名'}</div>
                    </div>

                    <div className={cn('rounded-2xl border p-3.5', studioMetricToneClassName('slate'))}>
                      <div className="flex items-center gap-2">
                        <FaEnvelope className="size-3.5 text-slate-400" aria-hidden />
                        <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">今日配额</span>
                      </div>
                      <div className="mt-1.5 text-sm font-semibold text-slate-700">
                        {quota.used} / {quota.total}
                      </div>
                      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-100">
                        <div className="h-1.5 rounded-full bg-slate-900 transition-all" style={{ width: `${quotaPercent}%` }} />
                      </div>
                      <div className="mt-0.5 text-xs text-slate-400">
                        重置时间：{quota.resetAt ? new Date(quota.resetAt).toLocaleString('zh-CN', { hour12: false }) : '-'}
                      </div>
                    </div>

                    <div className={cn('rounded-2xl border p-3.5', studioMetricToneClassName('slate'))}>
                      <div className="flex items-center gap-2">
                        <FaEnvelopeOpenText className="size-3.5 text-slate-400" aria-hidden />
                        <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">发送记录</span>
                      </div>
                      <div className="mt-1.5 text-2xl font-bold text-slate-900">{recordCount}</div>
                      <div className="mt-0.5 text-xs text-slate-400">累计对外邮件发送</div>
                    </div>
                  </div>

                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    <Link to="/admin/email-traceability" className={cn(studioPrimaryButtonClassName, 'min-h-11 sm:min-h-0')}>
                      <FaDatabase className="size-3.5" aria-hidden />
                      查看完整溯源
                    </Link>
                    <button
                      type="button"
                      onClick={() => void loadEmailOverview()}
                      className={cn(studioSecondaryButtonClassName, 'min-h-11 sm:min-h-0')}
                    >
                      <FaSync className="size-3.5" aria-hidden />
                      刷新
                    </button>
                  </div>
                </>
              )}
            </motion.section>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AdminDashboard;
