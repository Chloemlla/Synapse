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

/**
 * 落一条政策同意记录（POST /api/policy/verify）。
 *
 * 校验和与时间戳都由服务端生成——签名盐不下发，浏览器无从计算，因此客户端只需证明
 * 「我是这个指纹的设备」：请求拦截器会带上 X-Fingerprint 与首访验证令牌，
 * 已登录时会话本身也算证明。
 */
export async function recordPolicyConsent(fingerprintInput?: string): Promise<RecordPolicyConsentResult> {
  const fingerprint = fingerprintInput || (await getFingerprint());
  if (!fingerprint) {
    throw new Error('无法获取设备信息，请刷新页面后重试');
  }

  const { data } = await api.post<RecordPolicyConsentResponse>('/api/policy/verify', { fingerprint });

  return {
    consentId: data.consentId,
    version: data.version,
    expiresAt: data.expiresAt,
  };
}
