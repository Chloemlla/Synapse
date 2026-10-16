import express from "express";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import multer from "multer";
import { ticketController } from "../controllers/ticketController";
import { auditLog } from "../middleware/auditLog";
import { authenticateSuperAdmin, isAdminRole } from "../middleware/auth";
import { requireAdminScope } from "../middleware/adminScope";
import { authenticateToken } from "../middleware/authenticateToken";
import {
  ticketAdminLimiter,
  ticketReadLimiter,
  ticketUploadLimiter,
  ticketWriteLimiter,
} from "../middleware/routeLimiters";
import { MAX_TICKET_ATTACHMENT_BYTES } from "../utils/ticketAttachments";

const router = express.Router();

// 附件上传：一律进内存（正文要当场校验魔数并落到 Mongo，磁盘中转只会多一份要清理的临时文件）。
// 体积上限刻意比业务上限多 64KB：让「超过 1MB」由控制器给出带单位的中文原因，
// 而不是 multer 的 LIMIT_FILE_SIZE 通用错误。
const ticketAttachmentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_TICKET_ATTACHMENT_BYTES + 64 * 1024, files: 1 },
});

const uploadSingleTicketAttachment: RequestHandler = (req, res, next) => {
  ticketAttachmentUpload.single("file")(req, res, (error: unknown) => {
    if (error) {
      if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({
          error: `单个附件不能超过 ${Math.round(MAX_TICKET_ATTACHMENT_BYTES / 1024 / 1024)}MB`,
          code: "FILE_TOO_LARGE",
        });
      }
      return res.status(400).json({ error: "附件上传失败，请重试", code: "UPLOAD_FAILED" });
    }
    next();
  });
};

// 所有工单接口都需要登录
router.use(authenticateToken);

// 管理员接口 (在 controller 内部已有角色检查，但为了安全建议在此处也加上)
const adminOnly = (req: Request, res: Response, next: NextFunction) => {
  if (req.user && isAdminRole(req.user.role)) {
    next();
  } else {
    res.status(403).json({ error: "需要管理员权限" });
  }
};

// ── 管理端（superadmin） ──
// 静态段路由必须排在 `/admin/:id...` 之前：否则 PATCH /admin/bulk/status 会被
// `/admin/:id/status` 先匹配掉（id="bulk"），批量操作直接失效。
//
// 普通管理员看不了工单原文（用户内容）：与后端范围守卫口径一致。
router.get("/admin/all", ticketAdminLimiter, adminOnly, requireAdminScope, ticketController.getAllTickets);
router.get("/admin/stats", ticketAdminLimiter, adminOnly, requireAdminScope, ticketController.getTicketStats);
router.patch(
  "/admin/bulk/status",
  ticketAdminLimiter,
  authenticateSuperAdmin,
  auditLog({
    module: "other",
    action: "ticket.bulkStatusChange",
    extractDetail: (req) => ({
      status: req.body?.status,
      count: Array.isArray(req.body?.ids) ? req.body.ids.length : 0,
    }),
  }),
  ticketController.bulkUpdateStatus,
);
router.patch(
  "/admin/:id",
  ticketAdminLimiter,
  authenticateSuperAdmin,
  auditLog({ module: "other", action: "ticket.updateFields", extractTarget: (req) => ({ targetId: req.params.id }) }),
  ticketController.updateTicketFields,
);
router.patch(
  "/admin/:id/status",
  ticketAdminLimiter,
  authenticateSuperAdmin,
  auditLog({ module: "other", action: "ticket.statusChange", extractTarget: (req) => ({ targetId: req.params.id }) }),
  ticketController.updateTicketStatus,
);
router.put(
  "/admin/:id/messages/:messageIndex",
  ticketAdminLimiter,
  authenticateSuperAdmin,
  auditLog({ module: "other", action: "ticket.messageEdit", extractTarget: (req) => ({ targetId: req.params.id }), extractDetail: (req) => ({ messageIndex: req.params.messageIndex }) }),
  ticketController.adminEditMessage,
);
router.delete(
  "/admin/:id/messages/:messageIndex",
  ticketAdminLimiter,
  authenticateSuperAdmin,
  auditLog({ module: "other", action: "ticket.messageDelete", extractTarget: (req) => ({ targetId: req.params.id }), extractDetail: (req) => ({ messageIndex: req.params.messageIndex }) }),
  ticketController.adminDeleteMessage,
);

// ── 用户接口 ──
router.post("/", ticketWriteLimiter, ticketController.createTicket);
router.get("/", ticketReadLimiter, ticketController.getUserTickets);
// 能力查询（附件上传开关等）必须在 `/:id` 之前，否则会被当成工单 ID。
// 告给登录用户，不包含任何敏感配置（只有一个布尔开关与公开的限额）。
router.get("/capabilities", ticketReadLimiter, ticketController.getTicketCapabilities);
// `/unread-count` 必须排在 `/:id` 之前，否则会被当成工单 ID（id 校验会返回 400）。
router.get("/unread-count", ticketReadLimiter, ticketController.getUnreadCount);
router.get("/:id", ticketReadLimiter, ticketController.getTicketById);
router.post("/:id/messages", ticketWriteLimiter, ticketController.replyToTicket);
// 附件：上传/删除是写类操作（`ticketUpload`），下载走读类限额（60/分钟够用：单个 1MB）。
router.post(
  "/:id/attachments",
  ticketUploadLimiter,
  uploadSingleTicketAttachment,
  ticketController.uploadTicketAttachment,
);
router.get("/:id/attachments/:attachmentId/download", ticketReadLimiter, ticketController.downloadTicketAttachment);
router.delete("/:id/attachments/:attachmentId", ticketUploadLimiter, ticketController.deleteTicketAttachment);
// 附件链接（上传文件默认关闭时用户提交截图的通道）。
router.put("/:id/attachment-links", ticketWriteLimiter, ticketController.updateTicketAttachmentLinks);
// 属主自助关闭；客服侧走 PATCH /admin/:id
router.patch("/:id/close", ticketWriteLimiter, ticketController.closeOwnTicket);

export default router;
