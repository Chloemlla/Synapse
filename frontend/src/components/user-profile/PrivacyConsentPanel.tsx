import React, { useCallback, useEffect, useState } from 'react';
import {
  FaCheckCircle,
  FaExclamationCircle,
  FaExclamationTriangle,
  FaShieldAlt,
  FaSyncAlt,
  FaUserShield,
} from 'react-icons/fa';
import {
  checkPolicyConsent,
  DeviceCredentialRequiredError,
  revokePolicyConsent,
  type PolicyConsentStatus,
} from '../../api/policy';
import { getBackendErrorMessage } from '../../utils/backendError';
import { cn } from '../../utils/cn';
import { formatDateTime } from './profileHelpers';
import {
  studioDangerButtonClassName,
  studioFieldClassName,
  studioSecondaryButtonClassName,
} from '../studioTheme';

const REVOKE_WARNING =
  '撤回后本设备上依赖政策同意的功能（如语音生成）将立即停止，需要重新逐项勾选条款才能继续使用。';

const REVOKED_NOTICE = `已撤回本设备对政策条款的同意。${REVOKE_WARNING}`;

// 403 的设备凭据缺失要给人话，其余错误沿用后端文案；这里都不把 error code 透给用户。
const describeError = (error: unknown, fallback: string): string =>
  error instanceof DeviceCredentialRequiredError
    ? '当前浏览器没有该设备的同意凭据，请在本设备上重新同意后操作。'
    : getBackendErrorMessage(error, fallback);

interface StatusPresentation {
  label: string;
  badgeClassName: string;
  hint: string;
}

const getStatusPresentation = (status: PolicyConsentStatus): StatusPresentation => {
  if (status.hasValidConsent) {
    return {
      label: '有效',
      badgeClassName: 'bg-emerald-100 text-emerald-700',
      hint: '本设备可以继续使用依赖该同意的功能。',
    };
  }

  if (status.reason === 'expired') {
    return {
      label: '已过期',
      badgeClassName: 'bg-amber-100 text-amber-700',
      hint: '同意已过期，需要重新逐项勾选条款才能继续使用依赖该同意的功能。',
    };
  }

  return {
    label: '未同意',
    badgeClassName: 'bg-slate-100 text-slate-600',
    hint: '本设备还没有对当前版本政策做出同意，无需撤回。',
  };
};

/**
 * 用户资料页的「隐私与同意」面板。
 *
 * 政策同意按浏览器设备指纹记录（没有 userId），TTS 生成时的门禁也按指纹判定，
 * 所以这里的口径是「本设备」而不是「本账户」——按账户聚合会与实际判定不一致。
 */
const PrivacyConsentPanel: React.FC = () => {
  const [status, setStatus] = useState<PolicyConsentStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [revoking, setRevoking] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setStatus(await checkPolicyConsent());
    } catch (loadError) {
      setStatus(null);
      setError(describeError(loadError, '获取本设备的同意状态失败，请稍后重试'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const handleRevoke = async () => {
    setRevoking(true);
    setError(null);
    setNotice(null);
    try {
      await revokePolicyConsent();
      setConfirming(false);
      setNotice(REVOKED_NOTICE);
      // 撤回成功后无条件重查：提示语之外，状态标签也必须反映服务端的真实结果。
      // 放在成功分支里，失败时的错误文案才不会被 loadStatus 开头的 setError(null) 抹掉。
      await loadStatus();
    } catch (revokeError) {
      setConfirming(false);
      setError(describeError(revokeError, '撤回同意失败，请稍后重试'));
    } finally {
      setRevoking(false);
    }
  };

  const busy = loading || revoking;
  const presentation = status ? getStatusPresentation(status) : null;

  return (
    <section
      className="mb-4 rounded-2xl border border-slate-200 bg-white p-4 sm:p-5"
      aria-labelledby="privacy-consent-title"
      aria-busy={busy}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
            <FaUserShield />
            <span id="privacy-consent-title">隐私与同意</span>
          </div>
          <p className="mt-2 text-[13px] leading-6 text-slate-600 sm:text-sm">
            查看并撤回<strong className="font-semibold text-slate-700">本设备</strong>对服务条款与隐私政策的同意。
            同意按浏览器设备记录，撤回后需要在本设备上重新逐项勾选条款，才能继续使用依赖该同意的功能。
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            void loadStatus();
          }}
          disabled={busy}
          className={cn(
            studioFieldClassName,
            'inline-flex w-auto shrink-0 items-center justify-center gap-2 px-3 py-2 text-xs font-semibold text-slate-600 disabled:cursor-not-allowed disabled:opacity-50',
          )}
          aria-label="刷新隐私与同意状态"
          title="刷新隐私与同意状态"
        >
          <FaSyncAlt className={loading ? 'animate-spin' : undefined} />
          刷新
        </button>
      </div>

      {error && (
        <div className="mt-4 flex flex-col gap-3 rounded-2xl border border-rose-200 bg-rose-50 px-3.5 py-3 text-[13px] text-rose-700 sm:flex-row sm:items-center sm:justify-between sm:text-sm">
          <span className="flex items-start gap-2 break-words">
            <FaExclamationCircle className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </span>
          <button
            type="button"
            onClick={() => {
              void loadStatus();
            }}
            disabled={busy}
            className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl bg-white px-3 py-2 text-xs font-semibold text-rose-700 transition hover:bg-rose-100 disabled:opacity-50"
          >
            <FaSyncAlt />
            重试
          </button>
        </div>
      )}

      {notice && !error && (
        <div className="mt-4 flex items-start gap-2 rounded-2xl border border-emerald-200 bg-emerald-50 px-3.5 py-3 text-[12px] leading-5 text-emerald-700">
          <FaCheckCircle className="mt-0.5 shrink-0" />
          <span>{notice}</span>
        </div>
      )}

      {loading && !status ? (
        <div className="mt-4 flex items-center gap-2 rounded-2xl border border-slate-200 bg-slate-50 px-3.5 py-4 text-sm text-slate-500">
          <FaSyncAlt className="animate-spin" />
          正在加载本设备的同意状态...
        </div>
      ) : status && presentation ? (
        <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50/70 px-3.5 py-3.5 sm:px-4">
          <div className="grid min-w-0 gap-3 sm:grid-cols-2">
            <div className="min-w-0">
              <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">当前政策版本</div>
              <div className="mt-1 break-words text-sm font-semibold text-slate-900">{status.version}</div>
            </div>
            <div className="min-w-0">
              <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">本设备同意状态</div>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <span className={cn('inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[10px] font-semibold', presentation.badgeClassName)}>
                  <FaShieldAlt />
                  {presentation.label}
                </span>
                {status.hasValidConsent && status.expiresAt && (
                  <span className="text-xs text-slate-600">有效期至 {formatDateTime(status.expiresAt)}</span>
                )}
              </div>
            </div>
          </div>

          <p className="mt-3 break-words border-t border-slate-200/80 pt-3 text-xs leading-5 text-slate-500">
            {presentation.hint}
          </p>

          {status.hasValidConsent && (
            <div className="mt-3">
              {confirming ? (
                <div className="rounded-2xl border border-amber-200 bg-amber-50 px-3.5 py-3">
                  <p className="flex items-start gap-2 break-words text-[12px] leading-5 text-amber-800">
                    <FaExclamationTriangle className="mt-0.5 shrink-0" />
                    <span>{REVOKE_WARNING}</span>
                  </p>
                  <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                    <button
                      type="button"
                      onClick={() => {
                        void handleRevoke();
                      }}
                      disabled={revoking}
                      className={cn(studioDangerButtonClassName, 'w-full px-3 py-2 text-xs sm:w-auto')}
                    >
                      {revoking ? <FaSyncAlt className="animate-spin" /> : <FaExclamationTriangle />}
                      {revoking ? '正在撤回...' : '确认撤回本设备同意'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirming(false)}
                      disabled={revoking}
                      className={cn(studioSecondaryButtonClassName, 'w-full px-3 py-2 text-xs sm:w-auto')}
                    >
                      取消
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setNotice(null);
                    setConfirming(true);
                  }}
                  disabled={busy}
                  className={cn(studioDangerButtonClassName, 'w-full px-3 py-2 text-xs sm:w-auto')}
                  aria-label="撤回本设备的政策同意"
                  title="撤回本设备的政策同意"
                >
                  <FaExclamationTriangle />
                  撤回本设备同意
                </button>
              )}
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
};

export default PrivacyConsentPanel;
