import { isServerStatusPasswordValid } from "../services/operationalStatusService";

/**
 * R3-06 之后 `isServerStatusPasswordValid` 是 **async**：环境变量默认值仍在本进程明文比对，
 * 但后台改过的口令以 bcrypt 哈希存在运行时配置里（必须异步比对）。所以这里的断言都要 await
 * —— 这也是本文件需要改的原因：漏 await 时 Promise 恒为真，「拒绝错误口令」会假通过。
 */
describe("operationalStatusService", () => {
  it("accepts the configured server status password", async () => {
    await expect(isServerStatusPasswordValid("test-password")).resolves.toBe(true);
  });

  it("rejects invalid server status passwords", async () => {
    await expect(isServerStatusPasswordValid("wrong-password")).resolves.toBe(false);
    await expect(isServerStatusPasswordValid("test-password ")).resolves.toBe(false);
    await expect(isServerStatusPasswordValid(undefined)).resolves.toBe(false);
  });

  it("rejects oversized password candidates", async () => {
    await expect(isServerStatusPasswordValid("a".repeat(1025))).resolves.toBe(false);
  });
});
