import { Router } from "express";
import type { Request, Response } from "express";
import { isAdminRole } from "../../middleware/auth";
import logger from "../../utils/logger";
import { listAdminPageKeys, getAdminPage } from "../../config/adminPages";
import {
  getPagesForUser,
  getPlainAdminScopeView,
  resetPlainAdminScopeConfig,
  updatePlainAdminScopeConfig,
} from "../../services/adminScopeConfigService";

/**
 * 普通管理员页面授权的读取与配置。
 *
 * 挂在 `/api/admin/admin-scope`（随 `src/routes/admin/index.ts` 一起位于 `/api/admin` 前缀下）：
 *  - `GET /me`       —— 任何管理员：回**调用方自己**可见的页面列表（前端据它过滤导航/总览入口）；
 *  - `GET /setting`  —— 超管：全部页面清单 + 当前默认授权 + 按用户覆盖；
 *  - `PUT /setting`  —— 超管：覆盖式更新；
 *  - `DELETE /setting` —— 超管：恢复默认。
 *
 * `/me` 被登记进 `ADMIN_ANY_ROLE_PREFIXES`（只要求管理员身份）；其余三个走页面授权守卫，
 * 由于没有任何页面的 API 范围覆盖 `/api/admin/admin-scope/setting`，普通管理员一律 403。
 */
const router = Router();

function currentUser(req: Request): { id: string; role: string } | null {
  const user = req.user;
  if (!user?.id || !isAdminRole(user.role)) return null;
  return { id: user.id, role: String(user.role) };
}

function isSuperAdminRequest(req: Request): boolean {
  return req.user?.role === "superadmin";
}

router.get("/me", async (req: Request, res: Response) => {
  const user = currentUser(req);
  if (!user) {
    return res.status(403).json({ error: "需要管理员权限", code: "ADMIN_REQUIRED" });
  }

  const superAdmin = isSuperAdminRequest(req);
  // 超管不受页面授权限制：直接给出全部已登记页面，前端不必为两种角色写两套逻辑。
  const pages = superAdmin ? listAdminPageKeys() : await getPagesForUser(user.id);

  return res.json({
    role: user.role,
    isSuperAdmin: superAdmin,
    pages,
    availablePages: pages
      .filter((key) => Boolean(getAdminPage(key)))
      .map((key) => {
        const page = getAdminPage(key)!;
        return { key: page.key, label: page.label, apiScopeCount: page.apiPrefixes.length };
      }),
  });
});

router.get("/setting", async (req: Request, res: Response) => {
  if (!isSuperAdminRequest(req)) {
    return res.status(403).json({ error: "该功能仅超级管理员可用", code: "ADMIN_SCOPE_FORBIDDEN" });
  }
  return res.json(await getPlainAdminScopeView());
});

router.put("/setting", async (req: Request, res: Response) => {
  const user = currentUser(req);
  if (!user || !isSuperAdminRequest(req)) {
    return res.status(403).json({ error: "该功能仅超级管理员可用", code: "ADMIN_SCOPE_FORBIDDEN" });
  }

  try {
    const view = await updatePlainAdminScopeConfig(
      { defaultPages: req.body?.defaultPages, perUser: req.body?.perUser },
      { userId: user.id },
    );
    return res.json(view);
  } catch (error) {
    const message = error instanceof Error ? error.message : "更新普通管理员页面授权失败";
    logger.warn("[AdminScope] 更新页面授权失败", { actor: user.id, error: message });
    return res.status(400).json({ error: message });
  }
});

router.delete("/setting", async (req: Request, res: Response) => {
  const user = currentUser(req);
  if (!user || !isSuperAdminRequest(req)) {
    return res.status(403).json({ error: "该功能仅超级管理员可用", code: "ADMIN_SCOPE_FORBIDDEN" });
  }
  return res.json(await resetPlainAdminScopeConfig({ userId: user.id }));
});

export default router;
