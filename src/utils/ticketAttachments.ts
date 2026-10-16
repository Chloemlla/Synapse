import crypto from "node:crypto";

/**
 * 工单附件规则与校验（纯函数，不依赖数据库，便于单测）。
 *
 * 口径来自票面约定：允许 `.jpg/.gif/.jpeg/.png/.txt/.pdf`、单个不超过 1 MB、不支持中文名称。
 * **这里是安全边界，前端 `frontend/src/components/ticket/ticketConstants.ts` 只是镜像提示**
 * —— 前端可以改，但以后端这套常量为准。
 */

/** 单个附件上限 1 MB（票面规则）。 */
export const MAX_TICKET_ATTACHMENT_BYTES = 1024 * 1024;
/** 单个工单的附件上限。 */
export const MAX_TICKET_ATTACHMENTS = 5;
/** 文件名长度上限（与票据文件名白名单一起，防止超长名撑爆响应）。 */
export const MAX_TICKET_ATTACHMENT_NAME_LEN = 120;

export const TICKET_ATTACHMENT_EXTS = ["jpg", "jpeg", "png", "gif", "txt", "pdf"] as const;
export type TicketAttachmentExt = (typeof TICKET_ATTACHMENT_EXTS)[number];

/**
 * 扩展名 → 允许的 MIME 集合。
 *
 * 多个 MIME 别名都收（例如部分客户端的 `.txt` 会带 `application/octet-stream`？—— 不收：
 * octet-stream 等于没有类型声明，白名单失去意义，宁可让极少数客户端改用正确的 MIME）。
 */
export const TICKET_ATTACHMENT_MIME_BY_EXT: Record<TicketAttachmentExt, readonly string[]> = {
  jpg: ["image/jpeg"],
  jpeg: ["image/jpeg"],
  png: ["image/png"],
  gif: ["image/gif"],
  txt: ["text/plain"],
  pdf: ["application/pdf"],
};

/** 供前端下拉/提示用的可读清单（票面文案）。 */
export const TICKET_ATTACHMENT_EXT_HINT = TICKET_ATTACHMENT_EXTS.map((ext) => `.${ext}`).join("/");

export interface TicketAttachmentUploadInput {
  fileName: unknown;
  mimeType: unknown;
  size: number;
  buffer: Buffer;
}

export interface ValidatedTicketAttachment {
  fileName: string;
  ext: TicketAttachmentExt;
  mimeType: string;
  size: number;
  sha256: string;
}

export type TicketAttachmentValidation =
  | { ok: true; value: ValidatedTicketAttachment }
  | { ok: false; code: string; error: string };

const EXT_SET = new Set<string>(TICKET_ATTACHMENT_EXTS);

/** JPEG(FFD8FF) / PNG(89504E470D0A1A0A) / GIF(GIF8) / PDF(%PDF-) 的魔数。 */
const MAGIC_BY_EXT: Partial<Record<TicketAttachmentExt, readonly number[][]>> = {
  jpg: [[0xff, 0xd8, 0xff]],
  jpeg: [[0xff, 0xd8, 0xff]],
  png: [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  gif: [[0x47, 0x49, 0x46, 0x38]],
  pdf: [[0x25, 0x50, 0x44, 0x46, 0x2d]],
};

function fail(code: string, error: string): TicketAttachmentValidation {
  return { ok: false, code, error };
}

function startsWithBytes(buffer: Buffer, bytes: readonly number[]): boolean {
  if (buffer.length < bytes.length) return false;
  for (let index = 0; index < bytes.length; index += 1) {
    if (buffer[index] !== bytes[index]) return false;
  }
  return true;
}

function hasMagic(buffer: Buffer, ext: TicketAttachmentExt): boolean {
  const candidates = MAGIC_BY_EXT[ext];
  if (!candidates) return true; // txt 无魔数可校验，改判「可读文本」
  return candidates.some((bytes) => startsWithBytes(buffer, bytes));
}

/**
 * `.txt` 内容初筛：必须是 UTF-8 可解码且不含 NUL。
 *
 * 只挡「扩展名写 txt、实际塞二进制」这一类，不承担内容审核 —— 内容审核走
 * `ModerationService.checkContentWithAi`（见 ticketController）。
 */
function looksLikeText(buffer: Buffer): boolean {
  if (buffer.includes(0)) return false;
  const decoded = buffer.toString("utf8");
  if (decoded.includes("\uFFFD")) return false;
  // 控制字符（除 tab/newline/carriage return/form feed）在纯文本里基本不出现。
  return !/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(decoded);
}

/**
 * 文件名清洗：票面明确「不支持中文名称」，这里把非 ASCII 一律拒绝而不是静默改名
 * —— 静默改名会让用户下载时拿到的名字和上传的对不上。
 *
 * 同时剥掉目录成分（浏览器在某些场景会把客户端路径塞进 filename）并挡掉隐藏文件名。
 */
export function sanitizeTicketAttachmentFileName(raw: unknown): { ok: true; fileName: string } | { ok: false; code: string; error: string } {
  if (typeof raw !== "string") return { ok: false, code: "INVALID_FILE_NAME", error: "缺少文件名" };
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, code: "INVALID_FILE_NAME", error: "缺少文件名" };
  if (trimmed.length > MAX_TICKET_ATTACHMENT_NAME_LEN) {
    return { ok: false, code: "FILE_NAME_TOO_LONG", error: `文件名不能超过 ${MAX_TICKET_ATTACHMENT_NAME_LEN} 个字符` };
  }
  if (/[^\x20-\x7E]/.test(trimmed)) {
    return {
      ok: false,
      code: "FILE_NAME_NON_ASCII",
      error: "文件名只支持英文、数字与常见符号（不支持中文名称），请重命名后再上传",
    };
  }
  // 目录成分：只取最后一段（`C:\a\b.png` 与 `a/b.png` 都归到 `b.png`）。
  const baseName = trimmed.split(/[\\/]/).pop() || "";
  if (!baseName || baseName === "." || baseName === ".." || baseName.startsWith(".")) {
    return { ok: false, code: "INVALID_FILE_NAME", error: "文件名无效" };
  }
  if (!baseName.includes(".")) {
    return { ok: false, code: "INVALID_FILE_NAME", error: `文件名缺少扩展名，仅支持 ${TICKET_ATTACHMENT_EXT_HINT}` };
  }
  return { ok: true, fileName: baseName };
}

export function resolveTicketAttachmentExt(fileName: string): TicketAttachmentExt | null {
  const dot = fileName.lastIndexOf(".");
  if (dot < 0 || dot === fileName.length - 1) return null;
  const ext = fileName.slice(dot + 1).toLowerCase();
  return EXT_SET.has(ext) ? (ext as TicketAttachmentExt) : null;
}

/**
 * 附件上传的统一校验（文件名 → 扩展名 → MIME → 体积 → 魔数 → 文本可读性）。
 *
 * 逐层都返回**面向用户的中文原因**：附件上传失败最常见的结局是「用户不知道为什么失败」。
 */
export function validateTicketAttachmentUpload(input: TicketAttachmentUploadInput): TicketAttachmentValidation {
  const nameResult = sanitizeTicketAttachmentFileName(input.fileName);
  if (!nameResult.ok) return { ok: false, code: nameResult.code, error: nameResult.error };
  const { fileName } = nameResult;

  const ext = resolveTicketAttachmentExt(fileName);
  if (!ext) {
    return fail("UNSUPPORTED_EXTENSION", `不支持的附件类型，仅支持 ${TICKET_ATTACHMENT_EXT_HINT}`);
  }

  const mimeType = typeof input.mimeType === "string" ? input.mimeType.toLowerCase().trim() : "";
  if (!TICKET_ATTACHMENT_MIME_BY_EXT[ext].includes(mimeType)) {
    return fail("MIME_MISMATCH", `文件类型与扩展名不一致（${ext} 需要 ${TICKET_ATTACHMENT_MIME_BY_EXT[ext].join(" / ")}）`);
  }

  if (!Buffer.isBuffer(input.buffer) || input.buffer.length === 0) {
    return fail("EMPTY_FILE", "附件内容为空");
  }
  if (typeof input.size !== "number" || input.size <= 0) {
    return fail("EMPTY_FILE", "附件内容为空");
  }
  if (input.size > MAX_TICKET_ATTACHMENT_BYTES) {
    return fail("FILE_TOO_LARGE", `单个附件不能超过 ${Math.round(MAX_TICKET_ATTACHMENT_BYTES / 1024 / 1024)}MB`);
  }
  if (input.buffer.length > MAX_TICKET_ATTACHMENT_BYTES) {
    // multer 的 size 与实际 buffer 长度理论上一致；以防万一以两者中更大者为准。
    return fail("FILE_TOO_LARGE", `单个附件不能超过 ${Math.round(MAX_TICKET_ATTACHMENT_BYTES / 1024 / 1024)}MB`);
  }

  if (!hasMagic(input.buffer, ext)) {
    return fail("CONTENT_MISMATCH", "文件内容与扩展名不匹配，请确认文件未损坏");
  }
  if (ext === "txt" && !looksLikeText(input.buffer)) {
    return fail("CONTENT_MISMATCH", "文本附件包含不可读内容，请确认文件为 UTF-8 纯文本");
  }

  return {
    ok: true,
    value: {
      fileName,
      ext,
      mimeType,
      size: input.buffer.length,
      sha256: crypto.createHash("sha256").update(input.buffer).digest("hex"),
    },
  };
}

export interface TicketAttachmentView {
  id: string;
  fileName: string;
  ext: string;
  mimeType: string;
  size: number;
  uploadedById: string;
  uploadedByName: string;
  createdAt: string | null;
}

function toDate(value: unknown): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value as string | number);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * 附件视图：**只回元数据，永不回 `data`**。
 *
 * 附件正文只走 `GET /api/tickets/:id/attachments/:attachmentId/download`（带属主校验），
 * 混进工单响应等于把二进制塞进 JSON。
 */
export function toTicketAttachmentView(attachment: unknown): TicketAttachmentView | null {
  if (!attachment || typeof attachment !== "object") return null;
  const source = attachment as Record<string, unknown>;
  const id = source._id != null ? String(source._id) : "";
  if (!id) return null;
  const createdAt = toDate(source.createdAt);
  return {
    id,
    fileName: typeof source.fileName === "string" ? source.fileName : "",
    ext: typeof source.ext === "string" ? source.ext : "",
    mimeType: typeof source.mimeType === "string" ? source.mimeType : "",
    size: typeof source.size === "number" ? source.size : 0,
    uploadedById: typeof source.userId === "string" ? source.userId : "",
    uploadedByName: typeof source.username === "string" ? source.username : "",
    createdAt: createdAt ? createdAt.toISOString() : null,
  };
}

/** 把字节数渲染成给人看的字符串（邮件 / 列表徽标用）。 */
export function formatTicketAttachmentSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0KB";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))}KB`;
  return `${Math.round((bytes / 1024 / 1024) * 10) / 10}MB`;
}
