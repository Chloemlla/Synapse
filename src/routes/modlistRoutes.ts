import express from "express";
import {
  addMod,
  batchAddMods,
  batchDeleteMods,
  deleteMod as deleteModController,
  getModList,
  getModListJson,
  updateMod,
} from "../controllers/modlistController";
import { authenticateAdmin, authenticateSuperAdmin } from "../middleware/auth";
import { auditLog } from "../middleware/auditLog";
import { authenticateToken } from "../middleware/authenticateToken";
import { createLimiter } from "../middleware/rateLimiter";

const router = express.Router();

const modlistLimiter = createLimiter({
  windowMs: 60 * 1000, // 1分钟
  max: 30,
  routeName: "modlist",
  message: "MOD操作过于频繁，请稍后再试",
});

router.get("/", authenticateToken, modlistLimiter, getModList);
// 明文导出只给管理员：加密的 GET /api/modlist 是给「有登录态但前端拿不到令牌」的
// 客户端留的兼容路径；而这条是明文，普通用户能读就等于把加密白做了。
//
// 限流器放在认证**之前**：既符合「先挡洪水再验身份」的一般顺序，也是 CodeQL
// js/missing-rate-limiting 要求的写法 —— 它要求授权中间件之前先出现可识别的限流器，
// 否则整条路由会被判成「做了授权但没有限流」。
router.get("/json", modlistLimiter, authenticateToken, authenticateAdmin, getModListJson);
// G3-23: 写操作要求登录 + 超级管理员，修改码降级为二次确认，并写审计
router.post("/", modlistLimiter, authenticateToken, authenticateSuperAdmin, auditLog({ module: "modlist", action: "modlist.add" }), addMod);
router.put("/:id", modlistLimiter, authenticateToken, authenticateSuperAdmin, auditLog({ module: "modlist", action: "modlist.update", extractTarget: (req) => ({ targetId: req.params.id }) }), updateMod);
router.delete("/:id", modlistLimiter, authenticateToken, authenticateSuperAdmin, auditLog({ module: "modlist", action: "modlist.delete", extractTarget: (req) => ({ targetId: req.params.id }) }), deleteModController);
router.post("/batch-add", modlistLimiter, authenticateToken, authenticateSuperAdmin, auditLog({ module: "modlist", action: "modlist.batchAdd", extractDetail: (req) => ({ count: Array.isArray(req.body?.mods) ? req.body.mods.length : 0 }) }), batchAddMods);
router.post("/batch-delete", modlistLimiter, authenticateToken, authenticateSuperAdmin, auditLog({ module: "modlist", action: "modlist.batchDelete", extractDetail: (req) => ({ count: Array.isArray(req.body?.ids) ? req.body.ids.length : 0 }) }), batchDeleteMods);

export default router;
