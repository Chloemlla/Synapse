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
 */

import jwt from "jsonwebtoken";
import request from "supertest";

interface ConsentStore {
  __reset: () => void;
}

jest.mock("../models/policyConsentModel", () => {
  interface StoredConsent {
    fingerprint: string;
    version: string;
    isValid: boolean;
    expiresAt: Date;
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

    public static async updateMany(filter: { fingerprint: string; version?: string }): Promise<{
      modifiedCount: number;
    }> {
      let modifiedCount = 0;
      for (const consent of consents.values()) {
        if (consent.fingerprint !== filter.fingerprint || !consent.isValid) continue;
        if (filter.version && consent.version !== filter.version) continue;
        consent.isValid = false;
        modifiedCount += 1;
      }
      return { modifiedCount };
    }
  }

  return {
    __reset: () => consents.clear(),
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
import { CURRENT_POLICY_VERSION } from "../services/policyConsentService";

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
});
