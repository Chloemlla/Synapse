import { describe, expect, it } from "@jest/globals";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  ACCOUNT_RISK_ACTION_LABELS,
  ACCOUNT_RISK_FLAG_LABELS,
  ACCOUNT_RISK_TIER_LABELS,
  AUTOMATION_SIGNAL_LABELS,
  CLIENT_REPORTED_EVENT_TYPES,
  DEVICE_FLAG_LABELS,
  RISK_EXEMPTION_SCOPE_LABELS,
  RISK_LEVEL_LABELS,
  SECURITY_EVENT_CATALOG,
  SECURITY_EVENT_LABELS,
  UNKNOWN_SECURITY_EVENT_LABEL,
  getSecurityCatalog,
  securityEventLabel,
} from "../services/nexaiSecurityCatalog";

/**
 * NexAI 安全面板「代号不许裸奔」的漂移闸门。
 *
 * 面板之前把 `ACCOUNT_ABUSE_*` / `SUPERADMIN_RISK_EXEMPT` 这类服务端代号原样铺在页面上，
 * 运维要看懂必须先翻代码。这些用例保证：源码里写出去的每个事件代号、以及各个枚举联合
 * （风险档位 / 判据旗标 / 处置动作 / 豁免范围）都有中文名。
 */

const SRC_ROOT = join(__dirname, "..");

function listSources(directory: string, files: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "generated") continue;
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "tests" && directory === SRC_ROOT) continue;
      listSources(full, files);
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

/** 从联合类型源码里取字符串字面量（`"a" | "b"`）。 */
function unionMembers(source: string, typeName: string): string[] {
  const match = new RegExp(`export type ${typeName} =([\\s\\S]*?);`).exec(source);
  if (!match) return [];
  return Array.from(match[1].matchAll(/"([^"]+)"/g)).map((item) => item[1]);
}

describe("nexaiSecurityCatalog", () => {
  it("has no duplicate codes and every entry carries a Chinese label", () => {
    const seen = new Set<string>();
    for (const entry of SECURITY_EVENT_CATALOG) {
      expect(entry.label.trim()).not.toBe("");
      expect(entry.groupLabel.trim()).not.toBe("");
      expect(seen.has(entry.value)).toBe(false);
      seen.add(entry.value);
    }
    expect(SECURITY_EVENT_CATALOG.length).toBe(Object.keys(SECURITY_EVENT_LABELS).length);
  });

  it("labels every event code written as an `eventType:` literal in the source tree", () => {
    const missing: string[] = [];
    // 取 `eventType:` 之后、逗号之前的那段（三元表达式的两个分支都能覆盖），
    // 再从中抽引号字面量。注释行跳过：其它子系统（如 tamper）也有 eventType 示例。
    const prefix = /eventType\s*:/;
    const quoted = /"([A-Za-z][A-Za-z0-9_]{3,})"/g;

    for (const file of listSources(SRC_ROOT)) {
      const source = readFileSync(file, "utf8");
      for (const line of source.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*")) continue;
        if (!prefix.test(trimmed)) continue;
        const afterColon = trimmed.slice(trimmed.indexOf("eventType:") + "eventType:".length);
        const segment = afterColon.split(",")[0];
        for (const match of segment.matchAll(quoted)) {
          const value = match[1];
          if (!SECURITY_EVENT_LABELS[value]) {
            missing.push(`${relative(join(SRC_ROOT, ".."), file)} → ${value}`);
          }
        }
      }
    }

    expect(missing).toEqual([]);
  });

  it("covers codes that are written through constants instead of inline literals", () => {
    // 这几个值只以 `X_EVENT = "..."` 常量或模板串形式出现，上面的行扫描抓不到。
    for (const value of [
      "AUTOMATION_TRACE",
      "FP_COMPONENT_DRIFT",
      "FP_SHARED_ACROSS_ACCOUNTS",
      "ACCOUNT_ABUSE_UNSPECIFIED",
    ]) {
      expect(SECURITY_EVENT_LABELS[value]).toBeTruthy();
    }
  });

  it("keeps the client-report whitelist aligned with the catalog", () => {
    expect(CLIENT_REPORTED_EVENT_TYPES).toHaveLength(14);
    for (const value of CLIENT_REPORTED_EVENT_TYPES) {
      const entry = SECURITY_EVENT_CATALOG.find((item) => item.value === value);
      expect(entry?.source).toBe("client");
    }
    expect(CLIENT_REPORTED_EVENT_TYPES).toEqual(
      expect.arrayContaining(["integrity_fail", "root_detected", "heartbeat", "custom"]),
    );
  });

  it("never renders an unknown code raw on the primary surface", () => {
    expect(securityEventLabel("SUPERADMIN_RISK_EXEMPT")).toBe("超管风控豁免");
    expect(securityEventLabel("ACCOUNT_ABUSE_GEO_JUMP")).toBe("登录属地跳变");
    expect(securityEventLabel("SOME_FUTURE_CODE")).toBe(UNKNOWN_SECURITY_EVENT_LABEL);
  });

  it("labels every member of the risk enums declared in the source tree", () => {
    const scopes = unionMembers(
      readFileSync(join(SRC_ROOT, "services", "riskExemption.ts"), "utf8"),
      "RiskExemptionScope",
    );
    expect(scopes.length).toBeGreaterThan(0);
    for (const scope of scopes) {
      expect(RISK_EXEMPTION_SCOPE_LABELS[scope]).toBeTruthy();
    }

    const scoring = readFileSync(join(SRC_ROOT, "utils", "accountRiskScoring.ts"), "utf8");
    for (const flag of unionMembers(scoring, "AccountRiskFlag")) {
      expect(ACCOUNT_RISK_FLAG_LABELS[flag]).toBeTruthy();
    }
    for (const tier of unionMembers(scoring, "AccountRiskTier")) {
      expect(ACCOUNT_RISK_TIER_LABELS[tier]).toBeTruthy();
    }

    const riskService = readFileSync(join(SRC_ROOT, "services", "accountRiskService.ts"), "utf8");
    for (const action of unionMembers(riskService, "AccountRiskAction")) {
      expect(ACCOUNT_RISK_ACTION_LABELS[action]).toBeTruthy();
    }
  });

  it("ships the full label dictionary with the catalog payload", () => {
    const payload = getSecurityCatalog();
    expect(payload.eventTypes.length).toBe(SECURITY_EVENT_CATALOG.length);
    expect(payload.eventGroups.map((group) => group.value)).toEqual(
      expect.arrayContaining(["client", "account", "session", "system", "fingerprint"]),
    );
    expect(Object.keys(payload.eventDataLabels)).toEqual(
      expect.arrayContaining(["scope", "riskScore", "flags", "reasons", "action"]),
    );
    expect(payload.eventDataOrder[0]).toBe("scope");
    expect(payload.riskLevels.map((item) => item.value)).toEqual(
      expect.arrayContaining(["SAFE", "CRITICAL"]),
    );
    expect(RISK_LEVEL_LABELS.SAFE).toBe("安全");
    expect(DEVICE_FLAG_LABELS.isRoot).toBe("Root 权限");
    expect(AUTOMATION_SIGNAL_LABELS.webdriver).toBeTruthy();
  });
});
