import { describe, expect, it } from "@jest/globals";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  ALLOWED_AUDIT_MODULES,
  AUDIT_MODULES,
  AUDIT_MODULE_GROUP_LABELS,
  AUDIT_ROLE_LABELS,
  auditModuleLabel,
  auditRoleLabel,
} from "../services/auditLogCatalog";
import { inferAuditModuleFromPath } from "../services/auditLogMetadata";

/**
 * 审计模块清单的漂移闸门。
 *
 * 背景：模块清单曾经抄在三处（模型类型联合、`ALLOWED_AUDIT_MODULES`、前端映射表），
 * 结果 `lumen-config` / `modlist` 写进了库却没进白名单 —— 筛选它们时后端静默忽略条件、
 * 返回全部日志。用户以为筛了，实际看到的是全量。这些用例把「源码里出现的每个模块值
 * 都必须在目录里」钉死。
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

describe("auditLogCatalog", () => {
  it("registers every module with a Chinese label, a group and a hint", () => {
    const values = new Set<string>();
    for (const item of AUDIT_MODULES) {
      expect(item.label.trim()).not.toBe("");
      expect(item.hint.trim()).not.toBe("");
      expect(AUDIT_MODULE_GROUP_LABELS[item.group]).toBeTruthy();
      expect(values.has(item.value)).toBe(false);
      values.add(item.value);
    }
    expect(ALLOWED_AUDIT_MODULES.size).toBe(AUDIT_MODULES.length);
  });

  it("covers every `module: \"...\"` literal written by the source tree", () => {
    const missing: string[] = [];
    const literal = /module:\s*"([a-z][a-z0-9-]*)"/g;

    for (const file of listSources(SRC_ROOT)) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(literal)) {
        const value = match[1];
        if (!(ALLOWED_AUDIT_MODULES as ReadonlySet<string>).has(value)) {
          missing.push(`${relative(join(SRC_ROOT, ".."), file)} → ${value}`);
        }
      }
    }

    expect(missing).toEqual([]);
  });

  it("keeps the two previously-omitted modules filterable", () => {
    // 回归点：这两个值由路由显式写入，白名单漏了它们时筛选会被静默忽略。
    expect((ALLOWED_AUDIT_MODULES as ReadonlySet<string>).has("modlist")).toBe(true);
    expect((ALLOWED_AUDIT_MODULES as ReadonlySet<string>).has("lumen-config")).toBe(true);
    expect(auditModuleLabel("modlist")).toBe("模组列表");
  });

  it("labels every role used by the audit writer", () => {
    for (const role of ["superadmin", "admin", "user", "unknown", "anonymous"]) {
      expect(AUDIT_ROLE_LABELS[role]).toBeTruthy();
      expect(auditRoleLabel(role)).toBe(AUDIT_ROLE_LABELS[role]);
    }
    // 未知值不隐藏：原样返回时管理端至少能看到真实的角色名。
    expect(auditRoleLabel("service-account")).toBe("service-account");
  });

  it("maps route prefixes to the right module, including plural aliases", () => {
    expect(inferAuditModuleFromPath("/api/modlist/123")).toBe("modlist");
    expect(inferAuditModuleFromPath("/api/lumen-config/keys")).toBe("lumen-config");
    expect(inferAuditModuleFromPath("/api/recommendations")).toBe("recommendation");
    expect(inferAuditModuleFromPath("/api/workspaces/abc")).toBe("workspace");
    expect(inferAuditModuleFromPath("/api/step-up/verify")).toBe("security");
    expect(inferAuditModuleFromPath("/api/totp/setup")).toBe("auth");
    expect(inferAuditModuleFromPath("/api/unknown-subsystem/x")).toBe("other");
  });
});
