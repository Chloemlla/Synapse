import crypto from "node:crypto";
import { config } from "../config/config";
import { StepUpChallenge, type IStepUpChallenge } from "../models/stepUpChallengeModel";
import { StepUpGrant } from "../models/stepUpGrantModel";
import logger from "../utils/logger";
import { stableStringify } from "../utils/routeKey";
import { mongoose } from "./mongoService";

/**
 * 逐步验证（step-up）的服务层 —— RC-02 / RC-03 / RC-45 / RC-46 / RC-54。
 *
 * 两层令牌，职责严格分离：
 * - **challenge**（一次性，TTL 默认 120s）：证明“人机验证/工作量证明刚做过”；
 *   它绑定 `(userId, routeKey, payloadHash)`，兑换即作废（`consumedAt`）。
 * - **grant**（短窗多人次，TTL 默认 30s，次数 ≤ 5）：只服务“用户已经发起、且已经看到弹窗”
 *   的那一批并发请求。它不是“验证一次免 30 秒”：`allowedRouteKeys` 来自服务端验签票据，
 *   `remainingUses` 严格等于合法票据数，前端队列排空即主动丢弃。
 *
 * 重放保护不另建 nonce 台账（RC-54.4）：challenge 的 `challengeId` 唯一 + 原子消费
 * 等价于“nonce 只用一次”，而且**多实例下正确** —— 进程内 nonce Set 在多实例部署里
 * 会被另一个实例放行。
 *
 * 术语纠正（RC-36）：需求原文的“哈希碰撞”不成立。工作量证明是 **hashcash 式前像难度**
 * （找 nonce 使 `sha256(seed:nonce)` 的前 N 个**比特**为 0），碰撞是找两个同摘要的不同输入，
 * 无法用作证明。
 */

function mongoReady(): boolean {
  return mongoose.connection.readyState === 1;
}

function readStepUpSecret(): string {
  // 用 JWT 主密钥做 HMAC 域分离：票据只在服务端签发/校验，客户端永远拿不到密钥。
  return `${config.jwtSecret || process.env.JWT_SECRET || "step-up-dev-secret"}|step-up-ticket`;
}

/** 请求体摘要（RC-03 的 `payloadHash`）：稳定序列化后取 sha256 前 32 位十六进制。 */
export function computePayloadHash(body: unknown): string {
  return crypto.createHash("sha256").update(stableStringify(body ?? null)).digest("hex").slice(0, 32);
}

export interface ChallengeTicketPayload {
  challengeId: string;
  userId: string;
  routeKey: string;
  issuedAt: number;
}

function ticketSigningInput(payload: ChallengeTicketPayload): string {
  return `${payload.challengeId}|${payload.userId}|${payload.routeKey}|${payload.issuedAt}`;
}

/**
 * 服务端 HMAC 签名的挑战票据（RC-46 补遗）。
 *
 * 为什么必须签名：原设计让客户端在兑换 grant 时**自行上报** `routeKeys[]`，
 * 于是任何人都能声称“我想过 /api/command 和 /api/admin/env”来骗取高危路由的短效通行证，
 * 也能虚报数量把 grant 放大成批量发射器。签名后服务端只认票据里的内容。
 */
export function signChallengeTicket(payload: ChallengeTicketPayload): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = crypto.createHmac("sha256", readStepUpSecret()).update(body).digest("base64url");
  return `${body}.${signature}`;
}

export function verifyChallengeTicket(
  ticket: unknown,
  options: { now?: number; maxAgeMs?: number } = {},
): ChallengeTicketPayload | null {
  if (typeof ticket !== "string" || !ticket.includes(".")) return null;
  const [body, signature] = ticket.split(".");
  if (!body || !signature) return null;

  const expected = crypto.createHmac("sha256", readStepUpSecret()).update(body).digest("base64url");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  const challengeId = typeof record.challengeId === "string" ? record.challengeId : "";
  const userId = typeof record.userId === "string" ? record.userId : "";
  const routeKey = typeof record.routeKey === "string" ? record.routeKey : "";
  const issuedAt = typeof record.issuedAt === "number" ? record.issuedAt : Number.NaN;
  if (!challengeId || !userId || !routeKey || !Number.isFinite(issuedAt)) return null;

  const now = options.now ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? config.accountRisk.stepUpChallengeTtlSeconds * 1000;
  // 票据自身也有时效：防止“批量收集票据 → 一次性兑一大枚 grant”。
  if (issuedAt > now + 5_000 || now - issuedAt > maxAgeMs) return null;

  return { challengeId, userId, routeKey, issuedAt };
}

export interface StepUpChallengeResult {
  challengeId: string;
  ticket: string;
  expiresAt: number;
  type: "captcha" | "pow";
  pow?: { seed: string; difficulty: number };
}

/**
 * 签发一枚单次挑战。
 *
 * 同一请求被重复拦截时会签出不同的 `challengeId`，这是**有意**的：grant 层负责
 * 把“一次验证”折算成“这批请求都能过”（RC-46），而不是让挑战本身可复用。
 */
export async function issueStepUpChallenge(params: {
  userId: string;
  riskTier: string;
  routeKey: string;
  payloadHash: string;
  provider: string;
  type?: "captcha" | "pow";
  powDifficulty?: number;
  ipAddress?: string;
  fingerprint?: string;
}): Promise<StepUpChallengeResult | null> {
  if (!mongoReady()) return null;

  const now = Date.now();
  const ttlMs = Math.max(30, config.accountRisk.stepUpChallengeTtlSeconds) * 1000;
  const challengeId = `sc_${crypto.randomBytes(16).toString("hex")}`;
  const type = params.type ?? "captcha";
  const powSeed = type === "pow" ? crypto.randomBytes(16).toString("hex") : undefined;

  try {
    await StepUpChallenge.create({
      challengeId,
      userId: params.userId,
      riskTier: params.riskTier,
      routeKey: params.routeKey,
      payloadHash: params.payloadHash,
      provider: params.provider,
      type,
      powDifficulty: type === "pow" ? Math.max(8, params.powDifficulty ?? DEFAULT_POW_DIFFICULTY) : undefined,
      powSeed,
      ipAddress: params.ipAddress || "",
      fingerprint: params.fingerprint || "",
      issuedAt: new Date(now),
      expiresAt: new Date(now + ttlMs),
      consumedAt: null,
    });
  } catch (error) {
    logger.warn("[StepUp] 挑战签发失败", {
      userId: params.userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  return {
    challengeId,
    ticket: signChallengeTicket({ challengeId, userId: params.userId, routeKey: params.routeKey, issuedAt: now }),
    expiresAt: now + ttlMs,
    type,
    pow: type === "pow" && powSeed ? { seed: powSeed, difficulty: Math.max(8, params.powDifficulty ?? DEFAULT_POW_DIFFICULTY) } : undefined,
  };
}

export const DEFAULT_POW_DIFFICULTY = 16;
export const MIN_POW_DIFFICULTY = 12;
export const MAX_POW_DIFFICULTY = 24;

/** 目标耗时区间（毫秒）：低于下限加难度，高于上限降难度（RC-36.2）。 */
export const POW_TARGET_MIN_MS = 1_500;
export const POW_TARGET_MAX_MS = 6_000;

/**
 * 纯函数：按客户端实测耗时自适应难度。
 *
 * 为什么必须自适应：移动端与桌面端 CPU 差 10 倍以上，固定难度会让低端机等 20 秒
 *（比风控本身更伤用户）。每次只挪 2 比特，避免难度振荡。
 */
export function nextPowDifficulty(current: unknown, elapsedMs: unknown): number {
  const base =
    typeof current === "number" && Number.isFinite(current)
      ? Math.min(MAX_POW_DIFFICULTY, Math.max(MIN_POW_DIFFICULTY, Math.round(current)))
      : DEFAULT_POW_DIFFICULTY;
  if (typeof elapsedMs !== "number" || !Number.isFinite(elapsedMs) || elapsedMs <= 0) return base;
  if (elapsedMs < POW_TARGET_MIN_MS) return Math.min(MAX_POW_DIFFICULTY, base + 2);
  if (elapsedMs > POW_TARGET_MAX_MS) return Math.max(MIN_POW_DIFFICULTY, base - 2);
  return base;
}

/** 哈希前导零**比特**数（不是“碰撞”，见文件头说明）。 */
export function leadingZeroBits(buffer: Buffer): number {
  let bits = 0;
  for (const byte of buffer) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    bits += Math.clz32(byte) - 24;
    break;
  }
  return bits;
}

export function verifyPowSolution(seed: unknown, nonce: unknown, difficulty: unknown): boolean {
  if (typeof seed !== "string" || !seed) return false;
  if (typeof nonce !== "string" || !nonce || nonce.length > 64) return false;
  const target =
    typeof difficulty === "number" && Number.isFinite(difficulty) ? Math.round(difficulty) : DEFAULT_POW_DIFFICULTY;
  const digest = crypto.createHash("sha256").update(`${seed}:${nonce}`).digest();
  return leadingZeroBits(digest) >= target;
}

/**
 * 原子消费一枚挑战（`consumedAt` 由 null → now）。并发下只有一个调用成功（RC-03）。
 * 同时校验 userId（防跨越账户复用）与过期时间（TTL 由数据库后台清理，存在竞态窗口）。
 */
export async function consumeStepUpChallenge(params: {
  userId: string;
  challengeId: string;
  now?: number;
}): Promise<IStepUpChallenge | null> {
  if (!mongoReady()) return null;
  const now = params.now ?? Date.now();
  const doc = (await StepUpChallenge.findOneAndUpdate(
    {
      challengeId: params.challengeId,
      userId: params.userId,
      consumedAt: null,
      expiresAt: { $gt: new Date(now) },
    },
    { $set: { consumedAt: new Date(now) } },
    { returnDocument: "after" },
  ).lean()) as IStepUpChallenge | null;
  return doc ?? null;
}

export interface StepUpGrantResult {
  grantId: string;
  remainingUses: number;
  expiresAt: number;
  routeKeys: string[];
}

/**
 * 用一批**服务端签名票据**兑换一枚 grant（RC-46 / D22）。
 *
 * 关键约束：
 * - `remainingUses` 严格等于**合法票据数**（上限 `stepUpGrantMaxUses`，D22 = 5），
 *   客户端无法虚报次数；
 * - `allowedRouteKeys` 由票据推导，客户端上传的 `routeKeys` 一律忽略；
 * - 每张票对应的挑战在此**原子消费**，同一张票不能兑两次。
 */
export async function createStepUpGrant(params: {
  userId: string;
  tickets: unknown;
  /** PoW 类型的挑战用它解题（RC-36/RC-54）；captcha 类型不需要。 */
  powNonce?: unknown;
  ipAddress?: string;
  fingerprint?: string;
}): Promise<StepUpGrantResult | { error: string }> {
  if (!mongoReady()) return { error: "服务暂时不可用" };

  const rawTickets = Array.isArray(params.tickets) ? params.tickets : [];
  if (rawTickets.length === 0) return { error: "缺少挑战票据" };

  const maxUses = Math.max(1, Math.min(5, config.accountRisk.stepUpGrantMaxUses));
  const routeKeys = new Set<string>();
  let valid = 0;
  let powSeen = 0;

  for (const raw of rawTickets.slice(0, maxUses * 2)) {
    const payload = verifyChallengeTicket(raw);
    if (!payload || payload.userId !== params.userId) continue;
    const consumed = await consumeStepUpChallenge({
      userId: params.userId,
      challengeId: payload.challengeId,
    });
    if (!consumed) continue;
    // 票据里的 routeKey 与落库的挑战必须一致（防“签一张、换一张”）。
    if (consumed.routeKey !== payload.routeKey) continue;
    if (consumed.type === "pow") {
      // 我们自己签发的 PoW：必须提交正确的 nonce（每张票一个 seed）。
      // 批量请求走 captcha 路线；PoW 路线是为单请求的低端设备准备的。
      powSeen += 1;
      if (!verifyPowSolution(consumed.powSeed, params.powNonce, consumed.powDifficulty)) continue;
    }
    routeKeys.add(payload.routeKey);
    valid += 1;
    if (valid >= maxUses) break;
  }

  if (valid === 0) {
    return { error: powSeen > 0 ? "工作量证明校验未通过" : "挑战票据无效或已使用" };
  }

  const now = Date.now();
  const ttlMs = Math.max(5, config.accountRisk.stepUpGrantTtlSeconds) * 1000;
  const grantId = `sg_${crypto.randomBytes(16).toString("hex")}`;

  await StepUpGrant.create({
    grantId,
    userId: params.userId,
    allowedRouteKeys: [...routeKeys],
    usedPayloadHashes: [],
    remainingUses: valid,
    maxUses: valid,
    ipAddress: params.ipAddress || "",
    fingerprint: params.fingerprint || "",
    issuedAt: new Date(now),
    expiresAt: new Date(now + ttlMs),
  });

  return { grantId, remainingUses: valid, expiresAt: now + ttlMs, routeKeys: [...routeKeys] };
}

/**
 * 兑换一次 grant 使用额度（原子）。
 *
 * 「先消费后转发」：`findOneAndUpdate` 一次性完成
 * 「路由在允许集内 + 未过期 + 还有次数 + 该 payloadHash 没用过」的判定与扣减，
 * 失败即拒绝 —— 避免 TOCTOU（仓库已有同类教训，见 `softDeleteRecord` 的 owner-in-filter 注释）。
 *
 * 请求体摘要由**服务端重算**：客户端上报的摘要不可信，也不需要它上报。
 */
export async function redeemStepUpGrant(params: {
  grantId: unknown;
  userId: string;
  routeKey: string;
  payloadHash: string;
  now?: number;
}): Promise<boolean> {
  if (typeof params.grantId !== "string" || !params.grantId) return false;
  if (!mongoReady()) return false;
  const now = params.now ?? Date.now();

  const updated = await StepUpGrant.findOneAndUpdate(
    {
      grantId: params.grantId,
      userId: params.userId,
      expiresAt: { $gt: new Date(now) },
      remainingUses: { $gt: 0 },
      allowedRouteKeys: params.routeKey,
      usedPayloadHashes: { $ne: params.payloadHash },
    },
    { $inc: { remainingUses: -1 }, $addToSet: { usedPayloadHashes: params.payloadHash } },
    { returnDocument: "after" },
  ).lean();

  return updated !== null;
}

/** 前端队列排空后主动作废，别让 grant 白挂到过期（RC-46 补遗）。 */
export async function discardStepUpGrant(grantId: unknown, userId: string): Promise<void> {
  if (typeof grantId !== "string" || !grantId || !mongoReady()) return;
  await StepUpGrant.deleteOne({ grantId, userId }).exec();
}
