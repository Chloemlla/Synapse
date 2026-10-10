import { mongoose } from "../services/mongoService";

/**
 * 注册尝试台账（RC-05「注册反滥用」）。
 *
 * 为什么单独一张表而不复用 `security_events`：注册闸门要按 **IP / 指纹 / 邮箱规范化值**
 * 三个维度各自计数，且要按**时间窗口**（24h / 7d）聚合 —— 这是典型的「事实表 + 复合索引」场景，
 * 塞进通用事件表会让前缀过滤 + 时间范围 + 多维分组都退化成扫描。
 *
 * 保留期用 TTL（90-180 天）：它是**计数用的运营数据**，不是取证证据；
 * 与 `account_ip_signals` 刻意不设 TTL 的取舍不同，理由已在这里写明。
 */
export interface IRegistrationAttempt {
  ipAddress: string;
  fingerprint: string;
  /** 规范化邮箱（小写 + 去 +tag + gmail 去点）：用于把变体折叠成同一个身份。 */
  emailCanonical: string;
  /** 实际提交的邮箱（保留原样，仅调查用；不做索引，避免把 PII 变成检索键）。 */
  emailRaw: string;
  inviteCode: string;
  outcome: "requested" | "succeeded" | "blocked";
  /** 当时的 IP 风险分快照（取不到为 null，不用 0 冒充「无风险」）。 */
  ipRiskScore: number | null;
  /** 命中闸门时的稳定 code，便于统计「拦在哪个规则上」。 */
  blockCode: string;
  createdAt: Date;
}

const registrationAttemptSchema = new mongoose.Schema<IRegistrationAttempt>(
  {
    ipAddress: { type: String, required: true, default: "" },
    fingerprint: { type: String, required: true, default: "" },
    emailCanonical: { type: String, default: "" },
    emailRaw: { type: String, default: "" },
    inviteCode: { type: String, default: "" },
    outcome: { type: String, enum: ["requested", "succeeded", "blocked"], default: "requested" },
    ipRiskScore: { type: Number, default: null },
    blockCode: { type: String, default: "" },
  },
  { timestamps: false, collection: "registration_attempts" },
);

// 三个维度各自「按窗口计数」：等值 + 时间范围，两个字段顺序固定才能既过滤又限定范围。
registrationAttemptSchema.index({ ipAddress: 1, createdAt: -1 });
registrationAttemptSchema.index({ fingerprint: 1, createdAt: -1 });
registrationAttemptSchema.index({ emailCanonical: 1, createdAt: -1 });
// 运营数据，到期即清（180 天）。取证需求走 account_ip_signals / security_events。
registrationAttemptSchema.index({ createdAt: 1 }, { expireAfterSeconds: 180 * 24 * 60 * 60 });

export const RegistrationAttempt =
  (mongoose.models.RegistrationAttempt as mongoose.Model<IRegistrationAttempt>) ||
  mongoose.model<IRegistrationAttempt>("RegistrationAttempt", registrationAttemptSchema);
