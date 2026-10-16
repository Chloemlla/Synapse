import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const MAX_GEOGEBRA_COVER_BYTES = 512 * 1024;
const COVER_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const SHARE_ID_PATTERN = /^[a-zA-Z0-9_-]{16,80}$/;

function shareAssetRoot(): string {
  return path.resolve(process.cwd(), "data", "geogebra", "shares");
}

function resolveShareAssetPath(shareId: string): string {
  if (!SHARE_ID_PATTERN.test(shareId)) throw new Error("分享资源不存在。");
  const root = shareAssetRoot();
  const filePath = path.resolve(root, `${shareId}.png`);
  if (!filePath.startsWith(`${root}${path.sep}`)) throw new Error("分享资源不存在。");
  return filePath;
}

export function decodeGeoGebraPngDataUrl(value: unknown): Buffer | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new Error("封面图片格式无效。");
  const match = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) throw new Error("封面仅支持 PNG 图片。");
  const bytes = Buffer.from(match[1], "base64");
  if (bytes.length === 0 || bytes.length > MAX_GEOGEBRA_COVER_BYTES) {
    throw new Error("封面图片超过大小限制。");
  }
  if (bytes.length < COVER_MAGIC.length || !bytes.subarray(0, COVER_MAGIC.length).equals(COVER_MAGIC)) {
    throw new Error("封面图片内容无效。");
  }
  return bytes;
}

export async function writeGeoGebraShareCover(shareId: string, bytes: Buffer): Promise<void> {
  if (!SHARE_ID_PATTERN.test(shareId) || bytes.length === 0 || bytes.length > MAX_GEOGEBRA_COVER_BYTES
      || bytes.length < COVER_MAGIC.length || !bytes.subarray(0, COVER_MAGIC.length).equals(COVER_MAGIC)) {
    throw new Error("封面图片无效。");
  }
  const root = shareAssetRoot();
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const target = resolveShareAssetPath(shareId);
  const temporary = path.join(root, `${shareId}.${crypto.randomBytes(8).toString("hex")}.tmp`);
  try {
    await fs.writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    await fs.rename(temporary, target);
  } catch (error) {
    await fs.unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function readGeoGebraShareCover(shareId: string): Promise<Buffer | null> {
  try {
    const filePath = resolveShareAssetPath(shareId);
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size > MAX_GEOGEBRA_COVER_BYTES) return null;
    const bytes = await fs.readFile(filePath);
    if (bytes.length < COVER_MAGIC.length || !bytes.subarray(0, COVER_MAGIC.length).equals(COVER_MAGIC)) return null;
    return bytes;
  } catch {
    return null;
  }
}

export async function deleteGeoGebraShareCover(shareId: string): Promise<void> {
  try {
    await fs.unlink(resolveShareAssetPath(shareId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
