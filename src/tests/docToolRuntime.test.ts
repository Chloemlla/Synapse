import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  collectMarkdown,
  probePandoc,
  relInside,
  resolveDocToolRoot,
  resolveUserRoot,
  runPandoc,
  sanitizeFileName,
  sanitizeRelPath,
  uniqueDestPath,
} from "../docTool/runtime";

const tmpDirs: string[] = [];

function makeTmp(prefix = "doc-tool-rt-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort 清理，不影响判据
    }
  }
});

describe("doc-tool 相对路径守界", () => {
  it("接受普通的相对路径并归一化", () => {
    expect(sanitizeRelPath("a.md")).toBe("a.md");
    expect(sanitizeRelPath("sub/a.md")).toBe("sub/a.md");
    expect(sanitizeRelPath("sub\\a.md")).toBe("sub/a.md");
    expect(sanitizeRelPath("a/./b.md")).toBe("a/b.md");
    expect(sanitizeRelPath("  spaced/名 称.md  ".trim())).toBe("spaced/名 称.md");
  });

  it("拒绝越界与不可信写法", () => {
    expect(sanitizeRelPath("")).toBeNull();
    expect(sanitizeRelPath("   ")).toBeNull();
    expect(sanitizeRelPath("..")).toBeNull();
    expect(sanitizeRelPath("../x.md")).toBeNull();
    expect(sanitizeRelPath("a/../../x.md")).toBeNull();
    expect(sanitizeRelPath("a/../b.md")).toBeNull();
    expect(sanitizeRelPath("/etc/passwd")).toBe("etc/passwd"); // 绝对路径被剥成相对，但仍在用户根内
    expect(sanitizeRelPath("C:\\Users\\x.md")).toBeNull();
    expect(sanitizeRelPath("//server/share/x.md")).toBeNull();
    expect(sanitizeRelPath("bad\u0000name.md")).toBeNull();
    expect(sanitizeRelPath("/")).toBeNull();
  });

  it("relInside 只认根内路径", () => {
    const root = makeTmp();
    const inside = path.join(root, "inbox", "a.md");
    expect(relInside(root, inside)).toBe("inbox/a.md");
    expect(relInside(root, root)).toBe("");
    expect(relInside(root, path.join(root, "..", "escape.md"))).toBeNull();
    expect(relInside(root, path.resolve("/etc/passwd"))).toBeNull();
  });

  it("文件名清洗去掉分隔符与保留字符", () => {
    expect(sanitizeFileName("a/b\\c:d*.md")).toBe("a_b_c_d_.md");
    expect(sanitizeFileName("..")).toBe("file");
    expect(sanitizeFileName("")).toBe("file");
    expect(sanitizeFileName("笔记.md")).toBe("笔记.md");
  });
});

describe("doc-tool 工作目录", () => {
  it("工作根默认落在 <cwd>/data/doc-tool，可由环境变量覆盖", () => {
    const def = resolveDocToolRoot({});
    expect(def.endsWith(path.join("data", "doc-tool"))).toBe(true);
    const abs = path.resolve(os.tmpdir(), "doc-tool-abs");
    expect(resolveDocToolRoot({ DOC_TOOL_WORK_DIR: abs })).toBe(path.normalize(abs));
    const rel = resolveDocToolRoot({ DOC_TOOL_WORK_DIR: "custom/rel" });
    expect(rel).toBe(path.resolve(process.cwd(), "custom/rel"));
  });

  it("每个用户拿到独立目录，且恶意 userId 出不了 users 层", () => {
    const root = makeTmp("doc-tool-root-");
    const a = resolveUserRoot("user-a", root);
    const b = resolveUserRoot("user-b", root);
    expect(a).not.toBe(b);
    expect(a.startsWith(path.join(root, "users"))).toBe(true);
    const evil = resolveUserRoot("../../../etc", root);
    expect(relInside(root, evil)).not.toBeNull();
    expect(path.basename(evil)).not.toContain("..");
  });
});

describe("doc-tool 冲突命名", () => {
  it("已存在则依次给出 (2) (3)", () => {
    const dir = makeTmp("doc-tool-uniq-");
    const dest = path.join(dir, "x.docx");
    expect(uniqueDestPath(dest)).toBe(dest);
    fs.writeFileSync(dest, "a");
    const second = uniqueDestPath(dest);
    expect(path.basename(second)).toBe("x (2).docx");
    fs.writeFileSync(second, "b");
    expect(path.basename(uniqueDestPath(dest))).toBe("x (3).docx");
    // 中文名同样保留后缀
    const cn = path.join(dir, "笔记.docx");
    fs.writeFileSync(cn, "c");
    expect(path.basename(uniqueDestPath(cn))).toBe("笔记 (2).docx");
  });
});

describe("doc-tool 收集 Markdown", () => {
  it("按递归开关收集，忽略隐藏项与 node_modules", () => {
    const root = makeTmp("doc-tool-collect-");
    fs.mkdirSync(path.join(root, "sub"), { recursive: true });
    fs.mkdirSync(path.join(root, ".hidden"), { recursive: true });
    fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(root, "a.md"), "# a");
    fs.writeFileSync(path.join(root, "b.MD"), "# b");
    fs.writeFileSync(path.join(root, "c.txt"), "no");
    fs.writeFileSync(path.join(root, "sub", "d.markdown"), "# d");
    fs.writeFileSync(path.join(root, ".hidden", "e.md"), "# e");
    fs.writeFileSync(path.join(root, "node_modules", "f.md"), "# f");

    const flat = collectMarkdown(root, false).map((p) => path.relative(root, p));
    expect(flat).toEqual(["a.md", "b.MD"]);
    const deep = collectMarkdown(root, true).map((p) => path.relative(root, p).replace(/\\/g, "/"));
    expect(deep).toEqual(["a.md", "b.MD", "sub/d.markdown"]);
  });
});

describe("doc-tool pandoc 探测与运行", () => {
  it("探测不到时如实返回不可用而不抛", () => {
    const status = probePandoc("definitely-not-a-real-pandoc-binary-xyz");
    expect(status.available).toBe(false);
    expect(status.bin).toBe("definitely-not-a-real-pandoc-binary-xyz");
    expect(status.version).toBe("");
    expect(typeof status.error).toBe("string");
  });

  it("runPandoc 把 stdout/stderr 首行当结果，并回调子进程句柄", async () => {
    const seen: Array<boolean> = [];
    const result = await runPandoc(
      process.execPath,
      ["-e", "console.log('pandoc 9.9.9');"],
      (child) => seen.push(child !== null),
    );
    expect(result.code).toBe(0);
    expect(result.msg).toBe("pandoc 9.9.9");
    // 起手一次句柄、结束一次 null
    expect(seen).toEqual([true, false]);
  });

  it("超时会被终止并报可读原因（串行队列不该被挂死的进程堵住）", async () => {
    const started = Date.now();
    const result = await runPandoc(
      process.execPath,
      ["-e", "setTimeout(() => {}, 5000);"],
      undefined,
      300,
    );
    expect(result.code).toBe(-1);
    expect(result.msg).toContain("未完成");
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("可执行文件不存在时不抛异常", async () => {
    const result = await runPandoc("definitely-not-a-real-pandoc-binary-xyz", ["--version"]);
    expect(result.code).toBe(-1);
    expect(result.msg.length).toBeGreaterThan(0);
  });
});
