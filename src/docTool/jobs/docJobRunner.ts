// doc-tool 任务执行器：串行队列（默认并发 1）跑 md → docx。
//
// 为什么必须串行：pandoc 是重进程（单个文档几百 MB 内存、CPU 打满），并发 1 是「一个人提交 300 个文件
// 也不会把整机拖垮」的唯一保证；HTTP 层另有限流与每用户活跃任务数兜底。
//
// 进度契约（前端进度条与文案的唯一依据）：
//   progress = Math.round(done / total * 100)（done 只统计真的跑完的文件）
//   stage    = 中文短句，形如「正在转换 3/12」
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { convertOne, destForFile } from "../converter";
import { relInside, resolveDocToolRoot, resolvePandocBin, resolveUserRoot } from "../runtime";
import {
  docLimitsFromEnv,
  type DocJobItem,
  type DocJobLog,
  type DocJobRecord,
  type DocJobStatus,
  type DocLimits,
} from "../types";
import type { DocJobStore } from "./docJobStore";

/** 日志上限：详情页只做折叠展示，200 行足够定位失败原因；超出丢最旧，免得单文档被日志撑爆。 */
const MAX_LOG_LINES = 200;
/** 终态 error 里汇总的最大失败条数：逐条原因在 items 里，error 只做「一眼可见」的摘要。 */
const MAX_ERROR_SUMMARY = 5;

export interface DocJobRunnerDeps {
  store: DocJobStore;
  /** 工作根（不是用户根）：默认 resolveDocToolRoot()；任务内再按 userId 落到 users/<uid>。 */
  workRoot?: string;
  limits?: DocLimits;
  pandocBin?: string;
  /** 覆盖默认 converter（单测注入假实现；生产不传，保证默认实现只有 converter.ts 一处）。 */
  convert?: typeof convertOne;
}

/** 把失败项拼成一行摘要（列表页的 error 字段）。 */
function summarizeFailures(items: DocJobItem[]): string {
  const messages = items
    .filter((it) => it.status === "failed")
    .map((it) => (it.error ? `${it.rel}: ${it.error}` : it.rel))
    .slice(0, MAX_ERROR_SUMMARY);
  const extra = items.filter((it) => it.status === "failed").length - messages.length;
  return extra > 0 ? `${messages.join("; ")}; 另有 ${extra} 个文件失败（见详情）` : messages.join("; ");
}

export class DocJobRunner {
  private queue: string[] = [];
  private active = 0;
  /** 本进程收到的取消请求：立即生效，不等下一次 store 轮询。 */
  private cancels = new Set<string>();
  /** 正在 execute 内的任务：enqueue 幂等与 HTTP 的 isActive 判断都用它。 */
  private activeIds = new Set<string>();
  /** 当前在跑的子进程：取消要在同一拍里 kill，不能等 pandoc 自己跑完。 */
  private children = new Map<string, ChildProcess | null>();
  private workRoot: string;
  private limits: DocLimits;
  private pandocBin: string;
  private convert: typeof convertOne;

  constructor(
    private deps: DocJobRunnerDeps,
    private concurrency = 1,
  ) {
    this.workRoot = deps.workRoot ?? resolveDocToolRoot();
    this.limits = deps.limits ?? docLimitsFromEnv();
    this.pandocBin = deps.pandocBin ?? resolvePandocBin();
    this.convert = deps.convert ?? convertOne;
  }

  /** 幂等入队：HTTP 的创建与重启恢复可能各入队一次，重复入队会让同一个任务跑两遍（产物互相覆盖）。 */
  enqueue(jobId: string): void {
    if (!jobId || this.queue.includes(jobId) || this.activeIds.has(jobId)) return;
    this.queue.push(jobId);
    this.pump();
  }

  /**
   * 请求取消。同步返回（HTTP 还要立刻回响应），但会做两件事：
   *   1) kill 当前子进程 —— pandoc 能跑几分钟，等它自己结束等于没取消；
   *   2) 落库 cancelRequested（fire-and-forget）—— 详情页与其它实例立刻看得到取消意图，
   *      否则记录会一直显示「运行中」，用户会再点一次取消。
   */
  cancel(jobId: string): void {
    this.cancels.add(jobId);
    const child = this.children.get(jobId);
    if (child) {
      try {
        child.kill();
      } catch {
        // 已经退出了
      }
    }
    void this.deps.store.patch(jobId, { cancelRequested: true }).catch(() => undefined);
  }

  /** 该任务此刻是否真的在排队或执行中（本进程视角）。 */
  isActive(jobId: string): boolean {
    return this.queue.includes(jobId) || this.activeIds.has(jobId);
  }

  /**
   * 进程重启后的自恢复（幂等）：
   *   残留 running → failed（进程没了，pandoc 子进程也没了，任务不可能自己完成）
   *   残留 queued  → 重新入队
   *   残留 queued 且已请求取消 → cancelled（取消意图只活在本进程内存里，重启后没有任何执行体会再写它的
   *     终态；留着 queued 会永久占住该用户的活跃任务配额）
   */
  async recover(): Promise<void> {
    const stale = await this.deps.store.listStale();
    for (const rec of stale) {
      if (rec.status === "running") {
        await this.deps.store.patch(rec.id, {
          status: "failed",
          stage: "已中断",
          error: "服务重启，任务被中断（可重试）",
          finishedAt: new Date(),
        });
      } else if (rec.cancelRequested) {
        await this.deps.store.patch(rec.id, { status: "cancelled", stage: "已取消", finishedAt: new Date() });
      } else {
        this.enqueue(rec.id);
      }
    }
  }

  private pump(): void {
    const limit = Math.max(1, Math.floor(this.concurrency) || 1);
    while (this.active < limit && this.queue.length > 0) {
      const jobId = this.queue.shift() as string;
      this.active += 1;
      void this.execute(jobId)
        .catch(() => undefined)
        .finally(() => {
          this.active -= 1;
          this.pump();
        });
    }
  }

  private async execute(jobId: string): Promise<void> {
    this.activeIds.add(jobId);
    try {
      await this.runJob(jobId);
    } catch (e) {
      // runJob 内部已尽力写终态；这里兜住「连写终态都抛」的极端情况，否则任务会永久卡在 running
      await this.patchTerminal(jobId, "failed", "转换失败", (e as Error).message);
    } finally {
      this.activeIds.delete(jobId);
      this.cancels.delete(jobId);
      this.children.delete(jobId);
    }
  }

  private async patchTerminal(jobId: string, status: DocJobStatus, stage: string, error?: string): Promise<void> {
    const patch: Partial<DocJobRecord> = { status, stage, finishedAt: new Date() };
    if (error) patch.error = error;
    await this.deps.store.patch(jobId, patch);
  }

  /** 单个文件：路径守界 → 候选目标名 → 调 converter。 */
  private async convertFile(
    jobId: string,
    userRoot: string,
    rel: string,
    input: DocJobRecord["input"],
  ): Promise<DocJobItem> {
    const src = path.resolve(userRoot, rel);
    if (relInside(userRoot, src) === null) {
      return { rel, destRel: "", status: "failed", error: "文件路径越界" };
    }
    const dest = destForFile({ userRoot, rel, outMode: input.outMode, outDir: input.outDir });
    if (relInside(userRoot, dest) === null) {
      return { rel, destRel: "", status: "failed", error: "输出路径越界（outDir 非法？）" };
    }
    // 参考样式模板同样只能来自该用户自己的目录：越界就当作没设置，而不是把路径透给 pandoc
    const referenceAbs = input.referenceDoc ? path.resolve(userRoot, input.referenceDoc) : "";
    const referenceDoc = referenceAbs && relInside(userRoot, referenceAbs) !== null ? referenceAbs : undefined;

    const outcome = await this.convert({
      pandoc: this.pandocBin,
      src,
      dest,
      referenceDoc,
      conflict: input.conflict,
      onChild: (child) => this.children.set(jobId, child),
    });
    return {
      rel,
      // 产物路径回填成用户根相对路径（对外接口一律相对用户根，绝不暴露容器绝对路径）
      destRel: relInside(userRoot, outcome.dest) ?? "",
      status: outcome.status,
      sizeBytes: outcome.sizeBytes,
      ms: outcome.ms,
      renamed: outcome.renamed,
      error: outcome.error,
    };
  }

  private async runJob(jobId: string): Promise<void> {
    const current = await this.deps.store.get(jobId);
    // 只有排队态会开跑：重试 = 调用方把记录 patch 回 queued 再入队，终态/运行中的记录一律不碰
    if (!current || current.status !== "queued") return;
    if (this.cancels.has(jobId) || current.cancelRequested) {
      await this.patchTerminal(jobId, "cancelled", "已取消");
      return;
    }

    const files = current.input.files.map(String);
    if (files.length === 0) {
      await this.patchTerminal(jobId, "failed", "转换失败", "任务没有可转换的文件");
      return;
    }
    if (files.length > this.limits.maxFilesPerJob) {
      await this.patchTerminal(
        jobId,
        "failed",
        "转换失败",
        `单次最多 ${this.limits.maxFilesPerJob} 个文件，本次 ${files.length} 个`,
      );
      return;
    }

    const userRoot = resolveUserRoot(current.userId, this.workRoot);
    const total = files.length;
    const items: DocJobItem[] = [];
    const logs: DocJobLog[] = [];
    let done = 0;
    let ok = 0;
    let skipped = 0;
    let failed = 0;
    let cancelled = false;

    // 日志用 epoch 秒（与 mediaTool 一致）：前端只用来排序与展示，秒级足够
    const pushLog = (text: string): void => {
      logs.push({ t: Math.floor(Date.now() / 1000), text });
      if (logs.length > MAX_LOG_LINES) logs.splice(0, logs.length - MAX_LOG_LINES);
    };
    const patchProgress = async (stage: string): Promise<void> => {
      await this.deps.store.patch(jobId, {
        status: "running",
        stage,
        progress: Math.round((done / total) * 100),
        total,
        done,
        ok,
        skipped,
        failed,
        items,
        logs,
      });
    };

    pushLog(`开始转换 ${total} 个文件`);
    await this.deps.store.patch(jobId, {
      status: "running",
      stage: `正在转换 1/${total}`,
      progress: 0,
      startedAt: new Date(),
      total,
      items: [],
      logs,
    });

    for (let i = 0; i < total; i++) {
      if (this.cancels.has(jobId)) {
        cancelled = true;
        break;
      }
      const rel = files[i];
      pushLog(`[${i + 1}/${total}] ${rel}`);
      await patchProgress(`正在转换 ${i + 1}/${total}`);

      const item = await this.convertFile(jobId, userRoot, rel, current.input);

      if (this.cancels.has(jobId)) {
        // 被取消的这一件产物不完整（子进程被 kill），既不算成功也不算失败：不计入 items/done，
        // 否则「取消」任务会凭空多出一个失败项
        cancelled = true;
        pushLog("已取消");
        break;
      }
      items.push(item);
      done += 1;
      if (item.status === "ok") ok += 1;
      else if (item.status === "skipped") skipped += 1;
      else {
        failed += 1;
        pushLog(`失败: ${item.error ?? "未知错误"}`);
      }
      await patchProgress(`正在转换 ${Math.min(done + 1, total)}/${total}`);
    }

    if (cancelled) {
      await this.deps.store.patch(jobId, {
        status: "cancelled",
        stage: "已取消",
        finishedAt: new Date(),
        // 取消的进度停在真实完成的位置，不写 100：用户能看出「跑到第几个被停掉了」
        progress: Math.round((done / total) * 100),
        total,
        done,
        ok,
        skipped,
        failed,
        items,
        logs,
      });
      return;
    }

    // 终态：一件没失败 = succeeded；全失败 = failed；有失败有成功（含跳过）= partial。
    // partial 是刻意的第三态：批量转换里「部分成功」既不该报成功也不该报失败。
    const status: DocJobStatus = failed === 0 ? "succeeded" : failed === total ? "failed" : "partial";
    const stage = status === "succeeded" ? "已完成" : status === "partial" ? "部分完成" : "转换失败";
    pushLog(`结束：成功 ${ok}，跳过 ${skipped}，失败 ${failed}`);
    const patch: Partial<DocJobRecord> = {
      status,
      stage,
      progress: 100,
      finishedAt: new Date(),
      total,
      done,
      ok,
      skipped,
      failed,
      items,
      logs,
    };
    // 逐条失败原因在 items 里（界面「详情」折叠区）；顶层 error 只在整批失败时给一行摘要
    if (status === "failed") patch.error = summarizeFailures(items);
    await this.deps.store.patch(jobId, patch);
  }
}
