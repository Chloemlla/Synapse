/**
 * 回归测试：政策同意查询/撤回的「登录会话」归属通道。
 *
 * assertDeviceOwnership 认三条归属证明（已登录会话 / 本端点下发的凭据 cookie / 首访验证令牌），
 * 但 policy-routes 模块挂载时没有全局会话解析：不在 /check、/revoke 上补 optionalAuthenticateToken，
 * req.user 就永远是空的，「已登录会话」那句是死代码——用户清了 cookie 或换了设备后，
 * 即使登录着也撤不掉自己的同意，网站端的撤回入口会恒定 403。
 *
 * 这里钉住两件事：
 * 1. 只有登录会话、没有设备凭据 cookie 的客户端可以撤回；
 * 2. 匿名且没有 cookie（或会话不可信）的客户端仍然被挡，闸门没被放宽。
 *
 * 只替换持久化与用户查询两层，其余（app、路由、限流、optionalAuthenticateToken、
 * assertDeviceOwnership）都走真实现，因此这个用例不需要真库，能进 CI。
 * 需要真库的 policyApi.test.ts 因同原因被排除在 CI 之外，不要把这个文件也拖下水。
 */

import jwt from "jsonwebtoken";
import request from "supertest";

interface StoredConsent {
  fingerprint: string;
  version: string;
  isValid: boolean;
  expiresAt: Date;
  isExpired: () => boolean;
  save: () => Promise<void>;
}

interface ConsentModelMock {
  __seed: (consent: StoredConsent) => void;
  __reset: () => void;
}

jest.mock("../models/policyConsentModel", () => {
  interface LocalConsent {
    fingerprint: string;
    version: string;
    isValid: boolean;
    expiresAt: Date;
    isExpired: () => boolean;
    save: () => Promise<void>;
  }

  // key 必须定义在工厂内部：jest.mock 的工厂会被提升到 import 之前，
  // 引用外层的 const 会在提升后拿到未初始化的绑定。
  const consents = new Map<string, LocalConsent>();
  const keyOf = (fingerprint: string, version: string): string => `${fingerprint}:${version}`;

  return {
    __seed: (consent: LocalConsent) => consents.set(keyOf(consent.fingerprint, consent.version), consent),
    __reset: () => consents.clear(),
    PolicyConsent: {
      findValidConsent: jest.fn(async (fingerprint: string, version: string) => {
        const consent = consents.get(keyOf(fingerprint, version));
        return consent && consent.isValid ? consent : null;
      }),
      updateMany: jest.fn(async (filter: { fingerprint: string; version?: string }) => {
        let modifiedCount = 0;
        for (const consent of consents.values()) {
          if (consent.fingerprint !== filter.fingerprint || !consent.isValid) continue;
          if (filter.version && consent.version !== filter.version) continue;
          consent.isValid = false;
          modifiedCount += 1;
        }
        return { modifiedCount };
      }),
    },
  };
});

jest.mock("../utils/userStorage", () => {
  const actual = jest.requireActual("../utils/userStorage");
  // 会话用户 id 放在工厂内部：jest.mock 的工厂会被提升到 import 之前，
  // 引用外层的 const 会在提升后拿到未初始化的绑定（TDZ）。
  const ownerId = "policy-session-owner";
  // UserStorage 的静态方法不可枚举，展开（{...UserStorage}）会得到空对象，
  // 其他模块拿到的 UserStorage 就废了。用 Proxy 只替换这一个方法，其余原样透传。
  return {
    ...actual,
    __ownerId: ownerId,
    UserStorage: new Proxy(actual.UserStorage as object, {
      get: (target, prop, receiver) =>
        prop === "getUserById"
          ? // 只认这一个 id，等价于「会话签名有效且用户仍在库」；
            // 其余 id 返回 null 即 optionalAuthenticateToken 眼中的「用户不存在」。
            async (id: string) => (id === ownerId ? { id: ownerId, username: "policyowner", role: "user" } : null)
          : Reflect.get(target, prop, receiver),
    }),
  };
});

import app from "../app";
import { config } from "../config/config";
import { CURRENT_POLICY_VERSION } from "../services/policyConsentService";

const consentModelMock = jest.requireMock("../models/policyConsentModel") as ConsentModelMock;
const { __ownerId: OWNER_ID } = jest.requireMock("../utils/userStorage") as { __ownerId: string };

const seedValidConsent = (fingerprint: string): void => {
  consentModelMock.__seed({
    fingerprint,
    version: CURRENT_POLICY_VERSION,
    isValid: true,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    isExpired: () => false,
    save: async () => undefined,
  });
};

const sessionAuthorization = `Bearer ${jwt.sign({ userId: OWNER_ID }, config.jwtSecret, {
  expiresIn: "1h",
})}`;

describe("政策同意撤回的登录会话通道", () => {
  beforeEach(() => {
    consentModelMock.__reset();
  });

  it("设备 cookie 丢失后，登录会话仍能撤回自己的同意", async () => {
    const fingerprint = "session-owner-fingerprint";
    seedValidConsent(fingerprint);

    // 模拟换设备/清 cookie：一个全新的客户端，只带登录会话
    const revoked = await request(app)
      .post("/api/policy/revoke")
      .set("Authorization", sessionAuthorization)
      .send({ fingerprint, version: CURRENT_POLICY_VERSION })
      .expect(200);

    expect(revoked.body).toEqual(expect.objectContaining({ success: true, revokedCount: 1 }));

    const afterRevoke = await request(app)
      .get("/api/policy/check")
      .set("Authorization", sessionAuthorization)
      .query({ fingerprint, version: CURRENT_POLICY_VERSION })
      .expect(200);

    expect(afterRevoke.body).toEqual(
      expect.objectContaining({ success: false, hasValidConsent: false }),
    );
  });

  it("查询同样认登录会话：登录用户不必持有设备 cookie 就能看状态", async () => {
    const fingerprint = "session-check-fingerprint";
    seedValidConsent(fingerprint);

    const checked = await request(app)
      .get("/api/policy/check")
      .set("Authorization", sessionAuthorization)
      .query({ fingerprint, version: CURRENT_POLICY_VERSION })
      .expect(200);

    expect(checked.body).toEqual(
      expect.objectContaining({ success: true, hasValidConsent: true }),
    );
  });

  it("既无会话也无设备凭据 cookie 的客户端依然被挡", async () => {
    const fingerprint = "session-anon-fingerprint";
    seedValidConsent(fingerprint);

    // 伪造/过期的会话不能被 optionalAuthenticateToken 接受，于是回落到「无凭据」分支
    const revoked = await request(app)
      .post("/api/policy/revoke")
      .set("Authorization", "Bearer not-a-real-token")
      .send({ fingerprint, version: CURRENT_POLICY_VERSION })
      .expect(403);

    expect(revoked.body.code).toBe("DEVICE_CREDENTIAL_REQUIRED");
  });
});
