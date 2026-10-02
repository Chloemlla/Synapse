import type { AuditLogQuery } from '../api/auditLog';

/**
 * 审计日志的筛选预设。
 *
 * 为什么要有它：`AuditLogViewer` 有 18 个筛选维度，但每次进页面都从空白开始。
 * 值班复盘几乎总是重复同样几组条件（今天的失败、今天的写操作、慢请求……），
 * 手工重填既慢又容易漏项。预置几条常用的 + 允许把当前筛选存成自己的预设。
 *
 * 存储：localStorage（只存筛选条件，不含任何日志内容/凭据）。读回来时逐字段白名单化，
 * 避免历史脏数据（或手工改过的 localStorage）把任意键塞进查询串。
 */

export interface AuditLogPreset {
  id: string;
  name: string;
  query: AuditLogQuery;
  /** 内置预设不可删除。 */
  builtIn?: boolean;
}

export const AUDIT_LOG_PRESET_STORAGE_KEY = 'synapse.admin.audit-log.presets.v1';

export const MAX_CUSTOM_AUDIT_LOG_PRESETS = 12;
const MAX_PRESET_NAME_LENGTH = 24;

/** 本地日期（`YYYY-MM-DD`）——与页面里 `type="date"` 的输入同格式。 */
export function localDateStamp(date: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function builtInAuditLogPresets(now: Date = new Date()): AuditLogPreset[] {
  const today = localDateStamp(now);
  return [
    { id: 'builtin:today-failure', name: '今日失败', builtIn: true, query: { result: 'failure', startDate: today } },
    { id: 'builtin:today-write', name: '今日写操作', builtIn: true, query: { method: 'POST', startDate: today } },
    { id: 'builtin:slow', name: '慢请求 ≥1s', builtIn: true, query: { minDurationMs: 1000 } },
    { id: 'builtin:today-admin', name: '今日管理后台', builtIn: true, query: { module: 'admin', startDate: today } },
  ];
}

/**
 * 只保留白名单字段，并丢掉空值。
 *
 * 这里把白名单写成显式对象字面量（而不是循环 + 索引赋值）：非引字段会被 tsc 直接拦住，
 * 且不需要用类型断言绕过 Record 与 interface 的不可比性。
 */
export function sanitizePresetQuery(raw: unknown): AuditLogQuery {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const source = raw as Record<string, unknown>;
  const text = (key: string): string => {
    const value = source[key];
    if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
    return '';
  };

  const query: AuditLogQuery = {
    module: text('module'),
    result: text('result'),
    keyword: text('keyword'),
    requestId: text('requestId'),
    action: text('action'),
    userId: text('userId'),
    username: text('username'),
    role: text('role'),
    method: text('method'),
    path: text('path'),
    ip: text('ip'),
    targetId: text('targetId'),
    targetName: text('targetName'),
    statusCode: text('statusCode'),
    minDurationMs: text('minDurationMs'),
    maxDurationMs: text('maxDurationMs'),
    startDate: text('startDate'),
    endDate: text('endDate'),
  };

  // 丢掉空字符串，让 `Object.keys(query).length > 0` 能当「这条预设真的有用」的判据。
  for (const key of Object.keys(query) as (keyof AuditLogQuery)[]) {
    if (query[key] === '') delete query[key];
  }
  return query;
}

function sanitizePreset(raw: unknown): AuditLogPreset | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const candidate = raw as Record<string, unknown>;
  const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
  const name = typeof candidate.name === 'string' ? candidate.name.trim().slice(0, MAX_PRESET_NAME_LENGTH) : '';
  if (!id || !name) return null;
  const query = sanitizePresetQuery(candidate.query);
  if (Object.keys(query).length === 0) return null;
  return { id, name, query };
}

export function readCustomAuditLogPresets(): AuditLogPreset[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(AUDIT_LOG_PRESET_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const result: AuditLogPreset[] = [];
    for (const item of parsed) {
      const preset = sanitizePreset(item);
      if (!preset || seen.has(preset.id)) continue;
      seen.add(preset.id);
      result.push(preset);
      if (result.length >= MAX_CUSTOM_AUDIT_LOG_PRESETS) break;
    }
    return result;
  } catch {
    // 隐私模式 / 配额满 / 历史脏数据：退回"没有自定义预设"，不影响页面可用性
    return [];
  }
}

export function writeCustomAuditLogPresets(presets: AuditLogPreset[]): AuditLogPreset[] {
  const limited = presets.slice(0, MAX_CUSTOM_AUDIT_LOG_PRESETS);
  if (typeof window === 'undefined') return limited;
  try {
    window.localStorage.setItem(AUDIT_LOG_PRESET_STORAGE_KEY, JSON.stringify(limited));
  } catch {
    /* 落盘失败只影响"下次还记得"，本次会话内存里仍然生效 */
  }
  return limited;
}

export function createCustomAuditLogPreset(name: string, query: AuditLogQuery): AuditLogPreset | null {
  const trimmed = name.trim().slice(0, MAX_PRESET_NAME_LENGTH);
  const sanitized = sanitizePresetQuery(query);
  if (!trimmed || Object.keys(sanitized).length === 0) return null;
  return { id: `custom:${Date.now().toString(36)}`, name: trimmed, query: sanitized };
}
