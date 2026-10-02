import { api } from './api';

/**
 * 账号安全中心（用户自助）接口。
 *
 * 后端只回答「调用方自己的账号」，不接受 userId，因此前端也不提供该参数。
 */

export type SecurityCheckStatus = 'pass' | 'warn' | 'fail';

export type SecurityCheckAction =
  | 'enable_mfa'
  | 'enable_passkey'
  | 'regenerate_backup_codes'
  | 'verify_email'
  | 'report_fingerprint'
  | 'review_devices';

export interface AccountSecurityCheck {
  id: string;
  label: string;
  status: SecurityCheckStatus;
  detail: string;
  action?: SecurityCheckAction;
}

export interface AccountSecurityRecommendation {
  id: string;
  label: string;
  detail: string;
  severity: 'info' | 'warning' | 'critical';
  action?: string;
}

export interface AccountSecurityOverview {
  score: number;
  riskLevel: 'good' | 'watch' | 'risk';
  mfaEnabled: boolean;
  totpEnabled: boolean;
  passkeyEnabled: boolean;
  mfaFactorCount: number;
  passkeyCount: number;
  backupCodesRemaining: number;
  backupCodesLow: boolean;
  linkedProviderCount: number;
  fingerprintCount: number;
  activeDeviceCount: number;
  otherDeviceCount: number;
  accountStatus: 'active' | 'suspended';
  lastLoginAt: string | null;
  lastLoginIp: string | null;
  lastFingerprintIp: string | null;
  loginIpMatchesLastFingerprint: boolean | null;
  recommendations: AccountSecurityRecommendation[];
  checks: AccountSecurityCheck[];
}

interface SecuritySummaryResponse {
  success?: boolean;
  data?: AccountSecurityOverview;
  error?: string;
}

/** 拉取当前登录账号的安全总览；失败时抛出带可读消息的 Error，由调用方渲染重试态。 */
export async function fetchAccountSecurityOverview(): Promise<AccountSecurityOverview> {
  const res = await api.get<SecuritySummaryResponse>('/api/auth/security-summary');
  const data = res.data?.data;
  if (!data) {
    throw new Error(res.data?.error || '安全总览数据格式异常');
  }
  return data;
}
