import React, { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import DOMPurify from 'dompurify';
import { useNotification } from './Notification';
import GoogleAuthButton from './GoogleAuthButton';
import LinuxDoAuthButton from './LinuxDoAuthButton';
import ManagedCaptcha, {
    type ManagedCaptchaChallenge,
    type ManagedCaptchaRef,
    type ManagedCaptchaStatus,
} from './ManagedCaptcha';
import { AnimatePresence, LazyMotion, domAnimation, m, useReducedMotion } from 'framer-motion';
import { api } from '../api/api';
import { FaEnvelope, FaLock, FaEye, FaEyeSlash, FaUser, FaVolumeUp, FaArrowLeft, FaUserPlus, FaCheckCircle, FaInfoCircle, FaTicketAlt } from 'react-icons/fa';
import { getFingerprint, getClientIP } from '../utils/fingerprint';
import { getBackendErrorMessage } from '../utils/backendError';
import PolicyConsentChecklist from './PolicyConsentChecklist';
import {
    buildPolicyConsentPayload,
    createPolicyConsentSelection,
    isPolicyConsentComplete,
    type PolicyConsentSelection,
} from '../utils/policyConsent';
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
    authDividerClassName,
    authDividerLabelClassName,
    authDividerLineClassName,
    authEyebrowClassName,
    authFieldActionClassName,
    authFieldClassName,
    authFieldIconClassName,
    authFormClassName,
    authFrameClassName,
    authHeaderBadgeClassName,
    authInfoPanelClassName,
    authLabelClassName,
    authModalCardClassName,
    authModalOverlayClassName,
    authPageShellClassName,
    authPasswordFieldClassName,
    authPrimaryButtonClassName,
    authSecondaryButtonClassName,
    authSuccessPanelClassName,
    authTextLinkClassName,
    authTitleClassName,
    authWarningPanelClassName,
    studioPageFont,
} from './authStudioTheme';
import { cn } from '../utils/cn';

interface PasswordStrength { score: number; feedback: string; }

const NO_TRANSITION = { duration: 0 } as const;
const FADE_VARIANTS = { hidden: { opacity: 0 }, visible: { opacity: 1 } } as const;
const cardVariants = { hidden: { opacity: 0, y: 24 }, visible: { opacity: 1, y: 0 } };
const CARD_TRANSITION = { duration: 0.45, type: 'spring', stiffness: 130 } as const;
const ITEM_HOVER = { scale: 1.01, y: -1 } as const;
const BUTTON_TAP = { scale: 0.99 } as const;

export const RegisterPage: React.FC = () => {
    const { user } = useAuth();
    const { setNotification } = useNotification();
    const navigate = useNavigate();
    const prefersReducedMotion = useReducedMotion();

    const [username, setUsername] = useState('');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [invitationCode, setInvitationCode] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [policyConsent, setPolicyConsent] = useState<PolicyConsentSelection>(createPolicyConsentSelection);
    const [policyConsentInvalid, setPolicyConsentInvalid] = useState(false);
    // 只标记「字段自身的错误」：条款/人机验证等非字段错误不得污染 aria-invalid
    const [invalidFields, setInvalidFields] = useState<{ username: boolean; email: boolean; password: boolean }>({ username: false, email: false, password: false });
    const [passwordStrength, setPasswordStrength] = useState<PasswordStrength>({ score: 0, feedback: '' });
    const [captcha, setCaptcha] = useState<ManagedCaptchaChallenge | null>(null);
    const captchaRef = React.useRef<ManagedCaptchaRef | null>(null);
    const [captchaStatus, setCaptchaStatus] = useState<ManagedCaptchaStatus>({
        required: false,
        loading: true,
        error: null,
        provider: null,
        solved: false,
    });
    const [showEmailVerify, setShowEmailVerify] = useState(false);
    const [pendingEmail, setPendingEmail] = useState('');
    const [showPassword, setShowPassword] = useState(false);
    const [showConfirmPassword, setShowConfirmPassword] = useState(false);

    const effectiveCardVariants = React.useMemo(() => prefersReducedMotion ? FADE_VARIANTS : cardVariants, [prefersReducedMotion]);
    const effectiveCardTransition = React.useMemo(() => prefersReducedMotion ? NO_TRANSITION : CARD_TRANSITION, [prefersReducedMotion]);
    const effectiveItemHover = React.useMemo(() => prefersReducedMotion ? undefined : ITEM_HOVER, [prefersReducedMotion]);
    const effectiveButtonTap = React.useMemo(() => prefersReducedMotion ? undefined : BUTTON_TAP, [prefersReducedMotion]);

    const allowedDomains = ['gmail.com', 'outlook.com', 'qq.com', '163.com', '126.com', 'hotmail.com', 'yahoo.com', 'icloud.com', 'foxmail.com', 'chloemlla.com'];
    const emailPattern = new RegExp(`^[\\w.-]+@(${allowedDomains.map(d => d.replace('.', '\\.')).join('|')})$`);
    const reservedUsernames = ['admin', 'root', 'system', 'test', 'administrator'];

    useEffect(() => { if (captcha?.token) setError(null); }, [captcha?.token]);

    // 人机验证由 /admin/captcha-providers 统一调控（三家共用同一套下发链路）。
    const handleCaptchaSolved = React.useCallback((challenge: ManagedCaptchaChallenge) => setCaptcha(challenge), []);
    const handleCaptchaCleared = React.useCallback(() => setCaptcha(null), []);
    const handleCaptchaStatus = React.useCallback((status: ManagedCaptchaStatus) => setCaptchaStatus(status), []);

    const checkPasswordStrength = (pwd: string): PasswordStrength => {
        let score = 0; const feedback: string[] = [];
        if (pwd.length < 8) { feedback.push('密码长度至少需要8个字符'); } else if (pwd.length >= 12) { score += 2; } else { score += 1; }
        if (/\d/.test(pwd)) score += 1; else feedback.push('需要包含数字');
        if (/[a-z]/.test(pwd)) score += 1; else feedback.push('需要包含小写字母');
        if (/[A-Z]/.test(pwd)) score += 1; else feedback.push('需要包含大写字母');
        if (/[!@#$%^&*(),.?":{}|<>]/.test(pwd)) score += 1; else feedback.push('需要包含特殊字符');
        const commonPatterns = [/^123/, /password/i, /qwerty/i, /abc/i, new RegExp(username, 'i')];
        if (commonPatterns.some(pattern => pattern.test(pwd))) { score = 0; feedback.push('请避免使用常见密码模式'); }
        return { score, feedback: feedback.join('、') };
    };

    const validateInput = (value: string, type: 'username' | 'email' | 'password'): string | null => {
        const sanitizedValue = DOMPurify.sanitize(value).trim();
        switch (type) {
            case 'username':
                if (!/^[a-zA-Z0-9_]{3,20}$/.test(sanitizedValue)) return '用户名只能包含字母、数字和下划线，长度3-20个字符';
                if (reservedUsernames.includes(sanitizedValue.toLowerCase())) return '该用户名为保留字段，不能注册';
                if (/[';"']/.test(sanitizedValue)) return '用户名包含非法字符';
                break;
            case 'email':
                if (!emailPattern.test(sanitizedValue)) return '只支持主流邮箱（如gmail、outlook、qq、163、126等）';
                break;
            case 'password':
                const strength = checkPasswordStrength(sanitizedValue);
                if (strength.score < 2) return strength.feedback || '密码强度不足';
                break;
        }
        return null;
    };

    useEffect(() => {
        if (!username || !email) { setPasswordStrength({ score: 0, feedback: '' }); return; }
        if (password) { setPasswordStrength(checkPasswordStrength(password)); } else { setPasswordStrength({ score: 0, feedback: '' }); }
    }, [password, username, email]);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault(); setError(null);
        setInvalidFields({ username: false, email: false, password: false });
        const usernameError = validateInput(username, 'username'); if (usernameError) { setInvalidFields({ username: true, email: false, password: false }); setError(usernameError); return; }
        const emailError = validateInput(email, 'email'); if (emailError) { setInvalidFields({ username: false, email: true, password: false }); setError(emailError); return; }
        const passwordError = validateInput(password, 'password'); if (passwordError) { setInvalidFields({ username: false, email: false, password: true }); setError(passwordError); return; }
        if (password !== confirmPassword) { setError('两次输入的密码不一致'); return; }
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
        try {
            const sanitizedUsername = DOMPurify.sanitize(username).trim();
            const sanitizedEmail = DOMPurify.sanitize(email).trim();
            const sanitizedInvitationCode = DOMPurify.sanitize(invitationCode).trim().toUpperCase();
            const [fingerprint, clientIP] = await Promise.all([getFingerprint(), getClientIP()]);
            if (!fingerprint) { setError('无法获取设备信息，请稍后重试'); setLoading(false); return; }
            const requestBody: any = { username: sanitizedUsername, email: sanitizedEmail, password, fingerprint, clientIP, policyConsent: consentPayload };
            if (sanitizedInvitationCode) requestBody.invitationCode = sanitizedInvitationCode;
            if (captcha?.token) {
                // 三家共用契约：captchaProvider 告诉后端这次是哪个供应商签发的；cfToken 是老后端兼容字段。
                requestBody.captchaToken = captcha.token;
                requestBody.captchaProvider = captcha.provider;
                requestBody.cfToken = captcha.token;
            }
            const res = await api.post('/api/auth/register', requestBody);
            const data = res.data;
            if (data && data.needVerify) {
                setNotification({ message: data.message || '验证链接已发送到您的邮箱，请点击链接完成注册', type: 'success' });
                setError(''); setShowEmailVerify(true); setPendingEmail(sanitizedEmail);
                // 挑战令牌一次性：注册请求已核销过它，下一次必须重新验证
                captchaRef.current?.reset();
            } else {
                setError(data?.error || '注册失败'); setNotification({ message: data?.error || '注册失败', type: 'error' });
            }
        } catch (err: any) {
            const msg = getBackendErrorMessage(err, '注册失败');
            setError(msg); setNotification({ message: msg, type: 'error' });
        } finally { setLoading(false); }
    };

    const strengthLabel = passwordStrength.score >= 4 ? '很强' : passwordStrength.score >= 3 ? '强' : passwordStrength.score >= 2 ? '中等' : '弱';
    const strengthColor = passwordStrength.score >= 4 ? 'text-emerald-600' : passwordStrength.score >= 3 ? 'text-slate-700' : passwordStrength.score >= 2 ? 'text-amber-600' : 'text-rose-600';

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
                        <p className={authBrandSubtitleClassName}>创建账号</p>
                    </m.div>

                    <m.div className={authCardClassName} variants={effectiveCardVariants} initial="hidden" animate="visible" transition={effectiveCardTransition}>
                        <div className={authCardBodyClassName}>
                            <div className={authCardHeaderClassName}>
                                <div className={authHeaderBadgeClassName}>
                                    <FaUserPlus />
                                </div>
                                <div>
                                    <div className={authEyebrowClassName}>新账号</div>
                                    <h2 className={authTitleClassName}>创建账户</h2>
                                </div>
                            </div>

                            {user && (
                                <m.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} className={cn(authInfoPanelClassName, 'mb-5 flex items-start gap-3')}>
                                    <FaUser className="mt-1 shrink-0 text-slate-500" />
                                    <div>
                                        <p className="text-xs font-semibold text-slate-900">您已登录为 {user.username}</p>
                                        <p className="mt-1 text-[11px] leading-5 text-slate-600">注册新账号将自动添加至此设备的账号列表中，您可以随时切换。</p>
                                    </div>
                                </m.div>
                            )}

                            <form className={authFormClassName} onSubmit={handleSubmit} aria-label="注册表单">
                                {error && <div role="alert" aria-live="assertive" className={authAlertClassName}>{error}</div>}

                                <div>
                                    <label htmlFor="username" className={authLabelClassName}>用户名</label>
                                    <div className="relative">
                                        <FaUser className={authFieldIconClassName} />
                                        <input id="username" name="username" type="text" required inputMode="text" enterKeyHint="next" aria-label="用户名" aria-required="true" aria-invalid={invalidFields.username} aria-describedby="username-hint"
                                            className={authFieldClassName}
                                            placeholder="3-20个字符" value={username} onChange={(e) => setUsername(e.target.value)} maxLength={20} pattern="^[a-zA-Z0-9_]{3,20}$" autoComplete="username" />
                                        <span id="username-hint" className="sr-only">用户名长度3到20个字符，只允许字母、数字和下划线</span>
                                    </div>
                                </div>

                                <div>
                                    <label htmlFor="email" className={authLabelClassName}>邮箱</label>
                                    <div className="relative">
                                        <FaEnvelope className={authFieldIconClassName} />
                                        <input id="email" name="email" type="email" required inputMode="email" enterKeyHint="next" aria-label="邮箱地址" aria-required="true" aria-invalid={invalidFields.email} aria-describedby="email-hint"
                                            className={authFieldClassName}
                                            placeholder="请输入邮箱地址" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
                                    </div>
                                    <p id="email-hint" className="mt-2 text-xs leading-5 text-slate-500">只支持主流邮箱：{allowedDomains.join('、')}</p>
                                </div>

                                <div>
                                    <label htmlFor="password" className={authLabelClassName}>密码</label>
                                    <div className="relative">
                                        <FaLock className={authFieldIconClassName} />
                                        <input id="password" name="password" type={showPassword ? 'text' : 'password'} required enterKeyHint="next" aria-label="密码" aria-required="true" aria-invalid={invalidFields.password} aria-describedby="password-strength"
                                            className={authPasswordFieldClassName}
                                            placeholder="请输入密码" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} autoComplete="new-password" />
                                        <button type="button" onClick={() => setShowPassword(!showPassword)} className={authFieldActionClassName} aria-label={showPassword ? '隐藏密码' : '显示密码'}>
                                            {showPassword ? <FaEyeSlash className="h-4 w-4" /> : <FaEye className="h-4 w-4" />}
                                        </button>
                                    </div>
                                    {password && username && email && (
                                        <div id="password-strength" className="mt-2 rounded-2xl border border-slate-200 bg-slate-50/80 p-3 text-xs leading-5" role="status" aria-live="polite">
                                            <div className="text-slate-600">密码强度：<span className={`ml-1 font-semibold ${strengthColor}`}>{strengthLabel}</span></div>
                                            {passwordStrength.feedback && <div className="mt-1 text-slate-500">{passwordStrength.feedback}</div>}
                                        </div>
                                    )}
                                </div>

                                <div>
                                    <label htmlFor="confirmPassword" className={authLabelClassName}>确认密码</label>
                                    <div className="relative">
                                        <FaLock className={authFieldIconClassName} />
                                        <input id="confirmPassword" name="confirmPassword" type={showConfirmPassword ? 'text' : 'password'} required enterKeyHint="done" aria-label="确认密码" aria-required="true" aria-invalid={confirmPassword.length > 0 && password !== confirmPassword}
                                            className={authPasswordFieldClassName}
                                            placeholder="请再次输入密码" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} autoComplete="new-password" />
                                        <button type="button" onClick={() => setShowConfirmPassword(!showConfirmPassword)} className={authFieldActionClassName} aria-label={showConfirmPassword ? '隐藏密码' : '显示密码'}>
                                            {showConfirmPassword ? <FaEyeSlash className="h-4 w-4" /> : <FaEye className="h-4 w-4" />}
                                        </button>
                                    </div>
                                </div>

                                <div>
                                    <label htmlFor="invitationCode" className={authLabelClassName}>邀请码</label>
                                    <div className="relative">
                                        <FaTicketAlt className={authFieldIconClassName} />
                                        <input id="invitationCode" name="invitationCode" type="text" inputMode="text" enterKeyHint="next" aria-label="邀请码"
                                            className={authFieldClassName}
                                            placeholder="如站点要求，请填写邀请码" value={invitationCode} onChange={(e) => setInvitationCode(e.target.value.toUpperCase())} maxLength={32} autoComplete="off" />
                                    </div>
                                </div>

                                <ManagedCaptcha
                                    ref={captchaRef}
                                    scenario="default"
                                    onSolved={handleCaptchaSolved}
                                    onCleared={handleCaptchaCleared}
                                    onStatusChange={handleCaptchaStatus}
                                />

                                <PolicyConsentChecklist
                                    selection={policyConsent}
                                    onChange={next => { setPolicyConsent(next); if (policyConsentInvalid) setPolicyConsentInvalid(false); }}
                                    showInvalid={policyConsentInvalid}
                                    disabled={loading}
                                />

                                {/* 不因「两次密码不一致」禁用提交：按钮点不动时页面没有任何原因说明，
                                    交给 handleSubmit 在提交后给出「两次输入的密码不一致」提示。 */}
                                <m.button type="submit" disabled={loading || (captchaStatus.required && !captcha?.token)} aria-label={loading ? '正在注册' : '创建账号'} aria-busy={loading}
                                    className={authPrimaryButtonClassName}
                                    whileHover={effectiveItemHover} whileTap={effectiveButtonTap}>
                                    {loading ? '注册中...' : '创建账户'}
                                </m.button>
                            </form>

                            {/* 第三方注册入口同样受同意约束：未逐项勾选前不渲染，
                                Google 按钮由 GIS 脚本注入原生 iframe，无法靠事件拦截拦住。 */}
                            {isPolicyConsentComplete(policyConsent) ? (
                                <>
                                    <div className={authDividerClassName}>
                                        <div className="absolute inset-0 flex items-center"><div className={authDividerLineClassName}></div></div>
                                        <div className="relative flex justify-center"><span className={authDividerLabelClassName}>或者</span></div>
                                    </div>

                                    <div className="space-y-4">
                                        <GoogleAuthButton
                                            intent="register"
                                            label="使用 Google 注册或登录"
                                            description="使用 Google 账号快速注册，首次登录自动创建本地账户"
                                        />
                                        <LinuxDoAuthButton
                                            intent="register"
                                            label="使用 Linux.do 一键注册"
                                            description="复用 Linux.do 论坛账号，首次登录自动创建本地账户"
                                        />
                                    </div>
                                </>
                            ) : (
                                <p className="text-center text-xs leading-5 text-slate-500">
                                    勾选上方四项条款后，可使用 Google 或 Linux.do 注册。
                                </p>
                            )}

                            <div className="mt-6 text-center">
                                <p className="text-sm text-slate-600">已有账户？<Link to="/login" className={authTextLinkClassName}>立即登录</Link></p>
                            </div>
                        </div>
                    </m.div>

                    <div className="mt-6 text-center">
                        <Link to="/" className={authBackLinkClassName} aria-label="返回首页">
                            <FaArrowLeft className="h-3.5 w-3.5" />返回首页
                        </Link>
                    </div>
                </div>

                <AnimatePresence>
                    {showEmailVerify && (
                        <m.div className={authModalOverlayClassName} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.3 }} role="dialog" aria-modal="true" aria-labelledby="verify-email-title" aria-describedby="verify-email-description">
                            <m.div className={`${authModalCardClassName} max-h-[90vh] overflow-y-auto overscroll-contain`}
                                initial={{ scale: 0.95, opacity: 0, y: 24 }} animate={{ scale: 1, opacity: 1, y: 0 }} exit={{ scale: 0.95, opacity: 0, y: 24 }} transition={{ duration: 0.3, type: 'spring', damping: 25, stiffness: 300 }}>
                                <div className="text-center">
                                    <div className="mx-auto mb-5 flex h-14 w-14 sm:h-16 sm:w-16 items-center justify-center rounded-2xl bg-emerald-100">
                                        <FaCheckCircle className="h-8 w-8 text-emerald-600" />
                                    </div>
                                    <div className={authEyebrowClassName}>Email Verification</div>
                                    <h3 id="verify-email-title" className="mt-2 text-2xl font-semibold text-slate-900">验证邮件已发送</h3>
                                    <p id="verify-email-description" className="mt-3 text-sm leading-7 text-slate-600">
                                        我们已向 <span className="font-semibold text-slate-900">{pendingEmail}</span> 发送了验证链接
                                    </p>
                                </div>

                                <div className={cn(authInfoPanelClassName, 'mt-6')}>
                                    <div className="flex items-start gap-3">
                                        <FaInfoCircle className="mt-1 shrink-0 text-slate-500" />
                                        <div className="text-sm leading-6 text-slate-600">
                                            <p className="font-semibold text-slate-900">下一步操作</p>
                                            <p className="mt-1">打开邮箱，找到来自 Synapse 的验证邮件，并使用相同设备和网络打开链接。</p>
                                        </div>
                                    </div>
                                </div>

                                <div className={cn(authWarningPanelClassName, 'mt-4')}>
                                    验证链接 10 分钟内有效，请及时验证。
                                </div>

                                <div className="mt-6 space-y-3">
                                    <button type="button" className={authPrimaryButtonClassName}
                                        onClick={() => { setShowEmailVerify(false); navigate('/login'); }}>前往登录页面</button>
                                    <button type="button" className={authSecondaryButtonClassName} onClick={() => setShowEmailVerify(false)} aria-label="返回修改邮箱地址">返回修改邮箱</button>
                                </div>
                            </m.div>
                        </m.div>
                    )}
                </AnimatePresence>
            </div>
        </LazyMotion>
    );
};
