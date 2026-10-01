import React from 'react';
import { Link } from 'react-router-dom';
import { FaArrowLeft, FaCheckCircle, FaRedo, FaShieldAlt } from 'react-icons/fa';
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
  const captchaRef = React.useRef<ManagedCaptchaRef | null>(null);
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
    // 挑战令牌一次性：重试必须重新取一枚（控件重新挂载 + 重新取下发配置）
    captchaRef.current?.reset();
  }, []);

  // 把挑战令牌交给后端统一校验（后端按 captchaProvider 分派到对应供应商）。
  const verifyToken = React.useCallback(async (challenge: ManagedCaptchaChallenge) => {
    setVerificationState('verifying');

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
      });

      const data = await response.json().catch(() => ({}));
      setVerificationState(response.ok && data?.success ? 'verified' : 'failed');
    } catch (_error) {
      setVerificationState('failed');
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
                  <div className="flex items-center gap-2 text-sm font-medium text-green-700">
                    <FaCheckCircle className="h-5 w-5" />
                    验证通过
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
                  验证失败，请重新验证
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
