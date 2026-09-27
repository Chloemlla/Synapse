import { getBackendErrorMessage } from '../../utils/backendError';
import { useCallback, useEffect, useRef, useState } from 'react';
import { m, useReducedMotion } from 'framer-motion';
import { FaLock, FaSync } from 'react-icons/fa';
import { useAuth } from '../../hooks/useAuth';
import { isSuperAdmin } from '../../utils/rbac';
import { useNotification } from '../Notification';
import CollapsibleSection from './CollapsibleSection';
import { API_URL, getAuthHeaders, authFetch } from './api';
import { decryptAES256 } from './utils';
import ConfigFieldRow from './ConfigFieldRow';
import InfoBox from './InfoBox';
import { studioPrimaryButtonClassName, studioTileClassName } from '../studioTheme';

const REFRESH_BUTTON_CLASS = studioPrimaryButtonClassName;

const SECTION_KEY = 'securitySecrets';

// F-01（2026-09-27）：数据静态加密根密钥——覆盖已有值会让存量密文永久解不开。
// 后端对这几个键的覆盖要求 confirmRotate:true；前端在已配置时先弹确认再带上该标志。
const DATA_AT_REST_ENCRYPTION_KEYS = new Set([
  'PASSWORD_ENCRYPTION_KEY',
  'BILIBILI_COOKIE_ENCRYPTION_KEY',
  'DATA_COLLECTION_RAW_SECRET',
]);

// 已统一由单一主密钥 AES_KEY 经 HKDF 按用途派生的内部密钥：留空即用派生子密钥，
// 仅在需要解密“用旧独立密钥加密的存量数据”或临时覆盖时才配置。LUMEN_ADMIN_AUTOMATION_TOKEN
// 是与 Lumen CI 共享的 Bearer 令牌（跨端契约），不在此列，仍需独立配置。
const REDIRECTED_TO_AES_KEY = new Set([
  'DATA_COLLECTION_RAW_SECRET',
  'BILIBILI_COOKIE_ENCRYPTION_KEY',
  'PASSWORD_ENCRYPTION_KEY',
  'POLICY_SECRET_SALT',
  'VERIFICATION_TOKEN_SECRET',
  'TTS_ASSET_ACCESS_SECRET',
  'LEGACY_API_CHOICE_SECRET',
]);

interface SecretField {
  key: string;
  altKeys: string[];
  label: string;
  description: string;
  placeholder: string;
}

const SECRET_FIELDS: SecretField[] = [
  {
    key: 'DATA_COLLECTION_RAW_SECRET',
    altKeys: [],
    label: '数据采集加密密钥',
    description:
      '用于加密数据采集环节的原始记录，确保落盘数据脱敏与传输加密。对应环境变量 DATA_COLLECTION_RAW_SECRET。',
    placeholder: '请输入至少 16 位的随机字符串',
  },
  {
    key: 'BILIBILI_COOKIE_ENCRYPTION_KEY',
    altKeys: [],
    label: 'Bilibili Cookie 加密密钥',
    description:
      '用于 AES-256-GCM 加密 Bilibili 账号 Cookie 的独立密钥，与 PASSWORD_ENCRYPTION_KEY 隔离。对应环境变量 BILIBILI_COOKIE_ENCRYPTION_KEY。',
    placeholder: '请输入至少 32 位的随机字符串',
  },
  {
    key: 'PASSWORD_ENCRYPTION_KEY',
    altKeys: [],
    label: '密码加密密钥',
    description:
      '用于对用户密码密文进行加密保护的独立密钥，与数据采集加密隔离。对应环境变量 PASSWORD_ENCRYPTION_KEY。',
    placeholder: '请输入至少 32 位的随机字符串',
  },
  {
    key: 'POLICY_SECRET_SALT',
    altKeys: [],
    label: '策略密钥盐值',
    description:
      '安全密钥隔离场景下用于派生策略级密钥的全局盐值。对应环境变量 POLICY_SECRET_SALT。',
    placeholder: '请输入随机盐值字符串',
  },
  {
    key: 'VERIFICATION_TOKEN_SECRET',
    altKeys: [],
    label: '验证令牌签名密钥',
    description:
      '用于签名/校验验证类令牌（邮件、手机号等验证流程）的独立密钥。对应环境变量 VERIFICATION_TOKEN_SECRET。',
    placeholder: '请输入用于签名验证令牌的密钥',
  },
  {
    key: 'TTS_ASSET_ACCESS_SECRET',
    altKeys: [],
    label: 'TTS 资产访问密钥',
    description:
      '用于校验对 TTS 音频资产的访问请求，防止未授权拉取。对应环境变量 TTS_ASSET_ACCESS_SECRET。',
    placeholder: '请输入 TTS 资产访问校验密钥',
  },
  {
    key: 'LEGACY_API_CHOICE_SECRET',
    altKeys: [],
    label: '旧版 API 选择密钥',
    description:
      '用于在密钥隔离机制下切换/访问旧版 API 的授权密钥。对应环境变量 LEGACY_API_CHOICE_SECRET。',
    placeholder: '请输入旧版 API 授权密钥',
  },
  {
    key: 'LUMEN_ADMIN_AUTOMATION_TOKEN',
    altKeys: [],
    label: 'Lumen 发布自动化令牌',
    description:
      'Lumen 客户端 CI 同步发布清单到 /api/lumen/admin/actions 时使用的 Bearer 令牌。对应环境变量 LUMEN_ADMIN_AUTOMATION_TOKEN，保存后立即生效，无需重启后端。',
    placeholder: '请输入与 PROJECT_LUMEN_ADMIN_TOKEN 相同的随机令牌',
  },
];

function normalizeEnvKey(rawKey: string): string {
  const parts = rawKey.split(':');
  return parts.length > 1 ? parts[parts.length - 1] : rawKey;
}

function matchesSecretField(candidateKey: string, field: SecretField): boolean {
  const normalized = normalizeEnvKey(candidateKey).toUpperCase();
  if (normalized === field.key) return true;
  return field.altKeys.some((altKey) => normalized === altKey);
}

function maskSecret(value: string): string {
  if (!value) return '未设置';
  if (value.length <= 8) return '已设置';
  return `${value.slice(0, 2)}***${value.slice(-4)}`;
}

export interface SecuritySecretSectionProps {
  isOpen: boolean;
  onToggle: (key: string) => void;
  loading: boolean;
  onRefresh: () => void;
  disabled?: boolean;
}

export default function SecuritySecretSection({
  isOpen,
  onToggle,
  loading,
  onRefresh,
  disabled = false,
}: SecuritySecretSectionProps) {
  const prefersReducedMotion = useReducedMotion();
  const { setNotification } = useNotification();
  const { user } = useAuth();
  const canWrite = isSuperAdmin(user?.role);

  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [current, setCurrent] = useState<Record<string, string>>({});
  const [fetching, setFetching] = useState(false);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);
  const fetchedRef = useRef(false);

  const fetchValues = useCallback(async () => {
    setFetching(true);
    try {
      const res = await authFetch(API_URL, { headers: getAuthHeaders() });
      const data = await res.json().catch(() => ({}));
      const next: Record<string, string> = {};
      if (res.ok && data) {
        let envList: Array<{ key: string; value: unknown }> = [];
        // G11-15: GET /api/admin/envs 对管理员返回 AES-256-CBC 加密载荷 { data, iv }，
        // 需按旧版 EnvManager 的解密逻辑还原后再匹配字段，否则当前值恒为“未设置”。
        if (typeof data.data === 'string' && data.data && typeof data.iv === 'string' && data.iv) {
          if (!user?.id) {
            setNotification({ message: '缺少用户标识，无法解密数据', type: 'error' });
            return;
          }
          try {
            const decryptedJson = decryptAES256(data.data, data.iv, user.id);
            const decryptedData = JSON.parse(decryptedJson);
            if (Array.isArray(decryptedData)) envList = decryptedData;
          } catch {
            // 解密失败时保留现有展示，不阻塞保存/删除操作。
          }
        } else if (Array.isArray(data.envs)) {
          envList = data.envs;
        } else if (data.envs && typeof data.envs === 'object') {
          envList = Object.entries(data.envs).map(([key, value]) => ({ key, value }));
        }
        for (const field of SECRET_FIELDS) {
          const item = envList.find((entry) => matchesSecretField(String(entry.key), field));
          const raw = item?.value;
          if (typeof raw === 'string' && raw.trim()) {
            next[field.key] = raw;
          }
        }
      }
      setCurrent(next);
    } catch {
      // 读取失败时保留现有展示，不阻塞保存/删除操作。
    } finally {
      setFetching(false);
    }
  }, [setNotification, user?.id]);

  useEffect(() => {
    if (isOpen && !fetchedRef.current) {
      fetchedRef.current = true;
      void fetchValues();
    }
  }, [isOpen, fetchValues]);

  const handleRefresh = useCallback(() => {
    fetchedRef.current = true;
    void fetchValues();
    onRefresh();
  }, [fetchValues, onRefresh]);

  const handleSave = useCallback(
    async (key: string) => {
      if (!canWrite) return;
      if (savingKey) return;
      const value = (inputs[key] || '').trim();
      if (!value) {
        setNotification({ message: '请填写密钥值后再保存', type: 'error' });
        return;
      }
      setSavingKey(key);
      try {
        // F-01: 轮换数据静态加密根密钥（已配置过）会静默损坏存量密文，先显式确认。
        const isRotation = DATA_AT_REST_ENCRYPTION_KEYS.has(key) && Boolean(current[key]);
        if (isRotation) {
          const ok = window.confirm(
            `${key} 已配置。它直接解密已落库的存量密文，轮换后旧数据将永久无法解密（需自行重加密）。\n\n确定要轮换吗？`,
          );
          if (!ok) {
            setSavingKey(null);
            return;
          }
        }
        const res = await authFetch(API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
          body: JSON.stringify(isRotation ? { key, value, confirmRotate: true } : { key, value }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setNotification({ message: data?.error || `保存 ${key} 失败`, type: 'error' });
          return;
        }
        setNotification({ message: `${key} 已保存并写入运行时配置`, type: 'success' });
        setInputs((prev) => ({ ...prev, [key]: '' }));
        await fetchValues();
        onRefresh();
      } catch (error) {
        setNotification({
          message: `保存 ${key} 失败：${getBackendErrorMessage(error, '未知错误')}`,
          type: 'error',
        });
      } finally {
        setSavingKey(null);
      }
    },
    [canWrite, inputs, current, savingKey, fetchValues, onRefresh, setNotification],
  );

  const handleDelete = useCallback(
    async (key: string) => {
      if (!canWrite) return;
      if (deletingKey) return;
      if (!window.confirm(`确定删除环境变量「${key}」？对应密钥隔离/加密能力可能立即失效。`)) return;
      setDeletingKey(key);
      try {
        // G11-15: 后端只注册 DELETE /envs（body 传 key）与 POST /envs/delete，路径式删除 404。
        const res = await authFetch(API_URL, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
          body: JSON.stringify({ key }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setNotification({ message: data?.error || `删除 ${key} 失败`, type: 'error' });
          return;
        }
        setNotification({ message: `${key} 已删除`, type: 'success' });
        setInputs((prev) => ({ ...prev, [key]: '' }));
        await fetchValues();
        onRefresh();
      } catch (error) {
        setNotification({
          message: `删除 ${key} 失败：${getBackendErrorMessage(error, '未知错误')}`,
          type: 'error',
        });
      } finally {
        setDeletingKey(null);
      }
    },
    [canWrite, deletingKey, fetchValues, onRefresh, setNotification],
  );

  const refreshing = fetching || loading;
  const busy = savingKey !== null || deletingKey !== null;

  return (
    <CollapsibleSection
      title="安全密钥隔离与数据采集加密"
      description="这些内部密钥已统一由单一主密钥 AES_KEY 经 HKDF 按用途派生：留空即用派生子密钥，无需单独配置。仅当需要解密用旧独立密钥加密的存量数据，或想临时覆盖某一项时才在此填写（保存即写入运行时配置并立即生效）。LUMEN_ADMIN_AUTOMATION_TOKEN 为与 Lumen CI 共享的令牌，仍需独立配置。"
      sectionKey={SECTION_KEY}
      isOpen={isOpen}
      onToggle={onToggle}
      prefersReducedMotion={prefersReducedMotion}
      headerRight={
        <m.button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            handleRefresh();
          }}
          disabled={refreshing}
          className={REFRESH_BUTTON_CLASS}
          whileTap={{ scale: 0.95 }}
        >
          <FaSync className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} /> 刷新
        </m.button>
      }
    >
      <InfoBox icon={<FaLock />}>
        <p>
          <strong>已统一为单一主密钥 AES_KEY。</strong>
          下列内部密钥（数据采集加密、Bilibili Cookie 加密、密码 KEK、策略盐、验证令牌、TTS 资产访问、旧版 API 选择）
          均由 <code className="rounded bg-white/80 px-1">AES_KEY</code> 经 HKDF 按用途派生；在上方“查看密钥”可验证后查看每个派生子密钥。
        </p>
        <p className="mt-1">
          <strong>无需在此单独配置。</strong>仅当（1）需要解密用旧独立密钥加密的存量密文，或（2）临时覆盖某项时才填写；
          填写后会覆盖该项的派生值。带 <span className="font-semibold">“已并入 AES_KEY”</span> 徽标的项留空即可。
        </p>
        <p className="mt-1 text-slate-500">
          <code className="rounded bg-white/80 px-1">LUMEN_ADMIN_AUTOMATION_TOKEN</code> 是与 Lumen CI 共享的令牌（跨端契约），不由 AES_KEY 派生，仍需独立配置。
        </p>
      </InfoBox>

      <div className="space-y-4">
        {SECRET_FIELDS.map((field) => (
          <div key={field.key} className={`${studioTileClassName} p-3 sm:p-4`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 className="text-sm font-semibold text-slate-700">{field.label}</h4>
              <div className="flex items-center gap-2">
                {REDIRECTED_TO_AES_KEY.has(field.key) ? (
                  <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[11px] text-emerald-700">已并入 AES_KEY（可留空）</span>
                ) : null}
                <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-600">
                  {field.key}
                </code>
              </div>
            </div>
            <p className="mt-1 mb-3 text-xs text-slate-500">{field.description}</p>

            <ConfigFieldRow
              inputLabel="新值"
              value={inputs[field.key] || ''}
              onChange={(v) => setInputs((prev) => ({ ...prev, [field.key]: v }))}
              placeholder={field.placeholder}
              currentLabel="当前配置（脱敏）"
              currentValue={maskSecret(current[field.key] || '')}
              loading={fetching}
              isSaving={savingKey === field.key}
              isDeleting={deletingKey === field.key}
              busy={busy}
              onSave={() => handleSave(field.key)}
              onDelete={() => handleDelete(field.key)}
              readOnly={disabled}
              isPassword
            />
          </div>
        ))}
      </div>
    </CollapsibleSection>
  );
}