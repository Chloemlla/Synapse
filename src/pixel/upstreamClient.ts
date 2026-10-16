import axios from "axios";
import logger from "../utils/logger";
import { isTargetPublic } from "../utils/ssrfGuard";
import {
  loadPixelIntegrationConfig,
  type PixelIntegrationConfig,
} from "./integrationConfigService";
import { PixelDomainError } from "./types";

/**
 * Pixel 上游适配器（PRD 6.1.7 / 5.1「外部上游」）。
 *
 * 唯一的出站入口。规则：
 *   1. **显式 allowlist**：只有下面 PIXEL_UPSTREAM_ROUTES 里列出的「方法 + 路径」能被表达。
 *      业务代码只能按 route 名调用（`PixelUpstreamCall` 是判别联合），根本写不出任意路径——
 *      这比「先拼 URL 再拿正则校验」更强，因为拼 URL 的代码路径不存在。
 *      这是对来源仓库 `Router::new().route("/api/{*path}", any(proxy_api))` 那种开放透传的正面替代。
 *   2. **fail-closed**：上游地址由超级管理员在运行时配置；没配置就抛
 *      PIXEL_UPSTREAM_NOT_CONFIGURED，**没有默认地址可回落**。
 *   3. **每次出站都重新校验**：https、hostname 在配置的 allowlist 内、域名解析到公网地址
 *      （防 SSRF / DNS rebinding）、`maxRedirects: 0`（不跟重定向，否则 allowlist 形同虚设）。
 *   4. **只带必要请求头**：固定送 `accept` 与（有请求体时）`content-type`。
 *      不透传客户端的任何 header（cookie / authorization / x-forwarded-for 都不外发）。
 *   5. 请求体只驻留内存：日志里不出现 body、URL、上游 host 或上游错误正文。
 */

/** 方法 + 路径 allowlist（PRD 5.2 列的 7 个业务端点）。 */
export const PIXEL_UPSTREAM_ROUTES = {
  settings: { method: "GET", path: "/api/settings" },
  verifyCard: { method: "POST", path: "/api/verify-card" },
  submitTask: { method: "POST", path: "/api/submit-task" },
  task: { method: "GET", path: "/api/task/:taskId" },
  tasksByCard: { method: "POST", path: "/api/tasks-by-card" },
  exportByCard: { method: "POST", path: "/api/tasks/export-by-card" },
  cancelQueue: { method: "POST", path: "/api/task/:taskId/account/:accountId/cancel-queue" },
} as const;


/**
 * 路径参数形状：上游 task id 是从公开页面观察到的 uuid/短 id，账号 id 是整数。
 * 单独校验再拼路径，任何越界字符（`..`、`/`、空格）都在这里被拒。
 */
const TASK_ID_PATTERN = /^[A-Za-z0-9_-]{6,80}$/;
const ACCOUNT_ID_PATTERN = /^[0-9]{1,18}$/;

export interface PixelUpstreamCardBody {
  card_key: string;
}

export interface PixelUpstreamSubmitBody {
  card_key: string;
  service_type: string;
  accounts_text: string;
}

export interface PixelUpstreamCardQueryBody {
  card_key: string;
  account_query?: string;
}

/**
 * 可发起的上游调用。每种调用对应 allowlist 里的一条，路径参数在这里就是强类型。
 */
export type PixelUpstreamCall =
  | { route: "settings" }
  | { route: "verifyCard"; body: PixelUpstreamCardBody }
  | { route: "submitTask"; body: PixelUpstreamSubmitBody }
  | { route: "task"; taskId: string }
  | { route: "tasksByCard"; body: PixelUpstreamCardQueryBody }
  | { route: "exportByCard"; body: PixelUpstreamCardQueryBody }
  | { route: "cancelQueue"; taskId: string; accountId: number };

export interface PixelUpstreamRequestSpec {
  method: "GET" | "POST";
  path: string;
  body: unknown | undefined;
}

export interface PixelUpstreamHttpRequest {
  method: "GET" | "POST";
  url: string;
  timeoutMs: number;
  headers: Record<string, string>;
  /** 已序列化的 JSON（只存在内存里，绝不写日志）。 */
  body?: string;
}

export interface PixelUpstreamHttpResponse {
  status: number;
  /** 原始响应文本（由适配器解析 JSON，不用 axios 的隐式 JSON 解析）。 */
  bodyText: string;
}

export type PixelUpstreamTransport = (
  request: PixelUpstreamHttpRequest,
) => Promise<PixelUpstreamHttpResponse>;

export interface PixelUpstreamResult {
  status: number;
  /** 解析出的 JSON；非 JSON 或解析失败时为 null。 */
  data: unknown;
  method: string;
  path: string;
  requestBytes: number;
  responseBytes: number;
  durationMs: number;
}

export interface PixelUpstreamClient {
  call(call: PixelUpstreamCall): Promise<PixelUpstreamResult>;
}

export interface PixelUpstreamClientDeps {
  /** 读取生效配置（未配置/已关闭返回 null）。 */
  loadConfig: () => Promise<PixelIntegrationConfig | null>;
  /** 注入点：单测不碰真实网络。 */
  transport?: PixelUpstreamTransport;
  /** 注入点：单测免去 DNS。默认走 ssrfGuard.isTargetPublic。 */
  assertHostPublic?: (host: string) => Promise<boolean>;
}

function routeNotAllowed(): PixelDomainError {
  // 内部错误：出现它说明有人绕过了 allowlist 的类型约束（代码 bug，不是用户输入问题）。
  return new PixelDomainError("请求未被允许。", 500, "PIXEL_ROUTE_NOT_ALLOWED");
}

/**
 * 把调用规格解析成「方法 + 路径 + 请求体」。路径参数越界时 fail-closed 抛错，不做任何修正。
 */
export function resolvePixelUpstreamRequest(call: PixelUpstreamCall): PixelUpstreamRequestSpec {
  switch (call.route) {
    case "settings":
      return { method: PIXEL_UPSTREAM_ROUTES.settings.method, path: PIXEL_UPSTREAM_ROUTES.settings.path, body: undefined };
    case "verifyCard":
      return {
        method: PIXEL_UPSTREAM_ROUTES.verifyCard.method,
        path: PIXEL_UPSTREAM_ROUTES.verifyCard.path,
        body: { card_key: call.body.card_key },
      };
    case "submitTask":
      return {
        method: PIXEL_UPSTREAM_ROUTES.submitTask.method,
        path: PIXEL_UPSTREAM_ROUTES.submitTask.path,
        body: {
          card_key: call.body.card_key,
          service_type: call.body.service_type,
          accounts_text: call.body.accounts_text,
        },
      };
    case "task": {
      const taskId = String(call.taskId ?? "");
      if (!TASK_ID_PATTERN.test(taskId)) throw routeNotAllowed();
      return { method: PIXEL_UPSTREAM_ROUTES.task.method, path: `/api/task/${taskId}`, body: undefined };
    }
    case "tasksByCard":
      return {
        method: PIXEL_UPSTREAM_ROUTES.tasksByCard.method,
        path: PIXEL_UPSTREAM_ROUTES.tasksByCard.path,
        body: { card_key: call.body.card_key, account_query: call.body.account_query ?? "" },
      };
    case "exportByCard":
      return {
        method: PIXEL_UPSTREAM_ROUTES.exportByCard.method,
        path: PIXEL_UPSTREAM_ROUTES.exportByCard.path,
        body: { card_key: call.body.card_key, account_query: call.body.account_query ?? "" },
      };
    case "cancelQueue": {
      const taskId = String(call.taskId ?? "");
      const accountId = String(call.accountId ?? "");
      if (!TASK_ID_PATTERN.test(taskId) || !ACCOUNT_ID_PATTERN.test(accountId)) throw routeNotAllowed();
      return {
        method: PIXEL_UPSTREAM_ROUTES.cancelQueue.method,
        path: `/api/task/${taskId}/account/${accountId}/cancel-queue`,
        body: undefined,
      };
    }
    default:
      // 判别联合穷尽：新增 route 却忘了在这里接上时会走到这里。
      throw routeNotAllowed();
  }
}

/**
 * 默认传输层：axios，`maxRedirects: 0` + `validateStatus: () => true`（自己判 statuscode）。
 * 响应按文本取回再由调用方解析，避免 axios 在 JSON 解析失败时抛出「看起来像业务错误」的异常。
 */
const axiosTransport: PixelUpstreamTransport = async (request) => {
  const response = await axios.request<string>({
    method: request.method,
    url: request.url,
    timeout: request.timeoutMs,
    headers: request.headers,
    data: request.body,
    maxRedirects: 0,
    validateStatus: () => true,
    responseType: "text",
    // 关掉 axios 的隐式 JSON 解析：上游契约是重建出来的草案，解析失败必须是「我们能看见的 null」，
    // 而不是一个混在传输错误里的异常。
    transformResponse: [(data: unknown) => (typeof data === "string" ? data : String(data ?? ""))],
  });
  return { status: response.status, bodyText: String(response.data ?? "") };
};

function isTimeoutError(error: unknown): boolean {
  const code = String((error as { code?: unknown })?.code ?? "");
  if (code === "ECONNABORTED" || code === "ETIMEDOUT" || code === "ERR_CANCELED") return true;
  const message = error instanceof Error ? error.message : "";
  return /timeout/i.test(message);
}

function upstreamUnavailable(status: number, code: string, message: string): PixelDomainError {
  return new PixelDomainError(message, status, code);
}

export function createPixelUpstreamClient(deps: PixelUpstreamClientDeps): PixelUpstreamClient {
  const transport = deps.transport ?? axiosTransport;
  const assertHostPublic = deps.assertHostPublic ?? ((host: string) => isTargetPublic(host));

  return {
    async call(call: PixelUpstreamCall): Promise<PixelUpstreamResult> {
      const config = await deps.loadConfig();
      if (!config) {
        // fail-closed：没有运行时配置（或已被超管关闭）时，一个字节都不发出去，也不回落到任何默认地址。
        throw upstreamUnavailable(503, "PIXEL_UPSTREAM_NOT_CONFIGURED", "该服务当前不可用，请联系管理员。");
      }

      const spec = resolvePixelUpstreamRequest(call);
      let host: string;
      try {
        host = new URL(config.upstreamBaseUrl).hostname.toLowerCase();
      } catch {
        throw upstreamUnavailable(503, "PIXEL_UPSTREAM_NOT_CONFIGURED", "该服务当前不可用，请联系管理员。");
      }
      if (!config.allowedHosts.includes(host)) {
        throw upstreamUnavailable(502, "PIXEL_UPSTREAM_TARGET_BLOCKED", "上游地址不在允许范围内，已拒绝。");
      }
      // DNS rebinding / 内网探测：每次出站都重新解析一次（不缓存），命中私网一律拒绝。
      if (!(await assertHostPublic(host))) {
        throw upstreamUnavailable(502, "PIXEL_UPSTREAM_TARGET_BLOCKED", "上游地址不可访问。");
      }

      const body = spec.body === undefined ? undefined : JSON.stringify(spec.body);
      const headers: Record<string, string> = { accept: "application/json" };
      if (body !== undefined) headers["content-type"] = "application/json";

      const startedAt = Date.now();
      let response: PixelUpstreamHttpResponse;
      try {
        response = await transport({
          method: spec.method,
          url: `${config.upstreamBaseUrl}${spec.path}`,
          timeoutMs: config.requestTimeoutMs,
          headers,
          body,
        });
      } catch (error) {
        // 只记分类与路由名：上游 host、URL、axios 的 message 都可能带上配置细节，不进日志。
        logger.warn("[Pixel] 上游请求失败", {
          route: call.route,
          method: spec.method,
          path: spec.path,
          timedOut: isTimeoutError(error),
          errorName: error instanceof Error ? error.name : "unknown",
        });
        if (isTimeoutError(error)) {
          throw upstreamUnavailable(504, "PIXEL_UPSTREAM_TIMEOUT", "上游响应超时，请稍后重试。");
        }
        throw upstreamUnavailable(502, "PIXEL_UPSTREAM_UNREACHABLE", "上游暂时无法访问，请稍后重试。");
      }

      const durationMs = Date.now() - startedAt;
      const requestBytes = body === undefined ? 0 : Buffer.byteLength(body, "utf8");
      const responseBytes = Buffer.byteLength(response.bodyText, "utf8");

      // 重定向一律不跟：3xx 直接判失败（否则 allowlist 可以被一次 302 绕过）。
      if (response.status >= 300 && response.status < 400) {
        throw upstreamUnavailable(502, "PIXEL_UPSTREAM_TARGET_BLOCKED", "上游返回了重定向，已拒绝跟随。");
      }

      let data: unknown = null;
      const trimmed = response.bodyText.trim();
      if (trimmed) {
        try {
          data = JSON.parse(trimmed);
        } catch {
          // 非 JSON 响应（HTML 错误页等）：data 留 null，由调用方按状态码决定怎么处理。
          data = null;
        }
      }

      return {
        status: response.status,
        data,
        method: spec.method,
        path: spec.path,
        requestBytes,
        responseBytes,
        durationMs,
      };
    },
  };
}

/** 生产单例：配置来自 superadmin 维护的 pixel_integration_configs。 */
export const pixelUpstreamClient = createPixelUpstreamClient({
  loadConfig: loadPixelIntegrationConfig,
});

/**
 * 把上游 HTTP 状态映射成领域错误。
 *
 * 刻意**不**把上游错误正文带出来（PRD 6.1.4）：上游是重建契约，错误体里可能出现邮箱、卡密、
 * 结果链接或 HTML 错误页；所以这里只按状态码分类，文案是我们自己的中文。
 */
export function mapUpstreamFailure(status: number): PixelDomainError {
  // upstreamStatus 放进 details，只用于溯源日志（非敏感整数），不构成实现细节泄漏。
  const context = { upstreamStatus: status };
  if (status === 429) {
    return new PixelDomainError("请求过于频繁，请稍后重试。", 429, "PIXEL_UPSTREAM_RATE_LIMITED", context);
  }
  if (status === 400 || status === 422) {
    return new PixelDomainError("上游拒绝了这次请求，请检查卡密或账号信息后重试。", 400, "PIXEL_UPSTREAM_REJECTED", context);
  }
  if (status === 404) {
    return new PixelDomainError("上游没有找到对应记录。", 404, "PIXEL_UPSTREAM_NOT_FOUND", context);
  }
  if (status >= 500) {
    return new PixelDomainError("上游服务暂时不可用，请稍后重试。", 502, "PIXEL_UPSTREAM_ERROR", context);
  }
  return new PixelDomainError("上游服务暂时不可用，请稍后重试。", 502, "PIXEL_UPSTREAM_ERROR", context);
}

/**
 * 这些失败保证请求**没有送达**上游（上游未配置 / 目标被拒），所以可以安全地让用户用同一个幂等键重试。
 * 其余失败（超时、连接中断）一律当作「结果不确定」，绝不自动重试——上游可能已经扣额。
 */
export function isPixelPreflightFailure(error: unknown): boolean {
  return (
    error instanceof PixelDomainError
    && (error.code === "PIXEL_UPSTREAM_NOT_CONFIGURED" || error.code === "PIXEL_UPSTREAM_TARGET_BLOCKED")
  );
}
