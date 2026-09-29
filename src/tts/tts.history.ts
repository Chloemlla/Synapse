import { mongoose } from "../services/mongoService";
import type {
  GenerationHistoryStore,
  TtsDuplicateHit,
  TtsHistoryDeletedFilter,
  TtsHistoryRecord,
  TtsHistoryReviewStatus,
  TtsHistoryUserPatch,
} from "./tts.ports";

interface TtsHistoryDocument extends TtsHistoryRecord {
  duplicateScopeKey: string;
  /** Date 型时间戳，供 TTL 索引使用。 */
  createdAtDate?: Date;
}

const REVIEW_STATUSES: TtsHistoryReviewStatus[] = ["none", "needs_review", "in_review", "fixed", "dismissed"];

// 历史记录保留期：90 天（与 translationLog/auditLog 一致）。
const HISTORY_TTL_SECONDS = 90 * 24 * 60 * 60;
const REDACT_TEXT_MAX_LENGTH = 64;

// 用户自助字段的长度/数量上限：前端也截一遍，这里是不可信输入的最后一道闸。
const USER_TITLE_MAX_LENGTH = 120;
const USER_NOTE_MAX_LENGTH = 1000;
const USER_TAG_MAX_LENGTH = 24;
const USER_TAG_MAX_COUNT = 10;

const TtsHistorySchema = new mongoose.Schema<TtsHistoryDocument>(
  {
    scope: { type: String, enum: ["user", "anonymous"], required: true, index: true },
    userId: { type: String, index: true },
    ip: { type: String, index: true },
    fingerprint: { type: String, index: true },
    text: { type: String, required: true },
    voice: { type: String, required: true },
    model: { type: String, required: true },
    outputFormat: { type: String, required: true },
    speed: { type: Number, required: true },
    contentHash: { type: String, required: true, index: true },
    fileName: { type: String, required: true },
    audioUrl: { type: String, required: true },
    audioFileId: { type: String, index: true },
    audioStorage: { type: String, enum: ["file", "mongo"] },
    audioMimeType: { type: String },
    audioSize: { type: Number },
    provider: { type: String, required: true },
    providerModel: { type: String, required: true },
    providerVoice: { type: String, required: true },
    createdAt: { type: String, required: true, index: true },
    // 真正的 Date 型时间戳，用于 TTL 索引（TTL 只对 Date 生效）。
    createdAtDate: { type: Date, default: Date.now },
    userTitle: { type: String },
    userNote: { type: String },
    userTags: { type: [String], default: undefined },
    userDeletedAt: { type: String },
    adminNote: { type: String },
    adminSuggestion: { type: String },
    reviewStatus: { type: String, enum: REVIEW_STATUSES, default: "none", index: true },
    reviewedBy: { type: String },
    reviewedAt: { type: String },
    fixedAt: { type: String },
    updatedAt: { type: String },
    duplicateScopeKey: { type: String, required: true, index: true },
  },
  { collection: "tts_generation_history" },
);

TtsHistorySchema.index({ scope: 1, userId: 1, contentHash: 1, createdAt: -1 });
TtsHistorySchema.index({ scope: 1, duplicateScopeKey: 1, contentHash: 1, createdAt: -1 });
TtsHistorySchema.index({ scope: 1, userId: 1, userDeletedAt: 1, createdAt: -1 });
TtsHistorySchema.index({ createdAtDate: 1 }, { expireAfterSeconds: HISTORY_TTL_SECONDS });

const TtsHistoryModel =
  mongoose.models.TtsGenerationHistory ||
  mongoose.model<TtsHistoryDocument>("TtsGenerationHistory", TtsHistorySchema);

/**
 * 对外/落库文本脱敏：只保留前 64 个字符并附原始长度。
 * 函数名承诺脱敏就真的要脱敏，避免"命名骗人的空实现"让后续维护者误以为已脱敏。
 */
export function redactTtsTextForStorage(text: string): string {
  const raw = String(text || "");
  if (!raw) return "";
  if (raw.length <= REDACT_TEXT_MAX_LENGTH) return raw;
  return `${raw.slice(0, REDACT_TEXT_MAX_LENGTH)}…[len=${raw.length}]`;
}

function normalizeReviewStatus(value: unknown): TtsHistoryReviewStatus {
  return REVIEW_STATUSES.includes(value as TtsHistoryReviewStatus) ? (value as TtsHistoryReviewStatus) : "none";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function trimOptionalText(value: unknown, maxLength: number): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return String(value || "").trim().slice(0, maxLength);
}

/** 用户标签：去空、去重、截断、限量，保持提交顺序（前端 chips 依赖稳定顺序）。 */
function normalizeUserTags(value: unknown): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  for (const item of value) {
    const tag = String(item || "").trim().slice(0, USER_TAG_MAX_LENGTH);
    if (tag) {
      seen.add(tag);
      if (seen.size >= USER_TAG_MAX_COUNT) {
        break;
      }
    }
  }

  return Array.from(seen);
}

function mapHistoryRecord(record: any): TtsHistoryRecord {
  const { _id, __v, duplicateScopeKey, createdAtDate, ...rest } = record || {};
  return {
    ...rest,
    id: _id ? String(_id) : rest.id,
    text: String(rest.text || ""),
    reviewStatus: normalizeReviewStatus(rest.reviewStatus),
  };
}

function mapDuplicate(record: Partial<TtsHistoryRecord> | null | undefined): TtsDuplicateHit | null {
  if (!record?.fileName || !record.audioUrl || !record.outputFormat || !record.contentHash) {
    return null;
  }

  return {
    fileName: record.fileName,
    audioUrl: record.audioUrl,
    audioFileId: record.audioFileId,
    audioStorage: record.audioStorage,
    audioMimeType: record.audioMimeType,
    audioSize: record.audioSize,
    outputFormat: record.outputFormat,
    contentHash: record.contentHash,
    provider: (record as any).provider,
    providerModel: (record as any).providerModel,
    providerVoice: (record as any).providerVoice,
  };
}

export class MongoGenerationHistoryStore implements GenerationHistoryStore {
  private buildAnonymousScopeKey(ip: string, fingerprint: string): string {
    return `${ip}::${fingerprint}`;
  }

  public async findDuplicateForUser(params: {
    userId: string;
    text: string;
    voice: string;
    model: string;
    speed: number;
    outputFormat: string;
    contentHashes: string[];
  }) {
    const record = (await TtsHistoryModel.findOne({
      scope: "user",
      userId: params.userId,
      // 用户软删掉的记录不再参与去重复用，否则删除等于没删（还能拿回同一份音频）。
      userDeletedAt: { $exists: false },
      voice: params.voice,
      model: params.model,
      speed: params.speed,
      outputFormat: params.outputFormat,
      contentHash: { $in: params.contentHashes },
    })
      .sort({ createdAt: -1 })
      .lean()
      .exec()) as TtsHistoryRecord | null;

    return mapDuplicate(record);
  }

  public async addRecord(record: TtsHistoryRecord) {
    const duplicateScopeKey =
      record.scope === "user"
        ? record.userId || ""
        : this.buildAnonymousScopeKey(record.ip || "unknown", record.fingerprint || "unknown");
    const created = await TtsHistoryModel.create({
      ...record,
      text: redactTtsTextForStorage(record.text),
      createdAtDate: record.createdAt ? new Date(record.createdAt) : new Date(),
      reviewStatus: record.reviewStatus || "none",
      updatedAt: record.updatedAt || record.createdAt,
      duplicateScopeKey,
    });
    return mapHistoryRecord(created.toObject());
  }

  /** 统计某用户在同一时间窗内提交过的相同 contentHash 次数（G6-13 同用户重复判定）。 */
  public async countRecentByContentHash(params: {
    userId: string;
    contentHash: string;
    sinceIso: string;
  }): Promise<number> {
    return TtsHistoryModel.countDocuments({
      scope: "user",
      userId: params.userId,
      contentHash: params.contentHash,
      createdAt: { $gte: params.sinceIso },
    }).exec();
  }

  public async getRecentRecords(params: { userId: string; limit?: number }) {
    const limit = Math.max(1, Math.min(params.limit || 10, 50));
    // TTS 仅登录可用，历史只按 userId 取本人记录；匿名维度（ip::fingerprint）已停用。
    const records = (await TtsHistoryModel.find({
      scope: "user",
      userId: params.userId,
      userDeletedAt: { $exists: false },
    })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean()
      .exec()) as TtsHistoryRecord[];

    return records.map(mapHistoryRecord);
  }

  public async getAllRecords(params: {
    page?: number;
    limit?: number;
    userId?: string;
    scope?: "user" | "anonymous";
    reviewStatus?: TtsHistoryReviewStatus | "all";
    userDeleted?: TtsHistoryDeletedFilter;
    q?: string;
  }) {
    const page = Math.max(1, Math.floor(params.page || 1));
    const limit = Math.max(1, Math.min(params.limit || 20, 100));
    const query: Record<string, any> = {};
    const and: Record<string, any>[] = [];

    if (params.userId?.trim()) {
      query.userId = params.userId.trim();
    }

    if (params.scope === "user" || params.scope === "anonymous") {
      query.scope = params.scope;
    }

    if (params.reviewStatus && params.reviewStatus !== "all") {
      if (params.reviewStatus === "none") {
        and.push({
          $or: [{ reviewStatus: "none" }, { reviewStatus: { $exists: false } }, { reviewStatus: null }],
        });
      } else {
        query.reviewStatus = params.reviewStatus;
      }
    }

    // 用户软删除只对管理后台可见：默认全部（含已删除），可筛选只看已删除/未删除。
    if (params.userDeleted === "active") {
      and.push({ userDeletedAt: { $exists: false } });
    } else if (params.userDeleted === "deleted") {
      and.push({ userDeletedAt: { $exists: true, $nin: [null, ""] } });
    }

    const q = params.q?.trim();
    if (q) {
      const pattern = new RegExp(escapeRegExp(q), "i");
      // 不搜索 text：文本已脱敏且该字段无索引，搜索 text 会退化为全集合扫描。
      and.push({
        $or: [
          { userId: pattern },
          { fileName: pattern },
          { audioFileId: pattern },
          { audioMimeType: pattern },
          { contentHash: pattern },
          { voice: pattern },
          { model: pattern },
          { outputFormat: pattern },
          { provider: pattern },
          { providerModel: pattern },
          { providerVoice: pattern },
          { userTitle: pattern },
          { userNote: pattern },
          { userTags: pattern },
          { adminNote: pattern },
          { adminSuggestion: pattern },
        ],
      });
    }

    if (and.length) {
      query.$and = and;
    }

    const [records, total] = await Promise.all([
      TtsHistoryModel.find(query)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean()
        .exec(),
      TtsHistoryModel.countDocuments(query).exec(),
    ]);

    return {
      records: (records as TtsHistoryRecord[]).map(mapHistoryRecord),
      total,
      page,
      limit,
    };
  }

  public async updateAdminReview(
    recordId: string,
    patch: {
      adminNote?: string;
      adminSuggestion?: string;
      reviewStatus?: TtsHistoryReviewStatus;
      reviewedBy?: string;
    },
  ) {
    if (!mongoose.Types.ObjectId.isValid(recordId)) {
      return null;
    }

    const now = new Date().toISOString();
    const setPatch: Record<string, unknown> = {
      updatedAt: now,
    };
    const unsetPatch: Record<string, string> = {};

    if (patch.adminNote !== undefined) {
      setPatch.adminNote = trimOptionalText(patch.adminNote, 1000);
    }

    if (patch.adminSuggestion !== undefined) {
      setPatch.adminSuggestion = trimOptionalText(patch.adminSuggestion, 1000);
    }

    if (patch.reviewStatus !== undefined) {
      setPatch.reviewStatus = normalizeReviewStatus(patch.reviewStatus);
      setPatch.reviewedAt = now;
      setPatch.reviewedBy = trimOptionalText(patch.reviewedBy, 120);

      if (setPatch.reviewStatus === "fixed") {
        setPatch.fixedAt = now;
      } else {
        unsetPatch.fixedAt = "";
      }
    }

    const update: Record<string, unknown> = { $set: setPatch };
    if (Object.keys(unsetPatch).length) {
      update.$unset = unsetPatch;
    }

    const updated = await TtsHistoryModel.findByIdAndUpdate(recordId, update, { returnDocument: "after" })
      .lean()
      .exec();

    return updated ? mapHistoryRecord(updated) : null;
  }

  /**
   * 用户自助编辑本人记录（标题/备注/标签）。
   * owner 条件与「未被用户删除」都写进过滤里：越权与改已删记录一律返回 null，
   * 不给先读后判的 TOCTOU 留窗口。
   */
  public async updateUserRecord(params: { recordId: string; userId: string }, patch: TtsHistoryUserPatch) {
    if (!mongoose.Types.ObjectId.isValid(params.recordId)) {
      return null;
    }

    const setPatch: Record<string, unknown> = {
      updatedAt: new Date().toISOString(),
    };
    const unsetPatch: Record<string, string> = {};

    if (patch.userTitle !== undefined) {
      const userTitle = trimOptionalText(patch.userTitle, USER_TITLE_MAX_LENGTH);
      if (userTitle) {
        setPatch.userTitle = userTitle;
      } else {
        unsetPatch.userTitle = "";
      }
    }

    if (patch.userNote !== undefined) {
      const userNote = trimOptionalText(patch.userNote, USER_NOTE_MAX_LENGTH);
      if (userNote) {
        setPatch.userNote = userNote;
      } else {
        unsetPatch.userNote = "";
      }
    }

    if (patch.userTags !== undefined) {
      const userTags = normalizeUserTags(patch.userTags);
      if (userTags?.length) {
        setPatch.userTags = userTags;
      } else {
        unsetPatch.userTags = "";
      }
    }

    const update: Record<string, unknown> = { $set: setPatch };
    if (Object.keys(unsetPatch).length) {
      update.$unset = unsetPatch;
    }

    const updated = await TtsHistoryModel.findOneAndUpdate(
      {
        _id: params.recordId,
        scope: "user",
        userId: params.userId,
        userDeletedAt: { $exists: false },
      },
      update,
      { returnDocument: "after" },
    )
      .lean()
      .exec();

    return updated ? mapHistoryRecord(updated) : null;
  }

  /**
   * 软删除：只打标记，不物理删除，也不动音频资产。
   * 删除不可恢复（对外没有任何清标记的入口），管理后台仍然可见。
   */
  public async softDeleteRecord(params: { recordId: string; userId: string }) {
    if (!mongoose.Types.ObjectId.isValid(params.recordId)) {
      return null;
    }

    const deletedAt = new Date().toISOString();
    const updated = await TtsHistoryModel.findOneAndUpdate(
      {
        _id: params.recordId,
        scope: "user",
        userId: params.userId,
        userDeletedAt: { $exists: false },
      },
      { $set: { userDeletedAt: deletedAt, updatedAt: deletedAt } },
      { returnDocument: "after" },
    )
      .lean()
      .exec();

    return updated ? mapHistoryRecord(updated) : null;
  }
}

export const generationHistoryStore = new MongoGenerationHistoryStore();
