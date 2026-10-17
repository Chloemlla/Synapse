import express from "express";
import { DeepLXController } from "../controllers/deeplxController";
import { authenticateToken } from "../middleware/authenticateToken";
import { requireFeatureConsent } from "../middleware/featureConsent";
import { translationAccessMiddleware } from "../middleware/translationAccessMiddleware";

const router = express.Router();

router.use(authenticateToken);
router.use(requireFeatureConsent("deeplx-translate"));
router.get("/config", DeepLXController.getConfig);
router.post("/translate", translationAccessMiddleware, DeepLXController.translate);

export default router;
