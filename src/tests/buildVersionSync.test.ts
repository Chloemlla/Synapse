import { execFileSync } from "node:child_process";
import path from "node:path";

/**
 * 构建期版本号注入的边界用例。
 *
 * 为什么必须钉住时区：构建机可能是 UTC（GitHub Actions）也可能是 Asia/Shanghai
 * （本地开发机）。直接读 `new Date()` 的本地字段，会在 UTC 机器上把当天 16:00 之后的
 * 构建算成「前一天」——每个工作日有三分之一的时间版本号都是错的。
 *
 * 用子进程调用脚本而不是 import：脚本是 ESM（`import.meta.url`），而 Jest 在 CJS 模式下
 * 加载它会踩到 babel 的 import.meta 转换；子进程同时也验证了真实的调用方式。
 */

const SCRIPT = path.resolve(__dirname, "../../scripts/sync-package-version.mjs");

function versionAt(iso: string): string {
  return execFileSync(process.execPath, [SCRIPT, "--print", "--at", iso], {
    encoding: "utf-8",
  }).trim();
}

describe("构建期版本号（YY.MM.DD，按 UTC+8 取日期）", () => {
  it("UTC 16:00 正好是 UTC+8 的次日零点", () => {
    expect(versionAt("2026-10-16T16:00:00Z")).toBe("26.10.17");
    expect(versionAt("2026-10-16T15:59:59Z")).toBe("26.10.16");
  });

  it("月与日补零，三段宽度固定", () => {
    expect(versionAt("2026-09-01T00:00:00Z")).toBe("26.09.01");
    expect(versionAt("2026-03-05T12:00:00Z")).toBe("26.03.05");
  });

  it("跨年按 UTC+8 的年份取", () => {
    // 2026-12-31T16:30Z = 2027-01-01 00:30（+08）
    expect(versionAt("2026-12-31T16:30:00Z")).toBe("27.01.01");
  });

  it("非法 --at 以非零退出码失败，而不是静默用当前时间", () => {
    expect(() =>
      execFileSync(process.execPath, [SCRIPT, "--print", "--at", "bogus"], {
        encoding: "utf-8",
        stdio: "pipe",
      }),
    ).toThrow();
  });
});
