import React, { useEffect, useState } from 'react';
import { AnimatePresence, motion, MotionConfig } from 'framer-motion';
import {
  FaBan,
  FaExclamationTriangle,
  FaKey,
  FaPlus,
  FaTimes,
  FaTrash,
  FaUserPlus,
} from 'react-icons/fa';
import { usePasskey } from '../hooks/usePasskey';
import { passkeyApi } from '../api/passkey';
import { useReducedMotion } from '../hooks/useReducedMotion';
import { formatDate } from '../utils/date';
import { useNotification } from './Notification';
import { StudioEmptyState, StudioErrorState, StudioLoadingState } from './studioFeedback';
import { renderCredentialIdModal } from './ui/CredentialIdModal';
import { ModalPortal } from './ModalPortal';
import {
  studioFieldClassName,
  studioGhostButtonClassName,
  studioModalCardClassName,
  studioModalCloseButtonClassName,
  studioModalOverlayClassName,
  studioPageFont,
  studioPrimaryButtonClassName,
} from './studioTheme';

interface PasskeySetupProps {
  onClose?: () => void;
  onChanged?: () => void;
}

export const PasskeySetup: React.FC<PasskeySetupProps> = ({ onClose, onChanged }) => {
  const {
    credentials,
    isLoading,
    loadCredentials,
    registerAuthenticator,
    removeAuthenticator,
    showModal,
    setShowModal,
    currentCredentialId,
  } = usePasskey();
  const { setNotification } = useNotification();

  const [isOpen, setIsOpen] = useState(false);
  const [credentialName, setCredentialName] = useState('');
  const [isRegistering, setIsRegistering] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [isPasskeySupported, setIsPasskeySupported] = useState<boolean | null>(null);
  const latestCredentialsRef = React.useRef(credentials);

  const hasCredential = Array.isArray(credentials) && credentials.length > 0;
  const singlePasskeyMessage = '每个账号仅可注册一个 Passkey。如需更换设备，请先删除当前 Passkey。';
  const registerBusy = isLoading || isRegistering;
  const reducedMotion = useReducedMotion();
  // loadCredentials 把请求失败吞成 console（只诊断，返回 void），页面拿不到失败信号，
  // 单看「列表为空」会把接口失败画成「还没有 Passkey」。
  // 列表落定后仍为空再确认一次服务端，把「确实没有」与「读取失败」分开，各走自己的状态。
  const [emptyProbe, setEmptyProbe] = useState<'idle' | 'checking' | 'empty' | 'failed'>('idle');

  useEffect(() => {
    if (isLoading || hasCredential || emptyProbe !== 'idle') return;
    let cancelled = false;
    setEmptyProbe('checking');
    passkeyApi
      .getCredentials()
      .then(() => { if (!cancelled) setEmptyProbe('empty'); })
      .catch(() => { if (!cancelled) setEmptyProbe('failed'); });
    return () => { cancelled = true; };
  }, [emptyProbe, hasCredential, isLoading]);

  useEffect(() => {
    latestCredentialsRef.current = credentials;
  }, [credentials]);

  useEffect(() => {
    if (
      typeof window !== 'undefined' &&
      window.PublicKeyCredential &&
      typeof window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable === 'function'
    ) {
      window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()
        .then((result: boolean) => setIsPasskeySupported(result))
        .catch(() => setIsPasskeySupported(false));
    } else {
      setIsPasskeySupported(false);
    }
  }, []);

  useEffect(() => {
    void loadCredentials();
  }, [loadCredentials]);

  const closeRegisterModal = () => {
    setCredentialName('');
    setIsOpen(false);
  };

  const handleRegister = async () => {
    if (isRegistering) return;
    if (hasCredential) {
      closeRegisterModal();
      setNotification({ message: singlePasskeyMessage, type: 'warning' });
      return;
    }
    if (!credentialName.trim()) return;

    let registerResult: any = null;
    setIsRegistering(true);
    try {
      registerResult = await registerAuthenticator(credentialName.trim());

      if (registerResult?.errorMessage) {
        closeRegisterModal();
        setNotification({ message: registerResult.errorMessage, type: 'warning' });
        return;
      }

      const newId =
        registerResult?.id ||
        registerResult?.credential?.id ||
        registerResult?.attRespId ||
        registerResult?.finishData?.passkeyCredentials?.[0]?.id;

      const maxAttempts = 6;
      const delayMs = 500;
      let confirmed = false;

      for (let index = 0; index < maxAttempts; index += 1) {
        try {
          await loadCredentials();
        } catch (error) {
          // 轮询期的单次失败不改变结论：下面还有剩余次数，彻底失败会走「注册未确认」的可见失败态。
          console.warn('loadCredentials failed during confirmation', error);
        }

        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 200));

        const list = latestCredentialsRef.current || [];
        if (newId) {
          if (list.find((credential: any) => credential.id === newId)) {
            confirmed = true;
            break;
          }
        } else if (list.find((credential: any) => String(credential.name).trim() === credentialName.trim())) {
          confirmed = true;
          break;
        }

        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }

      if (confirmed) {
        setNotification({ message: 'Passkey 注册成功并已确认', type: 'success' });
        closeRegisterModal();
        onChanged?.();
        return;
      }

      console.error('Passkey registration not confirmed after polling', registerResult);
      setNotification({
        message: 'Passkey 注册未确认，请稍后重试',
        type: 'error',
      });
    } catch (error) {
      // console 仅作诊断：用户可见的失败态由 notification 承担。
      console.error('Passkey registration failed:', error);
      setNotification({ message: 'Passkey 注册失败（请求错误）', type: 'error' });
    } finally {
      setIsRegistering(false);
    }
  };

  const handleRemoveConfirm = async () => {
    if (!confirmDeleteId) return;
    setRemovingId(confirmDeleteId);
    try {
      await removeAuthenticator(confirmDeleteId);
      setNotification({ message: 'Passkey 已删除', type: 'success' });
      onChanged?.();
    } catch (error) {
      // console 仅作诊断：用户可见的失败态由 notification 承担。
      console.error('Passkey removal failed:', error);
      setNotification({ message: '删除失败', type: 'error' });
    } finally {
      setRemovingId(null);
      setConfirmDeleteId(null);
    }
  };

  return (
    <MotionConfig reducedMotion={reducedMotion ? 'always' : 'never'}>
    <div className="space-y-4" style={{ fontFamily: studioPageFont }}>
      {isPasskeySupported === false ? (
        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-800"
        >
          <div className="flex gap-2">
            <FaExclamationTriangle className="mt-1 shrink-0" />
            <span>当前浏览器不支持 Passkey。请使用最新版 Chrome、Edge、Safari，并确保使用 HTTPS 访问。</span>
          </div>
        </motion.div>
      ) : null}

      <motion.section
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.24 }}
        className="rounded-2xl border border-slate-200 bg-white/90 p-4 shadow-sm sm:p-5"
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <div className="flex min-w-0 gap-3">
            <div className="flex h-9 w-9 sm:h-11 sm:w-11 shrink-0 items-center justify-center rounded-2xl bg-slate-900 text-white">
              <FaKey />
            </div>
            <div className="min-w-0">
              <h2 className="text-lg font-semibold text-slate-900">Passkey</h2>
              <p className="mt-1 text-sm leading-6 text-slate-500">
                使用设备密钥或生物识别完成身份验证。
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <span
              className={`rounded-full border px-3 py-1 text-xs font-semibold ${
                hasCredential
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                  : 'border-slate-200 bg-slate-50 text-slate-500'
              }`}
            >
              {hasCredential ? '已配置' : '未配置'}
            </span>
            {onClose ? (
              <button
                type="button"
                onClick={onClose}
                className={studioModalCloseButtonClassName}
                aria-label="关闭 Passkey 设置"
                title="关闭"
              >
                <FaTimes className="h-4 w-4" />
              </button>
            ) : null}
          </div>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-slate-50/80 px-4 py-3 text-sm leading-6 text-slate-600">
          {singlePasskeyMessage}
        </div>

        <div className="mt-4 space-y-3">
          <AnimatePresence>
            {hasCredential
              ? credentials.map((credential) => (
                <motion.div
                  key={credential.id}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-slate-900">
                      {credential.name}
                    </div>
                    <div className="mt-1 text-xs text-slate-400">
                      添加时间：{formatDate(credential.createdAt)}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setConfirmDeleteId(credential.id)}
                    disabled={isLoading || removingId === credential.id}
                    aria-busy={removingId === credential.id}
                    className={`${studioGhostButtonClassName} min-h-11 border-rose-200 text-rose-600 hover:border-rose-300 hover:text-rose-700 sm:min-h-0 sm:w-auto`}
                  >
                    {removingId === credential.id ? '正在删除...' : <><FaTrash />删除</>}
                  </button>
                </motion.div>
              ))
              : null}
          </AnimatePresence>

          {isLoading || emptyProbe === 'checking' ? (
            <StudioLoadingState minHeightClassName="min-h-[120px]" text="正在读取 Passkey…" />
          ) : null}

          {!hasCredential && !isLoading && emptyProbe === 'failed' ? (
            <StudioErrorState
              message="无法读取 Passkey 列表，请稍后重试。"
              onRetry={() => setEmptyProbe('idle')}
            />
          ) : null}

          {!hasCredential && !isLoading && (emptyProbe === 'idle' || emptyProbe === 'empty') ? (
            <StudioEmptyState message={<><span className="block font-semibold text-slate-900">还没有 Passkey</span>添加后可使用设备密钥完成验证。</>} />
          ) : null}

          <button
            type="button"
            onClick={() => setIsOpen(true)}
            disabled={isLoading || hasCredential || isPasskeySupported === false}
            className={`${studioPrimaryButtonClassName} w-full sm:w-auto`}
          >
            <FaPlus />
            添加 Passkey
          </button>
        </div>
      </motion.section>

      <ModalPortal>
      <AnimatePresence>
        {confirmDeleteId ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className={studioModalOverlayClassName}
            onClick={() => setConfirmDeleteId(null)}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.96, y: 18 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 18 }}
              className={`${studioModalCardClassName} max-w-md max-h-[90vh] overflow-y-auto overscroll-contain`}
              onClick={(event) => event.stopPropagation()}
            >
              <div className="mb-3 flex items-center gap-3">
                <div className="flex h-8 w-8 sm:h-10 sm:w-10 items-center justify-center rounded-2xl bg-rose-50 text-rose-600">
                  <FaExclamationTriangle />
                </div>
                <h3 className="text-lg font-semibold text-slate-900">删除 Passkey</h3>
              </div>
              <p className="text-sm leading-6 text-slate-500">
                删除后这个设备凭证将无法继续用于登录验证。
              </p>
              <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <button
                  type="button"
                  onClick={() => setConfirmDeleteId(null)}
                  disabled={Boolean(removingId)}
                  className={`${studioGhostButtonClassName} w-full sm:w-auto`}
                >
                  <FaBan />
                  取消
                </button>
                <button
                  type="button"
                  onClick={() => void handleRemoveConfirm()}
                  disabled={Boolean(removingId)}
                  aria-busy={Boolean(removingId)}
                  className={`${studioPrimaryButtonClassName} w-full bg-rose-600 hover:bg-rose-700 sm:w-auto`}
                >
                  {removingId ? '正在删除...' : <><FaTrash />确认删除</>}
                </button>
              </div>
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <AnimatePresence>
        {isOpen ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className={studioModalOverlayClassName}
            onClick={closeRegisterModal}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.96, y: 18 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 18 }}
              className={`${studioModalCardClassName} max-w-md max-h-[90vh] overflow-y-auto overscroll-contain`}
              onClick={(event) => event.stopPropagation()}
            >
              <div className="mb-4 flex items-start gap-3">
                <div className="flex h-8 w-8 sm:h-10 sm:w-10 shrink-0 items-center justify-center rounded-2xl bg-slate-900 text-white">
                  <FaKey />
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-slate-900">添加 Passkey</h3>
                  <p className="mt-1 text-sm leading-6 text-slate-500">
                    建议使用当前最常用且安全的设备。
                  </p>
                </div>
              </div>

              <div className="space-y-2">
                <label htmlFor="passkey-name" className="text-sm font-semibold text-slate-900">
                  Passkey 名称
                </label>
                <input
                  id="passkey-name"
                  type="text"
                  placeholder="例如：Windows Hello"
                  value={credentialName}
                  onChange={(event) => setCredentialName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !registerBusy && credentialName.trim()) {
                      void handleRegister();
                    }
                  }}
                  autoFocus
                  className={studioFieldClassName}
                  maxLength={50}
                />
              </div>

              <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <button
                  type="button"
                  onClick={closeRegisterModal}
                  disabled={registerBusy}
                  className={`${studioGhostButtonClassName} w-full sm:w-auto`}
                >
                  <FaBan />
                  取消
                </button>
                <button
                  type="button"
                  onClick={() => void handleRegister()}
                  disabled={registerBusy || !credentialName.trim() || hasCredential}
                  aria-busy={registerBusy}
                  className={`${studioPrimaryButtonClassName} w-full sm:w-auto`}
                >
                  {registerBusy ? '正在注册...' : <><FaUserPlus />注册</>}
                </button>
              </div>
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>
      </ModalPortal>

      {renderCredentialIdModal({
        open: showModal,
        credentialId: currentCredentialId,
        onClose: () => setShowModal(false),
      })}
    </div>
    </MotionConfig>
  );
};
