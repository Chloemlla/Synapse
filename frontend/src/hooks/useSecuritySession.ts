import { useSyncExternalStore } from 'react';

/**
 * 全站共享的「安全会话」（敏感操作二次验证）。
 *
 * 与个人资料页（UserProfile）同一套：先通过 /api/admin/user/profile/verify 验证一次身份
 * （密码 / TOTP / passkey）拿到 verificationToken，邮箱、密码、第三方账号绑定、查看密钥、
 * 命令执行、双因素配置等敏感操作复用同一枚 token（后端按 req.user.id + token 校验，TTL 由后台的安全会话策略决定）。
 *
 * 用模块级单例 + useSyncExternalStore，使不同页面/组件树（UserProfile、env-manager、TOTPManager）
 * 能共享同一会话，无需 Provider。
 */

export type SecuritySessionMethod = 'password' | 'totp' | 'passkey' | '';

interface SecuritySessionState {
  verificationToken: string;
  expiresAt: number | null;
  /** 建立会话时使用的验证方式，用于判断是否满足「必须非密码」的操作要求。 */
  method: SecuritySessionMethod;
}

let state: SecuritySessionState = { verificationToken: '', expiresAt: null, method: '' };
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): SecuritySessionState {
  return state;
}

/** 会话是否仍然有效（有 token 且未过期）。 */
export function isSecuritySessionActive(snapshot: SecuritySessionState = state): boolean {
  return Boolean(snapshot.verificationToken) && (!snapshot.expiresAt || snapshot.expiresAt > Date.now());
}

/**
 * 会话是否由 TOTP / Passkey 建立（满足「配置双因素验证不能用密码」的要求）。
 * 方式未知时按不满足处理，避免旧调用方漏传 method 时被放行。
 */
export function isTwoFactorSecuritySession(snapshot: SecuritySessionState = state): boolean {
  return isSecuritySessionActive(snapshot) && (snapshot.method === 'totp' || snapshot.method === 'passkey');
}

/** 设置/刷新安全会话（验证成功后调用）。 */
export function setSecuritySession(
  verificationToken: string,
  expiresAt: number | null,
  method: SecuritySessionMethod = '',
): void {
  state = { verificationToken, expiresAt: typeof expiresAt === 'number' ? expiresAt : null, method };
  emit();
}

/** 清除安全会话（登出 / 主动结束）。 */
export function clearSecuritySession(): void {
  if (!state.verificationToken && state.expiresAt === null && !state.method) return;
  state = { verificationToken: '', expiresAt: null, method: '' };
  emit();
}

/** 读取当前有效会话的 token（在回调、非组件的工具代码里用）；无有效会话返回空串。 */
export function getSecuritySessionToken(): string {
  return isSecuritySessionActive(state) ? state.verificationToken : '';
}

export interface UseSecuritySession {
  verificationToken: string;
  expiresAt: number | null;
  method: SecuritySessionMethod;
  isActive: boolean;
  /** 会话由 TOTP / Passkey 建立（可执行双因素配置类操作）。 */
  isTwoFactor: boolean;
  setSession: (verificationToken: string, expiresAt: number | null, method?: SecuritySessionMethod) => void;
  clear: () => void;
}

export function useSecuritySession(): UseSecuritySession {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return {
    verificationToken: snapshot.verificationToken,
    expiresAt: snapshot.expiresAt,
    method: snapshot.method,
    isActive: isSecuritySessionActive(snapshot),
    isTwoFactor: isTwoFactorSecuritySession(snapshot),
    setSession: setSecuritySession,
    clear: clearSecuritySession,
  };
}
