import express from "express";
import { PolicyConsentLogController } from "../../controllers/admin/policyConsentLogController";
import { authenticateSuperAdmin } from "../../middleware/auth";
import { auditLog } from "../../middleware/auditLog";
import {
  FEATURE_CONSENT_CATEGORY_AGREEMENTS,
  FEATURE_CONSENT_KEYS,
  FEATURE_CONSENT_REQUIREMENTS,
} from "../../config/featureConsent";

/**
 * 隐私政策同意记录只读面板（超级管理员专用）。
 *
 * 挂载点：/api/admin（src/routes/admin/index.ts）。两个端点全是 GET，只读不写。
 * 记录里含设备指纹、原始 IP 与 User-Agent，因此要求 superadmin，与同目录
 * proxycheck / mobile-token 面板同级，而不是普通 admin。
 */
const router = express.Router();

// codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter, preTamperModules G11-06); in-router copy would split quota
router.get("/policy-consents/overview", authenticateSuperAdmin, PolicyConsentLogController.getOverview);
// codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter, preTamperModules G11-06); in-router copy would split quota
router.get("/policy-consents", authenticateSuperAdmin, PolicyConsentLogController.listConsents);
/**
 * 功能门禁清单（页面 `/admin/policy-consents` 的「功能门禁」页签）。
 *
 * 只读派生自 `config/featureConsent.ts` —— 那份文件是「功能 → 条款」的唯一真相源，
 * 这里不再维护第二份清单，避免面板展示与真实门禁漂移。
 *
 * 故意**不**回「某功能挡住了多少人」：那需要逐功能实时查同意状态，
 * 在管理端热路径上代价高且容易误读（同意是有有效期的）。页面对此显式写「不提供」，
 * 而不是渲染一个 0 让人以为没人被挡。
 */
// codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter, preTamperModules G11-06); in-router copy would split quota
router.get("/policy-consents/feature-gates", authenticateSuperAdmin, (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({
    success: true,
    gates: FEATURE_CONSENT_KEYS.map((key) => {
      const requirement = FEATURE_CONSENT_REQUIREMENTS[key];
      const expected = FEATURE_CONSENT_CATEGORY_AGREEMENTS[requirement.category];
      return {
        key,
        label: requirement.label,
        category: requirement.category,
        agreements: requirement.agreements,
        /** 分类规则要求的条款：与 agreements 不一致时说明配置写错了。 */
        expectedAgreements: expected,
        consistent:
          expected.length === requirement.agreements.length &&
          expected.every((item) => requirement.agreements.includes(item)),
        rationale: requirement.rationale,
        message: requirement.message,
      };
    }),
    deniedCountNote:
      "本页不统计「某功能当前挡住了多少用户」：同意有有效期且按 userId 实时判定，管理端热路径上不做该聚合。",
  });
});

// 导出是唯一会一次性下发大量设备指纹/IP 的端点：superadmin + 审计留痕 + 单次行数封顶（见控制器）
// codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter, preTamperModules G11-06); in-router copy would split quota
router.get(
  "/policy-consents/export",
  authenticateSuperAdmin,
  auditLog({ module: "policy", action: "policy.consents.export", captureBody: false }),
  PolicyConsentLogController.exportConsents,
);

export default router;
