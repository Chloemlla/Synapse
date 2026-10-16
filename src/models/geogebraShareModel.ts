import mongoose, { type Document, Schema } from "mongoose";
import type { GeoGebraMode } from "./geogebraProjectModel";

export interface IGeoGebraShare extends Document {
  shareId: string;
  slug: string;
  ownerUserId: string;
  projectId: string | null;
  title: string;
  canvasMode: GeoGebraMode;
  commands: string[];
  allowFork: boolean;
  coverStored: boolean;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  subjectDeletedAt: number;
}

const GeoGebraShareSchema = new Schema<IGeoGebraShare>(
  {
    shareId: { type: String, required: true, unique: true, maxlength: 80 },
    slug: { type: String, required: true, unique: true, maxlength: 100 },
    ownerUserId: { type: String, required: true, index: true },
    projectId: { type: String, default: null, index: true },
    title: { type: String, required: true, maxlength: 120 },
    canvasMode: { type: String, enum: ["geometry", "3d", "graphing", "classic"], required: true },
    commands: { type: [String], required: true, validate: (items: string[]) => items.length > 0 && items.length <= 5_000 },
    allowFork: { type: Boolean, default: true },
    coverStored: { type: Boolean, default: false },
    revokedAt: { type: Date, default: null },
    subjectDeletedAt: { type: Number, default: 0 },
  },
  { collection: "geogebra_shares", timestamps: true },
);

GeoGebraShareSchema.index({ ownerUserId: 1, createdAt: -1 });
GeoGebraShareSchema.index({ projectId: 1, createdAt: -1 });

export default mongoose.models.GeoGebraShare
  || mongoose.model<IGeoGebraShare>("GeoGebraShare", GeoGebraShareSchema);
