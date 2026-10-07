import React, { useState, useEffect } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { useNotification } from './Notification';
import { FaVolumeUp, FaCheckCircle, FaTimesCircle, FaUser, FaInfoCircle } from 'react-icons/fa';
import { verifyEmailLinkOnce } from '../utils/emailLinkVerification';
import { getBackendErrorMessage } from '../utils/backendError';
import {
    authBackLinkClassName,
    authBrandBlockClassName,
    authBrandSubtitleClassName,
    authBrandTitleClassName,
    authCardClassName,
    authFrameClassName,
    authInfoPanelClassName,
    authPageShellClassName,
    authPrimaryButtonClassName,
    authSecondaryButtonClassName,
} from './authStudioTheme';
import { cn } from '../utils/cn';

export const EmailVerifyPage: React.FC = () => {
    const { user } = useAuth();
    const { setNotification } = useNotification();
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const token = searchParams.get('token');
    const [loading, setLoading] = useState(true);
    const [success, setSuccess] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [retryVersion, setRetryVersion] = useState(0);

    useEffect(() => {
        // 请求按 token 共享；卸载只取消本消费者，避免 StrictMode 重挂载消费同一链接两次。
        let active = true;
        let redirectTimer: ReturnType<typeof setTimeout> | undefined;
        setLoading(true);
        setSuccess(false);
        setError(null);

        const verifyEmail = async () => {
            if (!token) {
                setError('验证链接无效，请重新获取');
                setLoading(false);
                return;
            }
            try {
                const data = await verifyEmailLinkOnce(token);
                if (!active) return;
                if (data.success) {
                    setSuccess(true);
                    setNotification({ message: data.message || '邮箱验证成功！', type: 'success' });
                    redirectTimer = setTimeout(() => {
                        if (active) navigate('/login');
                    }, 3000);
                } else {
                    setError(data.error || '验证失败，请重试');
                    setNotification({ message: data.error || '验证失败', type: 'error' });
                }
            } catch (err) {
                if (!active) return;
                const message = getBackendErrorMessage(err, '验证暂时失败，请重试');
                setError(message);
                setNotification({ message, type: 'error' });
            } finally {
                if (active) setLoading(false);
            }
        };

        void verifyEmail();
        return () => {
            active = false;
            if (redirectTimer !== undefined) clearTimeout(redirectTimer);
        };
    }, [token, retryVersion, navigate, setNotification]);

    return (
        <div className={authPageShellClassName}>
            <div className={cn(authFrameClassName, 'min-w-0')}>
                {/* Header */}
                <div className={cn(authBrandBlockClassName, 'animate-slideInUp')}>
                    <div className="mb-4 inline-flex items-center gap-3">
                        <FaVolumeUp className="h-8 w-8 sm:h-10 sm:w-10 text-slate-900" />
                        <h1 className={authBrandTitleClassName}>Synapse</h1>
                    </div>
                    <p className={authBrandSubtitleClassName}>邮箱验证</p>
                </div>

                {/* Card */}
                <div className={cn(authCardClassName, 'hover:shadow-2xl transition-all duration-300')}>
                    {user && (
                        <div className={cn(authInfoPanelClassName, 'mb-6 flex items-start gap-3 animate-fadeIn')}>
                            <FaInfoCircle className="mt-1 flex-shrink-0 text-slate-500" />
                            <div>
                                <p className="text-xs font-bold text-slate-900">您当前登录为 {user.username}</p>
                                <p className="text-[11px] text-slate-600 mt-0.5">您正在验证另一个账号。验证完成后，您可以将其添加至此设备。</p>
                            </div>
                        </div>
                    )}
                    {loading ? (
                        <div className="text-center py-8">
                            <div className="w-12 h-12 sm:w-16 sm:h-16 border-4 border-slate-200 border-t-slate-900 rounded-full animate-spin mx-auto mb-4"></div>
                            <h3 className="text-xl font-semibold text-slate-900 mb-2">验证中...</h3>
                            <p className="text-slate-600">请稍候，正在验证您的邮箱</p>
                        </div>
                    ) : success ? (
                        <div className="text-center py-4">
                            <div className="w-16 h-16 sm:w-20 sm:h-20 bg-gradient-to-br from-emerald-100 to-sky-100 rounded-full flex items-center justify-center mx-auto mb-6">
                                <FaCheckCircle className="text-emerald-600 text-4xl sm:text-5xl" />
                            </div>
                            <h3 className="text-2xl font-bold text-slate-900 mb-4">验证成功！</h3>
                            <p className="text-slate-600 mb-6">您的邮箱已成功验证，账户创建完成</p>

                            <div className="bg-emerald-50 border-l-4 border-emerald-500 p-4 mb-6 rounded-r-lg text-left">
                                <div className="flex items-start">
                                    <svg className="w-5 h-5 text-emerald-600 mt-0.5 mr-3 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                                        <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                                    </svg>
                                    <div className="text-sm text-emerald-800">
                                        <p className="font-semibold mb-1">下一步</p>
                                        <p>即将自动跳转到登录页面，请使用您的账号登录</p>
                                    </div>
                                </div>
                            </div>

                            <Link
                                to="/login"
                                className={cn(authPrimaryButtonClassName, 'hover:scale-105')}
                            >
                                立即登录
                            </Link>
                        </div>
                    ) : (
                        <div className="text-center py-4">
                            <div className="w-16 h-16 sm:w-20 sm:h-20 bg-gradient-to-br from-rose-100 to-amber-100 rounded-full flex items-center justify-center mx-auto mb-6">
                                <FaTimesCircle className="text-rose-600 text-4xl sm:text-5xl" />
                            </div>
                            <h3 className="text-2xl font-bold text-slate-900 mb-4">验证失败</h3>
                            <p className="text-slate-600 mb-6">{error}</p>

                            <div className="bg-rose-50 border-l-4 border-rose-500 p-4 mb-6 rounded-r-lg text-left">
                                <div className="flex items-start">
                                    <svg className="w-5 h-5 text-rose-600 mt-0.5 mr-3 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                                        <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
                                    </svg>
                                    <div className="text-sm text-rose-800">
                                        <p className="font-semibold mb-2">可能的原因：</p>
                                        <ul className="list-disc list-inside space-y-1">
                                            <li>验证链接已过期（10分钟有效期）</li>
                                            <li>验证链接已被使用</li>
                                            <li>使用了不同的设备或网络</li>
                                            <li>链接无效或已损坏</li>
                                        </ul>
                                    </div>
                                </div>
                            </div>

                            <div className="space-y-3">
                                {token && (
                                    <button
                                        type="button"
                                        onClick={() => setRetryVersion(version => version + 1)}
                                        className={authPrimaryButtonClassName}
                                    >
                                        重新验证
                                    </button>
                                )}
                                <Link
                                    to="/register"
                                    className={cn(authPrimaryButtonClassName, 'hover:scale-105')}
                                >
                                    重新注册
                                </Link>
                                <Link
                                    to="/login"
                                    className={authSecondaryButtonClassName}
                                >
                                    返回登录
                                </Link>
                            </div>
                        </div>
                    )}
                </div>

                {/* Back to Home */}
                <div className="mt-6 text-center">
                    <Link to="/" className={authBackLinkClassName}>
                        返回首页
                    </Link>
                </div>
            </div>
        </div>
    );
};

export default EmailVerifyPage;
