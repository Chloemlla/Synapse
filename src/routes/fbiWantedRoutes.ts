import express from "express";
import { requireAdminScope } from "../middleware/adminScope";
import multer from "multer";
import { fbiWantedController } from "../controllers/fbiWantedController";
import { auditLog } from "../middleware/auditLog";
import { authenticateAdmin, authenticateSuperAdmin } from "../middleware/auth";
import { authenticateToken } from "../middleware/authenticateToken";
import { createLimiter } from "../middleware/rateLimiter";

const router = express.Router();

// 文件上传中间件（内存存储，限制5MB；禁止 SVG）
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const mime = (file.mimetype || "").toLowerCase();
    const name = (file.originalname || "").toLowerCase();
    if (mime === "image/svg+xml" || mime === "image/svg" || name.endsWith(".svg")) {
      return cb(new Error("出于安全考虑，已禁止上传 SVG 文件"));
    }
    cb(null, true);
  },
});

// ===== 公开路由（**无需登录**，owner 2026-10-11 要求） =====
// 为什么不再挂 authenticateToken（G10 曾经挂过）：FBI 通缉信息本身是公开数据，
// 要求登录才能看只会把一个公开信息页变成“注册墙”，而它并没有任何用户私有内容。
// 保留的约束：独立的公开限流器（60/min）+ WAF + IP 封禁仍在；
// 写操作（下文 admin 路由）完全不变，仍要管理员/超管。
const publicLimiter = createLimiter({
  windowMs: 60 * 1000,
  max: 60,
  routeName: "fbi.public",
  message: "公开API请求过于频繁，请稍后再试",
});

// 公开API - 使用 /public 前缀明确区分
router.get("/public/list", publicLimiter, fbiWantedController.getAllWanted);
router.get("/public/statistics", publicLimiter, fbiWantedController.getStatistics);
// 详情用公开版本：只返回 isActive 的记录，不把“已下架”的记录通过公开面泄出去。
router.get("/public/:id", publicLimiter, fbiWantedController.getPublicWantedById);

// ===== 管理员路由（需要认证+管理员权限） =====

// 管理员限流器
const adminLimiter = createLimiter({
  windowMs: 5 * 60 * 1000,
  max: 100,
  routeName: "fbi.admin",
  message: "管理员操作过于频繁，请稍后再试",
});

// 头像上传限流器（更严格）
const uploadPhotoLimiter = createLimiter({
  windowMs: 15 * 60 * 1000,
  max: 20,
  routeName: "fbi.admin.photo_upload",
  message: "头像上传过于频繁，请稍后再试",
});

// 管理员API - 统一应用认证中间件
router.get("/", adminLimiter, authenticateToken, authenticateAdmin, requireAdminScope, fbiWantedController.getAllWanted);
router.get("/statistics", adminLimiter, authenticateToken, authenticateAdmin, requireAdminScope, fbiWantedController.getStatistics);
router.get("/:id", adminLimiter, authenticateToken, authenticateAdmin, requireAdminScope, fbiWantedController.getWantedById);
router.post(
  "/",
  adminLimiter,
  authenticateToken,
  authenticateSuperAdmin,
  auditLog({ module: "other", action: "fbi.create" }),
  fbiWantedController.createWanted,
);
router.put(
  "/:id",
  adminLimiter,
  authenticateToken,
  authenticateSuperAdmin,
  auditLog({ module: "other", action: "fbi.update", extractTarget: (req) => ({ targetId: req.params.id }) }),
  fbiWantedController.updateWanted,
);
router.patch(
  "/:id/status",
  adminLimiter,
  authenticateToken,
  authenticateSuperAdmin,
  auditLog({ module: "other", action: "fbi.statusChange", extractTarget: (req) => ({ targetId: req.params.id }) }),
  fbiWantedController.updateWantedStatus,
);
router.patch(
  "/:id/photo",
  uploadPhotoLimiter,
  authenticateToken,
  authenticateSuperAdmin,
  auditLog({ module: "other", action: "fbi.photoUpdate", extractTarget: (req) => ({ targetId: req.params.id }) }),
  upload.single("photo"),
  fbiWantedController.updateWantedPhoto,
);
router.delete(
  "/multiple",
  adminLimiter,
  authenticateToken,
  authenticateSuperAdmin,
  auditLog({ module: "other", action: "fbi.deleteMultiple" }),
  fbiWantedController.deleteMultiple,
);
router.delete(
  "/:id",
  adminLimiter,
  authenticateToken,
  authenticateSuperAdmin,
  auditLog({ module: "other", action: "fbi.delete", extractTarget: (req) => ({ targetId: req.params.id }) }),
  fbiWantedController.deleteWanted,
);
router.post(
  "/batch-delete",
  adminLimiter,
  authenticateToken,
  authenticateSuperAdmin,
  auditLog({ module: "other", action: "fbi.batchDelete" }),
  fbiWantedController.batchDeleteWanted,
);

export default router;
