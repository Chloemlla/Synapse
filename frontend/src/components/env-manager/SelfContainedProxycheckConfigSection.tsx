import { useCallback, useEffect, useRef, useState } from 'react';
import { useReducedMotion } from 'framer-motion';
import { useAuth } from '../../hooks/useAuth';
import { isSuperAdmin } from '../../utils/rbac';
import { getBackendErrorMessage } from '../../utils/backendError';
import { useNotification } from '../Notification';
import { useConfirm } from '../confirm/ConfirmDialogProvider';
import ProxycheckConfigSection, {
  DEFAULT_PROXYCHECK_INPUTS,
  PROXYCHECK_NUMERIC_FIELDS,
  clampProxycheckNumber,
  isClearableProxycheckSecretKey,
  type ProxycheckClearableSecretKey,
  type ProxycheckInputs,
  type ProxycheckNumericKey,
  type ProxycheckSecretKey,
  type ProxycheckSectionState,
} from './ProxycheckConfigSection';
import { PROXYCHECK_API, getAuthHeaders, authFetch } from './api';

interface SelfContainedProxycheckConfigSectionProps {
  prefersReducedMotion?: boolean | null;
}

const SECRET_KEYS: ProxycheckSecretKey[] = ['apiKey', 'publicApiKey', 'payloadVerificationKey', 'hmacSecret'];

function pickNumericInput(cfg: Record<string, unknown>, key: ProxycheckNumericKey): string {
  const field = PROXYCHECK_NUMERIC_FIELDS.find((item) => item.key === key);
  if (!field) return DEFAULT_PROXYCHECK_INPUTS[key];
  const parsed = Number(cfg[key]);
  if (!Number.isFinite(parsed)) return String(field.fallback);
  return String(Math.min(field.max, Math.max(field.min, Math.round(parsed))));
}

function pickBoolean(cfg: Record<string, unknown>, key: 'enabled' | 'failOpen' | 'usePublicKeyForClient'): boolean {
  return typeof cfg[key] === 'boolean' ? (cfg[key] as boolean) : DEFAULT_PROXYCHECK_INPUTS[key];
}

function pickString(cfg: Record<string, unknown>, key: string): string {
  return typeof cfg[key] === 'string' ? (cfg[key] as string) : '';
}

/**
 * proxycheck.io IP 风险检测（PROXYCHECK）。四把密钥默认「留空 = 保留原值」，
 * 两把可清除的密钥另有「清除」开关（payload 传 null = 显式清除）；
 * 后端只回掩码 + hasXxx 布尔，明文永不回显。
 */
export default function SelfContainedProxycheckConfigSection({
  prefersReducedMotion: reducedMotionProp,
}: SelfContainedProxycheckConfigSectionProps) {
  const prefersReducedMotion = useReducedMotion() ?? reducedMotionProp;
  const { setNotification } = useNotification();
  const confirm = useConfirm();
  const { user } = useAuth();
  const canWrite = isSuperAdmin(user?.role);
  const [isOpen, setIsOpen] = useState(false);
  const fetchedRef = useRef(false);

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [inputs, setInputs] = useState<ProxycheckInputs>(DEFAULT_PROXYCHECK_INPUTS);
  const [current, setCurrent] = useState<ProxycheckSectionState | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | undefined>();
  /** 最近一次成功加载到的服务器值，用于判断「有未保存改动」；从未成功加载时为 null。 */
  const [serverInputs, setServerInputs] = useState<ProxycheckInputs | null>(null);
  const [clearKeys, setClearKeys] = useState<Set<ProxycheckClearableSecretKey>>(
    () => new Set<ProxycheckClearableSecretKey>(),
  );

  const handleInputChange = useCallback(
    <K extends keyof ProxycheckInputs>(key: K, value: ProxycheckInputs[K]) => {
      setInputs((prev) => {
        const next: ProxycheckInputs = { ...prev };
        next[key] = value;
        return next;
      });
    },
    [],
  );

  const handleToggleClearKey = useCallback(
    (key: ProxycheckClearableSecretKey) => {
      const willClear = !clearKeys.has(key);
      setClearKeys((prev) => {
        const next = new Set(prev);
        if (willClear) next.add(key);
        else next.delete(key);
        return next;
      });
      // 勾选清除时同步清掉该字段的新值输入，避免「既填新值又要清」的歧义。
      if (willClear) setInputs((prev) => (prev[key] ? { ...prev, [key]: '' } : prev));
    },
    [clearKeys],
  );

  const fetchConfig = useCallback(async () => {
    setLoading(true);
    try {
      const res = await authFetch(PROXYCHECK_API, { headers: { ...getAuthHeaders() } });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setNotification({ message: data.error || '获取 proxycheck.io 配置失败', type: 'error' });
        return;
      }
      const cfg: Record<string, unknown> = data?.setting?.config || {};
      const loadedInputs: ProxycheckInputs = {
        enabled: pickBoolean(cfg, 'enabled'),
        // 密钥输入框始终清空：留空保存即保留原值。
        apiKey: '',
        publicApiKey: '',
        payloadVerificationKey: '',
        hmacSecret: '',
        cacheTtlHours: pickNumericInput(cfg, 'cacheTtlHours'),
        timeoutMs: pickNumericInput(cfg, 'timeoutMs'),
        dailyQuotaPerKey: pickNumericInput(cfg, 'dailyQuotaPerKey'),
        challengeRiskScore: pickNumericInput(cfg, 'challengeRiskScore'),
        blockRiskScore: pickNumericInput(cfg, 'blockRiskScore'),
        failOpen: pickBoolean(cfg, 'failOpen'),
        usePublicKeyForClient: pickBoolean(cfg, 'usePublicKeyForClient'),
      };
      setInputs(loadedInputs);
      setServerInputs(loadedInputs);
      // 读到线上值就说明「清除」意图已结算或被放弃，复位开关。
      setClearKeys(new Set<ProxycheckClearableSecretKey>());
      setCurrent({
        enabled: pickBoolean(cfg, 'enabled'),
        apiKey: pickString(cfg, 'apiKey'),
        publicApiKey: pickString(cfg, 'publicApiKey'),
        payloadVerificationKey: pickString(cfg, 'payloadVerificationKey'),
        hmacSecret: pickString(cfg, 'hmacSecret'),
        hasApiKey: !!cfg.hasApiKey,
        hasPublicApiKey: !!cfg.hasPublicApiKey,
        hasPayloadVerificationKey: !!cfg.hasPayloadVerificationKey,
        hasHmacSecret: !!cfg.hasHmacSecret,
      });
      setUpdatedAt(data?.setting?.updatedAt);
    } catch (error) {
      setNotification({
        message: `获取 proxycheck.io 配置失败：${getBackendErrorMessage(error, '未知错误')}`,
        type: 'error',
      });
    } finally {
      setLoading(false);
    }
  }, [setNotification]);

  useEffect(() => {
    if (isOpen && !fetchedRef.current) {
      fetchedRef.current = true;
      fetchConfig();
    }
  }, [isOpen, fetchConfig]);

  const handleSave = useCallback(async () => {
    if (!canWrite) return;
    if (saving) return;
    // 配置未成功加载时 inputs 仍是默认值，保存会把线上真实开关与阈值静默重置。
    if (!current) {
      setNotification({ message: '配置未加载，禁止保存：请先点「刷新」成功读取服务器配置。', type: 'error' });
      return;
    }
    // 上游验签密钥必须是 64 字符（官方约定）；长度不符直接拦下，避免存进一把永远验不过的密钥。
    const payloadKeyValue = inputs.payloadVerificationKey.trim();
    if (
      !clearKeys.has('payloadVerificationKey') &&
      payloadKeyValue !== '' &&
      payloadKeyValue.length !== 64
    ) {
      setNotification({
        message: `API Payload Verification Key 须来自 proxycheck 官方 Dashboard，共 64 字符；当前为 ${payloadKeyValue.length} 字符，已中止保存。`,
        type: 'error',
      });
      return;
    }
    // 前端先按合法区间钳制，避免后端 400；空值/非法值回落该字段默认值。
    const numbers: Record<ProxycheckNumericKey, number> = {
      cacheTtlHours: 0,
      timeoutMs: 0,
      dailyQuotaPerKey: 0,
      challengeRiskScore: 0,
      blockRiskScore: 0,
    };
    let clamped = false;
    for (const field of PROXYCHECK_NUMERIC_FIELDS) {
      const value = clampProxycheckNumber(field, inputs[field.key]);
      const parsed = Number(inputs[field.key]);
      if (!Number.isFinite(parsed) || parsed !== value) clamped = true;
      numbers[field.key] = value;
    }

    const payload: Record<string, unknown> = {
      enabled: inputs.enabled,
      failOpen: inputs.failOpen,
      usePublicKeyForClient: inputs.usePublicKeyForClient,
      ...numbers,
    };
    for (const key of SECRET_KEYS) {
      // 显式清除：后端约定 null 表示置空（空串仍是「保留原值」）。
      if (isClearableProxycheckSecretKey(key) && clearKeys.has(key)) {
        payload[key] = null;
        continue;
      }
      const value = inputs[key].trim();
      if (value) payload[key] = value;
    }

    setSaving(true);
    try {
      const res = await authFetch(PROXYCHECK_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setNotification({ message: data.error || '保存失败', type: 'error' });
        return;
      }
      setNotification({
        message: clamped ? 'proxycheck.io 配置已保存（超区间的数值已按合法区间钳制）' : 'proxycheck.io 配置已保存',
        type: 'success',
      });
      await fetchConfig();
    } catch (error) {
      setNotification({ message: `保存失败：${getBackendErrorMessage(error, '未知错误')}`, type: 'error' });
    } finally {
      setSaving(false);
    }
  }, [canWrite, saving, current, clearKeys, inputs, fetchConfig, setNotification]);

  const handleReset = useCallback(async () => {
    if (!canWrite) return;
    if (deleting) return;
    if (
      !(await confirm({
          title: '确认执行该操作？',
          description: '确定重置 proxycheck.io IP 风险检测配置？重置后会回退到部署环境变量（PROXYCHECK_API_KEY / PROXYCHECK_PUBLIC_API_KEY / PROXYCHECK_PAYLOAD_VERIFICATION_KEY / PROXYCHECK_HMAC_SECRET），未设置则回到默认值（未启用）。',
          tone: 'danger',
          confirmLabel: '重置',
        }))
    ) {
      return;
    }
    setDeleting(true);
    try {
      const res = await authFetch(PROXYCHECK_API, { method: 'DELETE', headers: { ...getAuthHeaders() } });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setNotification({ message: data.error || '重置失败', type: 'error' });
        return;
      }
      setNotification({ message: '已重置 proxycheck.io IP 风险检测配置', type: 'success' });
      await fetchConfig();
    } catch (error) {
      setNotification({ message: `重置失败：${getBackendErrorMessage(error, '未知错误')}`, type: 'error' });
    } finally {
      setDeleting(false);
    }
  }, [canWrite, deleting, fetchConfig, setNotification]);

  // 有未保存改动：刷新会用服务器值覆盖表单，需要先二次确认。
  const dirty =
    serverInputs !== null &&
    (clearKeys.size > 0 ||
      (Object.keys(serverInputs) as (keyof ProxycheckInputs)[]).some(
        (key) => serverInputs[key] !== inputs[key],
      ));

  return (
    <ProxycheckConfigSection
      isOpen={isOpen}
      onToggle={() => setIsOpen((v) => !v)}
      prefersReducedMotion={prefersReducedMotion}
      loading={loading}
      saving={saving}
      deleting={deleting}
      disabled={!canWrite}
      inputs={inputs}
      current={current}
      updatedAt={updatedAt}
      dirty={dirty}
      clearKeys={clearKeys}
      onToggleClearKey={handleToggleClearKey}
      onInputChange={handleInputChange}
      onRefresh={fetchConfig}
      onSave={handleSave}
      onReset={handleReset}
    />
  );
}
