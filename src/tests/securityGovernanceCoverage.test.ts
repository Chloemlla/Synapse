import { describe, expect, it } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";

/**
 * 治理覆盖核对（RC-31 / RC-32 / RC-35 / RC-41）。
 *
 * 这三条的共同点：**不是“写一个功能”，而是“确认清单上的每一项都真的接上了”**。
 * 靠人肉核对必然漂移（仓库已有同类教训：新增场景只改了后端、共享替身缺件），
 * 所以这里用静态扫描把“当前覆盖状态”钉成断言：
 * - 某项**已接**却被误删 → 用例红；
 * - 某项**未接**（漏登）→ 在下面的清单里显式列着，补上时必须同步改这里，
 *   于是“漏登”从“没人知道”变成“有记录、有编号、有人负责”。
 */

const root = path.resolve(__dirname, "..", "..");

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (/\.tsx?$/.test(entry.name)) files.push(full);
  }
  return files;
}

function readAll(files: string[]): string {
  return files.map((file) => fs.readFileSync(file, "utf8")).join("\n");
}

const routeFiles = walk(path.join(root, "src", "routes"));
const routeSource = readAll(routeFiles);

describe("RC-31 功能同意闸门的覆盖度", () => {
  /**
   * 已经挂上同意闸门的功能键（2026-10-17：9 个漏登项全部接入）。
   * 其中 ipfs-upload / shorturl / data-report 走条件门禁：
   * 匿名/公开入口保持原行为，只有请求已识别出 userId 时才要求该用户自己的同意。
   */
  const gated = [
    "doc-tool",
    "image-upload",
    "ipfs-upload",
    "transcribe",
    "tts-generate",
    "deeplx-translate",
    "shorturl",
    "api-access",
    "cdk-redeem",
    "data-report",
  ];

  /** 必须使用条件门禁的功能键（有匿名/公开分支，不能被前置门禁变成 401）。 */
  const conditionalGating = ["ipfs-upload", "shorturl", "data-report"];

  const isGated = (feature: string) =>
    routeSource.includes(`requireFeatureConsent("${feature}")`) ||
    routeSource.includes(`requireFeatureConsentForAuthenticatedUser("${feature}")`);

  it("已接的功能键必须仍在使用（误删即 CI 红）", () => {
    for (const feature of gated) {
      expect(isGated(feature)).toBe(true);
    }
  });

  it("漏登清单已清空：清单里的每一项都真的接上了", () => {
    const actuallyGated = gated.filter(isGated);
    expect(actuallyGated.sort()).toEqual([...gated].sort());
  });

  it("匿名/公开入口使用条件门禁，不把匿名请求变成 401", () => {
    for (const feature of conditionalGating) {
      expect(routeSource).toContain(`requireFeatureConsentForAuthenticatedUser("${feature}")`);
    }
  });
});

describe("RC-32 敏感操作的安全会话清单", () => {
  /**
   * 需求点名的敏感操作，以及它们当前是否要求安全会话（Passkey/TOTP/密码二次验证）。
   * 清单本身即“检查表”：任何一处被摘掉守卫，用例就会红。
   */
  const sensitiveOps: Array<{ label: string; file: string; guard: string }> = [
    { label: "命令执行", file: "src/routes/commandRoutes.ts", guard: "hasValidSecuritySession" },
    { label: "管理端系统页（明文导出）", file: "src/routes/admin/system.ts", guard: "hasValidSecuritySession" },
    { label: "用户资料验证建立会话", file: "src/routes/admin/profile.ts", guard: "createProfileVerificationSession" },
    { label: "身份绑定", file: "src/routes/admin/profile.identity.ts", guard: "hasValidSecuritySession" },
    { label: "TOTP 关闭/重生成", file: "src/controllers/totpController.ts", guard: "hasValidSecuritySession" },
    { label: "超管危险动作", file: "src/controllers/adminController.ts", guard: "hasValidSecuritySession" },
    // 2026-10-17 补齐的三类写端点：主密钥派生/查看、环境变量变更、密钥轮换。
    { label: "主密钥派生/查看（路由层统一守卫）", file: "src/routes/admin/config.ts", guard: "requireSecuritySession" },
    { label: "环境变量变更（路由层统一守卫）", file: "src/routes/admin/config.ts", guard: "requireSecuritySession" },
    { label: "主密钥轮换（路由层统一守卫）", file: "src/routes/admin/config.ts", guard: "requireSecuritySession" },
    { label: "OAuth 客户端密钥轮换", file: "src/routes/oauthRoutes.ts", guard: "requireSecuritySession" },
    { label: "短链 AES_KEY 轮换", file: "src/routes/shortUrlRoutes.ts", guard: "requireSecuritySession" },
    { label: "Pixel 主密钥重加密（含异步绑定）", file: "src/routes/admin/pixelRoutes.ts", guard: "assertSecuritySessionBinding" },
  ];

  it.each(sensitiveOps)("$label 仍要求安全会话", ({ file, guard }) => {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    expect(source).toContain(guard);
  });

  it("三类写端点的审计动作仍在（守卫拦下的尝试也会被 auditLog 记录）", () => {
    const source = fs.readFileSync(path.join(root, "src", "routes", "admin", "config.ts"), "utf8");
    for (const action of [
      "env.set",
      "env.delete",
      "env.reveal_key",
      "env.rotate_aes_key",
      "env.end_security_sessions",
    ]) {
      expect(source).toContain(`action: "${action}"`);
    }
  });

  it("安全会话守卫提供稳定 code（前端才识别得了“需要二次验证”）", () => {
    const source = fs.readFileSync(path.join(root, "src", "utils", "securitySession.ts"), "utf8");
    expect(source).toContain("SECURITY_SESSION_REQUIRED");
    expect(source).toContain("SECURITY_SESSION_BINDING_CHANGED");
    expect(source).toContain("TWO_FACTOR_SESSION_REQUIRED");
  });
});

describe("RC-41 安全会话的环境绑定覆盖", () => {
  /** 所有调用 hasValidSecuritySession 的敏感端点，都必须跟随异步属地绑定判定。 */
  const bindingFiles: Array<{ file: string; marker: string }> = [
    { file: "src/routes/commandRoutes.ts", marker: "assertSecuritySessionBinding" },
    { file: "src/routes/admin/system.ts", marker: "assertSecuritySessionBinding" },
    { file: "src/routes/admin/profile.ts", marker: "assertSecuritySessionBinding" },
    { file: "src/routes/admin/profile.identity.ts", marker: "assertSecuritySessionBinding" },
    { file: "src/routes/admin/pixelRoutes.ts", marker: "assertSecuritySessionBinding" },
    // adminController 的敏感端点在路由层统一挂 requireSecuritySession（其内部执行绑定判定）。
    { file: "src/routes/admin/config.ts", marker: "requireSecuritySession" },
    { file: "src/controllers/totpController.ts", marker: "assertSecuritySessionBinding" },
    { file: "src/controllers/auth/providerHandlers.ts", marker: "assertSecuritySessionBinding" },
  ];

  it.each(bindingFiles)("$file 执行异步绑定判定", ({ file, marker }) => {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    expect(source).toContain(marker);
  });

  it("绑定失败与缺失会话各有稳定 code", () => {
    const source = fs.readFileSync(path.join(root, "src", "utils", "securitySession.ts"), "utf8");
    expect(source).toContain("SECURITY_SESSION_REQUIRED_CODE");
    expect(source).toContain("SECURITY_SESSION_BINDING_CHANGED_CODE");
  });
});

describe("RC-35 新增敏感动作的审计登记", () => {
  const registeredActions = [
    // 风险档动作（RC-07）：审计由 applyAccountRiskAction 统一写。
    ["src/services/accountRiskService.ts", "security.account-risk."],
    // 运行时配置变更（账户风险 / 安全会话 / 地区限制）。
    ["src/routes/admin/config.ts", "security.account-risk.set"],
    ["src/routes/admin/config.ts", "security.security-session.set"],
    ["src/routes/admin/config.ts", "security.region-policy.set"],
    // 蜜罐命中：高置信恶意信号，必须有事件留痕（否则事后无从解释）。
    ["src/security/honeypot.ts", "HONEYPOT_HIT"],
  ] as const;

  it.each(registeredActions)("%s 里登记了 %s", (file, marker) => {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    expect(source).toContain(marker);
  });
});
