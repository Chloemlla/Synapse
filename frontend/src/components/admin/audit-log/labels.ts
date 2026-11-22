import type { AuditLogMeta, AuditLogModuleMeta } from '@/api/auditLog';

/**
 * 审计日志的展示层字典。
 *
 * 中文名的唯一来源是后端 `services/auditLogCatalog.ts`（经 `/meta` 下发）。这里保留一份
 * **兜底表**，只为了两件事：接口还没回来时下拉框不闪成空白；后端尚未升级时也认识
 * 最常用的模块。兜底表不需要穷举 —— 真值是后端目录。
 */

const FALLBACK_MODULE_LABELS: Record<string, string> = {
  admin: '管理后台',
  announcement: '公告',
  api: '开放接口',
  auth: '登录认证',
  cdk: 'CDK 卡密',
  config: '运行时配置',
  debug: '调试工具',
  email: '邮件系统',
  env: '环境变量',
  geogebra: 'GeoGebra 工作台',
  ipban: 'IP 封禁',
  ipfs: 'IPFS 存储',
  life: '生活服务',
  lottery: '抽奖',
  'lumen-config': 'Lumen 客户端配置',
  media: '媒体工具',
  modlist: '模组列表',
  network: '网络与 IP',
  oauth: '第三方登录',
  other: '其他',
  policy: '政策条款',
  privacy: '隐私与取证',
  recommendation: '推荐位',
  resource: '资源商店',
  security: '安全风控',
  shorturl: '短链接',
  social: '社交互动',
  system: '系统维护',
  tts: '语音合成',
  user: '用户管理',
  workspace: '工作区',
};

const FALLBACK_ROLE_LABELS: Record<string, string> = {
  superadmin: '超级管理员',
  admin: '管理员',
  user: '普通用户',
  anonymous: '匿名访客',
  unknown: '未识别',
};

const FALLBACK_RESULT_LABELS: Record<string, string> = {
  success: '成功',
  failure: '失败',
};

/** 后端目录优先、兜底表次之、最后显示原值（不隐藏无法识别的值，避免误导）。 */
export function moduleLabel(value: string, meta?: AuditLogMeta | null): string {
  if (!value) return '';
  const fromMeta = meta?.moduleCatalog?.find((item) => item.value === value);
  return fromMeta?.label || FALLBACK_MODULE_LABELS[value] || value;
}

export function roleLabel(value: string, meta?: AuditLogMeta | null): string {
  if (!value) return '';
  const fromMeta = meta?.roles?.find((item) => item.value === value);
  return fromMeta?.label || FALLBACK_ROLE_LABELS[value] || value;
}

export function resultLabel(value: string, meta?: AuditLogMeta | null): string {
  if (!value) return '';
  return meta?.resultLabels?.[value] || FALLBACK_RESULT_LABELS[value] || value;
}

export interface ModuleOption {
  value: string;
  label: string;
  hint?: string;
}

export interface ModuleOptionGroup {
  value: string;
  label: string;
  options: ModuleOption[];
}

/**
 * 把模块目录折成「全选 + 分组」的结构。
 *
 * 没登记进分组的模块（旧后端、未来新增但目录未更新）落到「其他模块」，
 * 绝不直接从下拉框里消失 —— 那就是「筛不到自己刚写出来的记录」。
 */
export function buildModuleOptionGroups(meta?: AuditLogMeta | null): ModuleOptionGroup[] {
  const catalog: AuditLogModuleMeta[] | undefined = meta?.moduleCatalog?.length
    ? meta.moduleCatalog
    : undefined;

  if (!catalog) {
    return [
      {
        value: 'fallback',
        label: '模块',
        options: Object.keys(FALLBACK_MODULE_LABELS)
          .sort((a, b) => FALLBACK_MODULE_LABELS[a].localeCompare(FALLBACK_MODULE_LABELS[b], 'zh-CN'))
          .map((value) => ({ value, label: FALLBACK_MODULE_LABELS[value] })),
      },
    ];
  }

  const groupOrder = (meta?.moduleGroups || []).map((item) => item.value);
  const groups = new Map<string, ModuleOptionGroup>();
  const fallbackGroup: ModuleOptionGroup = { value: 'ungrouped', label: '其他模块', options: [] };

  for (const item of catalog) {
    const groupValue = item.group || 'ungrouped';
    const groupLabel = item.groupLabel || meta?.moduleGroups?.find((group) => group.value === groupValue)?.label || '其他模块';
    if (!groups.has(groupValue)) {
      groups.set(groupValue, { value: groupValue, label: groupLabel, options: [] });
    }
    groups.get(groupValue)!.options.push({ value: item.value, label: item.label, hint: item.hint });
  }

  const ordered = [
    ...groupOrder.map((value) => groups.get(value)).filter((group): group is ModuleOptionGroup => Boolean(group)),
    ...Array.from(groups.values()).filter((group) => !groupOrder.includes(group.value) && group.value !== 'ungrouped'),
  ];

  const ungrouped = groups.get('ungrouped');
  if (ungrouped) fallbackGroup.options.push(...ungrouped.options);
  if (fallbackGroup.options.length > 0) ordered.push(fallbackGroup);

  return ordered;
}

/** 本地日期（`YYYY-MM-DD`），与 `<input type="date">` 同格式。 */
export function localDateStamp(date: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 快捷时间窗。「今天」= 本地自然日；其余按「现在往前推」计算。 */
export type QuickTimeRange = 'today' | '1h' | '24h' | '7d' | '30d';

export const QUICK_TIME_RANGES: ReadonlyArray<{ value: QuickTimeRange; label: string }> = [
  { value: 'today', label: '今天' },
  { value: '1h', label: '近 1 小时' },
  { value: '24h', label: '近 24 小时' },
  { value: '7d', label: '近 7 天' },
  { value: '30d', label: '近 30 天' },
];

/**
 * 快捷时间窗 → `startDate` / `endDate`。
 *
 * 用本地日期而不是 UTC：后端把 `YYYY-MM-DD` 当成 UTC 日界解析，而值班看到的是本地时间。
 * 所以「近 1 小时/近 24 小时」这类相对窗口改用**完整 ISO 时间戳**（含时区），
 * 只有「今天」用日期串（本地自然日）。
 */
export function quickTimeRangeBounds(range: QuickTimeRange, now: Date = new Date()): { startDate: string; endDate: string } {
  if (range === 'today') {
    return { startDate: localDateStamp(now), endDate: localDateStamp(now) };
  }
  const windowMs: Record<Exclude<QuickTimeRange, 'today'>, number> = {
    '1h': 60 * 60 * 1000,
    '24h': 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
    '30d': 30 * 24 * 60 * 60 * 1000,
  };
  const start = new Date(now.getTime() - windowMs[range]);
  return { startDate: start.toISOString(), endDate: now.toISOString() };
}

/** 判断当前筛选是否正好等于某个快捷时间窗（用于高亮按钮）。 */
export function matchesQuickTimeRange(
  filters: { startDate?: string; endDate?: string },
  range: QuickTimeRange,
  now: Date = new Date(),
): boolean {
  const bounds = quickTimeRangeBounds(range, now);
  return filters.startDate === bounds.startDate && filters.endDate === bounds.endDate;
}

export function resultTone(result: string): string {
  return result === 'success' ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-600';
}

export function statusTone(statusCode: number | string): string {
  const code = Number(statusCode);
  if (code >= 500) return 'bg-rose-50 text-rose-600';
  if (code >= 400) return 'bg-amber-50 text-amber-700';
  if (code >= 300) return 'bg-sky-50 text-sky-700';
  return 'bg-emerald-50 text-emerald-700';
}

/** 角色徽标的底色：超管最重，普通用户最轻。 */
export function roleTone(role: string): string {
  if (role === 'superadmin') return 'bg-slate-900 text-white';
  if (role === 'admin') return 'bg-slate-200 text-slate-800';
  if (role === 'user') return 'bg-slate-100 text-slate-600';
  return 'bg-slate-50 text-slate-500';
}
