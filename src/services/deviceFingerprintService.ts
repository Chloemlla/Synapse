import { DeviceFingerprint, type IDeviceFingerprint } from "../models/deviceFingerprintModel";
import { SecurityEvent } from "../models/securityEventModel";
import logger from "../utils/logger";
import {
  hasFingerprintComponentDrift,
  normalizeFingerprintComponents,
  type FingerprintComponentHashes,
} from "../utils/fingerprintComponents";
import { mongoose } from "./mongoService";

/**
 * 设备指纹分量的事实沉淀与信号分析（RC-16）。
 *
 * 两条互相独立的职责：
 * 1. **沉淀**：指纹上报时按 `(userId, fingerprintId)` upsert 分量摘要，并在分量发生变化时
 *    记一次漂移（保留「上一次的值」用于事后解释）。**只写事件与事实，不做任何处罚**。
 * 2. **分析**：`analyzeFingerprintSignals` 读事实，产出两路信号：
 *    - `FP_COMPONENT_DRIFT`：同一 `fingerprintId` 的 `can`/`wgl` 分量变了（换浏览器沙箱 / 伪装 / 无头环境）；
 *    - `FP_SHARED_ACROSS_ACCOUNTS`：同一 WebGL 分量 hash 在 ≥2 个账户出现（同一硬件多账号，比 IP 可靠）。
 *
 * 与账户风险的接线（重要）：
 * - 信号本身**不是**评分旗标。评分层只认两个新旗标：`ACCOUNT_SHARING_SUSPECTED`（由
 *   `accountRiskService` 聚合三条件联立 + 跨账户共用得出）与既有的 `AUTOMATION_HINT`
 *  （分量漂移作为自动化痕迹的加权信号）；本模块只把 `FP_*` 写成 `security_events` 供调查与聚合读取。
 * - 因此这里可以放心地被登录/上报热路径调用：写入失败只记日志，绝不影响主流程。
 */

/** 分量漂移事件类型（`security_events.eventType`）。 */
export const FP_COMPONENT_DRIFT_EVENT = "FP_COMPONENT_DRIFT";
/** 跨账户共用分量事件类型（`security_events.eventType`）。 */
export const FP_SHARED_ACROSS_ACCOUNTS_EVENT = "FP_SHARED_ACROSS_ACCOUNTS";

const MAX_FINGERPRINT_ID_LENGTH = 200;
const MAX_IPS_PER_FINGERPRINT = 20;
/** 单账户参与分析的指纹条数上限：只取最近出现的那些，避免老设备把排序拖到内存。 */
const MAX_FINGERPRINTS_PER_USER = 50;
/** 同一 (userId, eventType) 的事件去重窗口：上报被节流到 5 分钟一次，没有去重会写爆安全事件表。 */
const EVENT_DEDUPE_MS = 24 * 60 * 60 * 1000;

export interface DeviceFingerprintSignalFacts {
  /** 该账户台账里的指纹条数。 */
  fingerprintCount: number;
  /** 是否有任一指纹出现分量漂移。 */
  componentDrift: boolean;
  /** 发生漂移的 `fingerprintId` 列表（管理端可下钻）。 */
  driftFingerprintIds: string[];
  /** 是否有分量 hash 同时出现在其他账户上（同一硬件多账号）。 */
  sharedAcrossAccounts: boolean;
  /** 命中跨账户共用的本账户 `fingerprintId` 列表。 */
  sharedFingerprintIds: string[];
  /** 命中的分量 hash（WebGL 优先，供调查比对）。 */
  sharedComponentHashes: string[];
}

const EMPTY_FACTS: DeviceFingerprintSignalFacts = {
  fingerprintCount: 0,
  componentDrift: false,
  driftFingerprintIds: [],
  sharedAcrossAccounts: false,
  sharedFingerprintIds: [],
  sharedComponentHashes: [],
};

/** Mongo 就绪探针：与 accountRiskService 同口径（只探就绪，不在这里建连）。 */
function mongoReady(): boolean {
  return mongoose.connection.readyState === 1;
}

function normalizeUserId(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 200) : "";
}

function normalizeFingerprintId(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, MAX_FINGERPRINT_ID_LENGTH) : "";
}

function normalizeSource(value: unknown): string {
  const trimmed = typeof value === "string" ? value.trim().slice(0, 64) : "";
  return trimmed || "fingerprint_report";
}

function normalizeIp(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 128) : "";
}

export interface RecordDeviceFingerprintInput {
  userId: string;
  fingerprintId: string;
  /** 原始分量（来自请求 body，本函数内部规范化；非法/缺失的分量会被丢弃）。 */
  components?: unknown;
  ipAddress?: string;
  source?: string;
}

export interface RecordDeviceFingerprintResult {
  recorded: boolean;
  /** 本次是否检测到分量漂移（调用方可据此立刻触发一次账户风险聚合）。 */
  driftDetected: boolean;
}

/**
 * 记录一次指纹事实（幂等 upsert）。
 *
 * `seenCount` / `driftCount` 用 `$inc`：同一账户多端并发上报时读改写会互相覆盖计数，
 * 而计数正是「漂移次数」判据的事实来源。
 */
export async function recordDeviceFingerprint(
  input: RecordDeviceFingerprintInput,
): Promise<RecordDeviceFingerprintResult> {
  const userId = normalizeUserId(input.userId);
  const fingerprintId = normalizeFingerprintId(input.fingerprintId);
  if (!userId || !fingerprintId) return { recorded: false, driftDetected: false };
  if (!mongoReady()) return { recorded: false, driftDetected: false };

  const components = normalizeFingerprintComponents(input.components);
  const now = new Date();

  try {
    let previous: FingerprintComponentHashes | null = null;
    try {
      const existing = (await DeviceFingerprint.findOne({ userId, fingerprintId })
        .select("componentHashes")
        .lean()) as { componentHashes?: FingerprintComponentHashes } | null;
      previous = existing?.componentHashes ?? null;
    } catch (error) {
      // 读旧值失败不影响写入（漂移这次先不判，下一次上报仍能补上）。
      logger.debug("[DeviceFingerprint] 读取既有分量失败（跳过本次漂移判定）", {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const driftDetected = components ? hasFingerprintComponentDrift(previous, components) : false;

    const setPatch: Record<string, unknown> = { lastSeenAt: now };
    if (components) setPatch.componentHashes = components;
    if (driftDetected && components) {
      setPatch.previousComponentHashes = previous;
      setPatch.lastDriftAt = now;
    }

    const ip = normalizeIp(input.ipAddress);
    const hasIp = Boolean(ip) && ip !== "unknown";

    await DeviceFingerprint.updateOne(
      { userId, fingerprintId },
      {
        $set: setPatch,
        $setOnInsert: { firstSeenAt: now },
        $inc: { seenCount: 1, ...(driftDetected ? { driftCount: 1 } : {}) },
        // `sources` 取值有限（如实上报来源标识），用 `$addToSet` 去重。
        $addToSet: { sources: { $each: [normalizeSource(input.source)] } },
        // `ips` 会被同一台设备在换网/换出口时反复写入，必须限长。
        // 注意：`$slice` 只能配 `$push`（`$addToSet` 不支持 `$slice`），因此这里保留“最近 20 次”
        // 而不是“最近 20 个不同 IP”——取证时看得到时序，代价是重复 IP 占位，可接受。
        ...(hasIp ? { $push: { ips: { $each: [ip], $slice: -MAX_IPS_PER_FINGERPRINT } } } : {}),
      },
      { upsert: true },
    ).exec();

    if (driftDetected) {
      logger.info("[DeviceFingerprint] 检测到指纹分量漂移", { userId, fingerprintId: fingerprintId.slice(0, 8) });
    }

    return { recorded: true, driftDetected };
  } catch (error) {
    // 记录失败不能影响上报主流程：指纹是增强证据，不是请求的前置条件。
    logger.warn("[DeviceFingerprint] 记录失败（不影响主流程）", {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { recorded: false, driftDetected: false };
  }
}

/**
 * 读取该账户的指纹风险事实（**只读**，不写事件）。
 *
 * 跨账户比对用一次聚合完成：把本账户的 WebGL 分量 hash 作为 `$in`，按 hash 分组收集
 * 其他账户的 userId。逐 hash 发查询会在登录热路径上放大成 N 次往返。
 *
 * 说明：`wgl` 分量由 vendor + renderer + 参数集合哈希而来，同型号设备会撞同一 hash。
 * 因此「跨账户共用」只作为**共享账号嫌疑的一路信号**（配合设备数/地区数/并发会话），
 * 绝不单独作为处罚判据。
 */
export async function loadDeviceFingerprintFacts(userId: string): Promise<DeviceFingerprintSignalFacts> {
  const safeUserId = normalizeUserId(userId);
  if (!safeUserId || !mongoReady()) return EMPTY_FACTS;

  try {
    const rows = (await DeviceFingerprint.find({ userId: safeUserId })
      .select("fingerprintId componentHashes.wgl componentHashes.can driftCount")
      .sort({ lastSeenAt: -1 })
      .limit(MAX_FINGERPRINTS_PER_USER)
      .lean()) as Array<{
      fingerprintId?: string;
      componentHashes?: { wgl?: string; can?: string };
      driftCount?: number;
    }>;

    const driftFingerprintIds: string[] = [];
    const hashToFingerprintIds = new Map<string, string[]>();
    for (const row of rows) {
      const fingerprintId = normalizeFingerprintId(row.fingerprintId);
      if (!fingerprintId) continue;
      if ((row.driftCount ?? 0) > 0) driftFingerprintIds.push(fingerprintId);

      const wgl = typeof row.componentHashes?.wgl === "string" ? row.componentHashes.wgl.trim() : "";
      const can = typeof row.componentHashes?.can === "string" ? row.componentHashes.can.trim() : "";
      for (const hash of [wgl, can]) {
        if (!hash) continue;
        const list = hashToFingerprintIds.get(hash) ?? [];
        list.push(fingerprintId);
        hashToFingerprintIds.set(hash, list);
      }
    }

    const componentHashes = [...hashToFingerprintIds.keys()];
    const sharedComponentHashes: string[] = [];
    if (componentHashes.length > 0) {
      // 同时按 wgl / can 反查其他账户；一个 hash 命中 ≥1 个其他 userId 即算跨账户共用。
      const groups = (await DeviceFingerprint.aggregate([
        {
          $match: {
            userId: { $ne: safeUserId },
            $or: [
              { "componentHashes.wgl": { $in: componentHashes } },
              { "componentHashes.can": { $in: componentHashes } },
            ],
          },
        },
        {
          $group: {
            _id: null,
            wgl: { $addToSet: "$componentHashes.wgl" },
            can: { $addToSet: "$componentHashes.can" },
          },
        },
      ]).exec()) as Array<{ wgl?: string[]; can?: string[] }>;

      const row = groups[0];
      const otherHashes = new Set<string>(
        [...(row?.wgl ?? []), ...(row?.can ?? [])].filter((value): value is string => Boolean(value)),
      );
      for (const hash of componentHashes) {
        if (otherHashes.has(hash)) sharedComponentHashes.push(hash);
      }
    }

    const sharedFingerprintIds = new Set<string>();
    for (const hash of sharedComponentHashes) {
      for (const fingerprintId of hashToFingerprintIds.get(hash) ?? []) {
        sharedFingerprintIds.add(fingerprintId);
      }
    }

    return {
      fingerprintCount: rows.length,
      componentDrift: driftFingerprintIds.length > 0,
      driftFingerprintIds,
      sharedAcrossAccounts: sharedComponentHashes.length > 0,
      sharedFingerprintIds: [...sharedFingerprintIds],
      sharedComponentHashes,
    };
  } catch (error) {
    logger.warn("[DeviceFingerprint] 指纹信号读取失败（按无信号处理）", {
      userId: safeUserId,
      error: error instanceof Error ? error.message : String(error),
    });
    return EMPTY_FACTS;
  }
}

export interface FingerprintAnalysisResult {
  componentDrift: boolean;
  sharedAcrossAccounts: boolean;
  /** 本次命中的指纹级信号（写入 `security_events`，供调查与聚合读取）。 */
  flags: Array<typeof FP_COMPONENT_DRIFT_EVENT | typeof FP_SHARED_ACROSS_ACCOUNTS_EVENT>;
  driftFingerprintIds: string[];
  sharedFingerprintIds: string[];
}

/**
 * 分析该账户的指纹信号，并按需要把 `FP_*` 事件写进 `security_events`。
 *
 * 事件按 `(userId, eventType)` **24 小时去重**：指纹上报本身已被前端节流到 5 分钟一次，
 * 若每次分析都写事件，一个长期漂移的账户一天会写近 300 条同类事件，把安全事件表变成噪声。
 */
export async function analyzeFingerprintSignals(
  userId: string,
  options: { writeEvents?: boolean } = {},
): Promise<FingerprintAnalysisResult> {
  const facts = await loadDeviceFingerprintFacts(userId);
  const flags: FingerprintAnalysisResult["flags"] = [];
  if (facts.componentDrift) flags.push(FP_COMPONENT_DRIFT_EVENT);
  if (facts.sharedAcrossAccounts) flags.push(FP_SHARED_ACROSS_ACCOUNTS_EVENT);

  if (options.writeEvents !== false && flags.length > 0 && mongoReady()) {
    const safeUserId = normalizeUserId(userId);
    if (facts.componentDrift) {
      await writeFingerprintEvent(safeUserId, FP_COMPONENT_DRIFT_EVENT, {
        fingerprintIds: facts.driftFingerprintIds.slice(0, 20),
        reason: "同一指纹 id 的 Canvas/WebGL 分量发生变化（换浏览器沙箱 / 伪装 / 无头环境）",
      });
    }
    if (facts.sharedAcrossAccounts) {
      await writeFingerprintEvent(safeUserId, FP_SHARED_ACROSS_ACCOUNTS_EVENT, {
        fingerprintIds: facts.sharedFingerprintIds.slice(0, 20),
        componentHashes: facts.sharedComponentHashes.slice(0, 20),
        reason: "同一设备分量在多个账户出现（同一硬件多账号）",
      });
    }
  }

  return {
    componentDrift: facts.componentDrift,
    sharedAcrossAccounts: facts.sharedAcrossAccounts,
    flags,
    driftFingerprintIds: facts.driftFingerprintIds,
    sharedFingerprintIds: facts.sharedFingerprintIds,
  };
}

async function writeFingerprintEvent(
  userId: string,
  eventType: string,
  eventData: Record<string, unknown>,
): Promise<void> {
  if (!userId) return;
  try {
    const since = new Date(Date.now() - EVENT_DEDUPE_MS);
    const existing = await SecurityEvent.findOne({ userId, eventType, createdAt: { $gte: since } })
      .select("_id")
      .lean();
    if (existing) return;

    await SecurityEvent.create({
      deviceFingerprint: "device-fingerprint",
      userId,
      eventType,
      eventData: { ...eventData, source: "device_fingerprint" },
      riskScore: 0,
      ipAddress: "",
      userAgent: "",
      createdAt: new Date(),
    });
  } catch (error) {
    // 事件写入失败不影响聚合与主流程。
    logger.warn("[DeviceFingerprint] 指纹信号事件写入失败", {
      userId,
      eventType,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** 仅测试/管理端使用：把事实投影成 `IDeviceFingerprint` 的关键字段，避免调用方依赖完整文档形状。 */
export type DeviceFingerprintRow = Pick<
  IDeviceFingerprint,
  "userId" | "fingerprintId" | "componentHashes" | "firstSeenAt" | "lastSeenAt" | "driftCount" | "ips"
>;
