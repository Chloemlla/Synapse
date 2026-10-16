import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import GeoGebraAssetModel, { type GeoGebraAssetPurpose } from "../models/geogebraAssetModel";
import { GeoGebraDomainError } from "./projectService";

// 目的限定资产服务（GEO-18）。设计约束：
//  - 只有两种用途，每种用途各自钉死 MIME、魔数与体积上限，不做通用文件桶。
//  - 文件落在 data/geogebra/assets/<ownerUserId>/ 下，文件名由服务端生成，
//    客户端永远不能提供路径片段；读取时再次校验归属与目录包含关系。
//  - AI 参考图是敏感输入：TTL 远短于导出产物，且支持按账号删除（软删除 + 立即失效）。
const ASSET_ID_PATTERN = /^asset_[a-f0-9]{32}$/;
const OWNER_SEGMENT_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export const GEOGEBRA_ASSET_LIMITS: Record<GeoGebraAssetPurpose, {
  mimeTypes: readonly string[];
  maxBytes: number;
  ttlMs: number;
  extension: string;
}> = {
  // 参考图只用于一次性 AI 生成，保留时间越短越好。
  "ai-reference": {
    mimeTypes: ["image/png", "image/jpeg", "image/webp"],
    maxBytes: 4 * 1024 * 1024,
    ttlMs: 6 * 60 * 60_000,
    extension: "bin",
  },
  // 服务端打包产物，供用户稍后下载。
  "export-bundle": {
    mimeTypes: ["application/zip"],
    maxBytes: 32 * 1024 * 1024,
    ttlMs: 7 * 24 * 60 * 60_000,
    extension: "zip",
  },
};

const MAGIC_BYTES: ReadonlyArray<{ mimeType: string; offset: number; magic: readonly number[] }> = [
  { mimeType: "image/png", offset: 0, magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mimeType: "image/jpeg", offset: 0, magic: [0xff, 0xd8, 0xff] },
  { mimeType: "image/webp", offset: 8, magic: [0x57, 0x45, 0x42, 0x50] },
  { mimeType: "application/zip", offset: 0, magic: [0x50, 0x4b, 0x03, 0x04] },
];

/** 魔数是「声明 MIME 与真实内容是否一致」的唯一可靠判据，扩展名与 Content-Type 都可伪造。 */
export function detectGeoGebraAssetMimeType(bytes: Buffer): string | null {
  for (const candidate of MAGIC_BYTES) {
    const slice = bytes.subarray(candidate.offset, candidate.offset + candidate.magic.length);
    if (slice.length === candidate.magic.length && candidate.magic.every((byte, index) => slice[index] === byte)) {
      return candidate.mimeType;
    }
  }
  return null;
}

export type GeoGebraAssetView = {
  assetId: string;
  purpose: GeoGebraAssetPurpose;
  mimeType: string;
  byteSize: number;
  createdAt: string;
  expiresAt: string;
};

function assetRoot(): string {
  // 默认落在 data/geogebra/assets；允许环境覆盖，便于测试与多实例指向独立盘。
  const configured = String(process.env.GEOGEBRA_ASSET_ROOT || "").trim();
  return configured ? path.resolve(configured) : path.resolve(process.cwd(), "data", "geogebra", "assets");
}

function ownerDirectory(userId: string): string {
  if (!OWNER_SEGMENT_PATTERN.test(userId)) throw new GeoGebraDomainError("资源不存在。", 404, "GEOGEBRA_ASSET_NOT_FOUND");
  const root = assetRoot();
  const directory = path.resolve(root, userId);
  if (!directory.startsWith(`${root}${path.sep}`)) {
    throw new GeoGebraDomainError("资源不存在。", 404, "GEOGEBRA_ASSET_NOT_FOUND");
  }
  return directory;
}

async function resolveAssetPath(userId: string, storageKey: string): Promise<string> {
  if (!ASSET_ID_PATTERN.test(storageKey.replace(/\.[a-z0-9]+$/i, ""))) {
    throw new GeoGebraDomainError("资源不存在。", 404, "GEOGEBRA_ASSET_NOT_FOUND");
  }
  const directory = ownerDirectory(userId);
  const filePath = path.resolve(directory, storageKey);
  if (!filePath.startsWith(`${directory}${path.sep}`)) {
    throw new GeoGebraDomainError("资源不存在。", 404, "GEOGEBRA_ASSET_NOT_FOUND");
  }
  return filePath;
}

function assetView(asset: { assetId: string; purpose: GeoGebraAssetPurpose; mimeType: string; byteSize: number; createdAt: Date; expiresAt: Date }): GeoGebraAssetView {
  return {
    assetId: asset.assetId,
    purpose: asset.purpose,
    mimeType: asset.mimeType,
    byteSize: asset.byteSize,
    createdAt: new Date(asset.createdAt).toISOString(),
    expiresAt: new Date(asset.expiresAt).toISOString(),
  };
}

/** 从 data URL 读入用户上传内容；格式、魔数、体积三项都不过就直接拒绝，不落盘。 */
export async function createGeoGebraAssetFromDataUrl(
  userId: string,
  purpose: GeoGebraAssetPurpose,
  dataUrl: unknown,
): Promise<GeoGebraAssetView> {
  if (typeof dataUrl !== "string" || dataUrl.length === 0) {
    throw new GeoGebraDomainError("请先选择要上传的图片。", 400, "GEOGEBRA_ASSET_EMPTY");
  }
  const match = /^data:([a-z0-9/+.-]+);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(dataUrl);
  if (!match) throw new GeoGebraDomainError("图片格式暂不支持。", 400, "GEOGEBRA_ASSET_UNSUPPORTED_TYPE");
  const declaredType = match[1].toLowerCase();
  const limits = GEOGEBRA_ASSET_LIMITS[purpose];
  if (!limits.mimeTypes.includes(declaredType)) {
    throw new GeoGebraDomainError("图片格式暂不支持。", 400, "GEOGEBRA_ASSET_UNSUPPORTED_TYPE");
  }
  // 上限以外先按 base64 长度粗筛，避免为超大请求分配整块 Buffer。
  if (match[2].length > Math.ceil(limits.maxBytes / 3) * 4 + 4) {
    throw new GeoGebraDomainError("图片超过大小限制。", 413, "GEOGEBRA_ASSET_TOO_LARGE");
  }
  return createGeoGebraAssetFromBuffer(userId, purpose, Buffer.from(match[2], "base64"), declaredType);
}

export async function createGeoGebraAssetFromBuffer(
  userId: string,
  purpose: GeoGebraAssetPurpose,
  bytes: Buffer,
  declaredMimeType?: string,
): Promise<GeoGebraAssetView> {
  const limits = GEOGEBRA_ASSET_LIMITS[purpose];
  if (bytes.length === 0) throw new GeoGebraDomainError("上传内容为空。", 400, "GEOGEBRA_ASSET_EMPTY");
  if (bytes.length > limits.maxBytes) {
    throw new GeoGebraDomainError("上传内容超过大小限制。", 413, "GEOGEBRA_ASSET_TOO_LARGE");
  }
  const detected = detectGeoGebraAssetMimeType(bytes);
  if (!detected || !limits.mimeTypes.includes(detected)) {
    throw new GeoGebraDomainError("上传内容与声明格式不一致。", 400, "GEOGEBRA_ASSET_CONTENT_MISMATCH");
  }
  if (declaredMimeType && declaredMimeType !== detected) {
    throw new GeoGebraDomainError("上传内容与声明格式不一致。", 400, "GEOGEBRA_ASSET_CONTENT_MISMATCH");
  }

  const assetId = `asset_${crypto.randomBytes(16).toString("hex")}`;
  const storageKey = `${assetId}.${limits.extension}`;
  const directory = ownerDirectory(userId);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const target = await resolveAssetPath(userId, storageKey);
  const temporary = path.join(directory, `${assetId}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  try {
    await fs.writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    await fs.rename(temporary, target);
  } catch (error) {
    await fs.unlink(temporary).catch(() => undefined);
    throw error;
  }

  const now = Date.now();
  try {
    await GeoGebraAssetModel.create({
      assetId,
      ownerUserId: userId,
      purpose,
      mimeType: detected,
      byteSize: bytes.length,
      storageKey,
      subjectDeletedAt: 0,
      createdAt: new Date(now),
      expiresAt: new Date(now + limits.ttlMs),
    });
  } catch (error) {
    // 元数据写失败必须回收刚落的文件，否则会留下无主字节。
    await fs.unlink(target).catch(() => undefined);
    throw error;
  }

  return assetView({
    assetId,
    purpose,
    mimeType: detected,
    byteSize: bytes.length,
    createdAt: new Date(now),
    expiresAt: new Date(now + limits.ttlMs),
  });
}

/** 读取仅供所有者：查询条件里就带 ownerUserId，越权访问在数据层就命中不了。 */
export async function readGeoGebraAsset(userId: string, assetId: string): Promise<{ bytes: Buffer; mimeType: string; byteSize: number }> {
  if (!ASSET_ID_PATTERN.test(assetId)) {
    throw new GeoGebraDomainError("资源不存在。", 404, "GEOGEBRA_ASSET_NOT_FOUND");
  }
  const asset = await GeoGebraAssetModel.findOne({ assetId, ownerUserId: userId, subjectDeletedAt: 0 }).lean();
  if (!asset) throw new GeoGebraDomainError("资源不存在。", 404, "GEOGEBRA_ASSET_NOT_FOUND");
  if (new Date(asset.expiresAt).getTime() <= Date.now()) {
    throw new GeoGebraDomainError("资源已过期。", 410, "GEOGEBRA_ASSET_EXPIRED");
  }
  const bytes = await fs.readFile(await resolveAssetPath(userId, asset.storageKey)).catch(() => null);
  if (!bytes) throw new GeoGebraDomainError("资源不存在。", 404, "GEOGEBRA_ASSET_NOT_FOUND");
  return { bytes, mimeType: asset.mimeType, byteSize: asset.byteSize };
}

export async function deleteGeoGebraAsset(userId: string, assetId: string): Promise<void> {
  const asset = await GeoGebraAssetModel.findOneAndUpdate(
    { assetId, ownerUserId: userId, subjectDeletedAt: 0 },
    { $set: { subjectDeletedAt: Date.now() } },
    { returnDocument: "before" },
  ).lean();
  if (!asset) return;
  await fs.unlink(await resolveAssetPath(userId, asset.storageKey)).catch(() => undefined);
}

/** 账号删除联动：元数据立即失效，文件删不掉也不阻断账号流程。 */
export async function markUserGeoGebraAssetsDeleted(userId: string, deletedAt: number): Promise<void> {
  await GeoGebraAssetModel.updateMany(
    { ownerUserId: userId, subjectDeletedAt: 0 },
    { $set: { subjectDeletedAt: deletedAt } },
  );
}

/**
 * 清扫过期资产：Mongo TTL 只回收元数据，盘上的文件必须自己删。
 * 返回删除计数，供任务日志与测试断言。
 */
export async function cleanupExpiredGeoGebraAssets(now: number = Date.now()): Promise<{ removed: number }> {
  const expired = await GeoGebraAssetModel.find({ expiresAt: { $lte: new Date(now) } }).limit(200).lean();
  let removed = 0;
  for (const asset of expired) {
    try {
      await fs.unlink(await resolveAssetPath(asset.ownerUserId, asset.storageKey));
      removed += 1;
    } catch {
      // 文件本来就不在（或已被清理）也算清理成功，避免卡住批次。
      removed += 1;
    }
    await GeoGebraAssetModel.deleteOne({ assetId: asset.assetId });
  }
  return { removed };
}
