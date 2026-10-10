export interface ValidationError {
  field: string;
  message: string;
}

export interface User {
  id: string;
  username: string;
  email: string;
  password?: string;
  passwordHash?: string;
  passwordCiphertext?: string;
  passwordIv?: string;
  passwordTag?: string;
  passwordKeyVersion?: string;
  passwordWrappedDek?: string;
  passwordDekId?: string;
  role: "user" | "admin" | "superadmin" | "trusted";
  dailyUsage: number;
  lastUsageDate: string;
  createdAt: string;
  token?: string;
  tokenExpiresAt?: number;
  totpSecret?: string;
  totpEnabled?: boolean;
  backupCodes?: string[];
  passkeyEnabled?: boolean;
  passkeyCredentials?: {
    id: string;
    name: string;
    credentialID: string;
    credentialPublicKey: string;
    counter: number;
    createdAt: string;
  }[];
  pendingChallenge?: string;
  pendingChallengeExpiresAt?: number;
  currentChallenge?: string;
  passkeyVerified?: boolean;
  avatarUrl?: string;
  authProvider?: "local" | "linuxdo" | "google";
  linuxdoId?: string;
  linuxdoUsername?: string;
  linuxdoAvatarUrl?: string;
  requireFingerprint?: boolean;
  requireFingerprintAt?: number;
  fingerprintRequestDismissedOnce?: boolean;
  fingerprintRequestDismissedAt?: number;
  fingerprints?: {
    id: string;
    ts: number;
    ua?: string;
    ip?: string;
  }[];
  fingerprintCount?: number;
  latestFingerprint?: {
    id: string;
    ts: number;
    ua?: string;
    ip?: string;
  } | null;
  lastLoginIp?: string;
  lastLoginAt?: string;
  /** RC-05：邮箱规范化键（小写 + 去 +tag + gmail 去点），注册查重与批量注册判定用。 */
  emailCanonical?: string;
  ticketViolationCount?: number;
  ticketBannedUntil?: string;
  isTranslationEnabled?: boolean;
  translationAccessUntil?: string;
  accountStatus?: "active" | "suspended";
  // ── 软删除账号（RC-01）────────────────────────────────────────────────
  // 0 / 缺省 = 未删除；> 0 = 被软删除的时间戳。
  deletedAt?: number;
  deletedBy?: string;
  deleteReason?: string;
  deletedOriginalUsername?: string;
  deletedOriginalEmail?: string;
  // ── 账户风险（RC-04）──────────────────────────────────────────────────
  riskTier?: "normal" | "watch" | "restricted" | "danger";
  /** 0-100，越高越危险（与 accountSecuritySummary 的「越高越安全」方向相反）。 */
  riskScore?: number;
  riskFlags?: string[];
  riskUpdatedAt?: number;
  flaggedBy?: string;
  flagReason?: string;
  /** 逐步验证到期时间：0 = 不强制；> now = 该时刻前每次操作都要验（RC-02/RC-03）。 */
  stepUpUntil?: number;
  stepUpMode?: "sensitive" | "all-writes" | "all";
}
