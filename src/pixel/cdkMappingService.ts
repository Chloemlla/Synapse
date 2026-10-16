import crypto from "node:crypto";
import PixelCdkMappingModel, { type IPixelCdkMapping } from "../models/pixelCdkMappingModel";
import {
  decryptPixelSecret,
  encryptPixelSecret,
  hashDistributionCdk,
  isValidSecretShape,
  maskSecret,
  newPixelId,
  normalizeDistributionCdk,
  PIXEL_SECRET_CRYPTO_VERSION,
} from "./runtime";
import { PixelDomainError, type PixelCdkMappingCreatedView, type PixelCdkMappingView } from "./types";

/**
 * CDK 映射的管理（PIX-11）。
 *
 * 不变量：
 *   · `distributionCdkHash`（sha256）唯一 → 重复创建返回 409；
 *   · 分发卡密明文**只在创建响应的那一次**出现（管理员当场复制给用户），从此不可读回；
 *   · 上游 CDK 可逆加密存储，接口只回遮罩值；
 *   · 停用（enabled=false）的映射不参与用户请求：`findByDistributionCdk` 返回记录，
 *     由调用方区分「不存在（404）」与「已停用（403）」，避免把停用说成不存在让人反复试。
 */

export interface PixelCdkMappingRecord {
  mappingId: string;
  distributionCdkHash: string;
  distributionCdkMasked: string;
  upstreamCdkMasked: string;
  note: string;
  enabled: boolean;
  createdByUserId: string;
  createdByUsername: string;
  createdAt: Date;
  updatedAt: Date;
  upstreamCdkCiphertext: string;
  upstreamCdkIv: string;
  upstreamCdkTag: string;
  upstreamCdkCryptoVersion: number;
}

export interface PixelCdkMappingCreateInput {
  distributionCdk?: unknown;
  upstreamCdk?: unknown;
  note?: unknown;
}

const MIN_DISTRIBUTION_CDK_CHARS = 12;
const MAX_DISTRIBUTION_CDK_CHARS = 128;
const MAX_UPSTREAM_CDK_CHARS = 256;
const DISTRIBUTION_CDK_PATTERN = /^[A-Za-z0-9._-]+$/;

function toRecord(doc: unknown): PixelCdkMappingRecord {
  const value = doc as IPixelCdkMapping;
  return {
    mappingId: String(value.mappingId),
    distributionCdkHash: String(value.distributionCdkHash),
    distributionCdkMasked: String(value.distributionCdkMasked ?? ""),
    upstreamCdkMasked: String(value.upstreamCdkMasked ?? ""),
    note: String(value.note ?? ""),
    enabled: Boolean(value.enabled),
    createdByUserId: String(value.createdByUserId ?? ""),
    createdByUsername: String(value.createdByUsername ?? ""),
    createdAt: new Date(value.createdAt),
    updatedAt: new Date(value.updatedAt),
    upstreamCdkCiphertext: String(value.upstreamCdkCiphertext ?? ""),
    upstreamCdkIv: String(value.upstreamCdkIv ?? ""),
    upstreamCdkTag: String(value.upstreamCdkTag ?? ""),
    upstreamCdkCryptoVersion: Number(value.upstreamCdkCryptoVersion ?? PIXEL_SECRET_CRYPTO_VERSION),
  };
}

function toView(record: PixelCdkMappingRecord): PixelCdkMappingView {
  return {
    mappingId: record.mappingId,
    distributionCdkMasked: record.distributionCdkMasked,
    upstreamCdkMasked: record.upstreamCdkMasked,
    note: record.note,
    enabled: record.enabled,
    createdByUsername: record.createdByUsername,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

/** 自动生成的分发卡密：前缀让人一眼看出是本地分发值，长度足够抗猜（128 bit 随机）。 */
function generateDistributionCdk(): string {
  return `dist-${crypto.randomUUID().replace(/-/g, "")}`;
}

function validateDistributionCdk(raw: unknown): string {
  const value = normalizeDistributionCdk(typeof raw === "string" ? raw : "");
  if (!value) return "";
  if (
    value.length < MIN_DISTRIBUTION_CDK_CHARS
    || value.length > MAX_DISTRIBUTION_CDK_CHARS
    || !DISTRIBUTION_CDK_PATTERN.test(value)
  ) {
    throw new PixelDomainError(
      `分发卡密需为 ${MIN_DISTRIBUTION_CDK_CHARS}-${MAX_DISTRIBUTION_CDK_CHARS} 位字母/数字/._- 组合。`,
      400,
      "PIXEL_MAPPING_DISTRIBUTION_INVALID",
    );
  }
  return value;
}

export const pixelCdkMappingService = {
  async create(
    input: PixelCdkMappingCreateInput,
    actor: { userId: string; username: string },
  ): Promise<PixelCdkMappingCreatedView> {
    const upstreamCdk = typeof input.upstreamCdk === "string" ? input.upstreamCdk.trim() : "";
    if (!isValidSecretShape(upstreamCdk, MAX_UPSTREAM_CDK_CHARS)) {
      throw new PixelDomainError("上游 CDK 不能为空。", 400, "PIXEL_MAPPING_UPSTREAM_REQUIRED");
    }
    const requestedDistribution = validateDistributionCdk(input.distributionCdk);
    const distributionCdk = requestedDistribution || generateDistributionCdk();
    const distributionCdkHash = hashDistributionCdk(distributionCdk);

    const existing = await PixelCdkMappingModel.findOne({ distributionCdkHash }).select("mappingId").lean();
    if (existing) {
      throw new PixelDomainError("该分发卡密已存在。", 409, "PIXEL_MAPPING_CONFLICT");
    }

    const encrypted = encryptPixelSecret(upstreamCdk);
    const note = typeof input.note === "string" ? input.note.trim().slice(0, 200) : "";

    try {
      const created = await PixelCdkMappingModel.create({
        mappingId: newPixelId("pcm"),
        distributionCdkHash,
        distributionCdkMasked: maskSecret(distributionCdk),
        upstreamCdkCiphertext: encrypted.ciphertext,
        upstreamCdkIv: encrypted.iv,
        upstreamCdkTag: encrypted.tag,
        upstreamCdkCryptoVersion: encrypted.cryptoVersion,
        upstreamCdkMasked: maskSecret(upstreamCdk),
        note,
        enabled: true,
        createdByUserId: actor.userId,
        createdByUsername: actor.username,
      });
      return {
        mapping: toView(toRecord(created)),
        // 明文只在这一行返回一次。
        distributionCdk,
      };
    } catch (error) {
      // 唯一索引竞态：两个管理员同时提交同一个分发卡密。
      if ((error as { code?: number }).code === 11000) {
        throw new PixelDomainError("该分发卡密已存在。", 409, "PIXEL_MAPPING_CONFLICT");
      }
      throw error;
    }
  },

  async list(): Promise<PixelCdkMappingView[]> {
    const docs = await PixelCdkMappingModel.find({}).sort({ createdAt: -1 }).limit(500).lean();
    return docs.map((doc) => toView(toRecord(doc)));
  },

  async getById(mappingId: string): Promise<PixelCdkMappingView | null> {
    if (!mappingId) return null;
    const doc = await PixelCdkMappingModel.findOne({ mappingId }).lean();
    return doc ? toView(toRecord(doc)) : null;
  },

  async remove(mappingId: string): Promise<void> {
    if (!mappingId) {
      throw new PixelDomainError("映射不存在。", 404, "PIXEL_MAPPING_NOT_FOUND");
    }
    const result = await PixelCdkMappingModel.deleteOne({ mappingId }).exec();
    if (Number(result.deletedCount ?? 0) === 0) {
      throw new PixelDomainError("映射不存在。", 404, "PIXEL_MAPPING_NOT_FOUND");
    }
  },

  /**
   * 按用户提交的卡密查映射（**不带 enabled 过滤**，让调用方能区分「不存在」与「已停用」）。
   * 找不到返回 null；卡密明文不落库，因此这里只可能用哈希匹配。
   */
  async findByDistributionCdk(card: string): Promise<PixelCdkMappingRecord | null> {
    const normalized = normalizeDistributionCdk(card);
    if (!normalized) return null;
    const doc = await PixelCdkMappingModel.findOne({ distributionCdkHash: hashDistributionCdk(normalized) }).lean();
    return doc ? toRecord(doc) : null;
  },

  /** 解密上游 CDK。解密失败一律当作「服务不可用」，绝不把密文当卡密发出去。 */
  decryptUpstreamCdk(record: PixelCdkMappingRecord): string {
    try {
      return decryptPixelSecret({
        ciphertext: record.upstreamCdkCiphertext,
        iv: record.upstreamCdkIv,
        tag: record.upstreamCdkTag,
        cryptoVersion: record.upstreamCdkCryptoVersion,
      });
    } catch {
      throw new PixelDomainError("该服务当前不可用，请联系管理员。", 503, "PIXEL_MAPPING_SECRET_UNAVAILABLE");
    }
  },

  async stats(): Promise<{ total: number; enabled: number }> {
    const [total, enabled] = await Promise.all([
      PixelCdkMappingModel.countDocuments({}).exec(),
      PixelCdkMappingModel.countDocuments({ enabled: true }).exec(),
    ]);
    return { total, enabled };
  },
};

/** 解析用户提交的卡密所需的最小查询能力（注入点：单测全部用假实现，不碰 Mongo）。 */
export interface PixelMappingLookups {
  findByDistributionCdk(card: string): Promise<PixelCdkMappingRecord | null>;
  decryptUpstreamCdk(record: PixelCdkMappingRecord): string;
}

export interface PixelResolvedCard {
  record: PixelCdkMappingRecord;
  /** 交给上游的 CDK 明文（只驻留请求内存，不入库、不入日志）。 */
  upstreamCdk: string;
  /** 用户提交的分发卡密（已去首尾空白）。 */
  card: string;
  masked: string;
}

/**
 * 卡密 → 启用的映射 + 上游 CDK。三个失败分支分开报：
 *   · 形状不合法 → 400（客户端没填 / 填了明显的垃圾）；
 *   · 查不到 → 404「卡密不存在或已失效」；
 *   · 存在但停用 → 403「已停用」——把停用说成不存在会让人反复试卡密；
 *   · 解密失败 → 503（在 decryptUpstreamCdk 里抛），绝不回退成把密文当卡密用。
 *
 * 它是对「映射语义」的唯一定义，card/task 两个 service 共用，避免两份 404/403 口径漂移。
 */
export async function resolveEnabledCardMapping(
  lookups: PixelMappingLookups,
  card: unknown,
): Promise<PixelResolvedCard> {
  const value = typeof card === "string" ? card.trim() : "";
  if (!isValidSecretShape(value)) {
    throw new PixelDomainError("请输入卡密。", 400, "PIXEL_CARD_INVALID");
  }
  const record = await lookups.findByDistributionCdk(value);
  if (!record) {
    throw new PixelDomainError("卡密不存在或已失效。", 404, "PIXEL_CARD_NOT_FOUND");
  }
  if (!record.enabled) {
    throw new PixelDomainError("该卡密已停用，请联系管理员。", 403, "PIXEL_CARD_DISABLED");
  }
  return {
    record,
    upstreamCdk: lookups.decryptUpstreamCdk(record),
    card: value,
    masked: maskSecret(value),
  };
}
