/**
 * 功能同意闸门：按**用户自己的同意**开放功能访问（不是按设备指纹）。
 *
 * 为什么要有这道闸门：现有同意体系以 fingerprint（设备身份）为唯一归属，同一台设备上换个账号
 * 就能蹭到上一位用户的同意。凡是「把用户内容交给服务端处理 / 交给第三方处理 / 对外发布」的功能，
 * 都需要用户在自己的账号下明确同意过相关条款才开放；撤销同意后立即收回（服务层不加缓存）。
 *
 * 挂法：`router.use(requireFeatureConsent("doc-tool"))`，挂在认证之后、业务路由之前。
 * 挂载层通常已有 authenticateToken（如 /api/doc-tool），这里仍自己判一次未登录：中间件被单测
 * 直挂、或将来挂到别的相位时，「未登录」必须是 401 而不是 403 —— 403 会让前端弹出一份
 * 「你没有登录」时根本无法完成的同意清单。
 */
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { FEATURE_CONSENT_REQUIREMENTS, type FeatureConsentKey } from "../config/featureConsent";
import { CURRENT_POLICY_VERSION } from "../config/policyMeta";
import { resolveFeatureConsentViews } from "../services/policyConsentService";
import type { AuthenticatedRequest } from "../types/authRequest";
import logger from "../utils/logger";

/**
 * 前端靠这个稳定 code 决定「弹同意清单」还是「走别的错误处理」。
 * 改它等于让所有已发布的客户端在 403 面前退回文案匹配 —— 那是最后手段，不是默认手段。
 */
export const POLICY_CONSENT_REQUIRED_CODE = "POLICY_CONSENT_REQUIRED";
const UNAUTHENTICATED_CODE = "UNAUTHENTICATED";

export function requireFeatureConsent(feature: FeatureConsentKey): RequestHandler {
  // 工厂期就把映射取出来：挂了一个不存在的功能键时，路由装配（进程启动）即失败，
  // 而不是等到某个请求才 500。
  const requirement = FEATURE_CONSENT_REQUIREMENTS[feature];

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const userId = String((req as AuthenticatedRequest).user?.id ?? "").trim();
    if (!userId) {
      res.status(401).json({ error: "未登录", code: UNAUTHENTICATED_CODE });
      return;
    }

    try {
      // 与 GET /api/policy/feature-consent 走同一个函数：403 里的 required/missing 与前端拿到的
      // 状态因此不可能分叉（门禁口径改了只改一处）。判定只认 userId，不回落到指纹。
      const views = await resolveFeatureConsentViews(userId, CURRENT_POLICY_VERSION);
      const view = views.find((item) => item.key === feature);
      // 兜底取副本：映射表里的数组不该被响应对象持有引用（将来谁改了响应就会改到配置）
      const requiredAgreements = view?.requiredAgreements ?? [...requirement.agreements];
      const missingAgreements = view?.missingAgreements ?? [...requirement.agreements];

      if (view?.satisfied) {
        next();
        return;
      }

      res.status(403).json({
        error: "该功能需要先同意相关条款",
        code: POLICY_CONSENT_REQUIRED_CODE,
        feature,
        label: requirement.label,
        category: requirement.category,
        rationale: requirement.rationale,
        requiredAgreements,
        missingAgreements,
        policyVersion: view?.policyVersion ?? CURRENT_POLICY_VERSION,
        message: requirement.message,
      });
    } catch (error) {
      // fail-closed：读不到同意状态就按「未同意」处理（与 middleware/adminScope 同一口径）——
      // 宁可让用户重试一次，也不放行一个无法证明已同意的请求。响应形状保持一致，
      // 前端因此仍会展示同意清单，而不是停在一个它不知道怎么处理的错误上。
      logger.error("[功能同意] 同意状态校验失败，已按拒绝处理", {
        feature,
        path: `${req.baseUrl || ""}${req.path || ""}`,
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(403).json({
        error: "该功能需要先同意相关条款",
        code: POLICY_CONSENT_REQUIRED_CODE,
        feature,
        label: requirement.label,
        category: requirement.category,
        rationale: requirement.rationale,
        requiredAgreements: [...requirement.agreements],
        missingAgreements: [...requirement.agreements],
        policyVersion: CURRENT_POLICY_VERSION,
        message: requirement.message,
      });
    }
  };
}
