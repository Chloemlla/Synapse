import type { Request } from "express";
import { createBurstConcurrencyGuard, createLimiter } from "./routeLimiters";

// Website sessions never inherit Android install/signature or privileged/local rate exemptions.
const noExemption = () => false;
const userKey = (req: Request): string => `user:${req.user?.id || "unknown"}`;

export const cdictWebIngressLimiter = createLimiter({
  name: "cdict-web-ingress", profile: "relaxed", max: 120, skip: noExemption,
});
export const cdictWebUpstreamIpLimiter = createLimiter({
  name: "cdict-web-upstream-ip", profile: "relaxed", max: 60, skip: noExemption,
});
export const cdictWebUpstreamUserLimiter = createLimiter({
  name: "cdict-web-upstream-user", profile: "standard", max: 30,
  keyGenerator: userKey, skip: noExemption, anonymousFingerprint: false,
});
export const cdictWebClaimLimiter = createLimiter({
  name: "cdict-web-claim", windowMs: 60 * 60_000, max: 10,
  keyGenerator: userKey, skip: noExemption, anonymousFingerprint: false,
});

// Separate account/IP buckets, not user|IP; GET speech also spends upstream credentials.
export const cdictWebUpstreamUserBurstGuard = createBurstConcurrencyGuard({
  name: "cdict-web-upstream-user-burst", maxConcurrent: 3, skipLocal: false, methods: ["POST", "GET", "HEAD"],
  keyGenerator: userKey,
});
export const cdictWebUpstreamIpBurstGuard = createBurstConcurrencyGuard({
  name: "cdict-web-upstream-ip-burst", maxConcurrent: 6, skipLocal: false, methods: ["POST", "GET", "HEAD"],
  keyGenerator: (req) => `ip:${req.ip || req.socket?.remoteAddress || "unknown"}`,
});
export const cdictWebUpstreamGlobalBurstGuard = createBurstConcurrencyGuard({
  name: "cdict-web-upstream-global-burst", maxConcurrent: 24, skipLocal: false, methods: ["POST", "GET", "HEAD"],
  keyGenerator: () => "global",
});
