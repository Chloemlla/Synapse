import fs from "node:fs";
import path from "node:path";
import { isAudioFile, relInside } from "./runtime";

/**
 * 文件任务沙箱（RC-39）：路径 / 大小 / 类型 / 数量四道硬顶。
 *
 * 为什么单独成模块：路径守界（`relInsideRoot`）、大小上限、类型白名单散落在两个 HTTP 入口
 * （管理端媒体工具、用户端转写），每个入口各写一遍必然漂移 —— 而这类缺口的表现是
 * "某个入口忘了检查，磁盘被写满"，不会在类型层面暴露。
 *
 * 失败关闭（fail-closed）：stat 失败、类型未知、大小读不出来 → 拒绝，而不是放行。
 * 与本仓库 `legalHoldService` 的"库不可用按疑似被保留"同一取向。
 */

export type MediaSandboxCode =
  | "MEDIA_SANDBOX_PATH_INVALID"
  | "MEDIA_SANDBOX_FILE_TOO_LARGE"
  | "MEDIA_SANDBOX_FILE_EMPTY"
  | "MEDIA_SANDBOX_TYPE_NOT_ALLOWED"
  | "MEDIA_SANDBOX_DIR_QUOTA_EXCEEDED"
  | "MEDIA_SANDBOX_FILE_COUNT_EXCEEDED";

export interface MediaSandboxLimits {
  /** 单文件字节上限。 */
  maxFileBytes: number;
  /** 单任务文件数上限（与用户页限额同源）。 */
  maxFilesPerJob: number;
  /** 单用户工作目录总字节上限（含 inbox/产物）。 */
  maxUserDirBytes: number;
  /** 单用户工作目录文件数上限。 */
  maxUserDirFiles: number;
}

export type MediaSandboxCheck =
  | { ok: true }
  | { ok: false; code: MediaSandboxCode; message: string };

function readPositiveIntEnv(name: string, fallback: number, env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env[name]);
  if (!Number.isFinite(parsed) || Math.floor(parsed) < 1) return fallback;
  return Math.floor(parsed);
}

/** 默认值刻意宽松（4 GiB / 500 个文件）：正常用户不会撞上，病态写入会被顶住。 */
export const MEDIA_SANDBOX_DEFAULTS: MediaSandboxLimits = {
  maxFileBytes: 500 * 1024 * 1024,
  maxFilesPerJob: 5,
  maxUserDirBytes: 4 * 1024 * 1024 * 1024,
  maxUserDirFiles: 500,
};

export function resolveMediaSandboxLimits(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<MediaSandboxLimits> = {},
): MediaSandboxLimits {
  // 覆盖值也必须 > 0：调用方从 settings 读到的 0（旧数据/未配置）不能把上限变成 0，
  // 否则每个上传都会被判"超过 0 字节"。
  const pick = (value: number | undefined, fallback: number): number =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
  return {
    maxFileBytes: pick(
      overrides.maxFileBytes,
      readPositiveIntEnv("MEDIA_TOOL_MAX_FILE_BYTES", MEDIA_SANDBOX_DEFAULTS.maxFileBytes, env),
    ),
    maxFilesPerJob: pick(
      overrides.maxFilesPerJob,
      readPositiveIntEnv("MEDIA_TOOL_MAX_FILES_PER_JOB", MEDIA_SANDBOX_DEFAULTS.maxFilesPerJob, env),
    ),
    maxUserDirBytes: pick(
      overrides.maxUserDirBytes,
      readPositiveIntEnv("MEDIA_TOOL_USER_DIR_MAX_BYTES", MEDIA_SANDBOX_DEFAULTS.maxUserDirBytes, env),
    ),
    maxUserDirFiles: pick(
      overrides.maxUserDirFiles,
      readPositiveIntEnv("MEDIA_TOOL_USER_DIR_MAX_FILES", MEDIA_SANDBOX_DEFAULTS.maxUserDirFiles, env),
    ),
  };
}

export interface DirectoryUsage {
  bytes: number;
  files: number;
  /** 达到扫描上限提前停止时为 true（此时 counts 是下界，仍可用于"肯定超了"的判断）。 */
  truncated: boolean;
}

/**
 * 统计目录用量。迭代式 + `lstat` 跳过符号链接（防环、防逃逸）。
 * `maxEntries` 只用于限制扫描成本：超过后提前返回下界。
 */
export function inspectDirectoryUsage(dir: string, maxEntries = 2000): DirectoryUsage {
  const usage: DirectoryUsage = { bytes: 0, files: 0, truncated: false };
  if (!dir) return usage;
  const stack: string[] = [dir];
  let visited = 0;
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      visited += 1;
      if (visited > maxEntries) {
        usage.truncated = true;
        return usage;
      }
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      try {
        const st = fs.lstatSync(full);
        if (!st.isFile()) continue;
        usage.bytes += st.size;
        usage.files += 1;
      } catch {
        // 扫描期间被删除：忽略
      }
    }
  }
  return usage;
}

/** 上传前的目录配额预检（用 maxFileBytes 作为最坏增量，避免"先收下再拒绝"）。 */
export function checkUploadBudget(params: {
  dir: string;
  incomingBytes: number;
  limits: MediaSandboxLimits;
}): MediaSandboxCheck & { usage?: DirectoryUsage } {
  const usage = inspectDirectoryUsage(params.dir);
  // truncated = 扫描到上限还没数完：文件数已经是下界，按"可能超了"处理（失败关闭）。
  if (usage.truncated || usage.files >= params.limits.maxUserDirFiles) {
    return {
      ok: false,
      code: "MEDIA_SANDBOX_FILE_COUNT_EXCEEDED",
      message: `目录内文件数已达上限（${params.limits.maxUserDirFiles} 个），请先清理后再上传`,
      usage,
    };
  }
  if (usage.bytes + Math.max(0, params.incomingBytes) > params.limits.maxUserDirBytes) {
    return {
      ok: false,
      code: "MEDIA_SANDBOX_DIR_QUOTA_EXCEEDED",
      message: `目录空间已接近上限（${Math.round(params.limits.maxUserDirBytes / 1024 / 1024)}MB），请先清理后再上传`,
      usage,
    };
  }
  return { ok: true, usage };
}

/**
 * 落盘后复核单个文件。**失败关闭**：stat 失败/不是普通文件/大小为 0 都拒绝。
 * 类型白名单只对用户可上传的音频生效；管理端下载产物（mp4/mkv 等）不经过这里。
 */
export function inspectUploadedFile(
  absPath: string,
  root: string,
  limits: MediaSandboxLimits,
  options: { audioOnly?: boolean } = {},
): MediaSandboxCheck {
  // 第一道：路径必须仍在 root 内（调用方通常已经过了 relInsideRoot，这里是纵深防御）。
  if (relInside(root, absPath) === null) {
    return { ok: false, code: "MEDIA_SANDBOX_PATH_INVALID", message: "文件路径越界" };
  }
  let st: fs.Stats;
  try {
    // codeql[js/path-injection] absPath 在函数入口已过 relInside(root,·) 守界（不通过则直接返回），自定义守界函数 CodeQL 不可见。
    st = fs.lstatSync(absPath);
  } catch {
    return { ok: false, code: "MEDIA_SANDBOX_PATH_INVALID", message: "文件不存在或不可读" };
  }
  if (!st.isFile()) {
    return { ok: false, code: "MEDIA_SANDBOX_TYPE_NOT_ALLOWED", message: "只接受普通文件" };
  }
  if (st.size <= 0) {
    return { ok: false, code: "MEDIA_SANDBOX_FILE_EMPTY", message: "文件为空" };
  }
  if (st.size > limits.maxFileBytes) {
    return {
      ok: false,
      code: "MEDIA_SANDBOX_FILE_TOO_LARGE",
      message: `文件超过 ${Math.round(limits.maxFileBytes / 1024 / 1024)}MB 上限`,
    };
  }
  if (options.audioOnly !== false && !isAudioFile(absPath)) {
    return { ok: false, code: "MEDIA_SANDBOX_TYPE_NOT_ALLOWED", message: "仅支持音频文件" };
  }
  return { ok: true };
}

export function mediaSandboxStatus(code: MediaSandboxCode): number {
  switch (code) {
    case "MEDIA_SANDBOX_FILE_TOO_LARGE":
    case "MEDIA_SANDBOX_DIR_QUOTA_EXCEEDED":
    case "MEDIA_SANDBOX_FILE_COUNT_EXCEEDED":
      return 413;
    case "MEDIA_SANDBOX_FILE_EMPTY":
    case "MEDIA_SANDBOX_TYPE_NOT_ALLOWED":
    case "MEDIA_SANDBOX_PATH_INVALID":
    default:
      return 400;
  }
}
