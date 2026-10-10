import type { Document } from "mongoose";
// 从 mongoService 取 mongoose 实例（不是直接从 "mongoose" 包）：
// 集成测试用 jest.mock 替换 mongoService 的连接实例，模型必须绑定到同一个实例，
// 否则模型挂在未连接的默认连接上（新模型一律沿用 authEmailCooldownModel 的写法）。
import { mongoose } from "../services/mongoService";

/**
 * 账户 × 登录 IP 的事实表（RC-06「历来登录 IP 的 risk score」）。
 *
 * 为什么必须单独建表：`proxycheck_risk_cache` 是 **IP 维度**、TTL 24 小时的临时结论，
 * 而需求要的是「这个账户历来用过哪些 IP、它们各自多危险」。账户维度原先只有
 * `user_datas.lastLoginIp` 一个单值 —— 换成新 IP 就把旧结论覆盖掉了。
 *
 * 刻意**不建 TTL 索引**（RC-22 裁决三）：审计与取证需要的结论不能由数据库后台线程
 * 静默删除。保留期由运行时配置 `accountRisk.ipSignalRetentionDays` 表达，
 * 清理必须走应用层任务并在删除前校验 `legal_holds`。
 */
export interface IAccountIpSignal extends Document {
  userId: string;
  ipAddress: string;
  ipLocation: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
  loginCount: number;
  /** 该 IP 的风险分快照；从未查到结论时为 null（不要用 0，0 是「确认无风险」）。 */
  riskScore: number | null;
  riskLevel: string;
  flags: string[];
  /** 机房/IDC 判据（RC-14）：proxycheck 的 networkType/asn/organisation 此前入库但没有消费方。 */
  networkType: string;
  asn: string;
  organisation: string;
  isDatacenter: boolean;
  /** 结论来源：cache 命中缓存、proxycheck 是同步补查、unavailable 表示暂无结论。 */
  source: "cache" | "proxycheck" | "unavailable";
  riskCheckedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const accountIpSignalSchema = new mongoose.Schema<IAccountIpSignal>(
  {
    userId: { type: String, required: true, index: true },
    ipAddress: { type: String, required: true },
    ipLocation: { type: String, default: "" },
    firstSeenAt: { type: Date, required: true },
    lastSeenAt: { type: Date, required: true },
    loginCount: { type: Number, default: 1 },
    riskScore: { type: Number, default: null },
    riskLevel: { type: String, default: "" },
    flags: { type: [String], default: [] },
    networkType: { type: String, default: "" },
    asn: { type: String, default: "" },
    organisation: { type: String, default: "" },
    isDatacenter: { type: Boolean, default: false },
    source: { type: String, enum: ["cache", "proxycheck", "unavailable"], default: "unavailable" },
    riskCheckedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: "account_ip_signals" },
);

// 唯一键：一个账户对一个 IP 只留一行，重复登录只累加 loginCount（幂等 upsert 的落点）。
accountIpSignalSchema.index({ userId: 1, ipAddress: 1 }, { unique: true });
// 聚合「最近 N 天登录 IP」：过滤 + 倒序排序都走索引，避免 sort memory limit。
accountIpSignalSchema.index({ userId: 1, lastSeenAt: -1 });
// 跨账户同 IP（一人多号）反查：不是主判据（NAT 会误伤），仅供管理端调查与加权。
accountIpSignalSchema.index({ ipAddress: 1, lastSeenAt: -1 });

export const AccountIpSignal =
  (mongoose.models.AccountIpSignal as mongoose.Model<IAccountIpSignal>) ||
  mongoose.model<IAccountIpSignal>("AccountIpSignal", accountIpSignalSchema);
