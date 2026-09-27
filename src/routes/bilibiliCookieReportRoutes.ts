import express from "express";
import { reportCookie } from "../controllers/bilibiliCookieReportController";
import { bilibiliReportLimiter } from "../middleware/routeLimiters";

/**
 * Bilibili login cookie reports (`/api/bilibili-reports`).
 *
 * `POST /cookie` is the report-only sink a client calls right after a Bilibili
 * login completes. It requires no Synapse session: the caller identifies itself
 * with the device id it generated on first launch, and the server verifies the
 * claimed UID against Bilibili before storing anything.
 *
 * Reads live under `/api/admin/bilibili-reports` (admin auth chain), so this
 * router accepts data and never hands any of it back.
 */
const router = express.Router();

router.post("/cookie", bilibiliReportLimiter, reportCookie);

export default router;
