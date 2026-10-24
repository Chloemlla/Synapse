import type { Request, Response } from "express";
import { CdictUpstreamValidationError } from "../config/cdictUpstreamConfig";
import { isAdminRole, isSuperAdmin } from "../middleware/auth";
import { mongoose } from "../services/mongoService";
import { RuntimeConfigService } from "../services/runtimeConfigService";

function checkAccess(req: Request, res: Response, write: boolean): boolean {
  res.setHeader("Cache-Control", "private, no-store");
  if (!req.user || (write ? !isSuperAdmin(req) : !isAdminRole(req.user.role))) {
    res.status(403).json({ success: false, error: write ? "需要超级管理员权限" : "需要管理员权限", code: "ADMIN_REQUIRED" });
    return false;
  }
  if (mongoose.connection.readyState !== 1) {
    res.status(503).json({ success: false, error: "配置存储暂不可用" });
    return false;
  }
  return true;
}

/** Scope/authentication and the shared security-session guard remain in the admin router. */
export const cdictUpstreamConfigController = {
  async getSetting(req: Request, res: Response) {
    if (!checkAccess(req, res, false)) return;
    try {
      return res.json({ success: true, ...await RuntimeConfigService.getCdictUpstreamSetting() });
    } catch {
      return res.status(500).json({ success: false, error: "读取 CDict 上游配置失败" });
    }
  },

  async setSetting(req: Request, res: Response) {
    if (!checkAccess(req, res, true)) return;
    try {
      const setting = await RuntimeConfigService.setCdictUpstreamSetting(req.body ?? {});
      return res.json({ success: true, setting });
    } catch (error) {
      // Only our value-free validation errors are safe to expose. Mongo errors can
      // contain the update document, including the signing credential.
      return res.status(error instanceof CdictUpstreamValidationError ? 400 : 500).json({
        success: false,
        error: error instanceof CdictUpstreamValidationError ? error.message : "保存 CDict 上游配置失败",
      });
    }
  },

  async deleteSetting(req: Request, res: Response) {
    if (!checkAccess(req, res, true)) return;
    try {
      await RuntimeConfigService.deleteCdictUpstreamSetting();
      return res.json({ success: true });
    } catch {
      return res.status(500).json({ success: false, error: "重置 CDict 上游配置失败" });
    }
  },
};
