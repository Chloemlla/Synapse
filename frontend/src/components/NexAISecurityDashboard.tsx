import React, { useState, useRef, useEffect, useMemo } from 'react';
import { Doughnut, Bar } from 'react-chartjs-2';
import {
  Chart as ChartJS,
  BarElement,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  ArcElement,
  Title,
  Tooltip,
  Legend,
  Filler
} from 'chart.js';
import api from '../api/api';
import { useNotification } from './Notification';
import {
  FaShieldAlt,
  FaExclamationTriangle,
  FaMobileAlt,
  FaUsers,
  FaChartBar,
  FaClock,
  FaFilter,
  FaExclamationCircle,
  FaGlobe
} from 'react-icons/fa';
import { cn } from '../utils/cn';
import {
  studioFieldClassName,
  studioPillClassName,
  studioSecondaryButtonClassName,
  studioSurfaceClassName,
  studioTileClassName,
} from './studioTheme';
import { StudioEmptyState, StudioErrorNote, StudioErrorState, StudioLoadingState } from './studioFeedback';

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  ArcElement,
  Title,
  Tooltip,
  Legend,
  Filler
);

interface DeviceTracking {
  _id: string;
  userId: string;
  deviceFingerprint: string;
  riskScore: number;
  riskLevel: string;
  isCompromised: boolean;
  isRoot: boolean;
  isDebugger: boolean;
  isEmulator: boolean;
  isVpn: boolean;
  signatureValid: boolean;
  hashValid: boolean;
  appVersion?: string;
  appBuild?: string;
  firstSeen: string;
  lastSeen: string;
  requestCount: number;
  blockedCount: number;
  ipAddress?: string;
  userAgent?: string;
}

interface SecurityEvent {
  _id: string;
  deviceFingerprint: string;
  userId?: string;
  eventType: string;
  eventData?: any;
  riskScore?: number;
  ipAddress?: string;
  userAgent?: string;
  createdAt: string;
}

interface DashboardStats {
  totalDevices: number;
  highRiskDevices: number;
  compromisedDevices: number;
  totalEvents: number;
  riskDistribution: {
    SAFE: number;
    LOW: number;
    MEDIUM: number;
    HIGH: number;
    CRITICAL: number;
  };
  eventTypeDistribution: Record<string, number>;
  recentEvents: SecurityEvent[];
  topRiskyDevices: DeviceTracking[];
}

const RISK_LEVEL_LABELS: Record<string, string> = {
  SAFE: '安全',
  LOW: '低风险',
  MEDIUM: '中风险',
  HIGH: '高风险',
  CRITICAL: '极高风险',
};

const EVENT_TYPE_LABELS: Record<string, string> = {
  integrity_fail: '完整性验证失败',
  root_detected: 'Root检测',
  debugger_detected: '调试器检测',
  emulator_detected: '模拟器检测',
  vpn_detected: 'VPN 检测',
  hook_detected: 'Hook 检测',
  tamper_detected: '篡改检测',
  anti_debug: '反调试命中',
  frida_detected: 'Frida框架检测',
  xposed_detected: 'Xposed框架检测',
  login_anomaly: '登录异常',
  device_switch: '设备切换',
  heartbeat: '心跳上报',
  custom: '自定义事件',
  dom_modification: 'DOM 篡改',
  network_tampering: '网络篡改',
  proxy_tampering: '代理篡改',
  script_injection: '脚本注入',
  dom: 'DOM 篡改',
  network: '网络篡改',
  proxy: '代理篡改',
  injection: '脚本注入',
  manual_test: '手动测试',
  unknown: '未知事件',
};

const getRiskLevelLabel = (level: string) => RISK_LEVEL_LABELS[level] || level;

const getEventTypeLabel = (type: string) => EVENT_TYPE_LABELS[type] || type;

/** 与后端 `ALLOWED_SECURITY_EVENT_TYPES` 对齐的事件类型筛选项（只列上报接口真正接受的值）。 */
const EVENT_TYPE_OPTIONS: ReadonlyArray<string> = [
  'integrity_fail',
  'root_detected',
  'debugger_detected',
  'emulator_detected',
  'vpn_detected',
  'hook_detected',
  'tamper_detected',
  'anti_debug',
  'frida_detected',
  'xposed_detected',
  'login_anomaly',
  'device_switch',
  'heartbeat',
  'custom',
];

/** 后端 `/devices` `/events` 统一回的分页元数据。 */
interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

const EMPTY_PAGINATION: Pagination = { page: 1, limit: 20, total: 0, totalPages: 0 };

const PAGE_SIZE_OPTIONS = [20, 50, 100] as const;

/**
 * 列表分页器（服务端分页）：显示「第 x–y 条 / 共 n 条」，并只给上一页/下一页。
 * 之前两个列表都写死了 `page=1&limit=20`，超出 20 条的数据根本看不到。
 */
const ListPager: React.FC<{
  pagination: Pagination;
  loading: boolean;
  onChange: (page: number) => void;
}> = ({ pagination, loading, onChange }) => {
  const { page, limit, total, totalPages } = pagination;
  if (total === 0) return null;
  const from = (page - 1) * limit + 1;
  const to = Math.min(page * limit, total);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 px-4 py-3">
      <span className="text-xs text-slate-500">
        第 {from}–{to} 条 / 共 {total} 条（第 {page} / {Math.max(totalPages, 1)} 页）
      </span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={loading || page <= 1}
          onClick={() => onChange(page - 1)}
          className={cn(studioSecondaryButtonClassName, 'min-h-9 px-3 py-1.5 text-xs disabled:opacity-50')}
        >
          上一页
        </button>
        <button
          type="button"
          disabled={loading || page >= totalPages}
          onClick={() => onChange(page + 1)}
          className={cn(studioSecondaryButtonClassName, 'min-h-9 px-3 py-1.5 text-xs disabled:opacity-50')}
        >
          下一页
        </button>
      </div>
    </div>
  );
};

const NexAISecurityDashboard: React.FC = () => {
  const { setNotification } = useNotification();
  const statsRequestRef = useRef(0);
  const devicesRequestRef = useRef(0);
  const eventsRequestRef = useRef(0);

  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);
  // 拉取失败与「真的是 0 台设备」必须分开：失败时给错误态 + 重试，不渲染一组全 0 的指标
  const [loadError, setLoadError] = useState('');
  const [selectedTab, setSelectedTab] = useState<'overview' | 'devices' | 'events'>('overview');
  const [timeRange, setTimeRange] = useState<'1h' | '24h' | '7d' | '30d'>('24h');

  // 设备列表：服务端分页 + 服务端筛选（搜索 / 风险等级 / 攻破状态）
  const [devices, setDevices] = useState<DeviceTracking[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(true);
  const [devicesError, setDevicesError] = useState('');
  const [devicesPagination, setDevicesPagination] = useState<Pagination>(EMPTY_PAGINATION);
  const [deviceSearchDraft, setDeviceSearchDraft] = useState('');
  const [deviceQuery, setDeviceQuery] = useState({
    search: '',
    riskLevel: 'all',
    status: 'all',
    page: 1,
    limit: 20,
  });

  // 安全事件列表：同样全部下推到服务端（默认不限时间窗，库里有多少就能翻到多少）
  const [events, setEvents] = useState<SecurityEvent[]>([]);
  const [eventsLoading, setEventsLoading] = useState(true);
  const [eventsError, setEventsError] = useState('');
  const [eventsPagination, setEventsPagination] = useState<Pagination>(EMPTY_PAGINATION);
  const [eventSearchDraft, setEventSearchDraft] = useState('');
  const [eventQuery, setEventQuery] = useState({
    search: '',
    eventType: 'all',
    timeRange: 'all',
    page: 1,
    limit: 20,
  });

  const loadStats = async () => {
    const request = ++statsRequestRef.current;
    setStatsLoading(true);
    try {
      const res = await api.get(`/api/nexai/security/stats?timeRange=${timeRange}`);
      if (request !== statsRequestRef.current) return;
      setStats(res.data);
      setLoadError('');
    } catch (error: any) {
      if (request !== statsRequestRef.current) return;
      console.error('Failed to fetch dashboard stats:', error);
      if (error.response?.status !== 401) {
        setNotification({ type: 'error', message: '加载数据失败' });
      }
      // 401 交给 api 拦截器处理跳转，这里同样记错误态，避免渲染成「全部为 0」
      setLoadError('安全数据加载失败，请检查网络后重试。');
    } finally {
      if (request === statsRequestRef.current) setStatsLoading(false);
    }
  };

  const loadDevices = async () => {
    const request = ++devicesRequestRef.current;
    setDevicesLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(deviceQuery.page),
        limit: String(deviceQuery.limit),
      });
      if (deviceQuery.search) params.set('search', deviceQuery.search);
      if (deviceQuery.riskLevel !== 'all') params.set('riskLevel', deviceQuery.riskLevel);
      if (deviceQuery.status !== 'all') params.set('status', deviceQuery.status);
      const res = await api.get(`/api/nexai/security/devices?${params.toString()}`);
      if (request !== devicesRequestRef.current) return;
      setDevices(res.data.devices || []);
      setDevicesPagination(res.data.pagination ?? EMPTY_PAGINATION);
      setDevicesError('');
    } catch (error: any) {
      if (request !== devicesRequestRef.current) return;
      console.error('Failed to fetch devices:', error);
      setDevicesError('设备列表加载失败，请稍后重试。');
    } finally {
      if (request === devicesRequestRef.current) setDevicesLoading(false);
    }
  };

  const loadEvents = async () => {
    const request = ++eventsRequestRef.current;
    setEventsLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(eventQuery.page),
        limit: String(eventQuery.limit),
      });
      if (eventQuery.search) params.set('search', eventQuery.search);
      if (eventQuery.eventType !== 'all') params.set('eventType', eventQuery.eventType);
      if (eventQuery.timeRange !== 'all') params.set('timeRange', eventQuery.timeRange);
      const res = await api.get(`/api/nexai/security/events?${params.toString()}`);
      if (request !== eventsRequestRef.current) return;
      setEvents(res.data.events || []);
      setEventsPagination(res.data.pagination ?? EMPTY_PAGINATION);
      setEventsError('');
    } catch (error: any) {
      if (request !== eventsRequestRef.current) return;
      console.error('Failed to fetch events:', error);
      setEventsError('安全事件列表加载失败，请稍后重试。');
    } finally {
      if (request === eventsRequestRef.current) setEventsLoading(false);
    }
  };

  useEffect(() => {
    void loadStats();
    const interval = setInterval(loadStats, 30000); // 每30秒刷新统计（列表页不动，避免翻页被打断）
    return () => {
      ++statsRequestRef.current;
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeRange]);

  useEffect(() => {
    void loadDevices();
    return () => {
      ++devicesRequestRef.current;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceQuery]);

  useEffect(() => {
    void loadEvents();
    return () => {
      ++eventsRequestRef.current;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventQuery]);

  const getRiskLevelColor = (level: string) => {
    switch (level) {
      case 'SAFE': return 'text-emerald-600 bg-emerald-100';
      case 'LOW': return 'text-sky-600 bg-sky-100';
      case 'MEDIUM': return 'text-amber-600 bg-amber-100';
      case 'HIGH': return 'text-amber-700 bg-amber-200';
      case 'CRITICAL': return 'text-rose-600 bg-rose-100';
      default: return 'text-slate-600 bg-slate-100';
    }
  };

  const getRiskLevelBadge = (level: string) => {
    const colorClass = getRiskLevelColor(level);
    return (
      <span
        className={`px-2 py-1 rounded-full text-xs font-semibold ${colorClass}`}
        title={level}
      >
        {getRiskLevelLabel(level)}
      </span>
    );
  };

  // 风险分布饼图数据
  const riskDistributionData = useMemo(() => ({
    labels: ['安全', '低风险', '中风险', '高风险', '极高风险'],
    datasets: [{
      data: stats ? [
        stats.riskDistribution.SAFE || 0,
        stats.riskDistribution.LOW || 0,
        stats.riskDistribution.MEDIUM || 0,
        stats.riskDistribution.HIGH || 0,
        stats.riskDistribution.CRITICAL || 0
      ] : [0, 0, 0, 0, 0],
      backgroundColor: [
        'rgba(16, 185, 129, 0.8)',
        'rgba(14, 165, 233, 0.8)',
        'rgba(251, 191, 36, 0.8)',
        'rgba(217, 119, 6, 0.8)',
        'rgba(244, 63, 94, 0.8)'
      ],
      borderColor: [
        'rgb(16, 185, 129)',
        'rgb(14, 165, 233)',
        'rgb(251, 191, 36)',
        'rgb(217, 119, 6)',
        'rgb(244, 63, 94)'
      ],
      borderWidth: 2
    }]
  }), [stats]);

  // 事件类型分布柱状图数据（枚举值统一转中文展示）
  const eventTypeData = useMemo(() => ({
    labels: stats ? Object.keys(stats.eventTypeDistribution).map(getEventTypeLabel) : [],
    datasets: [{
      label: '事件数量',
      data: stats ? Object.values(stats.eventTypeDistribution) : [],
      backgroundColor: 'rgba(14, 165, 233, 0.8)',
      borderColor: 'rgb(14, 165, 233)',
      borderWidth: 1
    }]
  }), [stats]);

  // 设备筛选已全部下推到服务端（见 loadDevices），这里只回答「有没有筛选条件」用于空态文案。
  const hasActiveDeviceFilter =
    deviceQuery.search.length > 0 || deviceQuery.riskLevel !== 'all' || deviceQuery.status !== 'all';

  // 页巡检每 30 秒会把 statsLoading 置为 true：只在「一条数据都还没有」时才整页等，
  // 否则每次轮询都会把已经显示的指标刷成白屏。
  if (!stats && statsLoading) {
    return (
      <div className="p-4 sm:p-6">
        <StudioLoadingState text="正在加载安全数据…" minHeightClassName="min-h-screen" />
      </div>
    );
  }

  // 首次加载就失败：给可重试的错误态，而不是一组全 0 的指标（那等于给出了错误结论）
  if (!stats && loadError) {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <StudioErrorState
          message={loadError}
          retryLabel="重新加载"
          onRetry={() => {
            void loadStats();
          }}
          className="w-full max-w-md"
        />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-white/80 backdrop-blur-xl p-4 sm:p-6">
      <div className="max-w-7xl mx-auto">
        {/* 自动轮询失败时页面不会清空，但必须说清楚数字是上一轮的 */}
        {loadError ? (
          <StudioErrorNote className="mb-5 text-xs">安全数据刷新失败，下面显示的是上次成功读取的结果。</StudioErrorNote>
        ) : null}

        {/* 页面标题 */}
        <div className="mb-8">
          <h1 className="text-2xl sm:text-3xl font-bold text-slate-900 flex items-center gap-3">
            <FaShieldAlt className="w-6 h-6 sm:w-8 sm:h-8 text-slate-500" />
            NexAI 安全监控中心
          </h1>
          <p className="mt-2 text-slate-600">实时监控设备安全状态、风险评估和异常行为</p>
        </div>

        {/* 时间范围选择器 */}
        <div className="mb-6 flex gap-2 overflow-x-auto pb-1">
          {(['1h', '24h', '7d', '30d'] as const).map((range) => (
            <button
              type="button"
              key={range}
              onClick={() => setTimeRange(range)}
              className={cn(studioPillClassName(timeRange === range), 'min-h-11')}
            >
              {range === '1h' && '最近1小时'}
              {range === '24h' && '最近24小时'}
              {range === '7d' && '最近7天'}
              {range === '30d' && '最近30天'}
            </button>
          ))}
        </div>

        {/* 统计卡片 */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
          <div className={cn(studioTileClassName, "p-6")}>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-slate-600">总设备数</p>
                <p className="text-3xl font-bold text-slate-900 mt-2">{stats?.totalDevices || 0}</p>
              </div>
              <FaMobileAlt className="w-10 h-10 text-slate-500 opacity-80" />
            </div>
          </div>

          <div className={cn(studioTileClassName, "p-6")}>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-slate-600">高风险设备</p>
                <p className="text-3xl font-bold text-amber-600 mt-2">{stats?.highRiskDevices || 0}</p>
              </div>
              <FaExclamationTriangle className="w-10 h-10 text-amber-600 opacity-80" />
            </div>
          </div>

          <div className={cn(studioTileClassName, "p-6")}>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-slate-600">已攻破设备</p>
                <p className="text-3xl font-bold text-rose-600 mt-2">{stats?.compromisedDevices || 0}</p>
              </div>
              <FaShieldAlt className="w-10 h-10 text-rose-600 opacity-80" />
            </div>
          </div>

          <div className={cn(studioTileClassName, "p-6")}>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-slate-600">安全事件</p>
                <p className="text-3xl font-bold text-slate-900 mt-2">{stats?.totalEvents || 0}</p>
              </div>
              <FaChartBar className="w-10 h-10 text-slate-500 opacity-80" />
            </div>
          </div>
        </div>

        {/* 标签页导航 */}
        <div className={cn(studioSurfaceClassName, "mb-6")}>
          <div className="border-b border-slate-200 p-2">
            <nav className="flex gap-2 overflow-x-auto" aria-label="安全监控视图">
              <button
                type="button"
                onClick={() => setSelectedTab('overview')}
                className={cn(studioPillClassName(selectedTab === 'overview'), 'inline-flex min-h-11 items-center gap-2')}
              >
                <FaChartBar className="w-4 h-4" aria-hidden /> 概览
              </button>
              <button
                type="button"
                onClick={() => setSelectedTab('devices')}
                className={cn(studioPillClassName(selectedTab === 'devices'), 'inline-flex min-h-11 items-center gap-2')}
              >
                <FaMobileAlt className="w-4 h-4" aria-hidden /> 设备管理
              </button>
              <button
                type="button"
                onClick={() => setSelectedTab('events')}
                className={cn(studioPillClassName(selectedTab === 'events'), 'inline-flex min-h-11 items-center gap-2')}
              >
                <FaClock className="w-4 h-4" aria-hidden /> 安全事件
              </button>
            </nav>
          </div>

          {/* 概览标签页 */}
          {selectedTab === 'overview' && (
            <div className="p-4 sm:p-6">
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* 风险分布饼图 */}
                <div className="bg-slate-50/80 rounded-2xl p-6 border border-slate-100">
                  <h3 className="text-lg font-semibold text-slate-900 mb-4 flex items-center gap-2">
                    <FaShieldAlt className="text-slate-500" /> 风险等级分布
                  </h3>
                  <div className="h-48 sm:h-64">
                    <Doughnut
                      data={riskDistributionData}
                      options={{
                        responsive: true,
                        maintainAspectRatio: false,
                        plugins: {
                          legend: {
                            position: 'bottom' as const
                          }
                        }
                      }}
                    />
                  </div>
                </div>

                {/* 事件类型分布柱状图 */}
                <div className="bg-slate-50/80 rounded-2xl p-6 border border-slate-100">
                  <h3 className="text-lg font-semibold text-slate-900 mb-4 flex items-center gap-2">
                    <FaChartBar className="text-slate-500" /> 安全事件类型分布
                  </h3>
                  <div className="h-48 sm:h-64">
                    <Bar
                      data={eventTypeData}
                      options={{
                        responsive: true,
                        maintainAspectRatio: false,
                        plugins: {
                          legend: {
                            display: false
                          }
                        },
                        scales: {
                          y: {
                            beginAtZero: true
                          }
                        }
                      }}
                    />
                  </div>
                </div>
              </div>

              {/* 高风险设备列表 */}
              <div className="mt-6">
                <h3 className="text-lg font-semibold text-slate-900 mb-4 flex items-center gap-2">
                  <FaExclamationTriangle className="text-amber-600" /> 高风险设备 Top 10
                </h3>
                <div className={cn(studioSurfaceClassName)}>
                  <table className="min-w-full divide-y divide-slate-200">
                    <thead className="bg-slate-50/80">
                      <tr>
                        <th className="px-3 sm:px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">设备指纹</th>
                        <th className="px-3 sm:px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">风险评分</th>
                        <th className="px-3 sm:px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">风险等级</th>
                        <th className="px-3 sm:px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">状态</th>
                        <th className="px-3 sm:px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">最后活跃</th>
                      </tr>
                    </thead>
                    <tbody className="bg-white/80 backdrop-blur-xl divide-y divide-slate-200">
                      {stats?.topRiskyDevices && stats.topRiskyDevices.length > 0 ? (
                        stats.topRiskyDevices.map((device) => (
                          <tr key={device._id} className="hover:bg-slate-50/80 transition-colors">
                            <td className="px-3 sm:px-6 py-4 whitespace-nowrap text-sm font-mono text-slate-600">
                              {device.deviceFingerprint.substring(0, 12)}...
                            </td>
                            <td className="px-3 sm:px-6 py-4 whitespace-nowrap text-sm font-bold text-slate-900">
                              {device.riskScore}
                            </td>
                            <td className="px-3 sm:px-6 py-4 whitespace-nowrap">
                              {getRiskLevelBadge(device.riskLevel)}
                            </td>
                            <td className="px-3 sm:px-6 py-4 whitespace-nowrap">
                              {device.isCompromised ? (
                                <span className="px-2.5 py-1 rounded-full text-xs font-bold text-rose-700 bg-rose-100 border border-rose-200">
                                  已攻破
                                </span>
                              ) : (
                                <span className="px-2.5 py-1 rounded-full text-xs font-bold text-emerald-700 bg-emerald-100 border border-emerald-200">
                                  正常
                                </span>
                              )}
                            </td>
                            <td className="px-3 sm:px-6 py-4 whitespace-nowrap text-sm text-slate-500">
                              {new Date(device.lastSeen).toLocaleString('zh-CN')}
                            </td>
                          </tr>
                        ))
                      ) : (
                        <tr>
                          <td colSpan={5} className="px-3 py-6 sm:px-6">
                            <StudioEmptyState message="当前时间范围内没有高风险设备。切到「设备管理」可以查看全部设备的风险画像。" />
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* 设备管理标签页 */}
          {selectedTab === 'devices' && (
            <div className="p-4 sm:p-6">
              {/* 搜索和筛选（全部下推到服务端：搜全库、筛全库，而不只是当前这一页） */}
              <div className="mb-6 flex flex-col gap-3 lg:flex-row lg:items-center">
                <div className="relative flex-1">
                  <FaFilter className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 w-4 h-4" />
                  <input
                    type="text"
                    placeholder="搜索设备指纹、用户ID、IP（回车或点搜索）"
                    value={deviceSearchDraft}
                    onChange={(e) => setDeviceSearchDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        setDeviceQuery((current) => ({ ...current, search: deviceSearchDraft.trim(), page: 1 }));
                      }
                    }}
                    className={cn(studioFieldClassName, 'pl-10')}
                  />
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      setDeviceQuery((current) => ({ ...current, search: deviceSearchDraft.trim(), page: 1 }))
                    }
                    className={cn(studioSecondaryButtonClassName, 'min-h-11')}
                  >
                    搜索
                  </button>
                  <select
                    value={deviceQuery.riskLevel}
                    onChange={(e) => setDeviceQuery((current) => ({ ...current, riskLevel: e.target.value, page: 1 }))}
                    aria-label="按风险等级筛选"
                    className={cn(studioFieldClassName, 'font-medium sm:w-40')}
                  >
                    <option value="all">所有风险等级</option>
                    <option value="SAFE">安全</option>
                    <option value="LOW">低风险</option>
                    <option value="MEDIUM">中风险</option>
                    <option value="HIGH">高风险</option>
                    <option value="CRITICAL">极高风险</option>
                  </select>
                  <select
                    value={deviceQuery.status}
                    onChange={(e) => setDeviceQuery((current) => ({ ...current, status: e.target.value, page: 1 }))}
                    aria-label="按设备状态筛选"
                    className={cn(studioFieldClassName, 'font-medium sm:w-36')}
                  >
                    <option value="all">全部状态</option>
                    <option value="compromised">已攻破</option>
                    <option value="normal">正常</option>
                  </select>
                  <select
                    value={deviceQuery.limit}
                    onChange={(e) =>
                      setDeviceQuery((current) => ({ ...current, limit: Number(e.target.value), page: 1 }))
                    }
                    aria-label="每页条数"
                    className={cn(studioFieldClassName, 'font-medium sm:w-32')}
                  >
                    {PAGE_SIZE_OPTIONS.map((size) => (
                      <option key={size} value={size}>
                        每页 {size} 条
                      </option>
                    ))}
                  </select>
                  {hasActiveDeviceFilter ? (
                    <button
                      type="button"
                      onClick={() => {
                        setDeviceSearchDraft('');
                        setDeviceQuery((current) => ({
                          ...current,
                          search: '',
                          riskLevel: 'all',
                          status: 'all',
                          page: 1,
                        }));
                      }}
                      className={cn(studioSecondaryButtonClassName, 'min-h-11')}
                    >
                      清除筛选
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => void loadDevices()}
                    disabled={devicesLoading}
                    className={cn(studioSecondaryButtonClassName, 'min-h-11')}
                  >
                    {devicesLoading ? '刷新中…' : '刷新'}
                  </button>
                </div>
              </div>
              {devicesError ? <StudioErrorNote className="mb-4 text-xs">{devicesError}</StudioErrorNote> : null}

              {/* 设备列表 */}
              <div className={cn(studioSurfaceClassName)}>
                <div className="overflow-x-auto">
                  <table className="min-w-full divide-y divide-slate-200">
                    <thead className="bg-slate-50/80">
                      <tr>
                        <th className="px-3 sm:px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">设备指纹</th>
                        <th className="px-3 sm:px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">用户ID</th>
                        <th className="px-3 sm:px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">风险状态</th>
                        <th className="px-3 sm:px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">环境特征</th>
                        <th className="px-3 sm:px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">请求数</th>
                        <th className="px-3 sm:px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">活跃时间</th>
                      </tr>
                    </thead>
                    <tbody className="bg-white/80 backdrop-blur-xl divide-y divide-slate-200">
                      {devices.length > 0 ? (
                        devices.map((device) => (
                          <tr key={device._id} className="hover:bg-slate-50/80 transition-colors">
                            <td className="px-3 sm:px-6 py-4 whitespace-nowrap text-sm font-mono text-slate-600">
                              {device.deviceFingerprint.substring(0, 12)}...
                            </td>
                            <td className="px-3 sm:px-6 py-4 whitespace-nowrap text-sm text-slate-600">
                              {device.userId || '游客'}
                            </td>
                            <td className="px-3 sm:px-6 py-4 whitespace-nowrap">
                              <div className="flex flex-col gap-1">
                                <div className="flex items-center gap-2">
                                  <span className="text-sm font-bold text-slate-900">{device.riskScore}</span>
                                  {getRiskLevelBadge(device.riskLevel)}
                                </div>
                              </div>
                            </td>
                            <td className="px-3 sm:px-6 py-4 whitespace-nowrap">
                              <div className="flex gap-1.5 flex-wrap max-w-xs">
                                {device.isRoot && (
                                  <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-rose-100 text-rose-700 border border-rose-200">ROOT</span>
                                )}
                                {device.isDebugger && (
                                  <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-100 text-amber-700 border border-amber-200">DEBUG</span>
                                )}
                                {device.isEmulator && (
                                  <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-100 text-slate-700 border border-slate-200">模拟器</span>
                                )}
                                {device.isVpn && (
                                  <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-100 text-sky-700 border border-sky-200">VPN</span>
                                )}
                                {!device.signatureValid && (
                                  <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-rose-100 text-rose-700 border border-rose-200">签名错</span>
                                )}
                              </div>
                            </td>
                            <td className="px-3 sm:px-6 py-4 whitespace-nowrap text-sm text-slate-900">
                              {device.requestCount}
                            </td>
                            <td className="px-3 sm:px-6 py-4 whitespace-nowrap text-sm text-slate-500">
                              {new Date(device.lastSeen).toLocaleString('zh-CN')}
                            </td>
                          </tr>
                        ))
                      ) : (
                        <tr>
                          <td colSpan={6} className="px-3 py-6 sm:px-6">
                            <StudioEmptyState
                              message={
                                hasActiveDeviceFilter
                                  ? '当前筛选条件下没有匹配的设备。清空搜索与筛选可以看回全部设备。'
                                  : '库里还没有任何设备上报。设备接入后会自动出现在这里。'
                              }
                              action={
                                <button
                                  type="button"
                                  onClick={() => {
                                    setDeviceSearchDraft('');
                                    setDeviceQuery((current) => ({
                                      ...current,
                                      search: '',
                                      riskLevel: 'all',
                                      status: 'all',
                                      page: 1,
                                    }));
                                  }}
                                  className={cn(studioSecondaryButtonClassName, 'min-h-11')}
                                >
                                  清空筛选
                                </button>
                              }
                            />
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
                <ListPager
                  pagination={devicesPagination}
                  loading={devicesLoading}
                  onChange={(page) => setDeviceQuery((current) => ({ ...current, page }))}
                />
              </div>
            </div>
          )}

          {/* 安全事件标签页 */}
          {selectedTab === 'events' && (
            <div className="p-4 sm:p-6">
              {/* 事件筛选（服务端）：默认不限时间窗，库里有多少事件就能翻到多少 */}
              <div className="mb-6 flex flex-col gap-3 lg:flex-row lg:items-center">
                <div className="relative flex-1">
                  <FaFilter className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 w-4 h-4" />
                  <input
                    type="text"
                    placeholder="搜索设备指纹、用户ID、IP、事件类型（回车或点搜索）"
                    value={eventSearchDraft}
                    onChange={(e) => setEventSearchDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        setEventQuery((current) => ({ ...current, search: eventSearchDraft.trim(), page: 1 }));
                      }
                    }}
                    className={cn(studioFieldClassName, 'pl-10')}
                  />
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      setEventQuery((current) => ({ ...current, search: eventSearchDraft.trim(), page: 1 }))
                    }
                    className={cn(studioSecondaryButtonClassName, 'min-h-11')}
                  >
                    搜索
                  </button>
                  <select
                    value={eventQuery.eventType}
                    onChange={(e) => setEventQuery((current) => ({ ...current, eventType: e.target.value, page: 1 }))}
                    aria-label="按事件类型筛选"
                    className={cn(studioFieldClassName, 'font-medium sm:w-44')}
                  >
                    <option value="all">全部事件类型</option>
                    {EVENT_TYPE_OPTIONS.map((type) => (
                      <option key={type} value={type}>
                        {getEventTypeLabel(type)}
                      </option>
                    ))}
                  </select>
                  <select
                    value={eventQuery.timeRange}
                    onChange={(e) => setEventQuery((current) => ({ ...current, timeRange: e.target.value, page: 1 }))}
                    aria-label="按时间范围筛选"
                    className={cn(studioFieldClassName, 'font-medium sm:w-36')}
                  >
                    <option value="all">全部时间</option>
                    <option value="1h">最近1小时</option>
                    <option value="24h">最近24小时</option>
                    <option value="7d">最近7天</option>
                    <option value="30d">最近30天</option>
                  </select>
                  <select
                    value={eventQuery.limit}
                    onChange={(e) =>
                      setEventQuery((current) => ({ ...current, limit: Number(e.target.value), page: 1 }))
                    }
                    aria-label="每页条数"
                    className={cn(studioFieldClassName, 'font-medium sm:w-32')}
                  >
                    {PAGE_SIZE_OPTIONS.map((size) => (
                      <option key={size} value={size}>
                        每页 {size} 条
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => void loadEvents()}
                    disabled={eventsLoading}
                    className={cn(studioSecondaryButtonClassName, 'min-h-11')}
                  >
                    {eventsLoading ? '刷新中…' : '刷新'}
                  </button>
                </div>
              </div>
              {eventsError ? <StudioErrorNote className="mb-4 text-xs">{eventsError}</StudioErrorNote> : null}
              <div className="mb-3 text-xs text-slate-500">
                {eventsPagination.total > 0
                  ? `共 ${eventsPagination.total} 条事件`
                  : eventsLoading
                    ? '正在读取事件…'
                    : '没有事件'}
              </div>
              <div className="space-y-3">
                {events.length > 0 ? (
                  events.map((event) => {
                    const getSeverityColor = (riskScore?: number) => {
                      if (!riskScore) return 'bg-slate-100 text-slate-700 border-slate-200';
                      if (riskScore >= 80) return 'bg-rose-50 text-rose-700 border-rose-200';
                      if (riskScore >= 50) return 'bg-amber-50 text-amber-700 border-amber-200';
                      if (riskScore >= 30) return 'bg-sky-50 text-sky-700 border-sky-200';
                      return 'bg-slate-50/80 text-slate-700 border-slate-200';
                    };

                    const getTimeAgo = (dateString: string) => {
                      const now = new Date();
                      const eventTime = new Date(dateString);
                      const diffMs = now.getTime() - eventTime.getTime();
                      const diffMins = Math.floor(diffMs / 60000);

                      if (diffMins < 1) return '刚刚';
                      if (diffMins < 60) return `${diffMins} 分钟前`;
                      const diffHours = Math.floor(diffMins / 60);
                      if (diffHours < 24) return `${diffHours} 小时前`;
                      const diffDays = Math.floor(diffHours / 24);
                      return `${diffDays} 天前`;
                    };

                    return (
                      <div key={event._id} className={`bg-white/80 backdrop-blur-xl rounded-2xl p-4 border transition-all hover:shadow-md ${getSeverityColor(event.riskScore)}`}>
                        <div className="flex items-start justify-between">
                          <div className="flex-1">
                            <div className="flex items-center gap-3 mb-2">
                              <span className="px-2.5 py-0.5 rounded-full text-xs font-bold uppercase tracking-wider">
                                {getEventTypeLabel(event.eventType)}
                              </span>
                              <span className="text-xs font-medium opacity-60 flex items-center gap-1">
                                <FaClock className="w-3 h-3" /> {getTimeAgo(event.createdAt)}
                              </span>
                            </div>
                            <div className="flex items-center gap-2">
                              <FaExclamationCircle className="w-4 h-4 opacity-50" />
                              <p className="text-sm font-medium">
                                设备 <span className="font-mono font-bold">{event.deviceFingerprint.substring(0, 12)}...</span> 触发异常
                              </p>
                            </div>
                            <div className="mt-2 grid grid-cols-2 sm:grid-cols-3 gap-y-1 gap-x-4 opacity-75">
                              {event.userId && (
                                <p className="text-[11px] flex items-center gap-1"><FaUsers className="w-2.5 h-2.5" /> {event.userId}</p>
                              )}
                              {event.ipAddress && (
                                <p className="text-[11px] flex items-center gap-1"><FaGlobe className="inline" aria-hidden /> {event.ipAddress}</p>
                              )}
                              <p className="text-[11px] flex items-center gap-1"><FaShieldAlt className="w-2.5 h-2.5" /> 风险值: {event.riskScore || 'N/A'}</p>
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })
                ) : (
                  <StudioEmptyState
                    message="当前时间范围内没有安全事件记录，说明没有设备触发风控规则。"
                    action={
                      <button
                        type="button"
                        onClick={() => setSelectedTab('devices')}
                        className={cn(studioSecondaryButtonClassName, 'min-h-11')}
                      >
                        查看设备风险画像
                      </button>
                    }
                  />
                )}
              </div>
              <ListPager
                pagination={eventsPagination}
                loading={eventsLoading}
                onChange={(page) => setEventQuery((current) => ({ ...current, page }))}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default NexAISecurityDashboard;
