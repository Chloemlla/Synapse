// doc-tool（Markdown → Word 批量转换）共享类型与默认值。
//
// 与 mediaTool/types.ts 同样的约束：只依赖 Node 内置模块，不 import mongoose / express / logger，
// 这样 runner、store、HTTP 层与单测都能共用同一份契约，也不会把运行期依赖带进类型层。
//
// 迁入自本机脚本 md2docx（F:\studys\md2docx），字段命名按服务端语义重排：
// 本机版的「输出到同目录 / 指定目录」在 Web 侧叫 alongside / custom，因为源文件是上传来的副本。

/** 目标 .docx 已存在时的处理方式。默认 rename：不覆盖用户已有产物。 */
export type ConflictMode = "skip" | "rename" | "overwrite";

/** alongside = 与上传的 .md 同目录；custom = 落到相对 outDir 下（保留子目录结构）。 */
export type OutMode = "alongside" | "custom";

/**
 * 任务状态。`partial` 是刻意的第三态：批量转换里「部分成功」既不该报成功也不该报失败，
 * 否则前端只能靠数字自己推断（本机版 md2docx 就是把 成功/跳过/失败 三计数并列显示的）。
 */
export type DocJobStatus = "queued" | "running" | "succeeded" | "partial" | "failed" | "cancelled";

/** 单个文件的处理结果状态。 */
export type DocItemStatus = "ok" | "skipped" | "failed";

/** 单个源文件相对「目标 .docx」的新旧关系（决定列表徽章与默认勾选）。 */
export type DocFileFreshness = "new" | "stale" | "fresh";

/** 用户偏好：服务端持久化，下次打开展示为已填状态。 */
export interface DocPrefs {
  conflict: ConflictMode;
  outMode: OutMode;
  /** outMode=custom 时的输出相对目录（相对用户工作目录，空表示 out） */
  outDir: string;
  /** 是否递归收集子目录里的 .md */
  recursive: boolean;
  /** 参考样式文档（用户工作目录内的相对路径，空表示不用） */
  referenceDoc: string;
}

/** 运行限额：由环境变量决定，只读。 */
export interface DocLimits {
  /** 单次上传的 .md 总大小上限（字节） */
  maxUploadBytes: number;
  /** 单个 .md 大小上限（字节） */
  maxFileBytes: number;
  /** 一个任务最多处理多少个文件 */
  maxFilesPerJob: number;
  /** 单个用户同时在排队/运行的任务上限 */
  maxActiveJobs: number;
  /** 产物保留天数（与 Mongo TTL 一致，用于磁盘清扫与提示文案） */
  retentionDays: number;
}

/** 已上传的 .md 在界面上的呈现（对应本机版的文件列表行 + 徽章）。 */
export interface DocFileEntry {
  rel: string;
  /** 源文件字节数（**字节**，不是 KB：同一界面里不要混两种量纲） */
  sizeBytes: number;
  /** epoch ms，前端自己格式化 */
  mtime: number;
  /** 本次会写出的 .docx 相对路径（rename 模式下已是「会另存为」的名字） */
  destRel: string;
  status: DocFileFreshness;
  /** true = 目标已存在、本次会另存为新名（界面显示「会另存为 xxx (2).docx」） */
  willRename: boolean;
}

/** 创建转换任务的入参（HTTP body）。files 与 recursive 二选一：给了 files 就只转这些。 */
export interface CreateJobInput {
  files?: string[];
  recursive?: boolean;
  outMode?: OutMode;
  outDir?: string;
  conflict?: ConflictMode;
  referenceDoc?: string;
}

/** 单个文件的转换结果。 */
export interface DocJobItem {
  rel: string;
  destRel: string;
  status: DocItemStatus;
  /** 产出文件字节数（**字节**） */
  sizeBytes?: number;
  ms?: number;
  /** 实际写了新名字（旧文件保留） */
  renamed?: boolean;
  error?: string;
}

/** 日志行：与 mediaTool 一致用 epoch 秒，前端只用来做「详情」折叠区。 */
export interface DocJobLog {
  t: number;
  text: string;
}

/**
 * 任务记录。时间字段用 Date 而不是 epoch 数字：本仓库的 TTL 索引都建在 Date 上，
 * 数字毫秒字段配 TTL 会在 1970 年就过期（auditLogModel 有同样的注释）。
 */
export interface DocJobRecord {
  id: string;
  /** 任务归属用户 id（用于隔离；不叫 ownerId 是为了和 userId 语义对齐） */
  userId: string;
  createdBy: string;
  createdAt: Date;
  startedAt?: Date;
  finishedAt?: Date;
  status: DocJobStatus;
  /** 当前阶段的中文短句（界面进度条下方一行） */
  stage: string;
  /** 0-100 */
  progress: number;
  total: number;
  done: number;
  ok: number;
  skipped: number;
  failed: number;
  input: {
    files: string[];
    outMode: OutMode;
    outDir: string;
    conflict: ConflictMode;
    referenceDoc: string;
  };
  items: DocJobItem[];
  logs: DocJobLog[];
  error?: string;
  cancelRequested: boolean;
}

/** GET /settings 的响应：限额 + 可选性检查 + 该用户的偏好。 */
export interface DocSettingsView {
  pandoc: PandocStatus;
  limits: DocLimits;
  prefs: DocPrefs;
  /** 用户工作目录内的模板清单（生成过的 reference.docx） */
  templates: ReferenceTemplate[];
}

/** GET /health 的响应。 */
export interface DocHealthView {
  ok: boolean;
  pandoc: PandocStatus;
  limits: DocLimits;
}

/** pandoc 可用性（本机版的「转换引擎」chip 对应这里）。 */
export interface PandocStatus {
  available: boolean;
  /** 形如 "pandoc 3.12.1"，探测失败时为空 */
  version: string;
  /** 实际使用的可执行文件路径/名字 */
  bin: string;
  /** 探测失败原因（界面「详情」里展示，不铺到主文案） */
  error?: string;
}

/** 参考样式模板条目。 */
export interface ReferenceTemplate {
  name: string;
  rel: string;
  /** 字节数 */
  sizeBytes: number;
  mtime: number;
}

/** 默认偏好：与本机版一致的「不覆盖」语义 —— 已存在就自动重命名；来源递归收集默认开。 */
export const DEFAULT_DOC_PREFS: DocPrefs = {
  conflict: "rename",
  outMode: "custom",
  outDir: "out",
  recursive: true,
  referenceDoc: "",
};

export const CONFLICT_MODES: ConflictMode[] = ["skip", "rename", "overwrite"];
export const OUT_MODES: OutMode[] = ["alongside", "custom"];

/** 只接受允许的枚举值，其余回落默认（PUT /settings 与创建任务都走它）。 */
export function normalizeConflict(value: unknown): ConflictMode {
  return CONFLICT_MODES.includes(value as ConflictMode) ? (value as ConflictMode) : DEFAULT_DOC_PREFS.conflict;
}

export function normalizeOutMode(value: unknown): OutMode {
  return OUT_MODES.includes(value as OutMode) ? (value as OutMode) : DEFAULT_DOC_PREFS.outMode;
}

const num = (raw: string | undefined, fallback: number): number => {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

/**
 * 限额从环境变量读取（与 .env.example 同步维护）。
 * 说明：上传上限刻意不放到运行时配置里 —— 它同时约束 multer 与磁盘配额，
 * 属于部署参数而不是产品开关，改它需要重启才不会出现「接口放行、multer 拒绝」的错位。
 */
export function docLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): DocLimits {
  return {
    maxUploadBytes: num(env.DOC_TOOL_MAX_UPLOAD_BYTES, 64 * 1024 * 1024),
    maxFileBytes: num(env.DOC_TOOL_MAX_FILE_BYTES, 8 * 1024 * 1024),
    maxFilesPerJob: num(env.DOC_TOOL_MAX_FILES_PER_JOB, 300),
    maxActiveJobs: num(env.DOC_TOOL_MAX_ACTIVE_JOBS, 3),
    retentionDays: num(env.DOC_TOOL_RETENTION_DAYS, 7),
  };
}
