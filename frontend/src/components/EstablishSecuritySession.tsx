import { useCallback, useEffect, useState } from 'react';
import getApiBaseUrl from '../api';
import { useAuth } from '../hooks/useAuth';
import { useNotification } from './Notification';
import { useSecuritySession } from '../hooks/useSecuritySession';
import { verifyIdentity, getPasskeyAuthResponse } from './user-profile/profileHelpers';
import { getBackendErrorMessage } from '../utils/backendError';
import { studioFieldClassName, studioPrimaryButtonClassName, studioSecondaryButtonClassName } from './studioTheme';

interface EstablishSecuritySessionProps {
  /** 会话建立成功后的回调（如自动触发原本要做的敏感操作）。 */
  onEstablished?: () => void;
  /** 会话已有效时是否仍渲染「有效 + 结束会话」的状态条（默认渲染）。 */
  showActiveBar?: boolean;
}

type VerifyResult = { success?: boolean; verificationToken?: string; expiresAt?: number; error?: string };

/**
 * 全站统一的「建立安全会话」组件：验证一次身份后，账号修改、第三方绑定、查看密钥、命令执行等
 * 敏感操作复用同一枚 verificationToken（10 分钟 TTL）。按已配置的因素展示三种方式：
 * 当前密码（始终）、TOTP（开启后）、Passkey（注册后）。
 */
export default function EstablishSecuritySession({ onEstablished, showActiveBar = true }: EstablishSecuritySessionProps) {
  const { user } = useAuth();
  const { setNotification } = useNotification();
  const { isActive, setSession, clear } = useSecuritySession();

  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [submitting, setSubmitting] = useState<'password' | 'totp' | 'passkey' | null>(null);
  const [factors, setFactors] = useState<{ totp: boolean; passkey: boolean }>({ totp: false, passkey: false });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`${getApiBaseUrl()}/api/totp/status`, { credentials: 'include' });
        if (!res.ok) return;
        const data = await res.json();
        const passkey =
          typeof data?.hasPasskey === 'boolean'
            ? data.hasPasskey
            : typeof data?.passkeyEnabled === 'boolean'
              ? data.passkeyEnabled
              : typeof data?.credentialsCount === 'number'
                ? data.credentialsCount > 0
                : Array.isArray(data?.passkeyCredentials)
                  ? data.passkeyCredentials.length > 0
                  : false;
        if (!cancelled) setFactors({ totp: Boolean(data?.enabled), passkey });
      } catch {
        // 拉取因素失败时只展示密码方式，不阻塞
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const applySuccess = useCallback(
    (res: VerifyResult) => {
      if (!res.success || !res.verificationToken) throw new Error(res.error || '验证失败');
      setSession(res.verificationToken, typeof res.expiresAt === 'number' ? res.expiresAt : null);
      setPassword('');
      setTotpCode('');
      setNotification({ message: '安全会话已建立', type: 'success' });
      onEstablished?.();
    },
    [onEstablished, setNotification, setSession],
  );

  const runVerify = useCallback(
    async (kind: 'password' | 'totp' | 'passkey', fn: () => Promise<VerifyResult>, fallbackMsg: string) => {
      setSubmitting(kind);
      try {
        applySuccess(await fn());
      } catch (error) {
        setNotification({ message: getBackendErrorMessage(error, fallbackMsg), type: 'error' });
      } finally {
        setSubmitting(null);
      }
    },
    [applySuccess, setNotification],
  );

  const verifyPassword = () => {
    if (!password.trim()) {
      setNotification({ message: '请输入当前密码', type: 'warning' });
      return;
    }
    void runVerify('password', () => verifyIdentity({ method: 'password', password }), '密码验证失败');
  };

  const verifyTotp = () => {
    if (!/^\d{6}$/.test(totpCode.trim())) {
      setNotification({ message: '请输入 6 位 TOTP 验证码', type: 'warning' });
      return;
    }
    void runVerify('totp', () => verifyIdentity({ method: 'totp', verificationCode: totpCode.trim() }), 'TOTP 验证失败');
  };

  const verifyPasskey = () => {
    if (!user?.username) {
      setNotification({ message: '无法获取用户名', type: 'error' });
      return;
    }
    void runVerify(
      'passkey',
      async () => {
        const passkeyResponse = await getPasskeyAuthResponse(user.username as string);
        return verifyIdentity({ method: 'passkey', passkeyResponse, clientOrigin: window.location.origin });
      },
      'Passkey 验证失败',
    );
  };

  if (isActive) {
    if (!showActiveBar) return null;
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50/60 p-3 text-sm">
        <span className="rounded bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-700">安全会话有效</span>
        <span className="text-slate-500">账号修改、第三方绑定等敏感操作会复用该会话。</span>
        <button type="button" onClick={() => clear()} className={studioSecondaryButtonClassName}>
          结束会话
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-xl border border-slate-200 bg-slate-50/60 p-3">
      <div>
        <div className="text-sm font-semibold text-slate-700">建立安全会话</div>
        <div className="text-xs text-slate-500">验证一次后，账号修改和第三方绑定会复用该会话。</div>
      </div>

      {/* 当前密码（始终可用） */}
      <div className="rounded-lg border border-slate-200 bg-white/70 p-3">
        <div className="text-sm font-medium text-slate-700">当前密码</div>
        <div className="mb-2 text-xs text-slate-500">使用登录密码建立 10 分钟安全会话</div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') verifyPassword();
            }}
            placeholder="请输入当前密码"
            autoComplete="current-password"
            className={studioFieldClassName}
          />
          <button type="button" disabled={submitting !== null} onClick={verifyPassword} className={studioPrimaryButtonClassName}>
            {submitting === 'password' ? '验证中…' : '使用密码验证'}
          </button>
        </div>
      </div>

      {/* TOTP（开启后展示） */}
      {factors.totp ? (
        <div className="rounded-lg border border-slate-200 bg-white/70 p-3">
          <div className="text-sm font-medium text-slate-700">TOTP 验证码</div>
          <div className="mb-2 text-xs text-slate-500">使用认证器应用生成的 6 位验证码</div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              inputMode="numeric"
              maxLength={6}
              value={totpCode}
              onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, ''))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') verifyTotp();
              }}
              placeholder="6 位验证码"
              className={studioFieldClassName}
            />
            <button type="button" disabled={submitting !== null} onClick={verifyTotp} className={studioPrimaryButtonClassName}>
              {submitting === 'totp' ? '验证中…' : '使用 TOTP 验证'}
            </button>
          </div>
        </div>
      ) : null}

      {/* Passkey（注册后展示） */}
      {factors.passkey ? (
        <div className="rounded-lg border border-slate-200 bg-white/70 p-3">
          <div className="text-sm font-medium text-slate-700">Passkey 验证</div>
          <div className="mb-2 text-xs text-slate-500">使用生物识别或安全密钥进行验证</div>
          <button type="button" disabled={submitting !== null} onClick={verifyPasskey} className={studioSecondaryButtonClassName}>
            {submitting === 'passkey' ? '验证中…' : '使用 Passkey 验证'}
          </button>
        </div>
      ) : null}
    </div>
  );
}
