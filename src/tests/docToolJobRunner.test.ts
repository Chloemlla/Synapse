/**
 * doc-tool 任务执行器（串行队列）状态机测试。
 *
 * 覆盖方案 §9.5 要求的四条主线：queued→running→succeeded/partial/failed/cancelled、
 * 取消真的 kill 子进程、重启恢复（running→failed / queued 重新入队 / 已请求取消→cancelled）、
 * 以及删除任务后队列不残留。转换本身注入假实现：不 spawn pandoc、不碰 ./data。
 */
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { convertOne } from "../docTool/converter";
import { DocJobRunner } from "../docTool/jobs/docJobRunner";
import type { DocJobStore } from "../docTool/jobs/docJobStore";
import { resolveUserRoot } from "../docTool/runtime";
import type { DocJobRecord, DocJobStatus, DocLimits } from "../docTool/types";

const LIMITS: DocLimits = {
  maxUploadBytes: 1024 * 1024,
  maxFileBytes: 512 * 1024,
  maxFilesPerJob: 3,
  maxActiveJobs: 2,
  retentionDays: 7,
};

const WORK_ROOT = { value: "" };

function makeRecord(id: string, overrides: Partial<DocJobRecord> = {}): DocJobRecord {
  return {
    id,
    userId: "user-1",
    createdBy: "tester",
    createdAt: new Date("2026-10-17T00:00:00Z"),
    status: "queued",
    stage: "排队中",
    progress: 0,
    total: 2,
    done: 0,
    ok: 0,
    skipped: 0,
    failed: 0,
    input: { files: ["inbox/a.md", "inbox/b.md"], outMode: "custom", outDir: "out", conflict: "rename", referenceDoc: "" },
    items: [],
    logs: [],
    cancelRequested: false,
    ...overrides,
  };
}

function createStore(seed: DocJobRecord[] = []) {
  const records = new Map<string, DocJobRecord>(seed.map((record) => [record.id, structuredClone(record)]));
  const store: DocJobStore = {
    async list(userId, limit) {
      return [...records.values()]
        .filter((record) => record.userId === userId)
        .slice(0, limit)
        .map((record) => structuredClone(record));
    },
    async get(id) {
      const record = records.get(id);
      return record ? structuredClone(record) : null;
    },
    async create(record) {
      records.set(record.id, structuredClone(record));
    },
    async patch(id, partial) {
      const current = records.get(id);
      if (current) records.set(id, { ...current, ...structuredClone(partial) });
    },
    async remove(id) {
      records.delete(id);
    },
    async countActive(userId) {
      return [...records.values()].filter((record) => record.userId === userId && (record.status === "queued" || record.status === "running"))
        .length;
    },
    async listStale() {
      return [...records.values()]
        .filter((record) => record.status === "queued" || record.status === "running")
        .map((record) => structuredClone(record));
    },
  };
  return { store, records };
}

type ConvertOpts = Parameters<typeof convertOne>[0];
type ConvertImpl = (opts: ConvertOpts) => Promise<Awaited<ReturnType<typeof convertOne>>>;

/** 假的 convertOne：默认把 dest 写出来并按宿主文件名决定成功/失败。 */
function makeConvert(impl?: ConvertImpl) {
  const calls: ConvertOpts[] = [];
  const fn = jest.fn(async (opts: ConvertOpts) => {
    calls.push(opts);
    if (impl) return impl(opts);
    fs.mkdirSync(path.dirname(opts.dest), { recursive: true });
    fs.writeFileSync(opts.dest, "docx");
    if (path.basename(opts.src).startsWith("bad")) {
      return { status: "failed" as const, dest: opts.dest, ms: 1, error: "pandoc: 输入不可读" };
    }
    return { status: "ok" as const, dest: opts.dest, sizeBytes: 4, ms: 1 };
  });
  return { convert: fn as unknown as typeof convertOne, calls };
}

function buildRunner(store: DocJobStore, convert: typeof convertOne) {
  return new DocJobRunner(
    {
      store,
      workRoot: WORK_ROOT.value,
      limits: LIMITS,
      pandocBin: "pandoc-test",
      convert,
      defaultReferenceDoc: null,
    },
    1,
  );
}

const waitFor = async (predicate: () => boolean, timeoutMs = 5000): Promise<void> => {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("等待条件超时");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const statusOf = (records: Map<string, DocJobRecord>, id: string): DocJobStatus | undefined => records.get(id)?.status;

beforeEach(() => {
  WORK_ROOT.value = fs.mkdtempSync(path.join(os.tmpdir(), "doctool-runner-"));
  const userRoot = resolveUserRoot("user-1", WORK_ROOT.value);
  fs.mkdirSync(path.join(userRoot, "inbox"), { recursive: true });
  fs.writeFileSync(path.join(userRoot, "inbox", "a.md"), "# a\n");
  fs.writeFileSync(path.join(userRoot, "inbox", "b.md"), "# b\n");
  fs.writeFileSync(path.join(userRoot, "inbox", "bad.md"), "# bad\n");
});

afterEach(() => {
  fs.rmSync(WORK_ROOT.value, { recursive: true, force: true });
});

describe("DocJobRunner 状态机", () => {
  it("全部成功 → succeeded，进度/统计自洽，finishedAt 是 Date", async () => {
    const { store, records } = createStore();
    const { convert } = makeConvert();
    const runner = buildRunner(store, convert);

    records.set("job-ok", makeRecord("job-ok"));
    runner.enqueue("job-ok");
    await waitFor(() => statusOf(records, "job-ok") === "succeeded");

    const job = records.get("job-ok") as DocJobRecord;
    expect(job.done).toBe(2);
    expect(job.ok).toBe(2);
    expect(job.failed).toBe(0);
    expect(job.progress).toBe(100);
    expect(job.finishedAt).toBeInstanceOf(Date);
    expect(job.startedAt).toBeInstanceOf(Date);
    expect(job.items.map((item) => item.status)).toEqual(["ok", "ok"]);
  });

  it("部分成功 → partial，逐条失败原因留在 items，顶层 error 不误报整批失败", async () => {
    const { store, records } = createStore();
    const { convert } = makeConvert();
    const runner = buildRunner(store, convert);

    records.set("job-partial", makeRecord("job-partial", { input: { ...makeRecord("x").input, files: ["inbox/a.md", "inbox/bad.md"] } }));
    runner.enqueue("job-partial");
    await waitFor(() => statusOf(records, "job-partial") === "partial");

    const job = records.get("job-partial") as DocJobRecord;
    expect(job.ok).toBe(1);
    expect(job.failed).toBe(1);
    expect(job.progress).toBe(100);
    expect(job.error).toBeUndefined();
    expect(job.items.find((item) => item.status === "failed")?.error).toContain("输入不可读");
  });

  it("全部失败 → failed，顶层 error 给出失败摘要", async () => {
    const { store, records } = createStore();
    const { convert } = makeConvert();
    const runner = buildRunner(store, convert);

    records.set("job-bad", makeRecord("job-bad", { input: { ...makeRecord("x").input, files: ["inbox/bad.md"] } }));
    runner.enqueue("job-bad");
    await waitFor(() => statusOf(records, "job-bad") === "failed");

    const job = records.get("job-bad") as DocJobRecord;
    expect(job.failed).toBe(1);
    expect(job.error).toContain("inbox/bad.md");
  });

  it("超过单任务文件数上限时不调用 pandoc，直接 failed", async () => {
    const { store, records } = createStore();
    const { convert, calls } = makeConvert();
    const runner = buildRunner(store, convert);
    const files = Array.from({ length: LIMITS.maxFilesPerJob + 1 }, (_v, i) => `inbox/f${i}.md`);

    records.set("job-too-many", makeRecord("job-too-many", { input: { ...makeRecord("x").input, files } }));
    runner.enqueue("job-too-many");
    await waitFor(() => statusOf(records, "job-too-many") === "failed");

    expect(calls).toHaveLength(0);
    expect((records.get("job-too-many") as DocJobRecord).error).toContain(String(LIMITS.maxFilesPerJob));
  });

  it("取消会立刻 kill 当前子进程并落成 cancelled（被打断的那件不计入统计）", async () => {
    const { store, records } = createStore();
    const kill = jest.fn();
    const fakeChild = { kill } as unknown as ChildProcess;
    let release: (() => void) | null = null;
    let childShown = false;
    const { convert } = makeConvert(async (opts) => {
      opts.onChild?.(fakeChild);
      childShown = true;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { status: "ok", dest: opts.dest, sizeBytes: 1, ms: 1 };
    });
    const runner = buildRunner(store, convert);

    records.set("job-cancel", makeRecord("job-cancel"));
    runner.enqueue("job-cancel");
    await waitFor(() => childShown);

    runner.cancel("job-cancel");
    expect(kill).toHaveBeenCalledTimes(1);
    expect(records.get("job-cancel")?.cancelRequested).toBe(true);

    (release as unknown as () => void)();
    await waitFor(() => statusOf(records, "job-cancel") === "cancelled");

    const job = records.get("job-cancel") as DocJobRecord;
    expect(job.done).toBe(0);
    expect(job.ok).toBe(0);
    expect(job.failed).toBe(0);
    // 取消是「停下」，不是「这一件失败」：不完整的产物不进 items
    expect(job.items).toEqual([]);
  });
});

describe("DocJobRunner 重启恢复", () => {
  it("running → failed；queued+已请求取消 → cancelled；queued → 重新入队并跑完", async () => {
    const { store, records } = createStore([
      makeRecord("stale-running", { status: "running", stage: "正在转换 1/2" }),
      makeRecord("stale-cancelled", { status: "queued", cancelRequested: true }),
      makeRecord("stale-queued", { status: "queued" }),
    ]);
    const { convert, calls } = makeConvert();
    const runner = buildRunner(store, convert);

    await runner.recover();
    await waitFor(() => statusOf(records, "stale-queued") === "succeeded");

    expect(statusOf(records, "stale-running")).toBe("failed");
    expect(records.get("stale-running")?.error).toContain("服务重启");
    expect(statusOf(records, "stale-cancelled")).toBe("cancelled");
    // 只有真正排队的那个重新跑：另两条不该再 spawn 任何转换
    expect(calls).toHaveLength(2);
  });

  it("重复 recover 不会把同一条排队任务跑两遍（enqueue 幂等）", async () => {
    const { store, records } = createStore([makeRecord("queued-once")]);
    const { convert, calls } = makeConvert();
    const runner = buildRunner(store, convert);

    await Promise.all([runner.recover(), runner.recover()]);
    await waitFor(() => statusOf(records, "queued-once") === "succeeded");

    expect(calls).toHaveLength(2);
  });
});

describe("DocJobRunner 队列清理", () => {
  it("discard 后排队中的任务不会再执行（删除任务后不留队头）", async () => {
    const { store, records } = createStore();
    let release: (() => void) | null = null;
    let started = 0;
    const { convert, calls } = makeConvert(async (opts) => {
      started += 1;
      if (started === 1) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return { status: "ok", dest: opts.dest, sizeBytes: 1, ms: 1 };
    });
    const runner = buildRunner(store, convert);

    records.set("job-first", makeRecord("job-first"));
    records.set("job-deleted", makeRecord("job-deleted"));
    runner.enqueue("job-first");
    await waitFor(() => started === 1);
    runner.enqueue("job-deleted");
    runner.discard("job-deleted");

    (release as unknown as () => void)();
    await waitFor(() => statusOf(records, "job-first") === "succeeded");
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(calls).toHaveLength(2); // 两个文件都属于 job-first
    expect(statusOf(records, "job-deleted")).toBe("queued");
  });
});
