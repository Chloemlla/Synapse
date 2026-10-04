import React, { Suspense, lazy, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { FaCheckCircle, FaExclamationTriangle, FaRedo, FaShieldAlt } from 'react-icons/fa';
import { useSecureCaptchaSelection } from '../hooks/useSecureCaptchaSelection';
import { getFingerprint } from '../utils/fingerprint';
import { CaptchaType, getCaptchaDisplayName } from '../utils/captchaSelection';
import { SimpleLoadingSpinner } from './LoadingSpinner';

// 按后端选中的供应商懒加载对应控件，不把三家 SDK 都塞进首屏。
const TurnstileWidget = lazy(() =>
  import('./TurnstileWidget').then((module) => ({ default: module.TurnstileWidget })),
);
const HCaptchaWidget = lazy(() => import('./HCaptchaWidget'));
const CapWidget = lazy(() => import('./CapWidget'));

/**
 * ManagedCaptcha —— 后台页面（登录/注册/忘记密码/重置密码/TTS/图床/抽奖/资源商店…）
 * **共用同一套人机验证下发链路**的控件。
 *
 * 链路：浏览器指纹 → `POST /api/turnstile/secure-captcha-config`（管理端按供应商上线状态、
 * 权重、优先级、场景策略与月度额度选出供应商）→ 按供应商渲染控件 → 控件解出挑战后把
 * `{ token, provider }` 交给页面，由页面随自己的请求提交（后端用同一个入口按供应商校验）。
 *
 * 页面只需要：
 * 1. 渲染 `<ManagedCaptcha onSolved={...} onCleared={...} />`；
 * 2. 用一个状态存放 `{ token, provider }`，提交时把 `captchaToken` 与 `captchaProvider` 一起发出去；
 * 3. 用 `required`（onStatusChange 回调）决定「没解出挑战时是否禁用提交」。
 *
 * 供应商的上下线、权重、外观（theme/size/语言/署名）全部由 /admin/captcha-providers 调控，
 * 页面不再各自读取 Turnstile 配置。
 */

export interface ManagedCaptchaChallenge {
  token: string;
  provider: CaptchaType;
}

export interface ManagedCaptchaStatus {
  /** 管理端当前是否要求人机验证（三家都没凭据/全下线时为 false，页面应放行提交）。 */
  required: boolean;
  /** 正在解析下发的供应商配置。 */
  loading: boolean;
  /** 选择层/控件层的错误文案（非空时页面应禁用提交并提示）。 */
  error: string | null;
  /** 当前选中的供应商（未就绪时为 null）。 */
  provider: CaptchaType | null;
  /** 当前挑战是否已解出（页面据此决定是否禁用提交）。 */
  solved: boolean;
}

export interface ManagedCaptchaProps {
  /** 下发场景：内容页用默认 default；首访门禁 first_visit；独立验证页 standalone。 */
  scenario?: 'default' | 'first_visit' | 'standalone';
  /** 挑战解出：页面保存 `{ token, provider }` 并随自己的请求提交。 */
  onSolved?: (challenge: ManagedCaptchaChallenge) => void;
  /** 挑战过期/失败/被重置：页面应清掉已持有的令牌。 */
  onCleared?: () => void;
  /** 状态变化：页面据此决定提交按钮的可用性与错误提示。 */
  onStatusChange?: (status: ManagedCaptchaStatus) => void;
  /** 紧凑模式（表单内嵌时用）。 */
  compact?: boolean;
  className?: string;
  /** 外观覆盖：仅在没有管理端配置时生效（默认完全跟随管理端）。 */
  fallbackTheme?: 'auto' | 'light' | 'dark';
  /** 控制台/测试用：固定指纹，跳过浏览器指纹采集。 */
  fingerprintOverride?: string;
}

export interface ManagedCaptchaRef {
  /** 重置挑战（提交失败后调用；会重新取一次下发配置）。 */
  reset: () => void;
}

type ProviderMode = 'turnstile' | 'hcaptcha' | 'trycap';

const DEFAULT_FAILOVER_ATTEMPTS = 2;

/** trycap 在报「验证已过期」前允许静默重挂的次数（Cap 控件挂载后会自己重新解题）。 */
const TRY_CAP_REARM_LIMIT = 2;

function providerModeOf(type: CaptchaType | null | undefined): ProviderMode | null {
  if (type === CaptchaType.TRYCAP) return 'trycap';
  if (type === CaptchaType.HCAPTCHA) return 'hcaptcha';
  if (type === CaptchaType.TURNSTILE) return 'turnstile';
  return null;
}

function providerTypeOf(mode: ProviderMode): CaptchaType {
  if (mode === 'trycap') return CaptchaType.TRYCAP;
  if (mode === 'hcaptcha') return CaptchaType.HCAPTCHA;
  return CaptchaType.TURNSTILE;
}

const ManagedCaptcha = ({
  scenario = 'default',
  onSolved,
  onCleared,
  onStatusChange,
  compact = false,
  className,
  fallbackTheme = 'auto',
  fingerprintOverride,
  ref,
}: ManagedCaptchaProps & { ref?: React.Ref<ManagedCaptchaRef> }) => {
  const [fingerprint, setFingerprint] = useState(fingerprintOverride ?? '');
  // 控件加载失败时逐个排除，等于前端侧的故障转移（次数上限由管理端分配策略下发）。
  const failedProvidersRef = useRef<CaptchaType[]>([]);
  const [widgetKey, setWidgetKey] = useState(0);
  const [solved, setSolved] = useState(false);
  const [widgetError, setWidgetError] = useState('');
  // trycap 静默换挑战期间给用户一句可见提示，避免「明明在重试却毫无动静」的困惑。
  const [rearming, setRearming] = useState(false);
  // 验证成功是终态：成功后面板会卸载控件，而 Cap 控件在 disconnectedCallback 里自己会 reset 一次
  // 并派发 reset 事件。若把这声噪声当真上报，就会变成「解出 → 显示过期 → 重挂 → 又自动解出」的循环。
  // 用 ref 记住终态（同步生效，不跟 setState 的异步调度）——与 CaptchaVerificationPage 同一套做法。
  const solvedRef = useRef(false);
  // trycap 的静默重挂计数：Cap 控件在断连/重挂/内部重取挑战时都会自己 reset 并派发 reset，
  // 这不是「用户令牌失效」。对 trycap 先静默换一张挑战（Cap 挂载后会自动解题），
  // 连续超过上限仍拿不到新令牌才报错，避免真卡死时无声无息。
  const tryCapRearmCountRef = useRef(0);

  useEffect(() => {
    if (fingerprintOverride) {
      setFingerprint(fingerprintOverride);
      return;
    }
    let cancelled = false;
    void getFingerprint().then((value) => {
      if (!cancelled) setFingerprint(value || '');
    });
    return () => {
      cancelled = true;
    };
  }, [fingerprintOverride]);

  const {
    captchaConfig,
    loading: selectionLoading,
    error: selectionError,
    regenerateSelection,
    siteKey,
    apiEndpoint,
    enabled,
    widget,
    failoverMaxAttempts,
  } = useSecureCaptchaSelection({ fingerprint, scenario });

  const providerMode = useMemo<ProviderMode | null>(
    () => (enabled && siteKey ? providerModeOf(captchaConfig?.captchaType) : null),
    [captchaConfig?.captchaType, enabled, siteKey],
  );

  const required = Boolean(providerMode);
  const attempts = Math.max(1, Math.min(3, failoverMaxAttempts || DEFAULT_FAILOVER_ATTEMPTS));

  // 换指纹/换场景即换一轮分配，排除名单随之作废。
  useEffect(() => {
    failedProvidersRef.current = [];
  }, [fingerprint, scenario]);

  const reset = useCallback(() => {
    failedProvidersRef.current = [];
    solvedRef.current = false;
    tryCapRearmCountRef.current = 0;
    setSolved(false);
    setWidgetError('');
    setRearming(false);
    setWidgetKey((value) => value + 1);
    onCleared?.();
    regenerateSelection();
  }, [onCleared, regenerateSelection]);

  useImperativeHandle(ref, () => ({ reset }), [reset]);

  const handleVerify = useCallback(
    (token: string) => {
      if (!providerMode || !token) return;
      setWidgetError('');
      setRearming(false);
      solvedRef.current = true;
      tryCapRearmCountRef.current = 0;
      setSolved(true);
      onSolved?.({ token, provider: providerTypeOf(providerMode) });
    },
    [onSolved, providerMode],
  );

  const handleExpire = useCallback(() => {
    // 成功之后控件会被卸载，卸载噪音产生的 reset 不得回滚已经拿到的令牌；
    // 真需要重新验证时走上层显式 reset()（它会把 solvedRef 置回 false）。
    if (solvedRef.current) return;

    // trycap：reset 不是「用户令牌失效」的可靠信号（Cap 官方控件在断连、重挂、内部重取
    // 挑战时都会自己 reset 一次），而且它的控件挂载后会自动重新解题。
    // 所以这里先静默换一张挑战：不清掉页面持有的令牌、不弹「验证已过期」。
    // 超时/失效令牌最终由后端校验拍板，页面拿到失败再走自己的 captchaRef.reset()。
    if (providerMode === 'trycap' && tryCapRearmCountRef.current < TRY_CAP_REARM_LIMIT) {
      tryCapRearmCountRef.current += 1;
      setWidgetError('');
      setRearming(true);
      setWidgetKey((value) => value + 1);
      return;
    }

    setSolved(false);
    setRearming(false);
    setWidgetError('验证已过期，请重新完成');
    setWidgetKey((value) => value + 1);
    onCleared?.();
  }, [onCleared, providerMode]);

  /** 控件加载/解题失败 → 排除这一家，按管理端策略换下一家（上限 failoverMaxAttempts）。 */
  const handleWidgetError = useCallback(() => {
    const current = captchaConfig?.captchaType;
    const attempted = failedProvidersRef.current;
    const canRetry =
      current !== undefined &&
      !attempted.includes(current) &&
      attempted.length + 1 < attempts;

    solvedRef.current = false;
    tryCapRearmCountRef.current = 0;
    setSolved(false);
    setRearming(false);
    onCleared?.();

    if (canRetry) {
      failedProvidersRef.current = [...attempted, current];
      setWidgetError('');
      setWidgetKey((value) => value + 1);
      regenerateSelection({ exclude: failedProvidersRef.current });
      return;
    }

    setWidgetError('验证控件加载失败，请点击重试');
  }, [attempts, captchaConfig?.captchaType, onCleared, regenerateSelection]);

  const error = useMemo(() => {
    if (selectionLoading) return null;
    return selectionError || widgetError || null;
  }, [selectionError, selectionLoading, widgetError]);

  // 状态回报：页面用它决定提交按钮可用性与错误提示（required 为 false 时页面直接放行）。
  // 回调放进 ref：页面即使传内联箭头函数也不会因为回调身份变化而重复触发。
  const statusCallbackRef = useRef(onStatusChange);
  statusCallbackRef.current = onStatusChange;
  useEffect(() => {
    statusCallbackRef.current?.({
      required,
      loading: selectionLoading,
      error,
      provider: providerMode ? providerTypeOf(providerMode) : null,
      solved,
    });
  }, [error, providerMode, required, selectionLoading, solved]);

  const providerLabel = providerMode ? getCaptchaDisplayName(providerTypeOf(providerMode)) : '人机验证';
  const theme = widget.theme ?? fallbackTheme;
  const size = widget.size;

  return (
    <div className={className} data-captcha-provider={providerMode ?? 'none'}>
      {selectionLoading && (
        <div className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
          <SimpleLoadingSpinner size={0.75} />
          正在加载人机验证…
        </div>
      )}

      {!selectionLoading && error && (
        <div className="space-y-2">
          <div className="flex items-start gap-2 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800" role="alert">
            <FaExclamationTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
          <button
            type="button"
            onClick={reset}
            className="inline-flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
          >
            <FaRedo className="h-3 w-3" />
            重试
          </button>
        </div>
      )}

      {!selectionLoading && !error && providerMode && (
        <div className="space-y-2">
          <div
            className={
              compact
                ? 'flex min-h-[72px] items-center justify-center rounded-xl border border-dashed border-slate-300 bg-white px-3 py-3'
                : 'flex min-h-[86px] items-center justify-center rounded-2xl border border-dashed border-slate-300 bg-white px-4 py-4'
            }
          >
            {solved ? (
              <div className="flex items-center gap-2 text-sm font-medium text-emerald-600" role="status" aria-live="polite">
                <FaCheckCircle className="h-4 w-4" />
                人机验证通过
              </div>
            ) : (
              <Suspense
                fallback={
                  <div className="flex h-[60px] w-full items-center justify-center">
                    <SimpleLoadingSpinner size={0.75} />
                  </div>
                }
              >
                {providerMode === 'turnstile' ? (
                  <TurnstileWidget
                    key={`turnstile-${widgetKey}`}
                    siteKey={siteKey}
                    theme={theme}
                    language={widget.language}
                    size={widget.size}
                    onVerify={handleVerify}
                    onExpire={handleExpire}
                    onError={handleWidgetError}
                  />
                ) : providerMode === 'trycap' ? (
                  <CapWidget
                    key={`trycap-${widgetKey}`}
                    siteKey={siteKey}
                    apiEndpoint={apiEndpoint || ''}
                    theme={theme}
                    language={widget.language}
                    onVerify={handleVerify}
                    onExpire={handleExpire}
                    onError={handleWidgetError}
                  />
                ) : (
                  <HCaptchaWidget
                    key={`hcaptcha-${widgetKey}`}
                    siteKey={siteKey}
                    theme={theme}
                    language={widget.language}
                    size={size}
                    onVerify={handleVerify}
                    onExpire={handleExpire}
                    onError={handleWidgetError}
                  />
                )}
              </Suspense>
            )}
          </div>

          {rearming && (
            <p className="flex items-center gap-2 text-xs text-slate-500" role="status" aria-live="polite">
              <FaRedo className="h-3 w-3 animate-spin" />
              正在重试，请稍候…
            </p>
          )}

          {!solved && (
            <p className="flex items-center gap-2 text-xs text-slate-500">
              <FaShieldAlt className="h-3 w-3" />
              请完成人机验证后继续
            </p>
          )}

          {widget.showProviderLabel && providerMode && (
            <p className="text-[11px] text-slate-400">
              本次验证方式：{providerLabel}
            </p>
          )}
        </div>
      )}
    </div>
  );
};

export default ManagedCaptcha;
export { ManagedCaptcha };
export type { ProviderMode as ManagedCaptchaProviderMode };
