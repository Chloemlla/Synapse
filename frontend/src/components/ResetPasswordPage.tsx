import React, { useState, useEffect } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import DOMPurify from 'dompurify';
import { useNotification } from './Notification';
import ManagedCaptcha, { type ManagedCaptchaChallenge, type ManagedCaptchaRef, type ManagedCaptchaStatus } from './ManagedCaptcha';
import { LazyMotion, domAnimation, m, useReducedMotion } from 'framer-motion';
import { FaEnvelope, FaLock, FaArrowLeft, FaVolumeUp, FaEye, FaEyeSlash, FaKey, FaCheckCircle } from 'react-icons/fa';
import getApiBaseUrl from '../api';
import { fetchWithTimeout } from '../utils/fetchWithTimeout';
import { getFingerprint, getClientIP } from '../utils/fingerprint';
import {
    authAlertClassName,
    authBackLinkClassName,
    authBrandBlockClassName,
    authBrandPillClassName,
    authBrandSubtitleClassName,
    authBrandTitleClassName,
    authCardBodyClassName,
    authCardClassName,
    authCardHeaderClassName,
    authDescriptionClassName,
    authEyebrowClassName,
    authFieldActionClassName,
    authFieldClassName,
    authFieldIconClassName,
    authFormClassName,
    authFrameClassName,
    authHeaderBadgeClassName,
    authMutedLinkClassName,
    authPageShellClassName,
    authPasswordFieldClassName,
    authPrimaryButtonClassName,
    authTitleClassName,
    studioPageFont,
} from './authStudioTheme';

const NO_TRANSITION = { duration: 0 } as const;
const FADE_VARIANTS = { hidden: { opacity: 0 }, visible: { opacity: 1 } } as const;
const cardVariants = { hidden: { opacity: 0, y: 24 }, visible: { opacity: 1, y: 0 } };
const CARD_TRANSITION = { duration: 0.45, type: 'spring', stiffness: 130 } as const;
const ITEM_HOVER = { scale: 1.01, y: -1 } as const;
const BUTTON_TAP = { scale: 0.99 } as const;

export const ResetPasswordPage: React.FC = () => {
    const { setNotification } = useNotification();
    const navigate = useNavigate();
    const location = useLocation();
    const prefersReducedMotion = useReducedMotion();

    const [email, setEmail] = useState('');
    const [code, setCode] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [success, setSuccess] = useState(false);
    const [showPassword, setShowPassword] = useState(false);
    const [showConfirmPassword, setShowConfirmPassword] = useState(false);
    const [captcha, setCaptcha] = useState<ManagedCaptchaChallenge | null>(null);
    const captchaRef = React.useRef<ManagedCaptchaRef | null>(null);
    const submittingRef = React.useRef(false);
    const [captchaStatus, setCaptchaStatus] = useState<ManagedCaptchaStatus>({
        required: false,
        loading: true,
        error: null,
        provider: null,
        solved: false,
    });

    const effectiveCardVariants = React.useMemo(() => prefersReducedMotion ? FADE_VARIANTS : cardVariants, [prefersReducedMotion]);
    const effectiveCardTransition = React.useMemo(() => prefersReducedMotion ? NO_TRANSITION : CARD_TRANSITION, [prefersReducedMotion]);
    const effectiveItemHover = React.useMemo(() => prefersReducedMotion ? undefined : ITEM_HOVER, [prefersReducedMotion]);
    const effectiveButtonTap = React.useMemo(() => prefersReducedMotion ? undefined : BUTTON_TAP, [prefersReducedMotion]);

    useEffect(() => { if (location.state && (location.state as any).email) setEmail((location.state as any).email); }, [location]);
    useEffect(() => { if (captcha?.token) setError(null); }, [captcha?.token]);

    // 人机验证由 /admin/captcha-providers 统一调控（三家共用同一套下发链路）。
    const handleCaptchaSolved = React.useCallback((challenge: ManagedCaptchaChallenge) => setCaptcha(challenge), []);
    const handleCaptchaCleared = React.useCallback(() => setCaptcha(null), []);
    const handleCaptchaStatus = React.useCallback((status: ManagedCaptchaStatus) => setCaptchaStatus(status), []);

    useEffect(() => {
        if (!success) return;
        const timer = setTimeout(() => navigate('/login'), 2000);
        return () => clearTimeout(timer);
    }, [success, navigate]);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (submittingRef.current) return;
        setError(null);
        const sanitizedEmail = DOMPurify.sanitize(email).trim();
        const sanitizedCode = DOMPurify.sanitize(code).trim();
        if (!sanitizedEmail || !sanitizedCode || !newPassword) { setError('请填写所有字段'); return; }
        if (!/^\d{8}$/.test(sanitizedCode)) { setError('验证码必须为8位数字'); return; }
        if (newPassword !== confirmPassword) { setError('两次输入的密码不一致'); return; }
        if (newPassword.length < 8) { setError('密码至少需要8个字符'); return; }
        if (captchaStatus.loading || captchaStatus.error) {
            setError(captchaStatus.error || '人机验证正在加载，请稍候');
            return;
        }
        if (captchaStatus.required && !captcha?.token) {
            setError('请先完成人机验证'); setNotification({ message: '请先完成人机验证', type: 'warning' }); return;
        }
        setLoading(true);
        submittingRef.current = true;
        // raw fetch 不走 axios（api.ts 的 15s timeout 覆盖不到），内联中止逻辑，
        // 后端挂起时最多等 15 秒后进入可重试的错误态。
        const controller = new AbortController();
        const timeoutId = window.setTimeout(() => controller.abort(), 15000);
        let requestSent = false;
        try {
            const [clientIP, fingerprint] = await Promise.all([getClientIP(), getFingerprint()]);
            const deviceName = navigator.userAgent || 'unknown';
            requestSent = true;
            const response = await fetchWithTimeout(getApiBaseUrl() + '/api/auth/reset-password', {
                method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
                body: JSON.stringify({
                    email: sanitizedEmail,
                    code: sanitizedCode,
                    newPassword,
                    clientIP,
                    deviceName,
                    fingerprint,
                    // 三家共用契约：captchaProvider 告诉后端这次是哪个供应商签发的；turnstileToken/cfToken 是老后端兼容字段。
                    ...(captcha?.token
                        ? {
                            captchaToken: captcha.token,
                            captchaProvider: captcha.provider,
                            turnstileToken: captcha.token,
                            cfToken: captcha.token,
                        }
                        : {}),
                }),
                credentials: 'include',
                signal: controller.signal,
            });
            const data = await response.json();
            if (response.ok && data.success) {
                setSuccess(true); setNotification({ message: '密码重置成功', type: 'success' });
            } else {
                setError(data.error || '密码重置失败'); setNotification({ message: data.error || '密码重置失败', type: 'error' });
            }
        } catch (err: any) {
            const timedOut = err?.name === 'AbortError';
            const message = timedOut ? '请求超时，请稍后重试' : '网络错误，请稍后重试';
            setError(message); setNotification({ message, type: 'error' });
        } finally {
            window.clearTimeout(timeoutId);
            if (requestSent && captcha?.token) captchaRef.current?.reset(captcha.token);
            submittingRef.current = false;
            setLoading(false);
        }
    };

    return (
        <LazyMotion features={domAnimation}>
            <div className={authPageShellClassName} style={{ fontFamily: studioPageFont }}>
                <div className={`${authFrameClassName} min-w-0`}>
                    <m.div className={authBrandBlockClassName} variants={effectiveCardVariants} initial="hidden" animate="visible" transition={{ duration: 0.5 }}>
                        <div className={authBrandPillClassName}>
                            <FaVolumeUp />
                            Synapse Access
                        </div>
                        <h1 className={authBrandTitleClassName}>Synapse</h1>
                        <p className={authBrandSubtitleClassName}>重置密码</p>
                    </m.div>

                    <m.div className={authCardClassName} variants={effectiveCardVariants} initial="hidden" animate="visible" transition={effectiveCardTransition}>
                        <div className={authCardBodyClassName}>
                            <div className={authCardHeaderClassName}>
                                <div className={authHeaderBadgeClassName}>
                                    <FaKey />
                                </div>
                                <div>
                                    <div className={authEyebrowClassName}>Password Reset</div>
                                    <h2 className={authTitleClassName}>输入新密码</h2>
                                    <p className={authDescriptionClassName}>使用发送到邮箱的验证码重置密码。</p>
                                </div>
                            </div>

                            {success ? (
                                <div className="py-4 text-center">
                                    <div className="mx-auto mb-5 flex h-14 w-14 sm:h-16 sm:w-16 items-center justify-center rounded-2xl bg-emerald-100">
                                        <FaCheckCircle className="h-8 w-8 text-emerald-600" />
                                    </div>
                                    <h3 className="text-xl font-semibold text-slate-900">密码重置成功</h3>
                                    <p className="mt-2 text-sm leading-6 text-slate-600">您的密码已成功重置，正在跳转到登录页面。</p>
                                </div>
                            ) : (
                                <form className={authFormClassName} onSubmit={handleSubmit}>
                                    {error && <div role="alert" aria-live="assertive" className={authAlertClassName}>{error}</div>}

                                    <div>
                                        <label htmlFor="email" className="mb-2 block text-sm font-medium text-slate-700">邮箱地址</label>
                                        <div className="relative">
                                            <FaEnvelope className={authFieldIconClassName} />
                                            <input id="email" name="email" type="email" required inputMode="email" aria-label="邮箱地址" aria-required="true" aria-invalid={!!error}
                                                className={authFieldClassName}
                                                placeholder="请输入邮箱地址" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
                                        </div>
                                    </div>

                                    <div>
                                        <label htmlFor="code" className="mb-2 block text-sm font-medium text-slate-700">验证码</label>
                                        <div className="relative">
                                            <FaKey className={authFieldIconClassName} />
                                            <input id="code" name="code" type="text" required inputMode="numeric" pattern="[0-9]{8}" maxLength={8} aria-required="true" aria-invalid={!!error}
                                                className={authFieldClassName}
                                                placeholder="12345678" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} autoComplete="one-time-code" />
                                        </div>
                                        <p className="mt-2 text-xs text-slate-500">输入发送到您邮箱的 8 位数字验证码</p>
                                    </div>

                                    <div>
                                        <label htmlFor="newPassword" className="mb-2 block text-sm font-medium text-slate-700">新密码</label>
                                        <div className="relative">
                                            <FaLock className={authFieldIconClassName} />
                                            <input id="newPassword" name="newPassword" type={showPassword ? 'text' : 'password'} required aria-label="新密码" aria-required="true" aria-invalid={!!error}
                                                className={authPasswordFieldClassName}
                                                placeholder="请输入新密码" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} autoComplete="new-password" />
                                            <button type="button" onClick={() => setShowPassword(!showPassword)} className={authFieldActionClassName} aria-label={showPassword ? '隐藏密码' : '显示密码'}>
                                                {showPassword ? <FaEyeSlash className="h-4 w-4" /> : <FaEye className="h-4 w-4" />}
                                            </button>
                                        </div>
                                    </div>

                                    <div>
                                        <label htmlFor="confirmPassword" className="mb-2 block text-sm font-medium text-slate-700">确认新密码</label>
                                        <div className="relative">
                                            <FaLock className={authFieldIconClassName} />
                                            <input id="confirmPassword" name="confirmPassword" type={showConfirmPassword ? 'text' : 'password'} required aria-label="确认新密码" aria-required="true" aria-invalid={!!error}
                                                className={authPasswordFieldClassName}
                                                placeholder="请再次输入新密码" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} autoComplete="new-password" />
                                            <button type="button" onClick={() => setShowConfirmPassword(!showConfirmPassword)} className={authFieldActionClassName} aria-label={showConfirmPassword ? '隐藏密码' : '显示密码'}>
                                                {showConfirmPassword ? <FaEyeSlash className="h-4 w-4" /> : <FaEye className="h-4 w-4" />}
                                            </button>
                                        </div>
                                    </div>

                                    <ManagedCaptcha
                                        ref={captchaRef}
                                        scenario="default"
                                        onSolved={handleCaptchaSolved}
                                        onCleared={handleCaptchaCleared}
                                        onStatusChange={handleCaptchaStatus}
                                    />

                                    <m.button type="submit" disabled={loading || captchaStatus.loading || Boolean(captchaStatus.error) || (captchaStatus.required && !captcha?.token)} aria-label={loading ? '重置密码中...' : '重置密码'} aria-busy={loading}
                                        className={authPrimaryButtonClassName}
                                        whileHover={effectiveItemHover} whileTap={effectiveButtonTap}>
                                        {loading ? '重置密码中...' : '重置密码'}
                                    </m.button>

                                    <div className="mt-2 space-y-2 text-center">
                                        <Link to="/forgot-password" className={authMutedLinkClassName}>重新发送验证码</Link>
                                        <Link to="/login" className={authMutedLinkClassName}>返回登录</Link>
                                    </div>
                                </form>
                            )}
                        </div>
                    </m.div>

                    <div className="mt-6 text-center">
                        <Link to="/" className={authBackLinkClassName} aria-label="返回首页">
                            <FaArrowLeft className="h-3.5 w-3.5" />返回首页
                        </Link>
                    </div>
                </div>
            </div>
        </LazyMotion>
    );
};

export default ResetPasswordPage;
