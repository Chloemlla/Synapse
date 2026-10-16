import mongoose, { type Document, Schema } from "mongoose";

// 目的限定资产（GEO-18）：只服务「AI 参考图」与「服务端打包产物」两种用途，
// 不做一个任意 URL/任意字节都能落库的通用上传表。
export type GeoGebraAssetPurpose = "ai-reference" | "export-bundle";

export interface IGeoGebraAsset extends Document {
  assetId: string;
  ownerUserId: string;
  purpose: GeoGebraAssetPurpose;
  mimeType: string;
  byteSize: number;
  /** 相对 data/geogebra/assets 的文件名；不含目录，避免路径穿越。 */
  storageKey: string;
  subjectDeletedAt: number;
  createdAt: Date;
  /** TTL：到期后元数据由 Mongo 回收，文件由 assetService 的清扫任务删除。 */
  expiresAt: Date;
}

const GeoGebraAssetSchema = new Schema<IGeoGebraAsset>(
  {
    assetId: { type: String, required: true, unique: true },
    ownerUserId: { type: String, required: true },
    purpose: { type: String, enum: ["ai-reference", "export-bundle"], required: true },
    mimeType: { type: String, required: true },
    byteSize: { type: Number, required: true },
    storageKey: { type: String, required: true },
    subjectDeletedAt: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true },
  },
  { collection: "geogebra_assets" },
);

GeoGebraAssetSchema.index({ ownerUserId: 1, createdAt: -1 });
GeoGebraAssetSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.models.GeoGebraAsset
  || mongoose.model<IGeoGebraAsset>("GeoGebraAsset", GeoGebraAssetSchema);
