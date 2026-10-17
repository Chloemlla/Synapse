import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import GeoGebraJobModel, {
  GEOGEBRA_JOB_KINDS,
  type GeoGebraJobKind,
  type GeoGebraJobResult,
} from "../models/geogebraJobModel";
import GeoGebraProjectVersionModel from "../models/geogebraProjectVersionModel";
import { createZipBuffer } from "../docTool/zipStore";
import { GeoGebraDomainError, getAccessibleGeoGebraProject } from "./projectService";
import { createGeoGebraAssetFromBuffer, deleteGeoGebraAsset, readGeoGebraAsset } from "./assetService";
import { requestGeoGebraAi, resolveGeoGebraAiProviderForRuntime, type GeoGebraAiKind } from "./aiService";

// GeoGebra 异步任务域（GEO-15/16/21）。
//
// 为什么复用「Mongo 一态 + 进程内 runner + 租约」而不是自建队列：
// 仓库已有 docTool/mediaTool 两套同构实现，任务量级也远不到需要独立 broker；
// 关键是租约要能挡住「进程重启后任务卡在 running」——这正是 PRD 要求的 lease/watchdog。
const MAX_ACTIVE_JOBS_PER_USER = 3;
const LEASE_MS = 120_000;
const AI_JOB_TTL_MS = 24 * 60 * 60_000;
const EXPORT_JOB_TTL_MS = 72 * 60 * 60_000;
const MAX_JOB_LIST = 50;
const TICK_MS = 2_000;

export const GEOGEBRA_EXPORT_FORMATS = ["zip-bundle", "svg", "pdf", "gif", "mp4", "pptx"] as const;
export type GeoGebraExportFormat = (typeof GEOGEBRA_EXPORT_FORMATS)[number];

/**
 * 导出能力矩阵：服务端只做「把已有数据打包」，渲染类格式明确标记为画布侧能力。
 * PRD 要求不留不可用的按钮，所以这里给的是可查询的真实能力，而不是一张格式白名单。
 */
export const GEOGEBRA_EXPORT_CAPABILITIES: Record<GeoGebraExportFormat, { serverSide: boolean; note: string }> = {
  "zip-bundle": { serverSide: true, note: "把项目脚本、版本与分享信息打包成 ZIP，稍后可下载。" },
  svg: { serverSide: false, note: "矢量图请在画布侧直接导出。" },
  pdf: { serverSide: false, note: "PDF 请由浏览器打印或使用画布导出的图片生成。" },
  gif: { serverSide: false, note: "动图需要帧录制，目前只有画布侧可完成。" },
  mp4: { serverSide: false, note: "视频编码不在服务端能力范围内。" },
  pptx: { serverSide: false, note: "演示文稿版式渲染不在服务端能力范围内。" },
};

export function isGeoGebraExportFormat(value: unknown): value is GeoGebraExportFormat {
  return typeof value === "string" && (GEOGEBRA_EXPORT_FORMATS as readonly string[]).includes(value);
}

export function listGeoGebraExportCapabilities() {
  return GEOGEBRA_EXPORT_FORMATS.map((format) => ({ format, ...GEOGEBRA_EXPORT_CAPABILITIES[format] }));
}

export type GeoGebraJobView = {
  jobId: string;
  kind: GeoGebraJobKind;
  status: string;
  progress: number;
  projectId: string | null;
  result: GeoGebraJobResult | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

function jobView(job: {
  jobId: string; kind: GeoGebraJobKind; status: string; progress: number; projectId: string | null;
  result: GeoGebraJobResult | null; errorCode: string | null; errorMessage: string | null;
  createdAt: Date; updatedAt: Date;
}): GeoGebraJobView {
  return {
    jobId: job.jobId,
    kind: job.kind,
    status: job.status,
    progress: job.progress,
    projectId: job.projectId ?? null,
    result: job.result ?? null,
    errorCode: job.errorCode ?? null,
    errorMessage: job.errorMessage ?? null,
    createdAt: new Date(job.createdAt).toISOString(),
    updatedAt: new Date(job.updatedAt).toISOString(),
  };
}

function normalizeProjectId(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 80) : "";
}

function normalizeCode(value: unknown): string {
  return typeof value === "string" ? value.slice(0, 50_000) : "";
}

async function assertActiveQuota(userId: string): Promise<void> {
  const active = await GeoGebraJobModel.countDocuments({ ownerUserId: userId, status: { $in: ["queued", "running"] } });
  if (active >= MAX_ACTIVE_JOBS_PER_USER) {
    throw new GeoGebraDomainError("同时进行的任务过多，请等待前面的任务完成。", 429, "GEOGEBRA_JOB_QUOTA_EXCEEDED");
  }
}

/**
 * 幂等落库：同一用户 + 同一幂等键若已有未终态任务，直接返回既有任务，
 * 不做第二次上游调用（双击提交、网络重试都不该重复生成/重复扣额）。
 */
async function createJobRecord(input: {
  userId: string;
  kind: GeoGebraJobKind;
  projectId: string | null;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  ttlMs: number;
}): Promise<GeoGebraJobView> {
  const existing = await GeoGebraJobModel.findOne({
    ownerUserId: input.userId,
    idempotencyKey: input.idempotencyKey,
    status: { $in: ["queued", "running"] },
  }).lean();
  if (existing) return jobView(existing as unknown as Parameters<typeof jobView>[0]);

  await assertActiveQuota(input.userId);
  const now = Date.now();
  const jobId = `ggbjob_${crypto.randomBytes(12).toString("hex")}`;
  try {
    const created = await GeoGebraJobModel.create({
      jobId,
      kind: input.kind,
      ownerUserId: input.userId,
      projectId: input.projectId,
      status: "queued",
      idempotencyKey: input.idempotencyKey,
      progress: 0,
      input: input.payload,
      result: null,
      errorCode: null,
      errorMessage: null,
      attempts: 0,
      leaseOwner: null,
      leaseExpiresAt: null,
      subjectDeletedAt: 0,
      createdAt: new Date(now),
      updatedAt: new Date(now),
      expiresAt: new Date(now + input.ttlMs),
    });
    return jobView(created as unknown as Parameters<typeof jobView>[0]);
  } catch (error) {
    // 并发双击时唯一索引会拒掉第二条，此时回读既有任务比报错更符合用户预期。
    if ((error as { code?: number }).code === 11000) {
      const raced = await GeoGebraJobModel.findOne({
        ownerUserId: input.userId,
        idempotencyKey: input.idempotencyKey,
        status: { $in: ["queued", "running"] },
      }).lean();
      if (raced) return jobView(raced as unknown as Parameters<typeof jobView>[0]);
    }
    throw error;
  }
}

function idempotencyKeyFor(userId: string, kind: GeoGebraJobKind, payload: Record<string, unknown>): string {
  const digest = crypto.createHash("sha256").update(JSON.stringify([userId, kind, payload])).digest("hex").slice(0, 40);
  return `${kind}:${digest}`;
}

export async function createGeoGebraAiJob(input: {
  userId: string;
  kind: GeoGebraAiKind;
  projectId?: unknown;
  canvasMode?: unknown;
  code?: unknown;
  prompt?: unknown;
  objectNames?: unknown;
  focusObject?: unknown;
  referenceAssetId?: unknown;
}): Promise<GeoGebraJobView> {
  // AI 来源可能是环境变量、独立配置或复用的 LibreChat 提供者：入队前先按当前生效配置判一次，
  // 未配置就不要排一个注定失败的任务（解析是异步的，读的是 Mongo 里的运行时配置）。
  const provider = await resolveGeoGebraAiProviderForRuntime();
  if (!provider.configured) {
    throw new GeoGebraDomainError("AI 能力暂不可用，请稍后再试。", 503, "GEOGEBRA_AI_UNAVAILABLE");
  }
  const projectId = normalizeProjectId(input.projectId);
  if (projectId) await getAccessibleGeoGebraProject(input.userId, projectId, "read");

  const payload: Record<string, unknown> = {
    canvasMode: typeof input.canvasMode === "string" ? input.canvasMode.slice(0, 20) : "geometry",
    code: normalizeCode(input.code),
    prompt: typeof input.prompt === "string" ? input.prompt.trim().slice(0, 2_000) : "",
    objectNames: Array.isArray(input.objectNames)
      ? input.objectNames.filter((name): name is string => typeof name === "string").slice(0, 200).map((name) => name.slice(0, 200))
      : [],
    focusObject: typeof input.focusObject === "string" ? input.focusObject.slice(0, 200) : "",
    // 只存 assetId：参考图本身留在资产服务里，作业文档里不留图片字节。
    referenceAssetId: typeof input.referenceAssetId === "string" ? input.referenceAssetId.slice(0, 80) : "",
  };
  return createJobRecord({
    userId: input.userId,
    kind: input.kind,
    projectId: projectId || null,
    idempotencyKey: idempotencyKeyFor(input.userId, input.kind, payload),
    payload,
    ttlMs: AI_JOB_TTL_MS,
  });
}

export async function createGeoGebraExportJob(input: {
  userId: string;
  projectId: unknown;
  format: unknown;
}): Promise<GeoGebraJobView> {
  const projectId = normalizeProjectId(input.projectId);
  if (!projectId) throw new GeoGebraDomainError("请先选择要导出的项目。", 400, "GEOGEBRA_EXPORT_PROJECT_REQUIRED");
  if (!isGeoGebraExportFormat(input.format)) {
    throw new GeoGebraDomainError("该导出格式暂不支持。", 400, "GEOGEBRA_EXPORT_FORMAT_UNKNOWN");
  }
  const capability = GEOGEBRA_EXPORT_CAPABILITIES[input.format];
  if (!capability.serverSide) {
    throw new GeoGebraDomainError(capability.note, 409, "GEOGEBRA_EXPORT_FORMAT_UNSUPPORTED");
  }
  await getAccessibleGeoGebraProject(input.userId, projectId, "read");
  const payload = { projectId, format: input.format };
  return createJobRecord({
    userId: input.userId,
    kind: "export",
    projectId,
    idempotencyKey: idempotencyKeyFor(input.userId, "export", payload),
    payload,
    ttlMs: EXPORT_JOB_TTL_MS,
  });
}

export async function listGeoGebraJobs(userId: string, limit = 20): Promise<GeoGebraJobView[]> {
  const safeLimit = Math.min(Math.max(1, Math.floor(limit) || 20), MAX_JOB_LIST);
  const jobs = await GeoGebraJobModel.find({ ownerUserId: userId, subjectDeletedAt: 0 })
    .sort({ createdAt: -1 })
    .limit(safeLimit)
    .lean();
  return jobs.map((job) => jobView(job as unknown as Parameters<typeof jobView>[0]));
}

export async function getGeoGebraJob(userId: string, jobId: string): Promise<GeoGebraJobView> {
  const job = await GeoGebraJobModel.findOne({ jobId, ownerUserId: userId, subjectDeletedAt: 0 }).lean();
  if (!job) throw new GeoGebraDomainError("任务不存在。", 404, "GEOGEBRA_JOB_NOT_FOUND");
  return jobView(job as unknown as Parameters<typeof jobView>[0]);
}

export async function cancelGeoGebraJob(userId: string, jobId: string): Promise<GeoGebraJobView> {
  const updated = await GeoGebraJobModel.findOneAndUpdate(
    { jobId, ownerUserId: userId, status: { $in: ["queued", "running"] }, subjectDeletedAt: 0 },
    { $set: { status: "cancelled", leaseOwner: null, leaseExpiresAt: null, updatedAt: new Date() } },
    { returnDocument: "after" },
  ).lean();
  if (!updated) {
    const existing = await GeoGebraJobModel.findOne({ jobId, ownerUserId: userId, subjectDeletedAt: 0 }).lean();
    if (!existing) throw new GeoGebraDomainError("任务不存在。", 404, "GEOGEBRA_JOB_NOT_FOUND");
    return jobView(existing as unknown as Parameters<typeof jobView>[0]);
  }
  return jobView(updated as unknown as Parameters<typeof jobView>[0]);
}

export async function markUserGeoGebraJobsDeleted(userId: string, deletedAt: number): Promise<void> {
  await GeoGebraJobModel.updateMany(
    { ownerUserId: userId, subjectDeletedAt: 0 },
    { $set: { subjectDeletedAt: deletedAt } },
  );
}

/** 过期任务：TTL 索引会回收文档，但 running 的残留要先置为 expired，避免前端一直显示运行中。 */
export async function expireGeoGebraJobs(now: Date = new Date()): Promise<{ expired: number }> {
  const result = await GeoGebraJobModel.updateMany(
    { expiresAt: { $lte: now }, status: { $in: ["queued", "running"] } },
    { $set: { status: "expired", leaseOwner: null, leaseExpiresAt: null, updatedAt: now } },
  );
  return { expired: result.modifiedCount ?? 0 };
}

async function releaseStaleLeases(now: Date): Promise<void> {
  // 进程重启后租约不会自己消失：过期的 running 必须能重新排队，否则任务永久卡住。
  await GeoGebraJobModel.updateMany(
    { status: "running", leaseExpiresAt: { $lte: now } },
    { $set: { status: "queued", leaseOwner: null, leaseExpiresAt: null, updatedAt: now } },
  );
}

async function runExportJob(job: { ownerUserId: string; jobId: string; input: Record<string, unknown> }): Promise<GeoGebraJobResult> {
  const format = String(job.input.format ?? "");
  if (!isGeoGebraExportFormat(format) || !GEOGEBRA_EXPORT_CAPABILITIES[format].serverSide) {
    throw new GeoGebraDomainError("该导出格式暂不支持。", 409, "GEOGEBRA_EXPORT_FORMAT_UNSUPPORTED");
  }
  const projectId = String(job.input.projectId ?? "");
  const project = await getAccessibleGeoGebraProject(job.ownerUserId, projectId, "read");
  const versions = await GeoGebraProjectVersionModel.find({ projectId, subjectDeletedAt: 0 })
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();

  const tempDir = path.resolve(
    String(process.env.GEOGEBRA_TMP_ROOT || "").trim() || path.resolve(process.cwd(), "data", "geogebra", "tmp"),
    job.jobId,
  );
  await fs.mkdir(tempDir, { recursive: true, mode: 0o700 });
  try {
    const scriptPath = path.join(tempDir, "script.txt");
    const projectPath = path.join(tempDir, "project.json");
    await fs.writeFile(scriptPath, String(project.code ?? ""), { encoding: "utf8", mode: 0o600 });
    await fs.writeFile(projectPath, JSON.stringify({
      projectId: project.projectId,
      title: project.title,
      folder: project.folder,
      tags: project.tags ?? [],
      canvasMode: project.canvasMode,
      revision: project.revision,
      exportedAt: new Date().toISOString(),
      versions: versions.map((version) => ({
        versionId: version.versionId,
        label: version.label,
        trigger: version.trigger,
        canvasMode: version.canvasMode,
        createdAt: version.createdAt,
        code: version.code,
      })),
    }, null, 2), { encoding: "utf8", mode: 0o600 });

    const zip = createZipBuffer([
      { name: "script.txt", sourcePath: scriptPath },
      { name: "project.json", sourcePath: projectPath },
    ], { maxTotalBytes: 8 * 1024 * 1024 });

    const asset = await createGeoGebraAssetFromBuffer(job.ownerUserId, "export-bundle", zip.buffer, "application/zip");
    return {
      summary: "打包完成，可以下载了。",
      commands: [],
      notes: [
        `包含 ${zip.entries} 个文件${zip.skipped > 0 ? `，跳过 ${zip.skipped} 个` : ""}。`,
        "下载链接在有效期内可重复使用。",
      ],
      confidence: null,
      assetId: asset.assetId,
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function runAiJob(job: { ownerUserId: string; kind: string; input: Record<string, unknown> }): Promise<GeoGebraJobResult> {
  const kind = job.kind as GeoGebraAiKind;
  const referenceAssetId = String(job.input.referenceAssetId ?? "");
  let referenceImageDataUrl: string | undefined;
  if (referenceAssetId) {
    const asset = await readGeoGebraAsset(job.ownerUserId, referenceAssetId);
    referenceImageDataUrl = `data:${asset.mimeType};base64,${asset.bytes.toString("base64")}`;
  }
  try {
    const result = await requestGeoGebraAi({
      kind,
      canvasMode: String(job.input.canvasMode ?? "geometry"),
      code: String(job.input.code ?? ""),
      prompt: typeof job.input.prompt === "string" && job.input.prompt ? job.input.prompt : undefined,
      objectNames: Array.isArray(job.input.objectNames)
        ? job.input.objectNames.filter((name): name is string => typeof name === "string")
        : undefined,
      focusObject: typeof job.input.focusObject === "string" && job.input.focusObject ? job.input.focusObject : undefined,
      referenceImageDataUrl,
    });
    return {
      summary: result.summary,
      commands: result.commands,
      notes: result.notes,
      confidence: result.confidence,
    };
  } finally {
    // 参考图只在这一次调用里需要：用完即删，比等 TTL 到期更符合「输入不长期保留」。
    if (referenceAssetId) await deleteGeoGebraAsset(job.ownerUserId, referenceAssetId).catch(() => undefined);
  }
}

export async function runGeoGebraJobTick(leaseOwner: string = runnerOwner): Promise<{ processed: boolean }> {
  const now = new Date();
  const claimed = await GeoGebraJobModel.findOneAndUpdate(
    { status: "queued", expiresAt: { $gt: now } },
    {
      $set: { status: "running", leaseOwner, leaseExpiresAt: new Date(now.getTime() + LEASE_MS), updatedAt: now },
      $inc: { attempts: 1 },
    },
    { sort: { createdAt: 1 }, returnDocument: "after" },
  ).lean();

  if (!claimed) {
    await releaseStaleLeases(now);
    return { processed: false };
  }

  const job = claimed as unknown as { jobId: string; kind: GeoGebraJobKind; ownerUserId: string; input: Record<string, unknown> };
  try {
    const result = job.kind === "export" ? await runExportJob(job) : await runAiJob(job);
    // 只有仍由本次租约持有、且仍处于 running 的任务才写结果：
    // 用户中途取消、或租约已被别人接管时，结果必须丢弃而不是覆盖状态。
    await GeoGebraJobModel.updateOne(
      { jobId: job.jobId, leaseOwner, status: "running" },
      { $set: { status: "completed", progress: 100, result, errorCode: null, errorMessage: null, leaseOwner: null, leaseExpiresAt: null, updatedAt: new Date() } },
    );
  } catch (error) {
    const domainError = error instanceof GeoGebraDomainError ? error : null;
    await GeoGebraJobModel.updateOne(
      { jobId: job.jobId, leaseOwner, status: "running" },
      {
        $set: {
          status: "failed",
          errorCode: domainError?.code ?? "GEOGEBRA_JOB_FAILED",
          errorMessage: domainError?.message ?? "任务暂时无法完成，请重试。",
          leaseOwner: null,
          leaseExpiresAt: null,
          updatedAt: new Date(),
        },
      },
    );
  }
  return { processed: true };
}

const runnerOwner = `geogebra-runner-${process.pid}`;
let runnerTimer: NodeJS.Timeout | null = null;
let runnerRunning = false;

/**
 * 供管理诊断（GEO-22）读取的 worker/队列静态信息。
 * 只报进程内可核对的事实：调度方式、runner 是否已启动、租约与单用户并发上限；
 * 进程内 runner 没有「空闲 worker 数」这种可观测值，所以不提供该字段（不编数字）。
 */
export function getGeoGebraJobRunnerStatus(): {
  scheduler: "in-process";
  running: boolean;
  pid: number;
  tickMs: number;
  leaseMs: number;
  maxActiveJobsPerUser: number;
} {
  return {
    scheduler: "in-process",
    running: runnerTimer !== null,
    pid: process.pid,
    tickMs: TICK_MS,
    leaseMs: LEASE_MS,
    maxActiveJobsPerUser: MAX_ACTIVE_JOBS_PER_USER,
  };
}

/** 单进程内只有一个 runner：多实例部署时靠租约互斥，不靠进程数。 */
export function startGeoGebraJobRunner(): void {
  if (runnerTimer) return;
  runnerTimer = setInterval(() => {
    if (runnerRunning) return;
    runnerRunning = true;
    void runGeoGebraJobTick()
      .catch(() => undefined)
      .finally(() => { runnerRunning = false; });
  }, TICK_MS);
  runnerTimer.unref?.();
}

export function stopGeoGebraJobRunner(): void {
  if (!runnerTimer) return;
  clearInterval(runnerTimer);
  runnerTimer = null;
}

export const GEOGEBRA_JOB_KINDS_FOR_TEST = GEOGEBRA_JOB_KINDS;
