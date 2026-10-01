/**
 * 回归测试：政策同意的查询/撤回只认「设备凭据」，不认登录会话。
 *
 * 背景：assertDeviceOwnership 一度写成「已登录会话也算设备凭据」。那条分支从未被激活过
 * （policy 模块挂载时没有全局会话解析，req.user 恒为空），但只要有人在路由上补一个
 * optionalAuthenticateToken，它就活了——任何登录用户拿到一个指纹（日志、请求 URL 里都有），
 * 就能查/撤别人设备的同意。指纹在本系统里就是设备凭据本身（同意 cookie 是它的 HMAC），
 * 会话只证明「你是谁」，不证明「你是这台设备」。所以这里钉住两头：
 * 1. 持凭据 cookie 的本设备照常能查、能撤；
 * 2. 一个**合法可解析**的登录会话，仍然不能替代设备凭据。
 *
 * 只替换持久化与用户查询两层，其余（app、路由、限流、cookie 凭据校验）都走真实现，
 * 因此不需要真库，能进 CI（需要真库的 policyApi.test.ts 因同原因被排除在 CI 之外）。
 *
 * 必须在 import ../app 之前引入应用安全边界替身：ipBanCheck 在 Redis 与 Mongo 都问不到时
 * fail-closed 回 503，而本套件没有 Mongo ⇒ 每个请求都会被拦在路由之前拿到 503（CI 日志里
 * 表现为「封禁状态查询不可用，拒绝请求（fail-closed）: 127.0.0.1」），断言全部失去意义。
 * 封禁/限流语义不在本套件射程内，统一直通见 helpers/mockAppSecurityBoundaries。
 */

import "./helpers/mockAppSecurityBoundaries";

import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import request from "supertest";

interface ConsentStore {
  __reset: () => void;
  __size: () => number;
  __get: (fingerprint: string, version: string) => Record<string, unknown> | undefined;
  __mutate: (fingerprint: string, version: string, patch: Record<string, unknown>) => void;
}

jest.mock("../models/policyConsentModel", () => {
  interface StoredConsent {
    fingerprint: string;
    version: string;
    isValid: boolean;
    expiresAt: Date;
    recordedAt?: Date;
    revokedAt?: Date;
    [key: string]: unknown;
  }

  const consents = new Map<string, StoredConsent>();
  const keyOf = (fingerprint: string, version: string): string => `${fingerprint}:${version}`;

  // 用类而不是静态对象：写入路径会 new PolicyConsent({...}).save()，替身必须可构造。
  class FakePolicyConsent {
    public fingerprint = "";
    public version = "";
    public isValid = true;
    public expiresAt = new Date(0);
    [key: string]: unknown;

    constructor(attrs: Record<string, unknown>) {
      Object.assign(this, attrs);
    }

    public isExpired(): boolean {
      return new Date() > this.expiresAt;
    }

    public async save(): Promise<FakePolicyConsent> {
      consents.set(keyOf(this.fingerprint, this.version), this as unknown as StoredConsent);
      return this;
    }

    public static async findValidConsent(fingerprint: string, version: string): Promise<StoredConsent | null> {
      const found = consents.get(keyOf(fingerprint, version));
      if (!found || !found.isValid) return null;
      // 过期即视为无效，与真模型的 expiresAt > now 过滤一致
      return new Date() > found.expiresAt ? null : found;
    }

    public static async findLatestConsent(fingerprint: string): Promise<StoredConsent | null> {
      let latest: StoredConsent | null = null;
      for (const consent of consents.values()) {
        if (consent.fingerprint !== fingerprint) continue;
        if (!latest || (consent.recordedAt?.getTime() ?? 0) >= (latest.recordedAt?.getTime() ?? 0)) {
          latest = consent;
        }
      }
      return latest;
    }

    public static async findConsentHistory(fingerprint: string, limit = 20): Promise<StoredConsent[]> {
      return [...consents.values()]
        .filter((consent) => consent.fingerprint === fingerprint)
        .sort((a, b) => (b.recordedAt?.getTime() ?? 0) - (a.recordedAt?.getTime() ?? 0))
        .slice(0, limit);
    }

    public static async updateMany(
      filter: { fingerprint: string; version?: string },
      update: Record<string, unknown> = {},
    ): Promise<{ modifiedCount: number }> {
      let modifiedCount = 0;
      for (const consent of consents.values()) {
        if (consent.fingerprint !== filter.fingerprint || !consent.isValid) continue;
        if (filter.version && consent.version !== filter.version) continue;
        // 把撤回载荷真的落到内存记录上：真模型靠 schema 声明字段接收它们，
        // 这里把「载荷有没有落到记录里」断言成可测行为（见 P-01）。
        Object.assign(consent, update, { isValid: false });
        modifiedCount += 1;
      }
      return { modifiedCount };
    }

    public static async deleteMany(filter: { fingerprint: string }): Promise<{ deletedCount: number }> {
      let deletedCount = 0;
      for (const [key, consent] of consents.entries()) {
        if (consent.fingerprint !== filter.fingerprint) continue;
        consents.delete(key);
        deletedCount += 1;
      }
      return { deletedCount };
    }
  }

  return {
    __reset: () => consents.clear(),
    __size: () => consents.size,
    __get: (fingerprint: string, version: string) => consents.get(keyOf(fingerprint, version)),
    __mutate: (fingerprint: string, version: string, patch: Record<string, unknown>) => {
      const found = consents.get(keyOf(fingerprint, version));
      if (found) Object.assign(found, patch);
    },
    PolicyConsent: FakePolicyConsent,
  };
});

jest.mock("../utils/userStorage", () => {
  const actual = jest.requireActual("../utils/userStorage");
  // 会话用户 id 放在工厂内部：jest.mock 的工厂会被提升到 import 之前，
  // 引用外层的 const 会拿到未初始化的绑定（TDZ）。
  const ownerId = "policy-session-owner";
  // UserStorage 的静态方法不可枚举，展开（{...UserStorage}）会得到空对象，
  // 其他模块拿到的 UserStorage 就废了。用 Proxy 只替换这一个方法，其余原样透传。
  return {
    ...actual,
    __ownerId: ownerId,
    UserStorage: new Proxy(actual.UserStorage as object, {
      get: (target, prop, receiver) =>
        prop === "getUserById"
          ? // 让它解析得出用户：会话必须是「真的能用」，测试才有意义——
            // 如果这里返回 null，被测行为会因为「会话无效」而通过，掩盖回归。
            async (id: string) => (id === ownerId ? { id: ownerId, username: "policyowner", role: "user" } : null)
          : Reflect.get(target, prop, receiver),
    }),
  };
});

import app from "../app";
import { config } from "../config/config";
import { POLICY_DOCUMENT_HASH } from "../config/policyDocument";
import { CURRENT_POLICY_VERSION, POLICY_AGREEMENT_KEYS } from "../services/policyConsentService";

const consentStore = jest.requireMock("../models/policyConsentModel") as ConsentStore;
const { __ownerId: OWNER_ID } = jest.requireMock("../utils/userStorage") as { __ownerId: string };

const sessionAuthorization = `Bearer ${jwt.sign({ userId: OWNER_ID }, config.jwtSecret, {
  expiresIn: "1h",
})}`;

describe("政策同意的设备凭据闸门", () => {
  beforeEach(() => {
    consentStore.__reset();
  });

  it("持凭据 cookie 的本设备可以查询并撤回", async () => {
    // agent 会保留 /verify 下发的同意凭据 cookie
    const device = request.agent(app);
    const fingerprint = "device-credential-fingerprint";

    await device.post("/api/policy/verify").send({ fingerprint }).expect(200);

    const checked = await device
      .get("/api/policy/check")
      .query({ fingerprint, version: CURRENT_POLICY_VERSION })
      .expect(200);
    expect(checked.body).toEqual(expect.objectContaining({ success: true, hasValidConsent: true }));

    const revoked = await device
      .post("/api/policy/revoke")
      .send({ fingerprint, version: CURRENT_POLICY_VERSION })
      .expect(200);
    expect(revoked.body).toEqual(expect.objectContaining({ success: true, revokedCount: 1 }));

    const afterRevoke = await device
      .get("/api/policy/check")
      .query({ fingerprint, version: CURRENT_POLICY_VERSION })
      .expect(200);
    expect(afterRevoke.body).toEqual(expect.objectContaining({ success: false, hasValidConsent: false }));
  });

  it("只有合法登录会话、没有设备凭据 cookie 的客户端仍被挡", async () => {
    const fingerprint = "session-only-fingerprint";

    // 先由设备本人写出一条有效同意
    await request.agent(app).post("/api/policy/verify").send({ fingerprint }).expect(200);

    // 换一个客户端：会话是真的（签名有效、用户可解析），但没有任何设备凭据 cookie
    const stranger = request(app);

    const checked = await stranger
      .get("/api/policy/check")
      .set("Authorization", sessionAuthorization)
      .query({ fingerprint, version: CURRENT_POLICY_VERSION })
      .expect(403);
    expect(checked.body.code).toBe("DEVICE_CREDENTIAL_REQUIRED");

    const revoked = await stranger
      .post("/api/policy/revoke")
      .set("Authorization", sessionAuthorization)
      .send({ fingerprint, version: CURRENT_POLICY_VERSION })
      .expect(403);
    expect(revoked.body.code).toBe("DEVICE_CREDENTIAL_REQUIRED");
  });

  it("既无凭据也无会话的客户端同样被挡", async () => {
    const fingerprint = "no-credential-fingerprint";
    await request.agent(app).post("/api/policy/verify").send({ fingerprint }).expect(200);

    const revoked = await request(app)
      .post("/api/policy/revoke")
      .set("Authorization", "Bearer not-a-real-token")
      .send({ fingerprint, version: CURRENT_POLICY_VERSION })
      .expect(403);

    expect(revoked.body.code).toBe("DEVICE_CREDENTIAL_REQUIRED");
  });

  it("撤回会把撤回时间、撤回 IP 与原因真正落进记录（schema 漏字段会让它们静默丢失）", async () => {
    const device = request.agent(app);
    const fingerprint = "revoke-audit-fingerprint";

    await device.post("/api/policy/verify").send({ fingerprint }).expect(200);
    const revoked = await device.post("/api/policy/revoke").send({ fingerprint }).expect(200);

    expect(revoked.body).toEqual(expect.objectContaining({ success: true, hadActiveConsent: true, purged: false, revokedCount: 1 }));

    const stored = consentStore.__get(fingerprint, CURRENT_POLICY_VERSION);
    expect(stored?.isValid).toBe(false);
    expect(stored?.revokedAt).toBeInstanceOf(Date);
    expect(stored?.revokedReason).toBe("user-request");
    expect(typeof stored?.revokedIP).toBe("string");
  });

  it("对本来就没有有效同意的设备重复撤回时，如实回 hadActiveConsent:false", async () => {
    const device = request.agent(app);
    const fingerprint = "revoke-twice-fingerprint";

    await device.post("/api/policy/verify").send({ fingerprint }).expect(200);
    await device.post("/api/policy/revoke").send({ fingerprint }).expect(200);

    const again = await device.post("/api/policy/revoke").send({ fingerprint }).expect(200);
    expect(again.body).toEqual(expect.objectContaining({ hadActiveConsent: false, revokedCount: 0 }));
  });

  it("purge 会硬删除本指纹的全部记录", async () => {
    const device = request.agent(app);
    const fingerprint = "purge-fingerprint";

    await device.post("/api/policy/verify").send({ fingerprint }).expect(200);
    const purged = await device.post("/api/policy/revoke").send({ fingerprint, purge: true }).expect(200);

    expect(purged.body).toEqual(expect.objectContaining({ success: true, purged: true, revokedCount: 1 }));
    expect(consentStore.__size()).toBe(0);

    // 另一台没有任何凭据的客户端依然查不到东西（设备凭据闸门不受 purge 影响）
    await request(app).get("/api/policy/status").set("X-Fingerprint", fingerprint).expect(403);
  });

  it("GET /api/policy/status 一次返回版本、条文指纹与本设备同意明细", async () => {
    const device = request.agent(app);
    const fingerprint = "status-fingerprint";

    await device.post("/api/policy/verify").send({ fingerprint }).expect(200);
    const status = await device.get("/api/policy/status").set("X-Fingerprint", fingerprint).expect(200);

    expect(status.body).toEqual(
      expect.objectContaining({
        success: true,
        hasValidConsent: true,
        reason: "active",
        version: CURRENT_POLICY_VERSION,
        currentVersion: CURRENT_POLICY_VERSION,
        documentHash: POLICY_DOCUMENT_HASH,
        consentDocumentHash: POLICY_DOCUMENT_HASH,
        agreements: [...POLICY_AGREEMENT_KEYS],
        agreementsComplete: true,
        missingAgreements: [],
        source: "feature",
      }),
    );
    expect(typeof status.body.recordedAt).toBe("string");
    expect(typeof status.body.expiresAt).toBe("string");
  });

  it("记录被清掉但设备凭据仍在时，status 回 reason=none 而不是报错", async () => {
    const device = request.agent(app);
    const fingerprint = "status-stale-fingerprint";

    await device.post("/api/policy/verify").send({ fingerprint }).expect(200);
    consentStore.__reset();

    const status = await device.get("/api/policy/status").set("X-Fingerprint", fingerprint).expect(200);
    expect(status.body).toEqual(
      expect.objectContaining({ success: true, hasValidConsent: false, reason: "none" }),
    );
  });

  it("旧形态的设备凭据 cookie（<fingerprint>.<sig>）仍然可用，升级不踢掉在线设备", async () => {
    const fingerprint = "legacy-token-fingerprint";
    await request.agent(app).post("/api/policy/verify").send({ fingerprint }).expect(200);

    const legacySignature = crypto
      .createHmac("sha256", crypto.createHmac("sha256", config.jwtSecret).update("policy-consent-token").digest())
      .update(fingerprint)
      .digest("hex");

    const checked = await request(app)
      .get("/api/policy/check")
      .set("Cookie", `policy_consent_token=${fingerprint}.${legacySignature}`)
      .set("X-Fingerprint", fingerprint)
      .expect(200);

    expect(checked.body).toEqual(expect.objectContaining({ hasValidConsent: true }));
  });

  it("篡改过的设备凭据 cookie 被拒", async () => {
    const fingerprint = "tampered-token-fingerprint";
    await request.agent(app).post("/api/policy/verify").send({ fingerprint }).expect(200);

    const forgedSignature = "f".repeat(64);
    await request(app)
      .get("/api/policy/check")
      .set("Cookie", `policy_consent_token=${fingerprint}.${forgedSignature}`)
      .set("X-Fingerprint", fingerprint)
      .expect(403);
  });

  it("GET /api/policy/history 返回本设备同意轨迹，撤回后状态翻成 revoked", async () => {
    const device = request.agent(app);
    const fingerprint = "history-fingerprint";

    await device.post("/api/policy/verify").send({ fingerprint }).expect(200);

    const active = await device.get("/api/policy/history").set("X-Fingerprint", fingerprint).expect(200);
    expect(active.body.entries).toHaveLength(1);
    expect(active.body.entries[0]).toEqual(
      expect.objectContaining({
        version: CURRENT_POLICY_VERSION,
        state: "active",
        source: "feature",
        agreements: [...POLICY_AGREEMENT_KEYS],
        agreementsComplete: true,
        missingAgreements: [],
        documentHashMatchesCurrent: true,
      }),
    );
    expect(typeof active.body.entries[0].recordedAt).toBe("string");
    expect(typeof active.body.entries[0].expiresAt).toBe("string");

    await device.post("/api/policy/revoke").send({ fingerprint }).expect(200);

    const revoked = await device.get("/api/policy/history").set("X-Fingerprint", fingerprint).expect(200);
    expect(revoked.body.entries[0]).toEqual(expect.objectContaining({ state: "revoked" }));
    expect(typeof revoked.body.entries[0].revokedAt).toBe("string");
  });

  it("轨迹把过期与旧版本的记录分别标成 expired / superseded", async () => {
    const device = request.agent(app);
    const fingerprint = "history-state-fingerprint";
    await device.post("/api/policy/verify").send({ fingerprint }).expect(200);

    consentStore.__mutate(fingerprint, CURRENT_POLICY_VERSION, { expiresAt: new Date(Date.now() - 1000) });
    const expired = await device.get("/api/policy/history").set("X-Fingerprint", fingerprint).expect(200);
    expect(expired.body.entries[0].state).toBe("expired");

    consentStore.__mutate(fingerprint, CURRENT_POLICY_VERSION, {
      expiresAt: new Date(Date.now() + 86_400_000),
      version: "0.9",
      documentHash: "0".repeat(64),
    });
    const superseded = await device.get("/api/policy/history").set("X-Fingerprint", fingerprint).expect(200);
    expect(superseded.body.entries[0]).toEqual(
      expect.objectContaining({ state: "superseded", version: "0.9", documentHashMatchesCurrent: false }),
    );
  });

  it("GET /api/policy/history 同样只认设备凭据，且空轨迹不是错误", async () => {
    const fingerprint = "history-guard-fingerprint";
    await request.agent(app).post("/api/policy/verify").send({ fingerprint }).expect(200);

    const denied = await request(app).get("/api/policy/history").set("X-Fingerprint", fingerprint).expect(403);
    expect(denied.body.code).toBe("DEVICE_CREDENTIAL_REQUIRED");

    // 凭据与记录相互独立：凭据仍有效但库里没有记录时，回空数组而不是报错
    const device = request.agent(app);
    const emptyFingerprint = "history-empty-fingerprint";
    await device.post("/api/policy/verify").send({ fingerprint: emptyFingerprint }).expect(200);
    consentStore.__reset();

    const empty = await device.get("/api/policy/history").set("X-Fingerprint", emptyFingerprint).expect(200);
    expect(empty.body).toEqual(
      expect.objectContaining({
        success: true,
        currentVersion: CURRENT_POLICY_VERSION,
        documentHash: POLICY_DOCUMENT_HASH,
        entries: [],
      }),
    );
  });
});
