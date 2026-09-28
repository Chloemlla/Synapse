import { useSyncExternalStore } from 'react';

/**
 * 全站共享的「安全会话」（敏感操作二次验证）。
 *
 * 与个人资料页（UserProfile）同一套：先通过 /api/admin/user/profile/verify 验证一次身份
 * （密码 / TOTP / passkey）拿到 verificationToken，邮箱、密码、第三方账号绑定，以及管理端
 * 「查看密钥」等敏感操作复用同一枚 token（后端按 req.user.id + token 校验，5 分钟 TTL）。
 *
 * 用模块级单例 + useSyncExternalStore，使不同页面/组件树（UserProfile 与 env-manager）
 * 能共享同一会话，无需 Provider。
 */

interface SecuritySessionState {
  verificationToken: string;
  expiresAt: number | null;
}

let state: SecuritySessionState = { verificationToken: '', expiresAt: null };
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

/** 设置/刷新安全会话（验证成功后调用）。 */
export function setSecuritySession(verificationToken: string, expiresAt: number | null): void {
  state = { verificationToken, expiresAt: typeof expiresAt === 'number' ? expiresAt : null };
  emit();
}

/** 清除安全会话（登出 / 主动结束）。 */
export function clearSecuritySession(): void {
  if (!state.verificationToken && state.expiresAt === null) return;
  state = { verificationToken: '', expiresAt: null };
  emit();
}

export interface UseSecuritySession {
  verificationToken: string;
  expiresAt: number | null;
  isActive: boolean;
  setSession: (verificationToken: string, expiresAt: number | null) => void;
  clear: () => void;
}

export function useSecuritySession(): UseSecuritySession {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return {
    verificationToken: snapshot.verificationToken,
    expiresAt: snapshot.expiresAt,
    isActive: isSecuritySessionActive(snapshot),
    setSession: setSecuritySession,
    clear: clearSecuritySession,
  };
}
