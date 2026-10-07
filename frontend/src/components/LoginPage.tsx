import React, { useState, useEffect } from 'react';
import { useAuth } from '../hooks/useAuth';
import { isAdminRole } from '../utils/rbac';
import type { AuthRequestError } from '../hooks/useAuth';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import DOMPurify from 'dompurify';
import { usePasskey } from '../hooks/usePasskey';
import { useNotification } from './Notification';
import GoogleAuthButton from './GoogleAuthButton';
import LinuxDoAuthButton from './LinuxDoAuthButton';
import MobileLoginPanel from './MobileLoginPanel';
import ManagedCaptcha, {
    type ManagedCaptchaChallenge,
    type ManagedCaptchaRef,
    type ManagedCaptchaStatus,
} from './ManagedCaptcha';
import PasskeyVerifyModal from './PasskeyVerifyModal';
import PolicyConsentChecklist from './PolicyConsentChecklist';
import TOTPVerification from './TOTPVerification';
import VerificationMethodSelector from './VerificationMethodSelector';
import { LazyMotion, domAnimation, m, useReducedMotion } from 'framer-motion';
import {
    FaEnvelope,
    FaLock,
    FaEye,
    FaEyeSlash,
    FaFingerprint,
    FaVolumeUp,
    FaArrowLeft,
    FaQuestionCircle,
    FaChevronDown,
    FaChevronUp,
    FaShieldAlt,
    FaUserShield,
    FaBolt,
    FaMobileAlt,
    FaUser,
    FaSignInAlt,
} from 'react-icons/fa';
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
    authCheckboxClassName,
    authDividerClassName,
    authDividerLabelClassName,
    authDividerLineClassName,
    authElevatedPanelClassName,
    authEyebrowClassName,
    authFieldActionClassName,
    authFieldClassName,
    authFieldIconClassName,
    authFormClassName,
    authFrameClassName,
    authHeaderBadgeClassName,
    authInfoPanelClassName,
    authLabelClassName,
    authMutedLinkClassName,
    authPageShellClassName,
    authPasswordFieldClassName,
    authPrimaryButtonClassName,
    authSecondaryButtonClassName,
    authTextLinkClassName,
    authTitleClassName,
    authWarningPanelClassName,
    studioPageFont,
} from './authStudioTheme';
import { cn } from '../utils/cn';
import {
    buildPolicyConsentPayload,
    createPolicyConsentSelection,
    isPolicyConsentComplete,
    type PolicyConsentSelection,
} from '../utils/policyConsent';

const NO_TRANSITION = { duration: 0 } as const;
const FADE_VARIANTS = { hidden: { opacity: 0 }, visible: { opacity: 1 } } as const;
const cardVariants = { hidden: { opacity: 0, y: 24 }, visible: { opacity: 1, y: 0 } };
const CARD_TRANSITION = { duration: 0.45, type: 'spring', stiffness: 130 } as const;
const ITEM_HOVER = { scale: 1.01, y: -1 } as const;
const BUTTON_TAP = { scale: 0.99 } as const;
// 后端 loginHandlers 用 JWT `expiresIn: "5m"` 加 updateUserToken(user.id, tempToken, 5*60*1000)
// 下发二次验证临时令牌，两边时限必须一致：这里按同一时限判断「续接窗口」是否还在。
const TWO_FACTOR_PENDING_TTL_MS = 5 * 60 * 1000;

type LoginAttemptStatus = {
    message: string;
    tone: 'warning' | 'locked';
};

const buildLoginAttemptStatus = (error: AuthRequestError): LoginAttemptStatus | null => {
    if (typeof error.lockedUntil === 'number') {
        const lockedUntilText = new Date(error.lockedUntil).toLocaleTimeString('zh-CN', {
            hour: '2-digit',
            minute: '2-digit',
        });
        return {
            tone: 'locked',
            message: `登录已暂时锁定，请在 ${lockedUntilText} 后重试。`,
        };
    }

    if (typeof error.remainingAttempts === 'number' && typeof error.attemptLimit === 'number') {
        return {
            tone: error.remainingAttempts <= 1 ? 'locked' : 'warning',
            message: `还可尝试 ${error.remainingAttempts}/${error.attemptLimit} 次。`,
        };
    }

    return null;
};

export const LoginPage: React.FC = () => {
    const { user, login, loginWithToken, pending2FA, setPending2FA, refreshUser } = useAuth();
    const { setNotification } = useNotification();
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const { authenticateWithPasskey, authenticateWithDiscoverablePasskey } = usePasskey();
    const prefersReducedMotion = useReducedMotion();

    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
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
    const [showTOTPVerification, setShowTOTPVerification] = useState(false);
    const [showPasskeyVerification, setShowPasskeyVerification] = useState(false);
    const [showVerificationSelector, setShowVerificationSelector] = useState(false);
    const [pendingVerificationData, setPendingVerificationData] = useState<any>(null);
    const [pendingToken, setPendingToken] = useState<string>('');
    const [twoFactorDeadline, setTwoFactorDeadline] = useState<number | null>(null);
    const [twoFactorClock, setTwoFactorClock] = useState(() => Date.now());
    const [rememberMe, setRememberMe] = useState(false);
    const [showPassword, setShowPassword] = useState(false);
    const [showPasskeyHelp, setShowPasskeyHelp] = useState(false);
    const [attemptStatus, setAttemptStatus] = useState<LoginAttemptStatus | null>(null);
    // 每次登录都要重新勾选四份政策文件，因此初始状态不持久化
    const [policyConsent, setPolicyConsent] = useState<PolicyConsentSelection>(createPolicyConsentSelection);
    const [policyConsentInvalid, setPolicyConsentInvalid] = useState(false);
    // 只标记「字段自身的错误」：条款/人机验证等非字段错误不得让无辜输入框被读屏报为无效
    const [invalidFields, setInvalidFields] = useState<{ username: boolean; password: boolean }>({ username: false, password: false });
    const consentComplete = React.useMemo(() => isPolicyConsentComplete(policyConsent), [policyConsent]);

    const effectiveCardVariants = React.useMemo(() => prefersReducedMotion ? FADE_VARIANTS : cardVariants, [prefersReducedMotion]);
    const effectiveCardTransition = React.useMemo(() => prefersReducedMotion ? NO_TRANSITION : CARD_TRANSITION, [prefersReducedMotion]);
    const effectiveItemHover = React.useMemo(() => prefersReducedMotion ? undefined : ITEM_HOVER, [prefersReducedMotion]);
    const effectiveButtonTap = React.useMemo(() => prefersReducedMotion ? undefined : BUTTON_TAP, [prefersReducedMotion]);
    const postLoginRedirect = React.useMemo(() => {
        const raw = searchParams.get('redirectTo') || '';
        if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return null;
        return raw;
    }, [searchParams]);

    // External redirect_uri for PiliPlus-style app deep-link callbacks
    const redirectUri = React.useMemo(() => {
        const raw = searchParams.get('redirect_uri') || '';
        if (!raw) return null;
        try {
            const parsed = new URL(raw);
            const protocol = parsed.protocol;
            // 显式拒绝可执行/数据类 scheme，杜绝 javascript: 反射 XSS
            if (protocol === 'javascript:' || protocol === 'data:' || protocol === 'blob:' || protocol === 'vbscript:' || protocol === 'file:') {
                return null;
            }
            // 只放行已登记的本地应用 scheme（与 LinuxDoAuthCallbackPage 的 synapse:// 约定一致）
            if (protocol === 'synapse:' || protocol === 'piliplus:') {
                return raw;
            }
            // http/https 仅放行 localhost（开发用途）
            if (protocol === 'http:' || protocol === 'https:') {
                if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]') {
                    return raw;
                }
                return null;
            }
            // 其它自定义 scheme 一律不放行，防止把会话 token 交给任意本机应用
            return null;
        } catch {
            return null;
        }
    }, [searchParams]);

    // Ref to hold the login token so it survives across 2FA flows
    const loginTokenRef = React.useRef<string | null>(null);

    const adminLoginRequested = React.useMemo(() => {
        return postLoginRedirect?.startsWith('/admin');
    }, [postLoginRedirect]);
    const completeLogin = React.useCallback(() => {
        // If an external redirect_uri was provided, send the token back to the calling app.
        // token 放在 fragment（#token=），避免进入外部应用的服务端访问日志与 Referer。
        if (redirectUri && loginTokenRef.current) {
            window.location.href = `${redirectUri}#token=${encodeURIComponent(loginTokenRef.current)}`;
            return;
        }
        if (postLoginRedirect) {
            navigate(postLoginRedirect, { replace: true });
            return;
        }
        window.location.reload();
    }, [navigate, postLoginRedirect, redirectUri]);

    useEffect(() => {
        const savedUsername = localStorage.getItem('rememberedUsername');
        if (savedUsername) { setUsername(savedUsername); setRememberMe(true); }
    }, []);

    useEffect(() => { if (captcha?.token) setError(null); }, [captcha?.token]);

    // 待验证期间每秒刷新剩余时间；归零后把续接入口切换成「重新登录」。
    useEffect(() => {
        if (twoFactorDeadline === null) return;
        setTwoFactorClock(Date.now());
        const timer = window.setInterval(() => setTwoFactorClock(Date.now()), 1000);
        return () => window.clearInterval(timer);
    }, [twoFactorDeadline]);

    // 已认证的管理员停留在 /login?redirectTo=/admin 时直接进入管理后台，
    // 覆盖 2FA/Passkey 登录成功后刷新、或登录成功后被弹回登录页等场景。
    useEffect(() => {
        if (user && isAdminRole(user.role) && postLoginRedirect?.startsWith('/admin')) {
            navigate(postLoginRedirect, { replace: true });
        }
    }, [user, postLoginRedirect, navigate]);

    // 人机验证由 /admin/captcha-providers 统一调控（三家共用同一套下发链路）。
    const handleCaptchaSolved = React.useCallback((challenge: ManagedCaptchaChallenge) => setCaptcha(challenge), []);
    const handleCaptchaCleared = React.useCallback(() => setCaptcha(null), []);
    const handleCaptchaStatus = React.useCallback((status: ManagedCaptchaStatus) => setCaptchaStatus(status), []);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (submittingRef.current) return;
        setError(null);
        setAttemptStatus(null);
        setInvalidFields({ username: false, password: false });
        const sanitizedUsername = DOMPurify.sanitize(username).trim();
        if (!sanitizedUsername || !password) { setInvalidFields({ username: !sanitizedUsername, password: !password }); setError('请输入用户名和密码'); return; }
        const consentPayload = buildPolicyConsentPayload(policyConsent);
        if (!consentPayload) {
            setPolicyConsentInvalid(true);
            setError('请先阅读并勾选同意全部四项条款');
            setNotification({ message: '请先阅读并勾选同意全部四项条款', type: 'warning' });
            return;
        }
        if (captchaStatus.required && !captcha?.token) {
            setError('请先完成人机验证'); setNotification({ message: '请先完成人机验证', type: 'warning' }); return;
        }
        setLoading(true);
        submittingRef.current = true;
        try {
            if (rememberMe) { localStorage.setItem('rememberedUsername', sanitizedUsername); }
            else { localStorage.removeItem('rememberedUsername'); }
            const result = await login(
                sanitizedUsername,
                password,
                captcha?.token,
                consentPayload,
                captcha?.provider,
            );
            // 只在完整登录（无 2FA）时保存会话令牌供深链回传。
            // 2FA 未完成时 result.token 是 5 分钟的 2fa_pending 临时令牌，不得外泄给外部应用。
            if (result?.token && !result.requires2FA) {
                loginTokenRef.current = result.token;
            }
            if (result && result.requires2FA && result.twoFactorType) {
                // 密码步骤已消费令牌；二次验证取消或过期后重新登录需要新挑战。
                if (captcha?.token) captchaRef.current?.reset();
                setNotification({ message: '需要二次验证，请选择验证方式', type: 'info' });
                setPendingToken(result.token);
                const verificationTypes = result.twoFactorType;
                if (!verificationTypes || verificationTypes.length === 0) {
                    setNotification({ message: '未启用任何二次验证方式，请联系管理员', type: 'error' }); setLoading(false); return;
                }
                // 确认存在可用的验证方式后才计时，避免这条中止分支留下一个永不停止的计时器
                setTwoFactorDeadline(Date.now() + TWO_FACTOR_PENDING_TTL_MS);
                const hasPasskey = verificationTypes.includes('Passkey');
                const hasTOTP = verificationTypes.includes('TOTP');
                if (hasPasskey && hasTOTP) {
                    setPendingVerificationData({ user: result.user, userId: result.user.id, token: result.token, username: sanitizedUsername, twoFactorType: result.twoFactorType });
                    setShowVerificationSelector(true);
                } else if (hasPasskey) {
                    setPending2FA({ userId: result.user.id, username: sanitizedUsername, type: ['Passkey'] }); setShowPasskeyVerification(true);
                } else if (hasTOTP) {
                    setPending2FA({ userId: result.user.id, username: sanitizedUsername, type: ['TOTP'] }); setShowTOTPVerification(true);
                }
                return;
            }
            if (postLoginRedirect?.startsWith('/admin') && !isAdminRole(result.user?.role)) {
                setNotification({ message: '当前账号没有管理员权限，已返回首页', type: 'warning' });
                navigate('/', { replace: true });
                return;
            }
            setNotification({ message: adminLoginRequested ? '管理员登录成功' : '登录成功', type: 'success' }); completeLogin();
        } catch (err: any) {
            const authError = err as AuthRequestError;
            const attemptFeedback = buildLoginAttemptStatus(authError);
            if (attemptFeedback) setAttemptStatus(attemptFeedback);
            if (captchaStatus.required) {
                // 挑战令牌一次性：失败后必须重新验证（reset 会清状态并重挂控件）
                captchaRef.current?.reset();
            }
            setError(authError.message || '登录失败'); setNotification({ message: authError.message || '登录失败', type: 'error' });
        } finally { submittingRef.current = false; setLoading(false); }
    };

    const handleVerificationMethodSelect = async (method: 'passkey' | 'totp') => {
        setShowVerificationSelector(false); setLoading(true);
        try {
            if (method === 'passkey') {
                const success = await authenticateWithPasskey(pendingVerificationData.username);
                if (success) { abandonTwoFactorVerification(); completeLogin(); }
                else { setError('通行密钥验证失败'); setNotification({ message: '通行密钥验证失败', type: 'error' }); }
            } else if (method === 'totp') {
                setPending2FA({ userId: pendingVerificationData.userId, username: pendingVerificationData.username, type: ['TOTP'] });
                setShowTOTPVerification(true); setNotification({ message: '请进行动态验证码验证', type: 'info' });
            }
        } catch (e: any) {
            const msg = e.message || '验证失败';
            setError(msg);
            setNotification({ message: msg, type: 'error' });
        } finally { setLoading(false); }
    };

    // 误关验证弹窗时只收起界面，保留待验证状态：用户可点「继续二次验证」重新进入，
    // 不必重输密码、重勾四份条款、重过人机验证。
    const handleVerificationSelectorClose = () => { setShowVerificationSelector(false); };

    const resumeTwoFactorVerification = () => {
        const pendingType = pending2FA?.type?.[0];
        if (pendingType === 'Passkey') { setShowPasskeyVerification(true); return; }
        if (pendingType === 'TOTP') { setShowTOTPVerification(true); return; }
        if (pendingVerificationData) setShowVerificationSelector(true);
    };

    // 放弃本次未完成的二次验证：清空待验证状态，回到普通登录表单。
    const abandonTwoFactorVerification = () => {
        setPending2FA(null);
        setPendingVerificationData(null);
        setPendingToken('');
        setTwoFactorDeadline(null);
    };

    const twoFactorRemainingMs = twoFactorDeadline === null ? 0 : Math.max(0, twoFactorDeadline - twoFactorClock);
    const twoFactorExpired = twoFactorDeadline !== null && twoFactorRemainingMs <= 0;
    const twoFactorRemainingText = `${String(Math.floor(twoFactorRemainingMs / 60000)).padStart(2, '0')}:${String(Math.floor((twoFactorRemainingMs % 60000) / 1000)).padStart(2, '0')}`;
    const showTwoFactorPanel = Boolean(pending2FA || pendingVerificationData)
        && !showVerificationSelector && !showPasskeyVerification && !showTOTPVerification;

    return (
        <LazyMotion features={domAnimation}>
            <div className={authPageShellClassName} style={{ fontFamily: studioPageFont }}>
                <div className={authFrameClassName}>
                    <m.div className={authBrandBlockClassName} variants={effectiveCardVariants} initial="hidden" animate="visible" transition={{ duration: 0.5 }}>
                        <div className={authBrandPillClassName}>
                            <FaVolumeUp />
                            Synapse Access
                        </div>
                        <h1 className={authBrandTitleClassName}>Synapse</h1>
                        <p className={authBrandSubtitleClassName}>欢迎回来</p>
                    </m.div>

                    <m.div className={authCardClassName} variants={effectiveCardVariants} initial="hidden" animate="visible" transition={effectiveCardTransition}>
                        <div className={authCardBodyClassName}>
                            <div className={authCardHeaderClassName}>
                                <div className={authHeaderBadgeClassName}>
                                    {adminLoginRequested ? <FaUserShield /> : <FaSignInAlt />}
                                </div>
                                <div>
                                    <div className={authEyebrowClassName}>{adminLoginRequested ? '管理员入口' : '账号登录'}</div>
                                    <h2 className={authTitleClassName}>{adminLoginRequested ? '管理员登录' : '登录账户'}</h2>
                                </div>
                            </div>

                            <div className="mb-5 grid grid-cols-2 rounded-2xl border border-slate-200 bg-slate-50 p-1">
                                <button
                                    type="button"
                                    onClick={() => navigate('/login', { replace: true })}
                                    className={cn(
                                        'rounded-xl px-3 py-2 text-sm font-semibold transition',
                                        !postLoginRedirect?.startsWith('/admin') ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-900',
                                    )}
                                >
                                    用户入口
                                </button>
                                <button
                                    type="button"
                                    onClick={() => {
                                        if (!username) setUsername('admin');
                                        navigate('/login?redirectTo=%2Fadmin', { replace: true });
                                    }}
                                    className={cn(
                                        'rounded-xl px-3 py-2 text-sm font-semibold transition',
                                        postLoginRedirect?.startsWith('/admin') ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-900',
                                    )}
                                >
                                    管理员入口
                                </button>
                            </div>

                            {user && (
                                <m.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} className={cn(authInfoPanelClassName, 'mb-5 flex items-start gap-3')}>
                                    <FaUser className="mt-1 shrink-0 text-slate-500" />
                                    <div>
                                        <p className="text-xs font-semibold text-slate-900">您已登录为 {user.username}</p>
                                        <p className="mt-1 text-[11px] leading-5 text-slate-600">继续登录将在此设备上添加新账号，您可以在菜单中随时切换。</p>
                                    </div>
                                </m.div>
                            )}

                            {adminLoginRequested && (
                                <m.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} className={cn(authWarningPanelClassName, 'mb-5 flex items-start gap-3')}>
                                    <FaShieldAlt className="mt-1 shrink-0 text-amber-600" />
                                    <div>
                                        <p className="text-xs font-semibold text-amber-950">管理员会话</p>
                                        <p className="mt-1 text-[11px] leading-5">登录后将进入管理后台，非管理员账号会被带回首页。</p>
                                    </div>
                                </m.div>
                            )}

                            <form className={authFormClassName} onSubmit={handleSubmit}>
                                {error && <div role="alert" aria-live="assertive" className={authAlertClassName}>{error}</div>}
                                {attemptStatus && (
                                    <div
                                        role="status"
                                        aria-live="polite"
                                        className={attemptStatus.tone === 'locked' ? authWarningPanelClassName : authInfoPanelClassName}
                                    >
                                        {attemptStatus.message}
                                    </div>
                                )}

                                <div>
                                    <label htmlFor="username" className={authLabelClassName}>邮箱或用户名</label>
                                    <div className="relative">
                                        <FaEnvelope className={authFieldIconClassName} />
                                        <input id="username" name="username" type="text" required inputMode="text" enterKeyHint="next" aria-label="用户名或邮箱" aria-required="true" aria-invalid={invalidFields.username}
                                            className={authFieldClassName}
                                            placeholder="请输入邮箱或用户名" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
                                    </div>
                                </div>

                                <div>
                                    <div className="mb-2 flex items-center justify-between">
                                        <label htmlFor="password" className="block text-sm font-medium text-slate-700">密码</label>
                                        <Link to="/forgot-password" className={authMutedLinkClassName} aria-label="忘记密码">忘记密码？</Link>
                                    </div>
                                    <div className="relative">
                                        <FaLock className={authFieldIconClassName} />
                                        <input id="password" name="password" type={showPassword ? 'text' : 'password'} required enterKeyHint="done" aria-label="密码" aria-required="true" aria-invalid={invalidFields.password}
                                            className={authPasswordFieldClassName}
                                            placeholder="请输入密码" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
                                        <button type="button" onClick={() => setShowPassword(!showPassword)} className={authFieldActionClassName} aria-label={showPassword ? '隐藏密码' : '显示密码'}>
                                            {showPassword ? <FaEyeSlash className="h-4 w-4" /> : <FaEye className="h-4 w-4" />}
                                        </button>
                                    </div>
                                </div>

                                <div className="flex items-center">
                                    <input id="remember-me" name="remember-me" type="checkbox" checked={rememberMe} onChange={(e) => setRememberMe(e.target.checked)} className={authCheckboxClassName} />
                                    <label htmlFor="remember-me" className="ml-2 block text-sm text-slate-600">记住我</label>
                                </div>

                                <PolicyConsentChecklist
                                    selection={policyConsent}
                                    onChange={next => { setPolicyConsent(next); if (policyConsentInvalid) setPolicyConsentInvalid(false); }}
                                    showInvalid={policyConsentInvalid}
                                    disabled={loading}
                                />

                                <ManagedCaptcha
                                    ref={captchaRef}
                                    scenario="default"
                                    onSolved={handleCaptchaSolved}
                                    onCleared={handleCaptchaCleared}
                                    onStatusChange={handleCaptchaStatus}
                                />

                                <m.button type="submit" disabled={loading || (captchaStatus.required && !captcha?.token)} aria-label={loading ? '正在登录' : '登录'} aria-busy={loading}
                                    className={authPrimaryButtonClassName}
                                    whileHover={effectiveItemHover} whileTap={effectiveButtonTap}>
                                    {loading ? '登录中...' : '登录'}
                                </m.button>
                            </form>

                            {/* 其他登录方式（安卓客户端 / Google / Linux.do / 通行密钥）同样受同意约束：
                                未逐项勾选前不渲染入口。Google 按钮由 GIS 脚本注入原生 iframe，
                                点击无法被 React 拦截，隐藏入口是唯一对所有方式都生效的做法。 */}
                            {consentComplete ? (
                                <>
                                    <div className={authDividerClassName}>
                                        <div className="absolute inset-0 flex items-center"><div className={authDividerLineClassName}></div></div>
                                        <div className="relative flex justify-center"><span className={authDividerLabelClassName}>或者使用以下方式</span></div>
                                    </div>

                                    <div className="space-y-4">
                                        <MobileLoginPanel
                                            disabled={loading}
                                            loginWithToken={loginWithToken}
                                            onSuccess={completeLogin}
                                        />
                                        <GoogleAuthButton
                                            intent="login"
                                            label="使用 Google 登录"
                                            description="用 Google 账号登录；尚未关联本站账号时会引导你绑定一个已有账号"
                                        />
                                        <LinuxDoAuthButton
                                            intent="login"
                                            label="使用 Linux.do 登录"
                                            description="用 Linux.do 论坛账号登录；尚未关联本站账号时会引导你绑定一个已有账号"
                                        />
                                <div className={authInfoPanelClassName}>
                                    <div className="flex items-start gap-3">
                                        <FaFingerprint className="mt-1 h-5 w-5 shrink-0 text-slate-500" />
                                        <div className="min-w-0 flex-1">
                                            <h3 className="text-sm font-semibold text-slate-900">通行密钥</h3>
                                            <p className="mt-1 text-xs leading-5 text-slate-600">使用生物识别或设备认证完成无密码登录。</p>
                                            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
                                                {[{ Icon: FaShieldAlt, label: '安全', sub: '防钓鱼' }, { Icon: FaBolt, label: '快速', sub: '一键登录' }, { Icon: FaMobileAlt, label: '简单', sub: '无需密码' }].map(({ Icon, label, sub }) => (
                                                    <div key={label} className="rounded-2xl border border-slate-200 bg-white/80 p-2 text-center">
                                                        <Icon className="mx-auto mb-1 h-4 w-4 text-slate-500" />
                                                        <span className="block text-xs font-medium text-slate-900">{label}</span>
                                                        <span className="block text-[10px] text-slate-500">{sub}</span>
                                                    </div>))}
                                            </div>
                                            <button type="button" onClick={() => setShowPasskeyHelp(!showPasskeyHelp)} className="mt-3 flex items-center gap-1.5 text-xs font-medium text-slate-500 transition hover:text-slate-900">
                                                <FaQuestionCircle className="h-3 w-3" /><span>{showPasskeyHelp ? '隐藏' : '显示'}详细指南</span>
                                                {showPasskeyHelp ? <FaChevronUp className="h-2.5 w-2.5" /> : <FaChevronDown className="h-2.5 w-2.5" />}
                                            </button>
                                        </div>
                                    </div>
                                    {showPasskeyHelp && (
                                        <div className="mt-4 space-y-3 border-t border-slate-200 pt-4">
                                            {[
                                                { num: '1', title: '如何使用通行密钥', items: ['点击下方“使用通行密钥登录”按钮', '浏览器将提示您进行认证', '使用指纹、面部识别或设备 PIN 码', '验证后将自动登录'] },
                                                { num: '2', title: '前置要求', items: ['您必须已为账户注册了通行密钥', '您的设备必须支持生物认证或安全密钥', '使用现代浏览器'] },
                                            ].map(({ num, title, items }) => (
                                                <div key={num}>
                                                    <h4 className="mb-2 flex items-center gap-2 text-xs font-semibold text-slate-900">
                                                        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-slate-900 text-[10px] text-white">{num}</span>{title}
                                                    </h4>
                                                    <ul className="ml-7 space-y-1.5 text-xs leading-5 text-slate-600">
                                                        {items.map(item => <li key={item}>{item}</li>)}
                                                    </ul>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                                <m.button type="button" onClick={async () => { try { setLoading(true); const success = await authenticateWithDiscoverablePasskey(); if (success) { setNotification({ message: '通行密钥登录成功！', type: 'success' }); completeLogin(); } } catch (err: any) { setNotification({ message: err.message || '通行密钥登录失败', type: 'error' }); } finally { setLoading(false); } }} disabled={loading}
                                    className={authSecondaryButtonClassName}
                                    aria-label="Sign in with Passkey" whileHover={effectiveItemHover} whileTap={effectiveButtonTap}>
                                    <FaFingerprint className="h-5 w-5" />
                                    使用通行密钥登录
                                </m.button>
                                    </div>
                                </>
                            ) : (
                                <p className="text-center text-xs leading-5 text-slate-500">
                                    勾选上方四项条款后，可使用安卓客户端、Google、Linux.do 或通行密钥登录。
                                </p>
                            )}

                            {showTwoFactorPanel && (twoFactorExpired ? (
                                <m.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} className={cn(authAlertClassName, 'mt-6')}>
                                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                                        <div className="flex items-start gap-3">
                                            <FaShieldAlt className="mt-0.5 shrink-0" />
                                            <div>
                                                <p className="text-xs font-semibold">本次二次验证已过期</p>
                                                <p className="mt-1 text-[11px] leading-5">验证令牌有效期为 5 分钟，已自动失效。请重新输入密码登录。</p>
                                            </div>
                                        </div>
                                        <button type="button" onClick={abandonTwoFactorVerification} className={cn(authSecondaryButtonClassName, 'w-full shrink-0 sm:w-auto')}>
                                            重新登录
                                        </button>
                                    </div>
                                </m.div>
                            ) : (
                                <m.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} className={cn(authWarningPanelClassName, 'mt-6')}>
                                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                                        <div className="flex items-start gap-3">
                                            <FaShieldAlt className="mt-0.5 shrink-0 text-amber-600" />
                                            <div>
                                                <p className="text-xs font-semibold text-amber-950">还有一次二次验证未完成</p>
                                                <p className="mt-1 text-[11px] leading-5">
                                                    请在 <span className="font-mono font-semibold">{twoFactorRemainingText}</span> 内完成验证；关闭验证窗口不会取消本次登录，无需重新输入密码。
                                                </p>
                                            </div>
                                        </div>
                                        <button type="button" onClick={resumeTwoFactorVerification} className={cn(authSecondaryButtonClassName, 'w-full shrink-0 sm:w-auto')}>
                                            继续二次验证
                                        </button>
                                    </div>
                                </m.div>
                            ))}

                            <div className="mt-6 text-center">
                                <p className="text-sm text-slate-600">还没有账户？<Link to="/register" className={authTextLinkClassName}>立即注册</Link></p>
                            </div>
                        </div>
                    </m.div>

                    <div className="mt-6 text-center">
                        <Link to="/" className={authBackLinkClassName} aria-label="返回首页">
                            <FaArrowLeft className="h-3.5 w-3.5" />返回首页
                        </Link>
                    </div>
                </div>

                <PasskeyVerifyModal open={showPasskeyVerification || false} username={username} onSuccess={() => { setShowPasskeyVerification(false); abandonTwoFactorVerification(); completeLogin(); }} onClose={() => setShowPasskeyVerification(false)} />
                {showTOTPVerification && (<TOTPVerification isOpen={showTOTPVerification} onClose={() => setShowTOTPVerification(false)} onSuccess={async () => { setShowTOTPVerification(false); abandonTwoFactorVerification(); await refreshUser(); completeLogin(); }} userId={pending2FA?.userId || ''} token={pendingToken || ''} />)}
                {showVerificationSelector && pendingVerificationData && (<VerificationMethodSelector isOpen={showVerificationSelector} onClose={handleVerificationSelectorClose} onSelectMethod={handleVerificationMethodSelect} username={pendingVerificationData.username} loading={loading} availableMethods={pendingVerificationData.twoFactorType?.map((type: string) => type === 'Passkey' ? 'passkey' : type === 'TOTP' ? 'totp' : null).filter(Boolean) as ('passkey' | 'totp')[] || []} />)}
            </div>
        </LazyMotion>
    );
};
