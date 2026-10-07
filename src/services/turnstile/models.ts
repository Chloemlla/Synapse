import logger from "../../utils/logger";
import { isConnected, mongoose } from "../mongoService";
import { readCaptchaKey } from "./keyStorage";
import type {
  CapSettingDoc,
  CaptchaAllocationPolicyDoc,
  CaptchaProviderId,
  CaptchaProviderSettingDoc,
  CaptchaScenario,
  CaptchaWidgetProviderOverride,
  CaptchaWidgetSettingsDoc,
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
    priority: { type: Number, default: undefined },
    scenarioWeights: { type: mongoose.Schema.Types.Mixed, default: undefined },
    updatedAt: { type: Date, default: Date.now },
  },
  { collection: "captcha_provider_settings" },
);

export const CaptchaProviderSettingModel =
  (mongoose.models.CaptchaProviderSetting as mongoose.Model<CaptchaProviderSettingDoc>) ||
  mongoose.model<CaptchaProviderSettingDoc>("CaptchaProviderSetting", CaptchaProviderSettingSchema);

const CaptchaAllocationPolicySchema = new mongoose.Schema<CaptchaAllocationPolicyDoc>(
  {
    key: { type: String, required: true, unique: true },
    strategy: { type: String, default: "weighted" },
    rotationSeconds: { type: Number, default: 300 },
    stickyEnabled: { type: Boolean, default: false },
    stickyTtlMinutes: { type: Number, default: 30 },
    rolloutPercent: { type: Number, default: 0 },
    rolloutControlProvider: { type: String, default: "turnstile" },
    failoverMaxAttempts: { type: Number, default: 2 },
    scenarioStrategies: { type: mongoose.Schema.Types.Mixed, default: {} },
    updatedAt: { type: Date, default: Date.now },
  },
  { collection: "captcha_allocation_policy" },
);

export const CaptchaAllocationPolicyModel =
  (mongoose.models.CaptchaAllocationPolicy as mongoose.Model<CaptchaAllocationPolicyDoc>) ||
  mongoose.model<CaptchaAllocationPolicyDoc>("CaptchaAllocationPolicy", CaptchaAllocationPolicySchema);

const CaptchaWidgetSettingsSchema = new mongoose.Schema<CaptchaWidgetSettingsDoc>(
  {
    key: { type: String, required: true, unique: true },
    theme: { type: String, default: "auto" },
    size: { type: String, default: "normal" },
    language: { type: String, default: "auto" },
    showProviderLabel: { type: Boolean, default: true },
    perProvider: { type: mongoose.Schema.Types.Mixed, default: {} },
    updatedAt: { type: Date, default: Date.now },
  },
  { collection: "captcha_widget_settings" },
);

export const CaptchaWidgetSettingsModel =
  (mongoose.models.CaptchaWidgetSettings as mongoose.Model<CaptchaWidgetSettingsDoc>) ||
  mongoose.model<CaptchaWidgetSettingsDoc>("CaptchaWidgetSettings", CaptchaWidgetSettingsSchema);

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

  const value = await readCaptchaKey(TurnstileSettingModel, keyName);

  turnstileKeyCache.set(keyName, {
    value,
    expiresAt: now + TURNSTILE_KEY_CACHE_TTL_MS,
  });

  return value;
}

export async function getHCaptchaKey(keyName: "HCAPTCHA_SECRET_KEY" | "HCAPTCHA_SITE_KEY"): Promise<string | null> {
  return readCaptchaKey(HCaptchaSettingModel, keyName);
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

  const value = await readCaptchaKey(CapSettingModel, keyName);

  capKeyCache.set(keyName, { value, expiresAt: now + CAP_KEY_CACHE_TTL_MS });
  return value;
}

/** 读取全部供应商的调度配置（上线开关 + 权重 + 优先级 + 场景权重）；缺失的供应商由调用方补默认值。 */
export async function getCaptchaProviderSettingDocs(): Promise<CaptchaProviderSettingDoc[]> {
  try {
    if (!isConnected()) return [];
    const docs = await CaptchaProviderSettingModel.find({}).lean().exec();
    return docs.map((doc) => {
      const raw = doc as {
        monthlyQuota?: unknown;
        priority?: unknown;
        scenarioWeights?: unknown;
      };
      return {
        provider: doc.provider as CaptchaProviderId,
        enabled: doc.enabled !== false,
        weight: typeof doc.weight === "number" && Number.isFinite(doc.weight) ? doc.weight : 0,
        monthlyQuota: typeof raw.monthlyQuota === "number" ? raw.monthlyQuota : undefined,
        priority: typeof raw.priority === "number" && Number.isFinite(raw.priority) ? raw.priority : undefined,
        scenarioWeights: normalizeStoredScenarioWeights(raw.scenarioWeights),
        updatedAt: doc.updatedAt,
      };
    });
  } catch (error) {
    logger.error("读取人机验证供应商调度配置失败", error);
    return [];
  }
}

/** 落库形状的防御性归一化：只保留已知场景且为有限正数的项（0 是合法权重，保留）。 */
function normalizeStoredScenarioWeights(value: unknown): Partial<Record<CaptchaScenario, number>> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const result: Partial<Record<CaptchaScenario, number>> = {};
  for (const scenario of ["default", "first_visit", "standalone"] as const) {
    const entry = source[scenario];
    if (typeof entry === "number" && Number.isFinite(entry) && entry >= 0) result[scenario] = entry;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export async function upsertCaptchaProviderSetting(
  provider: CaptchaProviderId,
  update: {
    enabled: boolean;
    weight: number;
    monthlyQuota?: number;
    priority?: number;
    scenarioWeights?: Partial<Record<CaptchaScenario, number>>;
  },
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
    // undefined = 不动现有设置；显式 0 = 解除限额 / 权重归零。
    if (update.monthlyQuota !== undefined) patch.monthlyQuota = update.monthlyQuota;
    if (update.priority !== undefined) patch.priority = update.priority;
    if (update.scenarioWeights !== undefined) patch.scenarioWeights = update.scenarioWeights;

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

/** 策略/外观是下发链路上的热读，30s 进程内缓存兜一层；写侧失效。 */
const CAPTCHA_ALLOCATION_CACHE_TTL_MS = 30_000;
let allocationPolicyCache: { value: CaptchaAllocationPolicyDoc | null; expiresAt: number } | null = null;
let widgetSettingsCache: { value: CaptchaWidgetSettingsDoc | null; expiresAt: number } | null = null;

export function invalidateCaptchaAllocationCaches(): void {
  allocationPolicyCache = null;
  widgetSettingsCache = null;
}

const ALLOCATION_POLICY_KEY = "global";

/** 读取全局分配策略；未配置时返回 null（调用方补默认值，读接口不产生副作用）。 */
export async function getCaptchaAllocationPolicyDoc(): Promise<CaptchaAllocationPolicyDoc | null> {
  const now = Date.now();
  if (allocationPolicyCache && allocationPolicyCache.expiresAt > now) return allocationPolicyCache.value;

  let value: CaptchaAllocationPolicyDoc | null = null;
  try {
    if (isConnected()) {
      const doc = await CaptchaAllocationPolicyModel.findOne({ key: ALLOCATION_POLICY_KEY }).lean().exec();
      if (doc) {
        value = {
          key: ALLOCATION_POLICY_KEY,
          strategy: doc.strategy as CaptchaAllocationPolicyDoc["strategy"],
          rotationSeconds: doc.rotationSeconds,
          stickyEnabled: doc.stickyEnabled === true,
          stickyTtlMinutes: doc.stickyTtlMinutes,
          rolloutPercent: doc.rolloutPercent,
          rolloutControlProvider: doc.rolloutControlProvider as CaptchaAllocationPolicyDoc["rolloutControlProvider"],
          failoverMaxAttempts: doc.failoverMaxAttempts,
          scenarioStrategies: (doc.scenarioStrategies ?? {}) as CaptchaAllocationPolicyDoc["scenarioStrategies"],
          updatedAt: doc.updatedAt,
        };
      }
    }
  } catch (error) {
    logger.error("读取人机验证分配策略失败", error);
  }

  allocationPolicyCache = { value, expiresAt: now + CAPTCHA_ALLOCATION_CACHE_TTL_MS };
  return value;
}

export async function upsertCaptchaAllocationPolicy(
  patch: Partial<Omit<CaptchaAllocationPolicyDoc, "key" | "updatedAt">>,
): Promise<CaptchaAllocationPolicyDoc | null> {
  try {
    if (!isConnected()) return null;
    const doc = await CaptchaAllocationPolicyModel.findOneAndUpdate(
      { key: ALLOCATION_POLICY_KEY },
      { $set: { ...patch, key: ALLOCATION_POLICY_KEY, updatedAt: new Date() } },
      { upsert: true, returnDocument: "after" },
    )
      .lean()
      .exec();
    invalidateCaptchaAllocationCaches();
    return (doc as CaptchaAllocationPolicyDoc) ?? null;
  } catch (error) {
    logger.error("更新人机验证分配策略失败", error);
    return null;
  }
}

/** 读取前端控件外观设置；未配置时返回 null（调用方补默认值）。 */
export async function getCaptchaWidgetSettingsDoc(): Promise<CaptchaWidgetSettingsDoc | null> {
  const now = Date.now();
  if (widgetSettingsCache && widgetSettingsCache.expiresAt > now) return widgetSettingsCache.value;

  let value: CaptchaWidgetSettingsDoc | null = null;
  try {
    if (isConnected()) {
      const doc = await CaptchaWidgetSettingsModel.findOne({ key: ALLOCATION_POLICY_KEY }).lean().exec();
      if (doc) {
        value = {
          key: ALLOCATION_POLICY_KEY,
          theme: doc.theme as CaptchaWidgetSettingsDoc["theme"],
          size: doc.size as CaptchaWidgetSettingsDoc["size"],
          language: doc.language,
          showProviderLabel: doc.showProviderLabel !== false,
          perProvider: normalizeStoredWidgetOverrides(doc.perProvider),
          updatedAt: doc.updatedAt,
        };
      }
    }
  } catch (error) {
    logger.error("读取人机验证控件外观设置失败", error);
  }

  widgetSettingsCache = { value, expiresAt: now + CAPTCHA_ALLOCATION_CACHE_TTL_MS };
  return value;
}

function normalizeStoredWidgetOverrides(value: unknown): Partial<Record<CaptchaProviderId, CaptchaWidgetProviderOverride>> {
  const result: Partial<Record<CaptchaProviderId, CaptchaWidgetProviderOverride>> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return result;
  const source = value as Record<string, unknown>;
  for (const provider of ["turnstile", "hcaptcha", "trycap"] as const) {
    const entry = source[provider];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const raw = entry as Record<string, unknown>;
    const override: CaptchaWidgetProviderOverride = {};
    if (typeof raw.theme === "string") override.theme = raw.theme as CaptchaWidgetProviderOverride["theme"];
    if (typeof raw.size === "string") override.size = raw.size as CaptchaWidgetProviderOverride["size"];
    if (typeof raw.language === "string") override.language = raw.language;
    if (Object.keys(override).length > 0) result[provider] = override;
  }
  return result;
}

export async function upsertCaptchaWidgetSettings(
  patch: Partial<Omit<CaptchaWidgetSettingsDoc, "key" | "updatedAt">>,
): Promise<CaptchaWidgetSettingsDoc | null> {
  try {
    if (!isConnected()) return null;
    const doc = await CaptchaWidgetSettingsModel.findOneAndUpdate(
      { key: ALLOCATION_POLICY_KEY },
      { $set: { ...patch, key: ALLOCATION_POLICY_KEY, updatedAt: new Date() } },
      { upsert: true, returnDocument: "after" },
    )
      .lean()
      .exec();
    invalidateCaptchaAllocationCaches();
    return (doc as CaptchaWidgetSettingsDoc) ?? null;
  } catch (error) {
    logger.error("更新人机验证控件外观设置失败", error);
    return null;
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

// Keep security diagnostics for the same 90-day period as the audit log.
SHCTraceSchema.index({ time: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

const SHCTraceModel = mongoose.models.SHCTrace || mongoose.model("SHCTrace", SHCTraceSchema);

export function getTraceModel() {
  return SHCTraceModel;
}
