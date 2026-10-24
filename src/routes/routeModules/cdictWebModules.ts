import type { RouteModule } from "../index";
import cdictWebRoutes, { privateCdictWebResponse } from "../cdictWebRoutes";
import { authenticateToken } from "../../middleware/authenticateToken";
import { requireAllowedOriginForWrites } from "../../middleware/corsMiddleware";
import { translationAccessMiddleware } from "../../middleware/translationAccessMiddleware";
import { cdictWebIngressLimiter } from "../../middleware/cdictWebLimiters";

export const cdictWebRouteModules: RouteModule[] = [{
  name: "cdict-web-routes",
  path: "/api/translate/cdict",
  router: cdictWebRoutes,
  middlewares: [
    privateCdictWebResponse,
    cdictWebIngressLimiter,
    requireAllowedOriginForWrites,
    authenticateToken,
    translationAccessMiddleware,
  ],
  requiresAuth: true,
  isPublic: false,
  rateLimited: true,
  strictStackCheck: true,
  authPolicy: { mode: "mount", handlers: ["authenticateToken", "translationAccessMiddleware"] },
  rateLimitPolicy: {
    mode: "mixed",
    limiters: [
      "cdictWebIngressLimiter", "cdictWebUpstreamIpLimiter", "cdictWebUpstreamUserLimiter",
      "cdictWebUpstreamUserBurstGuard", "cdictWebUpstreamIpBurstGuard", "cdictWebUpstreamGlobalBurstGuard",
      "cdictDonationClaimLimiter", "cdictWebClaimLimiter",
    ],
    note: "Mounted IP ingress ceiling on every endpoint; translate/tts have independent IP/account windows and account/IP/global in-flight caps after feature consent. Claims have IP and account limits. No role/signature exemptions.",
  },
  // No bypass flags: retain the normal website WAF, IP, tamper and audit pipeline.
}];
