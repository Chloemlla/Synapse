import GeoGebraAssetModel from "../models/geogebraAssetModel";
import GeoGebraJobModel from "../models/geogebraJobModel";
import GeoGebraShareModel from "../models/geogebraShareModel";
import { getGeoGebraJobRunnerStatus } from "../geogebra/jobService";
import { geoGebraVersionRetentionLimit } from "../geogebra/projectService";

/**
 * GeoGebra 管理端的分页列表（页面 `/admin/geogebra` 的任务 / 分享 / 资源 / 版本页签）。
 *
 * 为什么单独一层：`adminDiagnosticsService` 只回「最近 10 条」的概览，
 * 而运维排查需要能按状态/用户翻页、看单条细节。这里补的是**列表**，不重复概览的聚合。
 *
 * 边界：
 *   - 不回 `storageKey`（那是本地文件名，属实现细节），只回 assetId 与大小；
 *   - 所有者只回短哈希（与概览一致），需要定位到人时按 ownerUserId 精确筛；
 *   - 所有列表 ≤200/页，按 createdAt/index 排序，不下推整表。
 */

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;

function clampLimit(value: unknown): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.floor(num), 1), MAX_LIMIT);
}

function clampOffset(value: unknown): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return 0;
  return Math.floor(num);
}

function toIso(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  return null;
}

/** 所有者短哈希：与 `adminDiagnosticsService` 的 `owner` 字段同口径。 */
function shortOwner(value: unknown): string {
  const id = typeof value === "string" ? value : "";
  if (!id) return "unknown";
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

export class GeoGebraAdminListService {
  static async listJobs(query: Record<string, unknown>) {
    const limit = clampLimit(query.limit);
    const offset = clampOffset(query.offset);
    const filter: Record<string, unknown> = {};
    const status = typeof query.status === "string" ? query.status.trim() : "";
    const kind = typeof query.kind === "string" ? query.kind.trim() : "";
    const userId = typeof query.userId === "string" ? query.userId.trim() : "";
    if (status) filter.status = status;
    if (kind) filter.kind = kind;
    if (userId) filter.ownerUserId = userId;

    const [docs, total, runner] = await Promise.all([
      GeoGebraJobModel.find(filter)
        .select("jobId kind ownerUserId status progress errorCode attempts hasResult createdAt updatedAt")
        .sort({ createdAt: -1 })
        .skip(offset)
        .limit(limit)
        .lean()
        .exec(),
      GeoGebraJobModel.countDocuments(filter).exec(),
      Promise.resolve(getGeoGebraJobRunnerStatus()),
    ]);

    return {
      total,
      limit,
      offset,
      runner,
      jobs: (docs as unknown as Array<Record<string, unknown>>).map((doc) => ({
        jobId: String(doc.jobId ?? ""),
        kind: String(doc.kind ?? ""),
        owner: shortOwner(doc.ownerUserId),
        status: String(doc.status ?? ""),
        progress: Number(doc.progress) || 0,
        attempts: Number(doc.attempts) || 0,
        errorCode: typeof doc.errorCode === "string" ? doc.errorCode : null,
        hasResult: doc.hasResult === true,
        createdAt: toIso(doc.createdAt),
        updatedAt: toIso(doc.updatedAt),
      })),
    };
  }

  static async listShares(query: Record<string, unknown>) {
    const limit = clampLimit(query.limit);
    const offset = clampOffset(query.offset);
    const filter: Record<string, unknown> = {};
    const userId = typeof query.userId === "string" ? query.userId.trim() : "";
    const state = typeof query.state === "string" ? query.state.trim() : "";
    if (userId) filter.ownerUserId = userId;
    if (state === "revoked") filter.revokedAt = { $ne: null };
    if (state === "active") filter.revokedAt = null;

    const [docs, total] = await Promise.all([
      GeoGebraShareModel.find(filter)
        .select("shareId slug ownerUserId projectId title canvasMode commands allowFork coverStored revokedAt createdAt")
        .sort({ createdAt: -1 })
        .skip(offset)
        .limit(limit)
        .lean()
        .exec(),
      GeoGebraShareModel.countDocuments(filter).exec(),
    ]);

    return {
      total,
      limit,
      offset,
      shares: (docs as unknown as Array<Record<string, unknown>>).map((doc) => ({
        shareId: String(doc.shareId ?? ""),
        slug: String(doc.slug ?? ""),
        owner: shortOwner(doc.ownerUserId),
        title: String(doc.title ?? ""),
        canvasMode: String(doc.canvasMode ?? ""),
        commandCount: Array.isArray(doc.commands) ? doc.commands.length : 0,
        allowFork: doc.allowFork === true,
        coverStored: doc.coverStored === true,
        revoked: doc.revokedAt !== null && doc.revokedAt !== undefined,
        revokedAt: toIso(doc.revokedAt),
        createdAt: toIso(doc.createdAt),
        embedPath: doc.revokedAt ? null : `/geogebra/share/${String(doc.slug ?? "")}?embed=1`,
      })),
    };
  }

  static async listAssets(query: Record<string, unknown>) {
    const limit = clampLimit(query.limit);
    const offset = clampOffset(query.offset);
    const filter: Record<string, unknown> = {};
    const purpose = typeof query.purpose === "string" ? query.purpose.trim() : "";
    if (purpose) filter.purpose = purpose;

    const [docs, total] = await Promise.all([
      GeoGebraAssetModel.find(filter)
        .select("assetId ownerUserId purpose mimeType byteSize createdAt expiresAt")
        .sort({ createdAt: -1 })
        .skip(offset)
        .limit(limit)
        .lean()
        .exec(),
      GeoGebraAssetModel.countDocuments(filter).exec(),
    ]);

    return {
      total,
      limit,
      offset,
      assets: (docs as unknown as Array<Record<string, unknown>>).map((doc) => ({
        assetId: String(doc.assetId ?? ""),
        owner: shortOwner(doc.ownerUserId),
        purpose: String(doc.purpose ?? ""),
        mimeType: String(doc.mimeType ?? ""),
        byteSize: Number(doc.byteSize) || 0,
        createdAt: toIso(doc.createdAt),
        expiresAt: toIso(doc.expiresAt),
        expired: doc.expiresAt instanceof Date ? doc.expiresAt.getTime() <= Date.now() : false,
      })),
    };
  }

  /**
   * 版本与保留口径（GEO-11）。
   *
   * 只回「上限是多少、为什么有上限」，不回逐项目版本数（那是逐项目视图，属于项目页）。
   * `embedFrameAncestors` 回 env 实际生效值，方便核对「嵌入为什么被拒」。
   */
  static settings() {
    return {
      versionRetentionLimit: geoGebraVersionRetentionLimit(),
      versionRetentionEnv: "GEOGEBRA_VERSION_RETENTION_LIMIT",
      versionRetentionNote:
        "按项目内最旧裁剪；被评论引用的版本不删除（宁可临时超限也不制造悬空引用）。改动随重启生效。",
      embedFrameAncestors: process.env.GEOGEBRA_EMBED_FRAME_ANCESTORS ?? "*",
      embedFrameAncestorsEnv: "GEOGEBRA_EMBED_FRAME_ANCESTORS",
      embedFrameAncestorsNote:
        "空串 = 关闭嵌入；`*` = 允许任意来源 iframe；逗号分隔 = 白名单。非法来源会被丢弃（fail-closed）。",
    };
  }
}
