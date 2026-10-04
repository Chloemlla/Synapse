import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { FaCheck, FaExclamationCircle, FaSpinner, FaUserShield } from 'react-icons/fa';
import PolicyConsentChecklist from './PolicyConsentChecklist';
import { recordPolicyConsent } from '../api/policy';
import { usePolicyDocument } from '../hooks/usePolicyDocument';
import { getBackendErrorMessage } from '../utils/backendError';
import { studioEyebrowClassName, studioPrimaryButtonClassName } from './studioTheme';
import {
  createPolicyConsentSelection,
  isPolicyConsentComplete,
  type PolicyConsentSelection,
} from '../utils/policyConsent';
import { authTextLinkClassName } from './authStudioTheme';

interface TtsPolicyConsentPanelProps {
  /** 同意记录已落库后回调：调用方负责重新提交被拦下的那次生成 */
  onAccepted: () => void;
}

// 生成接口返回 TTS_POLICY_CONSENT_REQUIRED 时展开：条款原文在 /policy 上维护，
// 这里只负责逐项勾选 + 落库，然后把被拦下的生成交回给表单重试。
const TtsPolicyConsentPanel: React.FC<TtsPolicyConsentPanelProps> = ({ onAccepted }) => {
  const [selection, setSelection] = useState<PolicyConsentSelection>(createPolicyConsentSelection);
  const [showInvalid, setShowInvalid] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  // 条文已进程内缓存：这里只用来告诉用户正在同意的是哪个版本（取不到就不显示，不阻断流程）
  const { document: policyDocument } = usePolicyDocument();

  const complete = isPolicyConsentComplete(selection);

  const handleAccept = async () => {
    if (!complete) {
      setShowInvalid(true);
      return;
    }

    setBusy(true);
    setErrorMessage('');
    try {
      await recordPolicyConsent();
      onAccepted();
    } catch (error) {
      setErrorMessage(getBackendErrorMessage(error, '记录同意失败，请稍后重试'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-w-0 space-y-3 rounded-2xl border-2 border-amber-200 bg-amber-50/70 p-4 sm:p-5">
      <div className="flex items-start gap-2">
        <FaUserShield className="mt-0.5 shrink-0 text-amber-500" />
        <div className="min-w-0 space-y-1">
          <p className={studioEyebrowClassName}>政策确认</p>
          <p className="break-words text-sm font-semibold text-slate-800">
            本次生成被拦下：需要先确认最新版服务条款与隐私政策
          </p>
          <p className="break-words text-xs leading-5 text-slate-600">
            确认结果与当前设备绑定并保存在服务端，政策版本更新后会再次要求确认。
            {policyDocument ? `当前条文 v${policyDocument.version}。` : ''}
            条款原文见{' '}
            <Link to="/policy" target="_blank" rel="noreferrer noopener" className={authTextLinkClassName}>
              服务条款与隐私政策
            </Link>
            。
          </p>
        </div>
      </div>

      <PolicyConsentChecklist
        selection={selection}
        onChange={next => {
          setSelection(next);
          if (isPolicyConsentComplete(next)) setShowInvalid(false);
        }}
        showInvalid={showInvalid}
        disabled={busy}
      />

      {errorMessage && (
        <p className="flex items-center gap-1.5 break-words text-xs text-rose-600">
          <FaExclamationCircle className="shrink-0" />
          {errorMessage}
        </p>
      )}

      <button
        type="button"
        onClick={handleAccept}
        disabled={busy}
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
            同意并继续生成
          </>
        )}
      </button>
    </div>
  );
};

export default TtsPolicyConsentPanel;
