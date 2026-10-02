import { Router, type Request, type Response } from "express";
import { apiDocsAuthGate } from "../middleware/apiDocsAuth";
import { openapiLimiter } from "../middleware/routeLimiters";
import { readOpenapiJson } from "../services/openapiDocumentService";

async function sendApiDocsJson(_req: Request, res: Response): Promise<void> {
  try {
    res.setHeader("Content-Type", "application/json");
    // PERF-03: 254 KB 的 spec 每次重算 mtime 再整份下发；文档随部署才变，
    // 用 private 短缓存（该路由有 apiDocsAuthGate，不得 public）。
    res.setHeader("Cache-Control", "private, max-age=300");
    res.send(await readOpenapiJson());
  } catch (_error) {
    res.status(500).json({ error: "无法读取API文档" });
  }
}

const router = Router();
router.get("/openapi.json", openapiLimiter, apiDocsAuthGate, sendApiDocsJson);
router.get("/api-docs.json", openapiLimiter, apiDocsAuthGate, sendApiDocsJson);

export default router;
