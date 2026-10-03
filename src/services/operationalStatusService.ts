import os from "node:os";
import { config } from "../config/config";
import { RuntimeConfigService } from "./runtimeConfigService";
import { timingSafeStringEqual } from "../utils/timingSafeCompare";

export interface ServerStatusSnapshot {
  boot_time: string;
  uptime: number;
  cpu_usage_percent: number;
  memory_usage: {
    used: number;
    total: number;
    percent: number;
  };
  heap_usage: {
    used: number;
    total: number;
    rss: number;
  };
}

// R3-06：比较实现收敛到 utils/timingSafeCompare（本文件原来是 3 份同实现之一）。
// 校验改为 async 并委托给运行时配置：环境变量默认值仍在本进程明文比对，
// 后台改过的口令以 bcrypt 哈希存在 Mongo 里（不再明文落库）。
export async function isServerStatusPasswordValid(candidate: unknown): Promise<boolean> {
  if (typeof candidate !== "string" || !candidate) {
    return false;
  }

  const configuredPassword = config.serverStatusPassword?.trim();
  if (configuredPassword && timingSafeStringEqual(candidate, configuredPassword)) {
    return true;
  }

  return RuntimeConfigService.verifyAdminSecurityPassword("serverStatusPassword", candidate);
}

// G5-34: CPU 百分比需两次采样差值除以经过时间（与 profilingService 一致），不能用累计 CPU 秒当百分比。
let lastCpuUsage = process.cpuUsage();
let lastCpuSampleNs = process.hrtime.bigint();

export function getServerStatusSnapshot(): ServerStatusSnapshot {
  const bootTime = process.uptime();
  const memoryUsage = process.memoryUsage();

  const nowNs = process.hrtime.bigint();
  const elapsedMs = Number(nowNs - lastCpuSampleNs) / 1_000_000;
  const cpuUsage = process.cpuUsage();
  const userDeltaUs = cpuUsage.user - lastCpuUsage.user;
  const systemDeltaUs = cpuUsage.system - lastCpuUsage.system;
  lastCpuUsage = cpuUsage;
  lastCpuSampleNs = nowNs;
  const cpuPercent = elapsedMs > 0 ? ((userDeltaUs + systemDeltaUs) / 1000 / elapsedMs) * 100 : 0;

  // G5-34: 系统内存用 os.totalmem/freemem，堆指标单独字段（GC 前后 heapUsed/heapTotal 比值不能反映机器内存）。
  const totalSystemMemory = os.totalmem();
  const freeSystemMemory = os.freemem();
  const usedSystemMemory = Math.max(0, totalSystemMemory - freeSystemMemory);

  return {
    boot_time: new Date(Date.now() - bootTime * 1000).toISOString(),
    uptime: bootTime,
    cpu_usage_percent: Math.round(cpuPercent * 100) / 100,
    memory_usage: {
      used: usedSystemMemory,
      total: totalSystemMemory,
      percent: totalSystemMemory > 0 ? (usedSystemMemory / totalSystemMemory) * 100 : 0,
    },
    heap_usage: {
      used: memoryUsage.heapUsed,
      total: memoryUsage.heapTotal,
      rss: memoryUsage.rss,
    },
  };
}
