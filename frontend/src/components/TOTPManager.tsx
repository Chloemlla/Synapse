import React, { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  FaCheckCircle,
  FaClock,
  FaEye,
  FaKey,
  FaLock,
  FaShieldAlt,
} from "react-icons/fa";
import type { TOTPStatus } from "../types/auth";
import { passkeyApi } from "../api/passkey";
import { handleTOTPError } from "../utils/totpUtils";
import BackupCodesModal from "./BackupCodesModal";
import EstablishSecuritySession from "./EstablishSecuritySession";
import { ModalPortal } from "./ModalPortal";
import { StudioErrorNote, StudioErrorState, StudioLoadingState } from "./studioFeedback";
import { PasskeySetup } from "./PasskeySetup";
import {
  studioGhostButtonClassName,
  studioModalCardClassName,
  studioModalOverlayClassName,
  studioPageFont,
  studioPrimaryButtonClassName,
} from "./studioTheme";
import TOTPSetup from "./TOTPSetup";
import { api } from "../api/api";
import { useSecuritySession } from "../hooks/useSecuritySession";


interface TOTPManagerProps {
  onStatusChange?: (status: TOTPStatus) => void;
}

const TOTPManager: React.FC<TOTPManagerProps> = ({ onStatusChange }) => {
  const [status, setStatus] = useState<TOTPStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [statusError, setStatusError] = useState("");
  const [passkeyEnabled, setPasskeyEnabled] = useState(false);
  const [showSetup, setShowSetup] = useState(false);
  const [showDisable, setShowDisable] = useState(false);
  const [showBackupCodes, setShowBackupCodes] = useState(false);
  const [showPasskeySetup, setShowPasskeySetup] = useState(false);
  const [error, setError] = useState("");
  const [disabling, setDisabling] = useState(false);
  const prefersReducedMotion = useReducedMotion();
  // 双因素配置类操作统一复用个人资料页那套「安全会话」
  const { isActive, isTwoFactor, verificationToken } = useSecuritySession();

  const fetchStatus = useCallback(async (mode: "initial" | "refresh" = "refresh") => {
    const isInitial = mode === "initial";

    try {
      if (isInitial) {
        setLoading(true);
      } else {
        setRefreshing(true);
      }
      setStatusError("");

      const [totpResult, passkeyResult] = await Promise.allSettled([
        api.get<TOTPStatus>("/api/totp/status"),
        passkeyApi.getCredentials(),
      ]);

      if (totpResult.status === "fulfilled") {
        const nextStatus = {
          ...totpResult.value.data,
          type: [
            totpResult.value.data.enabled ? "TOTP" : null,
            passkeyResult.status === "fulfilled" && passkeyResult.value.data.length > 0
              ? "Passkey"
              : null,
          ].filter(Boolean) as string[],
        };
        setStatus(nextStatus);
        onStatusChange?.(nextStatus);
      } else if (isInitial) {
        // 不能用「未启用」的假状态顶替失败：那会把接口失败画成空态，
        // 用户会以为账号真的没开双因素而放弃配置。
        setStatus(null);
        setStatusError("无法获取账户安全状态，请稍后重试。");
      } else {
        setStatusError("状态刷新失败，页面仍显示上一次结果。");
      }

      if (passkeyResult.status === "fulfilled") {
        setPasskeyEnabled(passkeyResult.value.data.length > 0);
      } else if (isInitial) {
        // 通行密钥列表读失败也不是「未配置」：一并走失败态。
        setStatus(null);
        setStatusError("无法获取账户安全状态，请稍后重试。");
      }
    } catch (err) {
      // console 仅作诊断，用户可见的失败态由 statusError + StudioErrorState 承担。
      console.error("获取 TOTP 状态失败:", err);
      setStatusError("无法获取账户安全状态，请稍后重试。");
    } finally {
      if (isInitial) {
        setLoading(false);
      } else {
        setRefreshing(false);
      }
    }
  }, [api, onStatusChange]);

  useEffect(() => {
    void fetchStatus("initial");
  }, [fetchStatus]);

  const handleDisable = async () => {
    if (disabling) return;

    try {
      setError("");
      setDisabling(true);
      // 安全会话已建立，后端复用该会话直接关闭 TOTP，不必再输一次 6 位验证码。
      await api.post("/api/totp/disable", { verificationToken });
      setShowDisable(false);
      void fetchStatus("refresh");
    } catch (err: any) {
      setError(handleTOTPError(err));
    } finally {
      setDisabling(false);
    }
  };

  // Esc 关闭：两处遮罩层都支持标准键盘退出方式（焦点陷阱/回归未做，见回报）
  useEffect(() => {
    if (!showDisable && !showPasskeySetup) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (showDisable) {
        if (!disabling) setShowDisable(false);
        return;
      }
      if (showPasskeySetup) {
        setShowPasskeySetup(false);
        void fetchStatus("refresh");
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [showDisable, showPasskeySetup, disabling, fetchStatus]);

  const totpEnabled = Boolean(status?.enabled);
  const hasPasskey = passkeyEnabled;
  // 已配置任一二次验证因素时，后端要求用 TOTP / Passkey 建立的会话来改动双因素配置；
  // 两者都未配置时（首次启用）允许密码会话，否则无法开始配置。
  const requiresTwoFactorSession = totpEnabled || hasPasskey;
  const sessionReady = isActive && (!requiresTwoFactorSession || isTwoFactor);
  const methodLabel = [
    totpEnabled ? "动态验证码" : null,
    hasPasskey ? "通行密钥" : null,
  ]
    .filter(Boolean)
    .join(" / ");

  const summaryItems = [
    {
      label: "验证方式",
      value: methodLabel || "仅密码",
    },
    {
      label: "恢复码",
      value: totpEnabled
        ? status?.hasBackupCodes
          ? "已生成"
          : "未确认"
        : "启用后可用",
    },
    {
      label: "通行密钥",
      value: hasPasskey ? "已配置" : "未配置",
    },
  ];
  const motionProps = prefersReducedMotion
    ? { initial: false, animate: { opacity: 1 }, transition: { duration: 0 } }
    : undefined;

  if (loading) {
    return (
      <div className="mx-auto max-w-2xl" style={{ fontFamily: studioPageFont }} role="status">
        <StudioLoadingState minHeightClassName="min-h-[360px]" text="正在读取账户安全状态…" />
      </div>
    );
  }

  // 首屏读取失败：给独立错误态 + 重试，不让页面带着假状态继续。
  if (!status) {
    return (
      <div className="mx-auto max-w-2xl" style={{ fontFamily: studioPageFont }}>
        <StudioErrorState
          message={statusError || "无法获取账户安全状态，请稍后重试。"}
          onRetry={() => void fetchStatus("initial")}
        />
      </div>
    );
  }

  return (
    <div
      className="mx-auto max-w-2xl space-y-4"
      style={{ fontFamily: studioPageFont }}
    >
      <motion.section
        initial={motionProps?.initial ?? { opacity: 0, y: 12 }}
        animate={motionProps?.animate ?? { opacity: 1, y: 0 }}
        transition={motionProps?.transition ?? { duration: 0.24 }}
        className="rounded-2xl border border-slate-200 bg-slate-50/80 p-4 sm:p-5"
      >
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 gap-3">
            <div className="flex h-9 w-9 sm:h-11 sm:w-11 shrink-0 items-center justify-center rounded-2xl bg-slate-900 text-white">
              {totpEnabled ? <FaCheckCircle /> : <FaShieldAlt />}
            </div>
            <div className="min-w-0">
              <h3 className="text-base font-semibold text-slate-900">
                登录保护
              </h3>
              <p className="mt-1 text-sm leading-6 text-slate-500">
                {totpEnabled
                  ? "动态验证码已开启，登录时会要求额外验证。"
                  : "当前仍可仅凭密码登录，建议启用动态验证码。"}
              </p>
            </div>
          </div>
          <span
            className={`inline-flex shrink-0 items-center justify-center rounded-full border px-3 py-1 text-xs font-semibold ${
              totpEnabled
                ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                : "border-amber-200 bg-amber-50 text-amber-700"
            }`}
          >
            {totpEnabled ? "已开启" : "未开启"}
          </span>
        </div>

        <div className="mt-4 grid min-w-0 gap-2 sm:grid-cols-3">
          {summaryItems.map((item) => (
            <div
              key={item.label}
              className="rounded-2xl border border-slate-200 bg-white/80 px-3 py-3"
            >
              <div className="text-xs text-slate-600">{item.label}</div>
              <div className="mt-1 truncate text-sm font-semibold text-slate-800">
                {item.value}
              </div>
            </div>
          ))}
        </div>

        {statusError ? (
          <StudioErrorNote className="mt-3">
            <span className="block">{statusError}</span>
            <button
              type="button"
              onClick={() => void fetchStatus("refresh")}
              disabled={refreshing}
              className={`${studioGhostButtonClassName} mt-2 min-h-11 sm:min-h-0 disabled:cursor-not-allowed disabled:opacity-60`}
            >
              重试
            </button>
          </StudioErrorNote>
        ) : refreshing ? (
          <div className="mt-3 rounded-2xl border border-slate-200 bg-white/80 px-4 py-3 text-xs leading-5 text-slate-500">
            正在同步账户安全状态...
          </div>
        ) : null}
      </motion.section>

      <motion.section
        initial={motionProps?.initial ?? { opacity: 0, y: 12 }}
        animate={motionProps?.animate ?? { opacity: 1, y: 0 }}
        transition={motionProps?.transition ?? { duration: 0.24, delay: 0.04 }}
        className="space-y-3"
      >
        <EstablishSecuritySession requireTwoFactor={requiresTwoFactorSession} />

        <div className="rounded-2xl border border-slate-200 bg-white/90 p-4 shadow-sm">
          <div className="flex gap-3">
            <div className="flex h-8 w-8 sm:h-10 sm:w-10 shrink-0 items-center justify-center rounded-2xl border border-slate-200 bg-slate-50 text-slate-500">
              <FaLock />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-semibold text-slate-900">
                  动态验证码
                </h3>
                <span
                  className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                    totpEnabled
                      ? "bg-emerald-100 text-emerald-700"
                      : "bg-amber-100 text-amber-700"
                  }`}
                >
                  {totpEnabled ? "已启用" : "未启用"}
                </span>
              </div>
              <p className="mt-1 text-sm leading-6 text-slate-500">
                使用认证器应用生成 6 位验证码，保护登录过程。
              </p>
            </div>
          </div>

          <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:justify-end">
            {totpEnabled ? (
              <>
                {status?.hasBackupCodes ? (
                  <button
                    type="button"
                    onClick={() => setShowBackupCodes(true)}
                    disabled={!sessionReady}
                    title={sessionReady ? undefined : "请先建立安全会话"}
                    className={`${studioGhostButtonClassName} min-h-11 sm:min-h-0 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto`}
                  >
                    <FaEye />
                    查看恢复码
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => setShowDisable(true)}
                  disabled={!sessionReady}
                  title={sessionReady ? undefined : "请先建立安全会话"}
                  className={`${studioGhostButtonClassName} min-h-11 border-rose-200 text-rose-600 hover:border-rose-300 hover:text-rose-700 disabled:cursor-not-allowed disabled:opacity-60 sm:min-h-0 sm:w-auto`}
                >
                  关闭动态验证码
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => setShowSetup(true)}
                disabled={!sessionReady}
                title={sessionReady ? undefined : "请先建立安全会话"}
                className={`${studioPrimaryButtonClassName} sm:w-auto`}
              >
                <FaLock />
                启用动态验证码
              </button>
            )}
          </div>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white/90 p-4 shadow-sm">
          <div className="flex gap-3">
            <div className="flex h-8 w-8 sm:h-10 sm:w-10 shrink-0 items-center justify-center rounded-2xl border border-slate-200 bg-slate-50 text-slate-500">
              <FaKey />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-semibold text-slate-900">
                  通行密钥 (Passkey)
                </h3>
                <span
                  className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                    hasPasskey
                      ? "bg-emerald-100 text-emerald-700"
                      : "bg-slate-100 text-slate-500"
                  }`}
                >
                  {hasPasskey ? "已配置" : "可选"}
                </span>
              </div>
              <p className="mt-1 text-sm leading-6 text-slate-500">
                使用设备密钥或生物识别完成更快的身份验证。
              </p>
            </div>
          </div>
          <div className="mt-4 flex justify-end">
            <button
              type="button"
              onClick={() => setShowPasskeySetup(true)}
              disabled={!sessionReady}
              title={sessionReady ? undefined : "请先建立安全会话"}
              className={`${studioGhostButtonClassName} min-h-11 disabled:cursor-not-allowed disabled:opacity-60 sm:min-h-0 sm:w-auto`}
            >
              <FaKey />
              管理通行密钥
            </button>
          </div>
        </div>
      </motion.section>

      <TOTPSetup
        isOpen={showSetup}
        onClose={() => setShowSetup(false)}
        onSuccess={() => void fetchStatus("refresh")}
      />
      <BackupCodesModal
        isOpen={showBackupCodes}
        onClose={() => setShowBackupCodes(false)}
      />

      <ModalPortal>
      <AnimatePresence>
        {showDisable ? (
          <motion.div
            initial={prefersReducedMotion ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className={studioModalOverlayClassName}
            onClick={() => {
              if (!disabling) setShowDisable(false);
            }}
          >
            <motion.div
              initial={prefersReducedMotion ? false : { opacity: 0, scale: 0.96, y: 18 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 18 }}
              className={`${studioModalCardClassName} max-w-md max-h-[90vh] overflow-y-auto overscroll-contain`}
              onClick={(event) => event.stopPropagation()}
              role="dialog"
              aria-modal="true"
              aria-labelledby="totp-disable-title"
            >
              <h3 id="totp-disable-title" className="text-xl font-semibold text-slate-900">
                关闭动态验证码
              </h3>
              <p className="mt-2 text-sm leading-6 text-slate-500">
                复用当前安全会话直接关闭动态验证码，无需再次验证。关闭后登录只校验密码或通行密钥。
              </p>
              <div className="mt-5 space-y-3">
                {error ? (
                  <StudioErrorNote>
                    {error}
                  </StudioErrorNote>
                ) : null}
                <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                  <button
                    type="button"
                    onClick={() => setShowDisable(false)}
                    disabled={disabling}
                    className={`${studioGhostButtonClassName} w-full sm:w-auto`}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    onClick={handleDisable}
                    disabled={disabling}
                    aria-busy={disabling}
                    className={`${studioPrimaryButtonClassName} w-full bg-rose-600 shadow-rose-600/20 hover:bg-rose-700 sm:w-auto`}
                  >
                    {disabling ? null : <FaClock />}
                    {disabling ? "正在关闭..." : "确认关闭"}
                  </button>
                </div>
              </div>
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <AnimatePresence>
        {showPasskeySetup ? (
          <motion.div
            initial={prefersReducedMotion ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className={studioModalOverlayClassName}
            onClick={() => {
              setShowPasskeySetup(false);
              void fetchStatus("refresh");
            }}
          >
            <motion.div
              initial={prefersReducedMotion ? false : { opacity: 0, scale: 0.96, y: 18 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 18 }}
              className={`${studioModalCardClassName} max-w-4xl max-h-[90vh] overflow-y-auto overscroll-contain`}
              onClick={(event) => event.stopPropagation()}
              role="dialog"
              aria-modal="true"
              aria-labelledby="totp-manager-passkey-title"
            >
              <h2 id="totp-manager-passkey-title" className="sr-only">管理通行密钥</h2>
              <div className="pr-1">
                <PasskeySetup
                  onClose={() => {
                    setShowPasskeySetup(false);
                    void fetchStatus("refresh");
                  }}
                  onChanged={() => void fetchStatus("refresh")}
                />
              </div>
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>
      </ModalPortal>
    </div>
  );
};

export default TOTPManager;
