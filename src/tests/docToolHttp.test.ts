/**
 * doc-tool HTTP 层回归测试。
 *
 * 直接挂 createDocToolRouter（express() + supertest），注入内存假 store / 假 settings / 假 runner 与
 * 假 pandoc 探测：不连 Mongo、不 spawn pandoc、不碰仓库的 ./data。
 * 只验「路由契约」——鉴权、路径守界、归属复核、配额与引擎不可用；真实转换由 converter / runner 自己的用例覆盖。
 */
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import express, { type Request } from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { createDocToolRouter, type DocToolRouterDeps } from "../docTool/http/docToolHttp";
import type { DocJobStore } from "../docTool/jobs/docJobStore";
import type { DocJobRunner } from "../docTool/jobs/docJobRunner";
import { resolveUserRoot } from "../docTool/runtime";
import type { DocSettingsStore } from "../docTool/settingsStore";
import { DEFAULT_DOC_PREFS, type DocJobRecord, type DocLimits, type DocPrefs, type PandocStatus } from "../docTool/types";

/** 固定限额：不读 env，免得 CI 里某个 DOC_TOOL_* 把「文件数超限」那条用例顶掉。 */
const TEST_LIMITS: DocLimits = {
  maxUploadBytes: 2 * 1024 * 1024,
  maxFileBytes: 1024 * 1024,
  maxFilesPerJob: 3,
  maxActiveJobs: 2,
  retentionDays: 7,
};

const AVAILABLE: PandocStatus = { available: true, version: "pandoc 3.12.1", bin: "pandoc-test" };
const UNAVAILABLE: PandocStatus = { available: false, version: "", bin: "/missing/pandoc", error: "spawn pandoc ENOENT" };

/** 活跃任务数可控：429 那条用例要把它顶到限额。 */
function createFakeStore() {
  const records = new Map<string, DocJobRecord>();
  const counts = { active: 0 };
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
    async countActive() {
      return counts.active;
    },
    async listStale() {
      return [];
    },
  };
  return { store, records, counts };
}

function createFakeSettings(initial: Partial<DocPrefs> = {}) {
  let current: DocPrefs = { ...DEFAULT_DOC_PREFS, ...initial };
  const settingsStore: DocSettingsStore = {
    async get() {
      return { ...current };
    },
    async update(_userId, patch) {
      current = { ...current, ...patch };
      return { ...current };
    },
  };
  return { settingsStore, prefs: () => current };
}

function createFakeRunner() {
  const enqueue = jest.fn();
  const cancel = jest.fn();
  const isActive = jest.fn(() => false);
  const runner = { enqueue, cancel, isActive } as unknown as DocJobRunner;
  return { runner, enqueue, cancel, isActive };
}

function makeRecord(id: string, userId: string, overrides: Partial<DocJobRecord> = {}): DocJobRecord {
  return {
    id,
    userId,
    createdBy: userId,
    createdAt: new Date("2026-10-10T00:00:00Z"),
    status: "succeeded",
    stage: "已完成",
    progress: 100,
    total: 1,
    done: 1,
    ok: 1,
    skipped: 0,
    failed: 0,
    input: { files: ["inbox/a.md"], outMode: "custom", outDir: "out", conflict: "rename", referenceDoc: "" },
    items: [{ rel: "inbox/a.md", destRel: "out/a.docx", status: "ok" }],
    logs: [],
    cancelRequested: false,
    ...overrides,
  };
}

let workRoot: string;
let fakeStore: ReturnType<typeof createFakeStore>;
let fakeSettings: ReturnType<typeof createFakeSettings>;
let fakeRunner: ReturnType<typeof createFakeRunner>;

beforeEach(() => {
  workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctool-http-"));
  fakeStore = createFakeStore();
  fakeSettings = createFakeSettings();
  fakeRunner = createFakeRunner();
});

afterEach(() => {
  fs.rmSync(workRoot, { recursive: true, force: true });
});

const userRootFor = (userId: string): string => resolveUserRoot(userId, workRoot);

/** 在用户目录里造文件（顺带建目录）。 */
const write = (userId: string, rel: string, content = "# 标题\n"): string => {
  const abs = path.join(userRootFor(userId), rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
  return abs;
};

function buildApp(overrides: Partial<DocToolRouterDeps> = {}) {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/doc-tool",
    createDocToolRouter({
      store: fakeStore.store,
      settingsStore: fakeSettings.settingsStore,
      runner: fakeRunner.runner,
      workRoot,
      limits: TEST_LIMITS,
      pandocBin: "pandoc-test",
      // 用请求头模拟挂载层的登录态：有 x-test-user 即已登录（中间件本身不在本测试范围内）
      resolveUser: (req: Request) => {
        const header = req.headers["x-test-user"];
        const id = Array.isArray(header) ? header[0] : header;
        return id ? { id: String(id), username: "tester" } : null;
      },
      probePandoc: () => AVAILABLE,
      ...overrides,
    }),
  );
  return app;
}

const asUser = (test: request.Test, userId = "user-1"): request.Test => test.set("x-test-user", userId);

describe("doc-tool HTTP 鉴权", () => {
  it("未登录时读接口一律 401", async () => {
    const app = buildApp();
    const targets: Array<[string, string]> = [
      ["get", "/api/doc-tool/health"],
      ["get", "/api/doc-tool/settings"],
      ["get", "/api/doc-tool/files"],
      ["get", "/api/doc-tool/jobs"],
    ];
    for (const [method, url] of targets) {
      const res = method === "get" ? await request(app).get(url) : await request(app).post(url);
      expect(`${method} ${url} -> ${res.status}`).toBe(`${method} ${url} -> 401`);
      expect(res.body.error).toBe("未登录");
    }
  });

  it("未登录时创建任务 401（不落库、不入队）", async () => {
    const res = await request(buildApp()).post("/api/doc-tool/jobs").send({ files: ["inbox/a.md"] });
    expect(res.status).toBe(401);
    expect(fakeStore.records.size).toBe(0);
    expect(fakeRunner.enqueue).not.toHaveBeenCalled();
  });
});

describe("doc-tool HTTP 路径守界", () => {
  it("下载越界的 path 参数返回 400（不是 500）", async () => {
    const res = await asUser(request(buildApp()).get("/api/doc-tool/files/download?path=../../etc/passwd"));
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it("缺少 path 参数返回 400", async () => {
    const res = await asUser(request(buildApp()).get("/api/doc-tool/files/download"));
    expect(res.status).toBe(400);
  });

  it("建任务里带越界文件路径返回 400", async () => {
    write("user-1", "inbox/a.md");
    const res = await asUser(request(buildApp()).post("/api/doc-tool/jobs")).send({ files: ["inbox/a.md", "../evil.md"] });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("非法文件路径");
    expect(fakeRunner.enqueue).not.toHaveBeenCalled();
  });

  it("建任务里指向非 Markdown 文件返回 400", async () => {
    write("user-1", "inbox/notes.txt", "not md");
    const res = await asUser(request(buildApp()).post("/api/doc-tool/jobs")).send({ files: ["inbox/notes.txt"] });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("不是 Markdown");
  });
});

describe("doc-tool HTTP 任务归属", () => {
  it("他人任务按「不存在」处理：读/删一律 404", async () => {
    fakeStore.records.set("dj-other", makeRecord("dj-other", "user-2"));
    const app = buildApp();

    const read = await asUser(request(app).get("/api/doc-tool/jobs/dj-other"));
    expect(read.status).toBe(404);
    expect(read.body.error).toBe("任务不存在");

    const remove = await asUser(request(app).delete("/api/doc-tool/jobs/dj-other"));
    expect(remove.status).toBe(404);
    // 404 而不是 403：不能泄露「这个任务存在，只是不是你的」
    expect(fakeStore.records.has("dj-other")).toBe(true);
  });

  it("本人任务可读", async () => {
    fakeStore.records.set("dj-mine", makeRecord("dj-mine", "user-1"));
    const res = await asUser(request(buildApp()).get("/api/doc-tool/jobs/dj-mine"));
    expect(res.status).toBe(200);
    expect(res.body.job.id).toBe("dj-mine");
  });

  it("任务列表只返回自己的任务", async () => {
    fakeStore.records.set("dj-a", makeRecord("dj-a", "user-1"));
    fakeStore.records.set("dj-b", makeRecord("dj-b", "user-2"));
    const res = await asUser(request(buildApp()).get("/api/doc-tool/jobs"));
    expect(res.status).toBe(200);
    expect(res.body.jobs.map((job: DocJobRecord) => job.id)).toEqual(["dj-a"]);
  });
});

describe("doc-tool HTTP 配额", () => {
  it("超过单任务文件数上限返回 400 中文原因", async () => {
    const files = Array.from({ length: TEST_LIMITS.maxFilesPerJob + 1 }, (_v, i) => `inbox/f${i}.md`);
    const res = await asUser(request(buildApp()).post("/api/doc-tool/jobs")).send({ files });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain(String(TEST_LIMITS.maxFilesPerJob));
  });

  it("活跃任务达上限返回 429", async () => {
    write("user-1", "inbox/a.md");
    fakeStore.counts.active = TEST_LIMITS.maxActiveJobs;
    const res = await asUser(request(buildApp()).post("/api/doc-tool/jobs")).send({ files: ["inbox/a.md"] });
    expect(res.status).toBe(429);
    expect(res.body.error).toContain("排队或运行");
  });

  it("没有可转换文件返回 400", async () => {
    const res = await asUser(request(buildApp()).post("/api/doc-tool/jobs")).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("先上传");
  });
});

describe("doc-tool HTTP 引擎不可用", () => {
  it("创建任务直接 503，诊断信息放 detail", async () => {
    write("user-1", "inbox/a.md");
    const app = buildApp({ probePandoc: () => UNAVAILABLE });
    const res = await asUser(request(app).post("/api/doc-tool/jobs")).send({ files: ["inbox/a.md"] });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("转换引擎不可用");
    expect(res.body.detail).toBe(UNAVAILABLE.error);
    expect(fakeRunner.enqueue).not.toHaveBeenCalled();
  });

  it("/health 如实报告引擎不可用", async () => {
    const res = await asUser(request(buildApp({ probePandoc: () => UNAVAILABLE })).get("/api/doc-tool/health"));
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.pandoc.available).toBe(false);
    expect(res.body.pandoc.error).toBe(UNAVAILABLE.error);
    expect(res.body.limits).toMatchObject({ maxFilesPerJob: TEST_LIMITS.maxFilesPerJob });
  });
});

describe("doc-tool HTTP 创建任务", () => {
  it("成功后返回 jobId 并入队、按当前偏好落库", async () => {
    write("user-1", "inbox/a.md");
    const app = buildApp();
    const res = await asUser(request(app).post("/api/doc-tool/jobs")).send({ files: ["inbox/a.md"] });

    expect(res.status).toBe(200);
    expect(res.body.jobId).toMatch(/^dj-/);
    expect(fakeRunner.enqueue).toHaveBeenCalledWith(res.body.jobId);

    const record = fakeStore.records.get(res.body.jobId);
    expect(record?.userId).toBe("user-1");
    expect(record?.status).toBe("queued");
    expect(record?.input.files).toEqual(["inbox/a.md"]);
    expect(record?.input.conflict).toBe(DEFAULT_DOC_PREFS.conflict);
  });

  it("未给 files 时按 recursive 扫 inbox 收集", async () => {
    write("user-1", "inbox/a.md");
    write("user-1", "inbox/sub/b.md");
    const res = await asUser(request(buildApp()).post("/api/doc-tool/jobs")).send({ recursive: true });
    expect(res.status).toBe(200);
    const record = fakeStore.records.get(res.body.jobId);
    expect(record?.input.files).toEqual(["inbox/a.md", "inbox/sub/b.md"]);
  });
});

describe("doc-tool HTTP 上传", () => {
  it("relPaths 与 files 同序，保留子目录结构", async () => {
    const res = await asUser(
      request(buildApp())
        .post("/api/doc-tool/upload")
        .attach("files", Buffer.from("# 你好\n"), { filename: "笔记.md" })
        .field("relPaths", "docs/笔记.md"),
    );
    expect(res.status).toBe(200);
    expect(res.body.rejected).toEqual([]);
    expect(res.body.files).toHaveLength(1);
    expect(res.body.files[0].rel).toBe("inbox/docs/笔记.md");
    expect(fs.existsSync(path.join(userRootFor("user-1"), "inbox", "docs", "笔记.md"))).toBe(true);
  });

  it("relPaths 缺失时回落到原文件名", async () => {
    const res = await asUser(
      request(buildApp())
        .post("/api/doc-tool/upload")
        .attach("files", Buffer.from("# hi\n"), { filename: "fallback.md" }),
    );
    expect(res.status).toBe(200);
    expect(res.body.files[0].rel).toBe("inbox/fallback.md");
  });

  it("越界的 relPaths 不会写到用户目录之外", async () => {
    const res = await asUser(
      request(buildApp())
        .post("/api/doc-tool/upload")
        .attach("files", Buffer.from("# hi\n"), { filename: "a.md" })
        .field("relPaths", "../../escape.md"),
    );
    expect(res.status).toBe(200);
    expect(res.body.files[0].rel).toBe("inbox/escape.md");
    expect(fs.existsSync(path.join(workRoot, "escape.md"))).toBe(false);
  });

  it("非 Markdown 文件被拒", async () => {
    const res = await asUser(
      request(buildApp())
        .post("/api/doc-tool/upload")
        .attach("files", Buffer.from("binary"), { filename: "a.txt" }),
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toContain(".md");
  });
});

describe("doc-tool HTTP 设置与清理", () => {
  it("PUT /settings 保存后可读回", async () => {
    const put = await asUser(request(buildApp()).put("/api/doc-tool/settings")).send({
      prefs: { conflict: "overwrite", outDir: "docs-out" },
    });
    expect(put.status).toBe(200);
    expect(put.body.prefs.conflict).toBe("overwrite");
    expect(put.body.prefs.outDir).toBe("docs-out");
  });

  it("POST /cleanup 返回删除数并记录保留期", async () => {
    const res = await asUser(request(buildApp()).post("/api/doc-tool/cleanup")).send({});
    expect(res.status).toBe(200);
    expect(res.body.removed).toBe(0);
    expect(res.body.keepDays).toBe(TEST_LIMITS.retentionDays);
  });
});
