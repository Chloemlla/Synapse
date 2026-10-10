// 单个 md → docx 的转换、目标形态描述、参考样式模板生成与任务报告。
//
// 冲突策略是这里最需要小心的语义（迁入自本机 md2docx，并把它做成默认）：
//   skip      —— 目标已存在就不动（status: "skipped"）
//   rename    —— 目标已存在就另存为「名称 (2).docx」，旧文件一字不改（renamed: true）**默认值**
//   overwrite —— 原地覆盖
// 三种都在同一处判定，避免「扫描时按 rename 显示的徽章」与「转换时实际落点」不一致。
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ensureDir, relInside, runPandoc, statOrNull, uniqueDestPath, type RunPandoc } from "./runtime";
import type { ConflictMode, DocFileFreshness, DocItemStatus, DocJobRecord, OutMode } from "./types";

const fmtKB = (bytes: number): string => `${(bytes / 1024).toFixed(1)} KB`;
const secs = (ms: number): string => (ms / 1000).toFixed(1);
const CONFLICT_LABEL: Record<ConflictMode, string> = {
  skip: "已存在就跳过",
  rename: "已存在就自动重命名（保留旧文件）",
  overwrite: "已存在就覆盖",
};

export interface DescribeFileResult {
  /** 本次会写出的实际目标（rename 模式下已是「会另存为」的新名字） */
  dest: string;
  status: DocFileFreshness;
  willRename: boolean;
  sizeBytes: number;
  mtime: number;
}

/** 源相对路径 → 目标 docx 文件名（保留原来的目录层级由 destForFile 负责）。 */
export function docxNameFor(rel: string): string {
  return `${path.posix.basename(String(rel).replace(/\\/g, "/")).replace(/\.(md|markdown)$/i, "")}.docx`;
}

/**
 * 计算目标 .docx 的**候选**绝对路径（冲突策略的最终名字由 convertOne 决定）。
 *
 * 为什么只能有一份：任务执行时用它决定往哪写，界面的文件列表也用同一函数预告「会另存为 x (2).docx」。
 * 两边各写一份就会出现「列表说写 A、实际写到 B」这类无法自证的偏差 —— 所以它属于共享层，不属于 runner。
 */
export function destForFile(opts: {
  userRoot: string;
  rel: string;
  outMode: OutMode;
  outDir: string;
}): string {
  const posixRel = String(opts.rel).replace(/\\/g, "/");
  const dir = path.posix.dirname(posixRel);
  const docxName = docxNameFor(posixRel);
  if (opts.outMode === "alongside") {
    return path.resolve(opts.userRoot, dir, docxName);
  }
  const outDir = opts.outDir?.trim() || "out";
  return path.resolve(opts.userRoot, outDir, dir === "." ? docxName : `${dir}/${docxName}`);
}

/**
 * 描述「这个 md 转换后会是什么样」。扫描列表的徽章与默认勾选全依赖它，
 * 所以 rename 模式下就把 dest 换成将来真正写出的名字 —— 不能让界面显示 a.docx 却写出 a (2).docx。
 */
export function describeFile(opts: { src: string; dest: string; conflict: ConflictMode }): DescribeFileResult {
  const srcStat = statOrNull(opts.src);
  const sizeBytes = srcStat?.size ?? 0;
  const mtime = srcStat?.mtimeMs ?? 0;
  const destStat = statOrNull(opts.dest);

  if (!destStat) {
    return { dest: opts.dest, status: "new", willRename: false, sizeBytes, mtime };
  }
  if (opts.conflict === "rename") {
    return { dest: uniqueDestPath(opts.dest), status: "new", willRename: true, sizeBytes, mtime };
  }
  // 源比目标新 → 待更新；否则已是最新（overwrite 模式下也照实显示，由用户自己选择要不要覆盖）
  const status: DocFileFreshness = destStat.mtimeMs < mtime ? "stale" : "fresh";
  return { dest: opts.dest, status, willRename: false, sizeBytes, mtime };
}

export interface ConvertOneResult {
  status: DocItemStatus;
  /** 实际写出的文件（rename 时是新名字） */
  dest: string;
  sizeBytes?: number;
  ms: number;
  renamed?: boolean;
  error?: string;
}

/**
 * 转换一个文件。`run` 可注入（单测用假实现，不需要真的 pandoc）；默认走 runtime.runPandoc。
 * onChild 透传给运行层，供 runner 在取消时 kill。
 */
export async function convertOne(opts: {
  pandoc: string;
  src: string;
  dest: string;
  referenceDoc?: string;
  conflict: ConflictMode;
  run?: RunPandoc;
  onChild?: (child: import("node:child_process").ChildProcess | null) => void;
}): Promise<ConvertOneResult> {
  const started = Date.now();
  const elapsed = () => Date.now() - started;

  if (fs.existsSync(opts.dest)) {
    if (opts.conflict === "skip") {
      const stat = statOrNull(opts.dest);
      return { status: "skipped", dest: opts.dest, sizeBytes: stat?.size ?? 0, ms: elapsed() };
    }
  }
  const target = opts.conflict === "rename" ? uniqueDestPath(opts.dest) : opts.dest;

  try {
    ensureDir(path.dirname(target));
  } catch (error) {
    return {
      status: "failed",
      dest: target,
      ms: elapsed(),
      error: `无法创建输出目录：${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const args = [opts.src, "-o", target, ...(opts.referenceDoc ? [`--reference-doc=${opts.referenceDoc}`] : [])];
  const run = opts.run ?? runPandoc;
  const result = await run(opts.pandoc, args, opts.onChild);
  const ms = elapsed();

  const stat = result.code === 0 ? statOrNull(target) : null;
  if (result.code === 0 && stat) {
    // sizeBytes 一律用**字节**（与 DocFileEntry/describeFile 同单位）：界面自己格式化，
    // 否则同一个列表里会混着 KB 与字节两种量纲。
    return { status: "ok", dest: target, sizeBytes: stat.size, ms, renamed: target !== opts.dest };
  }
  // 失败的通用出口：pandoc 可能「退出码 0 但没产出文件」（磁盘满、路径被劫），两条都算失败
  return {
    status: "failed",
    dest: target,
    ms,
    error: result.code === 0 ? "pandoc 报告成功但没有产出文件" : result.msg,
  };
}

/**
 * 生成参考样式模板：pandoc 把默认样式文档内嵌在二进制里，--print-default-data-file 直接吐出 docx 字节。
 * 默认用 spawnSync 拿二进制 stdout；单测可注入 run（此时以「目标文件是否被写出」为准，而不是比对 stdout）。
 */
export async function buildReferenceDoc(opts: {
  pandoc: string;
  dest: string;
  run?: RunPandoc;
}): Promise<{ ok: boolean; sizeBytes?: number; error?: string }> {
  try {
    ensureDir(path.dirname(opts.dest));
  } catch (error) {
    return { ok: false, error: `无法创建目录：${error instanceof Error ? error.message : String(error)}` };
  }

  if (opts.run) {
    const result = await opts.run(opts.pandoc, ["--print-default-data-file", "reference.docx"]);
    const stat = statOrNull(opts.dest);
    if (result.code !== 0 || !stat) return { ok: false, error: result.msg || "没有产出模板文件" };
    return { ok: true, sizeBytes: stat.size };
  }

  try {
    const result = spawnSync(opts.pandoc, ["--print-default-data-file", "reference.docx"], {
      // 默认样式文档约 10 出头 KB；给 64 MB 上限只是为了不因为个别版本变大而莫名失败
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
    if (result.error) return { ok: false, error: result.error.message };
    if (result.status !== 0 || !result.stdout || result.stdout.length === 0) {
      const message = String(result.stderr || "").split("\n")[0]?.trim();
      return { ok: false, error: message || `pandoc 退出码 ${result.status ?? "unknown"}` };
    }
    fs.writeFileSync(opts.dest, result.stdout);
    return { ok: true, sizeBytes: result.stdout.length };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 任务报告（text/plain 下载）。写清三件事：这次用了什么策略、结果统计、逐条明细。
 * 明细里成功项带 KB，重命名项额外标出实际落点 —— 用户拿它去核对产物时不用再猜文件名。
 */
export function buildReport(job: DocJobRecord): string {
  const lines: string[] = [];
  const startedAt = job.startedAt ?? job.createdAt;
  const finishedAt = job.finishedAt ?? new Date();
  const durationMs = Math.max(0, finishedAt.getTime() - startedAt.getTime());

  lines.push("Markdown → Word 转换报告");
  lines.push(`任务：${job.id}`);
  lines.push(`时间：${startedAt.toLocaleString("zh-CN")}`);
  lines.push(`范围：${job.input.files.length ? `${job.input.files.length} 个文件` : "全部 .md"}`);
  lines.push(`输出：${job.input.outMode === "custom" ? job.input.outDir || "out" : "与源文件同目录"}`);
  lines.push(`已存在时：${CONFLICT_LABEL[job.input.conflict]}`);
  if (job.input.referenceDoc) lines.push(`参考样式：${job.input.referenceDoc}`);
  lines.push(
    `结果：成功 ${job.ok} · 跳过 ${job.skipped} · 失败 ${job.failed} · 共 ${job.total} · 用时 ${secs(durationMs)}s`,
  );
  if (job.error) lines.push(`任务错误：${job.error}`);
  lines.push("");
  lines.push("明细：");

  for (const item of job.items) {
    if (item.status === "ok") {
      const size = typeof item.sizeBytes === "number" ? `${fmtKB(item.sizeBytes).padStart(11)}` : "";
      const renamed = item.renamed ? `  → ${item.destRel}（重命名，未覆盖旧文件）` : "";
      lines.push(`  [成功] ${item.rel}  ${size}${renamed}`);
    } else if (item.status === "skipped") {
      lines.push(`  [跳过] ${item.rel}  已存在`);
    } else {
      lines.push(`  [失败] ${item.rel}  ${item.error || "未知错误"}`);
    }
  }

  if (!job.items.length) lines.push("  （没有可转换的文件）");
  return lines.join("\n");
}

/** 供 HTTP 层复用的守界小工具：把用户输入解析成用户目录内的绝对路径。 */
export function resolveInsideUserRoot(userRoot: string, relative: string): string | null {
  const clean = String(relative || "").trim().replace(/\\/g, "/");
  if (!clean) return null;
  const abs = path.resolve(userRoot, clean);
  return relInside(userRoot, abs) === null ? null : abs;
}
