import React from 'react';
import { Link } from 'react-router-dom';
import { FaCheckDouble, FaExclamationCircle, FaFileContract, FaGlobeAsia, FaScroll, FaShieldAlt } from 'react-icons/fa';
import { cn } from '../utils/cn';
import {
  POLICY_CONSENT_ITEMS,
  type PolicyAgreementKey,
  type PolicyConsentSelection,
  isPolicyConsentComplete,
} from '../utils/policyConsent';
import { authCheckboxClassName, authTextLinkClassName } from './authStudioTheme';

const ITEM_ICONS: Record<PolicyAgreementKey, React.ReactNode> = {
  terms: <FaFileContract />,
  usage: <FaShieldAlt />,
  'specific-terms': <FaScroll />,
  'supported-regions': <FaGlobeAsia />,
};

interface PolicyConsentChecklistProps {
  selection: PolicyConsentSelection;
  onChange: (selection: PolicyConsentSelection) => void;
  /** 提交被拦下后置为 true：给未勾选项加红色边框与提示，而不是只弹一条通知 */
  showInvalid?: boolean;
  disabled?: boolean;
}

// 登录与注册共用的四份政策文件勾选清单。条款原文不在这里重复写，
// 每一项都深链到 /policy 上带锚点的说明段落（在后端政策文档里维护）。
const PolicyConsentChecklist: React.FC<PolicyConsentChecklistProps> = ({ selection, onChange, showInvalid = false, disabled = false }) => {
  const allChecked = isPolicyConsentComplete(selection);

  const toggle = (key: PolicyAgreementKey) => {
    onChange({ ...selection, [key]: !selection[key] });
  };

  const toggleAll = () => {
    const next = !allChecked;
    onChange(Object.keys(selection).reduce((acc, key) => {
      acc[key as PolicyAgreementKey] = next;
      return acc;
    }, {} as PolicyConsentSelection));
  };

  return (
    <div
      className={cn(
        'rounded-2xl border p-3.5 text-left transition-colors',
        showInvalid && !allChecked ? 'border-rose-300 bg-rose-50/70' : 'border-slate-200 bg-slate-50/70',
      )}
    >
      <div className="mb-2.5 flex items-center justify-between gap-3">
        <span className="flex items-center gap-1.5 text-xs font-medium text-slate-600">
          <FaCheckDouble className="text-slate-400" />
          请逐项勾选（共 {POLICY_CONSENT_ITEMS.length} 项，全部勾选后才能提交）
        </span>
        <button
          type="button"
          onClick={toggleAll}
          disabled={disabled}
          className="shrink-0 text-xs font-medium text-teal-700 transition-colors hover:text-teal-900 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {allChecked ? '取消全选' : '全部勾选'}
        </button>
      </div>

      <ul className="space-y-2">
        {POLICY_CONSENT_ITEMS.map(item => {
          const checked = selection[item.key];
          return (
            <li key={item.key} className="flex items-start gap-2.5">
              <input
                id={`policy-consent-${item.key}`}
                name={`policyConsent-${item.key}`}
                type="checkbox"
                checked={checked}
                disabled={disabled}
                onChange={() => toggle(item.key)}
                aria-label={item.label}
                aria-required="true"
                className={cn(authCheckboxClassName, 'mt-0.5')}
              />
              <label htmlFor={`policy-consent-${item.key}`} className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1 text-xs leading-5 text-slate-700">
                <span className="mt-0.5 mr-0.5 text-slate-400">{ITEM_ICONS[item.key]}</span>
                <span className="cursor-pointer">{item.label}</span>
                <Link
                  to={item.href}
                  target="_blank"
                  rel="noreferrer noopener"
                  onClick={e => e.stopPropagation()}
                  className={cn(authTextLinkClassName, 'text-xs')}
                >
                  查看条文
                </Link>
              </label>
            </li>
          );
        })}
      </ul>

      {showInvalid && !allChecked && (
        <p className="mt-2.5 flex items-center gap-1.5 text-xs text-rose-600">
          <FaExclamationCircle />
          请先阅读并勾选全部四项，再继续提交
        </p>
      )}
    </div>
  );
};

export default PolicyConsentChecklist;
