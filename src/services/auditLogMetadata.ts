import type { IAuditLog } from "../models/auditLogModel";
import { AUDIT_MODULE_VALUES } from "./auditLogCatalog";

export { ALLOWED_AUDIT_MODULES } from "./auditLogCatalog";

export const AUDIT_LOG_ADAPTATION_STATUS = "completed" as const;
export const AUDIT_LOG_OPENAPI_EXTENSION = "x-audit-log";
export const AUDIT_LOG_SOURCE = "AuditLogService.globalAuditMiddleware";
export const BACKEND_API_PREFIX = "/api";

/**
 * 顶层路由段 → 审计模块的别名表。
 *
 * 这张表**只处理「路径段和模块名不一致」的情况**：路径段先按模块名精确匹配
 * （`ALLOWED_AUDIT_MODULES`），匹配不上才查这里。因此同一语义的两种写法
 * （`recommendations` / `recommendation`）不会各自漂成一个模块。
 *
 * 新增路由时先看第一段路径是否已经能命中模块名；只有不一致才在这里加一条。
 */
const AUDIT_MODULE_ALIASES: Record<string, IAuditLog["module"]> = {
  analytics: "admin",
  apikeys: "api",
  "api-keys": "api",
  "api-docs": "api",
  "api-docs.json": "api",
  articles: "announcement",
  "bilibili-sync": "media",
  cdict: "api",
  cdks: "cdk",
  "client-telemetry": "security",
  "coin-flip": "lottery",
  "data-collection": "security",
  data: "api",
  "doc-tool": "media",
  "fbi-wanted": "api",
  "frontend-config": "config",
  "github-billing": "api",
  "human-check": "security",
  "image-data": "api",
  "ip-info": "network",
  "ip-verification": "security",
  invitations: "user",
  "libre-chat": "api",
  librechat: "api",
  miniapi: "api",
  nexai: "api",
  oauth: "oauth",
  openapi: "api",
  "openapi.json": "api",
  outemail: "email",
  passkey: "auth",
  recommendations: "recommendation",
  resources: "resource",
  sharelog: "api",
  "step-up": "security",
  tamper: "security",
  tickets: "system",
  totp: "auth",
  transcribe: "media",
  turnstile: "security",
  "webhook-events": "admin",
  webhooks: "api",
  workspaces: "workspace",
};

export function isAuditLogRuntimeEnabled(): boolean {
  return process.env.GLOBAL_AUDIT_ENABLED !== "false";
}

export function isBackendApiPath(pathname: string): boolean {
  return pathname === BACKEND_API_PREFIX || pathname.startsWith(`${BACKEND_API_PREFIX}/`);
}

function getPathname(rawPath: string): string {
  const [pathname] = rawPath.split("?");
  return pathname || "/";
}

function normalizeRouteSegment(segment: string | undefined): string {
  return String(segment || "")
    .trim()
    .toLowerCase();
}

export function inferAuditModuleFromPath(rawPath: string): IAuditLog["module"] {
  const pathname = getPathname(rawPath);
  const segments = pathname.split("/").filter(Boolean);
  const routeSegment = segments[0] === "api" ? segments[1] : segments[0];
  const normalizedSegment = normalizeRouteSegment(routeSegment);

  if (!normalizedSegment) {
    return "api";
  }

  if (MODULE_SEGMENTS.has(normalizedSegment)) {
    return normalizedSegment as IAuditLog["module"];
  }

  return AUDIT_MODULE_ALIASES[normalizedSegment] || "other";
}

/** 路径段按模块名精确匹配用（模块清单的唯一来源仍是 catalog）。 */
const MODULE_SEGMENTS: ReadonlySet<string> = new Set<string>(AUDIT_MODULE_VALUES);
