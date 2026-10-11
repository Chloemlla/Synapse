import type { Request } from "express";
import type { AccountRiskTier } from "./accountRiskScoring";
import { getClientIP } from "./ipUtils";
import { isTrustedProxyPeer } from "./trustProxy";

/**
 * 请求级**服务端风控上下文**（RC-55）。
 *
 * 问题：风控要用的「这一次请求是谁、用什么设备、哪个 IP、账户什么档位、step-up 状态」
 * 此前散在 `req.user` / `req.ip` / 各自的一次 Mongo 查询里。于是
 * （a）同一请求里两个闸门可能读到不一致的 IP 判定；
 * （b）每加一个闸门就多一次 `getAccountRiskState`；
 * （c）出事后无法回答「当时这次请求用的是什么上下文」。
 *
 * 本模块把这三件事收口：
 * - 上下文在**请求期内存**里缓存（挂在 req 上，不落库、不出请求作用域）；
 * - 同一个请求内**只读一次**账户风险状态（多个闸门共享同一个上下文）；
 * - `ip.trusted` 显式标出「这个地址是否来自可信代理」——回退到客户端可伪造头部时
 *   必须为 false，后续闸门据此**只记信号、不做处罚**（与 RC-25 同口径）。
 *
 * 刻意不做的事：不在这里查属地、不在这里做外呼 —— 上下文只装「已经有的事实」。
 */

const CONTEXT_KEY = Symbol.for("synapse.requestRiskContext");

export interface RequestRiskContext {
  userId: string;
  riskTier: AccountRiskTier;
  /** 账户是否已软删除（RC-01）：已删除的账号按“不可用”处理，与匿名同路。 */
  accountDeleted: boolean;
  stepUp: {
    required: boolean;
    mode: "sensitive" | "all-writes" | "all";
    until: number;
  };
  ip: {
    address: string;
    /** false = 这个地址来自可伪造的回退路径，只能当信号用。 */
    trusted: boolean;
  };
  device: {
    fingerprint: string;
    userAgent: string;
  };
  /** 读取时刻（ms）：便于事后判断“当时的档位是什么时候算出来的”。 */
  builtAt: number;
}

export interface AccountRiskStateLike {
  id?: string;
  riskTier?: AccountRiskTier;
  stepUpMode?: "sensitive" | "all-writes" | "all";
  stepUpUntil?: number;
  role?: string;
  deletedAt?: number;
}

export function buildRequestRiskContext(input: {
  userId: string;
  state: AccountRiskStateLike | null;
  ipAddress: string;
  ipTrusted: boolean;
  fingerprint?: string;
  userAgent?: string;
  now?: number;
}): RequestRiskContext {
  const tier: AccountRiskTier = input.state?.riskTier ?? "normal";
  const until = input.state?.stepUpUntil ?? 0;
  const now = input.now ?? Date.now();
  return {
    userId: input.userId,
    riskTier: tier,
    accountDeleted: typeof input.state?.deletedAt === "number" && input.state.deletedAt > 0,
    stepUp: {
      // 「需不需要逐步验证」是档位 + 时间窗的纯函数，放在上下文里一次算好。
      required: (tier === "restricted" || tier === "danger") && until > now,
      mode: input.state?.stepUpMode ?? "sensitive",
      until,
    },
    ip: { address: input.ipAddress || "", trusted: input.ipTrusted },
    device: { fingerprint: input.fingerprint || "", userAgent: input.userAgent || "" },
    builtAt: now,
  };
}

/** 取已构建的上下文（不存在则返回 null）。 */
export function getRequestRiskContext(req: Request): RequestRiskContext | null {
  return ((req as Request & { [CONTEXT_KEY]?: RequestRiskContext })[CONTEXT_KEY] ?? null) as RequestRiskContext | null;
}

/**
 * 取或构建上下文。`loadState` 只在第一次调用时执行 —— 同一请求内多个闸门共享结果，
 * 这正是「新增闸门不再新增查库」的落点。
 */
export async function getOrCreateRequestRiskContext(
  req: Request,
  loadState: (userId: string) => Promise<AccountRiskStateLike | null>,
): Promise<RequestRiskContext | null> {
  const existing = getRequestRiskContext(req);
  if (existing) return existing;

  const user = (req as Request & { user?: { id?: string } }).user;
  const userId = typeof user?.id === "string" ? user.id : "";
  if (!userId) return null;

  const state = await loadState(userId).catch(() => null);
  const context = buildRequestRiskContext({
    userId,
    state,
    ipAddress: getClientIP(req),
    // 可信性取自 TCP 对端是否命中 TRUST_PROXY 声明（与真实 IP 解析同一份判定）。
    ipTrusted: isTrustedProxyPeer(req.socket?.remoteAddress),
    fingerprint: typeof req.headers["x-device-id"] === "string" ? req.headers["x-device-id"] : "",
    userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : "",
  });

  (req as Request & { [CONTEXT_KEY]?: RequestRiskContext })[CONTEXT_KEY] = context;
  return context;
}

/** 供测试与排查：把上下文挂到 req 上（不改变生产语义）。 */
export function setRequestRiskContextForTests(req: Request, context: RequestRiskContext): void {
  (req as Request & { [CONTEXT_KEY]?: RequestRiskContext })[CONTEXT_KEY] = context;
}
