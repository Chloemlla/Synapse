import { mongoose } from "./mongoService";
import logger from "../utils/logger";
import {
  DELETE_REASON_FIELD,
  DELETED_BY_FIELD,
  SUBJECT_DELETED_FIELD,
  activeRecordFilter,
  deletedRecordFilter,
  isSoftDeleted,
} from "../utils/softDeleteState";

/**
 * 统一的软删除设施（RC-21 / RC-22）。
 *
 * 为什么必须集中一处：仓库里曾有 30+ 个集合各自 `deleteOne/deleteMany`，每个删除点都
 * 配一句「此操作不可恢复」的前端文案。要按 owner 决策把这些改成软删除，散落各处逐个改
 * 必然漏项、也必然会随着新功能继续长出裸删除。因此这里提供唯一的写入口，
 * 并由治理闸门（scripts/governance）禁止业务代码在受管集合上出现裸删除。
 *
 * 字段约定（三个字段固定，便于按集合名做泛化查询与导出）——
 * 字段名与判据的唯一真相源是 `utils/softDeleteState.ts`，本文件不重复定义：
 *   - `subjectDeletedAt`: 0 或缺省 = 未删除；> 0 = 被软删除的时间戳（毫秒）。
 *     用`$in: [0, null]` 而不是 `0` 的原因见 softDeleteState 的注释。
 *   - `deletedBy`: 触发删除的操作者（用户 id / "auto" / 管理员 id）。
 *   - `deleteReason`: 可读原因，调查调取时要能解释「为什么留着这条」。
 *
 * 软删除**不**清凭据：凭据清理属于各集合自己的业务职责（例如 userService.softDeleteUser
 * 会清密码材料）。本模块只负责「标记 + 可查 + 可恢复」。
 */

export { DELETE_REASON_FIELD, DELETED_BY_FIELD, SUBJECT_DELETED_FIELD, isSoftDeleted };

/** 「未删除」判据。唯一真相源在 softDeleteState。 */
export function activeSubjectFilter(): Record<string, unknown> {
  return activeRecordFilter(SUBJECT_DELETED_FIELD);
}

/** 「已软删除」判据。 */
export function deletedSubjectFilter(): Record<string, unknown> {
  return deletedRecordFilter(SUBJECT_DELETED_FIELD);
}

export interface SoftDeleteOptions {
  /** 触发者：用户 id、管理员 id 或 "auto"。 */
  by?: string;
  /** 可读原因；调查调取与申诉处理都要靠它解释留存依据。 */
  reason?: string;
  now?: Date;
}

export interface SoftDeleteResult {
  matched: number;
  modified: number;
}

function buildUpdate(options: SoftDeleteOptions): Record<string, unknown> {
  const now = options.now ?? new Date();
  return {
    $set: {
      [SUBJECT_DELETED_FIELD]: now.getTime(),
      [DELETED_BY_FIELD]: options.by ?? "auto",
      [DELETE_REASON_FIELD]: options.reason ?? "",
    },
  };
}

function resolveCollection(name: string) {
  const db = mongoose.connection.db;
  if (!db) {
    throw new Error("数据库连接不可用");
  }
  return db.collection(name);
}

/**
 * 按集合名做软删除。`filter` 必须自带归属条件（例如 `{ userId }`）——
 * 本函数不做任何越权兜底，调用方要把 owner 条件写进 filter，避免「先读后改」的 TOCTOU。
 */
export async function softDeleteMany(
  collectionName: string,
  filter: Record<string, unknown>,
  options: SoftDeleteOptions = {},
): Promise<SoftDeleteResult> {
  const collection = resolveCollection(collectionName);
  // 已经软删除的记录不重复打标记（幂等）：`$in: [0, null]` 与入参 filter 合并，
  // 用 $and 而不是展开，避免 filter 里已有 subjectDeletedAt 时被覆盖。
  const result = await collection.updateMany({ $and: [filter, activeSubjectFilter()] }, buildUpdate(options));
  logger.info("[SoftDelete] 标记删除", {
    collection: collectionName,
    matched: result.matchedCount,
    modified: result.modifiedCount,
    by: options.by ?? "auto",
    reason: options.reason ?? "",
  });
  return { matched: result.matchedCount, modified: result.modifiedCount };
}

/** 单个文档的软删除，语义同 softDeleteMany。 */
export async function softDeleteOne(
  collectionName: string,
  filter: Record<string, unknown>,
  options: SoftDeleteOptions = {},
): Promise<SoftDeleteResult> {
  const collection = resolveCollection(collectionName);
  const result = await collection.updateOne({ $and: [filter, activeSubjectFilter()] }, buildUpdate(options));
  logger.info("[SoftDelete] 标记删除（单条）", {
    collection: collectionName,
    matched: result.matchedCount,
    modified: result.modifiedCount,
    by: options.by ?? "auto",
    reason: options.reason ?? "",
  });
  return { matched: result.matchedCount, modified: result.modifiedCount };
}

/**
 * 恢复：清掉三个标记字段。
 * 该入口只给「管理员误删纠正」用；对外没有任何面向用户的恢复入口（与 TTS 历史的语义一致）。
 */
export async function restoreMany(
  collectionName: string,
  filter: Record<string, unknown>,
): Promise<SoftDeleteResult> {
  const collection = resolveCollection(collectionName);
  const result = await collection.updateMany(
    { $and: [filter, deletedSubjectFilter()] },
    {
      $unset: {
        [SUBJECT_DELETED_FIELD]: "",
        [DELETED_BY_FIELD]: "",
        [DELETE_REASON_FIELD]: "",
      },
    },
  );
  logger.info("[SoftDelete] 恢复", {
    collection: collectionName,
    matched: result.matchedCount,
    modified: result.modifiedCount,
  });
  return { matched: result.matchedCount, modified: result.modifiedCount };
}

/**
 * 受管集合清单：治理闸门与取证导出都以它为准。
 * 新增集合时在这里加一条，否则裸删除检查不会覆盖到它。
 */
export const SOFT_DELETE_MANAGED_COLLECTIONS: readonly string[] = [
  "user_datas",
  "api_keys",
  "short_urls",
  "security_events",
  "device_trackings",
  "policy_consents",
  "tickets",
  "cdks",
  "resources",
  "data_collections",
  "webhook_events",
  "registration_invites",
  "voice_projects",
  "workspaces",
  "translation_logs",
  "bilibili_sync",
  "nexai_sync",
];

/** 该集合是否受软删除治理。 */
export function isSoftDeleteManaged(collectionName: string): boolean {
  return SOFT_DELETE_MANAGED_COLLECTIONS.includes(collectionName);
}
