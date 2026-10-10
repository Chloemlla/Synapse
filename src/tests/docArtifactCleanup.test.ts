/**
 * 产物清理回归测试：范围守界（越界/目录一律不删）+ 保留入参 .md + out/ 过期清扫。
 * 全部在 fs.mkdtempSync 的临时目录里跑，不碰仓库的 ./data。
 */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { purgeDocArtifacts, sweepExpiredArtifacts } from "../docTool/jobs/docArtifactCleanup";
import type { DocJobItem, DocJobRecord } from "../docTool/types";

let userRoot: string;
/** 用户目录之外的另一个临时目录：越界用例的靶子 */
let outsideRoot: string;
/** 造在临时目录里、但不在用户目录下的诱饵文件（测试结束要自己清掉） */
const decoys: string[] = [];

beforeEach(() => {
  userRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctool-clean-user-"));
  outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctool-clean-outside-"));
});

afterEach(() => {
  for (const file of decoys.splice(0)) fs.rmSync(file, { force: true });
  fs.rmSync(userRoot, { recursive: true, force: true });
  fs.rmSync(outsideRoot, { recursive: true, force: true });
});

/** 在用户根下造文件（顺带建目录）。 */
const write = (rel: string, content = "x"): string => {
  const abs = path.join(userRoot, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
  return abs;
};

const abs = (rel: string): string => path.join(userRoot, rel);

function makeRecord(id: string, files: string[], items: DocJobItem[]): DocJobRecord {
  return {
    id,
    userId: "user-1",
    createdBy: "tester",
    createdAt: new Date("2026-10-10T00:00:00Z"),
    status: "succeeded",
    stage: "已完成",
    progress: 100,
    total: items.length,
    done: items.length,
    ok: items.length,
    skipped: 0,
    failed: 0,
    input: { files, outMode: "custom", outDir: "out", conflict: "rename", referenceDoc: "" },
    items,
    logs: [],
    cancelRequested: false,
  };
}

const item = (rel: string, destRel: string): DocJobItem => ({ rel, destRel, status: "ok" });

describe("purgeDocArtifacts", () => {
  it("只删 items 里的产物，目录与普通文件之外的东西都不动", () => {
    write("inbox/a.md");
    write("out/a.docx");
    write("out/sub/b.docx");
    fs.mkdirSync(abs("out/emptydir"), { recursive: true });

    const job = makeRecord(
      "job-1",
      ["inbox/a.md"],
      [
        item("inbox/a.md", "out/a.docx"),
        item("inbox/b.md", "out/sub/b.docx"),
        item("inbox/c.md", "out/emptydir"), // 目录：绝不递归删
        item("inbox/d.md", "out/missing.docx"), // 已经不在磁盘上：跳过
      ],
    );

    expect(purgeDocArtifacts(job, userRoot)).toBe(2);
    expect(fs.existsSync(abs("out/a.docx"))).toBe(false);
    expect(fs.existsSync(abs("out/sub/b.docx"))).toBe(false);
    expect(fs.existsSync(abs("out/emptydir"))).toBe(true);
    // 上传的源 .md 不是 items 的产物，本来就不在候选里
    expect(fs.existsSync(abs("inbox/a.md"))).toBe(true);
  });

  it("越界路径（../ 与绝对路径）一个都不删", () => {
    // 用户目录的**上一级**（os.tmpdir()）："../x.docx" 真正指向的位置
    const escapeTarget = path.resolve(userRoot, `../doctool-escape-${path.basename(userRoot)}.docx`);
    fs.writeFileSync(escapeTarget, "x", "utf8");
    decoys.push(escapeTarget);
    const outside = path.join(outsideRoot, "steal.docx");
    fs.writeFileSync(outside, "x", "utf8");

    const job = makeRecord(
      "job-2",
      [],
      [
        item("inbox/a.md", `../${path.basename(escapeTarget)}`),
        item("inbox/b.md", outside),
        item("inbox/c.md", path.relative(userRoot, outside)),
      ],
    );

    expect(purgeDocArtifacts(job, userRoot)).toBe(0);
    expect(fs.existsSync(escapeTarget)).toBe(true);
    expect(fs.existsSync(outside)).toBe(true);
  });

  it("入参 .md 默认保留，显式 keepInputs:false 才删", () => {
    const md = write("inbox/a.md");
    const items = [item("inbox/a.md", "inbox/a.md")];

    expect(purgeDocArtifacts(makeRecord("job-3", ["inbox/a.md"], items), userRoot)).toBe(0);
    expect(fs.existsSync(md)).toBe(true);

    expect(purgeDocArtifacts(makeRecord("job-4", ["inbox/a.md"], items), userRoot, { keepInputs: false })).toBe(1);
    expect(fs.existsSync(md)).toBe(false);
  });
});

describe("sweepExpiredArtifacts", () => {
  it("只清 out/ 下超过保留期的文件，保留目录与别的目录", () => {
    const fresh = write("out/fresh.docx");
    const old = write("out/old.docx");
    const deepOld = write("out/sub/deep/old.docx");
    const template = write("templates/keep.docx");
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    fs.utimesSync(old, tenDaysAgo, tenDaysAgo);
    fs.utimesSync(deepOld, tenDaysAgo, tenDaysAgo);

    expect(sweepExpiredArtifacts(userRoot, 7)).toBe(2);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(deepOld)).toBe(false);
    // 目录本身不删（可能还有别的任务在用），out/ 之外的文件不归它管
    expect(fs.statSync(abs("out/sub/deep")).isDirectory()).toBe(true);
    expect(fs.existsSync(template)).toBe(true);
  });

  it("out/ 不存在时返回 0（新用户目录）", () => {
    expect(sweepExpiredArtifacts(userRoot, 7)).toBe(0);
  });
});
