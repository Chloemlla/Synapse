import { describe, expect, it } from "@jest/globals";
import type { Request } from "express";

/**
 * step-up 的**纯判据**回归（RC-03 / RC-45 / RC-46 / RC-54）。
 *
 * 这里只覆盖不碰 Mongo 的部分：routeKey 归一化、请求体摘要、票据 HMAC 往返与防篡改、
 * PoW 前像难度（术语纠正：不是“碰撞”）、以及闸门的纯谓词。
 * 需要数据库的部分（挑战原子消费、grant 次数扣减）由集成测试覆盖。
 */

import {
  computePayloadHash,
  leadingZeroBits,
  nextPowDifficulty,
  signChallengeTicket,
  verifyChallengeTicket,
  verifyPowSolution,
  DEFAULT_POW_DIFFICULTY,
  MAX_POW_DIFFICULTY,
  MIN_POW_DIFFICULTY,
} from "../services/stepUpService";
import { stableStringify } from "../utils/routeKey";
import {
  isInteractiveUnsupported,
  isStepUpBypassPath,
  stepUpRequiredForMethod,
} from "../middleware/accountStepUpGuard";

function fakeRequest(headers: Record<string, string>, method = "GET", path = "/api/user/me"): Request {
  return {
    method,
    path,
    headers,
    get(name: string) {
      return headers[name.toLowerCase()];
    },
  } as unknown as Request;
}

describe("routeKey 归一化（RC-45）", () => {
  it("纯数字 / ObjectId / 带连字 UUID / CUID 都折叠成 :id", async () => {
    const { normalizeRouteKey, DYNAMIC_SEGMENT_PLACEHOLDER } = await import("../utils/routeKey");
    const id = DYNAMIC_SEGMENT_PLACEHOLDER;
    expect(normalizeRouteKey("/api", "/resources/12345")).toBe(`/api/resources/${id}`);
    expect(normalizeRouteKey("/api", "/resources/507f1f77bcf86cd799439011")).toBe(`/api/resources/${id}`);
    expect(normalizeRouteKey("/api", "/resources/507F1F77BCF86CD799439011")).toBe(`/api/resources/${id}`);
    expect(normalizeRouteKey("/api", "/resources/3f2504e0-4f89-11d3-9a0c-0305e82c3301")).toBe(`/api/resources/${id}`);
    expect(normalizeRouteKey("/api", "/resources/cjld2ksy30000qzrm8n8z4b1h")).toBe(`/api/resources/${id}`);
  });

  it("同一路由不同 id → 同一 routeKey；不同路由 → 不同 routeKey", async () => {
    const { normalizeRouteKey } = await import("../utils/routeKey");
    expect(normalizeRouteKey("/api", "/resources/a1b2c3d4e5f6a7b8c9d0e1f2")).toBe(
      normalizeRouteKey("/api", "/resources/f2e1d0c9b8a7f6e5d4c3b2a1"),
    );
    expect(normalizeRouteKey("/api", "/user/me")).not.toBe(normalizeRouteKey("/api", "/user/keys"));
  });

  it("多余斜杠、query、尾斜杠都归一到同一键", async () => {
    const { normalizeRouteKey } = await import("../utils/routeKey");
    const expected = "/api/resources/:id";
    expect(normalizeRouteKey("/api//", "//resources/42/")).toBe(expected);
    expect(normalizeRouteKey("/api", "/resources/42?foo=bar&baz=1")).toBe(expected);
    expect(normalizeRouteKey("/api", "/resources/42#frag")).toBe(expected);
  });

  it("URL 里的 %2F 不当作路径分隔符（否则 a%2Fb 与 a/b 会被折成同一个键）", async () => {
    const { normalizeRouteKey } = await import("../utils/routeKey");
    expect(normalizeRouteKey("/api", "/files/a%2Fb")).toBe("/api/files/a%2Fb");
    expect(normalizeRouteKey("/api", "/files/a%2Fb")).not.toBe(normalizeRouteKey("/api", "/files/a/b"));
  });

  it("非 id 形状的段保持原样（宁可窄，也不过度通配）", async () => {
    const { normalizeRouteKey } = await import("../utils/routeKey");
    expect(normalizeRouteKey("/api", "/export.json")).toBe("/api/export.json");
    expect(normalizeRouteKey("/api", "/tools/v1/export.json")).toBe("/api/tools/v1/export.json");
    expect(normalizeRouteKey("/api", "/a/b-c_d")).toBe("/api/a/b-c_d");
  });

  it("baseUrl + path 两种拼接方式结果一致（应用级 / 路由级中间件）", async () => {
    const { normalizeRouteKey, routeKeyFromRequest } = await import("../utils/routeKey");
    const expected = normalizeRouteKey("/api/resources", "/42");
    expect(routeKeyFromRequest({ baseUrl: "/api", path: "/resources/42" })).toBe(expected);
    expect(routeKeyFromRequest({ baseUrl: "", path: "/api/resources/42" })).toBe(expected);
  });
});

describe("请求体摘要（RC-03 payloadHash）", () => {
  it("键顺序不同但语义相同 → 同一摘要", () => {
    expect(computePayloadHash({ a: 1, b: [1, 2] })).toBe(computePayloadHash({ b: [1, 2], a: 1 }));
  });

  it("内容不同 → 不同摘要（防「验一次、改内容重放」）", () => {
    expect(computePayloadHash({ amount: 1 })).not.toBe(computePayloadHash({ amount: 2 }));
  });

  it("数组顺序保留原样（不做会放过重放的“聪明”归一化）", () => {
    expect(computePayloadHash([1, 2])).not.toBe(computePayloadHash([2, 1]));
  });

  it("stableStringify 对 null / 原始值稳定", () => {
    expect(stableStringify(null)).toBe("null");
    expect(stableStringify({ b: { d: 4, c: 3 }, a: 1 })).toBe('{"a":1,"b":{"c":3,"d":4}}');
  });
});

describe("挑战票据（RC-46）", () => {
  const payload = { challengeId: "sc_1", userId: "u1", routeKey: "/api/command", issuedAt: Date.now() };

  it("签名往返：合法票据能被解析", () => {
    const ticket = signChallengeTicket(payload);
    const verified = verifyChallengeTicket(ticket);
    expect(verified).toMatchObject({ challengeId: "sc_1", userId: "u1", routeKey: "/api/command" });
  });

  it("篡改内容即失效（HMAC）", () => {
    const ticket = signChallengeTicket(payload);
    const [body, signature] = ticket.split(".");
    const tampered = Buffer.from(
      JSON.stringify({ ...payload, routeKey: "/api/admin/env" }),
      "utf8",
    ).toString("base64url");
    expect(verifyChallengeTicket(`${tampered}.${signature}`)).toBeNull();
    // 原始 body + 空签名也不行
    expect(verifyChallengeTicket(`${body}.`)).toBeNull();
  });

  it("过期票据被拒（防「批量收集票据 → 一次性兑一大枚 grant」）", () => {
    const issuedAt = Date.now() - 10 * 60 * 1000;
    const ticket = signChallengeTicket({ ...payload, issuedAt });
    expect(verifyChallengeTicket(ticket)).toBeNull();
    expect(verifyChallengeTicket(ticket, { now: issuedAt + 1000 })).not.toBeNull();
  });

  it("非字符串 / 无点号 / 非法 JSON 一律返回 null（不抛错）", () => {
    expect(verifyChallengeTicket(undefined)).toBeNull();
    expect(verifyChallengeTicket("nope")).toBeNull();
    expect(verifyChallengeTicket("Zm9v.bar")).toBeNull();
  });
});

describe("工作量证明：hashcash 前像难度（RC-36 / RC-54，术语纠正）", () => {
  it("leadingZeroBits 与前缀零比特数一致", () => {
    expect(leadingZeroBits(Buffer.from([0b1000_0000]))).toBe(0);
    expect(leadingZeroBits(Buffer.from([0b0100_0000]))).toBe(1);
    expect(leadingZeroBits(Buffer.from([0x00, 0b0010_0000]))).toBe(10);
    expect(leadingZeroBits(Buffer.from([0x00, 0x00]))).toBe(16);
  });

  it("难度 0 时任意 nonce 通过；难度提高后必须真的算出来", () => {
    const seed = "seed-1";
    expect(verifyPowSolution(seed, "anything", 0)).toBe(true);
    expect(verifyPowSolution(seed, "anything", 32)).toBe(false);
    // 暴力找 8 比特（期望 256 次）
    let nonce = 0;
    while (!verifyPowSolution(seed, String(nonce), 8) && nonce < 100_000) nonce += 1;
    expect(verifyPowSolution(seed, String(nonce), 8)).toBe(true);
  });

  it("非法输入一律拒绝", () => {
    expect(verifyPowSolution("", "n", 8)).toBe(false);
    expect(verifyPowSolution("seed", "", 8)).toBe(false);
    expect(verifyPowSolution("seed", "x".repeat(65), 8)).toBe(false);
  });

  it("难度按客户端实测耗时自适应（移动端 CPU 差 10 倍以上）", () => {
    expect(nextPowDifficulty(DEFAULT_POW_DIFFICULTY, 500)).toBe(DEFAULT_POW_DIFFICULTY + 2);
    expect(nextPowDifficulty(DEFAULT_POW_DIFFICULTY, 20_000)).toBe(DEFAULT_POW_DIFFICULTY - 2);
    expect(nextPowDifficulty(DEFAULT_POW_DIFFICULTY, 3_000)).toBe(DEFAULT_POW_DIFFICULTY);
    // 边界钳制
    expect(nextPowDifficulty(MAX_POW_DIFFICULTY, 100)).toBe(MAX_POW_DIFFICULTY);
    expect(nextPowDifficulty(MIN_POW_DIFFICULTY, 60_000)).toBe(MIN_POW_DIFFICULTY);
    // 非法输入回落默认
    expect(nextPowDifficulty(undefined, undefined)).toBe(DEFAULT_POW_DIFFICULTY);
  });
});

describe("闸门纯谓词（RC-09 / §4.4）", () => {
  it("只对写方法设闸，GET/HEAD/OPTIONS 永不逐请求验", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "post", "delete"]) {
      expect(stepUpRequiredForMethod(method)).toBe(true);
    }
    for (const method of ["GET", "HEAD", "OPTIONS", "get"]) {
      expect(stepUpRequiredForMethod(method)).toBe(false);
    }
  });

  it("豁免清单覆盖健康检查、登出、挑战端点自身与静态资源", () => {
    expect(isStepUpBypassPath("/api/step-up/grant")).toBe(true);
    expect(isStepUpBypassPath("/api/auth/logout")).toBe(true);
    expect(isStepUpBypassPath("/api/health")).toBe(true);
    expect(isStepUpBypassPath("/api/status")).toBe(true);
    expect(isStepUpBypassPath("/static/audio/x.mp3")).toBe(true);
    expect(isStepUpBypassPath("/api/tts/generate")).toBe(false);
    // 前缀相同但不是子路径的不得被误判（/api/statuses 不该放行）
    expect(isStepUpBypassPath("/api/statuses")).toBe(false);
  });

  it("原生/脚本客户端（只带 Bearer、没有会话 Cookie）标记为 unsupported", () => {
    expect(isInteractiveUnsupported(fakeRequest({ authorization: "Bearer abc" }))).toBe(true);
    expect(
      isInteractiveUnsupported(fakeRequest({ authorization: "Bearer abc", cookie: "synapse_token=t" })),
    ).toBe(false);
    expect(isInteractiveUnsupported(fakeRequest({ cookie: "synapse_token=t" }))).toBe(false);
    expect(isInteractiveUnsupported(fakeRequest({}))).toBe(false);
  });
});
