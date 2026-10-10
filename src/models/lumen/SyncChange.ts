import { mongoose } from "../../services/mongoService.js";

export interface ISyncChange {
  _id: string;
  userId: string;
  cursor: number;
  change: {
    collection: string;
    operation: string;
    remoteId: string;
    payload: unknown;
    deviceInstallationId: string;
    updatedAt: number;
  };
  /**
   * D3: TTL anchor. Left unset unless LUMEN_RETENTION_SYNC_CHANGE_DAYS is configured —
   * dropping a change a device has not pulled yet silently desyncs it.
   */
  ttlExpireAt?: Date;
}

const SyncChangeSchema = new mongoose.Schema<ISyncChange>(
  {
    _id: { type: String },
    userId: { type: String, required: true },
    cursor: { type: Number, unique: true },
    change: {
      type: new mongoose.Schema(
        {
          collection: { type: String },
          operation: { type: String },
          remoteId: { type: String },
          payload: { type: mongoose.Schema.Types.Mixed },
          deviceInstallationId: { type: String },
          updatedAt: { type: Number },
        },
        {
          _id: false,
          // `collection` 是 mongoose 的保留字段名（与 Schema#collection 访问器同名），
          // 默认会打 "`collection` is a reserved schema pathname" 警告。这里刻意保留该字段名：
          // 它是已落库的数据形状（描述“这条变更属于哪个集合”），改名要么写迁移、要么破坏
          // lumen 客户端协议；而它只出现在**子文档** schema 里（没有自己的 collection 概念），
          // 遮蔽风险最小，因此显式抑制警告而不是改名。
          suppressReservedKeysWarning: true,
        },
      ),
    },
    ttlExpireAt: { type: Date },
  },
  { strict: true, timestamps: false, collection: "sync_changes" },
);

SyncChangeSchema.index({ userId: 1, cursor: 1 });
SyncChangeSchema.index({ ttlExpireAt: 1 }, { expireAfterSeconds: 0 });

const SyncChange =
  (mongoose.models.SyncChange as mongoose.Model<ISyncChange>) ||
  mongoose.model<ISyncChange>("SyncChange", SyncChangeSchema);

export { SyncChange, SyncChangeSchema };