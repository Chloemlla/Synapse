import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Link } from 'react-router-dom';
import { FaChartBar, FaBox, FaKey, FaArrowRight, FaInfoCircle, FaStore, FaCog, FaUsers, FaDownload } from 'react-icons/fa';
import { resourcesApi } from '../api/resources';
import { cdksApi, CDKStats } from '../api/cdks';
import { UnifiedLoadingSpinner } from './LoadingSpinner';
import { cn } from '../utils/cn';
import { studioHeroCardClassName, studioPrimaryButtonClassName, studioSubPanelClassName, studioSurfaceClassName } from './studioTheme';

interface Stats {
  resources: {
    total: number;
  };
  cdks: CDKStats;
}

export default function AdminStoreDashboard() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  // 统计不可用（无权访问 / 接口报错）时不编造 0：
  // 假的 0 会让管理员以为「商店里什么都没有」，而这正是仪表盘最危险的失效方式。
  // 卡片会显示「—」并在上方给出明确提示。
  const [statsError, setStatsError] = useState<string | null>(null);

  useEffect(() => {
    fetchStats();
  }, []);

  const fetchStats = async () => {
    try {
      const [resourceStats, cdkStats] = await Promise.all([
        resourcesApi.getResourceStats(),
        cdksApi.getCDKStats()
      ]);

      setStats({
        resources: resourceStats,
        cdks: cdkStats
      });
      setStatsError(null);
    } catch (error) {
      console.error('获取统计信息失败:', error);
      setStats(null);
      setStatsError('商店统计暂时取不到（可能是权限不足或服务不可用），下方入口仍可正常使用。');
    } finally {
      setLoading(false);
    }
  };

  const handleRefresh = () => {
    setRefreshing(true);
    fetchStats().then(() => setRefreshing(false));
  };

  if (loading) {
    return (
      <div className="flex min-h-[min(24rem,50dvh)] items-center justify-center">
        <UnifiedLoadingSpinner size="lg" text="加载统计信息..." />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* 标题和说明 */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className={cn(studioSubPanelClassName, "border sm:p-6")}
      >
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 mb-4">
          <h2 className="text-xl sm:text-2xl font-bold text-slate-900 flex items-center gap-2">
            <FaStore className="w-6 h-6" />
            资源商店管理
          </h2>
          <motion.button
            onClick={handleRefresh}
            disabled={refreshing}
            className={cn(studioPrimaryButtonClassName, "w-full sm:w-auto px-3 py-2 disabled:opacity-50 font-medium flex")}
            whileTap={{ scale: 0.95 }}
          >
            <FaCog className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
            刷新
          </motion.button>
        </div>
        <div className="text-slate-600 space-y-2">
          <p>欢迎来到资源商店管理仪表板，这里提供完整的资源商店管理功能，包括资源管理、CDK管理和数据统计。</p>
          <div className="flex items-start gap-2 text-sm">
            <FaInfoCircle className="w-4 h-4 text-blue-500 mt-0.5 flex-shrink-0" />
            <div>
              <p className="font-semibold text-blue-700">功能说明：</p>
              <ul className="list-disc list-inside space-y-1 mt-1">
                <li>查看资源商店的实时统计数据</li>
                <li>管理所有资源和CDK兑换码</li>
                <li>监控资源使用情况和CDK兑换状态</li>
                <li>快速访问各个管理功能</li>
              </ul>
            </div>
          </div>
        </div>
      </motion.div>

      {/* 统计卡片 */}
      {statsError ? (
        <div className="flex items-start gap-2 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <FaInfoCircle className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
          <span>{statsError}</span>
        </div>
      ) : null}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4"
      >
        <motion.div 
          className={cn(studioSurfaceClassName, "shadow")}
          whileHover={{ scale: 1.02 }}
          transition={{ duration: 0.2 }}
        >
          <div className="px-4 py-5 sm:p-6">
            <div className="flex items-center">
              <div className="flex-shrink-0">
                <FaBox className="h-8 w-8 text-blue-600" />
              </div>
              <div className="ml-4">
                <dt className="text-sm font-medium text-slate-500 truncate">
                  总资源数量
                </dt>
                <dd className="mt-1 text-3xl font-semibold text-slate-900">
                  {stats ? stats.resources.total : '—'}
                </dd>
              </div>
            </div>
          </div>
        </motion.div>

        <motion.div 
          className={cn(studioSurfaceClassName, "shadow")}
          whileHover={{ scale: 1.02 }}
          transition={{ duration: 0.2 }}
        >
          <div className="px-4 py-5 sm:p-6">
            <div className="flex items-center">
              <div className="flex-shrink-0">
                <FaKey className="h-8 w-8 text-purple-600" />
              </div>
              <div className="ml-4">
                <dt className="text-sm font-medium text-slate-500 truncate">
                  总CDK数量
                </dt>
                <dd className="mt-1 text-3xl font-semibold text-slate-900">
                  {stats ? stats.cdks.total : '—'}
                </dd>
              </div>
            </div>
          </div>
        </motion.div>

        <motion.div 
          className={cn(studioSurfaceClassName, "shadow")}
          whileHover={{ scale: 1.02 }}
          transition={{ duration: 0.2 }}
        >
          <div className="px-4 py-5 sm:p-6">
            <div className="flex items-center">
              <div className="flex-shrink-0">
                <FaUsers className="h-8 w-8 text-red-600" />
              </div>
              <div className="ml-4">
                <dt className="text-sm font-medium text-slate-500 truncate">
                  已使用CDK
                </dt>
                <dd className="mt-1 text-3xl font-semibold text-red-600">
                  {stats ? stats.cdks.used : '—'}
                </dd>
              </div>
            </div>
          </div>
        </motion.div>

        <motion.div 
          className={cn(studioSurfaceClassName, "shadow")}
          whileHover={{ scale: 1.02 }}
          transition={{ duration: 0.2 }}
        >
          <div className="px-4 py-5 sm:p-6">
            <div className="flex items-center">
              <div className="flex-shrink-0">
                <FaDownload className="h-8 w-8 text-green-600" />
              </div>
              <div className="ml-4">
                <dt className="text-sm font-medium text-slate-500 truncate">
                  可用CDK
                </dt>
                <dd className="mt-1 text-3xl font-semibold text-green-600">
                  {stats ? stats.cdks.available : '—'}
                </dd>
              </div>
            </div>
          </div>
        </motion.div>
      </motion.div>

      {/* 导航链接 */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="grid grid-cols-1 gap-5 sm:grid-cols-2"
      >
        <motion.div
          whileHover={{ scale: 1.02 }}
          transition={{ duration: 0.2 }}
        >
          <Link
            to="/admin/store/resources"
            className={cn(studioHeroCardClassName, "shadow hover:bg-slate-50/80 transition-all duration-200 block")}
          >
            <div className="flex items-center">
              <div className="flex-shrink-0">
                <FaBox className="h-8 w-8 text-green-600" />
              </div>
              <div className="ml-4 flex-1">
                <h3 className="text-lg font-medium text-slate-900">资源管理</h3>
                <p className="mt-1 text-sm text-slate-500">
                  管理资源列表，添加、编辑或删除资源
                </p>
              </div>
              <div className="flex-shrink-0">
                <FaArrowRight className="h-5 w-5 text-slate-400" />
              </div>
            </div>
          </Link>
        </motion.div>

        <motion.div
          whileHover={{ scale: 1.02 }}
          transition={{ duration: 0.2 }}
        >
          <Link
            to="/admin/store/cdks"
            className={cn(studioHeroCardClassName, "shadow hover:bg-slate-50/80 transition-all duration-200 block")}
          >
            <div className="flex items-center">
              <div className="flex-shrink-0">
                <FaKey className="h-8 w-8 text-purple-600" />
              </div>
              <div className="ml-4 flex-1">
                <h3 className="text-lg font-medium text-slate-900">CDK管理</h3>
                <p className="mt-1 text-sm text-slate-500">
                  管理CDK，生成新的CDK或查看使用情况
                </p>
              </div>
              <div className="flex-shrink-0">
                <FaArrowRight className="h-5 w-5 text-slate-400" />
              </div>
            </div>
          </Link>
        </motion.div>
      </motion.div>

      {/* 快速访问链接 */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className={cn(studioSubPanelClassName, "border sm:p-6")}
      >
        <h2 className="text-lg font-medium text-slate-900 mb-4 flex items-center gap-2">
          <FaChartBar className="w-5 h-5" />
          快速访问
        </h2>
        <div className="flex flex-wrap gap-4">
          <motion.div
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
          >
            <Link
              to="/store"
              className="inline-flex items-center rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition-all duration-200 shadow-sm hover:border-slate-300 hover:bg-slate-50 hover:shadow-md"
            >
              <FaStore className="w-4 h-4 mr-2" />
              查看商店
            </Link>
          </motion.div>
          <motion.div
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
          >
            <Link
              to="/admin"
              className="inline-flex items-center rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition-all duration-200 shadow-sm hover:border-slate-300 hover:bg-slate-50 hover:shadow-md"
            >
              <FaCog className="w-4 h-4 mr-2" />
              主控制台
            </Link>
          </motion.div>
        </div>
      </motion.div>
    </div>
  );
} 