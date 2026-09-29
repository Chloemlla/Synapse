import { Router } from "express";
import { docsTimeoutLimiter, integrityLimiter, serverStatusLimiter } from "../middleware/routeLimiters";
import { optionalAdminAuth } from "../middleware/optionalAdminAuth";
import { DiagnosticsController } from "../controllers/diagnosticsController";

const router = Router();

router.head("/proxy-test", integrityLimiter, DiagnosticsController.ok);
router.get("/proxy-test", integrityLimiter, DiagnosticsController.ok);
router.get("/timing-test", integrityLimiter, DiagnosticsController.ok);
router.post("/report-docs-timeout", docsTimeoutLimiter, DiagnosticsController.reportDocsTimeout);
// 口令保留给外部脚本/监控；已登录管理员由会话直接放行，免填口令
router.post("/server_status", serverStatusLimiter, optionalAdminAuth, DiagnosticsController.getServerStatus);

export default router;

