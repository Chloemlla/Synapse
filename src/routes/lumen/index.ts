import { Router } from "express";
import type { RequestHandler } from "express";
import { isLumenEnabled } from "../../config/lumen.js";
import { lumenLimiter } from "../../middleware/routeLimiters.js";
import healthRoutes from "./health.routes.js";
import authRoutes from "./auth.routes.js";
import sessionsRoutes from "./sessions.routes.js";
import meRoutes from "./me.routes.js";
import devicesRoutes from "./devices.routes.js";
import entitlementsRoutes from "./entitlements.routes.js";
import purchasesRoutes from "./purchases.routes.js";
import syncRoutes from "./sync.routes.js";
import backupsRoutes from "./backups.routes.js";
import telemetryRoutes from "./telemetry.routes.js";
import crashRoutes from "./crash.routes.js";
import faceAnalysisRoutes from "./face-analysis.routes.js";
import privilegedControlRoutes from "./privileged-control.routes.js";
import adminRoutes from "./admin.routes.js";
import platformRoutes from "./platform.routes.js";

/**
 * Lumen 的两套挂载前缀，必须同时存在：
 *
 * - `/api/lumen`：本仓（以及后台面板、CI 的 `/api/lumen/admin/actions`、全部文档）的规范路径。
 * - `/api/lumen/v1`：**兼容已发布的 Project-Lumen 安装包**。客户端请求里带着 `v1/` 段
 *   （它的后端原本就是 `/api/v1/...`，迁到 Synapse 时只换了基址没换路径），装到用户手机上的
 *   APK 不会随服务端同步更新；少了这条别名，官方客户端除 `health` 外**每一个**请求都拿到
 *   Express 兜底 404（`{"error":"Not Found"}`，客户端表现为
 *   "Project Lumen API request failed with HTTP 404"）。
 *
 * 别名与新前缀共用同一个 v1Router / health 与同一份限流，所以两条路径的行为完全一致；
 * 客户端新版本已改用无版本段路径，别名只为旧包保留，不作新契约的一部分。
 */
export const LUMEN_API_PREFIXES = ["/api/lumen/v1", "/api/lumen"] as const;

const router = Router();

// Fail-closed gate: when Lumen is not enabled the whole subsystem returns 503.
// Scoped to the /api/lumen prefix (the registry entry in src/routes/lumenRouteModules.ts
// mounts this router at "/", so an unscoped gate would block every host route).
// Enabled state is read per request, so the admin UI can turn Lumen on without a redeploy.
const lumenGate: RequestHandler = (_req, res, next) => {
  if (!isLumenEnabled()) {
    res.status(503).json({
      error: "Lumen 未启用",
      message: "Lumen 服务未启用，请在环境变量 LUMEN_ENABLED=true 或管理后台「Lumen 服务端配置」中启用。",
    });
    return;
  }
  next();
};
router.use("/api/lumen", lumenGate);

// 业务子路由（auth/sessions/me/... 每一段自己不带版本号，版本只在挂载前缀上，见 LUMEN_API_PREFIXES）。
// 历史上它曾被注释成 "/api/v1 sub-router"，但那正是契约漂移的来源：前缀不再是 /api/v1 之后，
// 任何“按注释拼路径”的客户端都会 404。
const v1Router = Router();
v1Router.use("/auth", authRoutes);
v1Router.use("/sessions", sessionsRoutes);
v1Router.use("/me", meRoutes);
v1Router.use("/devices", devicesRoutes);
v1Router.use("/entitlements", entitlementsRoutes);
v1Router.use("/purchases", purchasesRoutes);
v1Router.use("/sync", syncRoutes);
v1Router.use("/backups", backupsRoutes);
v1Router.use("/telemetry", telemetryRoutes);
v1Router.use("/crash-report", crashRoutes);
v1Router.use("/face-analysis", faceAnalysisRoutes);
v1Router.use("/device-control", privilegedControlRoutes);
v1Router.use("/admin", adminRoutes);
v1Router.use("/", platformRoutes);

// Mount the v1 router on every accepted prefix, with the Lumen rate limiter scoped to it
// so non-Lumen routes on the host (TTS, static, etc.) are not throttled by it.
// 版本化前缀先挂：/api/lumen/v1/... 会先命中它，不会落到无版本段的同名子树上。
for (const prefix of LUMEN_API_PREFIXES) {
  router.use(prefix, lumenLimiter, v1Router);
}

// Mount lumen health at a path that doesn't collide with the canonical
// /api/health (mounted earlier by the pre-parser phase) so this router is reachable.
// 旧客户端把 health 拼在基址 `/api/lumen` 后面，新客户端同理；别名前缀一并提供，避免
// 「探测能通、业务全 404」这种半通状态再次出现。
for (const prefix of LUMEN_API_PREFIXES) {
  router.use(`${prefix}/health`, healthRoutes);
}

export default router;