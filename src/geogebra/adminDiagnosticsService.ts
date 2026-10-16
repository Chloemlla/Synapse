import crypto from "node:crypto";
import mongoose from "mongoose";
import GeoGebraProjectModel from "../models/geogebraProjectModel";
import GeoGebraProjectVersionModel from "../models/geogebraProjectVersionModel";
import GeoGebraReviewCommentModel from "../models/geogebraReviewCommentModel";
import GeoGebraShareModel from "../models/geogebraShareModel";
import GeoGebraAssetModel from "../models/geogebraAssetModel";
import GeoGebraJobModel from "../models/geogebraJobModel";
import { resolveGeoGebraAiProvider } from "./aiService";

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
  const [projects, versions, comments, shares, activeShares, assets, jobsByStatus, recentJobs, recentShares] = await Promise.all([
    GeoGebraProjectModel.countDocuments({ subjectDeletedAt: 0 }),
    GeoGebraProjectVersionModel.countDocuments({ subjectDeletedAt: 0 }),
    GeoGebraReviewCommentModel.countDocuments({ subjectDeletedAt: 0 }),
    GeoGebraShareModel.countDocuments({ subjectDeletedAt: 0 }),
    GeoGebraShareModel.countDocuments({ subjectDeletedAt: 0, revokedAt: null }),
    GeoGebraAssetModel.countDocuments({ subjectDeletedAt: 0 }),
    GeoGebraJobModel.aggregate<{ _id: string; count: number }>([
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]),
    GeoGebraJobModel.find({}).sort({ createdAt: -1 }).limit(10).lean(),
    GeoGebraShareModel.find({ subjectDeletedAt: 0 }).sort({ createdAt: -1 }).limit(10).lean(),
  ]);

  const provider = resolveGeoGebraAiProvider();
  const jobStatus: Record<string, number> = {};
  for (const entry of jobsByStatus) jobStatus[String(entry._id ?? "unknown")] = Number(entry.count ?? 0);

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
    // 指标缺口如实上报，管理页按「无数据」渲染。
    metrics: {
      endpointLatency: null,
      modelLatency: null,
      uploadSizeDistribution: null,
      unavailableReason: "服务当前没有指标存储，延迟与体积分布无法给出可核对的数据。",
    },
  };
}
