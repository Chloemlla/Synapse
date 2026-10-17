import { mongoose } from "../services/mongoService";

export interface IpVerificationTokenDoc {
  token: string;
  fingerprint: string;
  ipAddress: string;
  issuedBy: "auto" | "turnstile" | "hcaptcha" | "trycap";
  challengePassed: boolean;
  fraudScore?: number;
  riskFlags?: string[];
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
  lastValidatedAt?: Date;
}

const IpVerificationTokenSchema = new mongoose.Schema<IpVerificationTokenDoc>(
  {
    token: { type: String, required: true, unique: true, index: true },
    fingerprint: { type: String, required: true, index: true },
    ipAddress: { type: String, required: true, index: true },
    issuedBy: {
      type: String,
      enum: ["auto", "turnstile", "hcaptcha", "trycap"],
      required: true,
      default: "auto",
    },
    challengePassed: { type: Boolean, required: true, default: false },
    fraudScore: { type: Number, default: undefined },
    riskFlags: { type: [String], default: [] },
    expiresAt: { type: Date, required: true },
    lastValidatedAt: { type: Date, default: undefined },
  },
  {
    collection: "ip_verification_tokens",
    timestamps: true,
  },
);

// 查询索引（**不是 TTL**）：过期记录由 legalHoldCleanupService 清理（裁决三 / D8）。
IpVerificationTokenSchema.index({ expiresAt: 1 });
IpVerificationTokenSchema.index({ fingerprint: 1, ipAddress: 1, expiresAt: 1 });

export const IpVerificationTokenModel =
  (mongoose.models.IpVerificationToken as mongoose.Model<IpVerificationTokenDoc>) ||
  mongoose.model<IpVerificationTokenDoc>("IpVerificationToken", IpVerificationTokenSchema);
