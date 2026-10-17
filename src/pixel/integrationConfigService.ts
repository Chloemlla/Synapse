import mongoose from "mongoose";
import { isBlockedAddress } from "../utils/ssrfGuard";
import {
  PixelDomainError,
  type PixelIntegrationConfigView,
} from "./types";

/**
 * Pixel 上游集成配置（PRD 6.1.7 / PIX-13 的 Phase 4 子集）。
 *
 * 为什么这里自成一张表而不是塞进 `runtime_config_settings`：
 *   · 该集合的 key 有 mongoose enum（src/models/runtimeConfigModel.ts），加新 key 必须同时改
 *     runtimeConfigService 的默认值/校验/分组——本阶段的改动范围只有 src/pixel/**；
 *   · 上游地址是「一个账号体系接一个外部供应商」的集成参数，语义上属于 Pixel 域，不是全站运行时配置。
 *   Phase 5 若要并入运行时配置中心，把本文件换成 runtimeConfigService 的一个分组即可，
 *   上游调用方只认 loadPixelIntegrationConfig()。
 *
 * fail-closed 是本文件的中心思想：
 *   · 没配置 → 返回 null，所有上游操作抛 PIXEL_UPSTREAM_NOT_CONFIGURED（**没有默认地址可回落**）；
 *   · 配置里显式关掉 → 同样返回 null；
 *   · 地址必须 https、host 必须在 allowlist 里（保存时与出站时各校验一次，防「先保存合法、后改 DNS」）。
 */
export interface PixelIntegrationConfig {
  upstreamBaseUrl: string;
  allowedHosts: string[];
  enabled: boolean;
  requestTimeoutMs: number;
}

interface PixelIntegrationConfigDoc extends PixelIntegrationConfig {
  key: string;
  updatedByUserId: string;
  updatedByUsername: string;
  updatedAt: Date;
}

const PixelIntegrationConfigSchema = new mongoose.Schema<PixelIntegrationConfigDoc>(
  {
    key: { type: String, required: true, unique: true },
    upstreamBaseUrl: { type: String, default: "" },
    allowedHosts: { type: [String], default: [] },
    enabled: { type: Boolean, default: false },
    requestTimeoutMs: { type: Number, default: 20_000 },
    updatedByUserId: { type: String, default: "" },
    updatedByUsername: { type: String, default: "" },
    updatedAt: { type: Date, default: Date.now },
  },
  { collection: "pixel_integration_configs", versionKey: false },
);

const PixelIntegrationConfigModel =
  (mongoose.models.PixelIntegrationConfig as mongoose.Model<PixelIntegrationConfigDoc>) ||
  mongoose.model<PixelIntegrationConfigDoc>("PixelIntegrationConfig", PixelIntegrationConfigSchema);

const CONFIG_KEY = "default";
/** 出站路径每次都要读配置，加一个短缓存避免每次请求都打 Mongo；写入时立即失效。 */
const CACHE_TTL_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 20_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 60_000;
const HOSTNAME_PATTERN = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
/** 明显属于内部命名空间的 TLD：真正的判定是出站时的 DNS 解析，这里只是省掉一次明显的误配。 */
const INTERNAL_TLD_PATTERN = /(?:^|\.)(?:local|internal|localhost|lan|home|corp)$/;

/**
 * 写接口只接受这四个字段。其余字段（包括 `source`/`overridden`/`reload` 这类派生元数据）
 * 一律 400——这是 allowlist 而不是 denylist：Mongo URI、数据库名、主密钥、签名材料等
 * bootstrap 配置不能因为「忘了列进黑名单」而在这个页面被改写（PRD PIX-13，fail-closed）。
 */
const WRITABLE_CONFIG_KEYS: ReadonlySet<string> = new Set([
  "upstreamBaseUrl",
  "allowedHosts",
  "enabled",
  "requestTimeoutMs",
]);

/**
 * 部署环境里的上游配置（PIX-13 的「容器默认」来源）。
 * 只作为**数据库没有记录时**的显式配置通道存在：它没有任何默认地址，未填写就仍然
 * fail-closed，不会凭空出现一个可连接的上游。
 */
const ENV_KEYS = {
  baseUrl: "PIXEL_UPSTREAM_BASE_URL",
  allowedHosts: "PIXEL_UPSTREAM_ALLOWED_HOSTS",
  enabled: "PIXEL_UPSTREAM_ENABLED",
  timeoutMs: "PIXEL_UPSTREAM_TIMEOUT_MS",
} as const;

interface PixelIntegrationConfigInput {
  upstreamBaseUrl: string;
  allowedHosts: string[];
  enabled: boolean;
  requestTimeoutMs: number;
}

function readEnvIntegrationConfig(env: NodeJS.ProcessEnv = process.env): PixelIntegrationConfigInput | null {
  const baseUrl = String(env[ENV_KEYS.baseUrl] ?? "").trim();
  const rawHosts = String(env[ENV_KEYS.allowedHosts] ?? "").split(",");
  const allowedHosts = normalizeAllowedHosts(rawHosts);
  const enabledRaw = String(env[ENV_KEYS.enabled] ?? "").trim().toLowerCase();
  const enabled = ["1", "true", "yes", "on"].includes(enabledRaw);
  // 一个环境变量都没设 → 没有 env 来源，避免把「内置默认值」误报成 env。
  if (!baseUrl && allowedHosts.length === 0 && !enabledRaw) return null;
  return {
    upstreamBaseUrl: baseUrl,
    allowedHosts,
    enabled,
    requestTimeoutMs: normalizeTimeoutMs(env[ENV_KEYS.timeoutMs]),
  };
}

function applyIntegrationConfigCandidate(input: PixelIntegrationConfigInput): PixelIntegrationConfig | null {
  if (!input.enabled || !input.upstreamBaseUrl) return null;
  const allowedHosts = normalizeAllowedHosts(input.allowedHosts);
  try {
    const base = validatePixelUpstreamBaseUrl(input.upstreamBaseUrl, allowedHosts);
    for (const host of allowedHosts) assertHostAllowedShape(host);
    if (!base) return null;
    return {
      upstreamBaseUrl: base,
      allowedHosts,
      enabled: true,
      requestTimeoutMs: normalizeTimeoutMs(input.requestTimeoutMs),
    };
  } catch {
    return null;
  }
}

let cached: { at: number; value: PixelIntegrationConfig | null } | null = null;

export function invalidatePixelIntegrationConfigCache(): void {
  cached = null;
}

/** 把管理端传入的 host 清单归一：小写、去空、去重、去掉端口前的空白。 */
export function normalizeAllowedHosts(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const host = item.trim().toLowerCase();
    if (!host || seen.has(host)) continue;
    seen.add(host);
    out.push(host);
  }
  return out.slice(0, 20);
}

function assertHostAllowedShape(host: string): void {
  // IPv4/IPv6 字面量：直接判私网/环回/保留段（同步，无需 DNS）
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(":")) {
    if (isBlockedAddress(host)) {
      throw new PixelDomainError("上游主机不能是内网、环回或保留地址。", 400, "PIXEL_CONFIG_HOST_BLOCKED");
    }
    return;
  }
  if (!HOSTNAME_PATTERN.test(host)) {
    throw new PixelDomainError("上游主机名格式不正确。", 400, "PIXEL_CONFIG_HOST_INVALID");
  }
  if (INTERNAL_TLD_PATTERN.test(host)) {
    throw new PixelDomainError("上游主机名看起来是内部域名，请填写公网域名。", 400, "PIXEL_CONFIG_HOST_BLOCKED");
  }
}

/**
 * 校验并归一上游 base URL：必须是 https、只允许 host[:port]、不带凭据/查询串/路径。
 * 返回归一后的 `https://host[:port]`（不带尾斜杠）。
 */
export function validatePixelUpstreamBaseUrl(raw: unknown, allowedHosts: readonly string[]): string {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return "";
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new PixelDomainError("上游地址格式不正确。", 400, "PIXEL_CONFIG_URL_INVALID");
  }
  if (parsed.protocol !== "https:") {
    throw new PixelDomainError("上游地址必须使用 HTTPS。", 400, "PIXEL_CONFIG_URL_INSECURE");
  }
  if (parsed.username || parsed.password) {
    throw new PixelDomainError("上游地址不能携带账号密码。", 400, "PIXEL_CONFIG_URL_INVALID");
  }
  if (parsed.search || parsed.hash) {
    throw new PixelDomainError("上游地址不能带查询串或片段。", 400, "PIXEL_CONFIG_URL_INVALID");
  }
  if (parsed.pathname && parsed.pathname !== "/") {
    throw new PixelDomainError("上游地址只能是主机根地址，路径由服务端固定。", 400, "PIXEL_CONFIG_URL_INVALID");
  }
  const host = parsed.hostname.toLowerCase();
  if (!host) {
    throw new PixelDomainError("上游地址缺少主机名。", 400, "PIXEL_CONFIG_URL_INVALID");
  }
  if (!allowedHosts.includes(host)) {
    throw new PixelDomainError("上游主机必须在允许清单内。", 400, "PIXEL_CONFIG_HOST_NOT_ALLOWED");
  }
  return `https://${parsed.host}`;
}

function normalizeTimeoutMs(raw: unknown): number {
  const value = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(Math.trunc(value), MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
}

/**
 * 读取生效配置。优先级：数据库记录 > 环境变量 > 内置默认（上游地址为空的 fail-closed 默认）。
 * 未配置 / 被显式关闭 / 地址或 host 清单不完整时返回 null（**fail-closed**）。
 */
export async function loadPixelIntegrationConfig(): Promise<PixelIntegrationConfig | null> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

  const doc = await PixelIntegrationConfigModel.findOne({ key: CONFIG_KEY }).lean();
  // 有数据库记录就完全以它为准（即使它是「关闭」），不会被环境变量偷偷重新启用。
  const candidate: PixelIntegrationConfigInput | null = doc
    ? {
        upstreamBaseUrl: doc.upstreamBaseUrl ?? "",
        allowedHosts: normalizeAllowedHosts(doc.allowedHosts),
        enabled: Boolean(doc.enabled),
        requestTimeoutMs: normalizeTimeoutMs(doc.requestTimeoutMs),
      }
    : readEnvIntegrationConfig();
  const value = candidate ? applyIntegrationConfigCandidate(candidate) : null;
  cached = { at: Date.now(), value };
  return value;
}

export async function getPixelIntegrationConfigView(): Promise<PixelIntegrationConfigView> {
  const doc = await PixelIntegrationConfigModel.findOne({ key: CONFIG_KEY }).lean();
  if (doc) {
    const allowedHosts = normalizeAllowedHosts(doc.allowedHosts);
    const configured = Boolean(doc.upstreamBaseUrl && allowedHosts.length);
    return {
      configured,
      enabled: Boolean(doc.enabled) && configured,
      upstreamBaseUrl: doc.upstreamBaseUrl || "",
      allowedHosts,
      requestTimeoutMs: normalizeTimeoutMs(doc.requestTimeoutMs),
      updatedAt: doc.updatedAt ? new Date(doc.updatedAt).toISOString() : null,
      updatedByUsername: doc.updatedByUsername || "",
      source: "db",
      overridden: true,
      reload: "runtime",
    };
  }

  const envConfig = readEnvIntegrationConfig();
  if (envConfig) {
    return {
      configured: Boolean(envConfig.upstreamBaseUrl && envConfig.allowedHosts.length),
      enabled: envConfig.enabled && Boolean(envConfig.upstreamBaseUrl && envConfig.allowedHosts.length),
      upstreamBaseUrl: envConfig.upstreamBaseUrl,
      allowedHosts: envConfig.allowedHosts,
      requestTimeoutMs: envConfig.requestTimeoutMs,
      updatedAt: null,
      updatedByUsername: "环境变量",
      source: "env",
      overridden: false,
      reload: "restart",
    };
  }

  return {
    configured: false,
    enabled: false,
    upstreamBaseUrl: "",
    allowedHosts: [],
    requestTimeoutMs: DEFAULT_TIMEOUT_MS,
    updatedAt: null,
    updatedByUsername: "",
    source: "default",
    overridden: false,
    reload: "runtime",
  };
}
/**
 * 保存生效配置（仅超管路径调用，调用点已由 authenticateSuperAdmin 把关）。
 * 校验顺序刻意是「先归一 host 清单 → 再校验地址」，这样 base URL 的 host 一定能在清单里找到。
 * 入参先过 allowlist：任何未登记字段（含派生的 source/overridden/reload、以及 Mongo URI /
 * 主密钥 / 签名材料这类 bootstrap 项）直接 400，绝不被静默忽略或写进集合。
 */
export async function savePixelIntegrationConfig(
  input: unknown,
  actor: { userId: string; username: string },
): Promise<PixelIntegrationConfigView> {
  const body = input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
  for (const key of Object.keys(body)) {
    if (!WRITABLE_CONFIG_KEYS.has(key)) {
      throw new PixelDomainError(
        "该字段不允许在运行时配置页修改。",
        400,
        "PIXEL_CONFIG_PROTECTED_FIELD",
        { field: key.slice(0, 40) },
      );
    }
  }
  const allowedHosts = normalizeAllowedHosts(body.allowedHosts);
  if (allowedHosts.length === 0) {
    throw new PixelDomainError("请先填写允许访问的上游主机。", 400, "PIXEL_CONFIG_HOSTS_REQUIRED");
  }
  for (const host of allowedHosts) assertHostAllowedShape(host);
  const upstreamBaseUrl = validatePixelUpstreamBaseUrl(body.upstreamBaseUrl, allowedHosts);
  const enabled = body.enabled === true;
  if (enabled && !upstreamBaseUrl) {
    throw new PixelDomainError("启用上游前必须先填写上游地址。", 400, "PIXEL_CONFIG_URL_REQUIRED");
  }
  const requestTimeoutMs = normalizeTimeoutMs(body.requestTimeoutMs);

  await PixelIntegrationConfigModel.updateOne(
    { key: CONFIG_KEY },
    {
      $set: {
        upstreamBaseUrl,
        allowedHosts,
        enabled,
        requestTimeoutMs,
        updatedByUserId: actor.userId,
        updatedByUsername: actor.username,
        updatedAt: new Date(),
      },
      $setOnInsert: { key: CONFIG_KEY },
    },
    { upsert: true },
  );
  invalidatePixelIntegrationConfigCache();
  return getPixelIntegrationConfigView();
}

/**
 * 恢复默认（PIX-13）：删除数据库记录，回到「环境变量 > 内置默认」的来源。
 *
 * 注意这不是「恢复成一个可用的默认上游」——默认上游地址为空，删除后所有上游调用立刻
 * fail-closed（除非部署侧显式配置了环境变量）。审计由路由层写（记录操作者与结果来源）。
 */
export async function resetPixelIntegrationConfig(): Promise<PixelIntegrationConfigView> {
  await PixelIntegrationConfigModel.deleteOne({ key: CONFIG_KEY });
  invalidatePixelIntegrationConfigCache();
  return getPixelIntegrationConfigView();
}
