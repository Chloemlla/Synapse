import { api } from './api';
import { getFingerprint } from '../utils/fingerprint';

export interface RecordPolicyConsentResult {
  consentId: string;
  version: string;
  expiresAt: string;
}

interface RecordPolicyConsentResponse {
  success: boolean;
  consentId: string;
  version: string;
  expiresAt: string;
}

interface PolicyVersionResponse {
  success: boolean;
  version: string;
  validityDays: number;
}

interface PolicyCheckResponse {
  success: boolean;
  hasValidConsent: boolean;
  version?: string;
  expiresAt?: string;
  /** 后端在无有效同意时给出的英文原因文案 */
  message?: string;
  currentVersion?: string;
}

interface RevokePolicyConsentResponse {
  success: boolean;
  message: string;
  revokedCount: number;
}

/** 本设备对当前政策版本的同意状态；「无有效同意」是正常结果，不作为错误抛出 */
export interface PolicyConsentStatus {
  hasValidConsent: boolean;
  /** 当前政策版本；同意有效时该同意也正是记录在这个版本下的 */
  version: string;
  /** 同意到期时间，仅 hasValidConsent 为 true 时存在 */
  expiresAt?: string;
  /** 无有效同意的原因：从未同意过 / 已有的同意已过期 */
  reason?: 'none' | 'expired';
}

export interface RevokePolicyConsentResult {
  revokedCount: number;
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
 * 校验和与时间戳都由服务端生成——签名盐不下发，浏览器无从计算，因此客户端只需证明
 * 「我是这个指纹的设备」：请求拦截器会带上 X-Fingerprint 与首访验证令牌，
 * 已登录时会话本身也算证明。
 */
export async function recordPolicyConsent(fingerprintInput?: string): Promise<RecordPolicyConsentResult> {
  const fingerprint = await resolveFingerprint(fingerprintInput);

  const { data } = await api.post<RecordPolicyConsentResponse>('/api/policy/verify', { fingerprint });

  return {
    consentId: data.consentId,
    version: data.version,
    expiresAt: data.expiresAt,
  };
}

/**
 * 查询本设备对当前政策版本的同意状态（GET /api/policy/version + /api/policy/check）。
 *
 * check 的 version 是必填参数，缺了直接 400，所以版本必须先从 /version 取。
 * 无有效同意时后端同样返回 200，这里照常返回结果而不是抛错——「没同意过」是面板要展示的状态。
 */
export async function checkPolicyConsent(fingerprintInput?: string): Promise<PolicyConsentStatus> {
  const fingerprint = await resolveFingerprint(fingerprintInput);

  const { data: versionData } = await api.get<PolicyVersionResponse>('/api/policy/version');
  const version = versionData.version?.trim();
  if (!version) {
    throw new Error('无法获取当前政策版本，请稍后重试');
  }

  try {
    const { data } = await api.get<PolicyCheckResponse>('/api/policy/check', {
      params: { fingerprint, version },
    });

    if (data.hasValidConsent) {
      return { hasValidConsent: true, version: data.version || version, expiresAt: data.expiresAt };
    }

    return {
      hasValidConsent: false,
      version,
      // 「已过期」目前只能从这句英文文案区分；后端 findValidConsent 会把过期记录一并过滤掉，
      // 因此该分支实际很少命中，拿不到就按「未同意」展示。
      reason: data.message === 'Consent expired' ? 'expired' : 'none',
    };
  } catch (error) {
    throw toPolicyRequestError(error);
  }
}

/**
 * 撤回本设备的政策同意（POST /api/policy/revoke）。
 *
 * 不传 version：撤回该指纹下所有版本的记录，避免旧版本记录残留后又被判成「已同意」。
 */
export async function revokePolicyConsent(fingerprintInput?: string): Promise<RevokePolicyConsentResult> {
  const fingerprint = await resolveFingerprint(fingerprintInput);

  try {
    const { data } = await api.post<RevokePolicyConsentResponse>('/api/policy/revoke', { fingerprint });
    return { revokedCount: data.revokedCount };
  } catch (error) {
    throw toPolicyRequestError(error);
  }
}
