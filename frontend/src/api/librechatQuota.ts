import { api } from './api';

/**
 * 普通用户的今日 LibreChat 对话额度视图（与后端 libreChatQuotaService.buildQuotaView 同形）。
 * 权威来源有三处，形状一致：GET /api/librechat/quota（只读查询）、POST /send 与 /retry 的
 * 成功响应（扣减后）、被拒时的 403 响应（超额警告 / 暂停态）。
 */
export interface LibreChatQuotaView {
  dailyLimit: number;
  used: number;
  remaining: number;
  banned: boolean;
  bannedUntil: string | null;
  warnings: number;
  maxWarnings: number;
}

const QUOTA_PATH = '/api/librechat/quota';

function readFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * 宽松解析后端额度视图：缺必需数字字段时返回 null（= 额度未知），不要用 0 兜底——
 * 把「查不到」显示成「剩余 0 次」会把用户误导到以为今天已经不能用了。
 */
export function parseLibreChatQuota(value: unknown): LibreChatQuotaView | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const dailyLimit = readFiniteNumber(raw.dailyLimit);
  const used = readFiniteNumber(raw.used);
  const remaining = readFiniteNumber(raw.remaining);
  const maxWarnings = readFiniteNumber(raw.maxWarnings);
  if (dailyLimit === null || used === null || remaining === null || maxWarnings === null) return null;

  const bannedUntil = typeof raw.bannedUntil === 'string' && raw.bannedUntil.trim() ? raw.bannedUntil : null;
  return {
    dailyLimit,
    used,
    remaining,
    banned: raw.banned === true,
    bannedUntil,
    warnings: readFiniteNumber(raw.warnings) ?? 0,
    maxWarnings,
  };
}

/** 只读查询今日额度（不消耗次数）。失败时抛错，由调用方决定显示「未知」还是保留上一次的值。 */
export async function fetchLibreChatQuota(): Promise<LibreChatQuotaView> {
  const response = await api.get(QUOTA_PATH);
  const quota = parseLibreChatQuota(response.data?.quota);
  if (!quota) throw new Error('LibreChat 额度响应格式无法识别');
  return quota;
}
