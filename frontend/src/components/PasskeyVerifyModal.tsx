import React, { useState } from 'react';
import { usePasskey } from '../hooks/usePasskey';
import { FaShieldAlt, FaExclamationTriangle } from 'react-icons/fa';
import { cn } from '../utils/cn';
import {
  authElevatedPanelClassName,
  authPrimaryButtonClassName,
  authSecondaryButtonClassName,
} from './authStudioTheme';
import {
  StudioErrorNote,
  StudioLoadingState,
  StudioModal,
  StudioModalHeader,
  StudioSuccessNote,
} from './studioFeedback';

interface PasskeyVerifyModalProps {
  open: boolean;
  username: string;
  onSuccess: () => void;
  onClose: () => void;
}

const PasskeyVerifyModal: React.FC<PasskeyVerifyModalProps> = ({ open, username, onSuccess, onClose }) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false); // 新增认证成功状态
  const { authenticateWithPasskey } = usePasskey();

  const handlePasskeyAuth = async () => {
    setError('');
    setLoading(true);
    try {
      const result = await authenticateWithPasskey(username);
      if (result === true) {
        setSuccess(true); // 标记认证成功
        onSuccess();
      } else {
        setError('认证失败，请重试');
      }
    } catch (e: any) {
      setError(e?.message || '认证失败，请重试');
    } finally {
      setLoading(false);
    }
  };

  // 关闭弹窗时重置状态
  const handleClose = () => {
    setSuccess(false);
    setError('');
    setLoading(false);
    onClose();
  };

  return (
    <StudioModal
      open={open}
      onClose={handleClose}
      labelledBy="passkey-verify-title"
      maxWidthClassName="max-w-md"
    >
      <StudioModalHeader
        title="通行密钥二次校验"
        titleId="passkey-verify-title"
        description="为了确保账户安全，请使用您的 Passkey 进行身份验证。"
        icon={<FaShieldAlt className="h-6 w-6" />}
        iconClassName="bg-slate-100 text-slate-600"
        onClose={handleClose}
      />

      <div className={cn(authElevatedPanelClassName, 'mt-6 p-4')}>
        <div className="flex items-center">
          <div className="mr-3 flex h-8 w-8 sm:h-10 sm:w-10 items-center justify-center rounded-2xl border border-slate-200 bg-slate-50">
            <span className="text-sm font-semibold text-slate-600">
              {username.charAt(0).toUpperCase()}
            </span>
          </div>
          <div>
            <span className="block text-sm font-medium text-slate-900">正在验证用户</span>
            <span className="block text-sm text-slate-500">{username}</span>
          </div>
        </div>
      </div>

      <div className="mt-4 flex items-center gap-2 rounded-2xl border border-amber-200 bg-amber-50/80 p-3 text-sm leading-6 text-amber-800">
        <FaExclamationTriangle className="h-5 w-5 shrink-0 text-amber-500" aria-hidden />
        <span>Passkey 是一种基于 FIDO2 的无密码认证方式，认证过程将唤起系统安全验证，保障账户安全。</span>
      </div>

      <div className="mt-6 text-center">
        {loading ? (
          <StudioLoadingState
            minHeightClassName="min-h-[140px]"
            text="正在进行 Passkey 认证，请在系统窗口中操作…"
          />
        ) : error ? (
          <div className="space-y-4">
            <FaExclamationTriangle className="mx-auto h-8 w-8 text-rose-500" aria-hidden />
            <StudioErrorNote>
              <div className="font-medium">{error}</div>
              <div className="mt-2 text-xs">如多次失败，请检查浏览器是否支持 Passkey，或尝试更换浏览器/设备。</div>
            </StudioErrorNote>
            <button type="button" onClick={handlePasskeyAuth} className={authPrimaryButtonClassName}>
              重新尝试
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              <div className="font-medium text-slate-800">准备开始认证</div>
              <div className="text-sm text-slate-500">点击下方按钮开始 Passkey 身份验证流程</div>
            </div>
            <button type="button" onClick={handlePasskeyAuth} className={authPrimaryButtonClassName}>
              开始 Passkey 认证
            </button>
          </div>
        )}

        {success && !loading && !error ? (
          <div className="mt-6 flex flex-col items-center">
            <div className="mb-2 flex h-10 w-10 sm:h-12 sm:w-12 items-center justify-center rounded-2xl bg-emerald-100">
              <FaShieldAlt className="h-7 w-7 text-emerald-600" aria-hidden />
            </div>
            <StudioSuccessNote>认证成功，已安全登录！</StudioSuccessNote>
          </div>
        ) : null}
      </div>

      <div className="mt-6 flex flex-col justify-end gap-2 border-t border-slate-200 pt-4 sm:flex-row">
        <button
          type="button"
          onClick={handleClose}
          disabled={loading}
          className={authSecondaryButtonClassName}
        >
          {success && !loading && !error ? '完成' : '取消'}
        </button>
      </div>
    </StudioModal>
  );
};

export default PasskeyVerifyModal;
