import { m } from 'framer-motion';
import { FaSync, FaInfoCircle, FaLock } from 'react-icons/fa';
import CollapsibleSection from './CollapsibleSection';
import InfoBox from './InfoBox';
import { useConfirm } from '../confirm/ConfirmDialogProvider';
import {
  studioFieldClassName,
  studioPrimaryButtonClassName,
  studioDangerButtonClassName,
} from '../studioTheme';
import type { ProxycheckConfigSetting } from './types';

const REFRESH_BUTTON_CLASS =
  'inline-flex items-center gap-2 rounded-2xl bg-slate-900 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400';

const SECTION_KEY = 'proxycheck';

export type ProxycheckSecretKey = 'apiKey' | 'publicApiKey' | 'payloadVerificationKey' | 'hmacSecret';
/** 可由「清除」开关显式置空的密钥；后端约定 payload 传 null 即显式清除。 */
export type ProxycheckClearableSecretKey = 'payloadVerificationKey' | 'hmacSecret';
export type ProxycheckNumericKey = 'cacheTtlHours' | 'timeoutMs' | 'dailyQuotaPerKey' | 'challengeRiskScore' | 'blockRiskScore';
type ProxycheckSwitchKey = 'failOpen' | 'usePublicKeyForClient';

/** 判断某密钥字段是否支持「显式清除」（用于收窄类型，避免调用方强转）。 */
export function isClearableProxycheckSecretKey(
  key: ProxycheckSecretKey,
): key is ProxycheckClearableSecretKey {
  return key === 'payloadVerificationKey' || key === 'hmacSecret';
}

/** 表单态：数值字段保留字符串，避免输入中途被钳制后无法继续输入。 */
export interface ProxycheckInputs {
  enabled: boolean;
  apiKey: string;
  publicApiKey: string;
  payloadVerificationKey: string;
  hmacSecret: string;
  cacheTtlHours: string;
  timeoutMs: string;
  dailyQuotaPerKey: string;
  challengeRiskScore: string;
  blockRiskScore: string;
  failOpen: boolean;
  usePublicKeyForClient: boolean;
}

/** 初始/重置兜底值，逐字对齐后端默认值（运行时配置契约 §1）。 */
export const DEFAULT_PROXYCHECK_INPUTS: ProxycheckInputs = {
  enabled: false,
  apiKey: '',
  publicApiKey: '',
  payloadVerificationKey: '',
  hmacSecret: '',
  cacheTtlHours: '24',
  timeoutMs: '8000',
  dailyQuotaPerKey: '1000',
  challengeRiskScore: '66',
  blockRiskScore: '90',
  failOpen: true,
  usePublicKeyForClient: true,
};

export interface ProxycheckNumericField {
  key: ProxycheckNumericKey;
  label: string;
  unit: string;
  min: number;
  max: number;
  step: number;
  fallback: number;
  hint: string;
}

/** 区间与默认值逐字对齐 normalizeStoredProxycheckConfig（运行时配置契约 §1）。 */
export const PROXYCHECK_NUMERIC_FIELDS: ProxycheckNumericField[] = [
  {
    key: 'cacheTtlHours',
    label: '同 IP 去重缓存 TTL',
    unit: '小时',
    min: 1,
    max: 168,
    step: 1,
    fallback: 24,
    hint: '同一 IP 在 TTL 内只查询一次上游，命中缓存时零上游请求。',
  },
  {
    key: 'timeoutMs',
    label: '上游请求超时',
    unit: '毫秒',
    min: 1000,
    max: 15000,
    step: 500,
    fallback: 8000,
    hint: '单次 proxycheck.io 请求的超时时间，超时按下方 failOpen 策略处理。',
  },
  {
    key: 'dailyQuotaPerKey',
    label: '每 key 每日查询上限',
    unit: '次/天',
    min: 100,
    max: 1000000,
    step: 100,
    fallback: 1000,
    hint: '达到上限后当日不再外呼 proxycheck.io，同样按 failOpen 策略处理。',
  },
  {
    key: 'challengeRiskScore',
    label: '触发挑战的风险分阈值',
    unit: '分',
    min: 0,
    max: 100,
    step: 1,
    fallback: 66,
    hint: 'IP 风险分大于等于该值时，首访验证会被提升为挑战（加严，不放宽）。',
  },
  {
    key: 'blockRiskScore',
    label: '直接阻断的风险分阈值',
    unit: '分',
    min: 0,
    max: 100,
    step: 1,
    fallback: 90,
    hint: 'IP 风险分大于等于该值时不再给验证机会，直接封禁该 IP：前后端请求都会被拦下，只展示阻断页与申诉入口。',
  },
];

export function clampProxycheckNumber(field: ProxycheckNumericField, raw: string): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return field.fallback;
  return Math.min(field.max, Math.max(field.min, Math.round(parsed)));
}

/** 区块只消费总开关与密钥字段：后端只回掩码串 + hasXxx 布尔。 */
export type ProxycheckSectionState = Pick<
  ProxycheckConfigSetting,
  | 'enabled'
  | 'apiKey'
  | 'publicApiKey'
  | 'payloadVerificationKey'
  | 'hmacSecret'
  | 'hasApiKey'
  | 'hasPublicApiKey'
  | 'hasPayloadVerificationKey'
  | 'hasHmacSecret'
>;

function proxycheckSecretsFromConfig(
  config: ProxycheckSectionState | null,
): { key: ProxycheckSecretKey; has: boolean; masked: string }[] {
  return [
    { key: 'apiKey', has: !!config?.hasApiKey, masked: config?.apiKey || '' },
    { key: 'publicApiKey', has: !!config?.hasPublicApiKey, masked: config?.publicApiKey || '' },
    {
      key: 'payloadVerificationKey',
      has: !!config?.hasPayloadVerificationKey,
      masked: config?.payloadVerificationKey || '',
    },
    { key: 'hmacSecret', has: !!config?.hasHmacSecret, masked: config?.hmacSecret || '' },
  ];
}

const SECRET_FIELDS: Array<{
  key: ProxycheckSecretKey;
  label: string;
  description: string;
  placeholder: string;
}> = [
  {
    key: 'apiKey',
    label: '服务端 API Key',
    description:
      'proxycheck.io 的服务端 key（4 段式，形如 111111-222222-333333-444444）。只在本服务后端使用，绝不下发到浏览器。',
    placeholder: '请输入新的服务端 API Key（不回显明文，留空保存表示保留原值）',
  },
  {
    key: 'publicApiKey',
    label: '浏览器公开 API Key',
    description:
      'proxycheck.io 的公开 key（形如 public-######-######-######），当「向浏览器下发公开 API Key」开启时供前端直连查询使用。虽是官方定义的公开 key，仍按脱敏处理。',
    placeholder: '请输入新的公开 API Key（不回显明文，留空保存表示保留原值）',
  },
  {
    key: 'payloadVerificationKey',
    label: 'API Payload Verification Key（响应验签）',
    description:
      '获取路径：proxycheck.io 官方 Dashboard → API Payload Verification Key。官方生成的响应验签密钥（64 字符）。上游在 HTTPS 响应头 http_x_signature 里回签响应体，本服务按 HMAC-SHA256(原始响应体, 该密钥) 逐字节比对；不通过就当上游失败，绝不采信未验签的结论。换 API Key 后该密钥会重新生成，需要同步更新。',
    placeholder: '请输入 64 字符的 API Payload Verification Key（不回显明文，留空保存表示保留原值）',
  },
  {
    key: 'hmacSecret',
    label: '自建 HMAC 验签主密钥',
    description:
      '本服务自建的主密钥，方向与上一项相反：服务端用它派生每会话密钥，校验浏览器上报的出口/IPv6/WebSocket 泄露探测结果。proxycheck.io 不参与，主密钥只留在服务端。',
    placeholder: '请输入新的 HMAC 主密钥（不回显明文，留空保存表示保留原值）',
  },
];

const TOGGLE_FIELDS: Array<{
  key: ProxycheckSwitchKey;
  label: string;
  description: string;
}> = [
  {
    key: 'failOpen',
    label: '上游失败时放行（failOpen）',
    description:
      '开启：proxycheck.io 超时、报错或超配额时视为无风险，不阻断访问。关闭：上游不可用时按有风险处理，可能误伤正常用户。',
  },
  {
    key: 'usePublicKeyForClient',
    label: '向浏览器下发公开 API Key',
    description:
      '开启：前端探测组件可通过 /api/ip-risk/probe-config 拿到公开 key 直连查询。关闭：前端只走本服务接口，不下发任何 key。',
  },
];

export interface ProxycheckConfigSectionProps {
  isOpen: boolean;
  onToggle: (key: string) => void;
  prefersReducedMotion?: boolean | null;
  disabled?: boolean;
  loading: boolean;
  saving: boolean;
  deleting: boolean;
  inputs: ProxycheckInputs;
  current: ProxycheckSectionState | null;
  updatedAt?: string;
  /** 存在未保存改动（表单值与最近一次加载到的服务器值不同）。 */
  dirty: boolean;
  /** 已勾选「清除」的密钥集合。 */
  clearKeys: Set<ProxycheckClearableSecretKey>;
  onToggleClearKey: (key: ProxycheckClearableSecretKey) => void;
  onInputChange: <K extends keyof ProxycheckInputs>(key: K, value: ProxycheckInputs[K]) => void;
  onRefresh: () => void;
  onSave: () => void;
  onReset: () => void;
}

export default function ProxycheckConfigSection({
  isOpen,
  onToggle,
  prefersReducedMotion,
  disabled = false,
  loading,
  saving,
  deleting,
  inputs,
  current,
  updatedAt,
  dirty,
  clearKeys,
  onToggleClearKey,
  onInputChange,
  onRefresh,
  onSave,
  onReset,
}: ProxycheckConfigSectionProps) {
  const confirm = useConfirm();
  const isDisabled = saving || deleting || disabled;
  const secrets = proxycheckSecretsFromConfig(current);
  // 已加载时以「已保存」的总开关为准，避免切了开关还没保存就误以为已生效。
  const savedEnabled = current ? current.enabled : inputs.enabled;
  // 配置尚未成功加载：inputs 仍是默认值，此时保存会把线上真实配置静默重置。
  const configLoaded = current !== null;
  const showNotLoadedNotice = !configLoaded && !loading;
  // 两把方向相反的密钥被填成同一串（线上事故形态）：脱敏串相同即告警。
  const secretsLookIdentical =
    !!current &&
    current.hasPayloadVerificationKey &&
    current.hasHmacSecret &&
    !!current.payloadVerificationKey &&
    current.payloadVerificationKey === current.hmacSecret;
  // 开关开着但没配公开 key：该开关是空承诺。
  const publicKeyMissing = !!current && inputs.usePublicKeyForClient && !current.hasPublicApiKey;

  const secretCurrentValue = (key: ProxycheckSecretKey): string => {
    if (loading) return '加载中...';
    // 加载失败与「确实没配」必须区分：否则运维会以为密钥丢失而重新粘贴。
    if (!current) return '—（未加载）';
    const entry = secrets.find((item) => item.key === key);
    if (!entry?.has) return '未配置';
    return entry.masked || '已配置';
  };

  const handleRefreshClick = async () => {
    if (dirty) {
      const ok = await confirm({
        title: '放弃未保存的改动？',
        description: '当前表单有尚未保存的改动，刷新会用服务器上的配置覆盖它们。',
        tone: 'danger',
        confirmLabel: '放弃并刷新',
      });
      if (!ok) return;
    }
    onRefresh();
  };

  return (
    <CollapsibleSection
      title="proxycheck.io IP 风险检测"
      description="配置 proxycheck.io 的服务端 key、浏览器公开 key、官方响应验签密钥、自建 HMAC 主密钥，以及同 IP 去重缓存、超时、每日配额与风险分阈值（运行时配置键 PROXYCHECK）。保存后立即生效，无需重启服务。"
      sectionKey={SECTION_KEY}
      isOpen={isOpen}
      onToggle={onToggle}
      prefersReducedMotion={prefersReducedMotion}
      headerRight={
        <m.button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            void handleRefreshClick();
          }}
          disabled={loading}
          className={REFRESH_BUTTON_CLASS}
          whileTap={{ scale: 0.95 }}
        >
          <FaSync className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> 刷新
        </m.button>
      }
    >
      {secretsLookIdentical && (
        <div role="alert" className="rounded-2xl border border-rose-300 bg-rose-50/90 p-3 text-sm text-rose-700">
          <strong>两把密钥的已脱敏值相同，疑似把「浏览器上报主密钥」填成了「上游验签密钥」</strong>
          <p className="mt-1 text-xs leading-5">
            这两把密钥方向相反：上游验签密钥必须来自 proxycheck.io 官方 Dashboard，自建主密钥由本服务自行生成。
            当前两处脱敏串完全一致，请核对后重新填写——上游验签密钥填错会让每一次查询都在验签阶段失败，
            并按 failOpen 策略静默放行。
          </p>
        </div>
      )}

      {showNotLoadedNotice && (
        <div role="alert" className="rounded-2xl border border-rose-200 bg-rose-50/80 p-3 text-sm text-rose-700">
          配置未加载，禁止保存：请先点右上角「刷新」成功读取服务器配置，否则保存会把界面上的默认值覆盖回线上。
        </div>
      )}
      <InfoBox icon={<FaInfoCircle />}>
        {savedEnabled ? (
          <p>
            已启用：首访验证会并入 proxycheck.io 的 IP 风险结论（只加严、不放宽），并对同一 IP 在缓存 TTL 内只查询一次上游。
          </p>
        ) : (
          <p>
            当前未启用：本服务<strong>不会</strong>向 proxycheck.io 发起任何请求，首访验证也不会引用 IP 风险结论，浏览器端拿不到任何 key。
          </p>
        )}
        {current !== null && savedEnabled !== inputs.enabled && (
          <p className="mt-1">
            下方的启用开关已改动但尚未保存，点击「保存/更新」后才会生效。
          </p>
        )}
      </InfoBox>

      <InfoBox icon={<FaLock />}>
        <p>
          <strong>两个方向的 HMAC，别混</strong>：「API Payload Verification Key」是 proxycheck.io
          官方 Dashboard 的字段（64 字符），验证的是<strong>上游响应</strong>确实来自 proxycheck 且中途未被篡改，
          本服务逐字节比对响应头 http_x_signature，不一致就按上游失败处理。
          「自建 HMAC 验签主密钥」方向相反，是本服务自己签发并校验<strong>浏览器上报</strong>的出口/IPv6/WebSocket
          泄露探测结果，proxycheck.io 不参与。服务端 key 与两把 HMAC 密钥绝不下发到浏览器。
        </p>
        <p className="mt-1">
          未配置自建主密钥时，探测会话端点返回 501、上报端点直接拒绝（403），不会静默跳过验签。
          未配置响应验签密钥时，不校验上游响应签名，只依赖 TLS。
        </p>
        <p className="mt-1">
          响应验签密钥必须是 64 字符（官方约定）。长度不符会在外呼前直接判为配置错误，不会拿一把永远验不过的密钥去发请求。
        </p>
      </InfoBox>

      <div className="rounded-2xl border border-slate-200 bg-white/80 p-3 sm:p-4">
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            checked={inputs.enabled}
            onChange={(event) => onInputChange('enabled', event.target.checked)}
            disabled={isDisabled}
            className="mt-1 h-4 w-4 shrink-0 rounded border-slate-300 text-slate-900 focus:ring-2 focus:ring-slate-300 disabled:cursor-not-allowed"
          />
          <span>
            <span className="block text-sm font-semibold text-slate-700">启用 proxycheck.io IP 风险检测</span>
            <span className="mt-1 block text-xs text-slate-500">
              关闭时不下发 key、不外呼上游；已保存的其它字段会保留，重新开启即继续生效。
            </span>
          </span>
        </label>
      </div>

      <div className="space-y-4">
        {SECRET_FIELDS.map((field) => {
          // 收窄成局部 const：属性访问的收窄不会带进 onChange 回调，局部 const 才会。
          const clearKey: ProxycheckClearableSecretKey | null = isClearableProxycheckSecretKey(field.key)
            ? field.key
            : null;
          const clearChecked = clearKey !== null && clearKeys.has(clearKey);
          return (
            <div key={field.key} className="rounded-2xl border border-slate-200 bg-white/80 p-3 sm:p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h4 className="text-sm font-semibold text-slate-700">{field.label}</h4>
                <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-600">
                  {field.key}
                </code>
              </div>
              <p className="mt-1 mb-3 text-xs text-slate-500">{field.description}</p>
              <div className="flex flex-col gap-2">
                <label className="text-sm font-medium text-slate-700" htmlFor={`proxycheck-${field.key}`}>
                  新值
                </label>
                <input
                  id={`proxycheck-${field.key}`}
                  type="password"
                  value={inputs[field.key]}
                  onChange={(event) => onInputChange(field.key, event.target.value)}
                  placeholder={field.placeholder}
                  className={studioFieldClassName}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={isDisabled || clearChecked}
                />
              </div>
              {clearKey !== null && (
                <label className="mt-2 flex items-start gap-2 text-xs text-rose-700">
                  <input
                    type="checkbox"
                    checked={clearKeys.has(clearKey)}
                    onChange={() => onToggleClearKey(clearKey)}
                    disabled={isDisabled}
                    className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300 text-rose-600 focus:ring-2 focus:ring-rose-200 disabled:cursor-not-allowed"
                  />
                  <span>
                    清除该密钥：保存后把该键置空（后端按「显式清除」处理）。用于密钥误填、需要彻底移除的场景；
                    留空保存仍然是「保留原值」。
                  </span>
                </label>
              )}
              <div className="mt-3 rounded-2xl border border-slate-200 bg-slate-50/80 px-3 py-2 text-xs text-slate-600 sm:px-4 sm:py-3">
                当前配置（脱敏）：{secretCurrentValue(field.key)}
                {clearChecked && <span className="ml-1 font-semibold text-rose-700">→ 保存后清除</span>}
              </div>
            </div>
          );
        })}
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {PROXYCHECK_NUMERIC_FIELDS.map((field) => (
          <div key={field.key}>
            <label className="mb-1 block text-sm font-medium text-slate-700" htmlFor={`proxycheck-${field.key}`}>
              {field.label}（{field.unit}）
            </label>
            <input
              id={`proxycheck-${field.key}`}
              type="number"
              min={field.min}
              max={field.max}
              step={field.step}
              value={inputs[field.key]}
              onChange={(event) => onInputChange(field.key, event.target.value)}
              disabled={isDisabled}
              autoComplete="off"
              className={studioFieldClassName}
            />
            <div className="mt-2 rounded-2xl border border-slate-200 bg-slate-50/80 px-3 py-2 text-xs text-slate-600">
              合法区间 {field.min}–{field.max} {field.unit}，默认 {field.fallback}。{field.hint}
            </div>
          </div>
        ))}
      </div>

      {publicKeyMissing && (
        <div role="status" className="rounded-2xl border border-amber-300 bg-amber-50/80 p-3 text-sm text-amber-900">
          未配置公开 API Key，本开关不会生效：请填写上方的「浏览器公开 API Key」，或关闭「向浏览器下发公开 API Key」。
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {TOGGLE_FIELDS.map((field) => (
          <div key={field.key} className="rounded-2xl border border-slate-200 bg-white/80 p-3 sm:p-4">
            <label className="flex items-start gap-3">
              <input
                type="checkbox"
                checked={inputs[field.key]}
                onChange={(event) => onInputChange(field.key, event.target.checked)}
                disabled={isDisabled}
                className="mt-1 h-4 w-4 shrink-0 rounded border-slate-300 text-slate-900 focus:ring-2 focus:ring-slate-300 disabled:cursor-not-allowed"
              />
              <span>
                <span className="block text-sm font-semibold text-slate-700">{field.label}</span>
                <span className="mt-1 block text-xs text-slate-500">{field.description}</span>
              </span>
            </label>
          </div>
        ))}
      </div>

      <div className="flex items-center justify-end gap-3">
        <m.button
          type="button"
          onClick={onReset}
          disabled={isDisabled}
          className={studioDangerButtonClassName}
          whileTap={{ scale: 0.97 }}
        >
          {deleting ? '重置中...' : '重置为默认值'}
        </m.button>
        <m.button
          type="button"
          onClick={onSave}
          disabled={isDisabled || !configLoaded}
          className={studioPrimaryButtonClassName}
          whileTap={{ scale: 0.97 }}
        >
          {saving ? '保存中...' : '保存/更新'}
        </m.button>
      </div>

      <div className="mt-1 text-xs text-slate-500">
        最后更新时间：{updatedAt ? new Date(updatedAt).toLocaleString() : '-'}
      </div>
    </CollapsibleSection>
  );
}
