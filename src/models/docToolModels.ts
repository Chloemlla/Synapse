import mongoose from "mongoose";
import {
  CONFLICT_MODES,
  DEFAULT_DOC_PREFS,
  OUT_MODES,
  docLimitsFromEnv,
  type DocJobItem,
  type DocJobLog,
  type DocJobRecord,
  type DocJobStatus,
  type DocPrefs,
} from "../docTool/types";

/**
 * doc_tool_jobs 集合：与 src/docTool/types.ts 的 DocJobRecord 同构。
 *
 * 时间字段是 **Date** 而不是 media_tool_jobs 那样的 epoch 毫秒数字，因为本表的保留期靠 TTL 实现：
 * TTL 是索引的物理属性，只对 BSON Date 生效 —— 换成数字毫秒，整张表会在「1970 年之后的第 7 天」全员命中过期，
 * 表现为任务一创建就从列表里消失（auditLogModel 有同样的注释）。
 */
export interface DocToolJobDoc {
  id: string;
  userId: string;
  createdBy: string;
  createdAt: Date;
  startedAt?: Date;
  finishedAt?: Date;
  status: DocJobStatus;
  stage: string;
  progress: number;
  total: number;
  done: number;
  ok: number;
  skipped: number;
  failed: number;
  input: DocJobRecord["input"];
  items: DocJobItem[];
  logs: DocJobLog[];
  error?: string;
  cancelRequested: boolean;
}

/** 单个文件的转换结果（与 DocJobItem 同构）。 */
const jobItemSchema = new mongoose.Schema<DocJobItem>(
  {
    rel: { type: String, required: true },
    destRel: { type: String, required: true },
    status: { type: String, enum: ["ok", "skipped", "failed"], required: true },
    sizeBytes: { type: Number },
    ms: { type: Number },
    renamed: { type: Boolean },
    error: { type: String },
  },
  { _id: false },
);

const jobLogSchema = new mongoose.Schema<DocJobLog>(
  {
    t: { type: Number, required: true },
    text: { type: String, required: true },
  },
  { _id: false },
);

/** 任务入参快照：任务建好之后用户再改设置也不该改变这次转换的策略，所以整块存进记录里。 */
const jobInputSchema = new mongoose.Schema<DocJobRecord["input"]>(
  {
    files: { type: [String], default: [] },
    outMode: { type: String, enum: OUT_MODES, default: DEFAULT_DOC_PREFS.outMode },
    outDir: { type: String, default: DEFAULT_DOC_PREFS.outDir },
    conflict: { type: String, enum: CONFLICT_MODES, default: DEFAULT_DOC_PREFS.conflict },
    referenceDoc: { type: String, default: "" },
  },
  { _id: false },
);

const jobSchema = new mongoose.Schema<DocToolJobDoc>(
  {
    id: { type: String, required: true, unique: true },
    userId: { type: String, required: true },
    createdBy: { type: String, required: true },
    createdAt: { type: Date, required: true },
    startedAt: { type: Date },
    finishedAt: { type: Date },
    status: {
      type: String,
      enum: ["queued", "running", "succeeded", "partial", "failed", "cancelled"],
      required: true,
      default: "queued",
    },
    stage: { type: String, default: "" },
    progress: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
    done: { type: Number, default: 0 },
    ok: { type: Number, default: 0 },
    skipped: { type: Number, default: 0 },
    failed: { type: Number, default: 0 },
    input: { type: jobInputSchema, required: true },
    items: { type: [jobItemSchema], default: [] },
    logs: { type: [jobLogSchema], default: [] },
    error: { type: String },
    cancelRequested: { type: Boolean, default: false },
  },
  { collection: "doc_tool_jobs", versionKey: false },
);

// 用户页「我的任务」列表
jobSchema.index({ userId: 1, createdAt: -1 });
// 重启恢复按 status 捞残留的 queued/running
jobSchema.index({ status: 1, createdAt: -1 });

/**
 * 产物与记录一起过期（默认 7 天，见 docLimitsFromEnv 的 DOC_TOOL_RETENTION_DAYS）。
 *
 * 为什么在模块加载时读一次 env：TTL 是索引创建那一刻的选项。改了 env 只会影响「新建的索引」——
 * MongoDB 不会因为 schema 里 expireAfterSeconds 变了就更新已存在的同名索引（只会报索引冲突），
 * 所以运行期读它没有任何意义，反而会让人以为改了就生效。存量部署要改保留期，得显式重建索引。
 */
const JOB_RETENTION_DAYS = docLimitsFromEnv().retentionDays;
jobSchema.index({ createdAt: 1 }, { expireAfterSeconds: JOB_RETENTION_DAYS * 24 * 60 * 60 });

export const DocToolJobModel =
  (mongoose.models.DocToolJob as mongoose.Model<DocToolJobDoc>) ||
  mongoose.model<DocToolJobDoc>("DocToolJob", jobSchema);

/** doc_tool_prefs 集合：一个用户一行偏好，下次打开展示为已填状态。 */
export interface DocToolPrefsDoc {
  userId: string;
  prefs: DocPrefs;
  updatedAt: Date;
}

const prefsSchema = new mongoose.Schema<DocToolPrefsDoc>(
  {
    userId: { type: String, required: true, unique: true },
    // Mixed 而不是子 schema：偏好的键集由 types.ts 的 DocPrefs 决定，校验统一走 settingsStore 的白名单
    prefs: { type: mongoose.Schema.Types.Mixed, required: true },
    updatedAt: { type: Date, required: true },
  },
  { collection: "doc_tool_prefs", versionKey: false },
);
// 一人一行：唯一索引同时兜住并发双击 upsert 造成的重复行（与 userPreferencesModel 同写法，
// 不另写 schema.index，两者同时声明会触发 mongoose 的重复索引告警）

export const DocToolPrefsModel =
  (mongoose.models.DocToolPrefs as mongoose.Model<DocToolPrefsDoc>) ||
  mongoose.model<DocToolPrefsDoc>("DocToolPrefs", prefsSchema);
