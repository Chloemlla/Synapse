import crypto from "node:crypto";
import { Entitlement, type EntitlementTier, type EntitlementStatus } from "../../models/lumen/index.js";
import { lumenConfig } from "../../config/lumen.js";
import { ApiError } from "./errors.js";
import logger from "../../utils/logger.js";

// ── Tier rank ──────────────────────────────────────────────────────────
export const TIER_RANK: Record<string, number> = {
  FREE: 0,
  PRO: 1,
  PLUS: 2,
  TEAM: 3,
  DEVELOPER: 4,
};

function resolveTierRank(tier: string): number {
  return TIER_RANK[tier] ?? 0;
}

/**
 * Map a product ID to its entitlement tier.
 * Uses substring matching, matching the Rust backend's `contains()` logic.
 * Unregistered product IDs resolve to FREE (never an elevated tier) and are
 * logged so unknown IDs are visible to operators.
 */
function tierForProduct(productId: string): EntitlementTier {
  const lower = productId.toLowerCase();
  if (lower.includes("team")) return "TEAM";
  if (lower.includes("plus") || lower.includes("monthly") || lower.includes("yearly")) return "PLUS";
  if (lower.includes("pro")) return "PRO";
  logger.warn("[Lumen Entitlements] Unrecognized product ID resolved to FREE tier", { productId });
  return "FREE";
}

/**
 * Given a list of entitlements, resolve the highest active, non-expired tier.
 * Matches the Rust backend's expiry check: expiresAt <= 0 means no expiry.
 */
function resolveActiveTier(
  entitlements: Array<{ tier: string; status: string; expiresAt?: number }>,
  now: number = Date.now(),
): EntitlementTier {
  let highest: EntitlementTier = "FREE";
  let highestRank = 0;

  for (const e of entitlements) {
    if (e.status !== "active") continue;
    // Expired if expiresAt > 0 and expiresAt <= now.
    if (e.expiresAt && e.expiresAt > 0 && e.expiresAt <= now) continue;
    const rank = resolveTierRank(e.tier);
    if (rank > highestRank) {
      highestRank = rank;
      highest = e.tier as EntitlementTier;
    }
  }

  return highest;
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * List all entitlements for a user, sorted by purchasedAt descending.
 * Returns the resolved active tier and the entitlement records.
 */
export async function listEntitlements(userId: string) {
  const now = Date.now();
  const entitlements = await Entitlement.find({ userId })
    .sort({ purchasedAt: -1 })
    .lean()
    .exec();

  const tier = resolveActiveTier(entitlements, now);

  return {
    tier,
    syncedAt: now,
    entitlements: entitlements.map((e) => ({
      id: e._id,
      source: e.source,
      productId: e.productId,
      tier: e.tier,
      status: e.status,
      purchasedAt: e.purchasedAt,
      expiresAt: e.expiresAt,
      lastVerifiedAt: e.lastVerifiedAt,
    })),
  };
}

/**
 * Check if a user has an active entitlement at or above the required tier.
 */
export async function userHasTierAtLeast(userId: string, requiredTier: string): Promise<boolean> {
  const requiredRank = resolveTierRank(requiredTier);
  if (requiredRank <= 0) return true; // FREE is always satisfied.

  const entitlements = await Entitlement.find({
    userId,
    status: "active",
  })
    .lean()
    .exec();

  const highest = resolveActiveTier(entitlements);
  return resolveTierRank(highest) >= requiredRank;
}

/**
 * Verify a Google Play purchase.
 *
 * NOTE (G7-04): this does not yet call the Google Play Developer API. The
 * `acceptUnverifiedPurchases` switch is intentionally read from config only —
 * callers cannot override it — so an unverified purchase can never become
 * "active" unless an operator explicitly enables the escape hatch. Purchase
 * New purchase records use a deterministic primary key, so idempotency also
 * holds on legacy databases whose purchaseToken index has not been built yet.
 */
export async function verifyGooglePurchase(
  userId: string,
  productId: string,
  purchaseToken: string,
  deviceInstallationId?: string,
) {
  const accept = lumenConfig.acceptUnverifiedPurchases;
  const now = Date.now();

  const tier = tierForProduct(productId);
  const status: EntitlementStatus = accept ? "active" : "pending";

  // purchaseToken 来自请求体：必须先确认是字符串，否则对象（如 {"$ne": null}）会被当成
  // Mongoose 过滤条件注入（NoSQL）。$eq 再兜一层，保证按字面值做等值匹配。
  if (typeof purchaseToken !== "string" || purchaseToken.length === 0 || purchaseToken.length > 4096) {
    throw new TypeError("purchaseToken must be a non-empty string");
  }
  // Idempotency: the same purchase token must not create unbounded duplicate
  // entitlement records. (A unique index on purchaseToken is the hard guard.)
  const existing = await Entitlement.findOne({ purchaseToken: { $eq: purchaseToken } }).lean().exec();
  if (existing) {
    // 只记短指纹：完整 purchaseToken 是可向 Google 校验/消耗的凭据，且重复提交流程攻击者可控。
    logger.info("[Lumen Entitlements] Duplicate purchase token rejected", {
      userId,
      productId,
      purchaseTokenHash: crypto.createHash("sha256").update(purchaseToken).digest("hex").slice(0, 16),
    });
    return {
      status: existing.status as EntitlementStatus,
      tier: existing.status === "active" ? existing.tier as EntitlementTier : "FREE",
      verifiedAt: now,
      entitlement: {
        id: existing._id,
        source: existing.source,
        productId: existing.productId,
        tier: existing.tier,
        status: existing.status,
        purchasedAt: existing.purchasedAt,
        expiresAt: existing.expiresAt,
      },
    };
  }

  const entitlement = await Entitlement.create({
    _id: `purchase_${crypto.createHash("sha256").update(purchaseToken).digest("hex")}`,
    userId,
    source: "google_play",
    productId,
    purchaseToken,
    tier,
    status,
    purchasedAt: now,
    expiresAt: 0, // 0 = no expiry; Rust default
    lastVerifiedAt: now,
    rawPayloadJson: JSON.stringify({
      deviceInstallationId,
      acceptUnverified: accept,
    }),
  }).catch(async (error: unknown) => {
    if ((error as { code?: number })?.code !== 11000) throw error;
    // A concurrent retry won the insert. Only suppress a duplicate for this token.
    const winner = await Entitlement.findOne({ purchaseToken }).lean().exec();
    if (!winner) throw error;
    return winner;
  });

  logger.info("[Lumen Entitlements] Purchase recorded", {
    userId,
    productId,
    tier,
    status,
    acceptUnverified: accept,
  });

  return {
    status: entitlement.status,
    tier: entitlement.status === "active" ? entitlement.tier : "FREE",
    verifiedAt: now,
    entitlement: {
      id: entitlement._id,
      source: entitlement.source,
      productId: entitlement.productId,
      tier: entitlement.tier,
      status: entitlement.status,
      purchasedAt: entitlement.purchasedAt,
      expiresAt: entitlement.expiresAt,
    },
  };
}

export { tierForProduct, resolveActiveTier, resolveTierRank, resolveTierRank as tierRank };
