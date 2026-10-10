import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildReferenceDoc, buildReport, convertOne, describeFile, destForFile } from "../docTool/converter";
import type { RunPandoc } from "../docTool/runtime";
import type { DocJobRecord } from "../docTool/types";

const tmpDirs: string[] = [];

function makeTmp(prefix = "doc-tool-cv-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

/** 假的 pandoc：把 -o 指向的位置写出来，并记录收到的参数（单测不需要真的装 pandoc）。 */
function fakePandoc(box: { args?: string[]; code?: number; msg?: string; write?: boolean }): RunPandoc {
  return async (_bin, args) => {
    box.args = args;
    if ((box.write ?? true) && args.includes("-o")) {
      const target = args[args.indexOf("-o") + 1];
      fs.writeFileSync(target, Buffer.from("fake-docx-bytes"));
    }
    return { code: box.code ?? 0, msg: box.msg ?? "" };
  };
}

describe("destForFile 目标路径", () => {
  const userRoot = path.resolve(os.tmpdir(), "doc-tool-userroot");

  it("alongside：与源 .md 同目录同名，后缀换成 .docx", () => {
    expect(destForFile({ userRoot, rel: "a.md", outMode: "alongside", outDir: "" })).toBe(
      path.join(userRoot, "a.docx"),
    );
    expect(destForFile({ userRoot, rel: "sub/笔记.markdown", outMode: "alongside", outDir: "" })).toBe(
      path.join(userRoot, "sub", "笔记.docx"),
    );
  });

  it("custom：落到 outDir 下并保留相对子目录结构", () => {
    expect(destForFile({ userRoot, rel: "sub/x.md", outMode: "custom", outDir: "out" })).toBe(
      path.join(userRoot, "out", "sub", "x.docx"),
    );
    // outDir 留空回落默认 out，而不是把产物扔到用户根
    expect(destForFile({ userRoot, rel: "x.md", outMode: "custom", outDir: "  " })).toBe(
      path.join(userRoot, "out", "x.docx"),
    );
  });
});

describe("describeFile 目标形态", () => {
  it("目标不存在 → 待生成", () => {
    const dir = makeTmp();
    const src = path.join(dir, "a.md");
    fs.writeFileSync(src, "# a");
    const info = describeFile({ src, dest: path.join(dir, "a.docx"), conflict: "rename" });
    expect(info.status).toBe("new");
    expect(info.willRename).toBe(false);
    expect(path.basename(info.dest)).toBe("a.docx");
    expect(info.sizeBytes).toBeGreaterThan(0);
    // 单位必须是字节：写成 "# a" 就是 3 字节（曾经这里混过 KB）
    expect(info.sizeBytes).toBe(3);
  });

  it("rename 模式下目标已存在 → 直接给出将写出的新名字", () => {
    const dir = makeTmp();
    const src = path.join(dir, "a.md");
    const dest = path.join(dir, "a.docx");
    fs.writeFileSync(src, "# a");
    fs.writeFileSync(dest, "old");
    const info = describeFile({ src, dest, conflict: "rename" });
    expect(info.status).toBe("new");
    expect(info.willRename).toBe(true);
    expect(path.basename(info.dest)).toBe("a (2).docx");
  });

  it("skip/overwrite 模式下按新旧报待更新或已是最新", () => {
    const dir = makeTmp();
    const src = path.join(dir, "a.md");
    const dest = path.join(dir, "a.docx");
    fs.writeFileSync(src, "# a");
    fs.writeFileSync(dest, "old");
    // 让目标比源新
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(dest, future, future);
    expect(describeFile({ src, dest, conflict: "skip" }).status).toBe("fresh");
    expect(describeFile({ src, dest, conflict: "skip" }).willRename).toBe(false);

    const past = new Date(Date.now() - 120_000);
    fs.utimesSync(dest, past, past);
    expect(describeFile({ src, dest, conflict: "overwrite" }).status).toBe("stale");
  });
});

describe("convertOne 转换与冲突策略", () => {
  it("正常转换：参数指向目标、产出被登记", async () => {
    const dir = makeTmp();
    const src = path.join(dir, "a.md");
    fs.writeFileSync(src, "# a");
    const box: { args?: string[] } = {};
    const result = await convertOne({
      pandoc: "pandoc",
      src,
      dest: path.join(dir, "out", "a.docx"),
      conflict: "rename",
      run: fakePandoc(box),
    });
    expect(result.status).toBe("ok");
    expect(result.renamed).toBe(false);
    expect(result.sizeBytes).toBeGreaterThan(0);
    // 字节口径：假 pandoc 写的 "fake-docx-bytes" 长度
    expect(result.sizeBytes).toBe(Buffer.byteLength("fake-docx-bytes"));
    expect(box.args?.[0]).toBe(src);
    expect(box.args?.[box.args.indexOf("-o") + 1]).toBe(path.join(dir, "out", "a.docx"));
    expect(fs.existsSync(path.join(dir, "out", "a.docx"))).toBe(true);
  });

  it("skip：目标已存在时跳过，且不调用 pandoc", async () => {
    const dir = makeTmp();
    const src = path.join(dir, "a.md");
    const dest = path.join(dir, "a.docx");
    fs.writeFileSync(src, "# a");
    fs.writeFileSync(dest, "old");
    const box: { args?: string[] } = {};
    const result = await convertOne({ pandoc: "pandoc", src, dest, conflict: "skip", run: fakePandoc(box) });
    expect(result.status).toBe("skipped");
    expect(box.args).toBeUndefined();
    expect(fs.readFileSync(dest, "utf8")).toBe("old");
  });

  it("rename：另存为新名且旧文件一个字节都不动", async () => {
    const dir = makeTmp();
    const src = path.join(dir, "a.md");
    const dest = path.join(dir, "a.docx");
    fs.writeFileSync(src, "# a");
    fs.writeFileSync(dest, "old-content");
    const box: { args?: string[] } = {};
    const result = await convertOne({ pandoc: "pandoc", src, dest, conflict: "rename", run: fakePandoc(box) });
    expect(result.status).toBe("ok");
    expect(result.renamed).toBe(true);
    expect(path.basename(result.dest)).toBe("a (2).docx");
    expect(fs.readFileSync(dest, "utf8")).toBe("old-content");
    expect(box.args?.[box.args.indexOf("-o") + 1]).toBe(path.join(dir, "a (2).docx"));
  });

  it("overwrite：直接写回原目标", async () => {
    const dir = makeTmp();
    const src = path.join(dir, "a.md");
    const dest = path.join(dir, "a.docx");
    fs.writeFileSync(src, "# a");
    fs.writeFileSync(dest, "old");
    const box: { args?: string[] } = {};
    const result = await convertOne({ pandoc: "pandoc", src, dest, conflict: "overwrite", run: fakePandoc(box) });
    expect(result.status).toBe("ok");
    expect(result.renamed).toBe(false);
    expect(fs.readFileSync(dest, "utf8")).toBe("fake-docx-bytes");
  });

  it("参考样式拼成 --reference-doc=<path>", async () => {
    const dir = makeTmp();
    const src = path.join(dir, "a.md");
    fs.writeFileSync(src, "# a");
    const ref = path.join(dir, "ref.docx");
    fs.writeFileSync(ref, "ref");
    const box: { args?: string[] } = {};
    await convertOne({
      pandoc: "pandoc",
      src,
      dest: path.join(dir, "a.docx"),
      referenceDoc: ref,
      conflict: "skip",
      run: fakePandoc(box),
    });
    expect(box.args).toContain(`--reference-doc=${ref}`);
  });

  it("失败：上游退出码非 0 时把原因带回来", async () => {
    const dir = makeTmp();
    const src = path.join(dir, "a.md");
    fs.writeFileSync(src, "# a");
    const result = await convertOne({
      pandoc: "pandoc",
      src,
      dest: path.join(dir, "a.docx"),
      conflict: "skip",
      run: fakePandoc({ code: 1, msg: "pandoc: 打不开某个输入" }),
    });
    expect(result.status).toBe("failed");
    expect(result.error).toBe("pandoc: 打不开某个输入");
  });

  it("失败：退出码 0 但没产出文件也判失败（磁盘满/路径被劫的真实形态）", async () => {
    const dir = makeTmp();
    const src = path.join(dir, "a.md");
    fs.writeFileSync(src, "# a");
    const result = await convertOne({
      pandoc: "pandoc",
      src,
      dest: path.join(dir, "a.docx"),
      conflict: "skip",
      run: fakePandoc({ write: false }),
    });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("没有产出文件");
  });

  it("写不进去（输出位置被同名文件占着）时报可读原因", async () => {
    const dir = makeTmp();
    const src = path.join(dir, "a.md");
    fs.writeFileSync(src, "# a");
    // 输出目录位置被一个文件占住 → ensureDir 必然失败
    const blocked = path.join(dir, "blocked");
    fs.writeFileSync(blocked, "x");
    const result = await convertOne({
      pandoc: "pandoc",
      src,
      dest: path.join(blocked, "a.docx"),
      conflict: "skip",
      run: fakePandoc({}),
    });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("无法创建输出目录");
  });
});

describe("buildReferenceDoc 生成默认样式模板", () => {
  it("注入 run 时以产出文件为准", async () => {
    const dir = makeTmp();
    const dest = path.join(dir, "templates", "默认样式.docx");
    const run: RunPandoc = async (_bin, args) => {
      expect(args).toEqual(["--print-default-data-file", "reference.docx"]);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, Buffer.from("docx-template"));
      return { code: 0, msg: "" };
    };
    const result = await buildReferenceDoc({ pandoc: "pandoc", dest, run });
    expect(result.ok).toBe(true);
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(fs.existsSync(dest)).toBe(true);
  });

  it("上游失败时返回原因", async () => {
    const dir = makeTmp();
    const result = await buildReferenceDoc({
      pandoc: "pandoc",
      dest: path.join(dir, "t.docx"),
      run: async () => ({ code: 2, msg: "pandoc: 不支持该选项" }),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("不支持");
  });
});

describe("buildReport 报告文本", () => {
  it("统计、策略与逐条明细（含重命名落点）都写进去", () => {
    const job = {
      id: "job-1",
      userId: "u1",
      createdBy: "tester",
      createdAt: new Date("2026-10-10T10:00:00Z"),
      startedAt: new Date("2026-10-10T10:00:00Z"),
      finishedAt: new Date("2026-10-10T10:00:03Z"),
      status: "partial",
      stage: "已完成",
      progress: 100,
      total: 3,
      done: 3,
      ok: 1,
      skipped: 1,
      failed: 1,
      input: {
        files: ["a.md", "b.md", "c.md"],
        outMode: "custom" as const,
        outDir: "out",
        conflict: "rename" as const,
        referenceDoc: "",
      },
      items: [
        { rel: "a.md", destRel: "a (2).docx", status: "ok" as const, sizeBytes: 14540, ms: 120, renamed: true },
        { rel: "b.md", destRel: "b.docx", status: "skipped" as const },
        { rel: "c.md", destRel: "c.docx", status: "failed" as const, error: "pandoc: 输入不可读" },
      ],
      logs: [],
      cancelRequested: false,
    } satisfies DocJobRecord;

    const report = buildReport(job);
    expect(report).toContain("Markdown → Word 转换报告");
    expect(report).toContain("已存在时：已存在就自动重命名（保留旧文件）");
    expect(report).toContain("结果：成功 1 · 跳过 1 · 失败 1 · 共 3 · 用时 3.0s");
    expect(report).toContain("[成功] a.md");
    expect(report).toContain("14.2 KB");   // 字节入、KB 出（报告里给人看的量纲）
    expect(report).toContain("a (2).docx（重命名，未覆盖旧文件）");
    expect(report).toContain("[跳过] b.md  已存在");
    expect(report).toContain("[失败] c.md  pandoc: 输入不可读");
  });
});
