// doc-tool「Markdown → Word 批量转换」用户态 HTTP 路由（挂载在 /api/doc-tool，登录即可用）。
//
// 与 admin 版 media-tool 路由的三点差异：
//   1) 守卫是登录态（authenticateToken 挂在挂载层，见 routeModules/postTamperModules.ts），不要求管理员角色；
//   2) 每个端点第一步 resolveUser，拿不到就 401；所有读写都限定在 resolveUserRoot(userId, workRoot) 内，
//      用户输入的路径一律 sanitizeRelPath + relInside 双校验，越界返回 400（不是 500）；
//   3) 任务归属按 job.userId 复核，不属于当前用户一律 404 —— 刻意不用 403：403 会告诉调用者
//      「这个任务确实存在，只是不是你的」，等于把他人任务 id 的存在性泄露出去。
//
// 限流不在本 router 内重复挂载：routeLimiterModules 的 doc-tool-limiter 已覆盖整棵 /api/doc-tool，
// 在这里再挂同一个实例只会把同一个配额桶分走两份（CodeQL 的 missing-rate-limiting 用行内注记交代来源）。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express, { type Request, type Response } from "express";
import multer from "multer";
import logger from "../../utils/logger";
import { buildReferenceDoc, buildReport, describeFile, destForFile } from "../converter";
import { purgeDocArtifacts, sweepExpiredArtifacts } from "../jobs/docArtifactCleanup";
import type { DocJobRunner } from "../jobs/docJobRunner";
import type { DocJobStore } from "../jobs/docJobStore";
import {
  collectMarkdown,
  ensureDir,
  isMarkdownFile,
  probePandoc,
  relInside,
  resolveUserRoot,
  sanitizeFileName,
  sanitizeRelPath,
  statOrNull,
  uniqueDestPath,
} from "../runtime";
import type { DocSettingsStore } from "../settingsStore";
import {
  normalizeConflict,
  normalizeOutMode,
  type ConflictMode,
  type CreateJobInput,
  type DocFileEntry,
  type DocJobRecord,
  type DocLimits,
  type DocPrefs,
  type PandocStatus,
  type ReferenceTemplate,
} from "../types";
import { createZipBuffer } from "../zipStore";

export interface DocToolRouterDeps {
  store: DocJobStore;
  settingsStore: DocSettingsStore;
  runner: DocJobRunner;
  /** 工作根（不含 users 层）；用户实际目录由 resolveUserRoot(userId, workRoot) 拼出。 */
  workRoot: string;
  limits: DocLimits;
  pandocBin: string;
  /** 挂载层已保证登录；返回 null 视为未登录（同时兜住直挂 router 的单测场景）。 */
  resolveUser(req: Request): { id: string; username: string } | null;
  /** 覆盖 pandoc 探测（单测注入假实现；生产不传，走 runtime.probePandoc）。 */
  probePandoc?(bin: string): PandocStatus;
}

/** 任务 id 前缀：与 mediaTool 的 mt-/st- 一样，日志里一眼能认出子系统。 */
function genJobId(): string {
  return `dj-${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`;
}

const mb = (bytes: number): string => `${Math.round((bytes / 1024 / 1024) * 10) / 10} MB`;
const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** multer 的报错码 → 中文可读原因（只讲「现在什么状态」，实现细节留给日志）。 */
function uploadErrorMessage(err: unknown, limits: DocLimits): string {
  const code = (err as { code?: string }).code || "";
  if (code === "LIMIT_FILE_SIZE") return `单个文件超过 ${mb(limits.maxFileBytes)} 上限`;
  if (code === "LIMIT_FILE_COUNT") return `单次最多上传 ${limits.maxFilesPerJob} 个文件`;
  if (code === "LIMIT_UNEXPECTED_FILE") return "文件字段名必须是 files";
  return errMessage(err) || "上传失败";
}

/** GET /settings 里的模板清单：只列用户目录 templates/ 下的 .docx。 */
function listTemplates(userRoot: string): ReferenceTemplate[] {
  const dir = path.join(userRoot, "templates");
  const dirStat = statOrNull(dir);
  if (!dirStat?.isDirectory()) return [];
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => !name.startsWith(".") && /\.docx$/i.test(name))
    .map((name) => {
      const stat = statOrNull(path.join(dir, name));
      if (!stat?.isFile()) return null;
      return { name, rel: `templates/${name}`, sizeBytes: stat.size, mtime: stat.mtimeMs };
    })
    .filter((entry): entry is ReferenceTemplate => entry !== null)
    .sort((a, b) => a.name.localeCompare(b.name, "zh"));
}

export function createDocToolRouter(deps: DocToolRouterDeps): express.Router {
  const { store, settingsStore, runner } = deps;
  const probePandocFn = deps.probePandoc ?? probePandoc;
  const router = express.Router();

  /** 探测结果按需现取：容器里装了/卸了 pandoc 都该在下次打开页面时如实反映。 */
  const probe = (): PandocStatus => probePandocFn(deps.pandocBin);

  interface Ctx {
    user: { id: string; username: string };
    /** 当前用户专属根目录：所有路径都必须落在它之内。 */
    userRoot: string;
    /** 对外相对路径（相对 userRoot）→ 绝对路径；越界/非法一律 null。 */
    resolveUserPath(rel: string): string | null;
    /** 绝对路径 → 相对 userRoot 的 posix 路径；不在用户目录内 null。 */
    toApiRel(abs: string): string | null;
  }

  const ctx = (req: Request, res: Response): Ctx | null => {
    const user = deps.resolveUser(req);
    if (!user) {
      res.status(401).json({ ok: false, error: "未登录" });
      return null;
    }
    const userRoot = resolveUserRoot(user.id, deps.workRoot);
    ensureDir(userRoot);
    const resolveUserPath = (rel: string): string | null => {
      const clean = sanitizeRelPath(rel);
      if (!clean) return null;
      const abs = path.resolve(userRoot, clean);
      return relInside(userRoot, abs) === null ? null : abs;
    };
    return { user, userRoot, resolveUserPath, toApiRel: (abs: string) => relInside(userRoot, abs) };
  };

  /** 单条上传文件 → 界面条目（destRel 随 conflict 策略变化，必须与转换时用同一函数算）。 */
  const describeEntry = (c: Ctx, prefs: DocPrefs, abs: string, conflict: ConflictMode): DocFileEntry | null => {
    const rel = relInside(c.userRoot, abs);
    if (rel === null || rel === "") return null;
    const dest = destForFile({ userRoot: c.userRoot, rel, outMode: prefs.outMode, outDir: prefs.outDir });
    const described = describeFile({ src: abs, dest, conflict });
    return {
      rel,
      sizeBytes: described.sizeBytes,
      mtime: described.mtime,
      destRel: relInside(c.userRoot, described.dest) ?? "",
      status: described.status,
      willRename: described.willRename,
    };
  };

  /** 归属复核：不是自己的任务按「不存在」处理（404），不泄露他人任务是否存在。 */
  const ownJob = async (req: Request, res: Response, c: Ctx): Promise<DocJobRecord | null> => {
    const id = String(req.params.id ?? "").trim();
    const job = id ? await store.get(id) : null;
    if (!job || job.userId !== c.user.id) {
      res.status(404).json({ ok: false, error: "任务不存在" });
      return null;
    }
    return job;
  };

  /** 引擎不可用统一出口：用户可见文案只讲「不可用」，诊断信息收进 detail。 */
  const engineUnavailable = (res: Response, pandoc: PandocStatus): void => {
    res.status(503).json({
      ok: false,
      error: "转换引擎不可用",
      detail: pandoc.error || `未找到可用的 pandoc（${pandoc.bin}）`,
    });
  };

  // ---- 能力与限额（页面初始化） ----
  // codeql[js/missing-rate-limiting] 整棵 /api/doc-tool 在 routeLimiterModules 的 doc-tool-limiter 下；router 内重复挂会分走配额
  router.get("/health", (req: Request, res: Response) => {
    try {
      const c = ctx(req, res);
      if (!c) return;
      const pandoc = probe();
      res.json({
        ok: pandoc.available,
        pandoc,
        workDir: deps.workRoot,
        limits: deps.limits,
        // 限额的唯一来源是环境变量（docLimitsFromEnv）：保留该字段是为了前端能说明「来自部署配置」
        limitsSource: "env",
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: errMessage(e) });
    }
  });

  // codeql[js/missing-rate-limiting] 同上：挂载层 doc-tool-limiter 已覆盖
  router.get("/settings", async (req: Request, res: Response) => {
    try {
      const c = ctx(req, res);
      if (!c) return;
      res.json({
        ok: true,
        pandoc: probe(),
        limits: deps.limits,
        prefs: await settingsStore.get(c.user.id),
        templates: listTemplates(c.userRoot),
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: errMessage(e) });
    }
  });

  // codeql[js/missing-rate-limiting] 同上
  router.put("/settings", async (req: Request, res: Response) => {
    try {
      const c = ctx(req, res);
      if (!c) return;
      // 白名单化交给 settingsStore.update：它只认 DocPrefs 的五个键，非法值回落默认而不是 400
      const patch = ((req.body ?? {}) as { prefs?: Partial<DocPrefs> }).prefs ?? {};
      res.json({ ok: true, prefs: await settingsStore.update(c.user.id, patch) });
    } catch (e) {
      res.status(500).json({ ok: false, error: errMessage(e) });
    }
  });

  // ---- 已上传的 .md（上传落在 <userRoot>/inbox/，所以列表与任务里的 rel 都带 inbox/ 前缀） ----
  // codeql[js/missing-rate-limiting] 同上
  router.get("/files", async (req: Request, res: Response) => {
    try {
      const c = ctx(req, res);
      if (!c) return;
      const prefs = await settingsStore.get(c.user.id);
      const rawRecursive = String(req.query.recursive ?? "").trim();
      const recursive = rawRecursive === "" ? prefs.recursive : rawRecursive !== "false" && rawRecursive !== "0";
      const conflict = req.query.conflict === undefined ? prefs.conflict : normalizeConflict(req.query.conflict);
      // 输出位置也影响「会写出哪个文件」（alongside 还是 outDir 下），而界面上改了未提交时
      // 列表必须跟着变 —— 否则安检预告的名字会与真实落点分叉。没传就沿用已保存的偏好。
      const outMode = req.query.outMode === undefined ? prefs.outMode : normalizeOutMode(req.query.outMode);
      const outDirFromQuery = sanitizeRelPath(String(req.query.outDir ?? ""));
      const outDir = req.query.outDir === undefined ? prefs.outDir : outDirFromQuery ?? "";
      const effectivePrefs: DocPrefs = { ...prefs, conflict, outMode, outDir, recursive };
      const inbox = path.join(c.userRoot, "inbox");
      const files = collectMarkdown(inbox, recursive)
        .map((abs) => describeEntry(c, effectivePrefs, abs, conflict))
        .filter((entry): entry is DocFileEntry => entry !== null);
      res.json({
        ok: true,
        files,
        counts: {
          total: files.length,
          new: files.filter((f) => f.status === "new").length,
          stale: files.filter((f) => f.status === "stale").length,
          fresh: files.filter((f) => f.status === "fresh").length,
        },
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: errMessage(e) });
    }
  });

  // ---- 上传到用户目录 inbox ----
  // codeql[js/missing-rate-limiting] 同上
  router.post("/upload", async (req: Request, res: Response) => {
    if (!/multipart\/form-data/i.test(String(req.headers["content-type"] || ""))) {
      res.status(400).json({ ok: false, error: "未收到文件：请以 multipart/form-data 提交（字段名 files）" });
      return;
    }
    const c = ctx(req, res);
    if (!c) return;
    let inbox = "";
    try {
      inbox = path.join(c.userRoot, "inbox");
      ensureDir(inbox);
    } catch (e) {
      res.status(500).json({ ok: false, error: errMessage(e) });
      return;
    }

    // multer 先写进 inbox 的临时名：真正落点要按 relPaths 还原目录结构，而 relPaths 是
    // 文件之后才到达的文本字段，落盘时还读不到（见下方按序搬运）。
    const upload = multer({
      storage: multer.diskStorage({
        destination: (_req, _file, cb) => cb(null, inbox),
        filename: (_req, _file, cb) => cb(null, `upload-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`),
      }),
      fileFilter: (_req, file, cb) => {
        if (!isMarkdownFile(file.originalname)) {
          cb(new Error("仅支持 .md / .markdown 文件"));
          return;
        }
        cb(null, true);
      },
      limits: { fileSize: deps.limits.maxFileBytes, files: deps.limits.maxFilesPerJob },
    }).array("files");

    try {
      await new Promise<void>((resolve, reject) => {
        upload(req, res, (err) => (err ? reject(err) : resolve()));
      });
    } catch (err) {
      res.status(400).json({ ok: false, error: uploadErrorMessage(err, deps.limits) });
      return;
    }

    const uploaded = ((req as Request & { files?: Express.Multer.File[] }).files ?? []).filter((f) => f?.path);
    const removeTemp = (file: Express.Multer.File): void => {
      try {
        fs.rmSync(file.path, { force: true });
      } catch {
        // best-effort：临时文件删不掉不影响本次上传的结论
      }
    };
    if (uploaded.length === 0) {
      res.status(400).json({ ok: false, error: "未收到文件：multipart 里没有名为 files 的部分" });
      return;
    }
    const totalBytes = uploaded.reduce((sum, file) => sum + (statOrNull(file.path)?.size ?? 0), 0);
    if (totalBytes > deps.limits.maxUploadBytes) {
      for (const file of uploaded) removeTemp(file);
      res.status(400).json({ ok: false, error: `上传总大小超过 ${mb(deps.limits.maxUploadBytes)} 上限` });
      return;
    }

    // relPaths 与 files 严格同序；缺失/非法/非 .md 一律回落到 originalname，保证不丢文件。
    const body = (req.body ?? {}) as { relPaths?: unknown };
    const rawRel = body.relPaths;
    const relPaths: string[] = Array.isArray(rawRel) ? rawRel.map((v) => String(v)) : rawRel ? [String(rawRel)] : [];
    const prefs = await settingsStore.get(c.user.id);

    const files: DocFileEntry[] = [];
    const rejected: Array<{ name: string; reason: string }> = [];
    for (let i = 0; i < uploaded.length; i++) {
      const file = uploaded[i];
      const originalName = path.basename(String(file.originalname || file.filename || "file.md"));
      const requested = relPaths[i] ? sanitizeRelPath(relPaths[i]) : null;
      const rel = requested && isMarkdownFile(requested) ? requested : sanitizeFileName(originalName, "file.md");
      // 逐段清洗：sanitizeRelPath 只挡 .. / 盘符 / 控制字符，Windows 保留字符留给 sanitizeFileName
      const safeRel = rel
        .split("/")
        .filter((segment) => segment && segment !== ".")
        .map((segment) => sanitizeFileName(segment, "file.md"))
        .join("/");
      const destRel = `inbox/${safeRel}`;
      const destAbs = c.resolveUserPath(destRel);
      if (!destAbs) {
        rejected.push({ name: originalName, reason: "文件路径非法或越界" });
        removeTemp(file);
        continue;
      }
      try {
        ensureDir(path.dirname(destAbs));
        // 同名重传＝覆盖上一份副本（multer 已把内容落到临时名，rename 是同一分区内的原子替换）
        fs.rmSync(destAbs, { force: true });
        fs.renameSync(file.path, destAbs);
      } catch (err) {
        rejected.push({ name: originalName, reason: `写入失败：${errMessage(err)}` });
        removeTemp(file);
        continue;
      }
      const entry = describeEntry(c, prefs, destAbs, prefs.conflict);
      if (entry) files.push(entry);
      else rejected.push({ name: originalName, reason: "文件路径非法或越界" });
    }

    res.json({ ok: true, files, rejected });
  });

  // ---- 建任务 ----
  // codeql[js/missing-rate-limiting] 同上
  router.post("/jobs", async (req: Request, res: Response) => {
    try {
      const c = ctx(req, res);
      if (!c) return;
      // 引擎不可用是服务级前置条件：先给结论，不让用户在一堆路径校验之后才知道跑不了
      const pandoc = probe();
      if (!pandoc.available) {
        engineUnavailable(res, pandoc);
        return;
      }
      const prefs = await settingsStore.get(c.user.id);
      const body = (req.body ?? {}) as CreateJobInput;

      const requested = (Array.isArray(body.files) ? body.files : [])
        .map((rel) => String(rel ?? "").trim())
        .filter(Boolean);
      const recursive = typeof body.recursive === "boolean" ? body.recursive : prefs.recursive;
      // files 与 recursive 二选一：给了 files 就只转这些，否则按 recursive 扫 inbox
      const rels = requested.length
        ? requested
        : collectMarkdown(path.join(c.userRoot, "inbox"), recursive)
            .map((abs) => relInside(c.userRoot, abs))
            .filter((rel): rel is string => rel !== null && rel !== "");

      if (rels.length === 0) {
        res.status(400).json({ ok: false, error: "没有可转换的 Markdown 文件，请先上传 .md" });
        return;
      }
      if (rels.length > deps.limits.maxFilesPerJob) {
        res.status(400).json({
          ok: false,
          error: `单次最多 ${deps.limits.maxFilesPerJob} 个文件，本次 ${rels.length} 个`,
        });
        return;
      }
      const active = await store.countActive(c.user.id);
      if (active >= deps.limits.maxActiveJobs) {
        res.status(429).json({
          ok: false,
          error: `已有 ${active} 个任务在排队或运行，请等完成后再提交`,
        });
        return;
      }

      const checked: string[] = [];
      for (const rel of rels) {
        const abs = c.resolveUserPath(rel);
        if (!abs) {
          res.status(400).json({ ok: false, error: `非法文件路径：${rel}` });
          return;
        }
        const stat = statOrNull(abs);
        if (!stat?.isFile() || !isMarkdownFile(abs)) {
          res.status(400).json({ ok: false, error: `文件不存在或不是 Markdown：${rel}` });
          return;
        }
        checked.push(rel);
      }

      const outMode = body.outMode === undefined ? prefs.outMode : normalizeOutMode(body.outMode);
      const outDir = body.outDir === undefined ? prefs.outDir : sanitizeRelPath(body.outDir) ?? prefs.outDir;
      const conflict = body.conflict === undefined ? prefs.conflict : normalizeConflict(body.conflict);
      let referenceDoc = prefs.referenceDoc;
      if (body.referenceDoc !== undefined) {
        const raw = String(body.referenceDoc ?? "").trim();
        if (raw === "") {
          referenceDoc = "";
        } else {
          const abs = c.resolveUserPath(raw);
          if (!abs) {
            res.status(400).json({ ok: false, error: "参考样式文件路径非法" });
            return;
          }
          if (!statOrNull(abs)?.isFile()) {
            res.status(400).json({ ok: false, error: "参考样式文件不存在或不可读" });
            return;
          }
          referenceDoc = relInside(c.userRoot, abs) ?? "";
        }
      }

      const record: DocJobRecord = {
        id: genJobId(),
        userId: c.user.id,
        createdBy: c.user.username || c.user.id,
        createdAt: new Date(),
        status: "queued",
        stage: "排队中",
        progress: 0,
        total: checked.length,
        done: 0,
        ok: 0,
        skipped: 0,
        failed: 0,
        input: { files: checked, outMode, outDir, conflict, referenceDoc },
        items: [],
        logs: [],
        cancelRequested: false,
      };
      await store.create(record);
      runner.enqueue(record.id);
      logger.info("[doc-tool] 创建转换任务", {
        userId: c.user.id,
        jobId: record.id,
        files: checked.length,
        outMode,
        conflict,
      });
      res.json({ ok: true, jobId: record.id });
    } catch (e) {
      res.status(500).json({ ok: false, error: errMessage(e) });
    }
  });

  // codeql[js/missing-rate-limiting] 同上
  router.get("/jobs", async (req: Request, res: Response) => {
    try {
      const c = ctx(req, res);
      if (!c) return;
      const parsed = Number.parseInt(String(req.query.limit ?? "20"), 10);
      const limit = Number.isFinite(parsed) ? Math.max(1, Math.min(parsed, 100)) : 20;
      const jobs = await store.list(c.user.id, limit);
      // 列表只带日志尾部：详情页才需要完整「详情」折叠区
      res.json({ ok: true, jobs: jobs.map((job) => ({ ...job, logs: job.logs.slice(-20) })) });
    } catch (e) {
      res.status(500).json({ ok: false, error: errMessage(e) });
    }
  });

  // codeql[js/missing-rate-limiting] 同上
  router.get("/jobs/:id", async (req: Request, res: Response) => {
    try {
      const c = ctx(req, res);
      if (!c) return;
      const job = await ownJob(req, res, c);
      if (!job) return;
      res.json({ ok: true, job });
    } catch (e) {
      res.status(500).json({ ok: false, error: errMessage(e) });
    }
  });

  // codeql[js/missing-rate-limiting] 同上
  router.post("/jobs/:id/cancel", async (req: Request, res: Response) => {
    try {
      const c = ctx(req, res);
      if (!c) return;
      const job = await ownJob(req, res, c);
      if (!job) return;
      if (["succeeded", "partial", "failed", "cancelled"].includes(job.status)) {
        // 已经是终态：取消是幂等的，直接回现状
        res.json({ ok: true, job });
        return;
      }
      runner.cancel(job.id);
      // 队列里的任务会由 runner 自己落成 cancelled；本进程已没有执行体的（历史遗留的
      // 「运行中」僵尸）没人会再写它的状态，这里直接落终态，否则永远取消不掉。
      if (!runner.isActive(job.id)) {
        await store.patch(job.id, { status: "cancelled", stage: "已取消", finishedAt: new Date() });
      }
      res.json({ ok: true, job: (await store.get(job.id)) ?? job });
    } catch (e) {
      res.status(500).json({ ok: false, error: errMessage(e) });
    }
  });

  // codeql[js/missing-rate-limiting] 同上
  router.delete("/jobs/:id", async (req: Request, res: Response) => {
    try {
      const c = ctx(req, res);
      if (!c) return;
      const job = await ownJob(req, res, c);
      if (!job) return;
      if (job.status === "running") {
        res.status(409).json({ ok: false, error: "任务运行中，请先取消再删除" });
        return;
      }
      // 只清产物，保留用户上传的原稿（keepInputs 默认 true）：任务删了也该还能再转一次
      const removedFiles = purgeDocArtifacts(job, c.userRoot);
      await store.remove(job.id);
      logger.info("[doc-tool] 删除转换任务", { userId: c.user.id, jobId: job.id, removedFiles });
      res.json({ ok: true, removedFiles });
    } catch (e) {
      res.status(500).json({ ok: false, error: errMessage(e) });
    }
  });

  // codeql[js/missing-rate-limiting] 同上
  router.get("/jobs/:id/report", async (req: Request, res: Response) => {
    try {
      const c = ctx(req, res);
      if (!c) return;
      const job = await ownJob(req, res, c);
      if (!job) return;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${job.id}.txt"`);
      res.send(buildReport(job));
    } catch (e) {
      res.status(500).json({ ok: false, error: errMessage(e) });
    }
  });

  // codeql[js/missing-rate-limiting] 同上
  router.get("/jobs/:id/bundle", async (req: Request, res: Response) => {
    try {
      const c = ctx(req, res);
      if (!c) return;
      const job = await ownJob(req, res, c);
      if (!job) return;
      const entries = job.items
        .filter((item) => item.status === "ok" && item.destRel)
        .map((item) => {
          const abs = c.resolveUserPath(item.destRel);
          // 产物已不在磁盘（被清/换盘）时跳过：打包是尽力而为，不该因一件缺失就整体失败
          return abs && statOrNull(abs)?.isFile() ? { name: item.destRel, sourcePath: abs } : null;
        })
        .filter((entry): entry is { name: string; sourcePath: string } => entry !== null);
      const zip = createZipBuffer(entries);
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="${job.id}.zip"`);
      res.send(zip.buffer);
    } catch (e) {
      res.status(500).json({ ok: false, error: errMessage(e) });
    }
  });

  // codeql[js/missing-rate-limiting] 同上
  router.get("/files/download", async (req: Request, res: Response) => {
    try {
      const c = ctx(req, res);
      if (!c) return;
      const rel = String(req.query.path ?? "").trim();
      if (!rel) {
        res.status(400).json({ ok: false, error: "缺少 path 参数" });
        return;
      }
      const abs = c.resolveUserPath(rel);
      if (!abs) {
        res.status(400).json({ ok: false, error: "非法文件路径" });
        return;
      }
      if (!statOrNull(abs)?.isFile()) {
        res.status(404).json({ ok: false, error: "文件不存在" });
        return;
      }
      // 只回 basename：不把用户目录结构（含 uid 摘要）写进响应头
      res.download(abs, path.basename(abs));
    } catch (e) {
      res.status(500).json({ ok: false, error: errMessage(e) });
    }
  });

  // codeql[js/missing-rate-limiting] 同上
  router.post("/templates", async (req: Request, res: Response) => {
    try {
      const c = ctx(req, res);
      if (!c) return;
      const pandoc = probe();
      if (!pandoc.available) {
        engineUnavailable(res, pandoc);
        return;
      }
      const requestBody = (req.body ?? {}) as { name?: unknown };
      const requested = typeof requestBody.name === "string" ? requestBody.name : "";
      const baseName = sanitizeFileName(requested.replace(/\\/g, "/").split("/").pop() || "", "reference.docx");
      const fileName = /\.docx$/i.test(baseName) ? baseName : `${baseName}.docx`;
      const dir = path.join(c.userRoot, "templates");
      ensureDir(dir);
      // 同名模板不覆盖旧文件：用户可能已经在 Word 里改过它
      const dest = uniqueDestPath(path.join(dir, fileName));
      const result = await buildReferenceDoc({ pandoc: deps.pandocBin, dest });
      if (!result.ok) {
        res.status(500).json({ ok: false, error: "生成默认样式模板失败", detail: result.error || "" });
        return;
      }
      const rel = relInside(c.userRoot, dest) ?? "";
      logger.info("[doc-tool] 生成默认样式模板", { userId: c.user.id, rel, sizeBytes: result.sizeBytes });
      res.json({
        ok: true,
        template: { name: path.basename(dest), rel, sizeBytes: result.sizeBytes ?? 0, mtime: Date.now() },
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: errMessage(e) });
    }
  });

  // codeql[js/missing-rate-limiting] 同上
  router.post("/cleanup", async (req: Request, res: Response) => {
    try {
      const c = ctx(req, res);
      if (!c) return;
      const parsed = Number(((req.body ?? {}) as { keepDays?: unknown }).keepDays);
      const keepDays = Number.isFinite(parsed) && parsed > 0 ? parsed : deps.limits.retentionDays;
      const removed = sweepExpiredArtifacts(c.userRoot, keepDays);
      logger.info("[doc-tool] 清理过期产物", { userId: c.user.id, removed, keepDays });
      res.json({ ok: true, removed, keepDays });
    } catch (e) {
      res.status(500).json({ ok: false, error: errMessage(e) });
    }
  });

  return router;
}
