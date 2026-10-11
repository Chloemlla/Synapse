import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useReducedMotion } from 'framer-motion';
import { FaCheck, FaSync, FaTrash } from 'react-icons/fa';
import { useAuth } from '../../hooks/useAuth';
import { isSuperAdmin } from '../../utils/rbac';
import { getBackendErrorMessage } from '../../utils/backendError';
import { useNotification } from '../Notification';
import { useConfirm } from '../confirm/ConfirmDialogProvider';
import CollapsibleSection from './CollapsibleSection';
import { ACCOUNT_RISK_API, SECURITY_SESSION_API, authFetch } from './api';
import { studioFieldClassName, studioPrimaryButtonClassName, studioSecondaryButtonClassName } from '../studioTheme';

/**
 * 风控策略的两个运行时可配分区（RC-06 / RC-40 / RC-41）：
 * - **账户风险聚合**：阈值与开关（关掉即不评分、不升档，用于故障注入与观察期）；
 * - **安全会话**：TTL（3～5 分钟）与绑定开关（UA 严格绑定、跨地跳变是否踢会话）。
 *
 * 为什么做成「字段描述 + 通用渲染」而不是写两遍表单：这两块都是「若干标量 + 保存/重置」，
 * 抄两遍的代价是下次加字段一定会漏改其中一处（仓库已有同类教训：新增场景只改了后端）。
 * 保存一律提交**差异字段**：后端以当前配置为默认值做归一化，因此不必回传整包，
 * 也不会因为界面少渲染一个字段把它重置成默认值。
 */

type FieldType = 'boolean' | 'number' | 'select';

interface FieldSpec {
  key: string;
  label: string;
  type: FieldType;
  hint?: string;
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
}

interface RiskPolicySectionProps {
  title: string;
  description: string;
  sectionKey: string;
  api: string;
  fields: FieldSpec[];
  /** 重置后的说明（回落到服务端默认值）。 */
  resetHint: string;
  successMessage: (draft: Record<string, unknown>) => string;
  prefersReducedMotion?: boolean | null;
}

function RiskPolicySection({
  title,
  description,
  sectionKey,
  api,
  fields,
  resetHint,
  successMessage,
  prefersReducedMotion: reducedMotionProp,
}: RiskPolicySectionProps) {
  const prefersReducedMotion = useReducedMotion() ?? reducedMotionProp;
  const { setNotification } = useNotification();
  const confirm = useConfirm();
  const { user } = useAuth();
  const canWrite = isSuperAdmin(user?.role);

  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<string | undefined>();
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const fetchedRef = useRef(false);

  const fetchConfig = useCallback(async () => {
    setLoading(true);
    try {
      const res = await authFetch(api, {});
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setNotification({ message: data.error || `获取${title}配置失败`, type: 'error' });
        return;
      }
      setDraft({ ...((data?.setting?.config || {}) as Record<string, unknown>) });
      setLoaded(true);
      setUpdatedAt(data?.setting?.updatedAt);
    } catch (error) {
      setNotification({
        message: `获取${title}配置失败：${getBackendErrorMessage(error, '未知错误')}。界面显示的值不代表服务器当前值，请先刷新成功后再保存。`,
        type: 'error',
      });
    } finally {
      setLoading(false);
    }
  }, [api, title, setNotification]);

  useEffect(() => {
    if (isOpen && !fetchedRef.current) {
      fetchedRef.current = true;
      void fetchConfig();
    }
  }, [isOpen, fetchConfig]);

  const save = useCallback(async () => {
    if (!canWrite || saving) return;
    if (!loaded) {
      setNotification({ message: '配置未加载，禁止保存：请先点「刷新」成功读取服务器配置。', type: 'error' });
      return;
    }
    setSaving(true);
    try {
      const res = await authFetch(api, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draft),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setNotification({ message: data.error || '保存失败', type: 'error' });
        return;
      }
      setNotification({ message: successMessage(draft), type: 'success' });
      await fetchConfig();
    } catch (error) {
      setNotification({ message: `保存失败：${getBackendErrorMessage(error, '未知错误')}`, type: 'error' });
    } finally {
      setSaving(false);
    }
  }, [canWrite, saving, loaded, api, draft, fetchConfig, setNotification, successMessage]);

  const reset = useCallback(async () => {
    if (!canWrite || deleting) return;
    if (
      !(await confirm({
        title: '确认执行该操作？',
        description: `确定重置${title}设置？${resetHint}`,
        tone: 'danger',
        confirmLabel: '重置',
      }))
    ) {
      return;
    }
    setDeleting(true);
    try {
      const res = await authFetch(api, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setNotification({ message: data.error || '重置失败', type: 'error' });
        return;
      }
      setNotification({ message: `已重置${title}设置`, type: 'success' });
      await fetchConfig();
    } catch (error) {
      setNotification({ message: `重置失败：${getBackendErrorMessage(error, '未知错误')}`, type: 'error' });
    } finally {
      setDeleting(false);
    }
  }, [canWrite, deleting, confirm, title, resetHint, api, fetchConfig, setNotification]);

  const statusText = useMemo(() => {
    if (!loaded) return '尚未读取到服务器配置';
    return updatedAt ? `最后保存：${new Date(updatedAt).toLocaleString('zh-CN')}` : '当前使用默认值';
  }, [loaded, updatedAt]);

  return (
    <CollapsibleSection
      title={title}
      description={description}
      sectionKey={sectionKey}
      isOpen={isOpen}
      onToggle={() => setIsOpen((v) => !v)}
      prefersReducedMotion={prefersReducedMotion}
      headerRight={<span className="text-xs text-slate-500">{statusText}</span>}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {fields.map((field) => {
          const raw = draft[field.key];
          if (field.type === 'boolean') {
            const value = raw !== false;
            return (
              <label key={field.key} className="flex items-start gap-3 rounded-2xl border-2 border-slate-200 bg-white/80 px-4 py-3">
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4"
                  checked={value}
                  disabled={!canWrite}
                  onChange={(event) => setDraft((prev) => ({ ...prev, [field.key]: event.target.checked }))}
                />
                <span>
                  <span className="block text-[13px] font-medium text-slate-700">{field.label}</span>
                  {field.hint ? <span className="mt-0.5 block text-[11px] text-slate-500">{field.hint}</span> : null}
                </span>
              </label>
            );
          }
          if (field.type === 'select') {
            return (
              <label key={field.key} className="text-[13px] text-slate-600">
                {field.label}
                <select
                  className={`${studioFieldClassName} mt-1`}
                  value={typeof raw === 'string' ? raw : ''}
                  disabled={!canWrite}
                  onChange={(event) => setDraft((prev) => ({ ...prev, [field.key]: event.target.value }))}
                >
                  {(field.options || []).map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                {field.hint ? <span className="mt-1 block text-[11px] text-slate-500">{field.hint}</span> : null}
              </label>
            );
          }
          return (
            <label key={field.key} className="text-[13px] text-slate-600">
              {field.label}
              <input
                type="number"
                className={`${studioFieldClassName} mt-1`}
                value={typeof raw === 'number' || typeof raw === 'string' ? String(raw) : ''}
                min={field.min}
                max={field.max}
                disabled={!canWrite}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  setDraft((prev) => ({ ...prev, [field.key]: Number.isFinite(next) ? next : prev[field.key] }));
                }}
              />
              {field.hint ? <span className="mt-1 block text-[11px] text-slate-500">{field.hint}</span> : null}
            </label>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={studioSecondaryButtonClassName} onClick={fetchConfig} disabled={loading}>
          <FaSync className={loading ? 'animate-spin' : ''} />
          刷新
        </button>
        <button type="button" className={studioPrimaryButtonClassName} onClick={save} disabled={saving || !canWrite || !loaded}>
          <FaCheck />
          {saving ? '保存中…' : '保存'}
        </button>
        <button type="button" className={studioSecondaryButtonClassName} onClick={reset} disabled={deleting || !canWrite}>
          <FaTrash />
          重置为默认
        </button>
        {!canWrite ? <span className="text-[11px] text-slate-500">只有超级管理员可以修改风控策略</span> : null}
      </div>
    </CollapsibleSection>
  );
}

const ACCOUNT_RISK_FIELDS: FieldSpec[] = [
  { key: 'enabled', label: '启用账户风险聚合', type: 'boolean', hint: '关闭后只保留字段，不评分、不自动升档（故障注入/观察期用）' },
  { key: 'stepUpEnabled', label: '启用逐步验证闸门', type: 'boolean', hint: '默认关闭；打开后被标记账户的写操作会要求人机验证' },
  { key: 'autoEscalationCap', label: '自动升档上限', type: 'select', hint: 'danger/banned 永远需要人工确认', options: [
    { value: 'watch', label: '仅到「观察」' },
    { value: 'restricted', label: '可到「受限」' },
  ] },
  { key: 'stepUpMode', label: '逐步验证范围', type: 'select', options: [
    { value: 'sensitive', label: '敏感操作' },
    { value: 'all-writes', label: '全部写操作' },
    { value: 'all', label: '全部请求（含读）' },
  ] },
  { key: 'watchScoreThreshold', label: '观察档阈值', type: 'number', min: 0, max: 100 },
  { key: 'restrictedScoreThreshold', label: '受限档阈值', type: 'number', min: 0, max: 100 },
  { key: 'highRiskIpScore', label: '高危登录 IP 判定分', type: 'number', min: 1, max: 100 },
  { key: 'minDistinctHighRiskIps', label: '触发多 IP 旗标的最少 IP 数', type: 'number', min: 1, max: 100 },
  { key: 'windowDays', label: '聚合窗口（天）', type: 'number', min: 1, max: 365 },
  { key: 'newAccountWatchDays', label: '新号观察期（天）', type: 'number', min: 0, max: 365 },
  { key: 'stepUpTtlSeconds', label: '逐步验证有效期（秒）', type: 'number', min: 60, max: 604800 },
  { key: 'stepUpChallengeTtlSeconds', label: '挑战票据有效期（秒）', type: 'number', min: 30, max: 3600 },
  { key: 'stepUpGrantTtlSeconds', label: 'Grant 有效期（秒）', type: 'number', min: 5, max: 600 },
  { key: 'stepUpGrantMaxUses', label: 'Grant 最大兑换次数', type: 'number', min: 1, max: 5 },
];

const SECURITY_SESSION_FIELDS: FieldSpec[] = [
  { key: 'ttlSeconds', label: '安全会话有效期（秒）', type: 'number', min: 60, max: 3600, hint: '建议 180～300 秒；越短越安全，但管理员会被更频繁地要求重新验证' },
  { key: 'bindUserAgent', label: '绑定客户端 UA', type: 'boolean', hint: 'UA 变化时该安全会话立即失效（防令牌被拿到另一环境重放）' },
  { key: 'revokeOnGeoJump', label: '跨地域跳变时终止会话', type: 'boolean', hint: '仅跨国家/省时终止并全站下线；同城换网只记录风险信号' },
];

export function AccountRiskPolicySection({ prefersReducedMotion }: { prefersReducedMotion?: boolean | null }) {
  return (
    <RiskPolicySection
      title="账户风险聚合与逐步验证"
      description="阈值全部运行时可调；被标记账户的写操作会要求人机验证（供应商由「人机验证供应商」页的 step_up 白名单决定）。"
      sectionKey="account-risk"
      api={ACCOUNT_RISK_API}
      fields={ACCOUNT_RISK_FIELDS}
      resetHint="重置后回落服务端默认值（聚合开启、自动升档上限为观察、逐步验证闸门关闭）。"
      successMessage={(draft) =>
        draft.stepUpEnabled === false
          ? '已保存：逐步验证闸门关闭，写操作不再被拦'
          : '已保存：新阈值立即生效（多实例 ≤ 10 秒收敛）'
      }
      prefersReducedMotion={prefersReducedMotion}
    />
  );
}

export function SecuritySessionPolicySection({ prefersReducedMotion }: { prefersReducedMotion?: boolean | null }) {
  return (
    <RiskPolicySection
      title="安全会话（敏感操作二次验证）"
      description="命令执行、密钥导出/轮换、双因素配置等敏感操作共用同一枚安全会话；TTL 与绑定策略在此调整。"
      sectionKey="security-session"
      api={SECURITY_SESSION_API}
      fields={SECURITY_SESSION_FIELDS}
      resetHint="重置后回落服务端默认值（5 分钟 TTL、UA 严格绑定、跨地跳变终止会话）。"
      successMessage={() => '已保存：安全会话策略立即生效'}
      prefersReducedMotion={prefersReducedMotion}
    />
  );
}
