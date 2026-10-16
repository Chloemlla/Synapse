import mongoose from "mongoose";
import { isBlockedAddress } from "../utils/ssrfGuard";
import { PixelDomainError, type PixelIntegrationConfigView } from "./types";

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
 * 读取生效配置。未配置 / 被显式关闭 / 地址或 host 清单不完整时返回 null（**fail-closed**）。
 */
export async function loadPixelIntegrationConfig(): Promise<PixelIntegrationConfig | null> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

  const doc = await PixelIntegrationConfigModel.findOne({ key: CONFIG_KEY }).lean();
  let value: PixelIntegrationConfig | null = null;
  if (doc && doc.enabled && doc.upstreamBaseUrl) {
    const allowedHosts = normalizeAllowedHosts(doc.allowedHosts);
    // 出站前的第一道闸：地址与 host 清单必须自洽。不自洽就当作没配置，而不是"尽力连一下"。
    try {
      const base = validatePixelUpstreamBaseUrl(doc.upstreamBaseUrl, allowedHosts);
      for (const host of allowedHosts) assertHostAllowedShape(host);
      if (base) {
        value = {
          upstreamBaseUrl: base,
          allowedHosts,
          enabled: true,
          requestTimeoutMs: normalizeTimeoutMs(doc.requestTimeoutMs),
        };
      }
    } catch {
      value = null;
    }
  }
  cached = { at: Date.now(), value };
  return value;
}

export async function getPixelIntegrationConfigView(): Promise<PixelIntegrationConfigView> {
  const doc = await PixelIntegrationConfigModel.findOne({ key: CONFIG_KEY }).lean();
  if (!doc) {
    return {
      configured: false,
      enabled: false,
      upstreamBaseUrl: "",
      allowedHosts: [],
      requestTimeoutMs: DEFAULT_TIMEOUT_MS,
      updatedAt: null,
      updatedByUsername: "",
    };
  }
  const configured = Boolean(doc.upstreamBaseUrl && normalizeAllowedHosts(doc.allowedHosts).length);
  return {
    configured,
    enabled: Boolean(doc.enabled) && configured,
    upstreamBaseUrl: doc.upstreamBaseUrl || "",
    allowedHosts: normalizeAllowedHosts(doc.allowedHosts),
    requestTimeoutMs: normalizeTimeoutMs(doc.requestTimeoutMs),
    updatedAt: doc.updatedAt ? new Date(doc.updatedAt).toISOString() : null,
    updatedByUsername: doc.updatedByUsername || "",
  };
}

/**
 * 保存生效配置（仅超管路径调用，调用点已由 authenticateSuperAdmin 把关）。
 * 校验顺序刻意是「先归一 host 清单 → 再校验地址」，这样 base URL 的 host 一定能在清单里找到。
 */
export async function savePixelIntegrationConfig(
  input: unknown,
  actor: { userId: string; username: string },
): Promise<PixelIntegrationConfigView> {
  const body = input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
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
