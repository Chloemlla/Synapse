import { describe, expect, it } from "@jest/globals";
import {
  MAX_TICKET_ATTACHMENT_BYTES,
  formatTicketAttachmentSize,
  resolveTicketAttachmentExt,
  sanitizeTicketAttachmentFileName,
  toTicketAttachmentView,
  validateTicketAttachmentUpload,
} from "../utils/ticketAttachments";

/**
 * 附件规则是安全边界（白名单 + 体积 + 魔数 + ASCII 文件名），这里锁死行为：
 * 放行一个「扩展名对、内容不对」的文件，就等于把任意二进制塞进用户的下载目录。
 */
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_MAGIC = [0xff, 0xd8, 0xff, 0xe0];
const GIF_MAGIC = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61];
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d];

function pngBuffer(extraBytes = 8): Buffer {
  return Buffer.from([...PNG_MAGIC, ...new Array(extraBytes).fill(0x00)]);
}

describe("sanitizeTicketAttachmentFileName", () => {
  it("rejects non-ASCII names (票面：不支持中文名称)", () => {
    const result = sanitizeTicketAttachmentFileName("截图.png");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("FILE_NAME_NON_ASCII");
  });

  it("strips directory components from both separator styles", () => {
    const windowsPath = sanitizeTicketAttachmentFileName(String.raw`C:\Users\me\Pictures\shot.png`);
    expect(windowsPath).toEqual({ ok: true, fileName: "shot.png" });
    const posixPath = sanitizeTicketAttachmentFileName("a/b/shot.png");
    expect(posixPath).toEqual({ ok: true, fileName: "shot.png" });
  });

  it("rejects hidden names, missing extensions and over-long names", () => {
    expect(sanitizeTicketAttachmentFileName(".hidden.png").ok).toBe(false);
    expect(sanitizeTicketAttachmentFileName("noextension").ok).toBe(false);
    expect(sanitizeTicketAttachmentFileName(`${"a".repeat(130)}.png`).ok).toBe(false);
    expect(sanitizeTicketAttachmentFileName("").ok).toBe(false);
    expect(sanitizeTicketAttachmentFileName(undefined).ok).toBe(false);
  });

  it("accepts an ASCII name with an allowed extension", () => {
    expect(sanitizeTicketAttachmentFileName("screen-shot_2.png")).toEqual({
      ok: true,
      fileName: "screen-shot_2.png",
    });
  });
});

describe("resolveTicketAttachmentExt", () => {
  it("lowercases the extension and rejects anything outside the whitelist", () => {
    expect(resolveTicketAttachmentExt("a.PDF")).toBe("pdf");
    expect(resolveTicketAttachmentExt("a.exe")).toBeNull();
    expect(resolveTicketAttachmentExt("a")).toBeNull();
    expect(resolveTicketAttachmentExt("a.")).toBeNull();
  });
});

describe("validateTicketAttachmentUpload", () => {
  it("accepts a real PNG with a matching MIME", () => {
    const buffer = pngBuffer();
    const result = validateTicketAttachmentUpload({
      fileName: "shot.png",
      mimeType: "image/png",
      size: buffer.length,
      buffer,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toMatchObject({ fileName: "shot.png", ext: "png", mimeType: "image/png" });
      expect(result.value.sha256).toHaveLength(64);
    }
  });

  it("rejects an unsupported extension even when the MIME looks fine", () => {
    const buffer = Buffer.from("MZ");
    const result = validateTicketAttachmentUpload({
      fileName: "payload.exe",
      mimeType: "application/octet-stream",
      size: buffer.length,
      buffer,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("UNSUPPORTED_EXTENSION");
  });

  it("rejects a MIME that contradicts the extension", () => {
    const buffer = pngBuffer();
    const result = validateTicketAttachmentUpload({
      fileName: "shot.png",
      mimeType: "image/jpeg",
      size: buffer.length,
      buffer,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("MIME_MISMATCH");
  });

  it("rejects content whose magic bytes do not match the extension", () => {
    // 把可执行/脚本内容改成 .png：扩展名与 MIME 都对，魔数不对。
    const buffer = Buffer.from("#!/bin/sh\necho hi\n");
    const result = validateTicketAttachmentUpload({
      fileName: "shot.png",
      mimeType: "image/png",
      size: buffer.length,
      buffer,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("CONTENT_MISMATCH");
  });

  it("accepts the remaining whitelisted types when the magic bytes are right", () => {
    const cases: Array<[string, string, Buffer]> = [
      ["a.jpg", "image/jpeg", Buffer.from(JPEG_MAGIC)],
      ["a.jpeg", "image/jpeg", Buffer.from(JPEG_MAGIC)],
      ["a.gif", "image/gif", Buffer.from(GIF_MAGIC)],
      ["a.pdf", "application/pdf", Buffer.from([...PDF_MAGIC, ...Buffer.from("1.7\n")])],
      ["a.txt", "text/plain", Buffer.from("复现步骤：1. 打开页面 2. 点击按钮\n")],
    ];
    for (const [fileName, mimeType, buffer] of cases) {
      const result = validateTicketAttachmentUpload({ fileName, mimeType, size: buffer.length, buffer });
      expect([fileName, result.ok]).toEqual([fileName, true]);
    }
  });

  it("rejects binary content dressed as a text file", () => {
    const buffer = Buffer.from([0x00, 0x01, 0x02, 0x03]);
    const result = validateTicketAttachmentUpload({
      fileName: "notes.txt",
      mimeType: "text/plain",
      size: buffer.length,
      buffer,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("CONTENT_MISMATCH");
  });

  it("rejects empty files and files above the 1MB limit", () => {
    const empty = validateTicketAttachmentUpload({
      fileName: "a.png",
      mimeType: "image/png",
      size: 0,
      buffer: Buffer.alloc(0),
    });
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.code).toBe("EMPTY_FILE");

    const big = Buffer.concat([pngBuffer(0), Buffer.alloc(MAX_TICKET_ATTACHMENT_BYTES)]);
    const tooLarge = validateTicketAttachmentUpload({
      fileName: "a.png",
      mimeType: "image/png",
      size: big.length,
      buffer: big,
    });
    expect(tooLarge.ok).toBe(false);
    if (!tooLarge.ok) expect(tooLarge.code).toBe("FILE_TOO_LARGE");
  });
});

describe("toTicketAttachmentView", () => {
  it("exposes metadata only and never the stored bytes", () => {
    const view = toTicketAttachmentView({
      _id: "att1",
      ticketId: "t1",
      userId: "u1",
      username: "alice",
      fileName: "shot.png",
      ext: "png",
      mimeType: "image/png",
      size: 1234,
      sha256: "x",
      data: Buffer.from("secret-bytes"),
      createdAt: new Date("2026-01-02T03:04:05Z"),
    });
    expect(view).not.toBeNull();
    expect(view).not.toHaveProperty("data");
    expect(view).toMatchObject({
      id: "att1",
      fileName: "shot.png",
      size: 1234,
      uploadedById: "u1",
      uploadedByName: "alice",
    });
    expect(view?.createdAt).toBe("2026-01-02T03:04:05.000Z");
  });

  it("returns null when there is no id to reference", () => {
    expect(toTicketAttachmentView({ fileName: "a.png" })).toBeNull();
    expect(toTicketAttachmentView(null)).toBeNull();
  });
});

describe("formatTicketAttachmentSize", () => {
  it("renders human readable sizes", () => {
    expect(formatTicketAttachmentSize(512)).toBe("512B");
    expect(formatTicketAttachmentSize(2048)).toBe("2KB");
    expect(formatTicketAttachmentSize(1.5 * 1024 * 1024)).toBe("1.5MB");
    expect(formatTicketAttachmentSize(0)).toBe("0KB");
  });
});
