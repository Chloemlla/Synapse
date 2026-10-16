import { pixelCdkMappingService, resolveEnabledCardMapping } from "./cdkMappingService";
import { pixelUsageLogService, pixelOutcomeFromError, pixelUpstreamStatusFromError } from "./usageLogService";
import { mapUpstreamFailure, pixelUpstreamClient, type PixelUpstreamClient } from "./upstreamClient";
import {
  PIXEL_SERVICE_QUOTA_COST,
  PIXEL_SERVICE_TYPES,
  type PixelCardQuotaView,
  type PixelServiceOptionView,
  type PixelSettingsView,
} from "./types";

/**
 * 卡密验证与额度（PIX-02 / PIX-03 的服务端一半）。
 *
 * 分工：用户提交的是**分发卡密**，本服务把它换成映射里的上游 CDK，再向上游要额度；
 * 上游的任何字段都只在这里被读一次并归一化，视图之外不再出现上游原文。
 *
 * 安全要点：
 *   · 卡密只出现在请求体里（不进 URL/query），调用上游时也只放在 JSON body 里；
 *   · 上游 CDK 解密失败 = 服务不可用（503），不把密文发出去；
 *   · 响应里的额度是上游原文的**白名单拷贝**：只取额度相关字段，其它字段（邮箱、链接等）
 *     即使上游返回也不会出现在我们的响应里。
 */
export interface PixelCardServiceDeps {
  upstream: Pick<PixelUpstreamClient, "call">;
  /** 卡密解析只要「查哈希 + 解密」两个能力，语义在 resolveEnabledCardMapping 里。 */
  mappings: Pick<typeof pixelCdkMappingService, "findByDistributionCdk" | "decryptUpstreamCdk">;
  usage: Pick<typeof pixelUsageLogService, "record">;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** 展示用额度：字符串优先（新字段是字符串），其次数字（旧字段）。 */
function displayValue(...candidates: unknown[]): string | null {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim().slice(0, 40);
    if (typeof candidate === "number" && Number.isFinite(candidate)) return String(candidate);
  }
  return null;
}

/** 计费单位额度：新字段 *_units 优先，缺失时回落旧字段。 */
function numericValue(...candidates: unknown[]): number | null {
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
    if (typeof candidate === "string") {
      const parsed = Number.parseFloat(candidate.trim());
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

/** 上游的开关键只有明确的「真」才算开：缺字段/解析不出时按关闭处理（fail-closed）。 */
function upstreamFlag(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === "number") return value === 1;
  if (typeof value === "string") return value.trim().toLowerCase() === "true" || value.trim() === "1";
  return false;
}

export function createPixelCardService(deps: PixelCardServiceDeps) {
  return {
    /**
     * 服务器开关（PIX-03）：上游 `/api/settings` 决定两个绑卡能力是否可用。
     * 不涉及卡密，因此这里没有映射可记，溯源日志记为「未命中映射」。
     */
    async getSettings(userId: string, requestId?: string): Promise<PixelSettingsView> {
      const startedAt = Date.now();
      let requestBytes = 0;
      let responseBytes: number | null = null;
      let upstreamStatus: number | null = null;
      try {
        const result = await deps.upstream.call({ route: "settings" });
        requestBytes = result.requestBytes;
        responseBytes = result.responseBytes;
        upstreamStatus = result.status;
        if (!result.data || result.status < 200 || result.status >= 300) {
          throw mapUpstreamFailure(result.status);
        }
        const data = asRecord(result.data);
        const autoBindEnabled = upstreamFlag(data.auto_bind_enabled);
        const autoBindOneDollarEnabled = upstreamFlag(data.auto_bind_one_dollar_enabled);
        const services: PixelServiceOptionView[] = PIXEL_SERVICE_TYPES.map((type) => ({
          type,
          quotaCost: PIXEL_SERVICE_QUOTA_COST[type],
          enabled: type === "link_only"
            ? true
            : type === "link_and_bind"
              ? autoBindEnabled
              : autoBindOneDollarEnabled,
        }));
        await deps.usage.record({
          userId,
          mappingId: null,
          matchedMapping: false,
          requestedCdk: null,
          method: result.method,
          path: result.path,
          serviceType: null,
          accountCount: null,
          requestBytes,
          responseBytes,
          upstreamStatus,
          outcome: "success",
          durationMs: result.durationMs,
          requestId,
        });
        return { autoBindEnabled, autoBindOneDollarEnabled, services };
      } catch (error) {
        await deps.usage.record({
          userId,
          mappingId: null,
          matchedMapping: false,
          requestedCdk: null,
          method: "GET",
          path: "/api/settings",
          serviceType: null,
          accountCount: null,
          requestBytes,
          responseBytes,
          upstreamStatus: upstreamStatus ?? pixelUpstreamStatusFromError(error),
          outcome: pixelOutcomeFromError(error),
          durationMs: Date.now() - startedAt,
          requestId,
        });
        throw error;
      }
    },

    async verifyCard(userId: string, rawCard: unknown, requestId?: string): Promise<PixelCardQuotaView> {
      const target = await resolveEnabledCardMapping(deps.mappings, rawCard);
      const startedAt = Date.now();
      let requestBytes = 0;
      let responseBytes: number | null = null;
      let upstreamStatus: number | null = null;
      try {
        const result = await deps.upstream.call({
          route: "verifyCard",
          body: { card_key: target.upstreamCdk },
        });
        requestBytes = result.requestBytes;
        responseBytes = result.responseBytes;
        upstreamStatus = result.status;
        if (result.status < 200 || result.status >= 300) {
          throw mapUpstreamFailure(result.status);
        }
        const data = asRecord(result.data);
        // 上游对无效卡密也回 200 + valid:false；此时仍然允许查历史（映射存在 → 按卡密过滤可用），
        // 所以 historyAvailable 与 valid 无关。
        const valid = data.valid === true;
        const view: PixelCardQuotaView = {
          valid,
          remainingQuota: displayValue(data.remaining_quota, data.remaining),
          totalQuota: displayValue(data.total_quota, data.total_count),
          remainingUnits: numericValue(data.remaining_quota_units, data.remaining),
          totalUnits: numericValue(data.total_quota_units, data.total_count),
          historyAvailable: true,
          message: valid ? "卡密有效。" : "卡密当前不可用（可能已失效或额度已用尽），仍可查看历史任务。",
        };
        await deps.usage.record({
          userId,
          mappingId: target.record.mappingId,
          matchedMapping: true,
          requestedCdk: target.card,
          method: result.method,
          path: result.path,
          serviceType: null,
          accountCount: null,
          requestBytes,
          responseBytes,
          upstreamStatus,
          outcome: "success",
          durationMs: result.durationMs,
          requestId,
        });
        return view;
      } catch (error) {
        await deps.usage.record({
          userId,
          mappingId: target.record.mappingId,
          matchedMapping: true,
          requestedCdk: target.card,
          method: "POST",
          path: "/api/verify-card",
          serviceType: null,
          accountCount: null,
          requestBytes,
          responseBytes,
          upstreamStatus: upstreamStatus ?? pixelUpstreamStatusFromError(error),
          outcome: pixelOutcomeFromError(error),
          durationMs: Date.now() - startedAt,
          requestId,
        });
        throw error;
      }
    },
  };
}

export type PixelCardService = ReturnType<typeof createPixelCardService>;

export const pixelCardService = createPixelCardService({
  upstream: pixelUpstreamClient,
  mappings: pixelCdkMappingService,
  usage: pixelUsageLogService,
});
