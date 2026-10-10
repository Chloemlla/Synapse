import { useCallback, useEffect, useState } from 'react';
import getApiBaseUrl from '../api';
import { useAuth } from '../hooks/useAuth';
import { useNotification } from './Notification';
import { useSecuritySession } from '../hooks/useSecuritySession';
import { passkeyApi } from '../api/passkey';
import { verifyIdentity, getPasskeyAuthResponse } from './user-profile/profileHelpers';
import { getBackendErrorMessage } from '../utils/backendError';
import { studioFieldClassName, studioPrimaryButtonClassName, studioSecondaryButtonClassName } from './studioTheme';

interface EstablishSecuritySessionProps {
  /** 会话建立成功后的回调（如自动触发原本要做的敏感操作）。 */
  onEstablished?: () => void;
  /** 会话已有效时是否仍渲染「有效 + 结束会话」的状态条（默认渲染）。 */
  showActiveBar?: boolean;
  /**
   * 是否要求用 TOTP / Passkey 建立会话（配置双因素验证时用）。
   * 为 true 时隐藏「当前密码」方式，密码建立的旧会话也不算满足要求。
   * 调用方应在账号已配置 TOTP/Passkey 时才传 true，否则用户无法开始首次配置。
   */
  requireTwoFactor?: boolean;
}

type VerifyResult = { success?: boolean; verificationToken?: string; expiresAt?: number; error?: string };

/**
 * 全站统一的「建立安全会话」组件：验证一次身份后，账号修改、第三方绑定、查看密钥、命令执行、
 * 双因素配置等敏感操作复用同一枚 verificationToken（10 分钟 TTL）。按已配置的因素展示三种方式：
 * 当前密码（requireTwoFactor 为 false 时）、TOTP（开启后）、Passkey（注册后）。
 */
export default function EstablishSecuritySession({
  onEstablished,
  showActiveBar = true,
  requireTwoFactor = false,
}: EstablishSecuritySessionProps) {
  const { user } = useAuth();
  const { setNotification } = useNotification();
  const { isActive, method, setSession, clear } = useSecuritySession();

  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [backupCode, setBackupCode] = useState('');
  // TOTP 卡片两种输入：认证器 6 位验证码 / 8 位备用恢复码（认证器丢失时的兑底）。
  const [totpMode, setTotpMode] = useState<'code' | 'backup'>('code');
  const [submitting, setSubmitting] = useState<'password' | 'totp' | 'passkey' | null>(null);
  // null = 尚未探测到（比如 /api/totp/status 请求失败）
  const [factors, setFactors] = useState<{ totp: boolean; passkey: boolean } | null>(null);
  // 验证失败的内联错误：toast 3 秒后消失，错过就不知道失败原因，所以按因素在卡片内联展示
  const [verifyError, setVerifyError] = useState<{ kind: 'password' | 'totp' | 'passkey'; message: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    // 裸 fetch 不走 axios，没有 api.ts 的 15s 超时；后端挂起时用同一档超时中止并走兜底展示
    const timeoutId = window.setTimeout(() => controller.abort(), 15000);
    void (async () => {
      try {
        const res = await fetch(`${getApiBaseUrl()}/api/totp/status`, {
          credentials: 'include',
          signal: controller.signal,
        });
        if (!res.ok) return;
        const data = await res.json();
        const explicitPasskey =
          typeof data?.hasPasskey === 'boolean'
            ? data.hasPasskey
            : typeof data?.passkeyEnabled === 'boolean'
              ? data.passkeyEnabled
              : typeof data?.credentialsCount === 'number'
                ? data.credentialsCount > 0
                : Array.isArray(data?.passkeyCredentials)
                  ? data.passkeyCredentials.length > 0
                  : null;
        // /api/totp/status 不返回 Passkey 信息，缺省时回落到凭证列表接口，
        // 否则只配了 Passkey 的账号在这里看不到 Passkey 验证方式。
        const passkey =
          explicitPasskey ??
          (await passkeyApi
            .getCredentials()
            .then(({ data: credentials }) => Array.isArray(credentials) && credentials.length > 0)
            .catch(() => false));
        if (!cancelled) setFactors({ totp: Boolean(data?.enabled), passkey });
      } catch {
        // 拉取因素失败时保持 null：不阻塞，由渲染逻辑决定兜底展示哪些方式
      } finally {
        window.clearTimeout(timeoutId);
      }
    })();
    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
      controller.abort();
    };
  }, []);

  // 因素未知时按「要求二因素就两种都给出」兜底，避免只配了 Passkey 的账号看到空盒子。
  const totpAvailable = factors ? factors.totp : requireTwoFactor;
  const passkeyAvailable = factors ? factors.passkey : requireTwoFactor;

  const applySuccess = useCallback(
    (res: VerifyResult, kind: 'password' | 'totp' | 'passkey') => {
      if (!res.success || !res.verificationToken) throw new Error(res.error || '验证失败');
      setSession(res.verificationToken, typeof res.expiresAt === 'number' ? res.expiresAt : null, kind);
      setPassword('');
      setTotpCode('');
      setBackupCode('');
      setTotpMode('code');
      setNotification({ message: '安全会话已建立', type: 'success' });
      onEstablished?.();
    },
    [onEstablished, setNotification, setSession],
  );

  const runVerify = useCallback(
    async (kind: 'password' | 'totp' | 'passkey', fn: () => Promise<VerifyResult>, fallbackMsg: string) => {
      setSubmitting(kind);
      setVerifyError(null);
      try {
        applySuccess(await fn(), kind);
      } catch (error) {
        const backendCode = (error as { response?: { data?: { code?: string } } })?.response?.data?.code;
        if (backendCode === 'TOTP_CODE_REUSED') {
          // 单次凭据已被消费：清掉输入，避免用户再提交同一枚码。
          setTotpCode('');
          setBackupCode('');
          setVerifyError({
            kind,
            message: '该验证码已被使用，请等待验证器显示新的验证码（约 30 秒）后重试',
          });
        } else {
          setVerifyError({ kind, message: getBackendErrorMessage(error, fallbackMsg) });
        }
      } finally {
        setSubmitting(null);
      }
    },
    [applySuccess],
  );

  const verifyPassword = () => {
    if (!password.trim()) {
      setNotification({ message: '请输入当前密码', type: 'warning' });
      return;
    }
    void runVerify('password', () => verifyIdentity({ method: 'password', password }), '密码验证失败');
  };

  const verifyTotp = () => {
    if (totpMode === 'backup') {
      // 与后端同口径：去掉分隔符、统一大写后的 8 位字母数字。
      const normalized = backupCode.toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (normalized.length !== 8) {
        setNotification({ message: '请输入 8 位备用恢复码', type: 'warning' });
        return;
      }
      void runVerify(
        'totp',
        () => verifyIdentity({ method: 'totp', backupCode: normalized }),
        '恢复码验证失败',
      );
      return;
    }

    if (!/^\d{6}$/.test(totpCode.trim())) {
      setNotification({ message: '请输入 6 位动态验证码', type: 'warning' });
      return;
    }
    void runVerify('totp', () => verifyIdentity({ method: 'totp', verificationCode: totpCode.trim() }), '动态验证码验证失败');
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
      '通行密钥验证失败',
    );
  };

  // 要求「非密码」时，密码建立的会话不算满足，继续展示可用的验证方式让用户升级会话。
  const satisfied = isActive && (!requireTwoFactor || method !== 'password');

  if (satisfied) {
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
        <div className="text-xs text-slate-500">
          {requireTwoFactor
            ? '配置双因素验证需用动态验证码或通行密钥建立 10 分钟安全会话，不能使用登录密码。'
            : '验证一次后，账号修改和第三方绑定会复用该会话。'}
        </div>
      </div>

      {/* 当前密码（requireTwoFactor 时隐藏，避免只拿到密码就能改动双因素配置） */}
      {requireTwoFactor ? null : (
        <div className="rounded-lg border border-slate-200 bg-white/70 p-3">
          <label htmlFor="ess-password" className="text-sm font-medium text-slate-700">当前密码</label>
          <div className="mb-2 text-xs text-slate-500">使用登录密码建立 10 分钟安全会话</div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              id="ess-password"
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
          {verifyError?.kind === 'password' ? (
            <div role="alert" aria-live="assertive" className="mt-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs leading-5 text-rose-700">
              {verifyError.message}
            </div>
          ) : null}
        </div>
      )}

      {/* TOTP（开启后展示；认证器不可用时可用备用恢复码） */}
      {totpAvailable ? (
        <div className="rounded-lg border border-slate-200 bg-white/70 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label
              htmlFor={totpMode === 'backup' ? 'ess-backup-code' : 'ess-totp-code'}
              className="text-sm font-medium text-slate-700"
            >
              {totpMode === 'backup' ? '备用恢复码' : '动态验证码'}
            </label>
            <button
              type="button"
              className="text-xs text-blue-600 hover:underline"
              disabled={submitting !== null}
              onClick={() => setTotpMode(totpMode === 'backup' ? 'code' : 'backup')}
            >
              {totpMode === 'backup' ? '改用认证器验证码' : '认证器不可用？改用恢复码'}
            </button>
          </div>
          <div className="mb-2 text-xs text-slate-500">
            {totpMode === 'backup'
              ? '输入生成双因素时保存的 8 位恢复码，每个恢复码只能使用一次'
              : '使用认证器应用生成的 6 位验证码'}
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            {totpMode === 'backup' ? (
              <input
                id="ess-backup-code"
                value={backupCode}
                maxLength={8}
                onChange={(e) => setBackupCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') verifyTotp();
                }}
                placeholder="8 位恢复码"
                className={studioFieldClassName}
              />
            ) : (
              <input
                id="ess-totp-code"
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
            )}
            <button type="button" disabled={submitting !== null} onClick={verifyTotp} className={studioPrimaryButtonClassName}>
              {submitting === 'totp' ? '验证中…' : totpMode === 'backup' ? '使用恢复码验证' : '使用动态验证码验证'}
            </button>
          </div>
          {verifyError?.kind === 'totp' ? (
            <div role="alert" aria-live="assertive" className="mt-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs leading-5 text-rose-700">
              {verifyError.message}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Passkey（注册后展示） */}
      {passkeyAvailable ? (
        <div className="rounded-lg border border-slate-200 bg-white/70 p-3">
          <div className="text-sm font-medium text-slate-700">通行密钥 (Passkey)</div>
          <div className="mb-2 text-xs text-slate-500">使用生物识别或安全密钥进行验证</div>
          <button type="button" disabled={submitting !== null} onClick={verifyPasskey} className={studioSecondaryButtonClassName}>
            {submitting === 'passkey' ? '验证中…' : '使用通行密钥验证'}
          </button>
          {verifyError?.kind === 'passkey' ? (
            <div role="alert" aria-live="assertive" className="mt-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs leading-5 text-rose-700">
              {verifyError.message}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
