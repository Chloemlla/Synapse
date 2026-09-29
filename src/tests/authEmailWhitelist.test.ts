import { emailPattern } from "../controllers/auth/_state";

/**
 * 邮箱后缀白名单。白名单本身是硬编码的（见 `_state.ts` 的 `allowedDomainPatterns`），
 * 这里把「哪些域名该被接受 / 哪些形近域名必须被拒」钉住，防止以后有人改动那串
 * 正则片段时把转义弄丢（例如 `gmail.com` 少转义一个点就会放行 `gmailxcom`）。
 */
const allowedDomains = [
  "gmail.com",
  "outlook.com",
  "qq.com",
  "163.com",
  "126.com",
  "hotmail.com",
  "yahoo.com",
  "icloud.com",
  "foxmail.com",
  "chloemlla.com",
];

describe("emailPattern（主流邮箱后缀白名单）", () => {
  it.each(allowedDomains)("接受 user@%s", (domain) => {
    expect(emailPattern.test(`user@${domain}`)).toBe(true);
  });

  it("接受带点/下划线/连字符的本地部分", () => {
    expect(emailPattern.test("first.last_1-a@gmail.com")).toBe(true);
  });

  it.each([
    ["形近域名（点号若未转义会误命中）", "user@gmailxcom"],
    ["后缀拼接", "user@gmail.com.evil.com"],
    ["子域名", "user@sub.gmail.com"],
    ["前缀拼接", "user@notgmail.com"],
    ["缺少本地部分", "@gmail.com"],
    ["本地部分含非法字符", "user+tag@gmail.com"],
    ["域名大小写不一致", "user@GMAIL.COM"],
    ["末尾多余字符", "user@gmail.com "],
    ["换行结尾", "user@gmail.com\n"],
  ])("拒绝 %s", (_name, input) => {
    expect(emailPattern.test(input)).toBe(false);
  });
});
