import * as accessToken from "./turnstile/accessToken";
import * as cap from "./turnstile/cap";
import * as config from "./turnstile/config";
import * as fingerprint from "./turnstile/fingerprint";
import * as hcaptcha from "./turnstile/hcaptcha";
import * as ipBan from "./turnstile/ipBan";
import * as providers from "./turnstile/providers";
import * as quota from "./turnstile/quota";
import * as verify from "./turnstile/verify";

export class TurnstileService {
  // 配置
  static isEnabled = config.isEnabled;
  static getConfig = config.getConfig;
  static updateConfig = config.updateConfig;
  static deleteConfig = config.deleteConfig;

  // IP 封禁
  static isIpBanned = ipBan.isIpBanned;
  static recordViolation = ipBan.recordViolation;
  static manualBanIp = ipBan.manualBanIp;
  static unbanIp = ipBan.unbanIp;
  static cleanupExpiredIpBans = ipBan.cleanupExpiredIpBans;
  static getIpBanStats = ipBan.getIpBanStats;

  // 访问密钥
  static generateAccessToken = accessToken.generateAccessToken;
  static generateDevToken = accessToken.generateDevToken;
  static verifyAccessToken = accessToken.verifyAccessToken;
  static hasValidAccessToken = accessToken.hasValidAccessToken;
  static cleanupExpiredAccessTokens = accessToken.cleanupExpiredAccessTokens;
  static getAccessTokenStats = accessToken.getAccessTokenStats;

  // 临时指纹
  static reportTempFingerprint = fingerprint.reportTempFingerprint;
  static checkTempFingerprintVerificationStatus = fingerprint.checkTempFingerprintVerificationStatus;
  static checkTempFingerprintStatus = fingerprint.checkTempFingerprintStatus;
  static cleanupExpiredFingerprints = fingerprint.cleanupExpiredFingerprints;
  static getTempFingerprintStats = fingerprint.getTempFingerprintStats;

  // Turnstile 验证
  static verifyToken = verify.verifyToken;
  static verifyTokenDetailed = verify.verifyTokenDetailed;
  static verifyTempFingerprint = verify.verifyTempFingerprint;

  // hCaptcha
  static verifyHCaptchaToken = hcaptcha.verifyHCaptchaToken;
  static isHCaptchaEnabled = hcaptcha.isHCaptchaEnabled;
  static getHCaptchaConfig = hcaptcha.getHCaptchaConfig;
  static updateHCaptchaConfig = hcaptcha.updateHCaptchaConfig;
  static deleteHCaptchaConfig = hcaptcha.deleteHCaptchaConfig;

  // Cap (trycap)
  static verifyCapToken = cap.verifyCapToken;
  static isCapEnabled = cap.isCapEnabled;
  static getCapConfig = cap.getCapConfig;
  static updateCapConfig = cap.updateCapConfig;
  static deleteCapConfig = cap.deleteCapConfig;
  static testCapConnectivity = cap.testCapConnectivity;
  static isCapConfigKey = cap.isCapConfigKey;

  // 供应商调度（上线/下线 + 权重 + 优先级 + 场景权重 + 月额度）
  static collectCaptchaProviders = providers.collectCaptchaProviders;
  static selectCaptchaProvider = providers.selectCaptchaProvider;
  static getProviderSecretPresence = providers.getProviderSecretPresence;
  static getProviderQuotaLimits = providers.getProviderQuotaLimits;
  static isCaptchaProviderId = providers.isCaptchaProviderId;
  static clampProviderWeight = providers.clampProviderWeight;
  static upsertCaptchaProviderSetting = providers.upsertCaptchaProviderSetting;

  // 分配体系（策略 + 前端控件外观）
  static getCaptchaAllocationPolicy = providers.getCaptchaAllocationPolicy;
  static updateCaptchaAllocationPolicy = providers.updateCaptchaAllocationPolicy;
  static getCaptchaWidgetSettings = providers.getCaptchaWidgetSettings;
  static updateCaptchaWidgetSettings = providers.updateCaptchaWidgetSettings;
  static resolveProviderWidgetSettings = providers.resolveProviderWidgetSettings;

  // 月度额度
  static clampMonthlyQuota = quota.clampMonthlyQuota;
  static getCaptchaQuotaSnapshot = quota.getCaptchaQuotaSnapshot;
  static getCaptchaQuotaSnapshots = quota.getCaptchaQuotaSnapshots;
  static consumeConfiguredCaptchaQuota = quota.consumeConfiguredCaptchaQuota;
  static readCaptchaQuotaHistory = quota.readCaptchaQuotaHistory;
}
