import express from "express";
import type { NextFunction, Request, Response } from "express";
import { ticketController } from "../controllers/ticketController";
import { auditLog } from "../middleware/auditLog";
import { authenticateSuperAdmin, isAdminRole } from "../middleware/auth";
import { requireAdminScope } from "../middleware/adminScope";
import { authenticateToken } from "../middleware/authenticateToken";
import { ticketAdminLimiter, ticketReadLimiter, ticketWriteLimiter } from "../middleware/routeLimiters";

const router = express.Router();

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
// `/unread-count` 必须排在 `/:id` 之前，否则会被当成工单 ID（id 校验会返回 400）。
router.get("/unread-count", ticketReadLimiter, ticketController.getUnreadCount);
router.get("/:id", ticketReadLimiter, ticketController.getTicketById);
router.post("/:id/messages", ticketWriteLimiter, ticketController.replyToTicket);
// 属主自助关闭；客服侧走 PATCH /admin/:id
router.patch("/:id/close", ticketWriteLimiter, ticketController.closeOwnTicket);

export default router;
