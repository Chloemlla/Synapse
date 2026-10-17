import { config } from "../config/config";
import { AccountIpSignal } from "../models/accountIpSignalModel";
import { AuthSessionModel } from "../models/authSessionModel";
import { DeviceTracking } from "../models/deviceTrackingModel";
import { SecurityEvent } from "../models/securityEventModel";
import {
  computeStepUpUntil,
  detectAccountSharingSuspected,
  evaluateAccountRiskScore,
  resolveAccountRiskChannelDecision,
  resolveIdcEscalationAction,
  tierRank,
  type AccountIpRiskFact,
  type AccountRiskAssessment,
  type AccountRiskChannel,
  type AccountRiskChannelDecision,
  type AccountRiskChannelSource,
  type AccountRiskTier,
  type AccountSharingFacts,
} from "../utils/accountRiskScoring";
import logger from "../utils/logger";
import type { User as UserType } from "../utils/userStorageTypes";
import { AuditLogService } from "./auditLogService";
import { setApiKeyPenalty } from "./apiKeyService";
import { getLatestAuthSessionIpLocation, revokeAllAuthSessions } from "./authSessionService";
import { loadDeviceFingerprintFacts, type DeviceFingerprintSignalFacts } from "./deviceFingerprintService";
import { isDatacenterEgress } from "./geoRisk";
import { isMeaningfulLocation } from "./ipTelemetryService";
import { getCachedIpRisk, getIpRisk, type IpRiskResult } from "./ipRiskService";
import { mongoose } from "./mongoService";
import { isRiskExempt, noteRiskExemption } from "./riskExemption";
import { getAccountRiskState, updateUser, UserModel } from "./userService";

/**
 * 账户风险聚合与登录 IP 沉淀（RC-06 / RC-12 / §4.2）。
 *
 * 两条互相独立的职责：
 * 1. **沉淀**：每次登录成功把 `(userId, ip)` 写进 `account_ip_signals`，顺带把该 IP 当下的
 *    风险分快照下来。缓存未命中时**只记「暂无结论」**，补查在后台异步做 —— 登录是热路径，
 *    不允许同步外呼上游（RC-06.2）。
 * 2. **聚合**：`evaluateAccountRisk` 把 IP 信号 + 设备台账 + 账户级滥用事件折算成
 *    「风险分 + 档位」，并按 §3 的升降级规则落库：**自动只升不降**，且升档上限由运行时
 *    配置 `accountRisk.autoEscalationCap` 控制（默认 `watch`，避免第一版就误封真实用户）。
 *
 * 判据的方向提醒：本模块的分数**越高越危险**，与 `accountSecuritySummaryService`
 *（越高越安全，驱动「建议你开 MFA」）方向相反，两者刻意不合并（RC-06.4）。
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** 账户级滥用事件的 eventType 前缀（RC-20：违规拦截要按账户聚合，不能只按 IP 记）。 */
export const ACCOUNT_ABUSE_EVENT_PREFIX = "ACCOUNT_ABUSE";

/**
 * RC-57：自动化痕迹事件（`security_events.eventType`）。
 *
 * **刻意不带 `ACCOUNT_ABUSE_` 前缀**：这类痕迹既会进评分权重（`AUTOMATION_HINT`，固定 8 分），
 * 又会被 `loadAbuseFacts` 当成一条滥用事件计数 —— 若共用前缀就会双重计分，把「仅作加权信号」
 * 变成一条能推动档位的判据。前缀不匹配聚合，聚合改读本常量。
 */
export const AUTOMATION_TRACE_EVENT = "AUTOMATION_TRACE";

/** 自动化痕迹事件的去重/有效窗口（天）：窗口内只要出现过一次就置 `AUTOMATION_HINT`。 */
const AUTOMATION_TRACE_WINDOW_DAYS = 7;

/** 匿名来源滥用信号的写入去重窗口：防止匿名调用方把事件表写成噪声。 */
const ANONYMOUS_SIGNAL_DEDUPE_MS = 10 * 60 * 1000;

export interface RecordLoginIpSignalInput {
  ipAddress: string;
  /** IP 属地（来自会话台账/属地查询结果）；取不到留空，不要用 "未知" 之外的编造值。 */
  ipLocation?: string;
  /** 归属地查询与设备无关时的补充说明，仅进日志。 */
  reason?: string;
}

function normalizeSignalIp(ip: unknown): string {
  return typeof ip === "string" ? ip.trim().slice(0, 128) : "";
}

/**
 * Mongo 就绪探针。
 *
 * 风控钩子挂在登录路径上，大量单元测试会加载这些模块但**不连库**：
 * 不做检查时，一次 `updateOne` 会先在 mongoose 缓冲里挂 10 秒（bufferTimeoutMS）
 * 再失败，把“替身没连库”变成“用例变慢/超时”的假故障。
 * 与 `ipRiskService.ensureMongoIfEnabled` 同口径：只探就绪，绝不在这里建连。
 */
function mongoReady(): boolean {
  return mongoose.connection.readyState === 1;
}

function riskPatchFromResult(result: IpRiskResult, now: Date): Record<string, unknown> {
  return {
    riskScore: result.risk,
    riskLevel: result.level,
    flags: Array.isArray(result.flags) ? result.flags.slice(0, 32) : [],
    networkType: result.networkType || "",
    asn: result.asn || "",
    organisation: result.organisation || "",
    isDatacenter: isDatacenterEgress({
      hosting: result.detections?.hosting,
      flags: result.flags,
      networkType: result.networkType,
    }),
    source: result.source === "cache" ? "cache" : "proxycheck",
    riskCheckedAt: now,
  };
}

// 补查的单飞集合：同一 (user, ip) 在补查未落定时不重复打上游（登录高峰会出现同一 IP 连打）。
const inFlightRefreshes = new Set<string>();

/**
 * 后台补查：缓存未命中时把结论异步补上。失败只记日志 —— 风险分是增强信号，
 * 不能因为上游不可用就让登录链路出现未捕获异常。
 */
async function refreshSignalRiskInBackground(userId: string, ipAddress: string): Promise<void> {
  const key = `${userId}|${ipAddress}`;
  if (inFlightRefreshes.has(key)) return;
  inFlightRefreshes.add(key);
  try {
    const result = await getIpRisk(ipAddress, "api");
    if (result.source === "unavailable") return;
    const now = new Date();
    await AccountIpSignal.updateOne(
      { userId, ipAddress },
      { $set: riskPatchFromResult(result, now) },
    ).exec();
  } catch (error) {
    logger.debug("[AccountRisk] 登录 IP 风险补查失败（不影响登录）", {
      userId,
      ipAddress,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    inFlightRefreshes.delete(key);
  }
}

/**
 * 记录一次登录 IP 事实（幂等 upsert）。
 *
 * `loginCount` 用 `$inc` 而不是读改写：同一账户多端并发登录时会互相覆盖计数，
 * 而计数正是「高危登录占比」判据的权重（RC-06.3）。
 */
export async function recordAccountIpSignal(
  userId: string,
  input: RecordLoginIpSignalInput,
): Promise<void> {
  const ipAddress = normalizeSignalIp(input.ipAddress);
  if (!userId || !ipAddress || ipAddress === "unknown") return;

  const cfg = config.accountRisk;
  if (!cfg.enabled) return;
  if (!mongoReady()) return;

  try {
    const cached = await getCachedIpRisk(ipAddress);
    const now = new Date();
    const setPatch: Record<string, unknown> = { lastSeenAt: now };
    if (input.ipLocation) setPatch.ipLocation = String(input.ipLocation).slice(0, 256);
    if (cached) Object.assign(setPatch, riskPatchFromResult(cached, now));

    await AccountIpSignal.updateOne(
      { userId, ipAddress },
      {
        $set: setPatch,
        $setOnInsert: { firstSeenAt: now },
        $inc: { loginCount: 1 },
      },
      { upsert: true },
    ).exec();

    // 只读缓存拿不到结论时才补查；缓存命中的场景已经在上面写完了。
    if (!cached && config.proxycheck.enabled) {
      void refreshSignalRiskInBackground(userId, ipAddress);
    }
  } catch (error) {
    // 沉淀失败不能影响登录：登录已经成功了，这里只是风控证据。
    logger.warn("[AccountRisk] 登录 IP 信号写入失败", {
      userId,
      ipAddress,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * 登录成功后的风控钩子（RC-06）：沉淀本次登录 IP + 聚合一次账户风险。
 *
 * 整个过程在后台异步执行：登录是热路径，风控只是增强证据，既不能让它拖慢登录响应，
 * 也不能因失败让登录报错（登录本身已经成功并已下发令牌）。
 * 属地不在此重新查询，而是读 `createAuthSession` 刚写下的那条会话（省一次上游调用）。
 */
export function scheduleLoginRiskSignals(userId: string, ipAddress: string): void {
  const cfg = config.accountRisk;
  if (!cfg.enabled) return;

  const normalized = normalizeSignalIp(ipAddress);
  if (!userId || !normalized || normalized === "unknown") return;
  if (!mongoReady()) return;

  void (async () => {
    try {
      let ipLocation: string | undefined;
      try {
        const location = await getLatestAuthSessionIpLocation(userId);
        if (location) ipLocation = location;
      } catch {
        // 属地只是展示字段，取不到就留空，不影响风险判定。
      }

      await recordAccountIpSignal(userId, { ipAddress: normalized, ipLocation });
      if (cfg.evaluateOnLogin) {
        await evaluateAccountRisk(userId, { reason: "login" });
      }
    } catch (error) {
      logger.warn("[AccountRisk] 登录风控钩子失败（不影响登录）", {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();
}

interface DeviceRiskFacts {
  deviceMaxRiskScore: number;
  compromisedDeviceCount: number;
  /** RC-57：任一设备出现模拟器/调试器/root 痕迹即计一次自动化提示。 */
  automationHint: boolean;
}

async function loadDeviceRiskFacts(userId: string): Promise<DeviceRiskFacts> {
  try {
    const rows = (await DeviceTracking.aggregate([
      { $match: { userId } },
      {
        $group: {
          _id: null,
          deviceMaxRiskScore: { $max: "$riskScore" },
          compromisedDeviceCount: { $sum: { $cond: ["$isCompromised", 1, 0] } },
          automationDeviceCount: {
            $sum: {
              $cond: [
                {
                  $or: [
                    { $eq: ["$isEmulator", true] },
                    { $eq: ["$isDebugger", true] },
                    { $eq: ["$isRoot", true] },
                    { $eq: ["$isTracerAttached", true] },
                  ],
                },
                1,
                0,
              ],
            },
          },
        },
      },
    ]).exec()) as Array<{
      deviceMaxRiskScore?: number;
      compromisedDeviceCount?: number;
      automationDeviceCount?: number;
    }>;
    const row = rows[0];
    return {
      deviceMaxRiskScore: typeof row?.deviceMaxRiskScore === "number" ? row.deviceMaxRiskScore : 0,
      compromisedDeviceCount:
        typeof row?.compromisedDeviceCount === "number" ? row.compromisedDeviceCount : 0,
      // RC-57：自动化痕迹只作加权信号（在评分函数里权重固定为 8，单独不升档）。
      automationHint: (row?.automationDeviceCount ?? 0) > 0,
    };
  } catch (error) {
    logger.warn("[AccountRisk] 设备风险聚合失败（按无信号处理）", {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { deviceMaxRiskScore: 0, compromisedDeviceCount: 0, automationHint: false };
  }
}

export interface AbuseEventFacts {
  /** 已认证路径产生的账户级事件（计全权重）。 */
  authenticated: number;
  /** 登录前人机验证失败这类未认证来源（半权重 + 单独封顶，RC-20）。 */
  anonymous: number;
}

async function loadAbuseFacts(userId: string, since: Date): Promise<AbuseEventFacts> {
  const base = {
    userId,
    createdAt: { $gte: since },
    // 前缀匹配，`(userId, createdAt)` 复合索引负责过滤与范围，eventType 在内存里筛。
    // `GEO_JUMP` 单独排除：它已经由 `geoJump` 事实按 +10 计分，再按「一条滥用事件」计一次
    // 就是同一件事加两遍分（接线前它只加了一次，本批保持总分不变、只补回旗标）。
    eventType: {
      $regex: `^${ACCOUNT_ABUSE_EVENT_PREFIX}`,
      $nin: [`${ACCOUNT_ABUSE_EVENT_PREFIX}_GEO_JUMP`],
    },
  };
  try {
    const [authenticated, anonymous] = await Promise.all([
      SecurityEvent.countDocuments({ ...base, "eventData.anonymous": { $ne: true } }).exec(),
      SecurityEvent.countDocuments({ ...base, "eventData.anonymous": true }).exec(),
    ]);
    return { authenticated, anonymous };
  } catch (error) {
    logger.warn("[AccountRisk] 账户级滥用事件统计失败（按 0 处理）", {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { authenticated: 0, anonymous: 0 };
  }
}

/**
 * RC-15：窗口内是否有跨地域跳变信号。
 *
 * 之前 loginHandlers 写了 `ACCOUNT_ABUSE_GEO_JUMP`，但 `evaluateAccountRisk` 把 `geoJump`
 * 显式传成 `false` —— 结果事件只按「一条滥用事件」+10 计分，`GEO_JUMP` 旗标永远不出现。
 * 这里改成读事实，判据与信号来自同一份台账（不再出现「记了但没算」）。
 */
async function hasRecentGeoJump(userId: string, since: Date): Promise<boolean> {
  try {
    const found = await SecurityEvent.exists({
      userId,
      eventType: `${ACCOUNT_ABUSE_EVENT_PREFIX}_GEO_JUMP`,
      createdAt: { $gte: since },
    }).exec();
    return Boolean(found);
  } catch (error) {
    logger.warn("[AccountRisk] 属地跳变信号读取失败（按无信号处理）", {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/** RC-26 / RC-56：探测报告事实。全部来自客户端上报，只能作信号。 */
interface ProbeRiskFacts {
  exitMismatch: boolean;
  webdriver: boolean;
}

const EMPTY_PROBE_FACTS: ProbeRiskFacts = { exitMismatch: false, webdriver: false };

/**
 * RC-26 / RC-56：把 WebRTC/出口不一致探测报告接进账户风险。
 *
 * 三个刻意的约束：
 * 1. **只在 `ipRecheckEnabled` 观察期内读取**（调用方保证）——探测报告是客户端可伪造的，
 *    默认关闭时评估口径与改动前逐字节一致；
 * 2. 只按「该账户已见过的 IP」反查报告，不按 userId（报告表没有 userId，且服务端解析的
 *    `ip` 才是权威字段）；因此不会把别人的报告算到本账户；
 * 3. 任何查询失败都按「无信号」处理（fail-open 到不处罚），绝不因此阻断评估。
 *
 * 这里用 `require` 延迟加载模型：`accountRiskAction.test.ts` 把 `mongoService` 替成一个
 * 不含 `models` 的对象，顶层 import 会在用例加载阶段就抛错。延迟加载让只测处罚出口的
 * 套件不受影响（与 `fingerprintHandlers` 的既有做法一致）。
 */
async function loadProbeRiskFacts(userId: string, since: Date): Promise<ProbeRiskFacts> {
  try {
    const ips = (await AccountIpSignal.distinct("ipAddress", {
      userId,
      lastSeenAt: { $gte: since },
    }).exec()) as unknown[];
    const safeIps = ips.filter((value): value is string => typeof value === "string" && value.trim() !== "");
    if (safeIps.length === 0) return EMPTY_PROBE_FACTS;

    const { ProxycheckProbeReportModel } =
      require("../models/proxycheckProbeReportModel") as typeof import("../models/proxycheckProbeReportModel");
    const window = { ip: { $in: safeIps.slice(0, 200) }, createdAt: { $gte: since } };
    const [mismatch, webdriver] = await Promise.all([
      // 以服务端判决为准：comparability 不成立的旧报告 mismatch 恒为 false，不会被误算。
      ProxycheckProbeReportModel.countDocuments({ ...window, "mismatch.webrtcVsExit": true }).exec(),
      ProxycheckProbeReportModel.countDocuments({ ...window, webdriver: true }).exec(),
    ]);
    return { exitMismatch: mismatch > 0, webdriver: webdriver > 0 };
  } catch (error) {
    logger.warn("[AccountRisk] 探测报告读取失败（按无信号处理）", {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return EMPTY_PROBE_FACTS;
  }
}

/** RC-57：窗口内是否上报过早期自动化痕迹（`AUTOMATION_TRACE`，不参与滥用事件计数）。 */
async function hasRecentAutomationTrace(userId: string, since: Date): Promise<boolean> {
  try {
    const found = await SecurityEvent.exists({
      userId,
      eventType: AUTOMATION_TRACE_EVENT,
      createdAt: { $gte: since },
    }).exec();
    return Boolean(found);
  } catch (error) {
    logger.warn("[AccountRisk] 自动化痕迹读取失败（按无信号处理）", {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

async function loadIpRiskFacts(userId: string, since: Date): Promise<AccountIpRiskFact[]> {
  const rows = (await AccountIpSignal.find({ userId, lastSeenAt: { $gte: since } })
    .select("ipAddress riskScore loginCount lastSeenAt isDatacenter")
    .sort({ lastSeenAt: -1 })
    .limit(200)
    .lean()) as Array<{
    ipAddress?: string;
    riskScore?: number | null;
    loginCount?: number;
    lastSeenAt?: Date | string;
    isDatacenter?: boolean;
  }>;

  return rows.map((row) => ({
    ipAddress: typeof row.ipAddress === "string" ? row.ipAddress : "",
    riskScore: typeof row.riskScore === "number" ? row.riskScore : null,
    loginCount: typeof row.loginCount === "number" ? row.loginCount : 0,
    lastSeenAt: row.lastSeenAt ? new Date(row.lastSeenAt).getTime() : 0,
    isDatacenter: row.isDatacenter === true,
  }));
}

/** 拼车判定的空事实：关开关/查询失败时使用，使评分函数的行为可预测。 */
export const EMPTY_SHARING_FACTS: AccountSharingFacts = {
  distinctDeviceCount: 0,
  distinctIpCount: 0,
  distinctCountryCount: 0,
  concurrentSessionCount: 0,
  fingerprintSharedAcrossAccounts: false,
};

/** 指纹信号的空事实：开关关闭时使用（不再查 `device_fingerprints`）。 */
const EMPTY_FINGERPRINT_FACTS: DeviceFingerprintSignalFacts = {
  fingerprintCount: 0,
  componentDrift: false,
  driftFingerprintIds: [],
  sharedAcrossAccounts: false,
  sharedFingerprintIds: [],
  sharedComponentHashes: [],
};

/**
 * 属地字符串里的国家/地区（形如 `"中国, 北京, 北京 运营商: 中国联通"`）。
 * “未知”等失败哨兵不参与计数 —— 宁可少算一个国家，也不要把“查不到”当“换了个国家”。
 */
function countryOf(location: unknown): string {
  const raw = typeof location === "string" ? location.trim() : "";
  if (!raw || !isMeaningfulLocation(raw)) return "";
  const first = raw.split(",")[0]?.trim() || "";
  return first.slice(0, 64);
}

function safeCount(promise: Promise<number>, label: string, userId: string): Promise<number> {
  return promise.catch((error) => {
    logger.warn(`[AccountRisk] ${label}失败（按 0 处理）`, {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  });
}

/**
 * 聚合拼车/共享账号所需的事实（RC-17）。
 *
 * 三个维度各自独立查询、各自容错：一个维度挂掉不应该让其余维度也退化成 0
 *（否则一次 Mongo 抖动就会把“有嫌疑”静默变成“没嫌疑”）。
 * 设备数直接数 `device_trackings`（唯一键是 (userId, deviceFingerprint)，行数即不同设备数）。
 */
async function loadSharingFacts(userId: string, since: Date, now: number): Promise<AccountSharingFacts> {
  const windowMinutes = Math.max(1, config.accountRisk.sharingSessionWindowMinutes);
  const sessionWindowStart = new Date(now - windowMinutes * 60 * 1000);

  const [distinctDeviceCount, distinctIpCount, ipRows, concurrentSessionCount] = await Promise.all([
    safeCount(DeviceTracking.countDocuments({ userId }).exec(), "拼车设备数统计", userId),
    safeCount(
      AccountIpSignal.countDocuments({ userId, lastSeenAt: { $gte: since } }).exec(),
      "拼车登录 IP 数统计",
      userId,
    ),
    AccountIpSignal.find({ userId, lastSeenAt: { $gte: since } })
      .select("ipLocation")
      .limit(200)
      .lean()
      .then((rows) => rows as Array<{ ipLocation?: string }>)
      .catch((error) => {
        logger.warn("[AccountRisk] 拼车地区统计失败（按 0 处理）", {
          userId,
          error: error instanceof Error ? error.message : String(error),
        });
        return [] as Array<{ ipLocation?: string }>;
      }),
    safeCount(
      AuthSessionModel.countDocuments({
        userId,
        revokedAt: null,
        lastActivityAt: { $gte: sessionWindowStart },
      }).exec(),
      "并发会话统计",
      userId,
    ),
  ]);

  const countries = new Set<string>();
  for (const row of ipRows) {
    const country = countryOf(row?.ipLocation);
    if (country) countries.add(country);
  }

  return {
    distinctDeviceCount,
    distinctIpCount,
    distinctCountryCount: countries.size,
    concurrentSessionCount,
    fingerprintSharedAcrossAccounts: false,
  };
}

function sameFlags(a: string[] | undefined, b: string[]): boolean {
  const left = Array.isArray(a) ? [...a].sort() : [];
  const right = [...b].sort();
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

export interface AccountRiskEvaluationResult extends AccountRiskAssessment {
  /** 落库后的生效档位（自动升档不会降级，因此可能高于本次算出的 `cappedTier`）。 */
  effectiveTier: AccountRiskTier;
  /** 本次是否发生了自动升档。 */
  escalated: boolean;
  /** 超管豁免：分数照算，档位与 step-up 不动。 */
  exempt: boolean;
}

/**
 * 账户风险聚合的入口（§4.2）。
 *
 * 调用时机：登录成功后（同步、只读缓存与外呼无关的库）、风险事件上报后（异步）、
 * 管理端打开账户详情时、定时任务。**幂等**：同分同档不重复写事件。超管豁免（RC-44）
 * 只影响档位与 step-up，分照算、事照记。
 */
export async function evaluateAccountRisk(
  userId: string,
  options: { reason?: string } = {},
): Promise<AccountRiskEvaluationResult | null> {
  const cfg = config.accountRisk;
  if (!cfg.enabled) return null;
  if (!mongoReady()) return null;

  const state = await getAccountRiskState(userId);
  if (!state) return null;

  const now = Date.now();
  const since = new Date(now - cfg.windowDays * DAY_MS);
  // 属地跳变与自动化痕迹只关心「最近」，用独立窗口避免一条半年前的记录长期压着旗标。
  const geoJumpSince = new Date(now - Math.min(cfg.windowDays, 7) * DAY_MS);
  const automationSince = new Date(now - AUTOMATION_TRACE_WINDOW_DAYS * DAY_MS);

  const [
    ipSignals,
    deviceFacts,
    abuseFacts,
    sharingFacts,
    fingerprintFacts,
    geoJump,
    probeFacts,
    automationTrace,
  ] = await Promise.all([
    loadIpRiskFacts(userId, since),
    loadDeviceRiskFacts(userId),
    loadAbuseFacts(userId, since),
    cfg.sharingDetectionEnabled
      ? loadSharingFacts(userId, since, now)
      : Promise.resolve(EMPTY_SHARING_FACTS),
    cfg.fingerprintComponentsEnabled ? loadDeviceFingerprintFacts(userId) : Promise.resolve(EMPTY_FINGERPRINT_FACTS),
    hasRecentGeoJump(userId, geoJumpSince),
    // RC-26 / RC-56：WebRTC 探测报告只在观察期内读取（默认关）。
    cfg.ipRecheckEnabled ? loadProbeRiskFacts(userId, since) : Promise.resolve(EMPTY_PROBE_FACTS),
    // RC-57：早期自动化痕迹（navigator.webdriver 等）与指纹分量同一开关。
    cfg.fingerprintComponentsEnabled ? hasRecentAutomationTrace(userId, automationSince) : Promise.resolve(false),
  ]);

  const createdAt = state.createdAt ? Date.parse(state.createdAt) : Number.NaN;

  // RC-17.4：`trusted` 是“经管理员确认的多设备账户”（手机 + 平板 + 两台电脑是常态），
  // 只有它豁免拼车判定；其余账户一律按三条件联立或跨账户分量判定。
  const trustedMultiDevice = state.role === "trusted";
  const sharingSuspected =
    !trustedMultiDevice &&
    detectAccountSharingSuspected(
      { ...sharingFacts, fingerprintSharedAcrossAccounts: fingerprintFacts.sharedAcrossAccounts },
      cfg,
    );

  // RC-57：分量漂移本身不是独立旗标（用户明确要求评分层只保留
  // ACCOUNT_SHARING_SUSPECTED 与 AUTOMATION_HINT），因此归入自动化痕迹的加权信号。
  // 早期痕迹（navigator.webdriver / UA-CH 缺失）与探测报告里的 webdriver 同样只是「提示」。
  const automationHint =
    deviceFacts.automationHint || fingerprintFacts.componentDrift || automationTrace || probeFacts.webdriver;

  const assessment = evaluateAccountRiskScore(
    {
      now,
      accountCreatedAt: Number.isFinite(createdAt) ? createdAt : null,
      ipSignals,
      deviceMaxRiskScore: deviceFacts.deviceMaxRiskScore,
      compromisedDeviceCount: deviceFacts.compromisedDeviceCount,
      recentAbuseEventCount: abuseFacts.authenticated,
      recentAnonymousAbuseEventCount: abuseFacts.anonymous,
      automationHint,
      sharingSuspected,
      // RC-15：读最近 7 天的 ACCOUNT_ABUSE_GEO_JUMP 台账，而不是恒传 false
      //（旧实现让旗标永远不会出现，信号只剩「一条滥用事件」的分数）。
      geoJump,
      probeExitMismatch: probeFacts.exitMismatch,
    },
    cfg,
  );

  const currentTier: AccountRiskTier = state.riskTier ?? "normal";
  const exempt = isRiskExempt({ role: state.role });

  // 自动只升不降：降级必须人工（§3 升降级规则 / D1 未裁决前不做自动降级）。
  const shouldEscalate = !exempt && tierRank(assessment.cappedTier) > tierRank(currentTier);
  const effectiveTier = shouldEscalate ? assessment.cappedTier : currentTier;

  const flagsChanged = !sameFlags(state.riskFlags, assessment.flags);
  const patch: Partial<UserType> = {
    riskScore: assessment.riskScore,
    riskUpdatedAt: now,
  };
  if (flagsChanged || assessment.flags.length > 0) {
    patch.riskFlags = assessment.flags;
  }

  if (shouldEscalate) {
    patch.riskTier = effectiveTier;
    patch.flaggedBy = "auto";
    patch.flagReason = assessment.reasons.join("; ").slice(0, 512) || options.reason || "auto escalation";
    patch.stepUpUntil = computeStepUpUntil(cfg, now);
    patch.stepUpMode = cfg.stepUpMode;
  } else if (
    !exempt &&
    (effectiveTier === "restricted" || effectiveTier === "danger") &&
    (state.stepUpUntil ?? 0) <= now
  ) {
    // 已在受限/危险档但 step-up 窗口过期：续期而不是永久要求验证（避免把用户卡死）。
    patch.stepUpUntil = computeStepUpUntil(cfg, now);
    patch.stepUpMode = state.stepUpMode ?? cfg.stepUpMode;
  }

  try {
    await updateUser(userId, patch);
  } catch (error) {
    logger.warn("[AccountRisk] 账户风险写回失败", {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  if (shouldEscalate || flagsChanged) {
    await recordAccountRiskEvent({
      userId,
      fromTier: currentTier,
      toTier: effectiveTier,
      assessment,
      reason: options.reason,
      exempt,
    });
  }

  logger.info("[AccountRisk] 聚合完成", {
    userId,
    riskScore: assessment.riskScore,
    currentTier,
    effectiveTier,
    escalated: shouldEscalate,
    exempt,
  });

  return {
    ...assessment,
    effectiveTier,
    escalated: shouldEscalate,
    exempt,
  };
}

async function recordAccountRiskEvent(params: {
  userId: string;
  fromTier: AccountRiskTier;
  toTier: AccountRiskTier;
  /** 只取事件需要的字段：聚合结果（AccountRiskAssessment）与人工动作构造的快照都能直接传。 */
  assessment: {
    riskScore: number;
    riskTier: AccountRiskTier;
    cappedTier: AccountRiskTier;
    flags: readonly string[];
    reasons: readonly string[];
  };
  reason?: string;
  exempt: boolean;
  /** 有值 = 这是一次人工/自动的明确动作；无值 = 聚合结果的自动升档。 */
  action?: AccountRiskAction;
  operatorId?: string;
}): Promise<void> {
  const { userId, fromTier, toTier, assessment, reason, exempt, action, operatorId } = params;
  try {
    await SecurityEvent.create({
      deviceFingerprint: "account-risk",
      userId,
      eventType: action ? "ACCOUNT_RISK_ACTION" : "ACCOUNT_RISK_TIER_CHANGED",
      eventData: {
        fromTier,
        toTier,
        riskScore: assessment.riskScore,
        flags: assessment.flags,
        reasons: assessment.reasons,
        reason,
        exempt,
        source: action ? "action" : "auto",
        ...(action ? { action, operatorId } : {}),
      },
      riskScore: assessment.riskScore,
      ipAddress: "",
      userAgent: "",
      createdAt: new Date(),
    });
  } catch (error) {
    logger.warn("[AccountRisk] 风险事件写入失败", {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * 账户风险动作（RC-07）：**管理端与自动判定唯一的处罚出口**。
 *
 * 为什么不继续让各处直接 `updateUser({accountStatus})`：
 * 1. 原实现只写 `accountStatus: "suspended"`，**不写原因、不写操作人、不撤存量会话、不写事件**——
 *    事后无法回答「谁在什么时候因为什么封了他」，也无法申诉；
 * 2. 只有「封停」与「正常」两档，没有「标记 / 观察 / 逐步验证」的中间态；
 * 3. 各业务模块各自实现了自己的禁令（工单 `TICKET_PERMISSION_BANNED`、翻译
 *    `translationAccessUntil`……），账户级与模块级两套体系没有共同的「风险档」概念。
 *
 * 本函数是这三件事的收口：**改档位 + 落事件 + 按需踢掉存量会话**，并保证：
 * - 档位**单调**（除 `unban` / `clear_flags` 这两个显式的人工降级动作）；
 * - `superadmin` 不能被本出口封停（封停超管必须走专用路径 + 安全会话，见 §3.2）；
 * - 无论成功与否都写审计（处罚类动作没有审计就等于没有）。
 */

export type AccountRiskAction =
  | "mark_watch"
  | "restrict"
  | "require_step_up"
  | "suspend"
  | "unban"
  | "clear_flags";

export interface ApplyAccountRiskActionInput {
  userId: string;
  action: AccountRiskAction;
  /** 必填：写给用户看的理由与写给审计的依据都取它。 */
  reason: string;
  /** 操作人 id；自动判定传 "auto"。 */
  operatorId: string;
  /** 绝对到期时间（ms），与 durationHours 二选一。 */
  until?: number;
  /** 相对时长（小时），与 until 二选一。 */
  durationHours?: number;
  /** 逐步验证范围（仅 restrict / require_step_up 用）。 */
  stepUpMode?: "sensitive" | "all-writes" | "all";
}

export type ApplyAccountRiskActionResult =
  | { ok: true; action: AccountRiskAction; fromTier: AccountRiskTier; toTier: AccountRiskTier; stepUpUntil: number }
  | { ok: false; error: string; code: string };

function resolveUntil(input: ApplyAccountRiskActionInput, now: number): number {
  if (typeof input.until === "number" && Number.isFinite(input.until) && input.until > now) return input.until;
  if (typeof input.durationHours === "number" && Number.isFinite(input.durationHours) && input.durationHours > 0) {
    return now + input.durationHours * 60 * 60 * 1000;
  }
  return computeStepUpUntil(config.accountRisk, now);
}

export async function applyAccountRiskAction(
  input: ApplyAccountRiskActionInput,
): Promise<ApplyAccountRiskActionResult> {
  const now = Date.now();
  const { userId, action, reason, operatorId } = input;

  if (!userId) return { ok: false, error: "缺少用户 ID", code: "INVALID_TARGET" };
  if (!reason || !reason.trim()) return { ok: false, error: "必须提供处罚理由", code: "REASON_REQUIRED" };

  const state = await getAccountRiskState(userId);
  if (!state) return { ok: false, error: "用户不存在", code: "TARGET_NOT_FOUND" };

  const fromTier: AccountRiskTier = state.riskTier ?? "normal";
  const patch: Partial<UserType> = {
    flaggedBy: operatorId,
    flagReason: reason.trim().slice(0, 512),
    riskUpdatedAt: now,
  };
  let toTier: AccountRiskTier = fromTier;
  let stepUpUntil = state.stepUpUntil ?? 0;
  let revokeSessions = false;

  switch (action) {
    case "mark_watch": {
      toTier = tierRank(fromTier) >= tierRank("watch") ? fromTier : "watch";
      break;
    }
    case "restrict": {
      toTier = tierRank(fromTier) >= tierRank("restricted") ? fromTier : "restricted";
      stepUpUntil = resolveUntil(input, now);
      patch.stepUpMode = input.stepUpMode ?? state.stepUpMode ?? config.accountRisk.stepUpMode;
      break;
    }
    case "require_step_up": {
      // 不动档位，只把「每次操作都要验」这个窗口签出来（可单独用于观察期）。
      stepUpUntil = resolveUntil(input, now);
      patch.stepUpMode = input.stepUpMode ?? state.stepUpMode ?? config.accountRisk.stepUpMode;
      break;
    }
    case "suspend": {
      if (state.role === "superadmin") {
        // 封停超管必须走专用路径（安全会话 + 双人确认），否则本出口就是一条提权捷径。
        return { ok: false, error: "不允许通过风险出口封停超级管理员", code: "TARGET_IS_SUPERADMIN" };
      }
      if (state.accountStatus === "suspended") {
        return { ok: false, error: "账户已经是封停状态", code: "ALREADY_SUSPENDED" };
      }
      patch.accountStatus = "suspended";
      // 封停后 step-up 窗口无意义：会话都撤了，留下它只会让后续判定自相矛盾。
      patch.stepUpUntil = 0;
      stepUpUntil = 0;
      revokeSessions = true;
      break;
    }
    case "unban": {
      patch.accountStatus = "active";
      patch.riskTier = "normal";
      patch.riskFlags = [];
      patch.riskScore = 0;
      patch.stepUpUntil = 0;
      toTier = "normal";
      stepUpUntil = 0;
      break;
    }
    case "clear_flags": {
      patch.riskFlags = [];
      patch.riskScore = 0;
      patch.stepUpUntil = 0;
      stepUpUntil = 0;
      break;
    }
    default:
      return { ok: false, error: "不支持的风险动作", code: "UNSUPPORTED_ACTION" };
  }

  if (action !== "unban" && action !== "clear_flags" && toTier !== fromTier) {
    patch.riskTier = toTier;
  }
  if (action === "restrict" || action === "require_step_up") {
    patch.stepUpUntil = stepUpUntil;
  }

  try {
    await updateUser(userId, patch);
  } catch (error) {
    logger.error("[AccountRisk] 风险动作写回失败", {
      userId,
      action,
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, error: "写入失败", code: "WRITE_FAILED" };
  }

  if (revokeSessions) {
    try {
      await revokeAllAuthSessions(userId);
    } catch (error) {
      // 会话撤销失败不能把已落库的封停回滚：漏撤的会话会由 assertActiveAuthSession 的
      // 账户状态检查拦下，但必须告警（否则没人知道有残留会话）。
      logger.error("[AccountRisk] 封停后撤销存量会话失败，需人工核查", {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // RC-19.4：账户级处罚要**联动 API Key**，而不是让管理员逐个手工处理。
  // 映射：受限 → 降速；封停/危险 → 暂停全部 Key；解除/清旗标 → 恢复。
  // 失败只告警：Key 状态是次要处罚面，不能因为它让主处罚（已落库）看起来失败。
  try {
    if (action === "restrict") {
      await setApiKeyPenalty({
        userId,
        status: "throttled",
        reason: reason.trim().slice(0, 200),
        source: `account-risk:${toTier}`,
        durationHours: Math.max(1, Math.round((stepUpUntil - now) / (60 * 60 * 1000))),
      });
    } else if (action === "suspend") {
      await setApiKeyPenalty({
        userId,
        status: "suspended",
        reason: reason.trim().slice(0, 200),
        source: "account-risk:suspended",
      });
    } else if (action === "unban" || action === "clear_flags") {
      await setApiKeyPenalty({
        userId,
        status: "active",
        reason: reason.trim().slice(0, 200),
        source: `account-risk:${action}`,
      });
    }
  } catch (error) {
    logger.error("[AccountRisk] 联动 API Key 处罚失败，需人工核查", {
      userId,
      action,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  await recordAccountRiskEvent({
    userId,
    fromTier,
    toTier,
    assessment: {
      riskScore: typeof patch.riskScore === "number" ? patch.riskScore : state.riskScore ?? 0,
      riskTier: toTier,
      cappedTier: toTier,
      flags: patch.riskFlags ?? state.riskFlags ?? [],
      reasons: [reason.trim()],
    },
    reason,
    exempt: false,
    action,
    operatorId,
  });

  await writeRiskActionAudit({ userId, action, reason, operatorId, fromTier, toTier, stepUpUntil });

  logger.info("[AccountRisk] 风险动作已执行", { userId, action, operatorId, fromTier, toTier, stepUpUntil });
  return { ok: true, action, fromTier, toTier, stepUpUntil };
}

async function writeRiskActionAudit(params: {
  userId: string;
  action: AccountRiskAction;
  reason: string;
  operatorId: string;
  fromTier: AccountRiskTier;
  toTier: AccountRiskTier;
  stepUpUntil: number;
}): Promise<void> {
  const isAuto = params.operatorId === "auto";
  try {
    await AuditLogService.log({
      userId: isAuto ? "system" : params.operatorId,
      username: isAuto ? "system" : params.operatorId,
      role: isAuto ? "system" : "admin",
      action: `security.account-risk.${params.action}`,
      module: "security",
      targetId: params.userId,
      result: "success",
      detail: {
        fromTier: params.fromTier,
        toTier: params.toTier,
        stepUpUntil: params.stepUpUntil,
        reason: params.reason,
        source: isAuto ? "auto" : "admin",
      },
      ip: "",
    });
  } catch (error) {
    logger.warn("[AccountRisk] 风险动作审计写入失败", {
      userId: params.userId,
      action: params.action,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * RC-14：已登录请求 / API Key 路径命中 **机房（IDC）出口**时的升档。
 *
 * 为什么必须收在一个函数里：审计要求「出现 IDC 出口 → 升档 + API Key 降速/吊销」，
 * 而登录后复查（`accountStepUpGuard`）与 API Key 鉴权（`apiKeyAuth`）是两条独立链路。
 * 两处各写一份处罚逻辑，迟早会出现「网页端升了、API 端没升」或绕过 `autoEscalationCap`。
 * 本函数是这条判据的**唯一落点**，处罚本身仍走 `applyAccountRiskAction`（RC-07 的唯一出口）。
 *
 * 观察期口径（§5 B7 Shadow Mode）：整个函数由 `accountRisk.ipRecheckEnabled` 控制，
 * **默认关**。关闭时不做缓存读取、不写信号、不升档 —— 行为与改动前逐字节一致。
 *
 * 为什么永远不会封号：动作只可能是 `mark_watch` / `restrict`（见
 * `resolveIdcEscalationAction`）。`restrict` 的副作用是 step-up 窗口 + 该账户全部
 * API Key 降速（RC-19.4），不会 `suspend`；封停仍必须人工经 RC-07 执行。
 */
export interface IdcEgressRiskInput {
  userId: string;
  ipAddress: string;
  /** 调用方已取得的缓存结论；缺省时本函数自己读一次缓存（绝不外呼）。 */
  ipRisk?: IpRiskResult | null;
  source: "logged_in_request" | "api_key";
  userAgent?: string;
  fingerprint?: string;
}

export interface IdcEgressRiskResult {
  detected: boolean;
  exempt: boolean;
  action: "mark_watch" | "restrict" | null;
  /** 稳定原因码：disabled / throttled / no-cached-verdict / not-idc / cap-reached / escalated / ... */
  reason: string;
}

/** 同一账户的 IDC 复查频率：与 `accountStepUpGuard` 的 5 分钟口径一致，避免每请求查库。 */
const IDC_RECHECK_INTERVAL_MS = 5 * 60 * 1000;
const IDC_RECHECK_MAX_ENTRIES = 10_000;
const idcRecheckAt = new Map<string, number>();

export async function handleIdcEgressRisk(input: IdcEgressRiskInput): Promise<IdcEgressRiskResult> {
  const cfg = config.accountRisk;
  const idle = (reason: string): IdcEgressRiskResult => ({ detected: false, exempt: false, action: null, reason });

  if (!cfg.enabled || !cfg.ipRecheckEnabled) return idle("disabled");
  if (!input.userId || !input.ipAddress || input.ipAddress === "unknown") return idle("missing-context");
  if (!mongoReady()) return idle("mongo-unavailable");

  const now = Date.now();
  const last = idcRecheckAt.get(input.userId) ?? 0;
  if (now - last < IDC_RECHECK_INTERVAL_MS) return idle("throttled");
  // 有界 Map：账号数增长时不能让它变成内存泄漏；清空只会让下一轮多做一次缓存读取。
  if (idcRecheckAt.size >= IDC_RECHECK_MAX_ENTRIES) idcRecheckAt.clear();
  idcRecheckAt.set(input.userId, now);

  const risk = input.ipRisk ?? (await getCachedIpRisk(input.ipAddress).catch(() => null));
  if (!risk) return idle("no-cached-verdict");

  const datacenter = isDatacenterEgress({
    hosting: risk.detections?.hosting,
    flags: risk.flags,
    networkType: risk.networkType,
  });
  if (!datacenter) return idle("not-idc");

  const state = await getAccountRiskState(input.userId).catch(() => null);
  if (!state) return idle("target-not-found");
  // 已软删除的账户不再产生处罚动作（认证层已拒绝它；再写只会污染事件表）。
  if (typeof state.deletedAt === "number" && state.deletedAt > 0) return idle("target-deleted");
  if (isRiskExempt({ role: state.role })) {
    noteRiskExemption({
      userId: input.userId,
      scope: "crossModule",
      detail: { signal: "IDC_EGRESS", source: input.source, risk: risk.risk },
    });
    return { detected: true, exempt: true, action: null, reason: "superadmin-exempt" };
  }

  // 先留证据再动档位：即使后面的写库失败，也能从事件表回答「当时的出口是什么」。
  recordAccountAbuseSignal({
    userId: input.userId,
    eventType: "ACCOUNT_ABUSE_IDC_EGRESS",
    fingerprint: input.fingerprint || `idc-egress:${input.source}`,
    action: input.source,
    reason: `已认证路径出现机房/IDC 出口（风险分 ${risk.risk}）`,
    riskScore: risk.risk,
    flags: risk.flags,
    ipAddress: input.ipAddress,
    userAgent: input.userAgent,
  });

  const action = resolveIdcEscalationAction(state.riskTier ?? "normal", cfg.autoEscalationCap);
  if (!action) return { detected: true, exempt: false, action: null, reason: "cap-reached" };

  const result = await applyAccountRiskAction({
    userId: input.userId,
    action,
    reason: `[自动] ${input.source === "api_key" ? "API Key" : "已登录"}请求命中机房/IDC 出口（风险分 ${risk.risk}）`,
    operatorId: "auto",
  });
  return {
    detected: true,
    exempt: false,
    action: result.ok ? action : null,
    reason: result.ok ? "escalated" : result.code,
  };
}

/**
 * RC-38：给**通道级**拦截点用的统一判定（工单 / CDK 兑换 / 文件上传 / 算力 / LibreChat）。
 *
 * 消费方只需要 `const d = await getAccountRiskChannelDecision({userId, channel}); if (d.locked) ...`
 * 并按 `d.code` 回 `403`，**不要**再自己拼一套禁令（否则又回到「各模块各自一套处罚体系」）。
 * 映射表在 `accountRiskScoring.resolveAccountRiskChannelDecision`，那里同时钉住了 RC-61 的
 * 相邻边界（`channel_local` 不跨通道）。
 *
 * 读库失败时 fail-open 到「不锁定」：账户封停（`accountStatus`）由认证层独立强制，不会因
 * 这里降级而漏放；反过来在此 fail-closed 会让一次 Mongo 抖动把所有高成本功能全停掉。
 */
export async function getAccountRiskChannelDecision(input: {
  userId: string;
  channel: AccountRiskChannel;
  source?: AccountRiskChannelSource;
}): Promise<AccountRiskChannelDecision> {
  if (!mongoReady() || !input.userId) {
    return resolveAccountRiskChannelDecision({
      tier: "normal",
      channel: input.channel,
      source: input.source,
    });
  }

  const state = await getAccountRiskState(input.userId).catch(() => null);
  return resolveAccountRiskChannelDecision({
    tier: state?.riskTier ?? "normal",
    channel: input.channel,
    source: input.source,
    exempt: isRiskExempt({ role: state?.role }),
  });
}

/**
 * RC-57：记录一次**早期自动化痕迹**（`navigator.webdriver` / UA-CH 缺失）。
 *
 * 与 `ACCOUNT_ABUSE_*` 分开写：后者按件计入滥用事件分，而自动化痕迹在评分层只有固定
 * 8 分权重（`AUTOMATION_HINT`）且单独不足以升档。混用会让一条可伪造的客户端信号
 * 获得与「已认证账户违规拦截」相同的计分能力。
 *
 * 24 小时去重：指纹上报本身被前端节流到 5 分钟一次，不去重会把它写成噪声。
 */
export interface AutomationTraceSignalInput {
  userId: string;
  /** 命中的判据名（来自 `detectAutomationTrace`）。 */
  signals: readonly string[];
  /** 原始痕迹（只落事件，不进评分），用于事后判断是哪个浏览器版本。 */
  traces?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
  fingerprint?: string;
}

const AUTOMATION_TRACE_DEDUPE_MS = 24 * 60 * 60 * 1000;

export async function recordAutomationTraceSignal(input: AutomationTraceSignalInput): Promise<void> {
  if (!input.userId || input.signals.length === 0 || !mongoReady()) return;
  try {
    const since = new Date(Date.now() - AUTOMATION_TRACE_DEDUPE_MS);
    const existing = await SecurityEvent.findOne({
      userId: input.userId,
      eventType: AUTOMATION_TRACE_EVENT,
      createdAt: { $gte: since },
    })
      .select("_id")
      .lean();
    if (existing) return;

    await SecurityEvent.create({
      deviceFingerprint: String(input.fingerprint || "automation-trace").slice(0, 256),
      userId: input.userId,
      eventType: AUTOMATION_TRACE_EVENT,
      eventData: {
        signals: input.signals.slice(0, 16),
        traces: input.traces ?? {},
        note: "客户端上报信号，仅作加权，不作为封禁判据",
      },
      riskScore: 0,
      ipAddress: String(input.ipAddress || "").slice(0, 128),
      userAgent: String(input.userAgent || "").slice(0, 512),
      createdAt: new Date(),
    });
  } catch (error) {
    logger.warn("[AccountRisk] 自动化痕迹写入失败（不影响主流程）", {
      userId: input.userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** 供管理端确认「是否最后一个超管」等前置检查使用（与 adminController.isLastSuperadmin 同源事实）。 */
export async function countSuperadmins(): Promise<number> {
  if (!mongoReady()) return 0;
  try {
    return await UserModel.countDocuments({ role: "superadmin" }).exec();
  } catch (error) {
    logger.warn("[AccountRisk] 超管数量查询失败", {
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }
}

/**
 * 账户级滥用信号的**唯一写入入口**（RC-10 / RC-20）。
 *
 * 为什么要收成一个函数：账户聚合（`evaluateAccountRisk`）按 `ACCOUNT_ABUSE_*` **前缀**计数，
 * 前缀是唯一契约 —— 让各调用点各自拼 eventType，早晚会出现 `ABUSE_ACCOUNT_*`、
 * `ACCOUNT_BLOCKED` 这类拼法，聚合就会静默漏掉它们（表现为“拦了但风险分不动”）。
 *
 * 写入失败只记日志：滥用信号是增强信息，不能因为审计表写不进去把已决定的拒绝变成 500。
 */
export interface AccountAbuseSignalInput {
  userId?: string;
  /** 必须带 `ACCOUNT_ABUSE_` 前缀；未传时用 `ACCOUNT_ABUSE_UNSPECIFIED`。 */
  eventType?: string;
  /** 设备指纹（实例化时若没有，用调用点标识，如 "step-up"）。 */
  fingerprint?: string;
  action?: string;
  reason?: string;
  riskScore?: number;
  flags?: readonly string[];
  ipAddress?: string;
  userAgent?: string;
  /**
   * RC-20：信号来自**未认证**路径（登录前人机验证失败）。
   *
   * 这类事件会被 `evaluateAccountRiskScore` 按半权重计分且总额封顶 10 分，
   * 因此单靠它们连 `watch` 阈值都到不了，更不会成为封禁依据（匿名路径不得升级为封禁）。
   */
  anonymous?: boolean;
  /**
   * RC-20：只有当该 `(userId, ipAddress)` 在 `account_ip_signals` 里出现过（即这个出口
   * 确实属于该账户）时才写信号。
   *
   * 登录前链路只能拿到 identifier，拿不到可信的 userId；不设这道门槛，任何人都能拿别人的
   * 用户名反复失败人机验证，把对方的风险分当玩具。查不到历史出口 ⇒ **不写**（fail-closed
   * 到「不归因」）。
   */
  requireKnownIp?: boolean;
}

/** 匿名信号写入去重：同一 (userId, eventType) 在窗口内只写一条，避免把安全事件表写成噪声。 */
const anonymousSignalThrottle = new Map<string, number>();

function shouldSkipAnonymousSignal(userId: string, eventType: string, now: number): boolean {
  const key = `${userId}|${eventType}`;
  const last = anonymousSignalThrottle.get(key) ?? 0;
  if (now - last < ANONYMOUS_SIGNAL_DEDUPE_MS) return true;
  if (anonymousSignalThrottle.size >= 10_000) anonymousSignalThrottle.clear();
  anonymousSignalThrottle.set(key, now);
  return false;
}

export function recordAccountAbuseSignal(input: AccountAbuseSignalInput): void {
  if (!mongoReady()) return;
  // 归因闸没有 userId 就没有可归因的对象；缺了它再用 `{userId: undefined}` 去查，
  // Mongoose 会把它从过滤条件里丢掉 —— 那就变成「按 IP 找任意账户」，正好制造误归因。
  if (input.requireKnownIp && !input.userId) return;
  const eventType =
    typeof input.eventType === "string" && input.eventType.startsWith(ACCOUNT_ABUSE_EVENT_PREFIX)
      ? input.eventType
      : `${ACCOUNT_ABUSE_EVENT_PREFIX}_UNSPECIFIED`;

  const now = Date.now();
  if (input.anonymous && input.userId && shouldSkipAnonymousSignal(input.userId, eventType, now)) return;

  const userId = input.userId || undefined;
  const ipAddress = input.ipAddress || "";

  const write = () => {
    void SecurityEvent.create({
      deviceFingerprint: String(input.fingerprint || "account-abuse").slice(0, 256),
      userId,
      eventType,
      eventData: {
        action: input.action,
        reason: input.reason,
        flags: Array.isArray(input.flags) ? input.flags.slice(0, 32) : undefined,
        // 显式写 false 而不是缺省：聚合按 `eventData.anonymous === true` 分流，
        // 缺省也能落到「已认证」一侧，但显式值让存量/新数据的口径一眼可读。
        anonymous: Boolean(input.anonymous),
      },
      riskScore: typeof input.riskScore === "number" && Number.isFinite(input.riskScore) ? input.riskScore : 0,
      ipAddress,
      userAgent: String(input.userAgent || "").slice(0, 512),
      createdAt: new Date(),
    }).catch((error) => {
      logger.warn("[AccountRisk] 账户滥用信号写入失败", {
        userId,
        eventType,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };

  if (!input.requireKnownIp) {
    write();
    return;
  }

  // 归因前置条件：该出口必须曾作为该账户的登录/使用 IP 出现过。
  // 查询失败一律不写（宁可漏一条信号，也不接受可被他人触发的归因）。
  void (async () => {
    try {
      const known = await AccountIpSignal.exists({ userId: input.userId, ipAddress }).exec();
      if (!known) return;
      write();
    } catch (error) {
      logger.debug("[AccountRisk] 匿名 Abuse 信号归因检查失败（不写信号）", {
        userId: input.userId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();
}
