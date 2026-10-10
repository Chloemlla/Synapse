// doc-tool 的运行期基础设施：pandoc 探测、工作目录解析、路径守界、冲突命名、子进程运行。
//
// 为什么自成一份而不 import ../mediaTool/runtime：
//   · 两边的输入契约不同 —— 媒体工具的文件名来自 multer 的 originalname（latin1 语义，需要 mojibake 修复），
//     doc-tool 的名字优先来自客户端显式提交的 relPaths 文本字段（真 UTF-8），套用那套启发式反而会改坏中文名；
//   · doc-tool 需要 mediaTool 没有的两件事：pandoc 探测与「已存在就另存新名」。
//   代价是 relInside 这类安全函数在两处各有一份实现：**语义必须保持一致**（越界一律 null），改动其一时同时改另一处。
//
// 只依赖 node: 内置模块，不 import mongoose / express / logger —— 这样单测与 HTTP 层都能直接用它。
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { PandocStatus } from "./types";

/** 工作根目录名：与 mediaTool 的 data/media-tool 并列，docker-compose 已把 ./data 挂进容器。 */
const DEFAULT_ROOT_DIR = path.join("data", "doc-tool");
/** pandoc 在镜像里的固定落点（Dockerfile 的 pandoc 层），也是「留空即自动探测」的第一顺位。 */
const IMAGE_PANDOC_PATH = "/usr/local/bin/pandoc";
/** pandoc 单次调用的兜底超时：串行队列里一个挂死的进程会挡住后面所有任务，宁可判失败。 */
const DEFAULT_PANDOC_TIMEOUT_MS = 5 * 60 * 1000;

export function isMarkdownFile(name: string): boolean {
  return /\.(md|markdown)$/i.test(String(name || ""));
}

/**
 * pandoc 可执行文件的解析顺序（与 yt-dlp 侧「配置优先、留空回退 PATH」同口径）：
 * DOC_TOOL_PANDOC_BIN → PANDOC_BIN → 镜像内的 /usr/local/bin/pandoc（存在才用）→ 裸名 "pandoc"（交给 PATH）。
 */
export function resolvePandocBin(env: NodeJS.ProcessEnv = process.env): string {
  const configured = (env.DOC_TOOL_PANDOC_BIN || env.PANDOC_BIN || "").trim();
  if (configured) return configured;
  try {
    if (fs.existsSync(IMAGE_PANDOC_PATH)) return IMAGE_PANDOC_PATH;
  } catch {
    // existsSync 正常不抛；权限异常时按「没装」处理，让探测结果去报告不可用
  }
  return "pandoc";
}

/** 同步探测 pandoc 版本：返回 "pandoc 3.12.1" 这类首行。失败不抛，交给调用方报「不可用」。 */
export function probePandoc(bin: string): PandocStatus {
  const resolved = (bin || "").trim() || "pandoc";
  try {
    const r = spawnSync(resolved, ["--version"], { encoding: "utf8", timeout: 15_000, windowsHide: true });
    if (r.error) {
      return { available: false, version: "", bin: resolved, error: r.error.message };
    }
    if (r.status !== 0) {
      return {
        available: false,
        version: "",
        bin: resolved,
        error: `pandoc 退出码 ${r.status ?? "unknown"}`,
      };
    }
    const firstLine = String(r.stdout || "")
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    if (!firstLine) {
      return { available: false, version: "", bin: resolved, error: "pandoc --version 没有输出" };
    }
    return { available: true, version: firstLine, bin: resolved };
  } catch (error) {
    return {
      available: false,
      version: "",
      bin: resolved,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * 工作根解析：空 → <cwd>/data/doc-tool；相对路径 → 基于 cwd。
 * 返回的是**根**，不含 users 层；每个用户的实际目录由 resolveUserRoot 拼。
 */
export function resolveDocToolRoot(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.DOC_TOOL_WORK_DIR || "").trim();
  const resolved = raw
    ? path.isAbsolute(raw)
      ? raw
      : path.resolve(process.cwd(), raw)
    : path.resolve(process.cwd(), DEFAULT_ROOT_DIR);
  return path.normalize(resolved);
}

/**
 * 用户子目录名：可读前缀 + id 摘要。
 * 只清洗会破坏路径的字符，再拼 8 位摘要 —— 保证不同用户不会因清洗碰撞到同一目录（与 mediaTool 同算法）。
 */
export function userScopedDirName(userId: string): string {
  const safe = String(userId || "").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 48) || "anon";
  const digest = crypto.createHash("sha256").update(String(userId || "")).digest("hex").slice(0, 8);
  return `${safe}-${digest}`;
}

export function resolveUserRoot(userId: string, workRoot?: string): string {
  const root = path.normalize(workRoot && workRoot.trim() ? workRoot : resolveDocToolRoot());
  return path.join(root, "users", userScopedDirName(userId));
}

export function ensureDir(dir: string): void {
  if (!dir) return;
  // codeql[js/path-injection] 调用点传入的都是 resolveUserRoot/resolveDocToolRoot 拼出的路径或已过 relInside 守界的落点；doc-tool 子树另有用户归属校验（见 http/docToolHttp.ts）。
  fs.mkdirSync(dir, { recursive: true });
}

export function statOrNull(p: string): fs.Stats | null {
  try {
    // codeql[js/path-injection] 每个调用点要么传 multer 写入 inbox 的路径，要么已先过 relInside(userRoot,·)；自定义守界函数 CodeQL 不可见，故在此共享 sink 上报。
    return fs.statSync(p);
  } catch {
    return null;
  }
}

/** 检查 root 是否完全包含 target：在 root 内返回相对 posix 路径，否则 null（防目录穿越）。 */
export function relInside(root: string, target: string): string | null {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  if (rel === "") return "";
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join("/");
}

/**
 * 客户端提交的相对路径归一：非法一律 null（而不是「尽力修一下」）。
 * 拒绝：空、绝对路径、盘符（C:\ 这类在 Windows 上是绝对路径、在容器里却不是）、UNC、控制字符、任何 ".." 段。
 */
export function sanitizeRelPath(input: string): string | null {
  const raw = String(input ?? "").trim().replace(/\\/g, "/");
  if (!raw) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) return null;
  if (/^[A-Za-z]:/.test(raw)) return null;
  if (raw.startsWith("//")) return null;
  const segments = raw.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (!segments.length) return null;
  if (segments.some((segment) => segment === "..")) return null;
  const normalized = segments.join("/");
  return normalized.length > 512 ? null : normalized;
}

/** 单个文件名的清洗：去路径分隔、控制字符与 Windows 保留字符，限长，拒绝 "."/".."。 */
export function sanitizeFileName(name: string, fallback = "file"): string {
  const cleaned = String(name || "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, "_")
    .replace(/^\.+$/, "")
    .trim()
    .replace(/[. ]+$/, "");
  return (cleaned || fallback).slice(0, 120);
}

/**
 * 目标已存在时找一个不撞名的：x.docx → "x (2).docx" → "x (3).docx"…
 * 超过 limit 仍撞名（说明有人在同一目录里反复转换同一批文件）时回落时间戳，保证不会覆盖。
 */
export function uniqueDestPath(dest: string, limit = 200): string {
  if (!fs.existsSync(dest)) return dest;
  const dir = path.dirname(dest);
  const ext = path.extname(dest);
  const base = path.basename(dest, ext);
  for (let i = 2; i <= limit; i += 1) {
    const candidate = path.join(dir, `${base} (${i})${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return path.join(dir, `${base} (${stamp})${ext}`);
}

/** 递归收集 .md。忽略隐藏项与 node_modules：用户上传目录里不该出现它们，真出现也多半是垃圾。 */
export function collectMarkdown(root: string, recursive: boolean): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      // codeql[js/path-injection] 起点是 resolveUserRoot 的结果，向下的每一层都是 readdirSync 产出的名字，不再来自请求。
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (recursive && entry.name !== "node_modules") walk(abs);
      } else if (entry.isFile() && isMarkdownFile(entry.name)) {
        found.push(abs);
      }
    }
  };
  walk(root);
  return found.sort((a, b) => a.localeCompare(b, "zh"));
}

/** 子进程运行契约：注入点让单测不必真的装 pandoc。 */
export type RunPandoc = (
  bin: string,
  args: string[],
  onChild?: (child: ChildProcess | null) => void,
) => Promise<{ code: number; msg: string }>;

/**
 * 运行 pandoc：**数组传参、绝不拼 shell**（用户可控的值只出现在 -o 与 --reference-doc= 的位置上，且已过路径守界）。
 * onChild 在子进程起来时回调一次、结束时回调 null —— 取消逻辑靠它拿到句柄 kill。
 */
export function runPandoc(
  bin: string,
  args: string[],
  onChild?: (child: ChildProcess | null) => void,
  timeoutMs = DEFAULT_PANDOC_TIMEOUT_MS,
): Promise<{ code: number; msg: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (code: number, msg: string) => {
      if (settled) return;
      settled = true;
      if (onChild) onChild(null);
      resolve({ code, msg });
    };

    let child: ChildProcess;
    try {
      child = spawn(bin, args, { windowsHide: true });
    } catch (error) {
      finish(-1, error instanceof Error ? error.message : String(error));
      return;
    }
    if (onChild) onChild(child);

    let output = "";
    const collect = (chunk: Buffer | string) => {
      output += chunk.toString();
      // 只留前若干 KB：pandoc 的报错在头几行，别让超长输出把内存吃了
      if (output.length > 64 * 1024) output = output.slice(0, 64 * 1024);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // 已经退出
      }
      finish(-1, `pandoc 超过 ${Math.round(timeoutMs / 1000)} 秒未完成，已终止`);
    }, timeoutMs);
    // 不要因为这个定时器把进程留住（测试里的 detectOpenHandles 会盯这个）
    if (typeof timer.unref === "function") timer.unref();

    child.on("error", (error) => {
      clearTimeout(timer);
      finish(-1, error.message);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const firstLine = (output || "")
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0);
      finish(code ?? -1, firstLine || `pandoc 退出码 ${code ?? "unknown"}`);
    });
  });
}
