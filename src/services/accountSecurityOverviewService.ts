import type { User } from "../utils/userStorageTypes";
import { type AccountSecuritySummary, buildAccountSecuritySummary } from "./accountSecuritySummaryService";
import type { LinkedAccountView } from "./accountIdentityService";

/**
 * 用户自助「账号安全中心」的数据装配。
 *
 * 为什么单独一层：`buildAccountSecuritySummary` 同时服务于管理端用户列表（那里对每行
 * 用户都会算一次），它的出参是要塞进列表 payload 的。用户端的自检清单需要额外的
 * 事实（恢复码余量、活跃设备数），这些只对「本人」有意义，塞进管理端列表会让每行
 * 都背上无用的查询与敏感计数。因此这里只做**只读装配**：分数与风险等级继续由
 * `buildAccountSecuritySummary` 单点计算并原样透传，避免同一个用户在管理端与个人页
 * 看到两个不同的分数（同一事实两个分数是最容易失去信任的那类不一致）。
 */

export type AccountSecurityCheckStatus = "pass" | "warn" | "fail";

export interface AccountSecurityCheck {
  id: string;
  label: string;
  status: AccountSecurityCheckStatus;
  detail: string;
  /** 前端据此把用户带到对应区块（值由前端解释，后端只给稳定标识）。 */
  action?: "enable_mfa" | "enable_passkey" | "regenerate_backup_codes" | "verify_email" | "report_fingerprint" | "review_devices";
}

export interface AccountSecurityOverview extends AccountSecuritySummary {
  /** 已配置的二次验证因素个数（TOTP / Passkey 各算一个）。 */
  mfaFactorCount: number;
  passkeyCount: number;
  backupCodesRemaining: number;
  /** 恢复码剩余数量偏低（TOTP 已启用且 ≤ 2 个）。 */
  backupCodesLow: boolean;
  activeDeviceCount: number;
  otherDeviceCount: number;
  /** 只读自检清单：事实与建议的机器可读版本，给用户端渲染，不参与打分。 */
  checks: AccountSecurityCheck[];
}

export interface AccountSecurityOverviewFacts {
  activeDeviceCount?: number;
  otherDeviceCount?: number;
}

const countPasskeys = (user: User): number => {
  const credentials = Array.isArray(user.passkeyCredentials) ? user.passkeyCredentials : [];
  if (credentials.length > 0) return credentials.length;
  return user.passkeyEnabled ? 1 : 0;
};

const hasPasswordCredential = (user: User): boolean =>
  Boolean(user.passwordHash || user.password || user.passwordCiphertext || user.passwordWrappedDek);

/** 恢复码在库里存的是哈希数组，长度即「还剩几个可用」。 */
export const countBackupCodes = (user: User): number =>
  Array.isArray(user.backupCodes) ? user.backupCodes.length : 0;

function buildChecks(
  user: User,
  summary: AccountSecuritySummary,
  passkeyCount: number,
  backupCodesRemaining: number,
  facts: AccountSecurityOverviewFacts,
): AccountSecurityCheck[] {
  const checks: AccountSecurityCheck[] = [];
  const totpEnabled = summary.totpEnabled;

  checks.push(
    hasPasswordCredential(user)
      ? {
          id: "password",
          label: "账号密码",
          status: "pass",
          detail: "已设置登录密码，可直接登录。",
        }
      : {
          id: "password",
          label: "账号密码",
          status: "warn",
          detail: "当前账号没有设置密码，只能通过第三方账号登录。绑定密码后可在第三方不可用时登录。",
        },
  );

  const mfaStatus: AccountSecurityCheckStatus = summary.mfaEnabled ? "pass" : "fail";
  const mfaFactors: string[] = [];
  if (totpEnabled) mfaFactors.push("TOTP");
  if (passkeyCount > 0) mfaFactors.push("Passkey");
  checks.push({
    id: "mfa",
    label: "二次验证",
    status: mfaStatus,
    detail: summary.mfaEnabled
      ? `已启用 ${mfaFactors.join(" + ")}，登录时需要额外验证。`
      : "未启用任何二次验证，密码泄露即可登录。建议至少启用 TOTP 或 Passkey。",
    action: summary.mfaEnabled ? undefined : "enable_mfa",
  });

  checks.push({
    id: "passkey",
    label: "Passkey",
    status: passkeyCount > 0 ? "pass" : "warn",
    detail:
      passkeyCount > 0
        ? `已配置 ${passkeyCount} 个 Passkey，可用系统生物识别直接登录并建立安全会话。`
        : "尚未配置 Passkey。配置后可用指纹 / 面容直接登录，且防钓鱼能力优于一次性验证码。",
    action: passkeyCount > 0 ? undefined : "enable_passkey",
  });

  if (!totpEnabled) {
    checks.push({
      id: "backup_codes",
      label: "备用恢复码",
      status: backupCodesRemaining > 0 ? "pass" : "warn",
      detail:
        backupCodesRemaining > 0
          ? `当前还有 ${backupCodesRemaining} 个备用恢复码。`
          : "启用 TOTP 后会生成备用恢复码；未启用 TOTP 时恢复码不影响登录。",
      action: undefined,
    });
  } else if (backupCodesRemaining === 0) {
    checks.push({
      id: "backup_codes",
      label: "备用恢复码",
      status: "fail",
      detail: "已启用 TOTP 但恢复码已用尽，验证器丢失后将无法自行登录。请立即重新生成。",
      action: "regenerate_backup_codes",
    });
  } else if (backupCodesRemaining <= 2) {
    checks.push({
      id: "backup_codes",
      label: "备用恢复码",
      status: "warn",
      detail: `备用恢复码仅剩 ${backupCodesRemaining} 个，建议现在重新生成一组。`,
      action: "regenerate_backup_codes",
    });
  } else {
    checks.push({
      id: "backup_codes",
      label: "备用恢复码",
      status: "pass",
      detail: `当前还有 ${backupCodesRemaining} 个备用恢复码。`,
    });
  }

  const hasEmail = typeof user.email === "string" && user.email.trim().length > 0;
  checks.push(
    hasEmail
      ? {
          id: "email",
          label: "邮箱",
          status: "pass",
          detail: "已绑定邮箱，可用于找回密码与安全通知。",
        }
      : {
          id: "email",
          label: "邮箱",
          status: "warn",
          detail: "账号没有可用邮箱，找回密码与安全通知无法送达。",
          action: "verify_email",
        },
  );

  checks.push(
    summary.fingerprintCount > 0
      ? {
          id: "device_fingerprint",
          label: "设备指纹",
          status: "pass",
          detail: `已记录 ${summary.fingerprintCount} 条设备指纹，异常登录判断更准确。`,
        }
      : {
          id: "device_fingerprint",
          label: "设备指纹",
          status: "warn",
          detail: "还没有设备指纹记录，异常登录与设备变更判断会不准确。",
          action: "report_fingerprint",
        },
  );

  checks.push({
    id: "login_ip",
    label: "最近登录核对",
    status: summary.loginIpMatchesLastFingerprint === false ? "warn" : "pass",
    detail:
      summary.loginIpMatchesLastFingerprint === false
        ? "最近登录 IP 与最新设备指纹 IP 不一致，请确认是本人操作；不是本人请退出其他设备并修改密码。"
        : "最近登录 IP 与设备记录一致，未发现异常。",
    action: summary.loginIpMatchesLastFingerprint === false ? "review_devices" : undefined,
  });

  const otherDeviceCount = facts.otherDeviceCount ?? 0;
  checks.push({
    id: "devices",
    label: "登录设备",
    status: otherDeviceCount === 0 ? "pass" : "warn",
    detail:
      otherDeviceCount === 0
        ? "当前只有本设备在使用此账号。"
        : `除本设备外还有 ${otherDeviceCount} 台设备处于登录状态，如有不认识的设备请立即退出。`,
    action: otherDeviceCount === 0 ? undefined : "review_devices",
  });

  if (summary.accountStatus === "suspended") {
    checks.push({
      id: "account_status",
      label: "账户状态",
      status: "fail",
      detail: "账户处于暂停状态，请联系管理员了解原因。",
    });
  }

  return checks;
}

/**
 * 组装用户自助安全总览。
 *
 * @param facts 需要查询才能得到的计数（活跃设备等）；调用方查不到时传 `undefined`，
 *   清单会按「未知即不报警」处理，不把查询失败说成安全问题。
 */
export function buildAccountSecurityOverview(
  user: User,
  linkedAccounts: LinkedAccountView[] | undefined,
  facts: AccountSecurityOverviewFacts = {},
): AccountSecurityOverview {
  const summary = buildAccountSecuritySummary(user, linkedAccounts);
  const passkeyCount = countPasskeys(user);
  const backupCodesRemaining = countBackupCodes(user);
  const mfaFactorCount = (summary.totpEnabled ? 1 : 0) + (passkeyCount > 0 ? 1 : 0);

  return {
    ...summary,
    mfaFactorCount,
    passkeyCount,
    backupCodesRemaining,
    backupCodesLow: summary.totpEnabled && backupCodesRemaining <= 2,
    activeDeviceCount: facts.activeDeviceCount ?? 0,
    otherDeviceCount: facts.otherDeviceCount ?? 0,
    checks: buildChecks(user, summary, passkeyCount, backupCodesRemaining, facts),
  };
}
