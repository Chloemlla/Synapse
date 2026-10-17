import { describe, expect, it } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import {
  ACCOUNT_EXPORT_MAX_USERS,
  OMITTED_DATASETS,
  listAccountExportTargets,
  sanitizeForExport,
} from "../services/accountDataExportService";
import { USER_CASCADE_COLLECTIONS } from "../services/userService";

/**
 * 账户数据导出（管理端）的两条硬约束：
 * 1. **脱敏**：凭据材料永远不出现在导出里，完整性校验字段（sha256 / checksum）保留；
 * 2. **契约一致**：隐私数据地图标注可导出的账号数据，导出注册表必须覆盖；
 *    标注不可导出的，必须出现在 `omitted` 里并带原因，而不是悄悄消失。
 *
 * 数据地图不进生产镜像（Docker 只拷 src/），所以注册表是硬编码的；
 * 这里读仓库内的 JSON 作为唯一契约来源，防止两边漂移。
 */

interface PrivacyDataset {
  id: string;
  collection: string;
  fields: string[];
  export?: { supported?: boolean | "partial"; reason?: string; surface?: string };
}

function loadPrivacyMap(): { datasets: PrivacyDataset[] } {
  const file = path.resolve(process.cwd(), "docs", "governance", "privacy-data-map.json");
  return JSON.parse(fs.readFileSync(file, "utf8")) as { datasets: PrivacyDataset[] };
}

describe("sanitizeForExport", () => {
  it("脱敏密码、令牌、密钥、密文与内部存储键", () => {
    const sanitized = sanitizeForExport({
      username: "alice",
      password: "plain",
      passwordHash: "hash",
      token: "token",
      tokenExpiresAt: "2026-01-01",
      totpSecret: "totp",
      backupCodes: ["a", "b"],
      passkeyCredentials: [{ id: "cred" }],
      credentialHash: "cred-hash",
      clientTokenHash: "client-hash",
      keyHash: "key-hash",
      ciphertext: "cipher",
      iv: "iv",
      tag: "tag",
      storageKey: "s3://bucket/key",
      nested: { apiKey: "api-key", rawResponse: { x: 1 } },
      list: [{ secretValue: "secret", plain: 1 }],
    }) as Record<string, any>;

    expect(sanitized.username).toBe("alice");
    for (const key of [
      "password",
      "passwordHash",
      "token",
      "tokenExpiresAt",
      "totpSecret",
      "backupCodes",
      "passkeyCredentials",
      "credentialHash",
      "clientTokenHash",
      "keyHash",
      "ciphertext",
      "iv",
      "tag",
      "storageKey",
    ]) {
      expect(sanitized[key]).toBe("[redacted]");
    }
    expect(sanitized.nested.apiKey).toBe("[redacted]");
    expect(sanitized.nested.rawResponse).toBe("[redacted]");
    expect(sanitized.list[0].secretValue).toBe("[redacted]");
    // 非凭据字段原样保留，管理员仍能核对完整性。
    expect(sanitized.list[0].plain).toBe(1);
  });

  it("保留完整性元数据（sha256 / checksum / documentHash）", () => {
    const sanitized = sanitizeForExport({
      sha256: "abc",
      checksum: "def",
      documentHash: "ghi",
      version: 3,
    }) as Record<string, unknown>;
    expect(sanitized).toEqual({ sha256: "abc", checksum: "def", documentHash: "ghi", version: 3 });
  });

  it("日期转 ISO 字符串，二进制正文标记为 redacted 而不是带出内容", () => {
    const sanitized = sanitizeForExport({
      when: new Date("2026-10-17T00:00:00.000Z"),
      blob: Buffer.from("secret-bytes"),
    }) as Record<string, unknown>;
    expect(sanitized.when).toBe("2026-10-17T00:00:00.000Z");
    expect(sanitized.blob).toEqual({ redacted: true, type: "binary" });
  });

  it("循环深度有上限（防止异常嵌套拖垮导出）", () => {
    let deep: Record<string, unknown> = { value: 1 };
    for (let i = 0; i < 20; i += 1) deep = { child: deep };
    const sanitized = sanitizeForExport(deep) as Record<string, any>;
    expect(JSON.stringify(sanitized)).toContain("[max-depth]");
  });
});

describe("导出注册表与隐私数据地图一致", () => {
  const map = loadPrivacyMap();
  const targets = listAccountExportTargets();
  const targetCollections = new Set(targets.map((target) => target.collection));
  const omittedIds = new Set(OMITTED_DATASETS.map((item) => item.id));
  const cascadeCollections = new Set(USER_CASCADE_COLLECTIONS.map((entry) => entry.collection));

  it("目标 id 与集合不重复", () => {
    const ids = targets.map((target) => target.id);
    expect(new Set(ids).size).toBe(ids.length);
    const collections = targets.map((target) => target.collection);
    expect(new Set(collections).size).toBe(collections.length);
  });

  it("地图里标注可导出的账号数据都被注册表覆盖", () => {
    // user-fingerprints 的账号资料与指纹作为 profile 段导出，不单独占一行数据集。
    const representedInProfile = new Set(["user-fingerprints"]);
    // 封面是公开分享的附属文件，分享记录元数据已覆盖。
    const intentionallyOmitted = new Set(["geogebra-share-covers"]);

    const userScopedExportable = map.datasets.filter((dataset) => {
      const supported = dataset.export?.supported;
      if (supported !== true && supported !== "partial") return false;
      const hasUserField = dataset.fields.some((field) =>
        /^(userId|ownerUserId|authorUserId|email)$/.test(field),
      );
      return hasUserField || cascadeCollections.has(dataset.collection);
    });

    const uncovered = userScopedExportable
      .filter((dataset) => (
        !targetCollections.has(dataset.collection)
        && !representedInProfile.has(dataset.id)
        && !(intentionallyOmitted.has(dataset.id) && omittedIds.has(dataset.id))
      ))
      .map((dataset) => `${dataset.id} (${dataset.collection})`);

    expect(uncovered).toEqual([]);
  });

  it("地图里标注不可导出的账号数据都在 omitted 里给出原因", () => {
    const userScopedNotExportable = map.datasets.filter((dataset) => {
      if (dataset.export?.supported !== false) return false;
      const hasUserField = dataset.fields.some((field) =>
        /^(userId|ownerUserId|authorUserId|email|emailCanonical)$/.test(field),
      );
      return hasUserField || cascadeCollections.has(dataset.collection);
    });
    const missing = userScopedNotExportable
      .filter((dataset) => !omittedIds.has(dataset.id))
      .map((dataset) => dataset.id);
    expect(missing).toEqual([]);
  });

  it("omitted 条目都能在地图里找到，且带非空原因", () => {
    const mapIds = new Set(map.datasets.map((dataset) => dataset.id));
    for (const item of OMITTED_DATASETS) {
      expect(mapIds.has(item.id)).toBe(true);
      expect(item.reason.trim().length).toBeGreaterThan(0);
    }
  });

  it("注销级联集合要么被导出、要么明确列为不导出", () => {
    // 级联清单里只有凭据类与设备遥测不进入导出；其余都必须出现在目标或自动纳入里。
    const knownCredentialCollections = new Set([
      "access_tokens",
      "oauth_tokens",
      "verification_tokens",
      "oauth_authorization_codes",
    ]);
    const nonExportableCascadeCollections = new Set(["device_trackings"]);
    const unaccounted = USER_CASCADE_COLLECTIONS
      .map((entry) => entry.collection)
      .filter((collection) => (
        !targetCollections.has(collection)
        && !knownCredentialCollections.has(collection)
        && !nonExportableCascadeCollections.has(collection)
      ));
    expect(unaccounted).toEqual([]);
  });

  it("批量导出上限与前端按钮口径一致", () => {
    expect(ACCOUNT_EXPORT_MAX_USERS).toBe(10);
  });
});
