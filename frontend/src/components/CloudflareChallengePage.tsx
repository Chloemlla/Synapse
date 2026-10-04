import React from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { FaArrowLeft, FaArrowRight, FaCheckCircle, FaExclamationTriangle, FaRedo, FaShieldAlt } from 'react-icons/fa';
import getApiBaseUrl from '../api';
import ManagedCaptcha, {
  type ManagedCaptchaChallenge,
  type ManagedCaptchaRef,
  type ManagedCaptchaStatus,
} from './ManagedCaptcha';
import { cn } from '../utils/cn';
import { studioMutedPrimaryButtonClassName, studioSoftBadgeClassName } from './studioTheme';

type VerificationState = 'idle' | 'verifying' | 'verified' | 'failed';

const CloudflareChallengePage: React.FC = () => {
  const [verificationState, setVerificationState] = React.useState<VerificationState>('idle');
  // 失败原因：后端原文优先，其次给可行动的中文文案（技术细节只进 console）
  const [failureMessage, setFailureMessage] = React.useState('');
  const captchaRef = React.useRef<ManagedCaptchaRef | null>(null);
  // 验证通过后的前进目标：沿用全站既有的 redirectTo 查询参数（登录页同款约定），
  // 只接受站内相对路径，缺省回首页，避免把用户带去第三方站点。
  const [searchParams] = useSearchParams();
  const continueTarget = React.useMemo(() => {
    const raw = searchParams.get('redirectTo') || '';
    return raw.startsWith('/') && !raw.startsWith('//') ? raw : '/';
  }, [searchParams]);
  // 人机验证供应商由 /admin/captcha-providers 统一调控（三家共用同一套下发链路）。
  const [captchaStatus, setCaptchaStatus] = React.useState<ManagedCaptchaStatus>({
    required: false,
    loading: true,
    error: null,
    provider: null,
    solved: false,
  });

  const resetChallenge = React.useCallback(() => {
    setVerificationState('idle');
    setFailureMessage('');
    // 挑战令牌一次性：重试必须重新取一枚（控件重新挂载 + 重新取下发配置）
    captchaRef.current?.reset();
  }, []);

  // 把挑战令牌交给后端统一校验（后端按 captchaProvider 分派到对应供应商）。
  const verifyToken = React.useCallback(async (challenge: ManagedCaptchaChallenge) => {
    setVerificationState('verifying');
    setFailureMessage('');

    // 请求自身带超时：后端或网络卡住时不能永久停在「正在确认验证结果…」
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 10000);

    try {
      const response = await fetch(`${getApiBaseUrl()}/api/turnstile/verify-token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({
          token: challenge.token,
          captchaToken: challenge.token,
          captchaProvider: challenge.provider,
        }),
        credentials: 'include',
        signal: controller.signal,
      });

      const data = await response.json().catch(() => ({}));
      if (response.ok && data?.success) {
        setVerificationState('verified');
        return;
      }

      const backendReason = [data?.error, data?.reason].find(
        (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0,
      );
      setFailureMessage(backendReason || '验证未通过，请重新完成人机验证。');
      setVerificationState('failed');
    } catch (error) {
      console.error('确认人机验证结果失败:', error);
      setFailureMessage(
        error instanceof DOMException && error.name === 'AbortError'
          ? '确认验证结果超时，请检查网络后重试。'
          : '无法确认验证结果，请检查网络后重试。',
      );
      setVerificationState('failed');
    } finally {
      window.clearTimeout(timeoutId);
    }
  }, []);

  const handleCaptchaSolved = React.useCallback(
    (challenge: ManagedCaptchaChallenge) => {
      void verifyToken(challenge);
    },
    [verifyToken],
  );

  const handleCaptchaCleared = React.useCallback(() => {
    setVerificationState('idle');
  }, []);

  const handleCaptchaStatus = React.useCallback((status: ManagedCaptchaStatus) => setCaptchaStatus(status), []);


  return (
    <section className="mx-auto flex min-h-[62vh] max-w-xl items-center px-4 py-10">
      <div className="w-full overflow-hidden rounded-2xl border border-slate-200 bg-white/90 shadow-xl shadow-slate-200/60 backdrop-blur">
        <div className="border-b border-slate-200 bg-slate-950 px-4 py-4 sm:px-6 sm:py-5 text-white">
          <div className="flex items-center gap-3">
            <FaShieldAlt className="h-5 w-5 sm:h-6 sm:w-6 text-[#8ECAE6]" />
            <div>
              <h1 className="text-lg sm:text-xl font-semibold">人机验证</h1>
              <p className="mt-1 text-xs text-slate-300">Synapse 安全检查</p>
            </div>
          </div>
        </div>

        <div className="space-y-5 px-4 py-5 sm:px-6 sm:py-7">
          {captchaStatus.loading ? (
            <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
              正在加载验证组件...
            </div>
          ) : captchaStatus.required ? (
            <div className="space-y-4">
              <div className={cn(studioSoftBadgeClassName, "min-h-[78px] border px-3 py-4")}>
                {verificationState === 'verified' ? (
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="flex items-center gap-2 text-sm font-medium text-green-700">
                      <FaCheckCircle className="h-5 w-5" />
                      验证通过
                    </div>
                    {/* 通过后必须有明确的前进动作，否则用户只能返回首页，等于白验证一次 */}
                    <Link
                      to={continueTarget}
                      className={cn(studioMutedPrimaryButtonClassName, "bg-[#FFB703] px-3 py-2 text-[#023047] hover:bg-[#FB8500]")}
                    >
                      <FaArrowRight className="h-3.5 w-3.5" />
                      继续访问
                    </Link>
                  </div>
                ) : verificationState === 'failed' ? (
                  // 页面已判定失败时不再渲染控件，避免控件自己还显示「人机验证通过」造成两态矛盾
                  <div className="flex items-center gap-2 text-sm font-medium text-rose-700">
                    <FaExclamationTriangle className="h-5 w-5" />
                    本次验证未通过
                  </div>
                ) : (
                  <ManagedCaptcha
                    ref={captchaRef}
                    scenario="standalone"
                    onSolved={handleCaptchaSolved}
                    onCleared={handleCaptchaCleared}
                    onStatusChange={handleCaptchaStatus}
                  />
                )}
              </div>

              {verificationState === 'verifying' && (
                <p className="text-center text-xs font-medium text-slate-500" role="status" aria-live="polite">
                  正在确认验证结果...
                </p>
              )}
              {verificationState === 'failed' && (
                <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">
                  {failureMessage || '验证失败，请重新验证'}
                </div>
              )}
            </div>
          ) : (
            <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              人机验证尚未启用
            </div>
          )}

          <div className="flex items-center justify-between gap-3">
            <Link
              to="/"
              className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:border-slate-300 hover:bg-slate-50"
            >
              <FaArrowLeft className="h-3.5 w-3.5" />
              返回首页
            </Link>
            {verificationState === 'failed' && (
              <button
                type="button"
                onClick={resetChallenge}
                className={cn(studioMutedPrimaryButtonClassName, "bg-[#FFB703] px-3 py-2 text-[#023047] hover:bg-[#FB8500]")}
              >
                <FaRedo className="h-3.5 w-3.5" />
                重试
              </button>
            )}
          </div>
        </div>
      </div>
    </section>
  );
};

export default CloudflareChallengePage;
