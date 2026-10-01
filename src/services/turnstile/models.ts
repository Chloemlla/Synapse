import logger from "../../utils/logger";
import { isConnected, mongoose } from "../mongoService";
import type {
  CapSettingDoc,
  CaptchaProviderId,
  CaptchaProviderSettingDoc,
  HCaptchaSettingDoc,
  TurnstileSettingDoc,
} from "./types";

type TurnstileKeyName = "TURNSTILE_SECRET_KEY" | "TURNSTILE_SITE_KEY";

const TURNSTILE_KEY_CACHE_TTL_MS = 60_000;
const turnstileKeyCache = new Map<TurnstileKeyName, { value: string | null; expiresAt: number }>();

const TurnstileSettingSchema = new mongoose.Schema<TurnstileSettingDoc>(
  {
    key: { type: String, required: true },
    value: { type: String, required: true },
    updatedAt: { type: Date, default: Date.now },
  },
  { collection: "turnstile_settings" },
);

const HCaptchaSettingSchema = new mongoose.Schema<HCaptchaSettingDoc>(
  {
    key: { type: String, required: true },
    value: { type: String, required: true },
    updatedAt: { type: Date, default: Date.now },
  },
  { collection: "hcaptcha_settings" },
);

export const TurnstileSettingModel =
  (mongoose.models.TurnstileSetting as mongoose.Model<TurnstileSettingDoc>) ||
  mongoose.model<TurnstileSettingDoc>("TurnstileSetting", TurnstileSettingSchema);

export const HCaptchaSettingModel =
  (mongoose.models.HCaptchaSetting as mongoose.Model<HCaptchaSettingDoc>) ||
  mongoose.model<HCaptchaSettingDoc>("HCaptchaSetting", HCaptchaSettingSchema);

const CapSettingSchema = new mongoose.Schema<CapSettingDoc>(
  {
    key: { type: String, required: true },
    value: { type: String, required: true },
    updatedAt: { type: Date, default: Date.now },
  },
  { collection: "cap_settings" },
);

export const CapSettingModel =
  (mongoose.models.CapSetting as mongoose.Model<CapSettingDoc>) ||
  mongoose.model<CapSettingDoc>("CapSetting", CapSettingSchema);

const CaptchaProviderSettingSchema = new mongoose.Schema<CaptchaProviderSettingDoc>(
  {
    provider: { type: String, required: true, unique: true },
    enabled: { type: Boolean, default: true },
    weight: { type: Number, default: 0 },
    monthlyQuota: { type: Number, default: undefined },
    updatedAt: { type: Date, default: Date.now },
  },
  { collection: "captcha_provider_settings" },
);

export const CaptchaProviderSettingModel =
  (mongoose.models.CaptchaProviderSetting as mongoose.Model<CaptchaProviderSettingDoc>) ||
  mongoose.model<CaptchaProviderSettingDoc>("CaptchaProviderSetting", CaptchaProviderSettingSchema);

export function invalidateTurnstileKeyCache(keyName?: TurnstileKeyName): void {
  if (keyName) {
    turnstileKeyCache.delete(keyName);
    return;
  }
  turnstileKeyCache.clear();
}

export async function getTurnstileKey(keyName: TurnstileKeyName): Promise<string | null> {
  const now = Date.now();
  const cached = turnstileKeyCache.get(keyName);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  let value: string | null = null;
  try {
    if (isConnected()) {
      const doc = await TurnstileSettingModel.findOne({ key: keyName }).lean().exec();
      if (doc && typeof doc.value === "string" && doc.value.trim().length > 0) {
        value = doc.value.trim();
      }
    }
  } catch (error) {
    logger.error("获取Turnstile密钥失败", { keyName, error: error instanceof Error ? error.message : String(error) });
  }

  if (!value) {
    const envValue = process.env[keyName]?.trim();
    value = envValue && envValue.length > 0 ? envValue : null;
  }

  turnstileKeyCache.set(keyName, {
    value,
    expiresAt: now + TURNSTILE_KEY_CACHE_TTL_MS,
  });

  return value;
}

export async function getHCaptchaKey(keyName: "HCAPTCHA_SECRET_KEY" | "HCAPTCHA_SITE_KEY"): Promise<string | null> {
  try {
    if (isConnected()) {
      const doc = await HCaptchaSettingModel.findOne({ key: keyName }).lean().exec();
      if (doc && typeof doc.value === "string" && doc.value.trim().length > 0) {
        return doc.value.trim();
      }
    }
  } catch (e) {
    logger.error(`读取hCaptcha ${keyName} 失败，回退到环境变量`, e);
  }

  const envKey = process.env[keyName]?.trim();
  return envKey && envKey.length > 0 ? envKey : null;
}

type CapKeyName = "CAP_SITE_KEY" | "CAP_SECRET_KEY" | "CAP_API_ENDPOINT";

const CAP_KEY_CACHE_TTL_MS = 60_000;
const capKeyCache = new Map<CapKeyName, { value: string | null; expiresAt: number }>();

export function invalidateCapKeyCache(keyName?: CapKeyName): void {
  if (keyName) {
    capKeyCache.delete(keyName);
    return;
  }
  capKeyCache.clear();
}

/** Cap 配置与 Turnstile 同构：先读 Mongo，再回退环境变量，带 60s 缓存。 */
export async function getCapKey(keyName: CapKeyName): Promise<string | null> {
  const now = Date.now();
  const cached = capKeyCache.get(keyName);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  let value: string | null = null;
  try {
    if (isConnected()) {
      const doc = await CapSettingModel.findOne({ key: keyName }).lean().exec();
      if (doc && typeof doc.value === "string" && doc.value.trim().length > 0) {
        value = doc.value.trim();
      }
    }
  } catch (error) {
    logger.error("获取Cap配置失败", { keyName, error: error instanceof Error ? error.message : String(error) });
  }

  if (!value) {
    const envValue = process.env[keyName]?.trim();
    value = envValue && envValue.length > 0 ? envValue : null;
  }

  capKeyCache.set(keyName, { value, expiresAt: now + CAP_KEY_CACHE_TTL_MS });
  return value;
}

/** 读取全部供应商的调度配置（上线开关 + 权重）；缺失的供应商由调用方补默认值。 */
export async function getCaptchaProviderSettingDocs(): Promise<CaptchaProviderSettingDoc[]> {
  try {
    if (!isConnected()) return [];
    const docs = await CaptchaProviderSettingModel.find({}).lean().exec();
    return docs.map((doc) => ({
      provider: doc.provider as CaptchaProviderId,
      enabled: doc.enabled !== false,
      weight: typeof doc.weight === "number" && Number.isFinite(doc.weight) ? doc.weight : 0,
      monthlyQuota:
        typeof (doc as { monthlyQuota?: unknown }).monthlyQuota === "number"
          ? ((doc as { monthlyQuota: number }).monthlyQuota)
          : undefined,
      updatedAt: doc.updatedAt,
    }));
  } catch (error) {
    logger.error("读取人机验证供应商调度配置失败", error);
    return [];
  }
}

export async function upsertCaptchaProviderSetting(
  provider: CaptchaProviderId,
  update: { enabled: boolean; weight: number; monthlyQuota?: number },
): Promise<boolean> {
  try {
    if (!isConnected()) {
      logger.error("数据库连接不可用，无法更新人机验证供应商配置", { provider });
      return false;
    }
    const patch: Record<string, unknown> = {
      provider,
      enabled: update.enabled,
      weight: update.weight,
      updatedAt: new Date(),
    };
    // undefined = 不动现有额度设置；显式 0 = 解除限额。
    if (update.monthlyQuota !== undefined) patch.monthlyQuota = update.monthlyQuota;

    await CaptchaProviderSettingModel.findOneAndUpdate({ provider }, patch, {
      upsert: true,
      returnDocument: "after",
    });
    return true;
  } catch (error) {
    logger.error("更新人机验证供应商配置失败", { provider, error });
    return false;
  }
}

const SHCTraceSchema = new mongoose.Schema(
  {
    traceId: { type: String, required: true, unique: true },
    time: { type: Date, default: Date.now },
    ip: String,
    ua: String,
    success: Boolean,
    reason: String,
    errorCode: String,
    errorMessage: String,
    score: Number,
    thresholdBase: Number,
    thresholdUsed: Number,
    passRateIp: Number,
    passRateUa: Number,
    policy: String,
    riskLevel: String,
    riskScore: Number,
    riskReasons: [String],
    challengeRequired: Boolean,
    verificationMethod: { type: String, default: "turnstile" },
    fingerprint: String,
    violationCount: Number,
    banned: Boolean,
    banExpiresAt: Date,
    cfErrorCodes: [String],
  },
  { collection: "shc_traces", timestamps: false },
);

const SHCTraceModel = mongoose.models.SHCTrace || mongoose.model("SHCTrace", SHCTraceSchema);

export function getTraceModel() {
  return SHCTraceModel;
}
