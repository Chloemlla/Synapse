import mongoose, { type Document, Schema } from "mongoose";

/**
 * 推荐反馈（RC-2）。
 *
 * 隐式历史（用了什么）能排序，但不能纠错：用户明确「不喜欢」的风格必须立刻从推荐里消失。
 * 一个用户对一个风格只保留一条反馈（唯一索引），后写覆盖前写，语义是「当前态度」。
 */

export type RecommendationFeedbackKind = "like" | "dislike" | "not_interested";

export interface IRecommendationFeedback extends Document {
  userId: string;
  styleId: string;
  feedback: RecommendationFeedbackKind;
  comment?: string;
  createdAt: Date;
  updatedAt: Date;
}

const RecommendationFeedbackSchema = new Schema<IRecommendationFeedback>(
  {
    userId: { type: String, required: true, index: true },
    styleId: { type: String, required: true, index: true },
    feedback: { type: String, required: true, enum: ["like", "dislike", "not_interested"] },
    comment: { type: String, default: "", maxlength: 500 },
  },
  { collection: "recommendation_feedback", timestamps: true },
);

// 同一用户对同一风格只有一条「当前态度」。
RecommendationFeedbackSchema.index({ userId: 1, styleId: 1 }, { unique: true });
// 管理端按风格聚合反馈分布。
RecommendationFeedbackSchema.index({ styleId: 1, feedback: 1 });

export const RECOMMENDATION_FEEDBACK_KINDS: readonly RecommendationFeedbackKind[] = [
  "like",
  "dislike",
  "not_interested",
];

export default mongoose.models.RecommendationFeedback ||
  mongoose.model<IRecommendationFeedback>("RecommendationFeedback", RecommendationFeedbackSchema);
