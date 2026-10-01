import React, { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { motion as m, AnimatePresence } from 'framer-motion';
import { FaShieldAlt } from 'react-icons/fa';
import { SimpleLoadingSpinner } from './LoadingSpinner';
import { api } from '../api/api';
import { getFingerprint } from '../utils/fingerprint';
import { useSecureCaptchaSelection } from '../hooks/useSecureCaptchaSelection';
import { CaptchaType, getCaptchaDisplayName } from '../utils/captchaSelection';
import {
  InfoBadge,
  InfoPanel,
  InfoQueryShell,
  studioPrimaryButtonClassName,
  studioSecondaryButtonClassName,
} from './studioTheme';

// 与首访门闸同款：按后端选中的供应商懒加载对应组件，不把三家 SDK 都塞进首屏。
const TurnstileWidget = lazy(() =>
  import('./TurnstileWidget').then((module) => ({ default: module.TurnstileWidget })),
);
const HCaptchaWidget = lazy(() => import('./HCaptchaWidget'));
const CapWidget = lazy(() => import('./CapWidget'));

type ProviderMode = 'turnstile' | 'hcaptcha' | 'trycap';

/**
 * 验证终点：与首访门闸一致，按后端选中的供应商走后端校验接口
 * （turnstile / hcaptcha / trycap 三家各自的 verify，均为 publicLimiter 限流的公开端点）。
 */
const VERIFY_ENDPOINTS: Record<ProviderMode, string> = {
  turnstile: '/api/turnstile/verify-token',
  hcaptcha: '/api/turnstile/hcaptcha-verify',
  trycap: '/api/turnstile/cap-verify',
};

interface VerificationResult {
  success: boolean;
  message: string;
  score?: number;
  timestamp?: string;
  details?: {
    hostname?: string;
    challenge_ts?: string;
    error_codes?: string[];
  };
}

interface CaptchaVerificationPageBaseProps {
  onVerificationSuccess?: (result: VerificationResult) => void;
  onVerificationFailure?: (error: string) => void;
  title?: string;
  description?: string;
}

interface ReturnableCaptchaVerificationPageProps extends CaptchaVerificationPageBaseProps {
  onBack: () => void;
}

type CaptchaVerificationPageFrameProps = CaptchaVerificationPageBaseProps & {
  backAction?: {
    label: string;
    onBack: () => void;
  };
};

const CaptchaVerificationPageFrame: React.FC<CaptchaVerificationPageFrameProps> = ({
  onVerificationSuccess,
  onVerificationFailure,
  title = '人机验证',
  description = '请完成以下验证以继续访问',
  backAction,
}) => {
  const [isLoading, setIsLoading] = useState(false);
  const [verificationResult, setVerificationResult] = useState<VerificationResult | null>(null);
  const [error, setError] = useState<string>('');
  const [fingerprint, setFingerprint] = useState('');
  // 每次重试换 key，强制三家组件里的任意一个重新挂载（等价于 reset）。
  const [widgetKey, setWidgetKey] = useState(0);

  // 指纹是后端选择供应商与校验入参的一部分（与首访门闸同一套 secure-captcha-config 流程）。
  useEffect(() => {
    let cancelled = false;
    void getFingerprint().then((value) => {
      if (!cancelled) setFingerprint(value || '');
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const {
    captchaConfig,
    loading: selectionLoading,
    error: selectionError,
    regenerateSelection,
    siteKey,
    apiEndpoint,
    enabled,
  } = useSecureCaptchaSelection({ fingerprint });

  const providerMode = useMemo<ProviderMode | null>(() => {
    if (!captchaConfig || !enabled || !siteKey) return null;
    if (captchaConfig.captchaType === CaptchaType.TRYCAP) return 'trycap';
    return captchaConfig.captchaType === CaptchaType.HCAPTCHA ? 'hcaptcha' : 'turnstile';
  }, [captchaConfig, enabled, siteKey]);

  const providerLabel = useMemo(() => {
    if (providerMode === 'trycap') return getCaptchaDisplayName(CaptchaType.TRYCAP);
    if (providerMode === 'hcaptcha') return getCaptchaDisplayName(CaptchaType.HCAPTCHA);
    if (providerMode === 'turnstile') return getCaptchaDisplayName(CaptchaType.TURNSTILE);
    return '人机验证';
  }, [providerMode]);

  // 选择阶段的错误（后端不可用 / 三家都没配置）直接呈现，避免用户对着空白框干等。
  const selectionFailure = useMemo(() => {
    if (selectionLoading) return '';
    if (selectionError) return selectionError;
    if (!captchaConfig || !enabled || !siteKey) return '验证服务暂不可用，请稍后重试';
    return '';
  }, [captchaConfig, enabled, selectionError, selectionLoading, siteKey]);

  // 拿到挑战 token 后立刻交给后端校验，成功/失败都落到同一份结果里。
  const handleChallengeToken = useCallback(
    async (token: string) => {
      if (!providerMode || !token) return;

      setIsLoading(true);
      setError('');
      setVerificationResult(null);

      try {
        const payload: Record<string, unknown> = { token };
        if (providerMode === 'hcaptcha') {
          payload.timestamp = new Date().toISOString();
          if (fingerprint) payload.fingerprint = fingerprint;
        }

        const response = await api.post(VERIFY_ENDPOINTS[providerMode], payload);
        const data = response.data || {};
        const result: VerificationResult = {
          // 校验端点对「验证已跳过」也会回 success:true（上线开关关着时的既有语义）。
          success: Boolean(data.success) && data.verified !== false,
          message:
            typeof data.message === 'string' && data.message
              ? data.message
              : data.success === false
                ? '验证失败，请重试'
                : '验证完成',
          score: typeof data.score === 'number' ? data.score : undefined,
          timestamp: typeof data.timestamp === 'string' ? data.timestamp : new Date().toISOString(),
          details: data.details,
        };

        setVerificationResult(result);

        if (result.success) {
          onVerificationSuccess?.(result);
        } else {
          onVerificationFailure?.(result.message);
        }
      } catch (err: any) {
        const payload = err?.response?.data;
        // 403 是 IP 封禁（带 reason/expiresAt），其余是校验失败；两者都要给出后端原文。
        const errorMessage =
          (typeof payload?.message === 'string' && payload.message) ||
          (typeof payload?.error === 'string' && payload.error) ||
          (payload?.verified === false ? '验证未通过，请重试' : '验证失败，请重试');
        setError(errorMessage);
        onVerificationFailure?.(errorMessage);
        setWidgetKey((value) => value + 1);
      } finally {
        setIsLoading(false);
      }
    },
    [fingerprint, onVerificationFailure, onVerificationSuccess, providerMode],
  );

  const handleChallengeExpire = useCallback(() => {
    setVerificationResult(null);
    setError('验证码已过期，请重新验证');
  }, []);

  const handleChallengeError = useCallback((widgetError: unknown) => {
    console.error('人机验证组件错误:', widgetError);
    setError('验证组件加载失败，请刷新页面重试');
  }, []);

  const handleRetry = useCallback(() => {
    setError('');
    setVerificationResult(null);
    setWidgetKey((value) => value + 1);
  }, []);

  const handleReselect = useCallback(() => {
    setError('');
    setVerificationResult(null);
    setWidgetKey((value) => value + 1);
    regenerateSelection();
  }, [regenerateSelection]);

  // 页面动画变体
  const pageVariants = {
    initial: { opacity: 0, y: 20 },
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 0, y: -20 }
  };

  const cardVariants = {
    initial: { scale: 0.9, opacity: 0 },
    animate: { scale: 1, opacity: 1 },
    exit: { scale: 0.9, opacity: 0 }
  };

  return (
    <m.div
      variants={pageVariants}
      initial="initial"
      animate="animate"
      exit="exit"
      transition={{ duration: 0.4, ease: "easeOut" }}
      className="min-h-screen"
    >
      <InfoQueryShell maxWidthClassName="max-w-xl" className="flex min-h-screen items-center">
        <m.div
          variants={cardVariants}
          initial="initial"
          animate="animate"
          transition={{ delay: 0.1, duration: 0.5 }}
          className="w-full"
        >
          <InfoPanel>
        {/* 头部 */}
        <div className="text-center mb-8">
          <m.div
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ delay: 0.2, type: "spring", stiffness: 200 }}
            className="mx-auto mb-4 flex h-12 w-12 sm:h-16 sm:w-16 items-center justify-center rounded-2xl border border-slate-200 bg-slate-50 text-slate-600"
          >
            <FaShieldAlt className="text-xl sm:text-2xl" />
          </m.div>
          <div className="mb-3 flex justify-center">
            <InfoBadge>{providerLabel}</InfoBadge>
          </div>
          <h1 className="text-xl sm:text-2xl font-semibold text-slate-900 mb-2">{title}</h1>
          <p className="text-sm leading-6 text-slate-600">{description}</p>
        </div>

        {/* 验证区域 */}
        <div className="space-y-6">
          {/* 供应商由后端 captcha-providers 选择（上线开关 + 权重 + 额度），前端只负责渲染对应组件 */}
          {providerMode && !verificationResult && (
            <m.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.3 }}
              className="flex justify-center"
            >
              <Suspense
                fallback={
                  <div className="flex justify-center py-6">
                    <SimpleLoadingSpinner size={0.75} />
                  </div>
                }
              >
                {providerMode === 'turnstile' ? (
                  <TurnstileWidget
                    key={widgetKey}
                    siteKey={siteKey}
                    onVerify={handleChallengeToken}
                    onExpire={handleChallengeExpire}
                    onError={handleChallengeError}
                  />
                ) : providerMode === 'trycap' ? (
                  <CapWidget
                    key={widgetKey}
                    siteKey={siteKey}
                    apiEndpoint={apiEndpoint || ''}
                    onVerify={handleChallengeToken}
                    onExpire={handleChallengeExpire}
                    onError={handleChallengeError}
                  />
                ) : (
                  <HCaptchaWidget
                    key={widgetKey}
                    siteKey={siteKey}
                    onVerify={handleChallengeToken}
                    onExpire={handleChallengeExpire}
                    onError={handleChallengeError}
                    size="normal"
                  />
                )}
              </Suspense>
            </m.div>
          )}

          {/* 加载状态（供应商选择中 / 后端校验中） */}
          <AnimatePresence>
            {(isLoading || selectionLoading) && (
              <m.div
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.8 }}
                className="flex flex-col items-center space-y-3 rounded-2xl border border-slate-200 bg-slate-50/80 p-4"
              >
                <SimpleLoadingSpinner size={0.75} />
                <p className="text-sm text-slate-600">
                  {selectionLoading ? '正在获取验证方式...' : '正在验证中...'}
                </p>
              </m.div>
            )}
          </AnimatePresence>

          {/* 验证结果 */}
          <AnimatePresence>
            {verificationResult && (
              <m.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                className={`rounded-2xl border p-4 ${
                  verificationResult.success
                    ? 'border-emerald-200 bg-emerald-50/80'
                    : 'border-rose-200 bg-rose-50/80'
                }`}
              >
                <div className="flex items-start space-x-3">
                  <div className={`flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center ${
                    verificationResult.success ? 'bg-emerald-500' : 'bg-rose-500'
                  }`}>
                    {verificationResult.success ? (
                      <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                    ) : (
                      <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    )}
                  </div>
                  <div className="flex-1">
                    <h3 className={`font-semibold ${
                      verificationResult.success ? 'text-emerald-800' : 'text-rose-800'
                    }`}>
                      {verificationResult.success ? '验证成功' : '验证失败'}
                    </h3>
                    <p className={`text-sm mt-1 ${
                      verificationResult.success ? 'text-emerald-700' : 'text-rose-700'
                    }`}>
                      {verificationResult.message}
                    </p>

                    {/* 详细信息 */}
                    {verificationResult.details && (
                      <div className="mt-3 space-y-1">
                        {verificationResult.score !== undefined && (
                          <p className="text-xs text-slate-600">
                            验证分数: {verificationResult.score}
                          </p>
                        )}
                        {verificationResult.timestamp && (
                          <p className="text-xs text-slate-600">
                            验证时间: {new Date(verificationResult.timestamp).toLocaleString()}
                          </p>
                        )}
                        {verificationResult.details.hostname && (
                          <p className="text-xs text-slate-600">
                            主机名: {verificationResult.details.hostname}
                          </p>
                        )}
                        {verificationResult.details.error_codes && verificationResult.details.error_codes.length > 0 && (
                          <p className="text-xs text-rose-600">
                            错误代码: {verificationResult.details.error_codes.join(', ')}
                          </p>
                        )}
                      </div>
                    )}

                    <p className="mt-3 text-xs text-slate-500">
                      本次验证方式: {providerLabel}
                    </p>
                  </div>
                </div>
              </m.div>
            )}
          </AnimatePresence>

          {/* 错误信息 */}
          <AnimatePresence>
            {(error || selectionFailure) && (
              <m.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                className="rounded-2xl border border-rose-200 bg-rose-50/80 p-4"
              >
                <div className="flex items-start space-x-3">
                  <svg className="w-5 h-5 text-rose-500 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <div>
                    <h3 className="font-semibold text-rose-800">验证错误</h3>
                    <p className="text-sm text-rose-700 mt-1">{error || selectionFailure}</p>
                  </div>
                </div>
              </m.div>
            )}
          </AnimatePresence>

          {/* 操作按钮 */}
          <div className="flex flex-col gap-3 sm:flex-row">
            {backAction && (
              <button
                onClick={backAction.onBack}
                className={`flex-1 ${studioSecondaryButtonClassName}`}
              >
                {backAction.label}
              </button>
            )}

            {selectionFailure ? (
              <button
                onClick={handleReselect}
                disabled={selectionLoading}
                className={`flex-1 ${studioPrimaryButtonClassName}`}
              >
                重新获取验证方式
              </button>
            ) : null}

            {(error || (verificationResult && !verificationResult.success)) && (
              <button
                onClick={handleRetry}
                className={`flex-1 ${studioPrimaryButtonClassName}`}
              >
                重新验证
              </button>
            )}

            {verificationResult?.success && (
              <button
                onClick={() => window.location.reload()}
                className={`flex-1 ${studioPrimaryButtonClassName}`}
              >
                继续
              </button>
            )}
          </div>
        </div>

        {/* 底部信息 */}
        <div className="mt-8 pt-6 border-t border-slate-200">
          <p className="text-xs text-slate-500 text-center">
            此验证由 {providerLabel} 提供技术支持
          </p>
        </div>
          </InfoPanel>
        </m.div>
      </InfoQueryShell>
    </m.div>
  );
};

export const StandaloneCaptchaVerificationPage: React.FC<CaptchaVerificationPageBaseProps> = (props) => (
  <CaptchaVerificationPageFrame {...props} />
);

export const ReturnableCaptchaVerificationPage: React.FC<ReturnableCaptchaVerificationPageProps> = ({
  onBack,
  ...props
}) => (
  <CaptchaVerificationPageFrame
    {...props}
    backAction={{ label: '返回', onBack }}
  />
);

export default StandaloneCaptchaVerificationPage;
