import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { SecurityEvent } from "../models/securityEventModel";
import { getClientIP } from "../utils/ipUtils";
import logger from "../utils/logger";

/**
 * 蜜罐端点 + Tarpit（RC-42 / RC-43 / D19 / D20）。
 *
 * 设计取舍（都已按 owner 裁决实现，不自行发挥）：
 * - **D19**：假响应只回**结构合法但显式无意义**的占位值（`dummy_trap_*`），绝不回看似真实的他人数据
 *  —— 对真的权利请求者（比如真去看 `/api/debug/dump` 的律师）不能构成误导；
 * - **D20**：Tarpit 只对**已确认的蜜罐命中对象**生效，并且有**全局并发硬顶**（默认 20）与
 *   **延时上限**（默认 2 秒观察期）。超顶直接立即断开，不排队等待 —— 否则“拖住攻击者”会先拖死自己
 *  （Node 单进程，每个被拖住的请求都占着一个连接与一个事件循环任务）；
 * - 蜜罐命中是**高置信但不自动封禁**的信号：先写审计/事件 + 告警，自动封禁阈值可配（默认关）。
 *   管理员工具与旧客户端可能访问 `/api/debug/*`，误杀代价远高于收益；
 * - 蜜罐路径**不写 `@swagger`**：写了就会被 `check-openapi-drift` 要求进 `openapi.json`，
 *   而它本就不该出现在文档里。
 */

/** 蜜罐路径：`/api/v1/*` 与 `/api/debug/*` 已核实空闲（不与现有路由冲突）。 */
export const HONEYPOT_PREFIXES = ["/api/v1", "/api/debug"] as const;

export function isHoneypotPath(pathname: string): boolean {
  const value = typeof pathname === "string" ? pathname : "";
  return HONEYPOT_PREFIXES.some((prefix) => value === prefix || value.startsWith(`${prefix}/`));
}

/** D19：结构合法、显式无意义。没有 userId/邮箱/姓名之类可被误读为真实个人信息的字段。 */
function dummyTrapPayload(path: string): Record<string, unknown> {
  const ids = ["dummy_trap_01", "dummy_trap_02", "dummy_trap_03"];
  return {
    status: "ok",
    trap: true,
    note: "This endpoint is a decoy and returns placeholder data only.",
    path,
    nodes: ids.map((id) => ({ id, kind: "placeholder", value: null })),
    generatedAt: new Date(0).toISOString(),
  };
}

/** 单个对象在 Tarpit 里的并发占用（键 = IP 或用户 id）。 */
let activeTarpitConnections = 0;
export const TARPIT_MAX_CONCURRENT = 20;
export const TARPIT_MAX_DELAY_MS = 2_000;
/** 观察期：延时上限 2 秒，且只对蜜罐/黑名单对象生效（D20）。 */
const TARPIT_OBSERVE_MAX_DELAY_MS = 2_000;

export function getActiveTarpitConnections(): number {
  return activeTarpitConnections;
}

/** 记录一次蜜罐命中（事件 + 告警日志）。不在这里做处罚：阈值策略由调用方/配置决定。 */
function recordHoneypotHit(req: Request, kind: string): void {
  const ip = getClientIP(req);
  const user = (req as Request & { user?: { id?: string } }).user;
  void SecurityEvent.create({
    deviceFingerprint: String(req.headers["x-device-id"] || "honeypot").slice(0, 128),
    userId: user?.id,
    eventType: "HONEYPOT_HIT",
    eventData: {
      kind,
      path: req.originalUrl || req.path,
      method: req.method,
      userAgent: String(req.headers["user-agent"] || "").slice(0, 512),
    },
    // 高置信恶意信号：给高分但不直接封禁（管理员工具/旧客户端也可能误入）。
    riskScore: 80,
    ipAddress: ip || "",
    userAgent: String(req.headers["user-agent"] || "").slice(0, 512),
    createdAt: new Date(),
  }).catch((error) => {
    logger.warn("[Honeypot] 命中事件写入失败", {
      error: error instanceof Error ? error.message : String(error),
    });
  });

  logger.error("[Honeypot] 蜜罐端点被访问（高置信恶意信号，需人工复核）", {
    kind,
    ip,
    path: req.originalUrl || req.path,
  });
}

/**
 * Tarpit：随机延时（异步计时器），只对已确认对象生效，带全局并发硬顶。
 *
 * 关键实现点：延时**必须 await**，绝不能用同步阻塞 —— 同步 sleep 会让整个进程停摆，
 * 那是“对攻击者零成本、对平台高成本”的交换，与初衷相反。超顶时立即放行（不排队）。
 */
export async function tarpit(req: Request, next: NextFunction): Promise<void> {
  if (activeTarpitConnections >= TARPIT_MAX_CONCURRENT) {
    // 超顶直接放行：宁可不拖，也不能把自己拖死（连接与事件循环都是稀缺资源）。
    logger.warn("[Tarpit] 并发已到硬顶，本次跳过延时", { active: activeTarpitConnections });
    next();
    return;
  }

  activeTarpitConnections += 1;
  try {
    const delayMs = Math.floor(crypto.randomInt(200, TARPIT_OBSERVE_MAX_DELAY_MS));
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    next();
  } finally {
    activeTarpitConnections -= 1;
  }
}

/**
 * 蜜罐中间件：命中即记事件 + （可选）Tarpit 延时 + 回 D19 占位数据。
 *
 * 返回 200 + 假数据（而不是 404）：脚本扫到 404 会换路径继续扫，拿到 200 才会在这条路径上继续花时间。
 */
export async function honeypotMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!isHoneypotPath(req.path || req.url || "")) {
    next();
    return;
  }

  recordHoneypotHit(req, "path_prefix");
  await tarpit(req, () => undefined);
  res.status(200).json(dummyTrapPayload(req.path || req.url || ""));
}

/** 供用例/排查使用：占位响应体生成（不涉及任何真实数据）。 */
export function buildHoneypotResponseBody(path: string): Record<string, unknown> {
  return dummyTrapPayload(path);
}

/** 导出常量以便测试与运维核对（延时上限与并发硬顶必须与文档一致）。 */
export const TARPIT_LIMITS = {
  maxConcurrent: TARPIT_MAX_CONCURRENT,
  maxDelayMs: TARPIT_MAX_DELAY_MS,
  observeMaxDelayMs: TARPIT_OBSERVE_MAX_DELAY_MS,
};

void TARPIT_LIMITS;
