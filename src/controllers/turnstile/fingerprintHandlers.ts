import type { Request, Response } from "express";
import { config } from "../../config/config";
import { evaluateAccountRisk, recordAutomationTraceSignal } from "../../services/accountRiskService";
import { analyzeFingerprintSignals, recordDeviceFingerprint } from "../../services/deviceFingerprintService";
import { TurnstileService } from "../../services/turnstileService";
import { sanitizeString, validateFingerprint } from "../../services/turnstile/validators";
import { detectAutomationTrace, type AutomationTraceFacts } from "../../utils/accountRiskScoring";
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

/**
 * RC-57：客户端上报的**早期自动化痕迹**只保留白名单字段。
 *
 * 与 deviceSignals 同理：body 是客户端可控的，不能把任意对象写进事件表
 *（事件表的查询/索引会因此变成不可信数据源）。只取固定几个键、固定类型。
 */
function sanitizeAutomationTraces(input: unknown): AutomationTraceFacts | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const source = input as Record<string, unknown>;
  const traces: AutomationTraceFacts = {
    webdriver: source.webdriver === true,
    uaCh: source.uaCh === true,
    // 下面三路只落库、不进判据（见 `detectAutomationTrace` 注释）。
    languages: typeof source.languages === "number" && Number.isFinite(source.languages) ? source.languages : undefined,
    plugins: typeof source.plugins === "number" && Number.isFinite(source.plugins) ? source.plugins : undefined,
    hardwareConcurrency:
      typeof source.hardwareConcurrency === "number" && Number.isFinite(source.hardwareConcurrency)
        ? source.hardwareConcurrency
        : undefined,
  };
  const hasAny = traces.webdriver === true || traces.uaCh === true || traces.languages !== undefined;
  return hasAny ? traces : null;
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

      // RC-16：把分量摘要写进 `device_fingerprints`（跨账户 / 漂移比对的事实源）。
      // 放在响应之前**不 await**：指纹事实是增强证据，不能让一次 Mongo 写入拖慢上报接口；
      // 失败只记日志（与上面“保存到用户记录”失败的容忍度一致）。
      if (config.accountRisk.fingerprintComponentsEnabled) {
        const automationTraces = sanitizeAutomationTraces(req.body?.automation);
        void (async () => {
          try {
            await recordDeviceFingerprint({
              userId,
              fingerprintId: safeFingerprint,
              components: req.body?.components,
              ipAddress: validatedClientIp,
              source: "fingerprint_report",
            });
            // RC-57：把 navigator.webdriver / UA-CH 缺失这类早期痕迹并入同一个上报面
            //（不新增采集端点）。只写 `AUTOMATION_TRACE` 事件与加权旗标，绝不单独封禁。
            if (automationTraces) {
              const verdict = detectAutomationTrace(automationTraces, String(userAgent));
              if (verdict.hint) {
                await recordAutomationTraceSignal({
                  userId,
                  signals: verdict.signals,
                  traces: {
                    webdriver: automationTraces.webdriver === true,
                    uaCh: automationTraces.uaCh === true,
                    languages: automationTraces.languages,
                    plugins: automationTraces.plugins,
                    hardwareConcurrency: automationTraces.hardwareConcurrency,
                  },
                  ipAddress: validatedClientIp,
                  userAgent: String(userAgent),
                  fingerprint: safeFingerprint,
                });
              }
            }
            // 先写 FP_* 信号事件（分析自带 24h 去重），再重新聚合一次账户风险，
            // 让新出现的跨账户共用 / 分量漂移不必等到下一次登录才生效。
            await analyzeFingerprintSignals(userId);
            await evaluateAccountRisk(userId, { reason: "fingerprint_report" });
          } catch (riskError) {
            logger.debug("[Fingerprint] 指纹分量风控链路失败（不影响上报）", {
              userId,
              error: riskError instanceof Error ? riskError.message : String(riskError),
            });
          }
        })();
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
