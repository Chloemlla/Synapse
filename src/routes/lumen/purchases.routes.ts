import { Router, type Request, type Response, type NextFunction } from "express";
import { requireAuth, requireDeviceSecurity } from "../../middleware/lumen/index.js";
import { entitlementsService } from "../../services/lumen/index.js";

const router = Router();

router.post("/google/verify", requireAuth(), requireDeviceSecurity(), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { productId, purchaseToken, deviceInstallationId } = req.body;
    const userId = req.lumenUserId;
    if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }
    // 购买令牌与商品号都是客户端可控的请求体字段，非字符串会在下游被当成查询对象（NoSQL 注入）。
    if (typeof productId !== "string" || typeof purchaseToken !== "string"
      || productId.trim() === "" || purchaseToken.trim() === "") {
      res.status(400).json({ error: "productId 与 purchaseToken 必须是非空字符串" });
      return;
    }
    const result = await entitlementsService.verifyGooglePurchase(
      userId,
      productId,
      purchaseToken,
      deviceInstallationId,
    );
    res.json(result);
  } catch (error) {
    next(error);
  }
});

export default router;