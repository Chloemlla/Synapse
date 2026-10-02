import type { Request, Response } from "express";
import { TurnstileService } from "../../services/turnstileService";
import { sanitizeString, validateFingerprint } from "../../services/turnstile/validators";
import logger from "../../utils/logger";
import { getClientIp } from "./_helpers";

/** 设备信号里我们真正会读的顶层分组（前端 utils/fingerprint.ts 的 deviceSignals 形状）。 */
const ALLOWED_SIGNAL_GROUPS = ["screen", "timezone", "canvas", "navigator", "window"] as const;
/**
 * 单个分组序列化后的字节上限。
 *
 * 为什么要截断：这些值原样写进用户文档（每人最多 20 条记录）。客户端可以把
 * deviceSignals 里塞任意大的对象，多条记录累积后会把文档推到 Mongo 的 16MB 上限，
 * 之后该用户的任何 `updateUser` 都会失败 —— 一个纯客户端可触发的可用性问题。
 */
const MAX_SIGNAL_GROUP_BYTES = 4096;

/** 只保留已知分组，并逐组做长度截断。 */
function sanitizeDeviceSignals(input: unknown): Record<string, unknown> | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const source = input as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const group of ALLOWED_SIGNAL_GROUPS) {
    if (!(group in source)) continue;
    let serialized: string;
    try {
      serialized = JSON.stringify(source[group]);
    } catch {
      continue; // 循环引用等异常形态直接丢弃该组
    }
    if (!serialized || serialized === "undefined") continue;
    if (Buffer.byteLength(serialized, "utf8") > MAX_SIGNAL_GROUP_BYTES) {
      result[group] = { truncated: true, bytes: Buffer.byteLength(serialized, "utf8") };
      continue;
    }
    result[group] = source[group];
  }
  return Object.keys(result).length > 0 ? result : null;
}

export async function reportFingerprint(req: Request, res: Response) {
  try {
    const { fingerprint, deviceSignals } = req.body;
    const validatedClientIp = getClientIp(req);
    const userId = (req as any).user?.id;
    const userAgent = req.headers["user-agent"] || "unknown";

    // 只记摘要：旧代码把整个 deviceSignals（含 canvas / navigator 明细）与 IP / UA 全量
    // console.log 出来，既是日志噪声也是把终端指纹写进了不受保留策略约束的 stdout。
    logger.debug("[Fingerprint] 收到上报请求", {
      userId,
      fingerprintPrefix: typeof fingerprint === "string" ? fingerprint.slice(0, 8) : null,
      hasDeviceSignals: Boolean(deviceSignals),
    });

    // 用共用校验器：长度 8–200 + 仅 [A-Za-z0-9_-]。旧实现只查了 typeof string，
    // 于是超长字符串/任意字符都会被当作记录 id 写进用户文档。
    // 前端的指纹要么是 FingerprintJS 的 visitorId（hex），要么是 SHA-256 hex；
    // 只有「SHA-256 抛错」的极端兼底路径才会产生 base64（含 +/=）—— 那一档先剔字符再校一次，
    // 不把这条很罕见但真实的路径卡成 400。
    const rawFingerprint = typeof fingerprint === "string" ? fingerprint : "";
    const safeFingerprint =
      validateFingerprint(rawFingerprint) ?? validateFingerprint(rawFingerprint.replace(/[^a-zA-Z0-9_-]/g, ""));
    if (!safeFingerprint) {
      return res.status(400).json({ success: false, error: "指纹参数无效" });
    }

    const banStatus = await TurnstileService.isIpBanned(validatedClientIp);
    if (banStatus.banned) {
      logger.warn("[Fingerprint] 拒绝已被封禁的 IP 上报", { ip: validatedClientIp });
      return res.status(403).json({
        success: false,
        error: "IP已被封禁",
        reason: banStatus.reason,
        expiresAt: banStatus.expiresAt,
      });
    }

    try {
      const { updateUser, getUserById } = require("../../services/userService");
      const current = await getUserById(userId);
      const existing = (current && (current as any).fingerprints) || [];

      const fingerprintRecord = {
        id: safeFingerprint,
        ts: Date.now(),
        ua: sanitizeString(String(userAgent), 512) || "unknown",
        ip: String(validatedClientIp),
        deviceInfo: sanitizeDeviceSignals(deviceSignals),
      };

      const next = [fingerprintRecord, ...existing].slice(0, 20);

      await updateUser(userId, {
        fingerprints: next,
        requireFingerprint: false,
        requireFingerprintAt: 0,
      } as any);

      logger.info("[Fingerprint] 上报已保存", {
        userId,
        fingerprintPrefix: safeFingerprint.slice(0, 8),
        total: next.length,
      });

      try {
        const { wsService } = require("../../services/wsService");
        wsService.notifyFingerprintAck(userId);
      } catch (_wsErr) {
        // WS 推送失败不影响主流程
      }
    } catch (saveError) {
      logger.error("[Fingerprint] 保存指纹到用户记录失败", { error: saveError, userId });
    }

    res.json({ success: true, message: "指纹上报成功", timestamp: new Date().toISOString() });
  } catch (error) {
    logger.error("[Fingerprint] 指纹上报失败", { error });
    res.status(500).json({ success: false, error: "服务器内部错误" });
  }
}
