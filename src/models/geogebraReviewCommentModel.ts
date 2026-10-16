import mongoose, { type Document, Schema } from "mongoose";

export interface IGeoGebraReviewComment extends Document {
  commentId: string;
  projectId: string;
  versionId: string | null;
  workspaceId: string | null;
  authorUserId: string;
  objectName: string | null;
  body: string;
  status: "open" | "resolved";
  createdAt: Date;
  updatedAt: Date;
  subjectDeletedAt: number;
}

const GeoGebraReviewCommentSchema = new Schema<IGeoGebraReviewComment>(
  {
    commentId: { type: String, required: true, unique: true, maxlength: 80 },
    projectId: { type: String, required: true },
    versionId: { type: String, default: null },
    workspaceId: { type: String, default: null },
    authorUserId: { type: String, required: true },
    objectName: { type: String, default: null, maxlength: 100 },
    body: { type: String, required: true, maxlength: 4_000 },
    status: { type: String, enum: ["open", "resolved"], default: "open" },
    subjectDeletedAt: { type: Number, default: 0 },
  },
  { collection: "geogebra_review_comments", timestamps: true },
);

GeoGebraReviewCommentSchema.index({ projectId: 1, createdAt: -1 });
GeoGebraReviewCommentSchema.index({ authorUserId: 1, createdAt: -1 });
GeoGebraReviewCommentSchema.index({ workspaceId: 1, createdAt: -1 });

export default mongoose.models.GeoGebraReviewComment
  || mongoose.model<IGeoGebraReviewComment>("GeoGebraReviewComment", GeoGebraReviewCommentSchema);
