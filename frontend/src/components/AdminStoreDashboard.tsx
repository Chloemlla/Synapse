import { useCallback, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Link } from 'react-router-dom';
import {
  FaArrowRight,
  FaBox,
  FaChartBar,
  FaCog,
  FaDownload,
  FaInfoCircle,
  FaKey,
  FaStore,
  FaUsers,
} from 'react-icons/fa';
import { resourcesApi } from '../api/resources';
import { cdksApi, CDKStats } from '../api/cdks';
import { cn } from '../utils/cn';
import { useReducedMotion } from '../hooks/useReducedMotion';
import { StudioEmptyState, StudioErrorState, StudioLoadingState } from './studioFeedback';
import {
  InfoMetricCard,
  studioAccentBlobBlueClassName,
  studioAccentBlobSkyClassName,
  studioDisplayFont,
  studioEyebrowPillClassName,
  studioHeroCardClassName,
  studioMainSurfaceClassName,
  studioMetricToneClassName,
  studioPageClassName,
  studioPageFont,
  studioPanelClassName,
  studioPrimaryButtonClassName,
  studioSecondaryButtonClassName,
} from './studioTheme';

interface Stats {
  resources: {
    total: number;
  };
  cdks: CDKStats;
}

const CAPABILITIES = [
  '查看资源商店的实时统计数据',
  '管理所有资源和 CDK 兑换码',
  '监控资源使用情况与 CDK 兑换状态',
  '快速进入各管理功能',
];

export default function AdminStoreDashboard() {
  const reducedMotion = useReducedMotion();
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  // 统计不可用（无权访问 / 接口报错）时不编造 0：
  // 假的 0 会让管理员以为「商店里什么都没有」，而这正是仪表盘最危险的失效方式。
  // 卡片会显示「—」并在上方给出明确提示。
  const [statsError, setStatsError] = useState<string | null>(null);

  const fetchStats = useCallback(async () => {
    try {
      const [resourceStats, cdkStats] = await Promise.all([
        resourcesApi.getResourceStats(),
        cdksApi.getCDKStats(),
      ]);

      setStats({
        resources: resourceStats,
        cdks: cdkStats,
      });
      setStatsError(null);
      setLastUpdatedAt(Date.now());
    } catch (error) {
      console.error('获取统计信息失败:', error);
      setStats(null);
      setStatsError('商店统计暂时取不到（可能是权限不足或服务不可用）。下方管理入口仍可正常使用。');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchStats();
  }, [fetchStats]);

  const handleRefresh = async () => {
    setRefreshing(true);
    await fetchStats();
    setRefreshing(false);
  };

  const statusTiles = [
    { label: '资源总数', value: stats ? stats.resources.total : '—' },
    { label: 'CDK 总数', value: stats ? stats.cdks.total : '—' },
    { label: '可用 CDK', value: stats ? stats.cdks.available : '—' },
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
                <FaStore />
                Resource Store Studio
              </div>
              <h1
                className="text-[2rem] font-semibold leading-[1.05] text-slate-900 sm:text-5xl sm:leading-tight"
                style={{ fontFamily: studioDisplayFont }}
              >
                资源商店管理
              </h1>
              <p className="mt-4 max-w-2xl text-sm leading-7 text-slate-600 sm:text-base">
                资源与 CDK 的实时统计，以及各管理入口。统计读取失败时会显式提示，不会用 0 冒充。
              </p>
            </div>
            <div className="w-full lg:w-auto">
              <div className="grid gap-2 sm:grid-cols-3 sm:gap-3">
                {statusTiles.map((tile) => (
                  <div
                    key={tile.label}
                    className={cn('min-w-0 rounded-2xl border px-3 py-2.5 sm:px-4 sm:py-3', studioMetricToneClassName('slate'))}
                  >
                    <div className="text-[10px] uppercase tracking-[0.24em] text-slate-400">{tile.label}</div>
                    <div className="mt-2 break-words text-sm font-semibold text-slate-800">{tile.value}</div>
                  </div>
                ))}
              </div>
              <button
                type="button"
                onClick={() => void handleRefresh()}
                disabled={refreshing}
                className={cn(studioPrimaryButtonClassName, 'mt-3 min-h-11 w-full sm:min-h-0 lg:w-auto')}
              >
                <FaCog className={cn('h-4 w-4', refreshing && 'animate-spin')} />
                {refreshing ? '刷新中…' : '刷新统计'}
              </button>
            </div>
          </div>
        </motion.div>

        <div className="grid gap-4 sm:gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,400px)]">
          <motion.div
            initial={reducedMotion ? false : { opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: reducedMotion ? 0 : 0.05 }}
            className={studioMainSurfaceClassName}
          >
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
              <div className="text-sm font-semibold text-slate-800">商店统计</div>
              <span className="text-xs text-slate-400">
                {lastUpdatedAt ? `更新于 ${new Date(lastUpdatedAt).toLocaleTimeString('zh-CN', { hour12: false })}` : '尚未取到数据'}
              </span>
            </div>

            {loading ? (
              <StudioLoadingState minHeightClassName="min-h-[260px]" text="正在读取商店统计…" />
            ) : statsError ? (
              <StudioErrorState
                message={statsError}
                onRetry={() => {
                  setLoading(true);
                  void fetchStats();
                }}
              />
            ) : !stats ? (
              <StudioEmptyState
                message="暂时没有商店统计数据。点「重试」再读一次；若持续为空，请确认资源与 CDK 数据已初始化。"
                action={
                  <button
                    type="button"
                    onClick={() => {
                      setLoading(true);
                      void fetchStats();
                    }}
                    className={studioSecondaryButtonClassName}
                  >
                    重试
                  </button>
                }
              />
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <InfoMetricCard label="总资源数量" value={stats.resources.total} detail="资源商店里的全部条目" icon={FaBox} tone="slate" />
                <InfoMetricCard label="总 CDK 数量" value={stats.cdks.total} detail="含已使用与已失效" icon={FaKey} tone="sky" />
                <InfoMetricCard label="已使用 CDK" value={stats.cdks.used} detail="已被兑换过的兑换码" icon={FaUsers} tone="amber" />
                <InfoMetricCard label="可用 CDK" value={stats.cdks.available} detail="当前仍可兑换" icon={FaDownload} tone="emerald" />
              </div>
            )}
          </motion.div>

          <div className="min-w-0 space-y-4 sm:space-y-6">
            <motion.section
              initial={reducedMotion ? false : { opacity: 0, y: 24 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: reducedMotion ? 0 : 0.1 }}
              className={studioPanelClassName}
            >
              <div className="mb-4 text-sm font-semibold text-slate-800">管理入口</div>
              <div className="space-y-3">
                <Link
                  to="/admin/store/resources"
                  className="flex min-h-11 items-center gap-3 rounded-2xl border-2 border-slate-200 bg-white/80 px-4 py-3 transition hover:border-slate-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300 focus-visible:ring-offset-2"
                >
                  <FaBox className="h-5 w-5 shrink-0 text-slate-400" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold text-slate-900">资源管理</span>
                    <span className="block text-xs text-slate-500">添加、编辑或删除资源</span>
                  </span>
                  <FaArrowRight className="h-4 w-4 shrink-0 text-slate-300" aria-hidden />
                </Link>
                <Link
                  to="/admin/store/cdks"
                  className="flex min-h-11 items-center gap-3 rounded-2xl border-2 border-slate-200 bg-white/80 px-4 py-3 transition hover:border-slate-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300 focus-visible:ring-offset-2"
                >
                  <FaKey className="h-5 w-5 shrink-0 text-slate-400" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold text-slate-900">CDK 管理</span>
                    <span className="block text-xs text-slate-500">生成新的兑换码或查看使用情况</span>
                  </span>
                  <FaArrowRight className="h-4 w-4 shrink-0 text-slate-300" aria-hidden />
                </Link>
              </div>
            </motion.section>

            <motion.section
              initial={reducedMotion ? false : { opacity: 0, y: 24 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: reducedMotion ? 0 : 0.15 }}
              className={studioPanelClassName}
            >
              <div className="mb-3 flex items-center gap-2">
                <FaChartBar className="h-4 w-4 text-slate-400" aria-hidden />
                <span className="text-sm font-semibold text-slate-800">在这里可以做什么</span>
              </div>
              <ul className="space-y-1.5 text-xs leading-6 text-slate-600">
                {CAPABILITIES.map((item) => (
                  <li key={item} className="flex gap-2">
                    <FaInfoCircle className="mt-1.5 h-3 w-3 shrink-0 text-slate-300" aria-hidden />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </motion.section>

            <motion.section
              initial={reducedMotion ? false : { opacity: 0, y: 24 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: reducedMotion ? 0 : 0.2 }}
              className={studioPanelClassName}
            >
              <div className="mb-3 text-sm font-semibold text-slate-800">快速访问</div>
              <div className="flex flex-wrap gap-3">
                <Link to="/store" className={cn(studioSecondaryButtonClassName, 'min-h-11 sm:min-h-0')}>
                  <FaStore className="h-4 w-4" aria-hidden />
                  查看商店
                </Link>
                <Link to="/admin" className={cn(studioSecondaryButtonClassName, 'min-h-11 sm:min-h-0')}>
                  <FaCog className="h-4 w-4" aria-hidden />
                  主控制台
                </Link>
              </div>
            </motion.section>
          </div>
        </div>
      </div>
    </div>
  );
}
