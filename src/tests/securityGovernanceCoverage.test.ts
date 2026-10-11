import { describe, expect, it } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";

/**
 * 治理覆盖核对（RC-31 / RC-32 / RC-35）。
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
  /** 已经挂上 requireFeatureConsent 的功能键。 */
  const gated = ["doc-tool"];

  /**
   * **尚未挂载**的功能键（漏登清单，逐条有去向）。
   * 这些功能目前对“未同意相关条款”的用户仍然开放 → 合规缺口，但每一项都需要挂在该功能
   * **自己的认证之后**（有些路由是工厂函数生成、认证在内部，不能直接 `router.use` 前置），
   * 因此按模块逐个接入，不做一刀切的前置挂载（那样会把“未登录”变成 401 语义错位）。
   */
  const pendingGating = [
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

  it("已接的功能键必须仍在使用（误删即 CI 红）", () => {
    for (const feature of gated) {
      expect(routeSource).toContain(`requireFeatureConsent("${feature}")`);
    }
  });

  it("漏登清单与实现一致：每一项要么已接、要么明确列在待接清单里", () => {
    const allFeatures = [...gated, ...pendingGating];
    expect(new Set(allFeatures).size).toBe(allFeatures.length);

    const actuallyGated = allFeatures.filter((feature) =>
      routeSource.includes(`requireFeatureConsent("${feature}")`),
    );
    // 实际已接的集合必须恰好等于 `gated` —— 多一个（有人接了没改这里）或少一个都会红。
    expect(actuallyGated.sort()).toEqual([...gated].sort());
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
  ];

  it.each(sensitiveOps)("$label 仍要求安全会话", ({ file, guard }) => {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    expect(source).toContain(guard);
  });

  it("安全会话守卫提供稳定 code（前端才识别得了“需要二次验证”）", () => {
    const source = fs.readFileSync(path.join(root, "src", "utils", "securitySession.ts"), "utf8");
    expect(source).toContain("SECURITY_SESSION_REQUIRED");
    expect(source).toContain("TWO_FACTOR_SESSION_REQUIRED");
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
