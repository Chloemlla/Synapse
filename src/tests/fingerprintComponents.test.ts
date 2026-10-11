import { describe, expect, it } from "@jest/globals";
import {
  hasFingerprintComponentDrift,
  normalizeFingerprintComponentHash,
  normalizeFingerprintComponents,
} from "../utils/fingerprintComponents";

/**
 * 指纹分量摘要的规范化与漂移判定（RC-16）。
 *
 * 这两步是 `device_fingerprints` 写入路径的唯一入口，因此这里钉死三件事：
 * 1. 非法/超长/空值必须归零成空串（不能把伪造值写进事实表）；
 * 2. 四路全空不产生记录（normalize 返回 null）；
 * 3. 漂移只在「前后都有值且不同」时才算（任一侧缺失不判 —— 采集失败不等于换机器）。
 */

describe("normalizeFingerprintComponentHash", () => {
  it("接受 hex / base64 / urlsafe 形态，并 trim", () => {
    expect(normalizeFingerprintComponentHash("  abc123  ")).toBe("abc123");
    expect(normalizeFingerprintComponentHash("a+b/c=")).toBe("a+b/c=");
    expect(normalizeFingerprintComponentHash("A_b-c")).toBe("A_b-c");
  });

  it("非字符串、空串、含非法字符、超长一律归零", () => {
    expect(normalizeFingerprintComponentHash(undefined)).toBe("");
    expect(normalizeFingerprintComponentHash(null)).toBe("");
    expect(normalizeFingerprintComponentHash(123)).toBe("");
    expect(normalizeFingerprintComponentHash("   ")).toBe("");
    expect(normalizeFingerprintComponentHash("has space")).toBe("");
    expect(normalizeFingerprintComponentHash("<script>")).toBe("");
    expect(normalizeFingerprintComponentHash("a".repeat(201))).toBe("");
  });
});

describe("normalizeFingerprintComponents", () => {
  it("四路全空返回 null（调用方不该写记录）", () => {
    expect(normalizeFingerprintComponents({ can: "", wgl: "", tz: "", scr: "" })).toBeNull();
    expect(normalizeFingerprintComponents({})).toBeNull();
    expect(normalizeFingerprintComponents(null)).toBeNull();
    expect(normalizeFingerprintComponents([])).toBeNull();
  });

  it("只保留合法分量，未提供的分量归零", () => {
    expect(normalizeFingerprintComponents({ can: "aaa", wgl: "bad value", tz: "ccc" })).toEqual({
      can: "aaa",
      wgl: "",
      tz: "ccc",
      scr: "",
    });
  });
});

describe("hasFingerprintComponentDrift", () => {
  const previous = { can: "can1", wgl: "wgl1", tz: "tz1", scr: "scr1" };

  it("任一路变化即判漂移", () => {
    expect(hasFingerprintComponentDrift(previous, { ...previous, can: "can2" })).toBe(true);
    expect(hasFingerprintComponentDrift(previous, { ...previous, wgl: "wgl2" })).toBe(true);
    expect(hasFingerprintComponentDrift(previous, { ...previous, tz: "tz2" })).toBe(true);
    expect(hasFingerprintComponentDrift(previous, { ...previous, scr: "scr2" })).toBe(true);
  });

  it("完全一致不判漂移", () => {
    expect(hasFingerprintComponentDrift(previous, { ...previous })).toBe(false);
  });

  it("任一侧缺失不判漂移（采集失败不是换机器）", () => {
    expect(hasFingerprintComponentDrift(null, previous)).toBe(false);
    expect(hasFingerprintComponentDrift(undefined, previous)).toBe(false);
    expect(hasFingerprintComponentDrift(previous, { ...previous, can: "" })).toBe(false);
    expect(hasFingerprintComponentDrift({ ...previous, can: "" }, previous)).toBe(false);
  });
});
