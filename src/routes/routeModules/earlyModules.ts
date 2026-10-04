import type { RouteModule } from "../index";
import analyticsRoutes from "../analyticsRoutes";
import emailRoutes from "../emailRoutes";
import invitationRoutes from "../invitationRoutes";
import outemailRoutes from "../outemailRoutes";
import recommendationRoutes from "../recommendationRoutes";
import workspaceRoutes from "../workspaceRoutes";

export const earlyRouteModules: RouteModule[] = [
  {
    name: "analytics-routes",
    path: "/api/analytics",
    router: analyticsRoutes,
    requiresAuth: true,
    rateLimited: true,
    isPublic: false,
    authPolicy: {
      mode: "route",
      handlers: ["authenticateToken"],
      note: "Every analytics endpoint chains authenticateToken inside the router; no mount-level auth is applied.",
    },
    rateLimitPolicy: {
      mode: "route",
      limiters: ["analyticsLimiter", "exportLimiter"],
      note: "analyticsRoutes.ts builds its own route-level limiters (30/min for reads, 5/min for export); no mount-level limiter is applied, so the same limiter instance is never counted twice.",
    },
  },
  {
    name: "recommendation-routes",
    path: "/api/recommendations",
    router: recommendationRoutes,
    requiresAuth: "mixed",
    rateLimited: true,
    isPublic: "mixed",
    authPolicy: {
      mode: "mixed",
      handlers: ["authenticateToken", "optionalAuthenticateToken"],
      note: "GET /popular is intentionally public, POST /analyze only opts into identity via optionalAuthenticateToken; every other endpoint chains authenticateToken inside the router.",
    },
    rateLimitPolicy: {
      mode: "route",
      limiters: ["recommendationLimiter", "analyzeLimiter"],
      note: "recommendationRoutes.ts builds its own route-level limiters (30/min general, 20/min for analyze); no mount-level limiter is applied, so the same limiter instance is never counted twice.",
    },
  },
  {
    name: "invitation-routes",
    path: "/api/invitations",
    router: invitationRoutes,
    requiresAuth: true,
    rateLimited: true,
    isPublic: false,
    authPolicy: {
      mode: "route",
      handlers: ["authenticateToken"],
      note: "Every invitation endpoint chains authenticateToken inside the router; no mount-level auth is applied.",
    },
    rateLimitPolicy: {
      mode: "route",
      limiters: ["invitationLimiter"],
      note: "invitationRoutes.ts builds its own 20/min route-level limiter; no mount-level limiter is applied, so the same limiter instance is never counted twice.",
    },
  },
  {
    name: "workspace-routes",
    path: "/api/workspaces",
    router: workspaceRoutes,
    requiresAuth: true,
    rateLimited: true,
    isPublic: false,
    authPolicy: {
      mode: "route",
      handlers: ["authenticateToken"],
      note: "Every workspace endpoint chains authenticateToken inside the router; no mount-level auth is applied.",
    },
    rateLimitPolicy: {
      mode: "route",
      limiters: ["workspaceLimiter", "inviteLimiter"],
      note: "workspaceRoutes.ts builds its own route-level limiters (30/min general, 10/min for invites); no mount-level limiter is applied, so the same limiter instance is never counted twice.",
    },
  },
  {
    name: "email-routes",
    path: "/api/email",
    router: emailRoutes,
    requiresAuth: "mixed",
    rateLimited: "mixed",
    isPublic: "mixed",
    authPolicy: {
      mode: "mixed",
      handlers: ["authMiddleware", "adminAuthMiddleware", "authenticateSuperAdmin"],
      note: "Admin reads (status, quota, domains) require JWT plus an admin-role check at mount; send and domain-management writes are gated to superadmin at route level.",
    },
  },
  {
    name: "outemail-routes",
    path: "/api/outemail",
    router: outemailRoutes,
    requiresAuth: "mixed",
    rateLimited: true,
    isPublic: "mixed",
    rateLimitPolicy: {
      mode: "route",
      limiters: ["outEmailLimiter", "statusQueryLimiter"],
      note: "Public outemail endpoints apply dedicated route-level limiters; records reads are admin-gated with the status limiter.",
    },
    authPolicy: {
      mode: "mixed",
      handlers: ["authMiddleware", "adminAuthMiddleware"],
      note: "Send/quota/status/domain endpoints are public (send authenticates via API key/code); records and records/:id reads require a JWT session plus admin role.",
    },
  },
];
