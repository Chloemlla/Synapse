import { mongoose } from "./mongoService";
import { checkAnyLegalHold } from "./legalHoldService";
import { registerBackgroundTaskStopper } from "../utils/backgroundTaskRegistry";
import logger from "../utils/logger";

/**
 * 应用层清理任务（RC-22.2 / 裁决三 (a)）。
 *
 * 为什么不能继续依赖 Mongo TTL：TTL 是**数据库后台线程**的删除行为，应用层拿不到
 * 「这一行是否命中 legal_holds」的判定点。调查期间一条被 hold 的记录照样会在 TTL
 * 到点后被删掉 —— 物理删除不可逆，事后无法补回。
 *
 * 因此裁决三要求：取证保留关键集合移除 TTL 索引，改由本任务定时清理，且**清理前**
 * 逐条校验 `legal_holds`。库不可用时 `checkAnyLegalHold` 回 `unknown: true`，
 * 本任务按 fail-closed 跳过整批删除（宁可晚清一次，也不能在拿不到 hold 结论时删证据）。
 *
 * ⚠ 本文件只负责「应用层清理」这一侧。移除各模型里的 TTL 索引属于跨文件改动，
 * 已登记在 docs/audit/2026-10-17-rc-b8.md 的挂起项里，由协调者统一应用；
 * 在 TTL 还在的模型上，本任务与 TTL 并存是安全的（本任务只删已过期文档，
 * 差别只在于「被 hold 的记录能不能被拦住」）。
 */

export interface CleanupIdentifiers {
  userId?: string;
  ipAddress?: string;
  fingerprint?: string;
}

export interface CleanupTarget {
  /** Mongo 集合名（不是模型名）。 */
  collection: string;
  /** 过期判据字段。 */
  expiryField: string;
  /** Date 字段直接用；number 字段需要和 epoch 毫秒比较。 */
  expiryKind: "date" | "number";
  /** 从文档里抽出 hold 维度。没有可抽字段时返回空对象（该集合不与个人标识关联）。 */
  identifiers: (doc: Record<string, unknown>) => CleanupIdentifiers;
}

/**
 * 关键集合清单，与 RC-22.2 的枚举逐条对齐：
 * ipBanModel / accessTokenModel / ipVerificationTokenModel / verificationTokenModel /
 * proxycheckRiskCacheModel / authEmailCooldownModel。
 *
 * 集合名用实际落库名（不是 mongoose 模型名）：Mongoose 的默认复数化会在
 * `ipbans` / `accesstokens` / `access_tokens` 这种名字上产生歧义，清理任务删错集合是灾难性的。
 */
export const LEGAL_HOLD_CLEANUP_TARGETS: readonly CleanupTarget[] = [
  {
    collection: "ipbans",
    expiryField: "expiresAt",
    expiryKind: "date",
    identifiers: (doc) => ({
      ipAddress: typeof doc.ipAddress === "string" ? doc.ipAddress : undefined,
      fingerprint: typeof doc.fingerprint === "string" ? doc.fingerprint : undefined,
    }),
  },
  {
    collection: "accesstokens",
    expiryField: "expiresAt",
    expiryKind: "date",
    identifiers: (doc) => ({
      ipAddress: typeof doc.ipAddress === "string" ? doc.ipAddress : undefined,
      fingerprint: typeof doc.fingerprint === "string" ? doc.fingerprint : undefined,
    }),
  },
  {
    collection: "ip_verification_tokens",
    expiryField: "expiresAt",
    expiryKind: "date",
    identifiers: (doc) => ({
      ipAddress: typeof doc.ipAddress === "string" ? doc.ipAddress : undefined,
      fingerprint: typeof doc.fingerprint === "string" ? doc.fingerprint : undefined,
    }),
  },
  {
    collection: "verification_tokens",
    expiryField: "ttlExpireAt",
    expiryKind: "date",
    identifiers: (doc) => ({
      ipAddress: typeof doc.ipAddress === "string" ? doc.ipAddress : undefined,
      fingerprint: typeof doc.fingerprint === "string" ? doc.fingerprint : undefined,
    }),
  },
  {
    // 存量兼容：早期文档只有数字型 expiresAt（epoch ms），没有 ttlExpireAt。
    // 单独一条 target，避免把两种时间表示塞进同一个查询。
    collection: "verification_tokens",
    expiryField: "expiresAt",
    expiryKind: "number",
    identifiers: (doc) => ({
      ipAddress: typeof doc.ipAddress === "string" ? doc.ipAddress : undefined,
      fingerprint: typeof doc.fingerprint === "string" ? doc.fingerprint : undefined,
    }),
  },
  {
    collection: "proxycheck_risk_cache",
    expiryField: "expiresAt",
    expiryKind: "date",
    identifiers: (doc) => ({
      ipAddress: typeof doc.ip === "string" ? doc.ip : undefined,
    }),
  },
  {
    // 只存用途与规范化邮箱摘要，没有 user/ip/fingerprint 维度 —— 不可能命中任何 hold。
    // 保留在清单里是为了让“关键集合”的边界完整，而不是遗漏。
    collection: "auth_email_cooldowns",
    expiryField: "expiresAt",
    expiryKind: "date",
    identifiers: () => ({}),
  },
];

export interface CleanupTargetReport {
  collection: string;
  scanned: number;
  deleted: number;
  skippedHeld: number;
  error?: string;
}

export interface CleanupReport {
  ok: boolean;
  dbAvailable: boolean;
  dryRun: boolean;
  startedAt: string;
  finishedAt: string;
  totalDeleted: number;
  totalSkippedHeld: number;
  targets: CleanupTargetReport[];
}

const DEFAULT_BATCH_SIZE = 200;
const MAX_BATCHES_PER_TARGET = 50;

function expirationFilter(target: CleanupTarget, cutoff: Date): Record<string, unknown> {
  return {
    [target.expiryField]:
      target.expiryKind === "number" ? { $lte: cutoff.getTime(), $ne: null } : { $lte: cutoff, $ne: null },
  };
}

function hasIdentifier(identifiers: CleanupIdentifiers): boolean {
  return Boolean(identifiers.userId || identifiers.ipAddress || identifiers.fingerprint);
}

/**
 * 清理一轮过期文档。导出为纯函数（不自动启动）以便集成测试与运维脚本按需触发。
 *
 * 返回 `ok:false` 只表示「库不可用，整轮跳过」，不是错误 —— 调用方据此告警即可。
 */
export async function runLegalHoldAwareCleanup(options: {
  now?: Date;
  dryRun?: boolean;
  batchSize?: number;
} = {}): Promise<CleanupReport> {
  const startedAt = new Date();
  const report: CleanupReport = {
    ok: true,
    dbAvailable: mongoose.connection.readyState === 1,
    dryRun: Boolean(options.dryRun),
    startedAt: startedAt.toISOString(),
    finishedAt: startedAt.toISOString(),
    totalDeleted: 0,
    totalSkippedHeld: 0,
    targets: [],
  };

  if (!report.dbAvailable) {
    report.ok = false;
    report.finishedAt = new Date().toISOString();
    logger.warn("[LegalHoldCleanup] 数据库不可用，整轮跳过（fail-closed，不删除任何文档）");
    return report;
  }

  const db = mongoose.connection.db;
  if (!db) {
    report.ok = false;
    report.finishedAt = new Date().toISOString();
    return report;
  }

  const cutoff = options.now ?? new Date();
  const batchSize = Math.min(Math.max(1, Math.floor(options.batchSize ?? DEFAULT_BATCH_SIZE) || DEFAULT_BATCH_SIZE), 1000);

  for (const target of LEGAL_HOLD_CLEANUP_TARGETS) {
    const targetReport: CleanupTargetReport = {
      collection: target.collection,
      scanned: 0,
      deleted: 0,
      skippedHeld: 0,
    };

    try {
      const collection = db.collection(target.collection);
      for (let batch = 0; batch < MAX_BATCHES_PER_TARGET; batch += 1) {
        const rows = (await collection
          .find(expirationFilter(target, cutoff) as any, {
            projection: { _id: 1, userId: 1, ipAddress: 1, fingerprint: 1, ip: 1 },
          })
          .limit(batchSize)
          .toArray()) as Array<Record<string, unknown>>;
        if (rows.length === 0) break;
        targetReport.scanned += rows.length;

        const deletableIds: unknown[] = [];
        for (const row of rows) {
          const identifiers = target.identifiers(row);
          if (!hasIdentifier(identifiers)) {
            deletableIds.push(row._id);
            continue;
          }
          // fail-closed：`held` 包含 unknown（库读不到结论），两种情况都不删。
          const hold = await checkAnyLegalHold(identifiers);
          if (hold.held) {
            targetReport.skippedHeld += 1;
            logger.warn("[LegalHoldCleanup] 命中法律保留，跳过物理删除", {
              collection: target.collection,
              caseRef: hold.hold?.caseRef ?? "unknown",
              undetermined: hold.unknown,
            });
            continue;
          }
          deletableIds.push(row._id);
        }

        if (!report.dryRun && deletableIds.length > 0) {
          const result = await collection.deleteMany({ // soft-delete-exempt: 应用层过期清理任务；删除前已逐条校验 legal_holds，库不可用整轮跳过
            _id: { $in: deletableIds },
            ...expirationFilter(target, cutoff),
          } as any);
          targetReport.deleted += result.deletedCount ?? 0;
        } else if (report.dryRun) {
          targetReport.deleted += deletableIds.length;
        }

        if (rows.length < batchSize) break;
      }
    } catch (error) {
      targetReport.error = error instanceof Error ? error.message : String(error);
      report.ok = false;
      logger.error("[LegalHoldCleanup] 集合清理失败", {
        collection: target.collection,
        error: targetReport.error,
      });
    }

    report.totalDeleted += targetReport.deleted;
    report.totalSkippedHeld += targetReport.skippedHeld;
    report.targets.push(targetReport);
  }

  report.finishedAt = new Date().toISOString();
  if (report.totalDeleted > 0 || report.totalSkippedHeld > 0) {
    logger.info("[LegalHoldCleanup] 清理轮次完成", {
      dryRun: report.dryRun,
      totalDeleted: report.totalDeleted,
      totalSkippedHeld: report.totalSkippedHeld,
    });
  }
  return report;
}

/** 每 6 小时扫一次。清理幂等；扫描命中率低时几乎无成本（expiry 字段有索引）。 */
const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

export function startLegalHoldAwareCleanup(intervalMs = CLEANUP_INTERVAL_MS): void {
  if (cleanupTimer) return;
  const run = () => {
    runLegalHoldAwareCleanup().catch((error: unknown) => {
      logger.error("[LegalHoldCleanup] 定时清理失败", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };
  run();
  cleanupTimer = setInterval(run, intervalMs);
  cleanupTimer.unref?.();
  registerBackgroundTaskStopper(stopLegalHoldAwareCleanup);
}

export function stopLegalHoldAwareCleanup(): void {
  if (!cleanupTimer) return;
  clearInterval(cleanupTimer);
  cleanupTimer = null;
}
