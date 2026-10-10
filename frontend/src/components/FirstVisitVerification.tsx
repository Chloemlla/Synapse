import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, m } from 'framer-motion';
import {
  FaArrowRight,
  FaBan,
  FaCheck,
  FaCircleNotch,
  FaClock,
  FaFingerprint,
  FaGlobe,
  FaLock,
  FaRedo,
  FaShieldAlt,
} from 'react-icons/fa';
import { CaptchaType } from '../utils/captchaSelection';
import { completeIpVerification } from '../utils/ipVerification';
import { useSecureCaptchaSelection } from '../hooks/useSecureCaptchaSelection';
import { useReducedMotion } from '../hooks/useReducedMotion';
import { useNotification } from './Notification';
import { PenaltyAppealActions } from './PenaltyAppealActions';
import {
  studioAccentBlobBlueClassName,
  studioAccentBlobSkyClassName,
  studioPageFont,
} from './studioTheme';

const TurnstileWidget = lazy(() =>
  import('./TurnstileWidget').then((module) => ({ default: module.TurnstileWidget })),
);
const HCaptchaWidget = lazy(() => import('./HCaptchaWidget'));
const CapWidget = lazy(() => import('./CapWidget'));

interface FirstVisitVerificationProps {
  onVerificationComplete: () => void;
  fingerprint: string;
  isIpBanned?: boolean;
  banReason?: string;
  banExpiresAt?: Date;
  clientIP?: string | null;
  challengeReason?: string;
}

type VerificationMode = 'turnstile' | 'hcaptcha' | 'trycap' | null;

interface BanState {
  isBanned: boolean;
  reason?: string;
  expiresAt?: Date;
}

/** 图标旋转一律交给 framer-motion，尺寸随字号走，不再手写 SVG 几何。 */
const Spinner: React.FC<{ className?: string; reducedMotion: boolean }> = ({
  className = 'h-4 w-4',
  reducedMotion,
}) => (
  <m.span
    className={`inline-flex shrink-0 items-center justify-center ${className}`}
    aria-hidden="true"
    animate={reducedMotion ? undefined : { rotate: 360 }}
    transition={{ duration: 1.1, ease: 'linear', repeat: reducedMotion ? 0 : Number.POSITIVE_INFINITY }}
  >
    <FaCircleNotch className="h-full w-full" aria-hidden="true" />
  </m.span>
);

const REVIEW_STEPS = [
  { id: 'scan', label: '正在检查网络连接', Icon: FaGlobe },
  { id: 'challenge', label: '正在确认您的身份', Icon: FaShieldAlt },
  { id: 'token', label: '即将完成', Icon: FaLock },
] as const;

const ReviewSteps: React.FC<{ activeIndex: number }> = ({ activeIndex }) => (
  <ol className="mt-6 space-y-0">
    {REVIEW_STEPS.map((step, index) => {
      const done = index < activeIndex;
      const current = index === activeIndex;
      const Icon = step.Icon;
      const isLast = index === REVIEW_STEPS.length - 1;

      return (
        <li key={step.id} className="relative flex gap-3 pb-4 last:pb-0">
          {!isLast && (
            <span
              aria-hidden="true"
              className={`absolute left-[13px] top-7 h-[calc(100%-1.25rem)] w-px ${
                done ? 'bg-emerald-400' : 'bg-slate-200'
              }`}
            />
          )}
          <span
            aria-hidden="true"
            className={`relative z-10 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-[11px] transition-colors ${
              done
                ? 'border-emerald-200 bg-emerald-50 text-emerald-600'
                : current
                  ? 'border-amber-200 bg-amber-50 text-amber-600'
                  : 'border-slate-200 bg-white text-slate-400'
            }`}
          >
            {done ? <FaCheck /> : <Icon />}
          </span>
          <span
            aria-current={current ? 'step' : undefined}
            className={`pt-1 text-xs font-semibold tracking-[0.02em] ${
              done ? 'text-emerald-600' : current ? 'text-slate-900' : 'text-slate-400'
            }`}
          >
            {step.label}
            {current && <span className="ml-2 font-medium text-amber-600">进行中</span>}
            {done && <span className="ml-2 font-medium text-emerald-600">已完成</span>}
          </span>
        </li>
      );
    })}
  </ol>
);

const MetaRow: React.FC<{ Icon: React.ComponentType<{ className?: string }>; label: string; children: React.ReactNode }> = ({
  Icon,
  label,
  children,
}) => (
  <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3">
    <p className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">
      <Icon className="h-3 w-3" />
      {label}
    </p>
    <div className="mt-1.5">{children}</div>
  </div>
);

export const FirstVisitVerification: React.FC<FirstVisitVerificationProps> = ({
  onVerificationComplete,
  fingerprint,
  isIpBanned = false,
  banReason,
  banExpiresAt,
  clientIP,
  challengeReason,
}) => {
  const { setNotification } = useNotification();
  const reducedMotion = useReducedMotion();
  const {
    captchaConfig: secureCaptchaConfig,
    loading: secureSelectionLoading,
    error: secureSelectionError,
    siteKey: secureSiteKey,
    apiEndpoint: secureApiEndpoint,
    enabled: secureEnabled,
    widget: secureWidget,
    failoverMaxAttempts,
    regenerateSelection,
  } = useSecureCaptchaSelection({ fingerprint, scenario: 'first_visit' });
  // 控件加载失败时逐个排除（前端侧故障转移），重置验证时应清空。
  const failedProvidersRef = useRef<CaptchaType[]>([]);
  // 挑战解出即终态：控件卸载/断连时可能自派发「过期」事件（Cap 的 disconnectedCallback 就会
  // 自己 reset 一次），这声噪声不得把已拿到的令牌与「已验证」状态抹掉。
  // 新一轮挑战（用户重试 resetChallenge / 供应商故障转移 handleChallengeError）会把终态置回 false。
  const succeededRef = useRef(false);
  const verifyingRef = useRef(false);
  const generationRef = useRef(0);
  const attemptedTokenRef = useRef<string | null>(null);
  const requestRef = useRef<AbortController | null>(null);

  const [turnstileToken, setTurnstileToken] = useState('');
  const [turnstileVerified, setTurnstileVerified] = useState(false);
  const [turnstileKey, setTurnstileKey] = useState(0);
  const [hcaptchaToken, setHCaptchaToken] = useState('');
  const [hcaptchaVerified, setHCaptchaVerified] = useState(false);
  const [hcaptchaKey, setHCaptchaKey] = useState(0);
  const [capToken, setCapToken] = useState('');
  const [capVerified, setCapVerified] = useState(false);
  const [capKey, setCapKey] = useState(0);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState('');
  const [banState, setBanState] = useState<BanState>({
    isBanned: isIpBanned,
    reason: banReason,
    expiresAt: banExpiresAt,
  });

  useEffect(() => {
    setBanState({
      isBanned: isIpBanned,
      reason: banReason,
      expiresAt: banExpiresAt,
    });
  }, [isIpBanned, banReason, banExpiresAt]);

  useEffect(() => {
    if (challengeReason) {
      setError(challengeReason);
    }
  }, [challengeReason]);

  const verificationMode = useMemo<VerificationMode>(() => {
    if (!secureCaptchaConfig || !secureEnabled || !secureSiteKey) {
      return null;
    }

    if (secureCaptchaConfig.captchaType === CaptchaType.TRYCAP) return 'trycap';
    return secureCaptchaConfig.captchaType === CaptchaType.HCAPTCHA ? 'hcaptcha' : 'turnstile';
  }, [secureCaptchaConfig, secureEnabled, secureSiteKey]);

  const serviceLabel =
    verificationMode === 'trycap'
      ? 'trycap'
      : verificationMode === 'hcaptcha'
        ? 'hCaptcha'
        : 'Cloudflare Turnstile';

  const configError = useMemo(() => {
    if (secureSelectionLoading) return '';
    if (secureSelectionError) return secureSelectionError;
    if (!secureEnabled || !secureSiteKey || !verificationMode) {
      return '验证服务暂不可用，请稍后重试。';
    }
    return '';
  }, [secureEnabled, secureSelectionError, secureSelectionLoading, secureSiteKey, verificationMode]);

  const isVerified = useMemo(() => {
    if (verificationMode === 'turnstile') {
      return turnstileVerified && Boolean(turnstileToken);
    }
    if (verificationMode === 'hcaptcha') {
      return hcaptchaVerified && Boolean(hcaptchaToken);
    }
    if (verificationMode === 'trycap') {
      return capVerified && Boolean(capToken);
    }
    return false;
  }, [capToken, capVerified, hcaptchaToken, hcaptchaVerified, turnstileToken, turnstileVerified, verificationMode]);

  const currentToken = useMemo(() => {
    if (verificationMode === 'turnstile') return turnstileToken;
    if (verificationMode === 'hcaptcha') return hcaptchaToken;
    if (verificationMode === 'trycap') return capToken;
    return '';
  }, [capToken, hcaptchaToken, turnstileToken, verificationMode]);

  // 0 = 解析验证码配置，1 = 等待人机挑战，2 = 挑战已过、正在换发会话令牌
  const reviewStepIndex = secureSelectionLoading || !verificationMode ? 0 : isVerified ? 2 : 1;

  const resetChallenge = useCallback(
    (mode: VerificationMode = verificationMode) => {
      generationRef.current += 1;
      requestRef.current?.abort();
      requestRef.current = null;
      verifyingRef.current = false;
      attemptedTokenRef.current = null;
      setVerifying(false);
      // 用户主动重试：清掉「已排除的供应商」，否则会一直被锁在备选名单上。
      failedProvidersRef.current = [];
      // 新一轮挑战开始，终态作废。
      succeededRef.current = false;
      if (mode === 'turnstile') {
        setTurnstileToken('');
        setTurnstileVerified(false);
        setTurnstileKey((value) => value + 1);
        return;
      }

      if (mode === 'hcaptcha') {
        setHCaptchaToken('');
        setHCaptchaVerified(false);
        setHCaptchaKey((value) => value + 1);
        return;
      }

      if (mode === 'trycap') {
        setCapToken('');
        setCapVerified(false);
        setCapKey((value) => value + 1);
      }
    },
    [verificationMode],
  );

  const handleTurnstileVerify = useCallback((token: string) => {
    setTurnstileToken(token);
    setTurnstileVerified(true);
    succeededRef.current = true;
    setError('');
  }, []);

  const handleTurnstileExpire = useCallback(() => {
    if (succeededRef.current) return;
    setTurnstileToken('');
    setTurnstileVerified(false);
    setError('验证已过期，请重新完成验证后继续。');
  }, []);

  const handleHCaptchaVerify = useCallback((token: string) => {
    setHCaptchaToken(token);
    setHCaptchaVerified(true);
    succeededRef.current = true;
    setError('');
  }, []);

  const handleHCaptchaExpire = useCallback(() => {
    if (succeededRef.current) return;
    setHCaptchaToken('');
    setHCaptchaVerified(false);
    setError('验证已过期，请重新完成验证后继续。');
  }, []);

  const handleCapVerify = useCallback((token: string) => {
    setCapToken(token);
    setCapVerified(true);
    succeededRef.current = true;
    setError('');
  }, []);

  const handleCapExpire = useCallback(() => {
    if (succeededRef.current) return;
    setCapToken('');
    setCapVerified(false);
    setError('验证已过期，请重新完成验证后继续。');
  }, []);

  /** 控件加载失败 → 排除这一家、按分配策略换下一家（上限由管理端下发）。 */
  const handleChallengeError = useCallback(() => {
    const current = secureCaptchaConfig?.captchaType;
    const attempted = failedProvidersRef.current;
    const canRetry =
      current !== undefined &&
      !attempted.includes(current) &&
      attempted.length + 1 < Math.max(1, failoverMaxAttempts);

    if (canRetry) {
      failedProvidersRef.current = [...attempted, current];
      succeededRef.current = false;
      setError('');
      setNotification({ message: '正在切换到备用验证服务…', type: 'info' });
      regenerateSelection({ exclude: failedProvidersRef.current });
      return;
    }

    setError('验证控件加载失败，请刷新页面后重试。');
  }, [failoverMaxAttempts, regenerateSelection, secureCaptchaConfig?.captchaType, setNotification]);

  const handleVerify = useCallback(async () => {
    if (!verificationMode || !currentToken || !isVerified || verifyingRef.current || attemptedTokenRef.current === currentToken) return;

    verifyingRef.current = true;
    attemptedTokenRef.current = currentToken;
    const generation = generationRef.current;
    const controller = new AbortController();
    requestRef.current = controller;

    setVerifying(true);
    setError('');

    try {
      const result = await completeIpVerification(fingerprint, currentToken, verificationMode, controller.signal);
      if (generation !== generationRef.current) return;
      if (!result.success || !result.verified || !result.token) {
        // 后端原文不直铺界面，只给中性可重试文案。
        throw new Error('验证未通过，请重试。');
      }

      setNotification({
        message: '验证已完成。',
        type: 'success',
      });

      window.setTimeout(() => {
        if (generation === generationRef.current) onVerificationComplete();
      }, 180);
    } catch (verifyError) {
      if (generation !== generationRef.current) return;
      // complete 在解验证码这一刻被封时抛出带 banData 的错误：切到阻断页（页面自带申诉入口），
      // 不再当作普通失败只显示一句「未被接受」。
      const banData = (verifyError as { banData?: { reason?: string; expiresAt?: string } })?.banData;
      if (banData) {
        setBanState({
          isBanned: true,
          reason: banData.reason || 'IP 已被封禁',
          expiresAt: banData.expiresAt ? new Date(banData.expiresAt) : undefined,
        });
        return;
      }

      // 原始异常只进 console；界面用中性文案。
      console.error('IP verification complete failed:', verifyError);
      const message = '验证未通过，请重试。';
      setError(message);
      resetChallenge(verificationMode);
      setNotification({
        message,
        type: 'error',
      });
    } finally {
      if (requestRef.current === controller) requestRef.current = null;
      if (generation === generationRef.current) {
        verifyingRef.current = false;
        setVerifying(false);
      }
    }
  }, [currentToken, fingerprint, isVerified, onVerificationComplete, resetChallenge, setNotification, verificationMode]);

  // 配置/设备换轮或组件卸载后，旧 complete 响应不得完成新一轮验证。
  useEffect(() => {
    generationRef.current += 1;
    requestRef.current?.abort();
    requestRef.current = null;
    verifyingRef.current = false;
    attemptedTokenRef.current = null;
    succeededRef.current = false;
    setVerifying(false);
    setTurnstileToken('');
    setTurnstileVerified(false);
    setHCaptchaToken('');
    setHCaptchaVerified(false);
    setCapToken('');
    setCapVerified(false);
    setTurnstileKey((value) => value + 1);
    setHCaptchaKey((value) => value + 1);
    setCapKey((value) => value + 1);
    return () => {
      generationRef.current += 1;
      requestRef.current?.abort();
    };
  }, [fingerprint, secureCaptchaConfig]);

  const fingerprintPreview = useMemo(() => {
    if (!fingerprint) return '不可用';
    return `${fingerprint.slice(0, 10)}...${fingerprint.slice(-6)}`;
  }, [fingerprint]);

  const shell = (children: React.ReactNode) => (
    <div className={`fixed inset-0 z-50 overflow-y-auto overscroll-contain bg-slate-50 ${studioPageFont}`}>
      {/* 均匀网格铺满整屏：不再用圆形遮罩，避免出现一圈巨大的"圆盘" */}
      <div
        className="pointer-events-none fixed inset-0 opacity-60"
        style={{
          backgroundImage:
            'linear-gradient(rgba(15,23,42,0.028) 1px, transparent 1px), linear-gradient(90deg, rgba(15,23,42,0.028) 1px, transparent 1px)',
          backgroundSize: '34px 34px',
        }}
      />
      {/* RC-49：台上光源改成与首页同一组 studio 光斑（不再自造橙色渐变） */}
      <div className={`${studioAccentBlobBlueClassName} -top-20 left-1/4`} aria-hidden="true" />
      <div className={`${studioAccentBlobSkyClassName} -top-8 right-1/4`} aria-hidden="true" />
      <div className="relative flex min-h-full items-center justify-center px-4 py-10 sm:px-6 sm:py-14">
        {children}
      </div>
    </div>
  );

  if (banState.isBanned) {
    return shell(
      <m.div
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.32, ease: 'easeOut' }}
        className="relative w-full max-w-xl overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-[0_30px_70px_-30px_rgba(15,23,42,0.25)]"
      >
        <div className="flex items-center gap-3 border-b border-slate-200 bg-slate-50 px-6 py-6 sm:px-8">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-rose-200 bg-white text-lg text-rose-600">
            <FaBan />
          </span>
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-rose-600">
              安全检查
            </p>
            <h1 className="text-xl font-semibold tracking-[-0.02em] text-slate-900 sm:text-2xl">
              访问暂时受限
            </h1>
          </div>
        </div>

        <div className="space-y-4 px-6 py-6 text-sm leading-6 text-slate-600 sm:px-8 sm:py-7">
          <p>{banState.reason || '该 IP 因异常流量频繁触发限制，当前暂不可访问。'}</p>
          {banState.expiresAt && (
            <div className="flex items-center gap-2.5 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-slate-800">
              <FaClock className="h-3.5 w-3.5 text-slate-500" />
              <span>{banState.expiresAt.toLocaleString()} 后可重试</span>
            </div>
          )}
          {clientIP && clientIP !== 'unknown' && (
            <MetaRow Icon={FaGlobe} label="IP 地址">
              <p className="font-mono text-xs text-slate-700">{clientIP}</p>
            </MetaRow>
          )}
          {/* mailOnly：被拦截期间工单接口同样不可达，只给管理员支持邮箱（组件内带 mailto 预填）。 */}
          <PenaltyAppealActions
            kind="ip_ban"
            mailOnly
            reason={banState.reason}
            remainingText={banState.expiresAt ? banState.expiresAt.toLocaleString() : undefined}
            details={clientIP && clientIP !== 'unknown' ? `IP: ${clientIP}` : undefined}
          />
        </div>
      </m.div>,
    );
  }

  const statusPill = isVerified
    ? { className: 'border-emerald-200 bg-emerald-50 text-emerald-600', label: '验证已通过' }
    : { className: 'border-amber-200 bg-amber-50 text-amber-600', label: '待验证' };

  return shell(
    <m.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.34, ease: 'easeOut' }}
      className="relative w-full max-w-[880px] overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-[0_30px_70px_-30px_rgba(15,23,42,0.25)] xl:max-w-[1000px]"
    >
      <div className="grid md:grid-cols-[1.15fr_0.85fr]">
        <div className="px-5 py-7 sm:px-8 sm:py-9 md:px-10 md:py-11">
          <div className="flex items-center gap-3.5">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-slate-900 text-lg text-white shadow-sm">
              <FaShieldAlt />
            </span>
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-amber-600">
                流量审查
              </p>
              <h1 className="text-[24px] font-semibold tracking-[-0.03em] text-slate-900 sm:text-[28px]">
                正在检查您的浏览器
              </h1>
            </div>
          </div>

          <p className="mt-5 text-sm leading-6 text-slate-600">
            在继续访问前需要完成一次快速安全验证。完成下方的挑战后即可直接返回站点。
          </p>

          <div className="mt-6 rounded-2xl border border-slate-200 bg-white px-5 py-5">
            <div className="flex items-center gap-3">
              <Spinner className="h-5 w-5 text-amber-600" reducedMotion={reducedMotion} />
              <div className="min-w-0">
                <p className="text-sm font-semibold text-slate-800">
                  {isVerified ? '验证已通过' : '审查进行中'}
                </p>
                <p className="text-xs text-slate-500">
                  一次性检查 · 已绑定当前浏览器与网络
                </p>
              </div>
            </div>
            <ReviewSteps activeIndex={reviewStepIndex} />
          </div>

          <div className="mt-6 rounded-2xl border border-slate-200 bg-white px-5 py-5 shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm font-semibold text-slate-800">完成安全验证</p>
              <AnimatePresence mode="wait" initial={false}>
                <m.span
                  key={statusPill.label}
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 4 }}
                  transition={{ duration: 0.18 }}
                  className={`rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] ${statusPill.className}`}
                >
                  {statusPill.label}
                </m.span>
              </AnimatePresence>
            </div>

            <div className="mt-4">
              {secureSelectionLoading ? (
                <div className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white px-5 py-6 text-sm text-slate-500">
                  <Spinner className="h-4 w-4 text-slate-400" reducedMotion={reducedMotion} />
                  正在加载验证服务…
                </div>
              ) : configError ? (
                <div className="space-y-4">
                  <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-4 text-sm text-amber-700">
                    {configError}
                  </div>
                  <button
                    type="button"
                    onClick={() => window.location.reload()}
                    className="inline-flex items-center gap-2 rounded-2xl border border-slate-900 px-4 py-3 text-sm font-semibold text-slate-900 transition hover:bg-slate-900 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300 focus-visible:ring-offset-2"
                  >
                    <FaRedo className="h-3.5 w-3.5" />
                    重新加载页面
                  </button>
                </div>
              ) : (
                <>
                  <m.div
                    transition={{ duration: 0.25 }}
                    className={`flex min-h-[86px] items-center justify-center rounded-2xl border border-dashed px-4 py-4 transition-colors duration-200 ${
                      isVerified ? 'border-emerald-200 bg-emerald-50' : 'border-slate-200 bg-white'
                    }`}
                  >
                    <Suspense
                      fallback={
                        <div className="flex h-[78px] w-full items-center justify-center">
                          <Spinner className="h-5 w-5 text-slate-400" reducedMotion={reducedMotion} />
                        </div>
                      }
                    >
                      {verificationMode === 'turnstile' ? (
                        <TurnstileWidget
                          key={turnstileKey}
                          siteKey={secureSiteKey}
                          theme={secureWidget.theme}
                          language={secureWidget.language}
                          size={secureWidget.size}
                          onVerify={handleTurnstileVerify}
                          onExpire={handleTurnstileExpire}
                          onError={handleChallengeError}
                        />
                      ) : verificationMode === 'trycap' ? (
                        <CapWidget
                          key={capKey}
                          siteKey={secureSiteKey}
                          apiEndpoint={secureApiEndpoint || ''}
                          theme={secureWidget.theme}
                          language={secureWidget.language}
                          onVerify={handleCapVerify}
                          onExpire={handleCapExpire}
                          onError={handleChallengeError}
                        />
                      ) : (
                        <HCaptchaWidget
                          key={hcaptchaKey}
                          siteKey={secureSiteKey}
                          theme={secureWidget.theme}
                          language={secureWidget.language}
                          onVerify={handleHCaptchaVerify}
                          onExpire={handleHCaptchaExpire}
                          onError={handleChallengeError}
                          size={secureWidget.size}
                        />
                      )}
                    </Suspense>
                  </m.div>

                  <AnimatePresence initial={false}>
                    {error && (
                      <m.div
                        initial={{ opacity: 0, y: 8, height: 0 }}
                        animate={{ opacity: 1, y: 0, height: 'auto' }}
                        exit={{ opacity: 0, y: -8, height: 0 }}
                        className="overflow-hidden"
                        role="alert"
                      >
                        <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
                          {error}
                        </div>
                      </m.div>
                    )}
                  </AnimatePresence>

                  <div className="mt-5 flex flex-col gap-3 sm:flex-row">
                    <m.button
                      type="button"
                      onClick={handleVerify}
                      disabled={!isVerified || verifying}
                      whileTap={reducedMotion || !isVerified || verifying ? undefined : { scale: 0.985 }}
                      className={`flex flex-1 items-center justify-center gap-2.5 rounded-2xl px-5 py-3.5 text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/45 focus-visible:ring-offset-2 ${
                        !isVerified || verifying
                          ? 'cursor-not-allowed bg-slate-200 text-slate-400'
                          : 'bg-slate-900 text-white shadow-sm hover:bg-slate-800'
                      }`}
                      aria-busy={verifying}
                    >
                      {verifying ? (
                        <>
                          <Spinner className="h-4 w-4 text-white" reducedMotion={reducedMotion} />
                          正在完成验证…
                        </>
                      ) : (
                        <>
                          继续访问站点
                          <FaArrowRight className="h-3.5 w-3.5" />
                        </>
                      )}
                    </m.button>

                    <button
                      type="button"
                      onClick={() => {
                        setError('');
                        resetChallenge();
                      }}
                      disabled={verifying}
                      className="inline-flex items-center justify-center gap-2 rounded-2xl border border-slate-300 px-5 py-3.5 text-sm font-semibold text-slate-800 transition hover:border-slate-300 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <FaRedo className="h-3.5 w-3.5" />
                      重新加载验证
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>

          {secureWidget.showProviderLabel && (
            <p className="mt-5 text-xs text-slate-500">
              由 {verificationMode ? serviceLabel : '站点验证服务'} 提供 · 验证令牌不会记录到日志或 URL 中。
            </p>
          )}
        </div>

        <div className="border-t border-slate-200 bg-white px-5 py-7 sm:px-8 sm:py-9 md:border-l md:border-t-0 md:px-9 md:py-11">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
            会话信息
          </p>

          <div className="mt-4 space-y-3">
            <MetaRow Icon={FaFingerprint} label="浏览器指纹">
              <p className="truncate font-mono text-xs text-slate-700">{fingerprintPreview}</p>
            </MetaRow>

            <MetaRow Icon={FaGlobe} label="IP 地址">
              <p className="truncate font-mono text-xs text-slate-700">{clientIP || '正在检测…'}</p>
            </MetaRow>

            <MetaRow Icon={FaClock} label="令牌策略">
              <p className="text-xs leading-5 text-slate-600">
                通过检查后即可照常浏览。本次检查在您的整个会话内有效，刷新页面不会再次出现。
              </p>
            </MetaRow>
          </div>

          <div className="mt-6 rounded-2xl border border-slate-200 bg-white px-5 py-5">
            <p className="text-sm font-semibold text-slate-800">为什么会出现此页面</p>
            <ul className="mt-3.5 space-y-3 text-xs leading-5 text-slate-500">
              {[
                '您的网络需要先完成一次快速的一次性验证。',
                '整个过程只需几秒，有助于保障站点安全。',
                '验证完成后即可照常继续浏览。',
              ].map((item) => (
                <li key={item} className="flex gap-2.5">
                  <FaCheck className="mt-0.5 h-3 w-3 shrink-0 text-amber-600" aria-hidden="true" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </m.div>,
  );
};
