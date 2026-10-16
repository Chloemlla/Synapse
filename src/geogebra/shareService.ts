import crypto from "node:crypto";
import GeoGebraShareModel, { type IGeoGebraShare } from "../models/geogebraShareModel";
import { createGeoGebraProject, getAccessibleGeoGebraProject, GeoGebraDomainError } from "./projectService";
import {
  decodeGeoGebraPngDataUrl,
  deleteGeoGebraShareCover,
  readGeoGebraShareCover,
  writeGeoGebraShareCover,
} from "./shareAssetStorage";
import { validateGeoGebraCommands } from "./scriptValidation";
import type { GeoGebraMode } from "../models/geogebraProjectModel";

const MODES = new Set<GeoGebraMode>(["geometry", "3d", "graphing", "classic"]);

function newShareId(): string {
  return `share_${crypto.randomUUID().replace(/-/g, "")}`;
}

function makeSlug(title: string): string {
  const stem = title.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "canvas";
  return `${stem}-${crypto.randomBytes(5).toString("hex")}`;
}

function shareView(share: IGeoGebraShare) {
  return {
    shareId: share.shareId,
    slug: share.slug,
    title: share.title,
    canvasMode: share.canvasMode,
    commands: share.commands,
    coverUrl: share.coverStored && !share.revokedAt && !share.subjectDeletedAt ? `/api/geogebra/shares/${encodeURIComponent(share.slug)}/cover` : null,
    allowFork: share.allowFork,
    revokedAt: share.revokedAt ?? null,
    createdAt: share.createdAt,
  };
}

export async function createGeoGebraShare(userId: string, input: {
  projectId?: unknown;
  title?: unknown;
  canvasMode?: unknown;
  commands?: unknown;
  coverDataUrl?: unknown;
  allowFork?: unknown;
}) {
  const commands = validateGeoGebraCommands(input.commands);
  const mode = typeof input.canvasMode === "string" && MODES.has(input.canvasMode as GeoGebraMode)
    ? input.canvasMode as GeoGebraMode
    : null;
  if (!mode) throw new GeoGebraDomainError("请先选择有效的画布类型。", 400, "GEOGEBRA_SHARE_INVALID");
  const title = typeof input.title === "string" ? input.title.trim().slice(0, 120) : "";
  if (!title) throw new GeoGebraDomainError("请填写分享标题。", 400, "GEOGEBRA_SHARE_INVALID");

  const projectId = typeof input.projectId === "string" && input.projectId.trim() ? input.projectId.trim() : null;
  if (projectId) await getAccessibleGeoGebraProject(userId, projectId, "write");

  const shareId = newShareId();
  const coverBytes = decodeGeoGebraPngDataUrl(input.coverDataUrl);
  if (coverBytes) await writeGeoGebraShareCover(shareId, coverBytes);
  try {
    const share = await GeoGebraShareModel.create({
      shareId,
      slug: makeSlug(title),
      ownerUserId: userId,
      projectId,
      title,
      canvasMode: mode,
      commands,
      allowFork: input.allowFork !== false,
      coverStored: Boolean(coverBytes),
      revokedAt: null,
      subjectDeletedAt: 0,
    });
    return shareView(share as unknown as IGeoGebraShare);
  } catch (error) {
    if (coverBytes) await deleteGeoGebraShareCover(shareId).catch(() => undefined);
    if ((error as { code?: number }).code === 11000) {
      throw new GeoGebraDomainError("分享创建失败，请重试。", 409, "GEOGEBRA_SHARE_CONFLICT");
    }
    throw error;
  }
}

export async function listGeoGebraShares(userId: string) {
  const shares = await GeoGebraShareModel.find({ ownerUserId: userId, subjectDeletedAt: 0 }).sort({ createdAt: -1 }).limit(100).lean();
  return shares.map((share) => shareView(share as unknown as IGeoGebraShare));
}

export async function getPublicGeoGebraShare(slug: string) {
  const safeSlug = slug.trim().slice(0, 100);
  if (!/^[a-z0-9-]{10,100}$/i.test(safeSlug)) {
    throw new GeoGebraDomainError("分享不存在或已撤销。", 404, "GEOGEBRA_SHARE_NOT_FOUND");
  }
  const share = await GeoGebraShareModel.findOne({ slug: safeSlug, revokedAt: null, subjectDeletedAt: 0 }).lean();
  if (!share) throw new GeoGebraDomainError("分享不存在或已撤销。", 404, "GEOGEBRA_SHARE_NOT_FOUND");
  return shareView(share as unknown as IGeoGebraShare);
}

export async function getPublicGeoGebraShareCover(slug: string) {
  const share = await GeoGebraShareModel.findOne({ slug, revokedAt: null, subjectDeletedAt: 0 }).select("shareId coverStored").lean();
  if (!share || !share.coverStored) throw new GeoGebraDomainError("封面不存在。", 404, "GEOGEBRA_SHARE_COVER_NOT_FOUND");
  const bytes = await readGeoGebraShareCover(share.shareId);
  if (!bytes) throw new GeoGebraDomainError("封面不存在。", 404, "GEOGEBRA_SHARE_COVER_NOT_FOUND");
  return bytes;
}

export async function forkGeoGebraShare(userId: string, slug: string) {
  const share = await GeoGebraShareModel.findOne({ slug, revokedAt: null, subjectDeletedAt: 0 }).lean();
  if (!share) throw new GeoGebraDomainError("分享不存在或已撤销。", 404, "GEOGEBRA_SHARE_NOT_FOUND");
  if (!share.allowFork) throw new GeoGebraDomainError("该分享暂不支持创建副本。", 403, "GEOGEBRA_SHARE_FORK_DISABLED");
  return createGeoGebraProject(userId, {
    title: `${share.title}（副本）`.slice(0, 120),
    folder: "个人空间",
    tags: ["分享副本"],
    canvasMode: share.canvasMode,
    code: `${share.commands.join("\n")}\n`,
  });
}

export async function deleteGeoGebraShare(userId: string, shareId: string): Promise<void> {
  const share = await GeoGebraShareModel.findOne({ shareId, subjectDeletedAt: 0 }).lean();
  if (!share) throw new GeoGebraDomainError("分享不存在。", 404, "GEOGEBRA_SHARE_NOT_FOUND");
  if (share.ownerUserId !== userId) throw new GeoGebraDomainError("分享不存在。", 404, "GEOGEBRA_SHARE_NOT_FOUND");
  await GeoGebraShareModel.updateOne({ shareId, subjectDeletedAt: 0 }, { $set: { revokedAt: new Date(), coverStored: false } });
  await deleteGeoGebraShareCover(shareId);
}

export async function removeGeoGebraCoversForUser(userId: string): Promise<void> {
  const shares = await GeoGebraShareModel.find({ ownerUserId: userId }).select("shareId").lean();
  await Promise.all(shares.map((share) => deleteGeoGebraShareCover(share.shareId).catch(() => undefined)));
}
