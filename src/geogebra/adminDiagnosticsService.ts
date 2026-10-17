import crypto from "node:crypto";
import mongoose from "mongoose";
import GeoGebraProjectModel from "../models/geogebraProjectModel";
import GeoGebraProjectVersionModel from "../models/geogebraProjectVersionModel";
import GeoGebraReviewCommentModel from "../models/geogebraReviewCommentModel";
import GeoGebraShareModel from "../models/geogebraShareModel";
import GeoGebraAssetModel from "../models/geogebraAssetModel";
import GeoGebraJobModel from "../models/geogebraJobModel";
import { resolveGeoGebraAiProvider } from "./aiService";
import { getGeoGebraJobRunnerStatus } from "./jobService";

// GeoGebra 管理诊断（GEO-22）。
//
// 只报「真实可核对的数」：
//  - 计数来自 Mongo 聚合，实时查询；
//  - provider 只输出「已配置/未配置」，不回显地址、模型名或密钥片段；
//  - 延迟分位没有可验证数据源（仓库没有指标存储），因此显式返回 null + 原因，
//    而不是从别处拼出看起来专业的数字（PRD 明确禁止虚构指标）。
const MONGO_STATE_LABELS: Record<number, string> = {
  0: "disconnected",
  1: "connected",
  2: "connecting",
  3: "disconnecting",
};

const PROCESS_STARTED_AT = Date.now();

function maskUserId(userId: string): string {
  // 管理端只需要「是不是同一个人」，不需要读到原始 userId：短哈希足够关联且不可反查。
  return `u_${crypto.createHash("sha256").update(userId).digest("hex").slice(0, 10)}`;
}

export type GeoGebraDiagnostics = Awaited<ReturnType<typeof getGeoGebraDiagnostics>>;

export async function getGeoGebraDiagnostics() {
  const [
    projects,
    versions,
    comments,
    shares,
    activeShares,
    assets,
    activeCovers,
    assetsByPurpose,
    jobsByStatus,
    recentJobs,
    recentShares,
    recentAssets,
  ] = await Promise.all([
    GeoGebraProjectModel.countDocuments({ subjectDeletedAt: 0 }),
    GeoGebraProjectVersionModel.countDocuments({ subjectDeletedAt: 0 }),
    GeoGebraReviewCommentModel.countDocuments({ subjectDeletedAt: 0 }),
    GeoGebraShareModel.countDocuments({ subjectDeletedAt: 0 }),
    GeoGebraShareModel.countDocuments({ subjectDeletedAt: 0, revokedAt: null }),
    GeoGebraAssetModel.countDocuments({ subjectDeletedAt: 0 }),
    GeoGebraShareModel.countDocuments({ subjectDeletedAt: 0, revokedAt: null, coverStored: true }),
    GeoGebraAssetModel.aggregate<{ _id: string; count: number; bytes: number }>([
      { $match: { subjectDeletedAt: 0 } },
      { $group: { _id: "$purpose", count: { $sum: 1 }, bytes: { $sum: "$byteSize" } } },
    ]),
    GeoGebraJobModel.aggregate<{ _id: string; count: number }>([
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]),
    GeoGebraJobModel.find({}).sort({ createdAt: -1 }).limit(10).lean(),
    GeoGebraShareModel.find({ subjectDeletedAt: 0 }).sort({ createdAt: -1 }).limit(10).lean(),
    GeoGebraAssetModel.find({ subjectDeletedAt: 0 }).sort({ createdAt: -1 }).limit(10).lean(),
  ]);

  const provider = resolveGeoGebraAiProvider();
  const jobStatus: Record<string, number> = {};
  for (const entry of jobsByStatus) jobStatus[String(entry._id ?? "unknown")] = Number(entry.count ?? 0);

  const assetBuckets: Record<string, { count: number; bytes: number }> = {};
  for (const entry of assetsByPurpose) {
    const purpose = String(entry._id ?? "unknown");
    assetBuckets[purpose] = { count: Number(entry.count ?? 0), bytes: Number(entry.bytes ?? 0) };
  }
  const aiReferences = assetBuckets["ai-reference"] ?? { count: 0, bytes: 0 };
  const exportBundles = assetBuckets["export-bundle"] ?? { count: 0, bytes: 0 };
  const runner = getGeoGebraJobRunnerStatus();
  const queued = Number(jobStatus.queued ?? 0);
  const runningJobs = Number(jobStatus.running ?? 0);

  return {
    generatedAt: new Date().toISOString(),
    service: {
      uptimeSeconds: Math.round((Date.now() - PROCESS_STARTED_AT) / 1000),
      pid: process.pid,
      nodeVersion: process.version,
    },
    mongo: {
      readyState: mongoose.connection.readyState,
      state: MONGO_STATE_LABELS[mongoose.connection.readyState] ?? "unknown",
      database: mongoose.connection.name || null,
    },
    ai: {
      configured: provider.configured,
      vision: provider.configured ? provider.vision : false,
      reason: provider.configured ? null : provider.reason ?? "AI 能力尚未配置。",
    },
    counts: { projects, versions, comments, shares, activeShares, assets },
    // GEO-22：worker / 队列。任务由进程内 runner + Mongo 租约驱动，没有独立 broker，
    // 因此队列深度只能报「库里 queued/running 的真实行数」，不报虚构的消费者数。
    worker: {
      scheduler: runner.scheduler,
      running: runner.running,
      pid: runner.pid,
      tickMs: runner.tickMs,
      leaseMs: runner.leaseMs,
      note: runner.running
        ? "单进程内 runner 已启动；多实例部署时靠租约互斥，不靠进程数。"
        : "单进程内 runner 未启动（通常只在测试或未调用 startGeoGebraJobRunner 时出现）。",
    },
    queue: {
      queued,
      running: runningJobs,
      totalActive: queued + runningJobs,
      maxActiveJobsPerUser: runner.maxActiveJobsPerUser,
      leaseMs: runner.leaseMs,
      note: "排队任务存在 MongoDB 的 geogebra_jobs 集合里；队列深度按 status 计数，等待时间受租约与单用户并发上限约束。",
    },
    // GEO-22：静态资源。分享封面落在 data/geogebra/shares，其余资产落在 data/geogebra/assets；
    // 这里只报计数与字节数，不回显磁盘路径（避免管理页泄漏部署结构）。
    staticAssets: {
      shareCovers: { active: activeCovers, storage: "local-disk" as const },
      aiReferenceAssets: { count: aiReferences.count, bytes: aiReferences.bytes },
      exportBundles: { count: exportBundles.count, bytes: exportBundles.bytes },
    },
    jobsByStatus: jobStatus,
    recentJobs: recentJobs.map((job) => ({
      jobId: job.jobId,
      kind: job.kind,
      status: job.status,
      progress: job.progress,
      owner: maskUserId(String(job.ownerUserId)),
      attempts: job.attempts,
      errorCode: job.errorCode ?? null,
      hasResult: Boolean(job.result),
      createdAt: new Date(job.createdAt).toISOString(),
      updatedAt: new Date(job.updatedAt).toISOString(),
    })),
    recentShares: recentShares.map((share) => ({
      shareId: share.shareId,
      slug: share.slug,
      title: share.title,
      owner: maskUserId(String(share.ownerUserId)),
      commandCount: Array.isArray(share.commands) ? share.commands.length : 0,
      allowFork: Boolean(share.allowFork),
      revoked: Boolean(share.revokedAt),
      createdAt: new Date(share.createdAt).toISOString(),
    })),
    // GEO-22：最近资产。storageKey 是内部文件名，不进入管理端响应；
    // 过期时间与体积是运维排查「是不是资源没清掉」时真正需要的字段。
    recentAssets: recentAssets.map((asset) => ({
      assetId: asset.assetId,
      purpose: asset.purpose,
      mimeType: asset.mimeType,
      byteSize: Number(asset.byteSize ?? 0),
      owner: maskUserId(String(asset.ownerUserId)),
      createdAt: new Date(asset.createdAt).toISOString(),
      expiresAt: new Date(asset.expiresAt).toISOString(),
    })),
    // 指标缺口如实上报，管理页按「无数据」渲染。
    metrics: {
      endpointLatency: null,
      modelLatency: null,
      uploadSizeDistribution: null,
      unavailableReason: "服务当前没有指标存储，延迟与体积分布无法给出可核对的数据。",
    },
  };
}
