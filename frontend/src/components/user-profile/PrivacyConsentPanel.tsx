import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  FaCheckCircle,
  FaChevronDown,
  FaExclamationCircle,
  FaExclamationTriangle,
  FaHistory,
  FaShieldAlt,
  FaSyncAlt,
  FaTrashAlt,
  FaUserShield,
} from 'react-icons/fa';
import {
  DeviceCredentialRequiredError,
  fetchPolicyConsentHistory,
  fetchPolicyConsentStatus,
  revokePolicyConsent,
  type PolicyConsentHistoryEntry,
  type PolicyConsentHistoryState,
  type PolicyConsentStatus,
} from '../../api/policy';
import { getBackendErrorMessage } from '../../utils/backendError';
import { cn } from '../../utils/cn';
import { describeAgreementKey, missingPolicyAgreements } from '../../utils/policyConsent';
import { formatDateTime } from './profileHelpers';
import {
  studioDangerButtonClassName,
  studioFieldClassName,
  studioSecondaryButtonClassName,
} from '../studioTheme';

const REVOKE_WARNING =
  '撤回后本设备上依赖政策同意的功能（如语音生成）将立即停止，需要重新逐项勾选条款才能继续使用。';

const PURGE_WARNING =
  '删除会从服务端彻底移除本设备的全部同意记录（不可恢复），同时清除本设备的同意凭据。之后在本设备使用依赖同意的功能时，会被要求重新逐项勾选。审计与安全类记录（如操作审计日志）按各自期限单独保留。';

const REVOKED_NOTICE = `已撤回本设备对政策条款的同意。${REVOKE_WARNING}`;
const PURGED_NOTICE = '已删除本设备在服务端的全部同意记录，并清除本设备的同意凭据。';

const SOURCE_LABELS: Record<string, string> = {
  login: '登录时同意',
  register: '注册时同意',
  feature: '功能使用时同意',
};

// 轨迹里每条记录的状态文案：与后端 entries[].state 一一对应
const HISTORY_STATE_LABELS: Record<PolicyConsentHistoryState, { label: string; className: string }> = {
  active: { label: '有效', className: 'bg-emerald-100 text-emerald-700' },
  expired: { label: '已过期', className: 'bg-slate-100 text-slate-600' },
  revoked: { label: '已撤回', className: 'bg-rose-100 text-rose-700' },
  superseded: { label: '属于旧版本', className: 'bg-amber-100 text-amber-700' },
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** 距到期还有多少天（向上取整）；无法解析时返回 null。 */
const daysUntil = (iso?: string): number | null => {
  if (!iso) return null;
  const target = new Date(iso).getTime();
  if (!Number.isFinite(target)) return null;
  return Math.ceil((target - Date.now()) / DAY_MS);
};

const sourceLabel = (source?: string): string =>
  source ? SOURCE_LABELS[source] ?? source : '未记录';

// 403 的设备凭据缺失要给人话，其余错误沿用后端文案；这里都不把 error code 透给用户。
const describeError = (error: unknown, fallback: string): string =>
  error instanceof DeviceCredentialRequiredError
    ? '当前浏览器没有该设备的同意凭据，请在本设备重新同意后操作。'
    : getBackendErrorMessage(error, fallback);

interface StatusPresentation {
  label: string;
  badgeClassName: string;
  hint: string;
}

/** 状态文案按后端给出的 reason 分档：比原先的「有效 / 未同意」两态更接近事实。 */
const getStatusPresentation = (status: PolicyConsentStatus): StatusPresentation => {
  if (status.hasValidConsent) {
    return {
      label: '有效',
      badgeClassName: 'bg-emerald-100 text-emerald-700',
      hint: '本设备可以继续使用依赖该同意的功能。',
    };
  }

  switch (status.reason) {
    case 'expired':
      return {
        label: '已过期',
        badgeClassName: 'bg-amber-100 text-amber-700',
        hint: '此前的同意已过期，无需手动撤回；继续使用依赖同意的功能时会被要求重新逐项勾选。',
      };
    case 'revoked':
      return {
        label: '已撤回',
        badgeClassName: 'bg-rose-100 text-rose-700',
        hint: '本设备此前撤回过同意（或记录已失效）。要再次使用依赖同意的功能，需要重新逐项勾选。',
      };
    case 'incomplete':
      return {
        label: '勾选项不完整',
        badgeClassName: 'bg-amber-100 text-amber-700',
        hint: '库里的记录没有覆盖当前版本要求的全部文件，需要重新逐项勾选后才能继续使用。',
      };
    case 'other-version':
      return {
        label: '记录属于旧版本',
        badgeClassName: 'bg-amber-100 text-amber-700',
        hint: `本设备最后同意的是 v${status.version}，当前版本是 v${status.currentVersion}，需要按新条文重新同意。`,
      };
    default:
      return {
        label: '从未同意',
        badgeClassName: 'bg-slate-100 text-slate-600',
        hint: '本设备没有同意记录；继续使用依赖同意的功能时会被要求重新逐项勾选。',
      };
  }
};

/**
 * 用户资料页的「隐私与同意」面板。
 *
 * 政策同意按浏览器设备指纹记录（没有 userId），TTS 生成时的门禁也按指纹判定，
 * 所以这里的口径是「本设备」而不是「本账户」——按账户聚合会与实际判定不一致。
 * 除状态外还展示同意时间、来源与已勾选文件，并支持两种终止处理：
 * 撤回（软，留痕）与删除（硬删除本设备记录）。
 */
const PrivacyConsentPanel: React.FC = () => {
  const [status, setStatus] = useState<PolicyConsentStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [revoking, setRevoking] = useState(false);
  const [purging, setPurging] = useState(false);
  const [confirming, setConfirming] = useState<'revoke' | 'purge' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // 本浏览器拿不到该设备的同意凭据（换设备、清了站点数据，或从未在此同意过）。
  // 这是空状态，不是故障，不该渲染成红色错误。
  const [credentialMissing, setCredentialMissing] = useState(false);
  // 同意轨迹（历次同意与撤回）：单独加载，失败不影响状态卡片的展示
  const [history, setHistory] = useState<PolicyConsentHistoryEntry[] | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      setHistory(await fetchPolicyConsentHistory(undefined, 10));
    } catch {
      // 轨迹是辅助信息：拿不到就不展示（状态卡片已经能说明当下情况），不报错打断用户
      setHistory(null);
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setStatus(await fetchPolicyConsentStatus());
      setCredentialMissing(false);
    } catch (loadError) {
      setStatus(null);
      if (loadError instanceof DeviceCredentialRequiredError) {
        setCredentialMissing(true);
      } else {
        setCredentialMissing(false);
        setError(describeError(loadError, '获取本设备的同意状态失败，请稍后重试'));
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
    void loadHistory();
  }, [loadStatus, loadHistory]);

  const handleRevoke = async (purge: boolean) => {
    if (purge) setPurging(true);
    else setRevoking(true);
    setError(null);
    setNotice(null);
    try {
      const result = await revokePolicyConsent(undefined, { purge });
      setConfirming(null);
      if (purge) {
        setNotice(PURGED_NOTICE);
      } else {
        setNotice(result.hadActiveConsent ? REVOKED_NOTICE : '本设备当前没有有效的同意记录，无需撤回。');
      }
      // 处理成功后无条件重查：提示语之外，状态标签也必须反映服务端的真实结果。
      // 放在成功分支里，失败时的错误文案才不会被 loadStatus 开头的 setError(null) 抹掉。
      await loadStatus();
      await loadHistory();
    } catch (actionError) {
      setConfirming(null);
      setError(describeError(actionError, purge ? '删除同意记录失败，请稍后重试' : '撤回同意失败，请稍后重试'));
    } finally {
      setRevoking(false);
      setPurging(false);
    }
  };

  const busy = loading || revoking || purging;
  const presentation = status ? getStatusPresentation(status) : null;
  const missing = status ? missingPolicyAgreements(status.agreements) : [];
  const staleDocument = Boolean(
    status?.hasValidConsent && status.consentDocumentHash && status.documentHash && status.consentDocumentHash !== status.documentHash,
  );
  // 临近到期提前告知：同意是按设备记录的，到期后依赖同意的功能会直接要求重新勾选，
  // 等被拦下才知道不如提前说一声（7 天内提醒）。
  const remainingDays = daysUntil(status?.expiresAt);
  const expiringSoon = Boolean(status?.hasValidConsent && remainingDays !== null && remainingDays >= 0 && remainingDays <= 7);

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
            查看、撤回或删除<strong className="font-semibold text-slate-700">本设备</strong>对服务条款与隐私政策的同意。
            同意按浏览器设备记录，处理之后需要在本设备上重新逐项勾选条款，才能继续使用依赖同意的功能。
            条文原文见{' '}
            <Link to="/policy" className="font-semibold text-teal-700 underline-offset-2 hover:underline">
              服务条款与隐私政策
            </Link>
            。
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
      ) : credentialMissing ? (
        <div className="mt-4 flex items-start gap-2 rounded-2xl border border-slate-200 bg-slate-50/70 px-3.5 py-3.5 text-[13px] leading-6 text-slate-600 sm:text-sm">
          <FaShieldAlt className="mt-1 shrink-0 text-slate-400" />
          <span>
            本浏览器没有该设备的同意凭据（可能是在其他设备上同意过，或清除了站点数据），因此这里没有可撤回的同意。
            继续使用依赖同意的功能时，会被要求重新逐项勾选；也可以直接到{' '}
            <Link to="/policy" className="font-semibold text-teal-700 underline-offset-2 hover:underline">
              政策页
            </Link>{' '}
            就地同意。
          </span>
        </div>
      ) : status && presentation ? (
        <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50/70 px-3.5 py-3.5 sm:px-4">
          <div className="grid min-w-0 gap-3 sm:grid-cols-3">
            <div className="min-w-0">
              <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">当前政策版本</div>
              <div className="mt-1 break-words text-sm font-semibold text-slate-900">{status.currentVersion || status.version}</div>
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
            <div className="min-w-0">
              <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">同意时间与来源</div>
              <div className="mt-1 break-words text-xs text-slate-600">
                {status.recordedAt ? formatDateTime(status.recordedAt) : '无记录'}
                {status.recordedAt ? ` · ${sourceLabel(status.source)}` : ''}
              </div>
            </div>
          </div>

          {status.agreements.length > 0 || missing.length > 0 ? (
            <div className="mt-3 border-t border-slate-200/80 pt-3">
              <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">已勾选文件</div>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {status.agreements.map((key) => (
                  <span
                    key={key}
                    className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 text-[11px] font-medium text-emerald-700"
                  >
                    <FaCheckCircle className="text-[9px]" />
                    {describeAgreementKey(key)}
                  </span>
                ))}
                {missing.map((key) => (
                  <span
                    key={key}
                    className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-0.5 text-[11px] font-medium text-amber-700"
                  >
                    <FaExclamationTriangle className="text-[9px]" />
                    缺少 {describeAgreementKey(key)}
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          {staleDocument && (
            <p className="mt-3 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-5 text-amber-800">
              <FaExclamationTriangle className="mt-0.5 shrink-0" />
              <span>
                这条同意记录对应的条文与当前条文不是同一份（措辞更新过）。同意仍然有效，但建议重新阅读并在政策页重新同意。
              </span>
            </p>
          )}

          {expiringSoon && (
            <p className="mt-3 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-5 text-amber-800">
              <FaExclamationTriangle className="mt-0.5 shrink-0" />
              <span>
                本设备同意将在 {remainingDays === 0 ? '今天' : `约 ${remainingDays} 天后`}到期。
                到期后依赖同意的功能会要求重新逐项勾选（约 1 分钟），可现在就到{' '}
                <Link to="/policy" className="font-semibold underline underline-offset-2">
                  政策页
                </Link>{' '}
                重新同意。
              </span>
            </p>
          )}

          <p className="mt-3 break-words border-t border-slate-200/80 pt-3 text-xs leading-5 text-slate-500">
            {presentation.hint}
          </p>

          <div className="mt-3 space-y-3">
            {confirming === 'revoke' ? (
              <div className="rounded-2xl border border-amber-200 bg-amber-50 px-3.5 py-3">
                <p className="flex items-start gap-2 break-words text-[12px] leading-5 text-amber-800">
                  <FaExclamationTriangle className="mt-0.5 shrink-0" />
                  <span>{REVOKE_WARNING}</span>
                </p>
                <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                  <button
                    type="button"
                    onClick={() => {
                      void handleRevoke(false);
                    }}
                    disabled={revoking}
                    className={cn(studioDangerButtonClassName, 'w-full px-3 py-2 text-xs sm:w-auto')}
                  >
                    {revoking ? <FaSyncAlt className="animate-spin" /> : <FaExclamationTriangle />}
                    {revoking ? '正在撤回...' : '确认撤回本设备同意'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirming(null)}
                    disabled={revoking}
                    className={cn(studioSecondaryButtonClassName, 'w-full px-3 py-2 text-xs sm:w-auto')}
                  >
                    取消
                  </button>
                </div>
              </div>
            ) : confirming === 'purge' ? (
              <div className="rounded-2xl border border-rose-200 bg-rose-50 px-3.5 py-3">
                <p className="flex items-start gap-2 break-words text-[12px] leading-5 text-rose-800">
                  <FaTrashAlt className="mt-0.5 shrink-0" />
                  <span>{PURGE_WARNING}</span>
                </p>
                <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                  <button
                    type="button"
                    onClick={() => {
                      void handleRevoke(true);
                    }}
                    disabled={purging}
                    className={cn(studioDangerButtonClassName, 'w-full px-3 py-2 text-xs sm:w-auto')}
                  >
                    {purging ? <FaSyncAlt className="animate-spin" /> : <FaTrashAlt />}
                    {purging ? '正在删除...' : '确认删除全部记录'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirming(null)}
                    disabled={purging}
                    className={cn(studioSecondaryButtonClassName, 'w-full px-3 py-2 text-xs sm:w-auto')}
                  >
                    取消
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setNotice(null);
                    setConfirming('revoke');
                  }}
                  disabled={busy || !status.hasValidConsent}
                  className={cn(studioDangerButtonClassName, 'px-3 py-2 text-xs disabled:opacity-50')}
                  aria-label="撤回本设备的政策同意"
                  title="撤回本设备的政策同意"
                >
                  <FaExclamationTriangle />
                  撤回本设备同意
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setNotice(null);
                    setConfirming('purge');
                  }}
                  disabled={busy}
                  className={cn(studioSecondaryButtonClassName, 'px-3 py-2 text-xs disabled:opacity-50')}
                  aria-label="删除本设备的政策同意记录"
                  title="删除本设备在服务端的全部同意记录（不可恢复）"
                >
                  <FaTrashAlt />
                  删除本设备记录
                </button>
              </div>
            )}
          </div>
        </div>
      ) : null}

      {history && history.length > 0 && (
        <details className="group mt-4 rounded-2xl border border-slate-200 bg-slate-50/70 px-3.5 py-3.5 sm:px-4">
          <summary className="flex cursor-pointer items-center gap-2 text-xs font-semibold text-slate-600 transition hover:text-slate-800">
            <FaHistory className="text-slate-400" />
            本设备同意轨迹（最近 {history.length} 条）
            <FaChevronDown className="ml-auto text-[10px] text-slate-400 transition-transform group-open:rotate-180" />
          </summary>
          <ol className="mt-3 space-y-2.5">
            {history.map((entry) => {
              const state = HISTORY_STATE_LABELS[entry.state] ?? HISTORY_STATE_LABELS.expired;
              return (
                <li
                  key={entry.id}
                  className="rounded-xl border border-slate-200 bg-white/80 px-3 py-2.5 text-[11px] leading-5 text-slate-600"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold', state.className)}>
                      {state.label}
                    </span>
                    <span className="font-mono text-[10px] text-slate-500">v{entry.version}</span>
                    <span>{entry.recordedAt ? formatDateTime(entry.recordedAt) : '时间未记录'}</span>
                    <span className="text-slate-400">·</span>
                    <span>{sourceLabel(entry.source)}</span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span>
                      勾选：{entry.agreementsComplete ? '四份齐全' : `缺 ${entry.missingAgreements.length} 份`}
                    </span>
                    <span className="text-slate-400">·</span>
                    <span title={entry.consentDocumentHash ?? '早期记录没有条文指纹'}>
                      条文指纹：{entry.documentHashMatchesCurrent ? '与当前一致' : '与当前不一致'}
                    </span>
                    {entry.revokedAt && (
                      <>
                        <span className="text-slate-400">·</span>
                        <span className="text-rose-600">撤回于 {formatDateTime(entry.revokedAt)}</span>
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
          <p className="mt-2 text-[10px] leading-4 text-slate-400">
            {historyLoading ? '正在刷新轨迹…' : '轨迹由服务端按设备指纹记录，最多展示最近 10 条。'}
          </p>
        </details>
      )}
    </section>
  );
};

export default PrivacyConsentPanel;
