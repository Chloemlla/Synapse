import crypto from "node:crypto";
import { isIP } from "node:net";
import axios from "axios";
import { config } from "../config/config";
import { IpqsLookupLogModel } from "../models/ipqsLookupLogModel";
import { type IpqsQuotaDoc, IpqsQuotaModel } from "../models/ipqsQuotaModel";
import { IpVerificationTokenModel } from "../models/ipVerificationTokenModel";
import logger from "../utils/logger";
import { buildScamalyticsLookupUrl, normalizeScamalyticsUser } from "../utils/scamalytics";
import { mongoose } from "./mongoService";
import { evaluateIpRisk } from "./ipRiskService";
import { manualBanIp } from "./turnstile/ipBan";
import { TurnstileService } from "./turnstileService";
interface ScamalyticsResponse {
  scamalytics: {
    status: string;
    credits: number;
    exec: string;
    /** 读不到厂商分数字段时整键缺省，绝不用 0 顶替（0 分等价于「厂商说这个 IP 很干净」，见 shouldRequireVerification 的 B2-01 处理）。 */
    scamalytics_score?: number;
    scamalytics_risk: string;
    scamalytics_isp: string;
    scamalytics_org: string;
    scamalytics_proxy: {
      is_datacenter: boolean;
      is_vpn: boolean;
      is_google: boolean;
      is_apple: boolean;
      is_icloud_relay: boolean;
    };
  };
  external_datasources?: {
    [key: string]: unknown;
  };
}

type LegacyIpRiskResponse = {
  fraud_score?: number;
  proxy?: boolean;
  vpn?: boolean;
  tor?: boolean;
  active_vpn?: boolean;
  active_tor?: boolean;
  recent_abuse?: boolean;
  bot_status?: boolean;
  request_id?: string;
};

interface LookupContext {
  fingerprint: string;
  ipAddress: string;
  userAgent?: string;
  userLanguage?: string;
}

interface LookupDecision {
  success: boolean;
  requiresVerification: boolean;
  decision: "allow" | "challenge" | "skip" | "error";
  reason: string;
  fraudScore?: number;
  riskFlags: string[];
  requestId?: string;
}

export interface IpVerificationSessionResult {
  success: boolean;
  verified: boolean;
  requiresVerification: boolean;
  fingerprint: string;
  ipAddress: string;
  token?: string;
  expiresAt?: string;
  issuedBy?: "auto" | "turnstile" | "hcaptcha" | "trycap";
  reason?: string;
  fraudScore?: number;
  riskFlags?: string[];
  tokenTtlMinutes: number;
  /**
   * 风险分达到 blockRiskScore、且封禁已落库：闸门直接阻断该 IP，不再给人机验证的机会。
   * 路由据此回 403 + error="IP已被封禁"（前端 ipVerification.ts 已按这个形状读 banData）。
   */
  banned?: boolean;
  banReason?: string;
  banExpiresAt?: string;
}

function normalizeFingerprint(input: string): string | null {
  if (!input || typeof input !== "string") return null;
  const value = input.trim().slice(0, 200);
  if (value.length < 8) return null;
  return /^[a-zA-Z0-9_-]+$/.test(value) ? value : null;
}

function normalizeIpAddress(input: string): string | null {
  if (!input || typeof input !== "string") return null;
  const trimmed = input.trim();
  if (isIP(trimmed)) return trimmed;
  if (trimmed.startsWith("::ffff:")) {
    const nested = trimmed.slice(7);
    return isIP(nested) ? nested : null;
  }
  return null;
}

function maskToken(token: string): string {
  return token.length > 10 ? `${token.slice(0, 8)}...` : token;
}

function monthKey(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function hashApiKey(apiKey: string): string {
  // G5-14: 该哈希仅用于给配额/日志打"这是哪个 key"的标识，不需要口令级 KDF。
  // 改用 HMAC-SHA256，避免 pbkdf2Sync 12 万次迭代阻塞事件循环。
  const secret = config.jwtSecret || process.env.JWT_SECRET || "ip-verification-test-secret";
  // codeql[js/insufficient-password-hash] HMAC identifier digest (server-secret keyed) of a server-generated high-entropy apiKey, not a password hash (see G5-14)
  return crypto.createHmac("sha256", secret).update(`ipqs:${apiKey}`).digest("hex").slice(0, 32);
}

/** 厂商响应里可能承载风险分的候选字段：Scamalytics 现用 scamalytics_score，其余是改名/换壳时的兜底。 */
const FRAUD_SCORE_FIELDS = ["scamalytics_score", "score", "risk_score", "fraud_score"] as const;

/** 只接受有限数值（含数字字符串）；空串、布尔、null、NaN 一律视为「读不到」。 */
function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * 从 scamalytics 容器里捧出风险分。读不到任何已知候选字段时返回 null —— 不是 0。
 * 「0 分」是「厂商说这个 IP 很干净」，「null」是「我们没读懂厂商」，两者的放行语义完全不同（B2-01）。
 */
function resolveFraudScore(container: unknown): number | null {
  if (typeof container !== "object" || container === null) return null;
  const record = container as Record<string, unknown>;
  for (const field of FRAUD_SCORE_FIELDS) {
    const parsed = toFiniteNumber(record[field]);
    if (parsed !== null) return parsed;
  }
  return null;
}

function normalizeRiskLookupResponse(response: ScamalyticsResponse | LegacyIpRiskResponse): ScamalyticsResponse {
  if ((response as ScamalyticsResponse).scamalytics) {
    return response as ScamalyticsResponse;
  }

  const legacy = response as LegacyIpRiskResponse;
  // 旧形态（IPQS 风格）的分数字段读不到时不要编造 0：0 分在下游等价于「厂商说这个 IP 很干净」，
  // 于是「响应形状变了 / 读不懂」会被静默变成放行（B2-01）。读不到就让该键缺省，
  // 由 shouldRequireVerification 按「解析失败」收紧。标志位照旧可读，不跟着分数一起丢。
  const score = toFiniteNumber(legacy.fraud_score);
  const highRisk =
    (score !== null && score >= config.ipqs.challengeFraudScore) ||
    Boolean(legacy.proxy || legacy.vpn || legacy.tor);

  return {
    scamalytics: {
      status: "ok",
      credits: 0,
      exec: legacy.request_id || "",
      ...(score === null ? {} : { scamalytics_score: score }),
      scamalytics_risk: highRisk ? "high" : "low",
      scamalytics_isp: "",
      scamalytics_org: "",
      scamalytics_proxy: {
        is_datacenter: Boolean(legacy.proxy),
        is_vpn: Boolean(legacy.vpn || legacy.active_vpn),
        is_google: false,
        is_apple: false,
        is_icloud_relay: false,
      },
    },
    external_datasources: {
      legacy,
    },
  };
}

interface RiskFlagsExtraction {
  flags: string[];
  /** 代理标志块是否真的读到了：读不到时不能当作「这个 IP 没有任何代理特征」。 */
  proxyReadable: boolean;
}

function extractRiskFlags(response: ScamalyticsResponse): RiskFlagsExtraction {
  const flags: string[] = [];
  // 厂商响应是外部数据：scamalytics 被换成非对象、或少了 scamalytics_proxy 键时，
  // 旧写法直接取属性会抛 TypeError，被 lookupIpqs 的 catch 吞成 lookup_failed。这里显式判形态，
  // 读不到就把 proxyReadable 置 false，交由上层按「解析失败」收紧处理（B2-01）。
  const scamalytics = response.scamalytics as unknown;
  const scamalyticsRecord =
    typeof scamalytics === "object" && scamalytics !== null ? (scamalytics as Record<string, unknown>) : null;
  const proxy = scamalyticsRecord?.scamalytics_proxy;
  const proxyReadable = typeof proxy === "object" && proxy !== null;

  if (proxyReadable) {
    const proxyRecord = proxy as Record<string, unknown>;
    if (proxyRecord.is_datacenter) flags.push("proxy", "datacenter");
    if (proxyRecord.is_vpn) flags.push("vpn");
    if (proxyRecord.is_icloud_relay) flags.push("icloud_relay");
  }

  // We can also check external datasources if needed, but Scamalytics' own assessment is usually enough
  if (scamalyticsRecord?.scamalytics_risk === "high" || scamalyticsRecord?.scamalytics_risk === "very high") {
    flags.push("high_risk");
  }

  return { flags, proxyReadable };
}

function shouldRequireVerification(response: ScamalyticsResponse): LookupDecision {
  const fraudScore = resolveFraudScore(response.scamalytics);
  const { flags: riskFlags, proxyReadable } = extractRiskFlags(response);

  // B2-01：这里的「读不到」与「读到 0」必须分开。旧写法 Number(x || 0) 在厂商把
  // scamalytics_score 改名或该字段缺失时静默得到 0 分，配合空的 riskFlags 判定 allow，
  // 调用方随即 issueToken(..., "auto") 在没有任何人机挑战的情况下签发已验证令牌。
  // 现在只有「确实读到数值、且低于阈值、且没有风险标志」才允许 allow；读不到分数字段
  // 或读不到标志块一律收紧为 challenge（fail-closed），真实用户仍能过人机验证通过。
  const parseFailed = fraudScore === null || !proxyReadable;
  const requiresVerification =
    fraudScore === null ||
    !proxyReadable ||
    fraudScore >= config.ipqs.challengeFraudScore ||
    riskFlags.length > 0;

  const unparsedParts: string[] = [];
  if (fraudScore === null) unparsedParts.push(`score_unreadable(${FRAUD_SCORE_FIELDS.join("|")})`);
  if (!proxyReadable) unparsedParts.push("proxy_block_unreadable");

  return {
    success: true,
    requiresVerification,
    decision: requiresVerification ? "challenge" : "allow",
    reason: parseFailed
      ? `risk_response_unparsed:${unparsedParts.join("+")}`
      : requiresVerification
        ? `fraud_score=${fraudScore};flags=${riskFlags.join(",") || "none"}`
        : "risk_check_passed",
    fraudScore: fraudScore ?? undefined,
    riskFlags,
    requestId: response.scamalytics.exec,
  };
}

function toLookupLogRawResponse(response?: ScamalyticsResponse): Record<string, unknown> | undefined {
  return response ? { ...response } : undefined;
}

async function ensureMongoIfEnabled(): Promise<boolean> {
  // G5-04: 纯只读探测，不再每次调用 connectMongo()（正常时避免全量配置重载，
  // Mongo 故障时避免每请求 ~19s 阻塞与连接风暴）。建连职责交给启动流程。
  return mongoose.connection.readyState === 1;
}

export class IpVerificationService {
  private static getVerifyTtlMs(): number {
    return config.ipqs.tokenTtlMinutes * 60 * 1000;
  }

  private static getApiKeys(): string[] {
    // G5-23: 去掉 env 合并。env 值只应经由 runtimeConfigDefaults 进入（"DB 未配置时才用 env"），
    // 否则管理员在后台删掉泄露的 key，env 里的旧 key 仍被选中，界面显示与实际不一致。
    const configuredKeys = Array.isArray(config.ipqs.apiKeys) ? config.ipqs.apiKeys : [];
    return Array.from(new Set(configuredKeys.map((item) => item?.trim()).filter((item): item is string => Boolean(item) && item !== 'api')));
  }

  private static async getReusableToken(fingerprint: string, ipAddress: string): Promise<any | null> {
    if (!(await ensureMongoIfEnabled())) return null;

    return IpVerificationTokenModel.findOne({
      fingerprint,
      ipAddress,
      expiresAt: { $gt: new Date() },
    })
      .sort({ expiresAt: -1 })
      .exec();
  }

  private static async issueToken(
    fingerprint: string,
    ipAddress: string,
    issuedBy: "auto" | "turnstile" | "hcaptcha" | "trycap",
    fraudScore?: number,
    riskFlags: string[] = [],
  ): Promise<IpVerificationSessionResult> {
    if (!(await ensureMongoIfEnabled())) {
      return {
        success: false,
        verified: false,
        requiresVerification: false,
        fingerprint,
        ipAddress,
        reason: "database_unavailable",
        tokenTtlMinutes: config.ipqs.tokenTtlMinutes,
      };
    }

    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + IpVerificationService.getVerifyTtlMs());

    // GB-06: 原子替换同一 (fingerprint, ipAddress) 的旧令牌。
    // 旧写法是先 deleteMany({fingerprint, ipAddress}) 再 create：同一客户端两次并发
    // /session 时，后到的 insert 会把前一个已经随 200 响应返回给客户端的令牌删掉，
    // 客户端拿这张已被删除的令牌过闸门就 403（现象是刷新一次就好）。
    // findOneAndUpdate + upsert 把「删旧 + 写新」合并成单次原子写，消除这个互踩窗口。
    // 注意：IpVerificationTokenModel 只对 (fingerprint, ipAddress, expiresAt) 建了普通复合索引，
    // 没有 (fingerprint, ipAddress) 唯一索引；Mongo 的 upsert 只有在唯一索引冲突时才转为更新，
    // 因此极端并发下两次 upsert 仍可能各插一条。本批不新增索引（线上大集合建索引需另评估）。
    await IpVerificationTokenModel.findOneAndUpdate(
      { fingerprint, ipAddress },
      {
        $set: {
          token,
          fingerprint,
          ipAddress,
          issuedBy,
          challengePassed: issuedBy !== "auto",
          fraudScore,
          riskFlags,
          expiresAt,
          lastValidatedAt: new Date(),
        },
      },
      { upsert: true, returnDocument: "after" },
    );

    logger.info("[IpVerification] Issued session token", {
      fingerprint: `${fingerprint.slice(0, 8)}...`,
      ipAddress,
      issuedBy,
      fraudScore,
      riskFlags,
      token: maskToken(token),
      expiresAt,
    });

    return {
      success: true,
      verified: true,
      requiresVerification: false,
      fingerprint,
      ipAddress,
      token,
      expiresAt: expiresAt.toISOString(),
      issuedBy,
      fraudScore,
      riskFlags,
      tokenTtlMinutes: config.ipqs.tokenTtlMinutes,
    };
  }

  private static async selectApiKey(
    month: string,
  ): Promise<
    | { status: "ok"; slot: number; key: string }
    | { status: "no_keys" }
    | { status: "database_unavailable" }
    | { status: "quota_exhausted" }
  > {
    const apiKeys = IpVerificationService.getApiKeys();
    if (apiKeys.length === 0) return { status: "no_keys" };

    if (!(await ensureMongoIfEnabled())) return { status: "database_unavailable" };

    const quotaDocs = await IpqsQuotaModel.find({ monthKey: month }).lean().exec();
    const quotaMap = new Map<number, number>();

    quotaDocs.forEach((doc: IpqsQuotaDoc) => {
      quotaMap.set(doc.apiKeySlot, Number(doc.usageCount || 0));
    });

    for (let index = 0; index < apiKeys.length; index += 1) {
      const usageCount = quotaMap.get(index) || 0;
      if (usageCount < config.ipqs.monthlyQuotaPerKey) {
        return { status: "ok", slot: index, key: apiKeys[index] };
      }
    }

    return { status: "quota_exhausted" };
  }

  private static async incrementQuota(month: string, slot: number, apiKey: string): Promise<void> {
    if (!(await ensureMongoIfEnabled())) return;

    const usageCount = (
      await IpqsQuotaModel.findOneAndUpdate(
        { monthKey: month, apiKeySlot: slot },
        {
          $setOnInsert: { apiKeyHash: hashApiKey(apiKey) },
          $inc: { usageCount: 1 },
          $set: { lastUsedAt: new Date() },
        },
        { upsert: true, returnDocument: "after" },
      ).lean()
    )?.usageCount;

    if ((usageCount || 0) >= config.ipqs.monthlyQuotaPerKey) {
      await IpqsQuotaModel.updateOne(
        { monthKey: month, apiKeySlot: slot },
        { $set: { exhaustedAt: new Date() } },
      ).exec();
    }
  }

  private static async logLookup(
    month: string,
    slot: number,
    apiKeyHashValue: string,
    context: LookupContext,
    decision: LookupDecision,
    response?: ScamalyticsResponse,
    errorMessage?: string,
  ): Promise<void> {
    if (!(await ensureMongoIfEnabled())) return;

    await IpqsLookupLogModel.create({
      monthKey: month,
      apiKeySlot: slot,
      apiKeyHash: apiKeyHashValue,
      ipAddress: context.ipAddress,
      fingerprint: context.fingerprint,
      userAgent: context.userAgent,
      userLanguage: context.userLanguage,
      requestId: decision.requestId,
      success: decision.success,
      decision: decision.decision,
      reason: decision.reason,
      fraudScore: decision.fraudScore,
      // 标志块可能读不到（见 extractRiskFlags）：这里不能再裸取属性，否则判定层刚定下的
      // challenge 会被这句 TypeError 掀回 lookup_failed（B2-01 的 fallback 路径）。
      proxy: response?.scamalytics.scamalytics_proxy?.is_datacenter || response?.scamalytics.scamalytics_proxy?.is_vpn,
      vpn: response?.scamalytics.scamalytics_proxy?.is_vpn,
      tor: false, // Scamalytics includes TOR in proxy or risk if enabled
      activeVpn: response?.scamalytics.scamalytics_proxy?.is_vpn,
      activeTor: false,
      recentAbuse:
        response?.scamalytics.scamalytics_risk === "high" || response?.scamalytics.scamalytics_risk === "very high",
      botStatus: false,
      strictness: config.ipqs.strictness,
      rawResponse: toLookupLogRawResponse(response),
      errorMessage,
      createdAt: new Date(),
    });
  }

  private static async lookupIpqs(context: LookupContext): Promise<LookupDecision> {
    if (!config.ipqs.enabled) {
      return {
        success: true,
        requiresVerification: false,
        decision: "skip",
        reason: "ip_verification_disabled",
        riskFlags: [],
      };
    }

    const month = monthKey();
    const selected = await IpVerificationService.selectApiKey(month);
    const scamalyticsUser = normalizeScamalyticsUser(config.ipqs.scamalyticsUser);

    // G5-15: 区分"未配置 key"、"配额耗尽"与"Mongo 不可用"，不再把库不可用误报成配额耗尽。
    if (selected.status === "no_keys" || selected.status === "quota_exhausted") {
      const exhaustedDecision: LookupDecision = {
        success: config.ipqs.failOpen,
        requiresVerification: false,
        decision: config.ipqs.failOpen ? "skip" : "error",
        reason:
          selected.status === "quota_exhausted" ? "ip_verification_quota_exhausted" : "ip_verification_not_configured",
        riskFlags: [],
      };
      await IpVerificationService.logLookup(
        month,
        -1,
        selected.status === "quota_exhausted" ? "quota-exhausted" : "not-configured",
        context,
        exhaustedDecision,
      );
      return exhaustedDecision;
    }

    if (selected.status === "database_unavailable") {
      const dbErrorDecision: LookupDecision = {
        success: config.ipqs.failOpen,
        requiresVerification: false,
        decision: config.ipqs.failOpen ? "skip" : "error",
        reason: "ip_verification_database_unavailable",
        riskFlags: [],
      };
      await IpVerificationService.logLookup(month, -1, "database-unavailable", context, dbErrorDecision);
      return dbErrorDecision;
    }

    // 走到这里 selected.status === "ok"
    const apiKey = selected.key;
    const slot = selected.slot;
    const scamalyticsUrl = buildScamalyticsLookupUrl(scamalyticsUser);

    try {
      const response = await axios.get<ScamalyticsResponse | LegacyIpRiskResponse>(scamalyticsUrl, {
        params: {
          key: apiKey,
          ip: context.ipAddress,
        },
        timeout: config.ipqs.timeoutMs,
        maxRedirects: 0,
      });

      // G5-15: 只在上游真正返回业务响应时计入配额；网络错误/超时不计费。
      await IpVerificationService.incrementQuota(month, slot, apiKey);

      const normalizedResponse = normalizeRiskLookupResponse(response.data);
      const decision = shouldRequireVerification(normalizedResponse);

      await IpVerificationService.logLookup(month, slot, hashApiKey(apiKey), context, decision, normalizedResponse);

      logger.info("[IpVerification] Scamalytics lookup completed", {
        ipAddress: context.ipAddress,
        fingerprint: `${context.fingerprint.slice(0, 8)}...`,
        decision: decision.decision,
        fraudScore: decision.fraudScore,
        riskFlags: decision.riskFlags,
      });

      return decision;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const failedDecision: LookupDecision = {
        success: config.ipqs.failOpen,
        requiresVerification: false,
        decision: config.ipqs.failOpen ? "skip" : "error",
        reason: "ip_verification_lookup_failed",
        riskFlags: [],
      };

      await IpVerificationService.logLookup(
        month,
        slot,
        hashApiKey(apiKey),
        context,
        failedDecision,
        undefined,
        errorMessage,
      );

      logger.warn("[IpVerification] Scamalytics lookup failed", {
        ipAddress: context.ipAddress,
        error: errorMessage,
        failOpen: config.ipqs.failOpen,
      });

      return failedDecision;
    }
  }

  public static async initializeSession(context: LookupContext): Promise<IpVerificationSessionResult> {
    const fingerprint = normalizeFingerprint(context.fingerprint);
    const ipAddress = normalizeIpAddress(context.ipAddress);

    if (!fingerprint || !ipAddress) {
      return {
        success: false,
        verified: false,
        requiresVerification: false,
        fingerprint: context.fingerprint,
        ipAddress: context.ipAddress,
        reason: "invalid_fingerprint_or_ip",
        tokenTtlMinutes: config.ipqs.tokenTtlMinutes,
      };
    }

    if (config.enableFirstVisitVerification === false) {
      return {
        success: true,
        verified: true,
        requiresVerification: false,
        fingerprint,
        ipAddress,
        issuedBy: "auto",
        tokenTtlMinutes: config.ipqs.tokenTtlMinutes,
      };
    }

    // 先认已经过了闸门的会话：令牌在 TTL 内、且指纹与 IP 都对得上就直接复用，不再走风险判定。
    //
    // 这一步必须排在风险判定之前。闸门真正执行的 verifyRequestToken 认这张令牌，这里却重新
    // 挑战一次的话，两条路径自相矛盾：访客刚过完人机验证，刷新一次又被打回挑战页。proxycheck
    // 的 IP 级结论（vpn/hosting）默认缓存 24 小时，比 40 分钟的令牌活得久，于是"验证通过后
    // 刷新即失效"会稳定复现。
    const reusableToken = await IpVerificationService.getReusableToken(fingerprint, ipAddress);
    if (reusableToken) {
      return {
        success: true,
        verified: true,
        requiresVerification: false,
        fingerprint,
        ipAddress,
        token: reusableToken.token,
        expiresAt: reusableToken.expiresAt.toISOString(),
        issuedBy: reusableToken.issuedBy,
        fraudScore: reusableToken.fraudScore,
        riskFlags: reusableToken.riskFlags || [],
        tokenTtlMinutes: config.ipqs.tokenTtlMinutes,
      };
    }

    // proxycheck.io 是独立于 IPQS 的辅助风险信号，只做「加严」：命中即挑战，未命中或上游
    // 不可用时完全交回下方原有的 IPQS 判定（failOpen 语义见 ipRiskService.evaluateIpRisk）。
    if (config.proxycheck.enabled) {
      const proxycheckRisk = await evaluateIpRisk(ipAddress);

      // 风险分达到 blockRiskScore：直接封禁，不再给验证机会。封禁写进 IpBanModel 后
      // ipBanCheck 会在最外层拦下该 IP 的**全部**请求（前端静态资源与后端 API 一起），
      // 这里只需把结果告诉前端，让它渲染阻断页与申诉入口。
      if (proxycheckRisk.shouldBlock) {
        const banReason = `高风险 IP 自动拦截：proxycheck 风险分 ${proxycheckRisk.risk}（${proxycheckRisk.level}）`;
        const banResult = await manualBanIp(ipAddress, banReason, 24 * 60, { source: "auto" });

        if (banResult.success) {
          return {
            success: false,
            verified: false,
            requiresVerification: false,
            fingerprint,
            ipAddress,
            reason: "ip_risk_blocked",
            banned: true,
            banReason,
            banExpiresAt: banResult.expiresAt?.toISOString(),
            fraudScore: proxycheckRisk.risk,
            riskFlags: proxycheckRisk.flags,
            tokenTtlMinutes: config.ipqs.tokenTtlMinutes,
          };
        }

        // 封禁落库失败（Mongo 不可用等）：不能假装已阻断，退回挑战，至少不静默放行。
        logger.warn("[IpVerification] 高风险 IP 封禁失败，退回挑战", {
          ipAddress,
          risk: proxycheckRisk.risk,
          error: banResult.error,
        });
      }

      if (proxycheckRisk.shouldChallenge) {
        return {
          success: true,
          verified: false,
          requiresVerification: true,
          fingerprint,
          ipAddress,
          reason: proxycheckRisk.reason,
          fraudScore: proxycheckRisk.risk,
          riskFlags: proxycheckRisk.flags,
          tokenTtlMinutes: config.ipqs.tokenTtlMinutes,
        };
      }
    }

    // 两侧风险源都关闭：既没有可签发的令牌，也没有要执行的判定，直接视为已验证放行
    // （ipVerification 中间件与 verifyRequestToken 用同一判据豁免）。
    // 注意不能只判 ipqs：只关 IPQS 而开着 proxycheck 时必须往下走，否则中间件要求令牌、
    // 这里却从不签发，干净 IP 也会被自己的门禁 403。下面 lookupIpqs 会直接跳过 IPQS 判定，
    // 由末尾的 issueToken 签出 "auto" 令牌。
    if (!config.ipqs.enabled && !config.proxycheck.enabled) {
      return {
        success: true,
        verified: true,
        requiresVerification: false,
        fingerprint,
        ipAddress,
        issuedBy: "auto",
        tokenTtlMinutes: config.ipqs.tokenTtlMinutes,
      };
    }

    const lookupDecision = await IpVerificationService.lookupIpqs({
      fingerprint,
      ipAddress,
      userAgent: context.userAgent,
      userLanguage: context.userLanguage,
    });

    if (!lookupDecision.success && !config.ipqs.failOpen) {
      return {
        success: false,
        verified: false,
        requiresVerification: false,
        fingerprint,
        ipAddress,
        reason: lookupDecision.reason,
        tokenTtlMinutes: config.ipqs.tokenTtlMinutes,
      };
    }

    if (lookupDecision.requiresVerification) {
      return {
        success: true,
        verified: false,
        requiresVerification: true,
        fingerprint,
        ipAddress,
        reason: lookupDecision.reason,
        fraudScore: lookupDecision.fraudScore,
        riskFlags: lookupDecision.riskFlags,
        tokenTtlMinutes: config.ipqs.tokenTtlMinutes,
      };
    }

    return IpVerificationService.issueToken(
      fingerprint,
      ipAddress,
      "auto",
      lookupDecision.fraudScore,
      lookupDecision.riskFlags,
    );
  }

  public static async completeVerification(
    fingerprintInput: string,
    ipAddressInput: string,
    captchaToken: string,
    userAgent?: string,
    captchaType: "turnstile" | "hcaptcha" | "trycap" = "turnstile",
  ): Promise<IpVerificationSessionResult> {
    const fingerprint = normalizeFingerprint(fingerprintInput);
    const ipAddress = normalizeIpAddress(ipAddressInput);

    if (!fingerprint || !ipAddress || !captchaToken) {
      return {
        success: false,
        verified: false,
        requiresVerification: true,
        fingerprint: fingerprintInput,
        ipAddress: ipAddressInput,
        reason: "invalid_verification_payload",
        tokenTtlMinutes: config.ipqs.tokenTtlMinutes,
      };
    }

    const captchaResult = await TurnstileService.verifyTokenDetailed(
      captchaToken,
      ipAddress,
      userAgent,
      fingerprint,
      captchaType,
    );

    if (!captchaResult.success) {
      return {
        success: false,
        verified: false,
        requiresVerification: true,
        fingerprint,
        ipAddress,
        reason: captchaResult.errorCode || captchaResult.reason || "captcha_verification_failed",
        tokenTtlMinutes: config.ipqs.tokenTtlMinutes,
      };
    }

    return IpVerificationService.issueToken(fingerprint, ipAddress, captchaType, undefined, []);
  }

  public static async verifyRequestToken(
    tokenInput: string,
    fingerprintInput: string,
    ipAddressInput: string,
  ): Promise<boolean> {
    // 同 ipVerification 中间件：闸门关闭或两侧风险源都关才豁免，否则一律校验令牌。
    if (
      config.enableFirstVisitVerification === false ||
      (!config.ipqs.enabled && !config.proxycheck.enabled)
    ) {
      return true;
    }

    const token = tokenInput?.trim();
    const fingerprint = normalizeFingerprint(fingerprintInput);
    const ipAddress = normalizeIpAddress(ipAddressInput);

    if (!token || !fingerprint || !ipAddress) return false;
    if (!(await ensureMongoIfEnabled())) return false;

    const doc = await IpVerificationTokenModel.findOne({
      token,
      fingerprint,
      ipAddress,
      expiresAt: { $gt: new Date() },
    }).exec();

    if (!doc) return false;

    // G5-14: lastValidatedAt 节流更新（距上次超过 60 秒才写），避免每个受保护请求多一次 Mongo 写。
    const lastValidatedAt = doc.lastValidatedAt ? new Date(doc.lastValidatedAt).getTime() : 0;
    if (!lastValidatedAt || Date.now() - lastValidatedAt > 60_000) {
      doc.lastValidatedAt = new Date();
      await doc.save();
    }
    return true;
  }
}

export default IpVerificationService;
