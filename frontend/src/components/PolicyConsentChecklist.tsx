import React, { useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  FaCheckDouble,
  FaChevronDown,
  FaExclamationCircle,
  FaFileContract,
  FaGlobeAsia,
  FaScroll,
  FaShieldAlt,
} from 'react-icons/fa';
import { cn } from '../utils/cn';
import {
  POLICY_CONSENT_ITEMS,
  type PolicyAgreementKey,
  type PolicyConsentSelection,
  isPolicyConsentComplete,
} from '../utils/policyConsent';
import { usePolicyDocument } from '../hooks/usePolicyDocument';
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
  /** 是否在勾选项下内联展示每份文件的要点（默认展示；条文加载失败时自动隐藏） */
  showSummaries?: boolean;
}

/**
 * 登录 / 注册 / 功能门禁共用的四份政策文件勾选清单。
 *
 * 条款原文不在前端重复写：每一项都深链到 /policy 上带锚点的说明段落。
 * 为了让用户不必跳走就能知道「这份文件到底约定了什么」，这里从条文接口
 * （hooks/usePolicyDocument，进程内缓存）取每份文件的摘要与要点，折叠在勾选项下。
 */
const PolicyConsentChecklist: React.FC<PolicyConsentChecklistProps> = ({
  selection,
  onChange,
  showInvalid = false,
  disabled = false,
  showSummaries = true,
}) => {
  const allChecked = isPolicyConsentComplete(selection);
  const checkedCount = POLICY_CONSENT_ITEMS.filter((item) => selection[item.key]).length;
  const { document } = usePolicyDocument();

  // 键名 -> 条文里的文件说明；条文没拿到时摘要区整体不渲染，勾选流程不受影响
  const summaries = useMemo(() => {
    const map = new Map<string, { summary: string; points: string[] }>();
    for (const agreement of document?.agreements ?? []) {
      map.set(agreement.key, { summary: agreement.summary, points: agreement.points });
    }
    return map;
  }, [document]);

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
        <span className="flex flex-wrap items-center gap-1.5 text-xs font-medium text-slate-600">
          <FaCheckDouble className="text-slate-400" />
          请逐项勾选（已选 {checkedCount} / {POLICY_CONSENT_ITEMS.length}，全部勾选后才能提交）
          {document && (
            <span className="rounded-full border border-slate-200 bg-white/80 px-2 py-0.5 text-[10px] font-semibold text-slate-500">
              当前条文 v{document.version}
            </span>
          )}
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
          const detail = showSummaries ? summaries.get(item.key) : undefined;
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
              <div className="min-w-0 flex-1">
                <label htmlFor={`policy-consent-${item.key}`} className="flex min-w-0 flex-wrap items-center gap-x-1 text-xs leading-5 text-slate-700">
                  <span className="mt-0.5 mr-0.5 text-slate-400">{ITEM_ICONS[item.key]}</span>
                  <span className="cursor-pointer">{item.label}</span>
                  <Link
                    to={item.href}
                    target="_blank"
                    rel="noreferrer noopener"
                    onClick={e => e.stopPropagation()}
                    className={cn(authTextLinkClassName, 'text-xs')}
                  >
                    查看完整条文
                  </Link>
                </label>

                {detail && (
                  <details className="group mt-1.5">
                    <summary className="inline-flex cursor-pointer items-center gap-1 text-[11px] font-medium text-slate-500 transition hover:text-slate-700">
                      <FaChevronDown className="text-[9px] transition-transform group-open:rotate-180" />
                      这份文件约定了什么（{detail.points.length} 条要点）
                    </summary>
                    <div className="mt-1.5 space-y-1.5 rounded-xl border border-slate-200 bg-white/80 p-2.5">
                      <p className="text-[11px] leading-5 text-slate-600">{detail.summary}</p>
                      <ul className="space-y-1">
                        {detail.points.map(point => (
                          <li key={point} className="flex items-start gap-1.5 text-[11px] leading-5 text-slate-500">
                            <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-slate-300" />
                            <span>{point}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </details>
                )}
              </div>
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
