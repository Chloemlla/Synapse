import mongoose, { type Document, Schema } from "mongoose";

export type GeoGebraMode = "geometry" | "3d" | "graphing" | "classic";

export interface IGeoGebraProject extends Document {
  projectId: string;
  ownerUserId: string;
  workspaceId: string | null;
  title: string;
  folder: string;
  tags: string[];
  isFavorite: boolean;
  canvasMode: GeoGebraMode;
  code: string;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
  lastOpenedAt: Date;
  subjectDeletedAt: number;
  deletedBy: string;
  deleteReason: string;
}

const GeoGebraProjectSchema = new Schema<IGeoGebraProject>(
  {
    projectId: { type: String, required: true, unique: true, maxlength: 80 },
    ownerUserId: { type: String, required: true, index: true },
    workspaceId: { type: String, default: null, index: true },
    title: { type: String, required: true, maxlength: 120 },
    folder: { type: String, default: "个人空间", maxlength: 80 },
    tags: { type: [String], default: [], validate: (items: string[]) => items.length <= 20 },
    isFavorite: { type: Boolean, default: false },
    canvasMode: { type: String, enum: ["geometry", "3d", "graphing", "classic"], default: "geometry" },
    code: { type: String, required: true, maxlength: 50_000 },
    revision: { type: Number, default: 1, min: 1 },
    lastOpenedAt: { type: Date, default: Date.now },
    subjectDeletedAt: { type: Number, default: 0, index: true },
    deletedBy: { type: String, default: "" },
    deleteReason: { type: String, default: "" },
  },
  { collection: "geogebra_projects", timestamps: true },
);

GeoGebraProjectSchema.index({ ownerUserId: 1, updatedAt: -1 });
GeoGebraProjectSchema.index({ workspaceId: 1, updatedAt: -1 });

export default mongoose.models.GeoGebraProject
  || mongoose.model<IGeoGebraProject>("GeoGebraProject", GeoGebraProjectSchema);
