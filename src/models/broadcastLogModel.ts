import { mongoose } from "../services/mongoService";

const BroadcastLogSchema = new mongoose.Schema({
  message: { type: String, required: true },
  level: { type: String, default: "info" },
  title: String,
  duration: Number,
  display: { type: String, default: "toast" },
  format: { type: String, default: "text" },
  audience: { type: String, default: "all" },
  targetUserIds: { type: [String], default: [] },
  targetChannel: String,
  admin: String,
  connections: Number,
  createdAt: { type: Date, default: Date.now },
});

// `/admin/broadcast/history` 按 createdAt 倒序取最近 N 条（可选 audience 过滤）。
// 该集合此前零索引：无过滤时的 sort、以及带 audience 的 find+sort 都走内存排序，
// 集合增长后会撞 32MB sort memory limit 并逐步变慢。补两条索引让排序走索引：
//   - { createdAt: -1 }              → 服务 find({}).sort({ createdAt: -1 })
//   - { audience: 1, createdAt: -1 } → 服务 find({ audience }).sort({ createdAt: -1 })
BroadcastLogSchema.index({ createdAt: -1 });
BroadcastLogSchema.index({ audience: 1, createdAt: -1 });

export function getBroadcastLogModel() {
  return mongoose.models.BroadcastLog || mongoose.model("BroadcastLog", BroadcastLogSchema);
}
