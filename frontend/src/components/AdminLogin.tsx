import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { FaArrowLeft, FaLock, FaSignInAlt, FaUserShield, FaEnvelope } from 'react-icons/fa';
import { useAuth } from '../hooks/useAuth';
import { isAdminRole } from '../utils/rbac';
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
  authEyebrowClassName,
  authFieldClassName,
  authFieldIconClassName,
  authFormClassName,
  authFrameClassName,
  authHeaderBadgeClassName,
  authLabelClassName,
  authPageShellClassName,
  authPrimaryButtonClassName,
  authTitleClassName,
  studioPageFont,
} from './authStudioTheme';

/**
 * 管理员登录页。
 *
 * 骨架与 components/LoginPage.tsx 同源（authStudioTheme）：brand block + authCard + 表单 + 返回首页。
 * 这里只做用户名/密码，不提供第三方登录与通行密钥（管理员入口以主登录页 /login?redirectTo=/admin 为准）。
 */
export default function AdminLogin() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { user, login } = useAuth();
  const navigate = useNavigate();

  // 如果已经登录且是管理员，直接跳转到管理页面
  if (isAdminRole(user?.role)) {
    navigate('/admin');
    return null;
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (loading) return;
    setError('');

    try {
      setLoading(true);
      const result = await login(username, password);

      // 检查是否是管理员
      if (result && result.user && !isAdminRole(result.user.role)) {
        setError('权限不足：该账号不是管理员。');
        return;
      }

      navigate('/admin');
    } catch {
      setError('登录失败：用户名或密码错误。');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={authPageShellClassName} style={{ fontFamily: studioPageFont }}>
      <div className={authFrameClassName}>
        <div className={authBrandBlockClassName}>
          <div className={authBrandPillClassName}>
            <FaUserShield />
            Synapse Admin
          </div>
          <h1 className={authBrandTitleClassName}>Synapse</h1>
          <p className={authBrandSubtitleClassName}>管理员入口</p>
        </div>

        <div className={authCardClassName}>
          <div className={authCardBodyClassName}>
            <div className={authCardHeaderClassName}>
              <div className={authHeaderBadgeClassName}>
                <FaSignInAlt aria-hidden />
              </div>
              <div>
                <div className={authEyebrowClassName}>管理员入口</div>
                <h2 className={authTitleClassName}>管理员登录</h2>
              </div>
            </div>

            <form className={authFormClassName} onSubmit={handleSubmit}>
              {error ? (
                <div role="alert" aria-live="assertive" className={authAlertClassName}>
                  {error}
                </div>
              ) : null}

              <div>
                <label htmlFor="admin-username" className={authLabelClassName}>
                  用户名
                </label>
                <div className="relative">
                  <FaEnvelope className={authFieldIconClassName} aria-hidden />
                  <input
                    id="admin-username"
                    name="username"
                    type="text"
                    required
                    aria-required="true"
                    aria-label="管理员用户名"
                    className={authFieldClassName}
                    placeholder="请输入管理员用户名"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    autoComplete="username"
                  />
                </div>
              </div>

              <div>
                <label htmlFor="admin-password" className={authLabelClassName}>
                  密码
                </label>
                <div className="relative">
                  <FaLock className={authFieldIconClassName} aria-hidden />
                  <input
                    id="admin-password"
                    name="password"
                    type="password"
                    required
                    aria-required="true"
                    aria-label="管理员密码"
                    className={authFieldClassName}
                    placeholder="请输入密码"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="current-password"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={loading}
                aria-busy={loading}
                className={authPrimaryButtonClassName}
              >
                {loading ? '登录中…' : '登录'}
              </button>
            </form>

            <p className="mt-5 text-center text-xs leading-5 text-slate-500">
              非管理员账号会被带回首页；如需使用第三方登录或通行密钥，请走
              <Link to="/login?redirectTo=%2Fadmin" className="mx-1 font-semibold text-slate-900 underline decoration-slate-300 underline-offset-2 transition hover:text-slate-700">
                统一登录页
              </Link>
              。
            </p>
          </div>
        </div>

        <div className="mt-6 text-center">
          <Link to="/" className={authBackLinkClassName} aria-label="返回首页">
            <FaArrowLeft className="h-3.5 w-3.5" aria-hidden />
            返回首页
          </Link>
        </div>
      </div>
    </div>
  );
}
