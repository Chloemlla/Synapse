import mongoose, { Schema } from "mongoose";

/**
 * GeoGebra AI 提供商配置（管理端「运行时配置 → GeoGebra AI 提供商」）。
 *
 * 单例文档（_id = "default"）。三种来源：
 *  - env：沿用 GEOGEBRA_AI_* → OPENAI_* 环境变量（历史行为，也是无文档时的默认）；
 *  - custom：独立填写 baseUrl/apiKey/model；
 *  - librechat：复用 chat_providers 里的一条 LibreChat 提供者。
 *
 * apiKey 与 LibreChat 提供者一样是明文落库（运行时配置的既有口径），但必须 select:false，
 * 只有解析 provider 与超管读取配置时才显式 `.select("+apiKey")`，避免列表/诊断误带出去。
 */
export type GeoGebraAiProviderMode = "env" | "custom" | "librechat";

export interface GeoGebraAiConfigDoc {
  _id: string;
  mode: GeoGebraAiProviderMode;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 模型是否支持图片输入；custom / librechat 模式共用。 */
  vision: boolean;
  librechatProviderId: string;
  updatedAt: Date;
  updatedBy: string;
}

const GeoGebraAiConfigSchema = new Schema<GeoGebraAiConfigDoc>(
  {
    _id: { type: String, default: "default" },
    mode: { type: String, enum: ["env", "custom", "librechat"], default: "env" },
    baseUrl: { type: String, default: "", maxlength: 2_048 },
    apiKey: { type: String, default: "", maxlength: 2_048, select: false },
    model: { type: String, default: "", maxlength: 200 },
    vision: { type: Boolean, default: false },
    librechatProviderId: { type: String, default: "", maxlength: 80 },
    updatedAt: { type: Date, default: Date.now },
    updatedBy: { type: String, default: "", maxlength: 120 },
  },
  { collection: "geogebra_ai_configs", versionKey: false },
);

export default (mongoose.models.GeoGebraAiConfig as mongoose.Model<GeoGebraAiConfigDoc>)
  || mongoose.model<GeoGebraAiConfigDoc>("GeoGebraAiConfig", GeoGebraAiConfigSchema);
