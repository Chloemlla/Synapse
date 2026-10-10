import React, { useCallback, useEffect, useState } from 'react';
import { FaCheck, FaExclamationCircle, FaShieldAlt, FaSpinner } from 'react-icons/fa';
import PolicyConsentChecklist from './PolicyConsentChecklist';
import { studioEyebrowClassName, studioPrimaryButtonClassName, studioSecondaryButtonClassName } from './studioTheme';
import { useFeatureConsent } from '../hooks/useFeatureConsent';
import { POLICY_CONSENT_REQUIRED_EVENT } from '../utils/policyConsent';
import {
  createPolicyConsentSelection,
  describeAgreementKey,
  isPolicyConsentComplete,
  type PolicyConsentSelection,
} from '../utils/policyConsent';

interface FeatureConsentGateProps {
  /** 门禁 key，与后端 config/featureConsent.ts 的 FEATURE_CONSENT_KEYS 一致 */
  feature: string;
  children: React.ReactNode;
}

const describeAgreements = (keys: readonly string[]): string =>
  keys.map(describeAgreementKey).join('、');

/** 到期时间只讲到天：同意有效期以天为单位，精确到秒对用户没有意义。 */
const formatExpiry = (value: string): string => {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return '';
  return new Date(timestamp).toLocaleDateString('zh-CN');
};

/**
 * 功能门禁：未同意时渲染同意清单，同意后放行 children。
 *
 * 判定与文案都来自 GET /api/policy/feature-consent（服务端按 userId 判），这里不自己算「开没开」——
 * 前端一旦自己判，就会与服务端的用户级口径分叉，出现「页面放行但请求 403」的错位体验。
 * 拉取失败时按未开通处理（fail-closed）：宁可让用户重试一次，也不放行一个证明不了已同意的面板。
 */
const FeatureConsentGate: React.FC<FeatureConsentGateProps> = ({ feature, children }) => {
  const { loading, ready, view, error, refresh, accept } = useFeatureConsent(feature);
  const [selection, setSelection] = useState<PolicyConsentSelection>(createPolicyConsentSelection);
  const [busy, setBusy] = useState(false);

  /**
   * 页面已打开后同意被撑销（同一会话或另一个标签页）时，里面的功能会收到 403 并发出这个事件。
   * 收到就重查一次：重查会把门禁切回同意清单，而不是让用户对着一句看不懂的错误发呆。
   */
  useEffect(() => {
    const onRequired = () => void refresh();
    window.addEventListener(POLICY_CONSENT_REQUIRED_EVENT, onRequired);
    return () => window.removeEventListener(POLICY_CONSENT_REQUIRED_EVENT, onRequired);
  }, [refresh]);

  const complete = isPolicyConsentComplete(selection);

  const handleAccept = useCallback(async () => {
    if (!complete || busy) return;
    setBusy(true);
    try {
      await accept();
    } finally {
      setBusy(false);
    }
  }, [accept, busy, complete]);

  // 先占位再放行：加载期间直接渲染 children 会闪出功能面板，而用户可能根本还没同意
  if (loading) {
    return (
      <div role="status" aria-live="polite" className="rounded-2xl border border-slate-200 bg-white/60 p-6">
        <p className="flex items-center gap-2 text-sm text-slate-500">
          <FaSpinner className="animate-spin" />
          正在确认该功能的开通状态...
        </p>
      </div>
    );
  }

  if (ready) return <>{children}</>;

  if (!view) {
    return (
      <div className="rounded-2xl border border-rose-200 bg-rose-50/70 p-4 text-left sm:p-5">
        <p className={studioEyebrowClassName}>功能开通确认</p>
        <p className="mt-1 break-words text-sm font-semibold text-slate-800">暂时无法确认该功能的开通状态</p>
        <p className="mt-1 break-words text-xs leading-5 text-slate-600">
          {error || '请稍后重试。'}
        </p>
        <button
          type="button"
          onClick={() => void refresh()}
          className={`${studioSecondaryButtonClassName} mt-3`}
        >
          重新获取
        </button>
      </div>
    );
  }

  const missing = view.missingAgreements;
  const expiry = view.expiresAt ? formatExpiry(view.expiresAt) : '';

  return (
    <div className="min-w-0 space-y-3 rounded-2xl border-2 border-amber-200 bg-amber-50/70 p-4 text-left sm:p-5">
      <div className="flex items-start gap-2">
        <FaShieldAlt className="mt-0.5 shrink-0 text-amber-500" />
        <div className="min-w-0 space-y-1">
          <p className={studioEyebrowClassName}>功能开通确认</p>
          <p className="break-words text-sm font-semibold text-slate-800">
            {view.label}需要先同意相关条款
          </p>
          <p className="break-words text-xs leading-5 text-slate-600">{view.message}</p>
        </div>
      </div>

      <div className="space-y-1 rounded-xl border border-amber-200 bg-white/70 px-3 py-2 text-xs leading-5 text-slate-600">
        {view.requiredAgreements.length > 0 && (
          <p>本功能需要：{describeAgreements(view.requiredAgreements)}</p>
        )}
        {missing.length > 0 && <p>还缺：{describeAgreements(missing)}</p>}
        {expiry && <p>上次同意已于 {expiry} 到期，请重新勾选。</p>}
        {view.policyVersion && <p>当前政策版本 v{view.policyVersion}。</p>}
        {/* 同意记录要求覆盖清单里的全部四项（与登录/注册同一份记录），不只本功能用到的那两份 */}
        <p>下面清单全部勾选后才能继续。</p>
        {view.rationale ? (
          <details>
            <summary className="cursor-pointer text-[11px] text-slate-500">为什么是这个功能要这几份文件</summary>
            <p className="mt-1 break-words text-[11px] leading-5 text-slate-500">{view.rationale}</p>
          </details>
        ) : null}
      </div>

      <PolicyConsentChecklist selection={selection} onChange={setSelection} disabled={busy} />

      {error && (
        <p className="flex items-center gap-1.5 break-words text-xs text-rose-600">
          <FaExclamationCircle className="shrink-0" />
          {error}
        </p>
      )}

      <button
        type="button"
        onClick={handleAccept}
        disabled={busy || !complete}
        className={`${studioPrimaryButtonClassName} w-full sm:w-auto`}
      >
        {busy ? (
          <>
            <FaSpinner className="animate-spin" />
            正在记录...
          </>
        ) : (
          <>
            <FaCheck />
            同意并继续
          </>
        )}
      </button>
    </div>
  );
};

export default FeatureConsentGate;
