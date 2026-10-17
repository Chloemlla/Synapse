import fs from "node:fs";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import logger from "./logger";

/**
 * 子进程内存/时长看门狗（RC-39）。
 *
 * 必须遵守的判据（审计原文）：
 * **不能看 `process.memoryUsage().rss`** —— 那是整个 Node 进程的共享值。一个转写任务
 * 吃满内存会把所有任务判死（包括无辜的 TTS/HTTP 请求），"异常波动即 SIGKILL" 会变成随机杀任务。
 *
 * 因此本模块：
 * 1. 只读**目标子进程及其后代**的 RSS（Linux `/proc/<pid>/status` 的 `VmRSS`）；
 * 2. 超限只杀该子进程树（SIGKILL），不碰主进程；
 * 3. 读不到计量（非 Linux / 进程已退出 / /proc 不可用）时**不做内存击杀** ——
 *    看不见就不要猜；时长上限仍然生效（它不依赖内存读数）。
 *
 * 默认 `observe`（只日志、不击杀）：yt-dlp 合并视频时 RSS 波动很大，
 * 第一版直接 enforce 会误杀正常下载。确认基线后把 `PROCESS_WATCHDOG_MODE=enforce` 打开。
 */

export type ProcessWatchdogMode = "observe" | "enforce";

export interface ProcessWatchdogLimitInfo {
  label: string;
  pid: number;
  reason: "rss" | "duration";
  rssBytes: number | null;
  maxRssBytes: number;
  elapsedMs: number;
  maxDurationMs: number;
  mode: ProcessWatchdogMode;
  killed: boolean;
}

export interface ProcessWatchdogOptions {
  label: string;
  child: Pick<ChildProcess, "pid" | "kill" | "exitCode" | "signalCode">;
  /** 目标子进程树的 RSS 上限（字节）。 */
  maxRssBytes?: number;
  /** 单次外部工具执行的总时长上限（毫秒）。 */
  maxDurationMs?: number;
  sampleIntervalMs?: number;
  mode?: ProcessWatchdogMode;
  /** 测试注入：返回目标进程树的 RSS（null = 计量不可用/进程已退出）。 */
  readRss?: (pid: number) => number | null;
  onLimit?: (info: ProcessWatchdogLimitInfo) => void;
  onUnavailable?: (pid: number) => void;
}

export interface ProcessWatchdogHandle {
  stop(): void;
  /** 最近一次采样（诊断用）。 */
  snapshot(): { rssBytes: number | null; elapsedMs: number; samples: number } | null;
}

function readNonNegativeIntEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  // 0 不能当"无上限"用在这里：RSS 上限 0 会把每个子进程立刻判死，时长 0 同理。
  if (!Number.isFinite(parsed) || Math.floor(parsed) <= 0) return fallback;
  return Math.floor(parsed);
}

export function resolveWatchdogMode(env: NodeJS.ProcessEnv = process.env): ProcessWatchdogMode {
  return String(env.PROCESS_WATCHDOG_MODE || "observe").trim().toLowerCase() === "enforce"
    ? "enforce"
    : "observe";
}

/** 默认 2 GiB：yt-dlp + ffmpeg 合并 1080p 视频的正常峰值远低于此，病态泄漏会远超。 */
export const DEFAULT_WATCHDOG_MAX_RSS_BYTES =
  readNonNegativeIntEnv("PROCESS_WATCHDOG_MAX_RSS_MB", 2048) * 1024 * 1024;
/** 默认 60 分钟：正常批量下载/转写在单任务维度里不会跑这么久。 */
export const DEFAULT_WATCHDOG_MAX_DURATION_MS = readNonNegativeIntEnv(
  "PROCESS_WATCHDOG_MAX_DURATION_MS",
  60 * 60 * 1000,
);

/** 解析 `/proc/<pid>/status` 里的 VmRSS（kB）。缺失/格式不符 → null。 */
export function parseProcStatusRssBytes(status: string): number | null {
  const match = /^VmRSS:\s+(\d+)\s+kB/m.exec(status || "");
  if (!match) return null;
  const kb = Number(match[1]);
  return Number.isFinite(kb) ? kb * 1024 : null;
}

function readPpidFromStat(stat: string): number | null {
  // comm 字段可能包含空格与括号，必须从**最后一个** ')' 之后开始解析。
  const close = stat.lastIndexOf(")");
  if (close < 0) return null;
  const rest = stat.slice(close + 2).trim().split(/\s+/);
  const ppid = Number(rest[1]);
  return Number.isFinite(ppid) ? ppid : null;
}

function readRssOfPid(pid: number, procRoot = "/proc"): number | null {
  try {
    return parseProcStatusRssBytes(fs.readFileSync(path.join(procRoot, String(pid), "status"), "utf8"));
  } catch {
    return null;
  }
}

/**
 * 目标进程 + 全部后代的 RSS 之和。root 已退出 → null（不是 0，0 会被误判成"内存正常"）。
 * 非 Linux 没有 /proc → null ⇒ 调用方不做内存击杀。
 */
export function readProcessTreeRssBytes(rootPid: number, procRoot = "/proc"): number | null {
  if (process.platform !== "linux" || !Number.isFinite(rootPid) || rootPid <= 0) return null;
  let entries: string[];
  try {
    entries = fs.readdirSync(procRoot);
  } catch {
    return null;
  }

  const childrenByParent = new Map<number, number[]>();
  let rootFound = false;
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === rootPid) rootFound = true;
    try {
      const stat = fs.readFileSync(path.join(procRoot, entry, "stat"), "utf8");
      const ppid = readPpidFromStat(stat);
      if (ppid === null) continue;
      const list = childrenByParent.get(ppid);
      if (list) list.push(pid);
      else childrenByParent.set(ppid, [pid]);
    } catch {
      // 进程在扫描过程中退出：跳过即可。
    }
  }
  if (!rootFound) return null;

  let total = 0;
  let measured = false;
  const queue = [rootPid];
  const seen = new Set<number>();
  while (queue.length > 0) {
    const pid = queue.shift() as number;
    if (seen.has(pid)) continue;
    seen.add(pid);
    const rss = readRssOfPid(pid, procRoot);
    if (rss !== null) {
      total += rss;
      measured = true;
    }
    const children = childrenByParent.get(pid);
    if (children) queue.push(...children);
  }
  return measured ? total : null;
}

function collectTreePids(rootPid: number, procRoot = "/proc"): number[] {
  if (process.platform !== "linux") return [];
  try {
    const entries = fs.readdirSync(procRoot).filter((entry) => /^\d+$/.test(entry));
    const childrenByParent = new Map<number, number[]>();
    for (const entry of entries) {
      try {
        const stat = fs.readFileSync(path.join(procRoot, entry, "stat"), "utf8");
        const ppid = readPpidFromStat(stat);
        const pid = Number(entry);
        if (ppid === null || !Number.isFinite(pid)) continue;
        const list = childrenByParent.get(ppid);
        if (list) list.push(pid);
        else childrenByParent.set(ppid, [pid]);
      } catch {
        // ignore
      }
    }
    const out: number[] = [];
    const queue = [rootPid];
    const seen = new Set<number>();
    while (queue.length > 0) {
      const pid = queue.shift() as number;
      if (seen.has(pid)) continue;
      seen.add(pid);
      out.push(pid);
      const children = childrenByParent.get(pid);
      if (children) queue.push(...children);
    }
    return out;
  } catch {
    return [];
  }
}

function killProcessTree(pid: number, child: ProcessWatchdogOptions["child"]): boolean {
  // 先杀后代再杀根：反过来根一死，后代可能被 init 收养，用原 ppid 就找不到了。
  let killed = false;
  const pids = collectTreePids(pid).filter((candidate) => candidate !== pid);
  for (const descendant of pids.reverse()) {
    try {
      process.kill(descendant, "SIGKILL");
      killed = true;
    } catch {
      // 已经退出
    }
  }
  try {
    child.kill("SIGKILL");
    killed = true;
  } catch {
    // 已经退出
  }
  return killed;
}

/**
 * 启动看门狗。返回的 stop() 必须在子进程 close/error 时调用（调用方负责）。
 */
export function startProcessWatchdog(options: ProcessWatchdogOptions): ProcessWatchdogHandle {
  const pid = Number(options.child.pid) || 0;
  const mode = options.mode || resolveWatchdogMode();
  const maxRssBytes =
    options.maxRssBytes !== undefined && options.maxRssBytes > 0
      ? options.maxRssBytes
      : DEFAULT_WATCHDOG_MAX_RSS_BYTES;
  const maxDurationMs =
    options.maxDurationMs !== undefined && options.maxDurationMs > 0
      ? options.maxDurationMs
      : DEFAULT_WATCHDOG_MAX_DURATION_MS;
  const sampleIntervalMs = Math.max(20, Math.floor(options.sampleIntervalMs ?? 1000));
  const readRss = options.readRss || ((target: number) => readProcessTreeRssBytes(target));
  const startedAt = Date.now();

  let stopped = false;
  let unavailableReported = false;
  let lastRss: number | null = null;
  let samples = 0;

  const isAlive = () => options.child.exitCode === null && options.child.signalCode === null;

  const trigger = (reason: "rss" | "duration", rssBytes: number | null, elapsedMs: number) => {
    const killed = mode === "enforce" ? killProcessTree(pid, options.child) : false;
    const info: ProcessWatchdogLimitInfo = {
      label: options.label,
      pid,
      reason,
      rssBytes,
      maxRssBytes,
      elapsedMs,
      maxDurationMs,
      mode,
      killed,
    };
    if (mode === "enforce") {
      logger.error("[ProcessWatchdog] 子进程超限，已只杀该进程树", info);
    } else {
      logger.warn("[ProcessWatchdog] 子进程超限（观察期，未击杀）", info);
    }
    try {
      options.onLimit?.(info);
    } catch {
      // 回调失败不影响看门狗自身
    }
    stop();
  };

  const tick = () => {
    if (stopped) return;
    if (!isAlive()) {
      stop();
      return;
    }
    const elapsedMs = Date.now() - startedAt;
    samples += 1;

    if (pid > 0) {
      const rss = readRss(pid);
      lastRss = rss;
      if (rss === null) {
        if (!unavailableReported) {
          unavailableReported = true;
          // 非 Linux / /proc 不可用：明确记录"计量不可用"，绝不回退到全局 RSS。
          logger.warn("[ProcessWatchdog] 无法读取子进程 RSS，跳过内存判据（不回退全局 RSS）", {
            label: options.label,
            pid,
            platform: process.platform,
          });
          try {
            options.onUnavailable?.(pid);
          } catch {
            // ignore
          }
        }
      } else if (rss > maxRssBytes) {
        trigger("rss", rss, elapsedMs);
        return;
      }
    }

    if (elapsedMs > maxDurationMs) {
      trigger("duration", lastRss, elapsedMs);
    }
  };

  const timer = setInterval(tick, sampleIntervalMs);
  timer.unref?.();

  function stop(): void {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  }

  return {
    stop,
    snapshot: () => (samples === 0 ? null : { rssBytes: lastRss, elapsedMs: Date.now() - startedAt, samples }),
  };
}
