import express from "express";
import { auditLog } from "../../middleware/auditLog";
import { authenticateSuperAdmin } from "../../middleware/auth";
import { firstString } from "../../utils/httpParam";
import {
  bulkDeleteRegistrationInvites,
  bulkSetRegistrationInvitesActive,
  createRegistrationInvite,
  deleteRegistrationInvite,
  getRegistrationInviteStats,
  listRegistrationInvites,
  updateRegistrationInvite,
} from "../../services/registrationInviteService";

const readIds = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];

const router = express.Router();

router.get("/registration-invites", async (_req, res) => {
  try {
    const invites = await listRegistrationInvites();
    return res.json({ success: true, invites });
  } catch (error) {
    return res.status(500).json({ error: "获取邀请码列表失败" });
  }
});

// IN-3：只读统计（用量趋势 / 顶级邀请人 / 过期与用尽计数）。
router.get("/registration-invites/stats", async (_req, res) => {
  try {
    const stats = await getRegistrationInviteStats();
    return res.json({ success: true, stats });
  } catch (error) {
    return res.status(500).json({ error: "获取邀请码统计失败" });
  }
});

// IN-4：批量停用 / 启用。
router.post(
  "/registration-invites/bulk-active",
  // codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter, preTamperModules G11-06); in-router copy would split quota
  authenticateSuperAdmin,
  auditLog({
    module: "user",
    action: "invite.bulkActive",
    extractDetail: (req) => ({ count: readIds((req as any).body?.ids).length, active: Boolean((req as any).body?.active) }),
  }),
  async (req, res) => {
    try {
      const ids = readIds(req.body?.ids);
      const active = req.body?.active !== false;
      const result = await bulkSetRegistrationInvitesActive(ids, active);
      return res.json({ success: true, ...result });
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : "批量更新邀请码失败" });
    }
  },
);

// IN-4：批量删除。
router.post(
  "/registration-invites/bulk-delete",
  // codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter, preTamperModules G11-06); in-router copy would split quota
  authenticateSuperAdmin,
  auditLog({
    module: "user",
    action: "invite.bulkDelete",
    extractDetail: (req) => ({ count: readIds((req as any).body?.ids).length }),
  }),
  async (req, res) => {
    try {
      const result = await bulkDeleteRegistrationInvites(readIds(req.body?.ids));
      return res.json({ success: true, ...result });
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : "批量删除邀请码失败" });
    }
  },
);

router.post(
  "/registration-invites",
  // codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter, preTamperModules G11-06); in-router copy would split quota
  authenticateSuperAdmin,
  auditLog({ module: "user", action: "invite.create", extractDetail: (req) => ({ count: (req as any).body?.count ?? 1 }) }),
  async (req: any, res) => {
  try {
    const invite = await createRegistrationInvite(req.body || {}, {
      id: req.user?.id,
      username: req.user?.username,
    });
    return res.json({ success: true, invite });
  } catch (error) {
    return res.status(400).json({ error: error instanceof Error ? error.message : "创建邀请码失败" });
  }
});

router.patch(
  "/registration-invites/:id",
  // codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter, preTamperModules G11-06); in-router copy would split quota
  authenticateSuperAdmin,
  auditLog({ module: "user", action: "invite.update", extractTarget: (req) => ({ targetId: firstString(req.params.id) }) }),
  async (req, res) => {
  try {
    const id = firstString(req.params.id);
    if (!id) return res.status(400).json({ error: "邀请码不存在" });
    const invite = await updateRegistrationInvite(id, req.body || {});
    if (!invite) {
      return res.status(404).json({ error: "邀请码不存在" });
    }
    return res.json({ success: true, invite });
  } catch (error) {
    return res.status(400).json({ error: error instanceof Error ? error.message : "更新邀请码失败" });
  }
});

router.delete(
  "/registration-invites/:id",
  // codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter, preTamperModules G11-06); in-router copy would split quota
  authenticateSuperAdmin,
  auditLog({ module: "user", action: "invite.delete", extractTarget: (req) => ({ targetId: firstString(req.params.id) }) }),
  async (req, res) => {
  try {
    const id = firstString(req.params.id);
    if (!id) return res.status(400).json({ error: "邀请码不存在" });
    const deleted = await deleteRegistrationInvite(id);
    if (!deleted) {
      return res.status(404).json({ error: "邀请码不存在" });
    }
    return res.json({ success: true });
  } catch (error) {
    return res.status(400).json({ error: "删除邀请码失败" });
  }
});

export default router;
