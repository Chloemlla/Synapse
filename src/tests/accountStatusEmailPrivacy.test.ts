import { generateAccountRestoredEmailHtml, generateAccountSuspendedEmailHtml } from "../templates/emailTemplates";

/**
 * 账号状态通知邮件的**最小披露**判据。
 *
 * 停用/恢复是管理员操作。历史上这封邮件把「处置原因」和详情表里的 IP、设备环境一起发了出去，
 * 而那两行的真实值来自**发起操作的那台机器**（管理员出口 IP、管理员浏览器 UA）——
 * 等于把操作者指纹送到被处置的普通用户手里，既无必要也留了口子。
 *
 * 现在的口径：普通用户只收到「发生了什么 + 生效时间」；原因/操作者/证据留在管理端审计里。
 * 这几条断言就是这条口径的回归门。
 */

const TIME = "2026/11/26 23:32:01";

describe("账号状态通知邮件：只报时间，不报操作者", () => {
  it("停用通知带上状态与生效时间", () => {
    const html = generateAccountSuspendedEmailHtml("alice", TIME);

    expect(html).toContain("alice");
    expect(html).toContain("账号已被停用");
    expect(html).toContain("操作时间");
    expect(html).toContain(TIME);
    // 占位符必须全部被替换掉，否则邮件里会出现 {{xxx}}。
    expect(html).not.toMatch(/\{\{\w+\}\}/);
  });

  it("停用通知不含处置原因与操作者的 IP / 设备环境", () => {
    const html = generateAccountSuspendedEmailHtml("alice", TIME);

    for (const leaked of ["由管理员", "根据平台规则", "IP 地址", "设备/环境", "Mozilla/", "未知设备"]) {
      expect(html).not.toContain(leaked);
    }
  });

  it("恢复通知同样只报生效时间（不写「系统管理后台 / 系统自动执行」这类操作者行）", () => {
    const html = generateAccountRestoredEmailHtml("alice", TIME);

    expect(html).toContain("账号已恢复使用");
    expect(html).toContain(TIME);
    expect(html).not.toContain("IP 地址");
    expect(html).not.toContain("设备/环境");
    expect(html).not.toContain("系统自动执行");
    expect(html).not.toMatch(/\{\{\w+\}\}/);
  });
});
