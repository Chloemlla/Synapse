import type { RouteModule } from "../index";
import { libreChatLimiter } from "../../middleware/routeLimiters";
import libreChatRoutes from "../libreChatRoutes";
import ttsRoutes from "../ttsRoutes";
import geoGebraRoutes from "../geogebraRoutes";
import pixelRoutes from "../pixelRoutes";

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
  {
    name: "pixel-routes",
    path: "/api/pixel",
    router: pixelRoutes,
    requiresAuth: true,
    rateLimited: true,
    isPublic: false,
    authPolicy: {
      mode: "router",
      handlers: ["authenticateToken"],
      note: "卡密额度、任务归属与结果链接都绑定在登录账号上，整棵 /api/pixel 只给登录用户；需要把账号凭据交给上游的端点再叠 account-credential 类同意门禁。",
    },
    rateLimitPolicy: {
      // 不用 route-module：那要求限流模块的挂载路径是本模块作用域的祖先或相等，
      // 而这里故意把三档限流挂在 /api/pixel 的更深路径上（提交 10/分、卡密验证 20/分、
      // 查询类 60/分，用户+IP 双键），否则一次提交会同时吃掉查询额度。
      mode: "route",
      limiters: ["pixel-limiter-verify", "pixel-limiter-submit", "pixel-limiter-settings", "pixel-limiter-tasks", "pixel-limiter-tasks-by-card", "pixel-limiter-export"],
      note: "限流由独立的限流模块按路径分别挂载（pixel-limiter-verify 20/分、pixel-limiter-submit 10/分、pixel-limiter-settings/tasks/tasks-by-card/export 60/分，均按用户+IP 双键分桶）；router 内不重复挂载同一 limiter 实例。",
    },
  },
];
