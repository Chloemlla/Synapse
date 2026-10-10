/**
 * DocJobRunner 编排回归测试。
 *
 * 只验状态机与落库内容：注入内存假 store + 假 converter，不 spawn pandoc、不连 Mongo。
 * 真实转换（conflict 命名、pandoc 调用参数）由 docTool converter 自己的用例覆盖。
 */
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { convertOne } from "../docTool/converter";
import { DocJobRunner } from "../docTool/jobs/docJobRunner";
import type { DocJobStore } from "../docTool/jobs/docJobStore";
import { resolveUserRoot } from "../docTool/runtime";
import type { DocItemStatus, DocJobRecord, DocLimits } from "../docTool/types";

// runner 的默认实现是真实 converter（会 spawn pandoc）：这条用例只用注入的假实现，
// 把模块换成空壳，避免它的模块级依赖渗进单测。
jest.mock("../docTool/converter", () => ({ convertOne: jest.fn() }));

type ConvertOpts = Parameters<typeof convertOne>[0];
type ConvertResult = Awaited<ReturnType<typeof convertOne>>;

/** 固定限额：不读那份 env，免得 CI 里某个 DOC_TOOL_* 把 210 文件那条用例顶掉。 */
const TEST_LIMITS: DocLimits = {
  maxUploadBytes: 64 * 1024 * 1024,
  maxFileBytes: 8 * 1024 * 1024,
  maxFilesPerJob: 300,
  maxActiveJobs: 3,
  retentionDays: 7,
};

interface FakeStore extends DocJobStore {
  records: Map<string, DocJobRecord>;
  /** 每次 patch 的入参快照，用来断言「中间进度真的落库了」 */
  patches: Array<Partial<DocJobRecord>>;
}

function createFakeStore(): FakeStore {
  const records = new Map<string, DocJobRecord>();
  const patches: Array<Partial<DocJobRecord>> = [];
  const clone = (record: DocJobRecord): DocJobRecord => structuredClone(record);
  return {
    records,
    patches,
    async list(userId: string, limit: number): Promise<DocJobRecord[]> {
      return [...records.values()].filter((r) => r.userId === userId).slice(0, limit).map(clone);
    },
    async get(id: string): Promise<DocJobRecord | null> {
      const record = records.get(id);
      return record ? clone(record) : null;
    },
    async create(record: DocJobRecord): Promise<void> {
      records.set(record.id, clone(record));
    },
    async patch(id: string, partial: Partial<DocJobRecord>): Promise<void> {
      const copy = structuredClone(partial);
      patches.push(copy);
      const current = records.get(id);
      if (current) records.set(id, { ...current, ...copy });
    },
    async remove(id: string): Promise<void> {
      records.delete(id);
    },
    async countActive(userId: string): Promise<number> {
      return [...records.values()].filter(
        (r) => r.userId === userId && (r.status === "queued" || r.status === "running"),
      ).length;
    },
    async listStale(): Promise<DocJobRecord[]> {
      return [...records.values()].filter((r) => r.status === "queued" || r.status === "running").map(clone);
    },
  };
}

function makeRecord(id: string, files: string[]): DocJobRecord {
  return {
    id,
    userId: "user-1",
    createdBy: "tester",
    createdAt: new Date("2026-10-10T00:00:00Z"),
    status: "queued",
    stage: "排队中",
    progress: 0,
    total: 0,
    done: 0,
    ok: 0,
    skipped: 0,
    failed: 0,
    input: { files, outMode: "custom", outDir: "out", conflict: "rename", referenceDoc: "" },
    items: [],
    logs: [],
    cancelRequested: false,
  };
}

const TERMINAL_STATUSES = ["succeeded", "partial", "failed", "cancelled"];

/** 轮询到终态：enqueue 是 fire-and-forget，测试只能等记录自己变成终态。 */
async function waitTerminal(store: FakeStore, id: string): Promise<DocJobRecord> {
  for (let i = 0; i < 400; i++) {
    const record = await store.get(id);
    if (record && TERMINAL_STATUSES.includes(record.status)) return record;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`任务 ${id} 没有在预期时间内进入终态`);
}

let workRoot: string;
let seq = 0;
const userRoot = () => resolveUserRoot("user-1", workRoot);

beforeEach(() => {
  workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctool-runner-"));
});

afterEach(() => {
  fs.rmSync(workRoot, { recursive: true, force: true });
});

interface Scenario {
  store: FakeStore;
  final: DocJobRecord;
  converted: ConvertOpts[];
}

/** 跑一个任务：results 按文件顺序给出每个文件的预置结果。 */
async function runScenario(
  files: string[],
  results: Array<{ status: DocItemStatus; error?: string }>,
): Promise<Scenario> {
  const store = createFakeStore();
  const record = makeRecord(`job-${++seq}`, files);
  await store.create(record);
  const converted: ConvertOpts[] = [];
  const runner = new DocJobRunner({
    store,
    workRoot,
    limits: TEST_LIMITS,
    pandocBin: "pandoc-test",
    convert: async (opts: ConvertOpts): Promise<ConvertResult> => {
      converted.push(opts);
      const preset = results[converted.length - 1];
      return { status: preset.status, dest: opts.dest, ms: 1, sizeBytes: 12, error: preset.error };
    },
  });
  runner.enqueue(record.id);
  return { store, final: await waitTerminal(store, record.id), converted };
}

describe("DocJobRunner 参考样式默认值", () => {
  /** 造一个带指定默认样式的 runner，返回它实际传给 converter 的 referenceDoc。 */
  const referenceUsed = async (
    userReference: string,
    defaultReferenceDoc: string | null,
  ): Promise<string | undefined> => {
    const store = createFakeStore();
    const record = makeRecord(`job-ref-${++seq}`, ["inbox/a.md"]);
    record.input = { ...record.input, referenceDoc: userReference };
    await store.create(record);
    let seen: string | undefined;
    const runner = new DocJobRunner({
      store,
      workRoot,
      limits: TEST_LIMITS,
      pandocBin: "pandoc-test",
      defaultReferenceDoc,
      convert: async (opts: ConvertOpts): Promise<ConvertResult> => {
        seen = opts.referenceDoc;
        return { status: "ok", dest: opts.dest, ms: 1 };
      },
    });
    runner.enqueue(record.id);
    await waitTerminal(store, record.id);
    return seen;
  };

  it("用户没选模板时用服务端默认的那份", async () => {
    const used = await referenceUsed("", "/srv/defaults/reference.docx");
    expect(used).toBe("/srv/defaults/reference.docx");
  });

  it("用户选了自己的模板时以用户为准", async () => {
    const userRoot = resolveUserRoot("user-1", workRoot);
    fs.mkdirSync(path.join(userRoot, "templates"), { recursive: true });
    fs.writeFileSync(path.join(userRoot, "templates", "mine.docx"), "PK\u0003\u0004mine");
    const used = await referenceUsed("templates/mine.docx", "/srv/defaults/reference.docx");
    expect(used).toBe(path.join(userRoot, "templates", "mine.docx"));
  });

  it("用户给的模板越界时回落默认样式（不把越界路径透给 pandoc）", async () => {
    const used = await referenceUsed("../../etc/passwd", "/srv/defaults/reference.docx");
    expect(used).toBe("/srv/defaults/reference.docx");
  });

  it("默认样式被显式关掉时不再传 referenceDoc", async () => {
    const used = await referenceUsed("", null);
    expect(used).toBeUndefined();
  });
});

describe("DocJobRunner", () => {
  it("逐文件落库 items 与 progress：全成功判 succeeded", async () => {
    const { store, final, converted } = await runScenario(
      ["inbox/a.md", "inbox/sub/b.md"],
      [{ status: "ok" }, { status: "ok" }],
    );

    expect(final.status).toBe("succeeded");
    expect(final.done).toBe(2);
    expect(final.ok).toBe(2);
    expect(final.failed).toBe(0);
    expect(final.progress).toBe(100);
    expect(final.stage).toBe("已完成");
    expect(final.items.map((item) => item.rel)).toEqual(["inbox/a.md", "inbox/sub/b.md"]);
    expect(final.finishedAt).toBeInstanceOf(Date);

    // 目标路径：custom 模式落在 <用户根>/out 下，并保留上传时的子目录结构
    expect(converted.map((opts) => opts.src)).toEqual([
      path.resolve(userRoot(), "inbox/a.md"),
      path.resolve(userRoot(), "inbox/sub/b.md"),
    ]);
    expect(converted.map((opts) => opts.dest)).toEqual([
      path.resolve(userRoot(), "out/a.docx"),
      path.resolve(userRoot(), "out/sub/b.docx"),
    ]);
    expect(converted.every((opts) => opts.pandoc === "pandoc-test" && opts.conflict === "rename")).toBe(true);

    // 中间进度真的落库了：2 个文件在第一个跑完后应是 50%，且阶段文案是「正在转换 N/M」
    expect(store.patches.some((patch) => patch.progress === 50)).toBe(true);
    expect(store.patches.some((patch) => patch.stage === "正在转换 2/2")).toBe(true);
    expect(store.patches.some((patch) => patch.stage === "正在转换 1/2")).toBe(true);
  });

  it("有失败有成功判 partial，全失败判 failed 并把原因写进 error", async () => {
    const partial = await runScenario(
      ["a.md", "b.md"],
      [{ status: "ok" }, { status: "failed", error: "pandoc 退出码 2" }],
    );
    expect(partial.final.status).toBe("partial");
    expect(partial.final.ok).toBe(1);
    expect(partial.final.failed).toBe(1);
    expect(partial.final.progress).toBe(100);
    expect(partial.final.items[1].error).toBe("pandoc 退出码 2");

    const allFailed = await runScenario(
      ["a.md", "b.md"],
      [{ status: "failed", error: "源文件不存在" }, { status: "failed", error: "pandoc 退出码 2" }],
    );
    expect(allFailed.final.status).toBe("failed");
    expect(allFailed.final.failed).toBe(2);
    expect(allFailed.final.error).toContain("源文件不存在");
    expect(allFailed.final.error).toContain("pandoc 退出码 2");

    // 全部跳过（目标已存在 + skip 策略）不是失败
    const allSkipped = await runScenario(["a.md"], [{ status: "skipped" }]);
    expect(allSkipped.final.status).toBe("succeeded");
    expect(allSkipped.final.skipped).toBe(1);
  });

  it("取消后剩余文件不再处理，终态 cancelled 且被中断的文件不计入统计", async () => {
    const store = createFakeStore();
    const record = makeRecord("job-cancel", ["a.md", "b.md", "c.md"]);
    await store.create(record);
    const seen: string[] = [];
    let runner: DocJobRunner | undefined;
    runner = new DocJobRunner({
      store,
      workRoot,
      limits: TEST_LIMITS,
      pandocBin: "pandoc-test",
      convert: async (opts: ConvertOpts): Promise<ConvertResult> => {
        const name = path.basename(opts.src);
        seen.push(name);
        // 在第二个文件转换途中请求取消：这一件的产物不完整，后面的文件都不该再被碰
        if (name === "b.md") runner?.cancel(record.id);
        return { status: "ok", dest: opts.dest, ms: 1 };
      },
    });

    runner.enqueue(record.id);
    const final = await waitTerminal(store, record.id);

    expect(final.status).toBe("cancelled");
    expect(final.stage).toBe("已取消");
    expect(seen).toEqual(["a.md", "b.md"]);
    expect(final.items.map((item) => item.rel)).toEqual(["a.md"]);
    expect(final.done).toBe(1);
    expect(final.progress).toBe(33);
    expect(final.cancelRequested).toBe(true);
  });

  it("logs 上限 200 行、丢最旧，且 t 是 epoch 秒", async () => {
    const files = Array.from({ length: 210 }, (_v, i) => `inbox/f${i}.md`);
    const { final } = await runScenario(
      files,
      files.map(() => ({ status: "ok" as DocItemStatus })),
    );

    expect(final.status).toBe("succeeded");
    expect(final.logs).toHaveLength(200);
    // 总行数是 212（开始 1 + 每文件 1 + 结束 1），最旧的 12 行必须已经丢掉
    expect(final.logs.some((log) => log.text.startsWith("开始转换"))).toBe(false);
    expect(final.logs[final.logs.length - 1].text.startsWith("结束：")).toBe(true);

    const nowSec = Math.floor(Date.now() / 1000);
    for (const log of final.logs) {
      expect(Number.isInteger(log.t)).toBe(true);
      // 秒级：毫秒值会是 1e12 量级，差一个小时就说明单位用错了
      expect(Math.abs(log.t - nowSec)).toBeLessThan(3600);
    }
  });
});
