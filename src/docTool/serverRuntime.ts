// doc-tool 的服务端单例装配：HTTP 路由、重启恢复、清理调用都必须拿到同一份
// store / settingsStore / runner。
//
// 为什么必须是单例：runner 的取消集合与子进程表都活在实例内存里。各自 new 一份的话，
// 路由用 A 实例入队、取消打到 B 实例上 —— kill 不到子进程，任务会一直跑到 pandoc 自己结束；
// 进程重启自恢复也会把同一条 queued 任务向两个 runner 各入队一次（同一份 md 被转换两遍）。
import { DocJobRunner } from "./jobs/docJobRunner";
import { createMongoDocJobStore, type DocJobStore } from "./jobs/docJobStore";
import { resolveDocToolRoot, resolvePandocBin } from "./runtime";
import { createMongoDocSettingsStore, type DocSettingsStore } from "./settingsStore";
import { docLimitsFromEnv } from "./types";

let jobStore: DocJobStore | null = null;
let settingsStore: DocSettingsStore | null = null;
let runner: DocJobRunner | null = null;
let recoveryStarted = false;

export function getDocJobStore(): DocJobStore {
  if (!jobStore) jobStore = createMongoDocJobStore();
  return jobStore;
}

export function getDocSettingsStore(): DocSettingsStore {
  if (!settingsStore) settingsStore = createMongoDocSettingsStore();
  return settingsStore;
}

/** 全局串行（并发 1）：pandoc 是重进程，不让单个用户把机器打满；限额只为日志/文件数校验而注入。 */
export function getDocRunner(): DocJobRunner {
  if (!runner) {
    runner = new DocJobRunner({
      store: getDocJobStore(),
      workRoot: resolveDocToolRoot(),
      limits: docLimitsFromEnv(),
      pandocBin: resolvePandocBin(),
    }, 1);
  }
  return runner;
}

/**
 * 进程重启后自恢复：残留 running 置为失败（中断），残留 queued 重新入队。
 *
 * 为什么延后一拍：mongoose 默认缓冲未连接前的查询，启动瞬间发起的查询会一直挂着；延后执行可以让
 * 「连接建立」与其它启动自检先走完，恢复扫描不会介于半连接状态（mediaTool/serverRuntime.ts 同理）。
 * 只跑一次：多个入口（路由挂载、启动自检）都可能调它。
 */
export function ensureDocJobRecovery(delayMs = 2500): void {
  if (recoveryStarted) return;
  recoveryStarted = true;
  setTimeout(() => {
    void getDocRunner()
      .recover()
      .catch(() => undefined);
  }, delayMs);
}
