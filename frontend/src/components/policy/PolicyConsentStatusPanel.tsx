import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  FaCheckCircle,
  FaExclamationCircle,
  FaExclamationTriangle,
  FaShieldAlt,
  FaSpinner,
  FaSyncAlt,
} from 'react-icons/fa';
import PolicyConsentChecklist from '../PolicyConsentChecklist';
import {
  DeviceCredentialRequiredError,
  fetchPolicyConsentStatus,
  recordPolicyConsent,
  type PolicyConsentStatus,
} from '../../api/policy';
import { getBackendErrorMessage } from '../../utils/backendError';
import {
  createPolicyConsentSelection,
  describeAgreementKey,
  isPolicyConsentComplete,
  type PolicyConsentSelection,
} from '../../utils/policyConsent';
import { cn } from '../../utils/cn';
import {
  InfoBadge,
  studioPrimaryButtonClassName,
  studioSecondaryButtonClassName,
  type InfoTone,
} from '../studioTheme';

/**
 * 政策页上的「本设备同意状态」卡片（从 PolicyPage 拆出）。
 *
 * 之前用户读完条文还要跳到个人中心才知道这台设备同意过没有（见
 * docs/audit-2026-09-30-policy-system.md P-17）；更糟的是，读完之后想在原地同意也没有入口。
 * 这里把两件事合在一起：展示状态 + 就地逐项勾选并提交同意。
 */

interface StatusPresentation {
  label: string;
  tone: InfoTone;
  hint: string;
}

const describeStatus = (status: PolicyConsentStatus, documentHash: string): StatusPresentation => {
  if (status.hasValidConsent) {
    const stale = Boolean(status.consentDocumentHash && documentHash && status.consentDocumentHash !== documentHash);
    return {
      label: '本设备已同意',
      tone: stale ? 'amber' : 'emerald',
      hint: stale
        ? '本设备的同意记录对应的是另一份条文（条文措辞更新过），建议重新逐项同意一次。'
        : '本设备可以继续使用依赖该同意的功能。',
    };
  }

  switch (status.reason) {
    case 'expired':
      return {
        label: '本设备同意已过期',
        tone: 'amber',
        hint: `此前记录的同意已于 ${status.expiresAt ? new Date(status.expiresAt).toLocaleString('zh-CN', { hour12: false }) : '到期时间'}过期，使用依赖同意的功能前需要重新同意。`,
      };
    case 'revoked':
      return {
        label: '本设备已撤回',
        tone: 'rose',
        hint: '本设备此前撤回过同意，依赖该同意的功能会要求重新逐项勾选。',
      };
    case 'incomplete':
      return {
        label: '勾选项不完整',
        tone: 'amber',
        hint: `库里的记录没有覆盖当前版本要求的全部文件${
          status.missingAgreements.length ? `（缺少：${status.missingAgreements.map(describeAgreementKey).join('、')}）` : ''
        }，需要重新同意。`,
      };
    case 'other-version':
      return {
        label: '记录属于旧版本',
        tone: 'amber',
        hint: `本设备最后一次同意的是 v${status.version}，与当前版本 v${status.currentVersion} 不同，需要按新条文重新同意。`,
      };
    default:
      return {
        label: '本设备尚未同意',
        tone: 'slate',
        hint: '本设备还没有当前版本的同意记录；使用依赖同意的功能时会要求逐项勾选。',
      };
  }
};

const PolicyConsentStatusPanel: React.FC<{ documentVersion: string; documentHash: string }> = ({
  documentVersion,
  documentHash,
}) => {
  const [status, setStatus] = useState<PolicyConsentStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // 本浏览器没有该设备的同意凭据（换设备 / 清了站点数据 / 从未在此同意过）：空状态，不是故障
  const [credentialMissing, setCredentialMissing] = useState(false);
  // 同意流程
  const [open, setOpen] = useState(false);
  const [selection, setSelection] = useState<PolicyConsentSelection>(createPolicyConsentSelection);
  const [showInvalid, setShowInvalid] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    try {
      const next = await fetchPolicyConsentStatus();
      setStatus(next);
      setCredentialMissing(false);
      setError(null);
    } catch (caught) {
      setStatus(null);
      if (caught instanceof DeviceCredentialRequiredError) {
        setCredentialMissing(true);
        setError(null);
      } else {
        setCredentialMissing(false);
        setError(getBackendErrorMessage(caught, '读取本设备的同意状态失败，请稍后重试'));
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const complete = isPolicyConsentComplete(selection);

  const handleAccept = async () => {
    if (!complete) {
      setShowInvalid(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const written = await recordPolicyConsent();
      setNotice(
        `已记录本设备对 v${written.version} 的同意${
          written.expiresAt ? `，有效期至 ${new Date(written.expiresAt).toLocaleString('zh-CN', { hour12: false })}` : ''
        }。`,
      );
      setOpen(false);
      setSelection(createPolicyConsentSelection());
      await loadStatus();
    } catch (caught) {
      setError(getBackendErrorMessage(caught, '记录同意失败，请稍后重试'));
    } finally {
      setBusy(false);
    }
  };

  const presentation = status ? describeStatus(status, documentHash) : null;

  return (
    <div className="rounded-2xl border border-slate-200 bg-white/80 p-4 print:hidden">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
            <FaShieldAlt />
            本设备同意状态
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {loading && !status ? (
              <InfoBadge tone="slate">
                <FaSyncAlt className="mr-1.5 animate-spin text-[10px]" /> 正在检查…
              </InfoBadge>
            ) : credentialMissing ? (
              <InfoBadge tone="slate">本浏览器没有该设备的同意凭据</InfoBadge>
            ) : presentation ? (
              <InfoBadge tone={presentation.tone}>{presentation.label}</InfoBadge>
            ) : (
              <InfoBadge tone="rose">状态读取失败</InfoBadge>
            )}
            <span className="text-xs text-slate-500">当前条文 v{documentVersion}</span>
          </div>
          <p className="mt-2 max-w-3xl text-xs leading-6 text-slate-500">
            {credentialMissing
              ? '本浏览器没有该设备的同意凭据（可能是在其他设备上同意过，或清除了站点数据）。可以在这里直接逐项同意，同意后本设备即持有新凭据。'
              : presentation?.hint ?? '同意按浏览器设备记录，换设备或清除站点数据后需要在本设备重新同意。'}
          </p>
        </div>

        <div className="flex shrink-0 flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void loadStatus()}
            disabled={loading || busy}
            className={cn(studioSecondaryButtonClassName, 'px-3 py-2 text-xs')}
          >
            <FaSyncAlt className={cn('text-[11px]', loading && 'animate-spin')} /> 刷新状态
          </button>
          {!status?.hasValidConsent && (
            <button
              type="button"
              onClick={() => {
                setNotice(null);
                setOpen((current) => !current);
              }}
              className={cn(studioPrimaryButtonClassName, 'px-3 py-2 text-xs')}
              aria-expanded={open}
            >
              <FaCheckCircle className="text-[11px]" />
              {open ? '收起同意清单' : '在页面内同意条款'}
            </button>
          )}
        </div>
      </div>

      {notice && (
        <p className="mt-3 flex items-start gap-2 rounded-2xl border border-emerald-200 bg-emerald-50 px-3.5 py-2.5 text-xs leading-5 text-emerald-700">
          <FaCheckCircle className="mt-0.5 shrink-0" />
          <span>{notice}</span>
        </p>
      )}

      {error && (
        <p className="mt-3 flex items-start gap-2 rounded-2xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-xs leading-5 text-rose-700">
          <FaExclamationCircle className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </p>
      )}

      {status?.hasValidConsent && status.missingAgreements.length > 0 && (
        <p className="mt-3 flex items-start gap-2 rounded-2xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-xs leading-5 text-amber-800">
          <FaExclamationTriangle className="mt-0.5 shrink-0" />
          <span>
            记录里缺少勾选项：{status.missingAgreements.map(describeAgreementKey).join('、')}。
            继续使用依赖同意的功能前会被要求重新逐项勾选。
          </span>
        </p>
      )}

      {open && (
        <div className="mt-4 space-y-3 border-t border-slate-200/80 pt-4">
          <p className="text-xs leading-6 text-slate-600">
            勾选下列四份文件后，同意会记录在服务端并绑定本设备（有效期 {status?.validityDays ?? 30} 天）。
            与登录/注册页的勾选清单完全一致；也可到
            <Link to="/profile" className="mx-1 font-semibold text-teal-700 underline-offset-2 hover:underline">
              个人中心 · 隐私与同意
            </Link>
            查看或撤回。
          </p>
          <PolicyConsentChecklist
            selection={selection}
            onChange={(next) => {
              setSelection(next);
              if (isPolicyConsentComplete(next)) setShowInvalid(false);
            }}
            showInvalid={showInvalid}
            disabled={busy}
          />
          <button
            type="button"
            onClick={() => void handleAccept()}
            disabled={busy || !complete}
            className={cn(studioPrimaryButtonClassName, 'w-full px-4 py-2 text-sm sm:w-auto')}
          >
            {busy ? (
              <>
                <FaSpinner className="animate-spin" /> 正在记录…
              </>
            ) : (
              <>
                <FaCheckCircle /> 同意并记录到本设备
              </>
            )}
          </button>
        </div>
      )}
    </div>
  );
};

export default PolicyConsentStatusPanel;
