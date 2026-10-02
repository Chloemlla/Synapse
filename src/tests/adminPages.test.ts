import { describe, expect, it } from "@jest/globals";
import {
  ADMIN_PAGES,
  DEFAULT_PLAIN_ADMIN_PAGES,
  getAdminPage,
  getApiPrefixesForPages,
  isAdminPageApiPath,
  isAdminPathAllowedForPages,
  isKnownAdminPage,
  listAdminPageKeys,
  normalizeAdminScopePath,
  normalizeGrantedPages,
  pagesWithoutApiScope,
  resolveAdminPagesForPath,
} from "../config/adminPages";

/**
 * 管理页面登记表与授权解析的契约。
 * 这里只测纯函数：登记表是权限判定的唯一数据源，写错一条会让页面在运行时 403，
 * 所以把「默认集合不变」「前缀匹配语义」「总览始终可见」几条钉死。
 */
describe("adminPages 登记表", () => {
  it("默认普通管理员页面保持历史行为（用户管理 / API Key / 计费 / OAuth）", () => {
    expect([...DEFAULT_PLAIN_ADMIN_PAGES]).toEqual(["users", "apikeys", "apikey-billing", "oauth"]);
  });

  it("默认页面都在登记表里，且都有 API 范围（否则默认授权就是空壳）", () => {
    for (const key of DEFAULT_PLAIN_ADMIN_PAGES) {
      const page = getAdminPage(key);
      expect(page).toBeDefined();
      expect(page!.apiPrefixes.length).toBeGreaterThan(0);
    }
    expect(pagesWithoutApiScope(DEFAULT_PLAIN_ADMIN_PAGES)).toEqual([]);
  });

  it("页面 key 唯一，总览页不需要 API 范围", () => {
    const keys = listAdminPageKeys();
    expect(new Set(keys).size).toBe(keys.length);
    expect(getAdminPage("dashboard")?.apiPrefixes).toEqual([]);
    expect(isKnownAdminPage("dashboard")).toBe(true);
    expect(isKnownAdminPage("no-such-page")).toBe(false);
    expect(ADMIN_PAGES.every((page) => Boolean(page.label))).toBe(true);
  });

  it("前缀是「相等或以 / 开头」的匹配，不会前缀误伤同前缀兄弟路径", () => {
    expect(isAdminPageApiPath("users", "/api/admin/users")).toBe(true);
    expect(isAdminPageApiPath("users", "/api/admin/users/u-1")).toBe(true);
    expect(isAdminPageApiPath("users", "/api/admin/users-export")).toBe(false);
    expect(isAdminPageApiPath("apikeys", "/api/apikeys")).toBe(true);
    expect(isAdminPageApiPath("apikeys", "/api/apikeys/key/revoke")).toBe(true);
    expect(isAdminPageApiPath("apikeys", "/api/apikeysomething")).toBe(false);
  });

  it("按路径反查所属页面（403 里用于提示需要开哪个页面）", () => {
    expect(resolveAdminPagesForPath("/api/admin/users/u-1")).toEqual(["users"]);
    expect(resolveAdminPagesForPath("/api/admin/audit-logs?page=1")).toEqual(["audit-log"]);
    expect(resolveAdminPagesForPath("/api/admin/media-tool/jobs")).toEqual(["media-tool"]);
    // 两个页面共用同一前缀时都算命中（EcoEnchants 授权与远程运维）。
    expect(resolveAdminPagesForPath("/api/ecoenchants/v1/admin/plans").sort()).toEqual([
      "ecoenchants",
      "ecoenchants-ops",
    ]);
    expect(resolveAdminPagesForPath("/api/admin/verify-access")).toEqual([]);
  });

  it("授权集合判定：命中任一所授页面的前缀即放行", () => {
    expect(isAdminPathAllowedForPages("/api/admin/users", ["users"])).toBe(true);
    expect(isAdminPathAllowedForPages("/api/admin/users", ["audit-log"])).toBe(false);
    expect(isAdminPathAllowedForPages("/api/admin/users", ["audit-log", "users"])).toBe(true);
    // 未登记的页面 key 不影响判定（不带任何前缀）。
    expect(isAdminPathAllowedForPages("/api/admin/users", ["some-future-page"])).toBe(false);
    expect(isAdminPathAllowedForPages("/api/admin/users", [])).toBe(false);
  });

  it("授予集合规整：去重去空、总览始终在列、未知 key 保留（新功能先于登记表）", () => {
    expect(normalizeGrantedPages(["users", "users", "", "  ", 42, null])).toEqual(["dashboard", "users"]);
    expect(normalizeGrantedPages([])).toEqual(["dashboard"]);
    expect(normalizeGrantedPages(["future-page"])).toEqual(["dashboard", "future-page"]);
    expect(normalizeGrantedPages(["  audit-log  "])).toEqual(["dashboard", "audit-log"]);
  });

  it("未登记 API 范围的页面能被识别出来（配置界面据此提示授权暂时无效）", () => {
    expect(pagesWithoutApiScope(["env", "users"])).toEqual(["env"]);
    expect(pagesWithoutApiScope(["users", "oauth"])).toEqual([]);
  });

  it("路径归一与守卫共用同一套语义", () => {
    expect(normalizeAdminScopePath("//api//admin/users//?a=1")).toBe("/api/admin/users");
    expect(getApiPrefixesForPages(["users"])).toEqual(["/api/admin/users"]);
    expect(getApiPrefixesForPages(["users", "users"])).toEqual(["/api/admin/users"]);
    // 默认集合汇总出的前缀就是守卫在无配置时的放行集合。
    expect(getApiPrefixesForPages(DEFAULT_PLAIN_ADMIN_PAGES).sort()).toEqual([
      "/api/admin/apikey-billing",
      "/api/admin/users",
      "/api/apikeys",
      "/api/apikeys/billing",
      "/api/oauth",
    ]);
  });
});
