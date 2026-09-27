import { mongoose } from "../services/mongoService";
import type { BilibiliAccountClientIdentity } from "./bilibiliAccountBindingModel";

/**
 * Device-scoped Bilibili cookie reports.
 *
 * Unlike `bilibili_account_bindings` (which belongs to a logged-in Synapse user),
 * this collection stores the reports pushed by a client right after a Bilibili
 * login completes. The only identity the reporter claims is its own device id,
 * so rows are keyed by (clientId, deviceId, bilibiliUid) and never by userId.
 *
 * The cookie itself is stored exclusively as AES-GCM ciphertext; the encrypted
 * fields carry `select: false` so a stray `.lean()` can never pull plaintext
 * material into an admin listing.
 */
export interface BilibiliCookieReportDoc {
  clientId: string;
  deviceId: string;
  bilibiliUid: string;
  isPrimary: boolean;
  credentialCiphertext: string;
  credentialIv: string;
  credentialTag: string;
  credentialKeyVersion: string;
  credentialStatus: "active" | "invalid";
  credentialValidatedAt: Date;
  credentialLastCheckedAt: Date | null;
  firstReportedAt: Date;
  lastReportedAt: Date;
  reportCount: number;
  device: Record<string, unknown>;
  permissions: Record<string, string>;
  client: BilibiliAccountClientIdentity;
  createdAt: Date;
  updatedAt: Date;
}

const clientIdentitySchema = new mongoose.Schema<BilibiliAccountClientIdentity>(
  {
    clientId: { type: String, default: undefined },
    clientName: { type: String, default: undefined },
    clientVersion: { type: String, default: undefined },
    clientBuild: { type: String, default: undefined },
    deviceId: { type: String, default: undefined },
    deviceName: { type: String, default: undefined },
    platform: { type: String, default: undefined },
  },
  { _id: false },
);

const bilibiliCookieReportSchema = new mongoose.Schema<BilibiliCookieReportDoc>(
  {
    clientId: { type: String, required: true, index: true },
    deviceId: { type: String, required: true },
    bilibiliUid: { type: String, required: true },
    isPrimary: { type: Boolean, default: false },
    credentialCiphertext: { type: String, required: true, select: false },
    credentialIv: { type: String, required: true, select: false },
    credentialTag: { type: String, required: true, select: false },
    credentialKeyVersion: { type: String, required: true, select: false },
    credentialStatus: { type: String, enum: ["active", "invalid"], default: "active" },
    credentialValidatedAt: { type: Date, required: true },
    credentialLastCheckedAt: { type: Date, default: null },
    firstReportedAt: { type: Date, required: true },
    lastReportedAt: { type: Date, required: true, index: true },
    reportCount: { type: Number, required: true, default: 1 },
    device: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    permissions: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    client: { type: clientIdentitySchema, default: () => ({}) },
  },
  {
    collection: "bilibili_cookie_reports",
    timestamps: true,
  },
);

bilibiliCookieReportSchema.index({ clientId: 1, deviceId: 1, bilibiliUid: 1 }, { unique: true });
bilibiliCookieReportSchema.index({ bilibiliUid: 1, lastReportedAt: -1 });

export const BilibiliCookieReportModel =
  (mongoose.models.BilibiliCookieReport as mongoose.Model<BilibiliCookieReportDoc>) ||
  mongoose.model<BilibiliCookieReportDoc>("BilibiliCookieReport", bilibiliCookieReportSchema);
