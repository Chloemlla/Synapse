import type { Request, Response } from "express";
import { isAdminRole } from "../middleware/auth";
import { escapeRegexLiteral } from "../utils/regexEscape";
import { DeviceTracking } from "../models/deviceTrackingModel";
import { SecurityEvent } from "../models/securityEventModel";
import {
  detectAnomalies,
  extractSecurityHeaders,
  getDeviceStatus,
  getPublicReportAction,
  getRiskStrategy,
  incrementBlockedCount,
  recordSecurityEvent,
  trackDevice,
} from "../services/nexaiSecurityService";
import { getClientIP } from "../utils/ipUtils";
import { CLIENT_REPORTED_EVENT_TYPES, getSecurityCatalog } from "../services/nexaiSecurityCatalog";
import logger from "../utils/logger";

/**
 * 客户端可上报的事件类型。清单本身住在 `services/nexaiSecurityCatalog.ts`
 * （与中文名同一份事实源）——这里再抄一份的话，新增类型时面板与白名单必然漂。
 */
const ALLOWED_SECURITY_EVENT_TYPES = new Set<string>(CLIENT_REPORTED_EVENT_TYPES);

const MAX_EVENT_DETAILS_JSON_LENGTH = 4_000;

/** 列表页可选的时间窗（与 `/stats` 的 timeRange 同名同义，`all` = 不限）。 */
const TIME_RANGE_MS: Record<string, number> = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

/**
 * 把 `timeRange` 换成起始时间；`all`/缺失/非法值一律返回 null（= 不限时间）。
 *
 * 为什么不默认截到 24h：面板的列表页要回答「库里到底有哪些数据」，
 * 默认截到 24 小时会让半年前的事件无法被看到 —— 那正是「必须先手查」的老毛病。
 */
function resolveTimeRangeStart(value: unknown): Date | null {
  if (typeof value !== "string" || !value || value === "all") return null;
  const windowMs = TIME_RANGE_MS[value];
  return windowMs ? new Date(Date.now() - windowMs) : null;
}

function getRequestUserId(req: Request): string | undefined {
  return req.nexaiUser?.id || (req as any).user?.id;
}

/**
 * POST /nexai/security/report
 * Client reports security event
 */
export async function reportSecurityEvent(req: Request, res: Response): Promise<void> {
  try {
    const headers = extractSecurityHeaders(req);
    const { event_type, details, timestamp } = req.body;

    if (!headers.deviceFingerprint) {
      res.status(400).json({
        error: "Missing device fingerprint",
      });
      return;
    }

    if (!event_type || typeof event_type !== "string") {
      res.status(400).json({
        error: "Missing event_type",
      });
      return;
    }

    const normalizedEventType = event_type.trim().slice(0, 64);
    if (!ALLOWED_SECURITY_EVENT_TYPES.has(normalizedEventType)) {
      res.status(400).json({
        error: "Unsupported event_type",
      });
      return;
    }

    let safeDetails: Record<string, unknown> = {};
    if (details && typeof details === "object" && !Array.isArray(details)) {
      const serialized = JSON.stringify(details);
      if (serialized.length > MAX_EVENT_DETAILS_JSON_LENGTH) {
        res.status(400).json({
          error: "event details too large",
        });
        return;
      }
      safeDetails = details as Record<string, unknown>;
    }

    const userId = getRequestUserId(req);
    const ipAddress = getClientIP(req);
    const userAgent = req.headers["user-agent"] || "";

    // Record the security event. Client headers are telemetry only.
    await recordSecurityEvent(
      headers.deviceFingerprint,
      userId,
      normalizedEventType,
      safeDetails,
      headers.riskScore,
      ipAddress,
      userAgent,
    );

    // Track device if user is authenticated
    if (userId) {
      await trackDevice(userId, headers, ipAddress, userAgent);
    }

    // Unauthenticated clients cannot force BLOCK/HONEYPOT via self-reported headers.
    // Authenticated reports may still compute full strategy for operator telemetry only,
    // but destructive counter increments require authentication.
    let action: string = getPublicReportAction(headers);
    if (userId) {
      const strategy = getRiskStrategy(headers);
      if (strategy === "BLOCK") {
        action = "block";
        if (headers.deviceFingerprint) {
          await incrementBlockedCount(userId, headers.deviceFingerprint);
        }
      } else if (strategy === "HONEYPOT") {
        action = "honeypot";
      } else if (strategy === "RESTRICT") {
        action = "restrict";
      } else if (strategy === "MONITOR") {
        action = "monitor";
      } else {
        action = "monitor";
      }
    }

    logger.info(`Security event reported: ${normalizedEventType} from device ${headers.deviceFingerprint}, action: ${action}`);

    res.json({
      status: "recorded",
      action,
      message: action === "block" ? "Device has been flagged for security review" : "Event recorded successfully",
    });
  } catch (error) {
    logger.error("Error reporting security event:", error);
    res.status(500).json({
      error: "Internal server error",
    });
  }
}

/**
 * GET /nexai/security/status
 * Query device security status
 */
export async function getSecurityStatus(req: Request, res: Response): Promise<void> {
  try {
    const headers = extractSecurityHeaders(req);

    if (!headers.deviceFingerprint) {
      res.status(400).json({
        error: "Missing device fingerprint",
      });
      return;
    }

    const status = await getDeviceStatus(headers.deviceFingerprint);

    if (!status) {
      res.json({
        device_fingerprint: headers.deviceFingerprint,
        status: "unknown",
        risk_level: "SAFE",
        restrictions: [],
        message: "Device not found in database",
      });
      return;
    }

    res.json({
      device_fingerprint: headers.deviceFingerprint,
      status: status.status,
      risk_level: status.riskLevel,
      restrictions: status.restrictions,
      message: status.message,
    });
  } catch (error) {
    logger.error("Error getting security status:", error);
    res.status(500).json({
      error: "Internal server error",
    });
  }
}

/**
 * GET /nexai/security/anomalies
 * Check for anomalies (requires authentication)
 */
export async function checkAnomalies(req: Request, res: Response): Promise<void> {
  try {
    const headers = extractSecurityHeaders(req);
    const userId = getRequestUserId(req);

    if (!userId) {
      res.status(401).json({
        error: "Authentication required",
      });
      return;
    }

    if (!headers.deviceFingerprint) {
      res.status(400).json({
        error: "Missing device fingerprint",
      });
      return;
    }

    const anomalies = await detectAnomalies(headers.deviceFingerprint, userId);

    res.json({
      device_fingerprint: headers.deviceFingerprint,
      user_id: userId,
      anomalies: {
        multi_account: anomalies.multiAccount,
        frequent_device_switch: anomalies.frequentDeviceSwitch,
      },
      details: {
        account_count: anomalies.accountCount,
        device_count: anomalies.deviceCount,
      },
    });
  } catch (error) {
    logger.error("Error checking anomalies:", error);
    res.status(500).json({
      error: "Internal server error",
    });
  }
}

/**
 * POST /nexai/security/track
 * Manually track device (requires authentication)
 */
export async function trackDeviceManually(req: Request, res: Response): Promise<void> {
  try {
    const headers = extractSecurityHeaders(req);
    const userId = getRequestUserId(req);

    if (!userId) {
      res.status(401).json({
        error: "Authentication required",
      });
      return;
    }

    if (!headers.deviceFingerprint) {
      res.status(400).json({
        error: "Missing device fingerprint",
      });
      return;
    }

    const ipAddress = getClientIP(req);
    const userAgent = req.headers["user-agent"] || "";

    await trackDevice(userId, headers, ipAddress, userAgent);

    res.json({
      status: "tracked",
      device_fingerprint: headers.deviceFingerprint,
      risk_level: headers.riskLevel,
      risk_score: headers.riskScore,
      anti_debug: {
        adb: headers.isAdbEnabled,
        development_settings: headers.isDevelopmentSettingsEnabled,
        debug_build: headers.isDebugBuild,
        tracer: headers.isTracerAttached,
        score: headers.antiDebugScore,
      },
    });
  } catch (error) {
    logger.error("Error tracking device:", error);
    res.status(500).json({
      error: "Internal server error",
    });
  }
}

/**
 * GET /nexai/security/stats
 * Get dashboard statistics (requires admin authentication)
 */
export async function getDashboardStats(req: Request, res: Response): Promise<void> {
  try {

    const role = req.nexaiUser?.role || (req as any).user?.role;
    if (!isAdminRole(role)) {
      res.status(403).json({ error: "Admin access required" });
      return;
    }
    const timeRange = (req.query.timeRange as string) || "24h";
    const timeRangeMs: Record<string, number> = {
      "1h": 60 * 60 * 1000,
      "24h": 24 * 60 * 60 * 1000,
      "7d": 7 * 24 * 60 * 60 * 1000,
      "30d": 30 * 24 * 60 * 60 * 1000,
    };

    const startTime = new Date(Date.now() - (timeRangeMs[timeRange] || timeRangeMs["24h"]));

    const totalDevices = await DeviceTracking.countDocuments({});
    const highRiskDevices = await DeviceTracking.countDocuments({ riskScore: { $gte: 50 } });
    const compromisedDevices = await DeviceTracking.countDocuments({ isCompromised: true });
    const antiDebugDevices = await DeviceTracking.countDocuments({
      $or: [
        { isTracerAttached: true },
        { isDebugger: true },
        { isAdbEnabled: true },
        { isDebugBuild: true },
        { antiDebugScore: { $gte: 0.5 } },
      ],
    });
    const totalEvents = await SecurityEvent.countDocuments({ createdAt: { $gte: startTime } });

    const riskDistribution = {
      SAFE: await DeviceTracking.countDocuments({ riskLevel: "SAFE" }),
      LOW: await DeviceTracking.countDocuments({ riskLevel: "LOW" }),
      MEDIUM: await DeviceTracking.countDocuments({ riskLevel: "MEDIUM" }),
      HIGH: await DeviceTracking.countDocuments({ riskLevel: "HIGH" }),
      CRITICAL: await DeviceTracking.countDocuments({ riskLevel: "CRITICAL" }),
    };

    const eventTypeAggregation = await SecurityEvent.aggregate([
      { $match: { createdAt: { $gte: startTime } } },
      { $group: { _id: "$eventType", count: { $sum: 1 } } },
    ]);

    const eventTypeDistribution: Record<string, number> = {};
    for (const item of eventTypeAggregation) {
      eventTypeDistribution[item._id] = item.count;
    }

    const recentEvents = await SecurityEvent.find({ createdAt: { $gte: startTime } })
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();

    const topRiskyDevices = await DeviceTracking.find({}).sort({ riskScore: -1 }).limit(10).lean();

    res.json({
      totalDevices,
      highRiskDevices,
      compromisedDevices,
      antiDebugDevices,
      totalEvents,
      riskDistribution,
      eventTypeDistribution,
      recentEvents,
      topRiskyDevices,
    });
  } catch (error) {
    logger.error("Error getting dashboard stats:", error);
    res.status(500).json({ error: "Internal server error" });
  }
}

/**
 * GET /nexai/security/devices
 * Get device list with pagination (requires admin authentication)
 */
export async function getDeviceList(req: Request, res: Response): Promise<void> {
  try {

    const role = req.nexaiUser?.role || (req as any).user?.role;
    if (!isAdminRole(role)) {
      res.status(403).json({ error: "Admin access required" });
      return;
    }

    // G4-15: limit 夹紧到 [1,100]，page 夹紧到 >=1，避免一次拉全表或负数 skip。
    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string, 10) || 20));
    const riskLevelParam = req.query.riskLevel;
    const searchParam = req.query.search;
    const statusParam = req.query.status;
    const since = resolveTimeRangeStart(req.query.timeRange);

    const query: any = {};

    if (typeof riskLevelParam === "string" && riskLevelParam !== "all") {
      query.riskLevel = riskLevelParam;
    }

    // 「已攻破 / 正常」是设备画像里最常用的两个筛选，后端下推而不是前端过滤已加载页，
    // 否则分页 total 与实际展示行数会矛盾。
    if (statusParam === "compromised") query.isCompromised = true;
    else if (statusParam === "normal") query.isCompromised = { $ne: true };

    if (since) query.lastSeen = { $gte: since };

    if (typeof searchParam === "string" && searchParam) {
      const escapedSearch = escapeRegexLiteral(searchParam);
      query.$or = [
        { deviceFingerprint: { $regex: escapedSearch, $options: "i" } },
        { userId: { $regex: escapedSearch, $options: "i" } },
        { ipAddress: { $regex: escapedSearch, $options: "i" } },
      ];
    }

    const total = await DeviceTracking.countDocuments(query);
    const devices = await DeviceTracking.find(query)
      .sort({ lastSeen: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    res.json({
      devices,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    logger.error("Error getting device list:", error);
    res.status(500).json({ error: "Internal server error" });
  }
}

/**
 * GET /nexai/security/catalog
 * 事件类型、风险等级、档位、判据、豁免范围等全部代号的中文名。
 *
 * 为什么由服务端下发：这些代号是服务端写的（`ACCOUNT_ABUSE_*`、`SUPERADMIN_RISK_EXEMPT` …），
 * 前端如果自己抄一份映射，服务端新增事件类型时面板会把代号原样铺出来。这里一次发全，
 * 前端只负责展示。
 */
export async function getSecurityCatalogMeta(req: Request, res: Response): Promise<void> {
  try {
    const role = req.nexaiUser?.role || (req as any).user?.role;
    if (!isAdminRole(role)) {
      res.status(403).json({ error: "Admin access required" });
      return;
    }
    res.json({ success: true, ...getSecurityCatalog() });
  } catch (error) {
    logger.error("Error getting security catalog:", error);
    res.status(500).json({ error: "Internal server error" });
  }
}

/**
 * GET /nexai/security/events
 * Get security events with pagination (requires admin authentication)
 */
export async function getSecurityEvents(req: Request, res: Response): Promise<void> {
  try {

    const role = req.nexaiUser?.role || (req as any).user?.role;
    if (!isAdminRole(role)) {
      res.status(403).json({ error: "Admin access required" });
      return;
    }

    // G4-15: 与设备列表一致，limit 夹紧到 [1,100]，page >= 1。
    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string, 10) || 20));
    const eventTypeParam = req.query.eventType;
    const deviceFingerprintParam = req.query.deviceFingerprint;
    const searchParam = req.query.search;
    const since = resolveTimeRangeStart(req.query.timeRange);

    const query: any = {};
    if (typeof eventTypeParam === "string" && eventTypeParam !== "all") {
      query.eventType = eventTypeParam;
    }
    if (typeof deviceFingerprintParam === "string" && deviceFingerprintParam) {
      query.deviceFingerprint = deviceFingerprintParam;
    }
    // 默认不限时间（`all`）：与设备列表一致，面板要能回答「库里有全部事件」。
    if (since) query.createdAt = { $gte: since };

    if (typeof searchParam === "string" && searchParam) {
      const escapedSearch = escapeRegexLiteral(searchParam);
      query.$or = [
        { deviceFingerprint: { $regex: escapedSearch, $options: "i" } },
        { userId: { $regex: escapedSearch, $options: "i" } },
        { ipAddress: { $regex: escapedSearch, $options: "i" } },
        { eventType: { $regex: escapedSearch, $options: "i" } },
      ];
    }

    const total = await SecurityEvent.countDocuments(query);
    const events = await SecurityEvent.find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    res.json({
      events,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    logger.error("Error getting security events:", error);
    res.status(500).json({ error: "Internal server error" });
  }
}
