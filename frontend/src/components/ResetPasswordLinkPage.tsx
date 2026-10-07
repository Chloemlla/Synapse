import React, { useState, useEffect } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { useNotification } from './Notification';
import { LazyMotion, domAnimation, m, useReducedMotion } from 'framer-motion';
import { FaVolumeUp, FaLock, FaEye, FaEyeSlash, FaCheckCircle, FaTimesCircle, FaArrowLeft, FaKey } from 'react-icons/fa';
import { api } from '../api/api';
import { getFingerprint, getClientIP } from '../utils/fingerprint';
import { getBackendErrorMessage } from '../utils/backendError';
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
    authFieldIconClassName,
    authFormClassName,
    authFrameClassName,
    authHeaderBadgeClassName,
    authInfoPanelClassName,
    authMutedLinkClassName,
    authPageShellClassName,
    authPasswordFieldClassName,
    authPrimaryButtonClassName,
    authSecondaryButtonClassName,
    authSuccessPanelClassName,
    authTitleClassName,
    studioPageFont,
} from './authStudioTheme';
import { cn } from '../utils/cn';

const NO_TRANSITION = { duration: 0 } as const;
const FADE_VARIANTS = { hidden: { opacity: 0 }, visible: { opacity: 1 } } as const;
const cardVariants = { hidden: { opacity: 0, y: 24 }, visible: { opacity: 1, y: 0 } };
const CARD_TRANSITION = { duration: 0.45, type: 'spring', stiffness: 130 } as const;
const ITEM_HOVER = { scale: 1.01, y: -1 } as const;
const BUTTON_TAP = { scale: 0.99 } as const;

export const ResetPasswordLinkPage: React.FC = () => {
    const { user } = useAuth();
    const { setNotification } = useNotification();
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const prefersReducedMotion = useReducedMotion();

    const token = searchParams.get('token');
    const lifecycleRef = React.useRef(0);
    const submittingRef = React.useRef(false);
    const [newPassword, setNewPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [showPassword, setShowPassword] = useState(false);
    const [showConfirmPassword, setShowConfirmPassword] = useState(false);
    const [loading, setLoading] = useState(false);
    const [verifying, setVerifying] = useState(true);
    const [validatedToken, setValidatedToken] = useState<string | null>(null);
    const tokenValid = Boolean(token && validatedToken === token);
    const [success, setSuccess] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const effectiveCardVariants = React.useMemo(() => prefersReducedMotion ? FADE_VARIANTS : cardVariants, [prefersReducedMotion]);
    const effectiveCardTransition = React.useMemo(() => prefersReducedMotion ? NO_TRANSITION : CARD_TRANSITION, [prefersReducedMotion]);
    const effectiveItemHover = React.useMemo(() => prefersReducedMotion ? undefined : ITEM_HOVER, [prefersReducedMotion]);
    const effectiveButtonTap = React.useMemo(() => prefersReducedMotion ? undefined : BUTTON_TAP, [prefersReducedMotion]);

    useEffect(() => {
        const lifecycle = ++lifecycleRef.current;
        const controller = new AbortController();
        setValidatedToken(null);
        setVerifying(true);
        setSuccess(false);
        setError(null);
        setLoading(false);
        submittingRef.current = false;
        setNewPassword('');
        setConfirmPassword('');

        const validateToken = async () => {
            if (!token) {
                setError('重置链接无效，请重新获取');
                setVerifying(false);
                return;
            }
            try {
                const [fingerprint, clientIP] = await Promise.all([getFingerprint(), getClientIP()]);
                if (lifecycle !== lifecycleRef.current) return;
                if (!fingerprint) throw new Error('无法获取设备信息，请刷新页面重试');
                const response = await api.post('/api/auth/validate-reset-token', {
                    token, fingerprint, clientIP,
                }, { signal: controller.signal });
                if (lifecycle !== lifecycleRef.current) return;
                const data = response.data as { valid?: boolean; error?: string };
                if (data.valid) setValidatedToken(token);
                else setError(data.error || '重置链接验证失败');
            } catch (err) {
                if (lifecycle !== lifecycleRef.current) return;
                setError(getBackendErrorMessage(err, '验证重置链接时发生网络错误，请刷新页面重试'));
            } finally {
                if (lifecycle === lifecycleRef.current) setVerifying(false);
            }
        };
        void validateToken();
        return () => {
            lifecycleRef.current += 1;
            controller.abort();
        };
    }, [token]);

    useEffect(() => {
        if (!success) return;
        const timer = setTimeout(() => navigate('/login'), 3000);
        return () => clearTimeout(timer);
    }, [success, token, navigate]);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault(); setError(null);
        if (submittingRef.current || verifying || !tokenValid || !token) return;
        // 密码是凭据，不能做 HTML 净化（DOMPurify 会剥离未知标签、转义 & 等，静默改写用户密码）。
        // 只做空值/一致性校验，最小长度 8 与后端 authController（8-128）对齐。
        if (!newPassword || !confirmPassword) { setError('请填写所有字段'); return; }
        if (newPassword !== confirmPassword) { setError('两次输入的密码不一致'); return; }
        if (newPassword.length < 8) { setError('密码长度至少为8位'); return; }
        submittingRef.current = true;
        const lifecycle = lifecycleRef.current;
        setLoading(true);
        try {
            const fingerprint = await getFingerprint();
            if (lifecycle !== lifecycleRef.current) return;
            if (!fingerprint) { setError('无法获取设备信息，请刷新页面重试'); setLoading(false); return; }
            const clientIP = await getClientIP();
            if (lifecycle !== lifecycleRef.current) return;
            const deviceName = navigator.userAgent || 'unknown';
            const response = await api.post('/api/auth/reset-password-link', {
                token, fingerprint, newPassword, clientIP, deviceName,
            });

            if (lifecycle !== lifecycleRef.current) return;
            const data = response.data as { success?: boolean; message?: string; error?: string };
            if (response.status === 200 && data.success) {
                setSuccess(true); setNotification({ message: data.message || '密码重置成功！', type: 'success' });
            } else {
                setError(data.error || '密码重置失败，请重试'); setNotification({ message: data.error || '密码重置失败', type: 'error' });
            }
        } catch (err: any) {
            if (lifecycle !== lifecycleRef.current) return;
            const msg = getBackendErrorMessage(err, '网络错误，请稍后重试');
            setError(msg); setNotification({ message: msg, type: 'error' });
        } finally {
            if (lifecycle === lifecycleRef.current) {
                submittingRef.current = false;
                setLoading(false);
            }
        }
    };

    return (
        <LazyMotion features={domAnimation}>
            <div className={authPageShellClassName} style={{ fontFamily: studioPageFont }}>
                <div className={cn(authFrameClassName, 'min-w-0')}>
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
                                    <div className={authEyebrowClassName}>安全重置链接</div>
                                    <h2 className={authTitleClassName}>设置新密码</h2>
                                    <p className={authDescriptionClassName}>通过安全链接重置您的账户密码。</p>
                                </div>
                            </div>

                            {user && (
                                <m.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} className={cn(authInfoPanelClassName, 'mb-5 flex items-start gap-3')}>
                                    <FaLock className="mt-1 shrink-0 text-slate-500" />
                                    <div>
                                        <p className="text-xs font-semibold text-slate-900">您当前登录为 {user.username}</p>
                                        <p className="mt-1 text-[11px] leading-5 text-slate-600">请确认这是您要重置的账号。完成后请使用新密码重新登录。</p>
                                    </div>
                                </m.div>
                            )}

                            {verifying ? (
                                <div className="py-8 text-center">
                                    <div className="mx-auto mb-5 h-10 w-10 sm:h-12 sm:w-12 animate-spin rounded-full border-4 border-slate-200 border-t-slate-900"></div>
                                    <h3 className="text-xl font-semibold text-slate-900">验证中</h3>
                                    <p className="mt-2 text-sm text-slate-600">正在验证重置链接</p>
                                </div>
                            ) : !tokenValid ? (
                                <div className="py-4 text-center">
                                    <div className="mx-auto mb-5 flex h-14 w-14 sm:h-16 sm:w-16 items-center justify-center rounded-2xl bg-rose-100">
                                        <FaTimesCircle className="h-8 w-8 text-rose-500" />
                                    </div>
                                    <h3 className="text-2xl font-semibold text-slate-900">链接无效</h3>
                                    <p className="mt-3 text-sm leading-6 text-slate-600">{error}</p>
                                    <div className="mt-6 space-y-3">
                                        <m.div whileHover={effectiveItemHover} whileTap={effectiveButtonTap}>
                                            <Link to="/forgot-password" className={authPrimaryButtonClassName}>重新获取重置链接</Link>
                                        </m.div>
                                        <m.div whileHover={effectiveItemHover} whileTap={effectiveButtonTap}>
                                            <Link to="/login" className={authSecondaryButtonClassName}>返回登录</Link>
                                        </m.div>
                                    </div>
                                </div>
                            ) : success ? (
                                <div className="py-4 text-center">
                                    <div className="mx-auto mb-5 flex h-14 w-14 sm:h-16 sm:w-16 items-center justify-center rounded-2xl bg-emerald-100">
                                        <FaCheckCircle className="h-8 w-8 text-emerald-600" />
                                    </div>
                                    <h3 className="text-2xl font-semibold text-slate-900">密码重置成功</h3>
                                    <p className="mt-3 text-sm leading-6 text-slate-600">您的密码已成功重置</p>
                                    <div className={cn(authSuccessPanelClassName, 'my-6 text-left')}>
                                        即将自动跳转到登录页面，请使用新密码登录。
                                    </div>
                                    <m.div whileHover={effectiveItemHover} whileTap={effectiveButtonTap}>
                                        <Link to="/login" className={authPrimaryButtonClassName}>立即登录</Link>
                                    </m.div>
                                </div>
                            ) : (
                                <>
                                    <form className={authFormClassName} onSubmit={handleSubmit}>
                                        {error && <div role="alert" aria-live="assertive" className={authAlertClassName}>{error}</div>}

                                        <div>
                                            <label htmlFor="newPassword" className="mb-2 block text-sm font-medium text-slate-700">新密码</label>
                                            <div className="relative">
                                                <FaLock className={authFieldIconClassName} />
                                                <input id="newPassword" name="newPassword" type={showPassword ? 'text' : 'password'} required minLength={8} aria-label="新密码" aria-required="true"
                                                    className={authPasswordFieldClassName}
                                                    placeholder="请输入新密码（至少8位）" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
                                                <button type="button" className={authFieldActionClassName} onClick={() => setShowPassword(!showPassword)} aria-label={showPassword ? 'Hide password' : 'Show password'}>
                                                    {showPassword ? <FaEyeSlash className="h-4 w-4" /> : <FaEye className="h-4 w-4" />}
                                                </button>
                                            </div>
                                        </div>

                                        <div>
                                            <label htmlFor="confirmPassword" className="mb-2 block text-sm font-medium text-slate-700">确认密码</label>
                                            <div className="relative">
                                                <FaLock className={authFieldIconClassName} />
                                                <input id="confirmPassword" name="confirmPassword" type={showConfirmPassword ? 'text' : 'password'} required minLength={8} aria-label="确认密码" aria-required="true"
                                                    className={authPasswordFieldClassName}
                                                    placeholder="请再次输入新密码" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} />
                                                <button type="button" className={authFieldActionClassName} onClick={() => setShowConfirmPassword(!showConfirmPassword)} aria-label={showConfirmPassword ? 'Hide password' : 'Show password'}>
                                                    {showConfirmPassword ? <FaEyeSlash className="h-4 w-4" /> : <FaEye className="h-4 w-4" />}
                                                </button>
                                            </div>
                                        </div>

                                        <m.button type="submit" disabled={loading || verifying || !tokenValid} aria-label={loading ? '重置中...' : '重置密码'} aria-busy={loading}
                                            className={authPrimaryButtonClassName}
                                            whileHover={effectiveItemHover} whileTap={effectiveButtonTap}>
                                            {loading ? '重置中...' : '重置密码'}
                                        </m.button>
                                    </form>

                                    <div className="mt-6 text-center">
                                        <Link to="/login" className={authMutedLinkClassName}>返回登录</Link>
                                    </div>
                                </>
                            )}
                        </div>
                    </m.div>

                    <div className="mt-6 text-center">
                        <Link to="/" className={authBackLinkClassName}>
                            <FaArrowLeft className="h-3.5 w-3.5" />返回首页
                        </Link>
                    </div>
                </div>
            </div>
        </LazyMotion>
    );
};

export default ResetPasswordLinkPage;
