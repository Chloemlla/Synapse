import { m } from "framer-motion";
import { FaFingerprint, FaKey, FaLink, FaShieldAlt, FaUser, FaUserShield } from "react-icons/fa";
import type { LinkedAccount, TotpStatus, UserProfileData } from "./profileHelpers";
import {
  formatDateTime,
  formatRelativeTime,
  getAuthProviderLabel,
  getLinkedAccountStatusLabel,
} from "./profileHelpers";
import { InfoMetricCard, InfoPanel, InfoSectionTitle } from "../studioTheme";
import { useReducedMotion } from "../../hooks/useReducedMotion";

interface ProfileSidebarSummaryProps {
  profile: UserProfileData | null;
  totpStatus: TotpStatus | null;
  linkedAccounts: LinkedAccount[];
}

export function ProfileSidebarSummary({
  profile,
  totpStatus,
  linkedAccounts,
}: ProfileSidebarSummaryProps) {
  const reducedMotion = useReducedMotion();
  const boundAccountCount = linkedAccounts.filter((account) => account.status === "bound").length;
  const accountStatusLabel =
    profile === null
      ? "未知"
      : profile.accountStatus === "suspended"
        ? "已暂停"
        : "正常";
  const accountStatusTone = profile?.accountStatus === "suspended" ? "rose" : "emerald";
  const enterFrom = reducedMotion ? false : { opacity: 0, y: 24 };

  return (
    <>
      {/* Account info */}
      <m.div
        initial={enterFrom}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 0.12 }}
      >
        <InfoPanel>
          <InfoSectionTitle
            title="账户信息"
            description="基础身份与登录轨迹"
            icon={FaUser}
            tone="slate"
          />
          <div className="space-y-3 text-sm">
            <div className="flex items-center justify-between gap-3">
              <span className="text-slate-500">用户名</span>
              <span className="font-medium text-slate-900">{profile?.username || "-"}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-slate-500">邮箱</span>
              <span className="font-medium text-slate-900 break-all text-right">{profile?.email || "-"}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-slate-500">角色</span>
              <span className="font-medium text-slate-900">{profile?.role || "-"}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-slate-500">登录方式</span>
              <span className="font-medium text-slate-900">{getAuthProviderLabel(profile?.authProvider)}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-slate-500">注册时间</span>
              <span className="font-medium text-slate-900">{formatDateTime(profile?.createdAt)}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-slate-500">最近登录</span>
              <span className="font-medium text-slate-900">{formatRelativeTime(profile?.lastLoginAt)}</span>
            </div>
          </div>
        </InfoPanel>
      </m.div>

      {/* Security status */}
      <m.div
        initial={enterFrom}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 0.18 }}
      >
        <InfoPanel>
          <InfoSectionTitle
            title="安全状态"
            description="当前账户安全配置"
            icon={FaShieldAlt}
            tone="slate"
          />
          <div className="grid grid-cols-2 gap-3">
            <InfoMetricCard
              label="账户状态"
              value={accountStatusLabel}
              icon={FaUserShield}
              tone={accountStatusTone}
            />
            <InfoMetricCard
              label="TOTP"
              value={totpStatus?.enabled ? "已启用" : "未启用"}
              icon={FaKey}
              tone="slate"
            />
            <InfoMetricCard
              label="Passkey"
              value={totpStatus?.hasPasskey ? "已配置" : "未配置"}
              icon={FaFingerprint}
              tone="slate"
            />
            <InfoMetricCard
              label="绑定账号"
              value={boundAccountCount}
              icon={FaLink}
              tone="slate"
            />
          </div>
          {linkedAccounts.length > 0 && (
            <div className="mt-4 space-y-3 text-sm">
              {linkedAccounts.slice(0, 3).map((account) => (
                <div
                  key={`${account.provider}-${account.providerUserId || account.label}`}
                  className="flex items-center justify-between gap-3"
                >
                  <span className="text-slate-500">{account.label}</span>
                  <span className="font-medium text-slate-900">
                    {getLinkedAccountStatusLabel(account.status)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </InfoPanel>
      </m.div>
    </>
  );
}
