import type { RouteModule } from "../index";
import { libreChatLimiter } from "../../middleware/routeLimiters";
import libreChatRoutes from "../libreChatRoutes";
import ttsRoutes from "../ttsRoutes";
import geoGebraRoutes from "../geogebraRoutes";

export const preDocsRouteModules: RouteModule[] = [
  {
    name: "tts-routes",
    path: "/api/tts",
    router: ttsRoutes,
    requiresAuth: "mixed",
    rateLimited: true,
    isPublic: "mixed",
    authPolicy: {
      mode: "mixed",
      handlers: ["authenticateAdmin", "authenticateSuperAdmin"],
      note: "TTS generation is gated by API-key auth; admin history reads are admin-level and clarity config writes are gated to superadmin inside the router.",
    },
    securityBypass: {
      ipVerification: {
        value: "mixed",
        reason:
          "Only the /assets subtree (browser audio streaming with scoped, expiring asset tokens) bypasses IP verification; generation and job endpoints remain gated.",
      },
    },
  },
  {
    name: "librechat-compat-routes",
    path: "/api/librechat",
    router: libreChatRoutes,
    middlewares: [libreChatLimiter],
    requiresAuth: true,
    rateLimited: true,
    isPublic: false,
    authPolicy: {
      mode: "router",
      handlers: ["authenticateToken"],
      note: "LibreChat 只属于登录账号：router 内统一 enforce JWT/Cookie 登录（authenticateToken），不再接受游客或客户端自选 token；admin 用户/提供方读写仍由 admin 子路由内的角色门控约束。",
    },
  },
  {
    name: "geogebra-routes",
    path: "/api/geogebra",
    router: geoGebraRoutes,
    requiresAuth: "mixed",
    rateLimited: true,
    isPublic: "mixed",
    authPolicy: {
      mode: "mixed",
      handlers: ["authenticateToken"],
      note: "项目、评论、分享写入与导出在 router 内要求当前 Synapse 会话和用户级 feature consent；公开分享读取仅返回已发布快照。",
    },
    rateLimitPolicy: {
      mode: "route-module",
      limiters: ["geogebra-limiter"],
      note: "统一限流由前置 /api/geogebra geogebra-limiter 承担，router 不重复挂载同一 limiter。",
    },
  },
];
