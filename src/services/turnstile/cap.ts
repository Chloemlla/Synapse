import axios from "axios";
import logger from "../../utils/logger";
import { isConnected } from "../mongoService";
import { CAP_VERIFY_TIMEOUT_MS } from "./constants";
import { CapSettingModel, getCapKey, invalidateCapKeyCache } from "./models";
import { isValidCapSiteKey, sanitizeCapEndpoint, validateCapEndpoint } from "./capEndpoint";
import { assessClientRisk, recordVerificationOutcome } from "./risk";
import { generateUniqueTraceId, persistTurnstileTrace } from "./trace";
import type { CapVerifyResponse } from "./types";
import { validateConfigValue, validateToken } from "./validators";

export type CapConfigKey = "CAP_SITE_KEY" | "CAP_SECRET_KEY" | "CAP_API_ENDPOINT";

const CAP_CONFIG_KEYS: readonly CapConfigKey[] = ["CAP_SITE_KEY", "CAP_SECRET_KEY", "CAP_API_ENDPOINT"];

function normalizeEndpoint(endpoint: string | null): string {
  // 所有读取点都过一遍校验：即使库里已被写坏，出站请求也只会拿到校验过（或默认）的 origin。
  return sanitizeCapEndpoint(endpoint);
}

export function maskCapSecret(secretKey: string | null): string | null {
  if (!secretKey) return null;
  if (secretKey.length <= 8) return "***";
  return `${secretKey.slice(0, 4)}***${secretKey.slice(-4)}`;
}

export async function getCapConfig(): Promise<{
  enabled: boolean;
  siteKey: string | null;
  secretKey: string | null;
  apiEndpoint: string;
}> {
  const [siteKey, secretKey, apiEndpoint] = await Promise.all([
    getCapKey("CAP_SITE_KEY"),
    getCapKey("CAP_SECRET_KEY"),
    getCapKey("CAP_API_ENDPOINT"),
  ]);

  return {
    enabled: !!siteKey && !!secretKey,
    siteKey,
    secretKey,
    apiEndpoint: normalizeEndpoint(apiEndpoint),
  };
}

export async function isCapEnabled(): Promise<boolean> {
  const [siteKey, secretKey] = await Promise.all([getCapKey("CAP_SITE_KEY"), getCapKey("CAP_SECRET_KEY")]);
  return !!siteKey && !!secretKey;
}

export async function updateCapConfig(key: CapConfigKey, value: string): Promise<boolean> {
  try {
    if (!CAP_CONFIG_KEYS.includes(key)) {
      logger.warn("Cap 配置更新失败：不允许的配置键", { key });
      return false;
    }

    const validatedValue = validateConfigValue(value);
    if (!validatedValue) {
      logger.warn("Cap 配置更新失败：输入参数无效", { key, valueLength: value?.length });
      return false;
    }

    // 写入侧把关：地址类配置查 SSRF，站点密钥查格式（非 10 位十六进制直接拒，避免把非法值带进出站 URL）。
    if (key === "CAP_API_ENDPOINT") {
      const check = validateCapEndpoint(validatedValue);
      if (!check.ok) {
        logger.warn("Cap 实例地址校验未通过", { reason: check.reason });
        return false;
      }
    }
    if (key === "CAP_SITE_KEY" && !isValidCapSiteKey(validatedValue)) {
      logger.warn("Cap Site Key 格式非法（应为 10 位十六进制）");
      return false;
    }

    if (!isConnected()) {
      logger.error("数据库连接不可用，无法更新 Cap 配置", { key });
      return false;
    }

    const storedValue = key === "CAP_API_ENDPOINT" ? sanitizeCapEndpoint(validatedValue) : validatedValue;

    await CapSettingModel.findOneAndUpdate(
      { key },
      { key, value: storedValue, updatedAt: new Date() },
      { upsert: true, returnDocument: "after" },
    );
    invalidateCapKeyCache(key);

    logger.info(`Cap 配置更新成功: ${key}`);
    return true;
  } catch (error) {
    logger.error(`更新 Cap 配置失败: ${key}`, error);
    return false;
  }
}

export async function deleteCapConfig(key: CapConfigKey): Promise<boolean> {
  try {
    if (!CAP_CONFIG_KEYS.includes(key)) {
      logger.warn("Cap 配置删除失败：输入参数无效", { key });
      return false;
    }

    if (!isConnected()) {
      logger.error("数据库连接不可用，无法删除 Cap 配置", { key });
      return false;
    }

    await CapSettingModel.findOneAndDelete({ key });
    invalidateCapKeyCache(key);
    logger.info(`Cap 配置删除成功: ${key}`);
    return true;
  } catch (error) {
    logger.error(`删除 Cap 配置失败: ${key}`, error);
    return false;
  }
}

/**
 * Cap Standalone 的 /siteverify：body { secret, response }，失败时返回 { success:false, error }。
 * fail-closed：任何网络异常/超时都判失败并落 trace，绝不因上游抖动放行。
 */
function resolveCapSiteKey(value: string | null): string | null {
  return isValidCapSiteKey(value) ? value.trim() : null;
}

export async function verifyCapToken(token: string, remoteIp?: string): Promise<boolean> {
  const traceId = generateUniqueTraceId();

  const fail = async (reason: string, errorCode: string, errorMessage: string) => {
    const riskAssessment = assessClientRisk(remoteIp || "unknown", undefined, undefined);
    await persistTurnstileTrace({
      traceId,
      time: new Date(),
      ip: remoteIp || "unknown",
      ua: undefined,
      success: false,
      reason,
      errorCode,
      errorMessage,
      fingerprint: undefined,
      riskLevel: riskAssessment.riskLevel,
      riskScore: riskAssessment.riskScore,
      riskReasons: riskAssessment.riskReasons,
      verificationMethod: "trycap",
    });
    return false;
  };

  try {
    const validatedToken = validateToken(token);
    if (!validatedToken) {
      return await fail("invalid_input", "INVALID_INPUT", "输入参数无效");
    }

    const { siteKey, secretKey, apiEndpoint } = await getCapConfig();
    // 站点密钥只认配置（且必须是 Cap 的 10 位十六进制格式），不接受任何调用方传入的值。
    const effectiveSiteKey = resolveCapSiteKey(siteKey);

    if (!secretKey || !effectiveSiteKey) {
      logger.warn("Cap 密钥未配置或格式非法，拒绝当前验证请求", { traceId, hasSiteKey: !!effectiveSiteKey });
      return await fail("service_unavailable", "SERVICE_UNAVAILABLE", "trycap 服务未配置");
    }

    const response = await axios.post<CapVerifyResponse>(
      `${apiEndpoint}/${encodeURIComponent(effectiveSiteKey)}/siteverify`,
      { secret: secretKey, response: validatedToken },
      { headers: { "Content-Type": "application/json" }, timeout: CAP_VERIFY_TIMEOUT_MS },
    );

    const now = new Date();

    if (!response.data?.success) {
      recordVerificationOutcome(remoteIp || "unknown", undefined, false, now);
      logger.warn("trycap 验证失败", { error: response.data?.error, remoteIp, traceId });
      return await fail("verification_failed", "VERIFICATION_FAILED", `trycap 验证失败: ${response.data?.error || "未知错误"}`);
    }

    recordVerificationOutcome(remoteIp || "unknown", undefined, true, now);

    const riskAssessment = assessClientRisk(remoteIp || "unknown", undefined, undefined);
    await persistTurnstileTrace({
      traceId,
      time: now,
      ip: remoteIp || "unknown",
      ua: undefined,
      success: true,
      reason: "verification_success",
      errorCode: null,
      errorMessage: null,
      fingerprint: undefined,
      riskLevel: riskAssessment.riskLevel,
      riskScore: riskAssessment.riskScore,
      riskReasons: riskAssessment.riskReasons,
      verificationMethod: "trycap",
    });

    return true;
  } catch (error) {
    recordVerificationOutcome(remoteIp || "unknown", undefined, false, new Date());
    logger.error("trycap 验证请求失败", {
      error: error instanceof Error ? error.message : "Unknown error",
      remoteIp,
      traceId,
    });
    return await fail("network_error", "NETWORK_ERROR", error instanceof Error ? error.message : "网络请求失败");
  }
}

/**
 * 管理端自检：用配置里的 endpoint + siteKey 取一次 challenge。
 * 只验证「地址可达 + siteKey 有效」，不消耗 token、不校验 secret（secret 只有在 siteverify 时才用得上）。
 */
export async function testCapConnectivity(): Promise<{
  ok: boolean;
  apiEndpoint: string;
  siteKey: string | null;
  latencyMs: number;
  httpStatus?: number;
  error?: string;
}> {
  const { siteKey, apiEndpoint } = await getCapConfig();
  const startedAt = Date.now();

  if (!siteKey) {
    return { ok: false, apiEndpoint, siteKey: null, latencyMs: 0, error: "未配置 Cap Site Key" };
  }

  try {
    const response = await axios.post(
      `${apiEndpoint}/${encodeURIComponent(siteKey)}/challenge`,
      {},
      { headers: { "Content-Type": "application/json" }, timeout: CAP_VERIFY_TIMEOUT_MS },
    );
    const hasToken = typeof response.data?.token === "string" && response.data.token.length > 0;
    return {
      ok: hasToken,
      apiEndpoint,
      siteKey,
      latencyMs: Date.now() - startedAt,
      httpStatus: response.status,
      ...(hasToken ? {} : { error: "挑战接口未返回 token，Site Key 可能无效" }),
    };
  } catch (error) {
    const status = axios.isAxiosError(error) ? error.response?.status : undefined;
    return {
      ok: false,
      apiEndpoint,
      siteKey,
      latencyMs: Date.now() - startedAt,
      httpStatus: status,
      error: error instanceof Error ? error.message : "连通性检查失败",
    };
  }
}

export function isCapConfigKey(key: unknown): key is CapConfigKey {
  return typeof key === "string" && (CAP_CONFIG_KEYS as readonly string[]).includes(key);
}
