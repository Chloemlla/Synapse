import fs from "node:fs";
import path from "node:path";
import { DocToolJobModel } from "../../models/docToolModels";
import { purgeDocArtifacts, sweepExpiredArtifacts } from "../jobs/docArtifactCleanup";
import { probePandoc, resolveDocToolRoot, resolvePandocBin, resolveUserRoot, relInside } from "../runtime";
import { docLimitsFromEnv, type DocJobRecord } from "../types";
import { UserStorage } from "../../utils/userStorage";
import logger from "../../utils/logger";

/**
 * doc-tool 的管理端只读运维视图（页面 `/admin/doc-tool`）。
 *
 * 为什么需要它：批量转换是「用户上传文件 → 服务端 pandoc 转换 → 产物落在容器本地盘」，
 * 但用户侧页面只看得到自己的任务。运维要回答的是另一组问题：
 *   - 引擎（pandoc）在这台机器上到底可用吗、工作根目录可写吗；
 *   - 队列里积压了多少、有多少失败、产物占了多大磁盘、谁占的；
 *   - 清理能回收多少（先预演再执行）。
 *
 * 四条硬约束：
 *   1. **不提供跨用户文件下载**：这里只回目录占用与任务元数据，用户文件内容不属于运维视图。
 *   2. 所有路径解析继续走 `runtime.ts` 的 `relInside` / `resolveUserRoot` 守界；
 *      扫描目录时跳过符号链接（`lstat`），避免顺链走出工作根。
 *   3. 删除沿用既有实现（`purgeDocArtifacts` / `sweepExpiredArtifacts`），不另写一套删除逻辑。
 *   4. 扫描有上限（用户目录数、单用户条目数），扫描超限如实标注 `truncated`，不静默少算。
 */

const MAX_USER_DIRS = 300;
const MAX_ENTRIES_PER_DIR = 5000;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;

export interface DocToolStorageRow {
  userId: string;
  username: string | null;
  inboxFiles: number;
  outFiles: number;
  totalBytes: number;
  lastModifiedAt: string | null;
  truncated: boolean;
}

function toIso(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
  }
  return null;
}

/** 目录统计：只算普通文件，跳过符号链接（防顺链走出工作根）。 */
function measureDir(dir: string): { files: number; bytes: number; lastModifiedAt: number | null; truncated: boolean } {
  let files = 0;
  let bytes = 0;
  let lastModifiedAt: number | null = null;
  let truncated = false;
  const stack: Array<{ dir: string; depth: number }> = [{ dir, depth: 0 }];
  let visited = 0;

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.depth > 12) continue;
    let names: string[];
    try {
      names = fs.readdirSync(current.dir);
    } catch {
      continue;
    }
    for (const name of names) {
      visited += 1;
      if (visited > MAX_ENTRIES_PER_DIR) {
        truncated = true;
        stack.length = 0;
        break;
      }
      const abs = path.resolve(current.dir, name);
      if (relInside(dir, abs) === null) continue;
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(abs);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        stack.push({ dir: abs, depth: current.depth + 1 });
        continue;
      }
      if (!stat.isFile()) continue;
      files += 1;
      bytes += stat.size;
      const mtime = stat.mtimeMs;
      if (lastModifiedAt === null || mtime > lastModifiedAt) lastModifiedAt = mtime;
    }
  }

  return { files, bytes, lastModifiedAt, truncated };
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export class DocToolAdminService {
  /** 引擎 + 队列 + 磁盘的一屏结论。 */
  static overview() {
    const limits = docLimitsFromEnv();
    const workRoot = resolveDocToolRoot();
    const pandoc = probePandoc(resolvePandocBin());

    let workRootWritable = false;
    try {
      fs.mkdirSync(workRoot, { recursive: true });
      fs.accessSync(workRoot, fs.constants.W_OK);
      workRootWritable = true;
    } catch {
      workRootWritable = false;
    }

    return {
      pandoc: {
        available: pandoc.available,
        version: pandoc.version || null,
        bin: pandoc.bin,
        error: pandoc.error ?? null,
      },
      workRoot: { writable: workRootWritable },
      limits,
      /** 目录路径只给相对形态，不回宿主绝对路径（避免把部署结构带给前端）。 */
      workRootIsAbsolute: path.isAbsolute(workRoot),
    };
  }

  /** 队列计数与最近任务（跨用户）。 */
  static async overviewCounts() {
    const [queued, running, failed24h, succeeded24h, total] = await Promise.all([
      DocToolJobModel.countDocuments({ status: "queued" }).exec(),
      DocToolJobModel.countDocuments({ status: "running" }).exec(),
      DocToolJobModel.countDocuments({
        status: { $in: ["failed", "partial"] },
        createdAt: { $gte: new Date(Date.now() - 24 * 3600 * 1000) },
      }).exec(),
      DocToolJobModel.countDocuments({
        status: { $in: ["succeeded", "partial"] },
        createdAt: { $gte: new Date(Date.now() - 24 * 3600 * 1000) },
      }).exec(),
      DocToolJobModel.countDocuments({}).exec(),
    ]);
    return { queued, running, failed24h, succeeded24h, total };
  }

  /** 跨用户任务分页（只回元数据，不含 items 正文与日志正文）。 */
  static async listJobs(options: {
    status?: string;
    userId?: string;
    limit?: number;
    offset?: number;
  }) {
    const limit = Math.min(Math.max(Math.floor(Number(options.limit) || DEFAULT_LIMIT), 1), MAX_LIMIT);
    const offset = Math.max(Math.floor(Number(options.offset) || 0), 0);
    const filter: Record<string, unknown> = {};
    if (options.status) filter.status = options.status;
    if (options.userId) filter.userId = options.userId;

    const [docs, total] = await Promise.all([
      DocToolJobModel.find(filter)
        .select("id userId createdBy createdAt startedAt finishedAt status stage progress total ok skipped failed error")
        .sort({ createdAt: -1 })
        .skip(offset)
        .limit(limit)
        .lean()
        .exec(),
      DocToolJobModel.countDocuments(filter).exec(),
    ]);

    return {
      total,
      limit,
      offset,
      jobs: (docs as unknown as Array<Record<string, unknown>>).map((doc) => ({
        id: readString(doc.id),
        userId: readString(doc.userId),
        createdBy: readString(doc.createdBy) || null,
        status: readString(doc.status),
        stage: readString(doc.stage) || null,
        progress: Number(doc.progress) || 0,
        total: Number(doc.total) || 0,
        ok: Number(doc.ok) || 0,
        skipped: Number(doc.skipped) || 0,
        failed: Number(doc.failed) || 0,
        error: readString(doc.error) || null,
        createdAt: toIso(doc.createdAt),
        startedAt: toIso(doc.startedAt),
        finishedAt: toIso(doc.finishedAt),
      })),
    };
  }

  /** 单任务详情：含逐文件结果与日志尾部（用于排查「为什么这个文件没转出来」）。 */
  static async getJob(id: string) {
    const doc = (await DocToolJobModel.findOne({ id }).lean().exec()) as unknown as Record<string, unknown> | null;
    if (!doc) return null;
    const items = Array.isArray(doc.items) ? (doc.items as Array<Record<string, unknown>>) : [];
    const logs = Array.isArray(doc.logs) ? (doc.logs as Array<Record<string, unknown>>) : [];
    return {
      id: readString(doc.id),
      userId: readString(doc.userId),
      status: readString(doc.status),
      stage: readString(doc.stage) || null,
      error: readString(doc.error) || null,
      createdAt: toIso(doc.createdAt),
      finishedAt: toIso(doc.finishedAt),
      items: items.slice(0, 200).map((item) => ({
        sourceRel: readString(item.sourceRel),
        destRel: readString(item.destRel) || null,
        status: readString(item.status),
        error: readString(item.error) || null,
      })),
      logs: logs.slice(-100).map((log) => ({
        at: toIso(log.at),
        level: readString(log.level),
        message: readString(log.message),
      })),
    };
  }

  /**
   * 每个用户目录的占用（本次服务的运维视图）。
   *
   * 用 `resolveUserRoot` 推目录，但**以磁盘上的实际目录为准**：只扫工作根下一层目录，
   * 反向映射回 userId（目录名即 `userScopedDirName` 的结果），查不到用户名的给 null。
   */
  static async listStorage() {
    const workRoot = resolveDocToolRoot();
    const rows: DocToolStorageRow[] = [];
    let names: string[] = [];
    try {
      names = fs.readdirSync(workRoot);
    } catch {
      return { total: 0, limit: 0, offset: 0, truncated: false, storage: rows };
    }

    const truncated = names.length > MAX_USER_DIRS;
    for (const name of names.slice(0, MAX_USER_DIRS)) {
      const dir = path.resolve(workRoot, name);
      if (relInside(workRoot, dir) === null) continue;
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(dir);
      } catch {
        continue;
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;

      const inbox = measureDir(path.resolve(dir, "inbox"));
      const out = measureDir(path.resolve(dir, "out"));
      const lastModified = Math.max(inbox.lastModifiedAt ?? 0, out.lastModifiedAt ?? 0, stat.mtimeMs);
      rows.push({
        userId: name,
        username: null,
        inboxFiles: inbox.files,
        outFiles: out.files,
        totalBytes: inbox.bytes + out.bytes,
        lastModifiedAt: lastModified > 0 ? new Date(lastModified).toISOString() : null,
        truncated: inbox.truncated || out.truncated,
      });
    }

    // 用户名只在有行时批量补一次；查不到（或多实例下已注销）就保持 null，不回落到 id 拼接。
    if (rows.length > 0) {
      try {
        const users = await UserStorage.getUsersByIds(rows.map((row) => row.userId));
        const byId = new Map(users.map((user) => [String(user.id), String(user.username)]));
        for (const row of rows) row.username = byId.get(row.userId) ?? null;
      } catch (error) {
        logger.warn("[DocToolAdmin] 补用户名失败，按 ID 展示", {
          errorType: error instanceof Error ? error.name : "unknown",
        });
      }
    }

    rows.sort((a, b) => b.totalBytes - a.totalBytes);
    return {
      total: rows.length,
      truncated,
      totalBytes: rows.reduce((sum, row) => sum + row.totalBytes, 0),
      storage: rows,
    };
  }

  /**
   * 清理预演 / 执行。
   *
   * 删除动作完全复用既有实现：
   *   - 过期任务（`finishedAt` 早于保留期）逐条 `purgeDocArtifacts`；
   *   - 每个用户目录再跑一次 `sweepExpiredArtifacts`（覆盖 out/ 下没有任务记录的残留）。
   * `dryRun: true` 只统计数量、不动磁盘。
   */
  static async runCleanup(options: { dryRun?: boolean } = {}) {
    const dryRun = options.dryRun !== false;
    const limits = docLimitsFromEnv();
    const keepDays = limits.retentionDays;
    const cutoff = new Date(Date.now() - keepDays * 24 * 3600 * 1000);
    const workRoot = resolveDocToolRoot();

    const expiredDocs = (await DocToolJobModel.find({ finishedAt: { $lt: cutoff } })
      .select("id userId createdAt finishedAt status items input")
      .lean()
      .exec()) as unknown as Array<Record<string, unknown>>;

    let purgedFiles = 0;
    let sweptFiles = 0;
    const affectedUsers = new Set<string>();

    for (const doc of expiredDocs) {
      const userId = readString(doc.userId);
      if (!userId) continue;
      const userRoot = resolveUserRoot(userId, workRoot);
      if (relInside(workRoot, userRoot) === null) continue;
      if (dryRun) {
        const items = Array.isArray(doc.items) ? (doc.items as Array<Record<string, unknown>>) : [];
        purgedFiles += items.filter((item) => readString(item.status) === "ok" && readString(item.destRel)).length;
      } else {
        const record = doc as unknown as DocJobRecord;
        purgedFiles += purgeDocArtifacts(record, userRoot, { keepInputs: true });
      }
      affectedUsers.add(userId);
    }

    let names: string[] = [];
    try {
      names = fs.readdirSync(workRoot);
    } catch {
      names = [];
    }
    for (const name of names.slice(0, MAX_USER_DIRS)) {
      const userRoot = path.resolve(workRoot, name);
      if (relInside(workRoot, userRoot) === null) continue;
      try {
        if (!fs.lstatSync(userRoot).isDirectory()) continue;
      } catch {
        continue;
      }
      // 预演阶段不统计 out/ 残留：目录级扫描无法区分「过期」与「新写入」，
      // 报一个上限数字会被读成事实。真实执行时由 sweepExpiredArtifacts 给出准确计数。
      if (!dryRun) {
        sweptFiles += sweepExpiredArtifacts(userRoot, keepDays);
      }
    }

    if (!dryRun && expiredDocs.length > 0) {
      await DocToolJobModel.deleteMany({ finishedAt: { $lt: cutoff } }).exec();
    }

    return {
      dryRun,
      keepDays,
      expiredJobs: expiredDocs.length,
      purgedFiles,
      sweptFiles,
      affectedUsers: [...affectedUsers].slice(0, 100),
      note: dryRun
        ? "预演：只统计数量，未改磁盘与数据库。out/ 残留的实际回收量要等真实执行才能确定。"
        : "已按保留期清理过期任务的产物文件，并删除对应任务记录。",
    };
  }
}
