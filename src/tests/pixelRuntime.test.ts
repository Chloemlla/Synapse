/**
 * Pixel 运行期基础设施的纯函数用例：遮罩、卡密哈希、上游 CDK 可逆加密、限额解析。
 *
 * 全是无副作用的纯函数/加密原语，不连 Mongo、不碰网络。
 */
import { describe, expect, it } from "@jest/globals";
import {
  PIXEL_SECRET_CRYPTO_VERSION,
  decryptPixelSecret,
  encryptPixelSecret,
  hashDistributionCdk,
  isValidSecretShape,
  maskSecret,
  newPixelId,
  normalizeDistributionCdk,
  pixelLimitsFromEnv,
} from "../pixel/runtime";

describe("pixel 遮罩与卡密哈希", () => {
  it("≤ 8 位全部打码，更长时只留前 4 后 4", () => {
    expect(maskSecret("abc")).toBe("********");
    expect(maskSecret("12345678")).toBe("********");
    expect(maskSecret("dist-1234567890")).toBe("dist...7890");
    expect(maskSecret("")).toBe("********");
  });

  it("遮罩值不可能包含完整卡密", () => {
    const card = "dist-abcdef123456";
    const masked = maskSecret(card);
    expect(masked).not.toBe(card);
    expect(masked).not.toContain("abcdef123456");
  });

  it("规范化只去首尾空白，不做大小写折叠", () => {
    expect(normalizeDistributionCdk("  aB-c  ")).toBe("aB-c");
    expect(normalizeDistributionCdk("ab-c")).not.toBe(normalizeDistributionCdk("AB-C"));
  });

  it("哈希对规范化后的卡密稳定，不同卡密不同", () => {
    expect(hashDistributionCdk(" dist-1 ")).toBe(hashDistributionCdk("dist-1"));
    expect(hashDistributionCdk("dist-1")).not.toBe(hashDistributionCdk("dist-2"));
    expect(hashDistributionCdk("dist-1")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("哈希里看不出明文卡密（库里因此没有可读的卡密）", () => {
    const hash = hashDistributionCdk("dist-super-secret");
    expect(hash).not.toContain("dist");
    expect(hash).not.toContain("secret");
  });
});

describe("pixel 上游 CDK 可逆加密", () => {
  it("往返一致，且密文字段里不含明文", () => {
    const encrypted = encryptPixelSecret("upstream-cdk-测试");
    expect(encrypted.cryptoVersion).toBe(PIXEL_SECRET_CRYPTO_VERSION);
    expect(encrypted.ciphertext).not.toContain("upstream");
    expect(encrypted.iv).not.toContain("upstream");
    expect(decryptPixelSecret(encrypted)).toBe("upstream-cdk-测试");
  });

  it("每次加密的 iv/密文都不同（同明文不会产生同一段密文）", () => {
    const a = encryptPixelSecret("same");
    const b = encryptPixelSecret("same");
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(decryptPixelSecret(b)).toBe("same");
  });

  it("版本不符、字段缺失或 tag 被改一律解不开（不回退成按明文用）", () => {
    const encrypted = encryptPixelSecret("upstream-cdk");
    expect(() => decryptPixelSecret({ ...encrypted, cryptoVersion: 2 })).toThrow();
    expect(() => decryptPixelSecret({ ciphertext: encrypted.ciphertext, iv: encrypted.iv })).toThrow();
    expect(() => decryptPixelSecret({ ...encrypted, tag: Buffer.alloc(16).toString("base64") })).toThrow();
    expect(() => decryptPixelSecret({ ...encrypted, ciphertext: Buffer.from("tampered").toString("base64") })).toThrow();
  });
});

describe("pixel 限额环境变量", () => {
  it("默认值是可用的保守值", () => {
    const limits = pixelLimitsFromEnv({});
    expect(limits.maxAccountsPerSubmission).toBe(100);
    expect(limits.maxAccountLineChars).toBe(512);
    expect(limits.usageLogRetentionDays).toBe(30);
    expect(limits.upstreamTimeoutMs).toBe(20_000);
  });

  it("可被 env 覆盖，越界值被夹到安全区间", () => {
    expect(pixelLimitsFromEnv({ PIXEL_MAX_ACCOUNTS: "7" }).maxAccountsPerSubmission).toBe(7);
    expect(pixelLimitsFromEnv({ PIXEL_MAX_ACCOUNTS: "0" }).maxAccountsPerSubmission).toBe(1);
    expect(pixelLimitsFromEnv({ PIXEL_MAX_ACCOUNTS: "abc" }).maxAccountsPerSubmission).toBe(100);
    expect(pixelLimitsFromEnv({ PIXEL_UPSTREAM_TIMEOUT_MS: "99999999" }).upstreamTimeoutMs).toBe(120_000);
    expect(pixelLimitsFromEnv({ PIXEL_USAGE_LOG_RETENTION_DAYS: "0" }).usageLogRetentionDays).toBe(1);
  });
});

describe("pixel 标识与卡密形状校验", () => {
  it("newPixelId 带前缀且每次不同", () => {
    const a = newPixelId("pcm");
    expect(a.startsWith("pcm_")).toBe(true);
    expect(a).not.toBe(newPixelId("pcm"));
  });

  it("isValidSecretShape 拒绝空/超长/控制字符", () => {
    expect(isValidSecretShape("card-123")).toBe(true);
    expect(isValidSecretShape("  card-123  ")).toBe(true);
    expect(isValidSecretShape("")).toBe(false);
    expect(isValidSecretShape("   ")).toBe(false);
    expect(isValidSecretShape("bad\u0000card")).toBe(false);
    expect(isValidSecretShape("x".repeat(300), 256)).toBe(false);
    expect(isValidSecretShape(123)).toBe(false);
  });
});
