import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { crc32, createZipBuffer } from "../docTool/zipStore";

const tmpDirs: string[] = [];

function makeTmp(prefix = "doc-tool-zip-"): string {
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

/**
 * 独立的 ZIP 读回器：只按规范从 EOCD → 中央目录 → local header 走一遍，
 * 不复用写入侧的任何函数（否则「写错了也读得回来」会变成自证）。
 */
function readZipBack(buffer: Buffer): Array<{ name: string; data: Buffer; crc: number; method: number }> {
  const eocdOffset = buffer.lastIndexOf(Buffer.from("PK\u0005\u0006", "latin1"));
  if (eocdOffset < 0) throw new Error("找不到 EOCD");
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  let centralOffset = buffer.readUInt32LE(eocdOffset + 16);

  const out: Array<{ name: string; data: Buffer; crc: number; method: number }> = [];
  for (let i = 0; i < entryCount; i += 1) {
    expect(buffer.readUInt32LE(centralOffset)).toBe(0x02014b50);
    const method = buffer.readUInt16LE(centralOffset + 10);
    const crc = buffer.readUInt32LE(centralOffset + 16);
    const compressedSize = buffer.readUInt32LE(centralOffset + 20);
    const nameLength = buffer.readUInt16LE(centralOffset + 28);
    const extraLength = buffer.readUInt16LE(centralOffset + 30);
    const commentLength = buffer.readUInt16LE(centralOffset + 32);
    const localOffset = buffer.readUInt32LE(centralOffset + 42);
    const name = buffer.subarray(centralOffset + 46, centralOffset + 46 + nameLength).toString("utf8");

    expect(buffer.readUInt32LE(localOffset)).toBe(0x04034b50);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const payload = buffer.subarray(dataStart, dataStart + compressedSize);
    const data = method === 8 ? zlib.inflateRawSync(payload) : Buffer.from(payload);

    out.push({ name, data, crc, method });
    centralOffset += 46 + nameLength + extraLength + commentLength;
  }
  return out;
}

describe("crc32", () => {
  it("符合公开校验向量", () => {
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
    expect(crc32(Buffer.alloc(0))).toBe(0);
    expect(crc32(Buffer.from("中文"))).toBe(crc32(Buffer.from("中文")));
  });
});

describe("createZipBuffer", () => {
  it("写出的包能被独立解析回来，字节与 CRC 都对", () => {
    const dir = makeTmp();
    const a = path.join(dir, "a.docx");
    const b = path.join(dir, "sub", "笔记 (2).docx");
    fs.mkdirSync(path.dirname(b), { recursive: true });
    const contentA = Buffer.from("first-docx-content");
    const contentB = Buffer.from("第二份内容".repeat(200)); // 大小够大，走 deflate 分支
    fs.writeFileSync(a, contentA);
    fs.writeFileSync(b, contentB);

    const result = createZipBuffer([
      { name: "a.docx", sourcePath: a },
      { name: "sub/笔记 (2).docx", sourcePath: b },
    ]);

    expect(result.entries).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.truncated).toBe(false);
    expect(result.bytes).toBe(contentA.length + contentB.length);
    expect(result.buffer.subarray(0, 4).toString("latin1")).toBe("PK\u0003\u0004");

    const readBack = readZipBack(result.buffer);
    expect(readBack.map((entry) => entry.name)).toEqual(["a.docx", "sub/笔记 (2).docx"]);
    expect(readBack[0].data.equals(contentA)).toBe(true);
    expect(readBack[1].data.equals(contentB)).toBe(true);
    for (const entry of readBack) {
      expect(entry.crc).toBe(crc32(entry.data));
    }
    // 大文件应当被压缩（否则打包下载没有意义）
    expect(readBack[1].method).toBe(8);
  });

  it("读不到源文件时跳过而不是整体失败", () => {
    const dir = makeTmp();
    const good = path.join(dir, "good.docx");
    fs.writeFileSync(good, "ok");
    const result = createZipBuffer([
      { name: "missing.docx", sourcePath: path.join(dir, "nope.docx") },
      { name: "good.docx", sourcePath: good },
    ]);
    expect(result.entries).toBe(1);
    expect(result.skipped).toBe(1);
    expect(readZipBack(result.buffer)[0].name).toBe("good.docx");
  });

  it("超过总量上限时截断并标记", () => {
    const dir = makeTmp();
    const big = path.join(dir, "big.docx");
    fs.writeFileSync(big, Buffer.alloc(4096, 1));
    const result = createZipBuffer([{ name: "big.docx", sourcePath: big }], { maxTotalBytes: 1024 });
    expect(result.truncated).toBe(true);
    expect(result.entries).toBe(0);
    expect(result.skipped).toBe(1);
    // 空包也必须是合法 zip（只有 EOCD）
    expect(result.buffer.subarray(0, 4).toString("latin1")).toBe("PK\u0005\u0006");
  });
});
