import { mongoose } from "../services/mongoService";

/**
 * 工单附件（独立集合，正文以 Buffer 落库）。
 *
 * 为什么独立集合而不是塞进 `tickets.messages[]`：
 * 工单列表接口会整档读取 `tickets` 文档（`TicketModel.find(...)` + Mongoose 文档化），
 * 把 1 MB 的附件正文放进工单文档，等于让「打开工单列表」顺带把所有人的附件一起读进内存。
 * 文档里只保留 `attachmentCount` 计数（见 ticketModel），正文按需取。
 *
 * 为什么不落磁盘 / 不引入对象存储：本仓用户存储已统一为 MongoDB
 * （见 `scripts/start-with-file-storage.sh` 的兼容说明：旧存储入口已改为 MongoDB）。
 * 容器内本地磁盘会在重启/换实例时丢文件，且要额外承担静态目录的访问控制风险。
 */
const ticketAttachmentSchema = new mongoose.Schema(
  {
    ticketId: { type: String, required: true, index: true },
    userId: { type: String, required: true },
    username: { type: String, required: true },
    /** 原始文件名（仅 ASCII、已剥离目录成分，见 utils/ticketAttachments.ts）。 */
    fileName: { type: String, required: true },
    ext: { type: String, required: true },
    mimeType: { type: String, required: true },
    size: { type: Number, required: true },
    /** 内容摘要：同一工单里重复上传可识别，也便于取证比对。 */
    sha256: { type: String, required: true },
    data: { type: Buffer, required: true },
  },
  {
    collection: "ticket_attachments",
    timestamps: true,
  },
);

// Serves `find({ ticketId }).sort({ createdAt: 1 })` — the only read path (详情渲染附件列表).
ticketAttachmentSchema.index({ ticketId: 1, createdAt: 1 });
// 运维巡检 / 留存核对：按上传时间扫描（报告仅统计量与元数据，不含正文）。
ticketAttachmentSchema.index({ createdAt: -1 });

export const TicketAttachmentModel =
  mongoose.models.TicketAttachment || mongoose.model("TicketAttachment", ticketAttachmentSchema);

export interface ITicketAttachment {
  _id: string;
  ticketId: string;
  userId: string;
  username: string;
  fileName: string;
  ext: string;
  mimeType: string;
  size: number;
  sha256: string;
  data: Buffer;
  createdAt: Date;
  updatedAt: Date;
}
