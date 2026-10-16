import mongoose, { type Document, Schema } from "mongoose";
import type { GeoGebraMode } from "./geogebraProjectModel";

export interface IGeoGebraProjectVersion extends Document {
  versionId: string;
  projectId: string;
  ownerUserId: string;
  workspaceId: string | null;
  label: string;
  code: string;
  canvasMode: GeoGebraMode;
  trigger: string;
  createdAt: Date;
  subjectDeletedAt: number;
}

const GeoGebraProjectVersionSchema = new Schema<IGeoGebraProjectVersion>(
  {
    versionId: { type: String, required: true, unique: true, maxlength: 80 },
    projectId: { type: String, required: true },
    ownerUserId: { type: String, required: true },
    workspaceId: { type: String, default: null },
    label: { type: String, required: true, maxlength: 120 },
    code: { type: String, required: true, maxlength: 50_000 },
    canvasMode: { type: String, enum: ["geometry", "3d", "graphing", "classic"], required: true },
    trigger: { type: String, default: "manual", maxlength: 40 },
    subjectDeletedAt: { type: Number, default: 0 },
  },
  { collection: "geogebra_project_versions", timestamps: { createdAt: true, updatedAt: false } },
);

GeoGebraProjectVersionSchema.index({ projectId: 1, createdAt: -1 });
GeoGebraProjectVersionSchema.index({ ownerUserId: 1, createdAt: -1 });

export default mongoose.models.GeoGebraProjectVersion
  || mongoose.model<IGeoGebraProjectVersion>("GeoGebraProjectVersion", GeoGebraProjectVersionSchema);
