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
  isAdbEnabled?: boolean;
  isDevelopmentSettingsEnabled?: boolean;
  isDebugBuild?: boolean;
  isTracerAttached?: boolean;
  antiDebugScore?: number;
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
  /** 反调试命中（tracer / debugger / ADB / 调试包 / 反调试分 ≥0.5）的设备数。 */
  antiDebugDevices?: number;
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

/**
 * 面板涉及的「代号 → 中文」全部由后端 `/api/nexai/security/catalog` 下发
 * （`services/nexaiSecurityCatalog.ts` 是唯一事实源）。这里只保留两样东西：
 * 1. 首帧兜底表 —— 目录还没回来时不至于把 `root_detected` 铺到界面上；
 * 2. 目录类型定义。
 *
 * 原则：主界面只显示中文名；原始代号（`SUPERADMIN_RISK_EXEMPT` 这类）只出现在
 * 「详情」展开区，供排查时核对与搜索。
 */

interface CatalogOption {
  value: string;
  label: string;
}

interface SecurityCatalogEntry extends CatalogOption {
  group: string;
  groupLabel: string;
  source: 'client' | 'server';
}

interface SecurityCatalog {
  eventTypes: SecurityCatalogEntry[];
  eventGroups: CatalogOption[];
  riskLevels: CatalogOption[];
  riskTiers: CatalogOption[];
  riskFlags: CatalogOption[];
  riskActions: CatalogOption[];
  exemptionScopes: CatalogOption[];
  deviceFlags: CatalogOption[];
  strategies: CatalogOption[];
  automationSignals: CatalogOption[];
  eventDataLabels: Record<string, string>;
  eventDataOrder: string[];
}

const FALLBACK_RISK_LEVEL_LABELS: Record<string, string> = {
  SAFE: '安全',
  LOW: '低风险',
  MEDIUM: '中风险',
  HIGH: '高风险',
  CRITICAL: '极高风险',
};

/** 只兜底客户端上报的 14 个类型（其余靠目录；目录缺失时显示「未登记事件类型」）。 */
const FALLBACK_EVENT_TYPE_LABELS: Record<string, string> = {
  integrity_fail: '完整性校验失败',
  root_detected: '检测到 Root',
  debugger_detected: '检测到调试器',
  emulator_detected: '检测到模拟器',
  vpn_detected: '检测到 VPN / 代理',
  hook_detected: '检测到 Hook 框架',
  tamper_detected: '客户端被篡改',
  anti_debug: '反调试命中',
  frida_detected: '检测到 Frida',
  xposed_detected: '检测到 Xposed',
  login_anomaly: '登录行为异常',
  device_switch: '设备切换',
  heartbeat: '心跳上报',
  custom: '自定义事件',
};

const UNKNOWN_EVENT_LABEL = '未登记事件类型';

/** 事件类型下拉的兜底项：目录未就绪时至少能筛客户端上报的类型。 */
const FALLBACK_EVENT_TYPE_OPTIONS: CatalogOption[] = Object.entries(FALLBACK_EVENT_TYPE_LABELS).map(
  ([value, label]) => ({ value, label }),
);

const DEVICE_FLAG_LABELS_FALLBACK: Record<string, string> = {
  isRoot: 'Root 权限',
  isDebugger: '调试器',
  isEmulator: '模拟器',
  isVpn: 'VPN / 代理',
  isAdbEnabled: 'ADB 调试',
  isDevelopmentSettingsEnabled: '开发者选项',
  isDebugBuild: '调试包',
  isTracerAttached: '调试器附着',
};

/** 事件详情里的风险档位（`eventData.fromTier` / `toTier`）。 */
const FALLBACK_TIER_LABELS: Record<string, string> = {
  normal: '正常',
  watch: '观察',
  restricted: '受限',
  danger: '高危',
};

const labelFromOptions = (options: CatalogOption[] | undefined, value: string): string | undefined =>
  options?.find((option) => option.value === value)?.label;

/** 服务端内部事件用固定标识占位 deviceFingerprint（不是真实设备），界面上要换个说法。 */
const PSEUDO_FINGERPRINTS = new Set([
  'risk-exemption',
  'account-risk',
  'account-abuse',
  'device-fingerprint',
  'automation-trace',
]);

const isPseudoFingerprint = (value?: string): boolean => Boolean(value && PSEUDO_FINGERPRINTS.has(value));

const EVENT_SOURCE_LABELS: Record<string, string> = {
  action: '人工处置',
  auto: '自动升档',
  device_fingerprint: '设备指纹上报',
};

/**
 * 事件 `eventData` 的某个字段 → 展示文本。
 *
 * 数组按「命中判据 / 自动化信号」分别翻中文，其它数组原样顿号连接；
 * 代号型字段（档位、处置动作、豁免范围）走服务端字典，查不到才显示原值。
 */
function formatEventValue(key: string, value: unknown, catalog: SecurityCatalog | null): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        const text = String(item);
        if (key === 'flags') return labelFromOptions(catalog?.riskFlags, text) || text;
        if (key === 'signals') return labelFromOptions(catalog?.automationSignals, text) || text;
        return text;
      })
      .join('、');
  }
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  const text = String(value);
  if (key === 'fromTier' || key === 'toTier') {
    return labelFromOptions(catalog?.riskTiers, text) || FALLBACK_TIER_LABELS[text] || text;
  }
  if (key === 'action') return labelFromOptions(catalog?.riskActions, text) || text;
  if (key === 'scope') return labelFromOptions(catalog?.exemptionScopes, text) || text;
  if (key === 'source') return EVENT_SOURCE_LABELS[text] || text;
  return text;
}

/** 事件详情：字段名与取值都翻中文；原始代号只在最下面一行出现。 */
const SecurityEventDetail: React.FC<{ event: SecurityEvent; catalog: SecurityCatalog | null }> = ({
  event,
  catalog,
}) => {
  const data =
    event.eventData && typeof event.eventData === 'object' && !Array.isArray(event.eventData)
      ? (event.eventData as Record<string, unknown>)
      : {};
  const preferredOrder = catalog?.eventDataOrder?.length ? catalog.eventDataOrder : [];
  const keys = [
    ...preferredOrder.filter((key) => key in data),
    ...Object.keys(data).filter((key) => !preferredOrder.includes(key)),
  ];

  return (
    <div className="min-w-0">
      {keys.length === 0 ? (
        <p className="text-xs text-slate-500">该事件没有附加数据。</p>
      ) : (
        <dl className="grid gap-x-4 gap-y-2 text-xs sm:grid-cols-2 xl:grid-cols-3">
          {keys.map((key) => (
            <div key={key} className="min-w-0">
              <dt className="text-slate-500">{catalog?.eventDataLabels?.[key] || key}</dt>
              <dd className="break-all text-slate-700">{formatEventValue(key, data[key], catalog)}</dd>
            </div>
          ))}
        </dl>
      )}
      <p className="mt-3 text-[11px] text-slate-400">
        事件代号 <span className="font-mono text-slate-500">{event.eventType}</span>
        <span className="mx-1">·</span>
        记录 ID <span className="font-mono text-slate-500">{event._id}</span>
      </p>
    </div>
  );
};

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

/** 设备环境特征徽标。颜色只表达「多危险」，文字才是判据本身。 */
const DeviceFlagBadge: React.FC<{ tone: 'rose' | 'amber' | 'sky' | 'slate'; label: string }> = ({ tone, label }) => {
  const toneClass =
    tone === 'rose'
      ? 'bg-rose-100 text-rose-700 border-rose-200'
      : tone === 'amber'
        ? 'bg-amber-100 text-amber-700 border-amber-200'
        : tone === 'sky'
          ? 'bg-sky-50 text-sky-700 border-sky-200'
          : 'bg-slate-100 text-slate-700 border-slate-200';
  return (
    <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold ${toneClass}`}>{label}</span>
  );
};

const NexAISecurityDashboard: React.FC = () => {
  const { setNotification } = useNotification();
  const statsRequestRef = useRef(0);
  const devicesRequestRef = useRef(0);
  const eventsRequestRef = useRef(0);

  const [stats, setStats] = useState<DashboardStats | null>(null);
  // 代号字典（事件类型/风险等级/判据/豁免范围的中文名）由服务端下发，见 loadCatalog。
  const [catalog, setCatalog] = useState<SecurityCatalog | null>(null);
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
  /** 展开中的事件（详情里才出现原始代号与 eventData）。 */
  const [expandedEventId, setExpandedEventId] = useState<string | null>(null);
  const [eventSearchDraft, setEventSearchDraft] = useState('');
  const [eventQuery, setEventQuery] = useState({
    search: '',
    eventType: 'all',
    timeRange: 'all',
    page: 1,
    limit: 20,
  });

  /**
   * 取代号字典。失败不阻塞页面：本地兜底表仍能把最常见的类型显示成中文，
   * 其余显示「未登记事件类型」而不是把大写代号铺出去。
   */
  const loadCatalog = async () => {
    try {
      const res = await api.get('/api/nexai/security/catalog');
      if (res.data?.success !== false) {
        setCatalog(res.data as SecurityCatalog);
      }
    } catch (error) {
      console.warn('Failed to fetch security catalog:', error);
    }
  };

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
    void loadCatalog();
  }, []);

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

  /** 事件类型 → 中文。主界面绝不显示原始代号；代号只在详情里出现。 */
  const eventTypeLabel = (type: string): string =>
    labelFromOptions(catalog?.eventTypes, type) || FALLBACK_EVENT_TYPE_LABELS[type] || UNKNOWN_EVENT_LABEL;

  const riskLevelLabel = (level: string): string =>
    labelFromOptions(catalog?.riskLevels, level) || FALLBACK_RISK_LEVEL_LABELS[level] || level;

  const deviceFlagLabel = (key: string): string =>
    labelFromOptions(catalog?.deviceFlags, key) || DEVICE_FLAG_LABELS_FALLBACK[key] || key;

  /** 事件类型下拉：按目录分组（客户端检测 / 账户风控 / 会话 / 系统 / 指纹）。 */
  const eventTypeGroups = useMemo(() => {
    if (catalog?.eventTypes?.length) {
      const order = (catalog.eventGroups || []).map((group) => group.value);
      const groups = new Map<string, { value: string; label: string; options: CatalogOption[] }>();
      for (const entry of catalog.eventTypes) {
        const key = entry.group || 'other';
        if (!groups.has(key)) {
          groups.set(key, { value: key, label: entry.groupLabel || '其他', options: [] });
        }
        groups.get(key)!.options.push({ value: entry.value, label: entry.label });
      }
      return [
        ...order.map((key) => groups.get(key)).filter((group): group is { value: string; label: string; options: CatalogOption[] } => Boolean(group)),
        ...Array.from(groups.values()).filter((group) => !order.includes(group.value)),
      ];
    }
    return [{ value: 'client', label: '客户端设备检测', options: FALLBACK_EVENT_TYPE_OPTIONS }];
  }, [catalog]);

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
        {riskLevelLabel(level)}
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
    labels: stats ? Object.keys(stats.eventTypeDistribution).map(eventTypeLabel) : [],
    datasets: [{
      label: '事件数量',
      data: stats ? Object.values(stats.eventTypeDistribution) : [],
      backgroundColor: 'rgba(14, 165, 233, 0.8)',
      borderColor: 'rgb(14, 165, 233)',
      borderWidth: 1
    }]
    // eventTypeLabel 依赖 catalog；把 catalog 列进依赖，字典到达后图表标签才会刷新。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [stats, catalog]);

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
        <div className="grid grid-cols-1 gap-6 mb-8 md:grid-cols-2 xl:grid-cols-5">
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
                <p className="text-sm font-medium text-slate-600">反调试命中</p>
                <p className="text-3xl font-bold text-amber-600 mt-2">{stats?.antiDebugDevices || 0}</p>
              </div>
              <FaShieldAlt className="w-10 h-10 text-amber-600 opacity-80" />
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
                                  <DeviceFlagBadge tone="rose" label={deviceFlagLabel('isRoot')} />
                                )}
                                {device.isDebugger && (
                                  <DeviceFlagBadge tone="amber" label={deviceFlagLabel('isDebugger')} />
                                )}
                                {device.isEmulator && (
                                  <DeviceFlagBadge tone="slate" label={deviceFlagLabel('isEmulator')} />
                                )}
                                {device.isVpn && (
                                  <DeviceFlagBadge tone="sky" label={deviceFlagLabel('isVpn')} />
                                )}
                                {device.isAdbEnabled && (
                                  <DeviceFlagBadge tone="amber" label={deviceFlagLabel('isAdbEnabled')} />
                                )}
                                {device.isDevelopmentSettingsEnabled && (
                                  <DeviceFlagBadge tone="amber" label={deviceFlagLabel('isDevelopmentSettingsEnabled')} />
                                )}
                                {device.isDebugBuild && (
                                  <DeviceFlagBadge tone="amber" label={deviceFlagLabel('isDebugBuild')} />
                                )}
                                {device.isTracerAttached && (
                                  <DeviceFlagBadge tone="rose" label={deviceFlagLabel('isTracerAttached')} />
                                )}
                                {!device.signatureValid && (
                                  <DeviceFlagBadge tone="rose" label="签名校验失败" />
                                )}
                                {device.hashValid === false && (
                                  <DeviceFlagBadge tone="rose" label="完整性校验失败" />
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
                    {eventTypeGroups.map((group) => (
                      <optgroup key={group.value} label={group.label}>
                        {group.options.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </optgroup>
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
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
                <span>
                  {eventsPagination.total > 0
                    ? `共 ${eventsPagination.total} 条事件`
                    : eventsLoading
                      ? '正在读取事件…'
                      : '没有事件'}
                </span>
                {eventsPagination.total > 0 ? <span className="text-slate-400">点任意一条展开判定依据与原始数据</span> : null}
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

                    const expanded = expandedEventId === event._id;
                    const pseudo = isPseudoFingerprint(event.deviceFingerprint);

                    return (
                      <div key={event._id} className={`bg-white/80 backdrop-blur-xl rounded-2xl border transition-all hover:shadow-md ${getSeverityColor(event.riskScore)}`}>
                        <button
                          type="button"
                          onClick={() => setExpandedEventId(expanded ? null : event._id)}
                          aria-expanded={expanded}
                          className="w-full p-4 text-left"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0 flex-1">
                              <div className="mb-2 flex flex-wrap items-center gap-3">
                                <span className="rounded-full px-2.5 py-0.5 text-xs font-bold tracking-wide">
                                  {eventTypeLabel(event.eventType)}
                                </span>
                                <span className="flex items-center gap-1 text-xs font-medium opacity-60">
                                  <FaClock className="h-3 w-3" aria-hidden /> {getTimeAgo(event.createdAt)}
                                </span>
                              </div>
                              <div className="flex items-center gap-2">
                                <FaExclamationCircle className="h-4 w-4 shrink-0 opacity-50" aria-hidden />
                                <p className="min-w-0 truncate text-sm font-medium">
                                  {pseudo ? '系统内部记录' : '设备'}{' '}
                                  <span className="font-mono font-bold">
                                    {pseudo ? event.deviceFingerprint : `${event.deviceFingerprint.substring(0, 12)}...`}
                                  </span>
                                </p>
                              </div>
                              <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 opacity-75 sm:grid-cols-3">
                                {event.userId ? (
                                  <p className="flex items-center gap-1 text-[11px]"><FaUsers className="h-2.5 w-2.5" aria-hidden /> {event.userId}</p>
                                ) : null}
                                {event.ipAddress ? (
                                  <p className="flex items-center gap-1 text-[11px]"><FaGlobe className="inline" aria-hidden /> {event.ipAddress}</p>
                                ) : null}
                                <p className="flex items-center gap-1 text-[11px]">
                                  <FaShieldAlt className="h-2.5 w-2.5" aria-hidden /> 风险分：{typeof event.riskScore === 'number' ? event.riskScore : '未评分'}
                                </p>
                              </div>
                            </div>
                            <span className="shrink-0 text-[11px] font-medium text-slate-500">
                              {expanded ? '收起详情' : '展开详情'}
                            </span>
                          </div>
                        </button>
                        {expanded ? (
                          <div className="border-t border-slate-200/70 px-4 pb-4 pt-3">
                            <SecurityEventDetail event={event} catalog={catalog} />
                          </div>
                        ) : null}
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
