import { mongoose } from "../services/mongoService";

/**
 * API Key 的**分钟桶**用量窗口（RC-18）。
 *
 * 为什么不是“在每个请求里算一遍”：判“突发”与“爬虫节奏”都需要**历史基线**与**到达间隔统计**，
 * 逐请求重算是 O(窗口) 的；把统计量增量维护在桶里，判定时只读一行 + 一次短聚合。
 *
 * 存的是**统计量**（计数、到达间隔的均值/二阶矩），不存原始时间戳数组 —— 后者既放大存储，
 * 又把“用户怎么用 API”的细粒度行为留在库里（隐私面）。
 *
 * TTL 7 天：它是观测/判定用的运营数据；判定基线本身就只回看 7 天。
 */
export interface IApiUsageWindow {
  keyId: string;
  userId: string;
  /** 分钟键（UTC，`YYYY-MM-DDTHH:mm`）：同一分钟内累加，不做跨时区归桶（判据与用户本地日无关）。 */
  minuteKey: string;
  /** 该分钟内的请求数。 */
  count: number;
  /** 到达间隔的 Welford 统计（毫秒）：均值 / 二阶矩 / 样本数。 */
  interArrivalMeanMs: number;
  interArrivalM2: number;
  interArrivalCount: number;
  lastSampleAt: Date | null;
  /** 判定结果快照（只写一次，便于事后解释“当时为什么给它降速”）。 */
  flags: string[];
  createdAt: Date;
  updatedAt: Date;
}

const apiUsageWindowSchema = new mongoose.Schema<IApiUsageWindow>(
  {
    keyId: { type: String, required: true, index: true },
    userId: { type: String, default: "" },
    minuteKey: { type: String, required: true },
    count: { type: Number, default: 0 },
    interArrivalMeanMs: { type: Number, default: 0 },
    interArrivalM2: { type: Number, default: 0 },
    interArrivalCount: { type: Number, default: 0 },
    lastSampleAt: { type: Date, default: null },
    flags: { type: [String], default: [] },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  },
  { timestamps: false, collection: "api_usage_windows" },
);

apiUsageWindowSchema.index({ keyId: 1, minuteKey: 1 }, { unique: true });
// 基线聚合：按 keyId 取最近 N 分钟。
apiUsageWindowSchema.index({ keyId: 1, createdAt: -1 });
apiUsageWindowSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 });

export const ApiUsageWindow =
  (mongoose.models.ApiUsageWindow as mongoose.Model<IApiUsageWindow>) ||
  mongoose.model<IApiUsageWindow>("ApiUsageWindow", apiUsageWindowSchema);
