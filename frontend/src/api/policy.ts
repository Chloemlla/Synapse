import { api, apiWithRetry } from './api';
import { getFingerprint } from '../utils/fingerprint';
import { isPolicyAgreementSetComplete, missingPolicyAgreements } from '../utils/policyConsent';

export interface RecordPolicyConsentResult {
  consentId: string;
  version: string;
  expiresAt: string;
  /** 落库时记录的条文指纹（后端 POLICY_DOCUMENT_HASH） */
  documentHash?: string;
}

interface RecordPolicyConsentResponse {
  success: boolean;
  consentId: string;
  version: string;
  expiresAt: string;
  documentHash?: string;
}

interface PolicyVersionResponse {
  success: boolean;
  version: string;
  validityDays: number;
  documentHash?: string;
  agreementKeys?: string[];
}

/** 没有有效同意时的原因，与后端 ConsentStateReason 对齐。 */
export type PolicyConsentReason = 'active' | 'none' | 'expired' | 'revoked' | 'incomplete' | 'other-version';

/** 本设备对当前政策版本的同意状态；「无有效同意」是正常结果，不作为错误抛出 */
export interface PolicyConsentStatus {
  hasValidConsent: boolean;
  reason: PolicyConsentReason;
  /** 当前政策版本；同意有效时该同意也正是记录在这个版本下的 */
  version: string;
  /** 当前政策版本（与 version 分开，便于「记录的是旧版本」这种状态展示） */
  currentVersion: string;
  validityDays: number;
  /** 当前条文指纹 */
  documentHash: string;
  /** 这条同意记录落库时的条文指纹；旧记录可能没有 */
  consentDocumentHash?: string;
  /** 同意到期时间，仅 hasValidConsent 为 true 时存在 */
  expiresAt?: string;
  /** 同意时间，仅存在记录时给出 */
  recordedAt?: string;
  /** 记录来源：login / register / feature */
  source?: string;
  /** 已勾选的文件键名 */
  agreements: string[];
  agreementsComplete: boolean;
  /** 未勾选的文件键名（旧记录可能四份全缺） */
  missingAgreements: string[];
}

/** GET /api/policy/status 的原始响应形状（字段可缺，缺时由 fetchPolicyConsentStatus 补齐默认值）。 */
interface PolicyStatusResponse {
  success: boolean;
  hasValidConsent?: boolean;
  reason?: PolicyConsentReason;
  version?: string;
  currentVersion?: string;
  validityDays?: number;
  documentHash?: string;
  consentDocumentHash?: string;
  expiresAt?: string;
  recordedAt?: string;
  source?: string;
  agreements?: string[];
  agreementsComplete?: boolean;
  missingAgreements?: string[];
}

interface RevokePolicyConsentResponse {
  success: boolean;
  message: string;
  revokedCount: number;
  hadActiveConsent?: boolean;
  purged?: boolean;
}

/** 轨迹里一条记录的状态：当前有效 / 已过期 / 已撤回 / 属于旧版本。 */
export type PolicyConsentHistoryState = 'active' | 'expired' | 'revoked' | 'superseded';

export interface PolicyConsentHistoryEntry {
  id: string;
  version: string;
  state: PolicyConsentHistoryState;
  recordedAt: string | null;
  expiresAt: string | null;
  source?: string;
  agreements: string[];
  agreementsComplete: boolean;
  missingAgreements: string[];
  consentDocumentHash?: string;
  /** 该条记录的条文指纹是否与当前条文一致 */
  documentHashMatchesCurrent: boolean;
  revokedAt: string | null;
  revokedReason?: string;
}

interface PolicyHistoryResponse {
  success: boolean;
  currentVersion?: string;
  documentHash?: string;
  limit?: number;
  entries?: PolicyConsentHistoryEntry[];
}

export interface RevokePolicyConsentResult {
  revokedCount: number;
  /** 本次是否真的改动了有效记录（false = 本来就无需撤回） */
  hadActiveConsent: boolean;
  /** 是否走了硬删除 */
  purged: boolean;
}

export interface RevokePolicyConsentOptions {
  /** 为 true 时硬删除本设备全部同意记录（不可恢复），满足「删除」这项用户权利 */
  purge?: boolean;
}

/**
 * 本设备没有该指纹的同意凭据（后端 403 DEVICE_CREDENTIAL_REQUIRED）。
 * 单独成型是为了让调用方渲染人话，而不是把 error code 透给用户。
 */
export class DeviceCredentialRequiredError extends Error {
  constructor() {
    super('当前浏览器没有该设备的同意凭据');
    this.name = 'DeviceCredentialRequiredError';
  }
}

const readBackendErrorCode = (error: unknown): string | undefined => {
  const data = (error as { response?: { data?: { code?: unknown } } } | null)?.response?.data;
  return typeof data?.code === 'string' ? data.code : undefined;
};

const toPolicyRequestError = (error: unknown): unknown =>
  readBackendErrorCode(error) === 'DEVICE_CREDENTIAL_REQUIRED'
    ? new DeviceCredentialRequiredError()
    : error;

const resolveFingerprint = async (fingerprintInput?: string): Promise<string> => {
  const fingerprint = fingerprintInput || (await getFingerprint());
  if (!fingerprint) {
    throw new Error('无法获取设备信息，请刷新页面后重试');
  }
  return fingerprint;
};

/**
 * 落一条政策同意记录（POST /api/policy/verify）。
 *
 * 校验和、时间戳与条文指纹都由服务端生成——签名盐不下发，浏览器无从计算，因此客户端只需证明
 * 「我是这个指纹的设备」：请求拦截器会带上 X-Fingerprint 与首访验证令牌。
 */
export async function recordPolicyConsent(fingerprintInput?: string): Promise<RecordPolicyConsentResult> {
  const fingerprint = await resolveFingerprint(fingerprintInput);

  const { data } = await api.post<RecordPolicyConsentResponse>(
    '/api/policy/verify',
    { fingerprint },
    { headers: { 'X-Fingerprint': fingerprint } },
  );

  return {
    consentId: data.consentId,
    version: data.version,
    expiresAt: data.expiresAt,
    documentHash: data.documentHash,
  };
}

const readHeader = (headers: unknown, name: string): string => {
  if (!headers || typeof headers !== 'object') return '';
  const value = (headers as Record<string, unknown>)[name];
  return value === undefined || value === null ? '' : String(value);
};

const toAgreements = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

/**
 * 查询本设备的政策与同意状态（GET /api/policy/status）。
 *
 * 一次请求同时拿到「当前版本 + 有效期 + 条文指纹 + 本设备同意明细」，取代原先
 * 「先 /version 再 /check」的两次往返。指纹走 X-Fingerprint 请求头，不落在 URL 与访问日志里。
 * 没有设备凭据时后端回 403，这里抛出 DeviceCredentialRequiredError —— 那是空状态，不是故障。
 */
export async function fetchPolicyConsentStatus(fingerprintInput?: string): Promise<PolicyConsentStatus> {
  const fingerprint = await resolveFingerprint(fingerprintInput);

  try {
    const { data } = await api.get<PolicyStatusResponse>('/api/policy/status', {
      headers: { 'X-Fingerprint': fingerprint },
    });

    const agreements = toAgreements(data.agreements);
    return {
      hasValidConsent: data.hasValidConsent === true,
      reason: data.reason ?? (data.hasValidConsent ? 'active' : 'none'),
      version: data.version || data.currentVersion || '',
      currentVersion: data.currentVersion || data.version || '',
      validityDays: typeof data.validityDays === 'number' ? data.validityDays : 0,
      documentHash: data.documentHash || '',
      consentDocumentHash: data.consentDocumentHash,
      expiresAt: data.expiresAt,
      recordedAt: data.recordedAt,
      source: data.source,
      agreements,
      agreementsComplete: data.agreementsComplete ?? isPolicyAgreementSetComplete(agreements),
      missingAgreements: Array.isArray(data.missingAgreements)
        ? data.missingAgreements
        : missingPolicyAgreements(agreements),
    };
  } catch (error) {
    throw toPolicyRequestError(error);
  }
}

/**
 * 兼容入口：历史上面板调用的是 checkPolicyConsent（/version + /check 两次请求）。
 * 现在统一走 /status，保留这个导出名以免调用方一次性全改。
 */
export const checkPolicyConsent = fetchPolicyConsentStatus;

/** 当前政策版本（部分页面只需要版本号与有效期时的轻量入口）。 */
export async function fetchPolicyVersion(): Promise<{ version: string; validityDays: number; documentHash?: string }> {
  const { data } = await api.get<PolicyVersionResponse>('/api/policy/version');
  const version = data.version?.trim();
  if (!version) {
    throw new Error('无法获取当前政策版本，请稍后重试');
  }
  return { version, validityDays: data.validityDays, documentHash: data.documentHash };
}

/**
 * 本设备的同意轨迹（GET /api/policy/history）。
 *
 * 只对持有该设备同意凭据的浏览器开放；没有凭据时抛 DeviceCredentialRequiredError。
 * 返回的每一条都带状态（active/expired/revoked/superseded）与条文指纹是否与当前一致，
 * 用户据此可以自行核对「我同意过几次、分别同意的是哪份文本」。
 */
export async function fetchPolicyConsentHistory(
  fingerprintInput?: string,
  limit = 10,
): Promise<PolicyConsentHistoryEntry[]> {
  const fingerprint = await resolveFingerprint(fingerprintInput);

  try {
    const { data } = await api.get<PolicyHistoryResponse>('/api/policy/history', {
      headers: { 'X-Fingerprint': fingerprint },
      params: { limit },
    });
    return Array.isArray(data.entries) ? data.entries : [];
  } catch (error) {
    throw toPolicyRequestError(error);
  }
}

/**
 * 下载条文存档副本（GET /api/policy/document?format=md）。
 *
 * 返回 Markdown 文本与建议文件名；落盘动作由调用方完成（便于同时提示错误）。
 */
export async function fetchPolicyArchive(): Promise<{ filename: string; content: string }> {
  const response = await apiWithRetry.get<string>('/api/policy/document', {
    params: { format: 'md' },
    responseType: 'text',
  });

  const content = typeof response.data === 'string' ? response.data : String(response.data ?? '');
  if (!content.trim()) {
    throw new Error('条文存档内容为空，请稍后重试');
  }

  const disposition = readHeader(response.headers, 'content-disposition');
  const matched = /filename="?([^";]+)"?/.exec(disposition);
  return { filename: matched?.[1] || 'synapse-policy-archive.md', content };
}

/**
 * 撤回本设备的政策同意（POST /api/policy/revoke）。
 *
 * 默认不传 version：撤回该指纹下所有版本的记录，避免旧版本记录残留后又被判成「已同意」。
 * `purge: true` 转为硬删除（不可恢复），用于行使删除权利。
 */
export async function revokePolicyConsent(
  fingerprintInput?: string,
  options: RevokePolicyConsentOptions = {},
): Promise<RevokePolicyConsentResult> {
  const fingerprint = await resolveFingerprint(fingerprintInput);

  try {
    const body = options.purge ? { fingerprint, purge: true } : { fingerprint };
    const { data } = await api.post<RevokePolicyConsentResponse>('/api/policy/revoke', body, {
      headers: { 'X-Fingerprint': fingerprint },
    });
    return {
      revokedCount: data.revokedCount ?? 0,
      hadActiveConsent: data.hadActiveConsent ?? (data.revokedCount ?? 0) > 0,
      purged: data.purged === true,
    };
  } catch (error) {
    throw toPolicyRequestError(error);
  }
}
