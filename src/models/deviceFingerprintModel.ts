import type { Document } from "mongoose";
// 与 accountIpSignalModel 同口径：模型必须绑定到 mongoService 的连接实例，
// 集成测试用 jest.mock 替换该实例时模型才会挂在同一个连接上。
import { mongoose } from "../services/mongoService";
import type { FingerprintComponentHashes } from "../utils/fingerprintComponents";

/**
 * 账户 × 设备指纹的**分量事实表**（RC-16）。
 *
 * 为什么必须单独建表，而不是塞进 `user_datas.fingerprints[]`：
 * 1. 用户文档里的 `fingerprints[]` 是**给用户/管理端看的最近 20 条快照**，会被新上报顶掉；
 *    跨账户比对（同一 WebGL 分量出现在多个 userId）需要可索引的独立集合；
 * 2. 分量漂移需要「上一次的值」，用户文档数组没有这个语义；
 * 3. 取证保留（RC-22）要求这张表不设 TTL，清理只能走应用层 + `legal_holds` 校验。
 *
 * 刻意**不建 Mongo TTL**：与 `account_ip_signals` 一致，风险证据要能活过账户删除。
 */
export interface IDeviceFingerprint extends Document {
  userId: string;
  /** 前端上报的复合指纹 id（FingerprintJS visitorId 或 SHA-256 兜底值）。 */
  fingerprintId: string;
  /** 当前分量摘要（Canvas / WebGL / 时区 / 屏幕各自 hash，不含原始图像）。 */
  componentHashes: FingerprintComponentHashes;
  /**
   * 上一次与当前不同的分量快照：只在真正发生漂移时才写，用于事后解释
   * 「哪个分量、从什么变成了什么」。空对象/null 表示从未漂移。
   */
  previousComponentHashes: FingerprintComponentHashes | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  /** 该 (userId, fingerprintId) 被看到的次数（`$inc`，不读改写）。 */
  seenCount: number;
  /** 分量漂移次数；`> 0` 即 `FP_COMPONENT_DRIFT` 的事实来源。 */
  driftCount: number;
  lastDriftAt: Date | null;
  /** 最近见过该指纹的来源 IP（上限 20 条，避免文档无限增长）。 */
  ips: string[];
  /** 上报来源标识（如 `fingerprint_report` / `login`），便于区分数据渠道。 */
  sources: string[];
  createdAt: Date;
  updatedAt: Date;
}

const componentHashesSchema = new mongoose.Schema<FingerprintComponentHashes>(
  {
    can: { type: String, default: "" },
    wgl: { type: String, default: "" },
    tz: { type: String, default: "" },
    scr: { type: String, default: "" },
  },
  { _id: false },
);

const deviceFingerprintSchema = new mongoose.Schema<IDeviceFingerprint>(
  {
    userId: { type: String, required: true, index: true },
    fingerprintId: { type: String, required: true },
    componentHashes: { type: componentHashesSchema, default: () => ({ can: "", wgl: "", tz: "", scr: "" }) },
    previousComponentHashes: { type: componentHashesSchema, default: null },
    firstSeenAt: { type: Date, required: true },
    lastSeenAt: { type: Date, required: true },
    seenCount: { type: Number, default: 1 },
    driftCount: { type: Number, default: 0 },
    lastDriftAt: { type: Date, default: null },
    ips: { type: [String], default: [] },
    sources: { type: [String], default: [] },
  },
  { timestamps: true, collection: "device_fingerprints" },
);

// 唯一键：一个账户对一台设备只留一行，重复上报只累加计数（幂等 upsert 的落点）。
deviceFingerprintSchema.index({ userId: 1, fingerprintId: 1 }, { unique: true });
// 账户维度按最近出现时间取（聚合与保留清理都走它）。
deviceFingerprintSchema.index({ userId: 1, lastSeenAt: -1 });
// 跨账户分量比对（RC-16.3 的 `FP_SHARED_ACROSS_ACCOUNTS`）：按 WebGL 分量 hash 反查其他账户。
// 这是抓「一人多号」的核心判据，必须走索引，否则每次聚合都是全表扫描。
deviceFingerprintSchema.index({ "componentHashes.wgl": 1, userId: 1 });
// Canvas 分量做同一目的的次级判据（wgl 缺失时的兜底比对）。
deviceFingerprintSchema.index({ "componentHashes.can": 1, userId: 1 });

export const DeviceFingerprint =
  (mongoose.models.DeviceFingerprint as mongoose.Model<IDeviceFingerprint>) ||
  mongoose.model<IDeviceFingerprint>("DeviceFingerprint", deviceFingerprintSchema);
