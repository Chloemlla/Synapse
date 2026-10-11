import { describe, expect, it, jest } from "@jest/globals";
import type { NextFunction, Request, Response } from "express";

/**
 * WAF 对邮件 API 的**字段级**白名单回归（RC-48）。
 *
 * 背景（审计原文纠正后的事实）：邮件系统的 body 天然携带 HTML（`html` / `text` / `content`），
 * 而 WAF 会扫描 body 字段找注入特征。之前有人主张给 `/api/email`、`/api/outemail` 加**前缀级**
 * 豁免，那等于把这两个端点完全暴露在超大 body、CRLF 注入、模板注入下。
 *
 * 实测结论：**不需要前缀豁免** —— WAF 已有字段级白名单（`html`/`text`/`content`/…）。
 * 本用例把这份“口头约定”钉成回归：
 * 1. fork-sync 形状的邮件 HTML（内联 style、rgba()、role=presentation 表格、<code style=…>）**不被拦**；
 * 2. 未在白名单里的字段（`to`/`subject`）**仍被扫描** —— 这正是 CRLF / 邮件头注入的拦截面；
 * 3. 路径级豁免**不存在**（`/api/outemail/send` 仍会走 WAF）。
 */

jest.mock("../utils/logger", () => ({
  __esModule: true,
  default: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { wafMiddleware, isWafBypassPath } from "../middleware/wafMiddleware";

function makeReq(overrides: Partial<Request>): Request {
  return {
    path: "/api/outemail/send",
    method: "POST",
    ip: "203.0.113.10",
    body: {},
    query: {},
    headers: {},
    ...overrides,
  } as unknown as Request;
}

function makeRes() {
  const status = jest.fn();
  const json = jest.fn();
  const res = { status: status.mockReturnThis(), json } as unknown as Response;
  return { res, status, json };
}

/** 与 fork-sync 的 `send.mjs` 同形状的邮件 HTML（内联 style / rgba / 表格 / code）。 */
const FORK_SYNC_HTML = [
  '<table role="presentation" width="100%" style="box-shadow:0 18px 60px rgba(15,23,42,0.28); border-collapse:collapse">',
  '<tr><td style="padding:24px 28px; background:#0f172a; color:#e2e8f0">',
  "<h1 style=\"margin:0; font-size:20px\">Synapse 上游同步报告</h1>",
  '<p style="margin:8px 0 0">本次合并 <code style="background:rgba(255,255,255,0.12); padding:2px 6px">142</code> 个冲突路径。</p>',
  "</td></tr></table>",
  '<a href="https://chloemlla.com/admin">查看详情</a>',
].join("");

describe("WAF × 邮件字段白名单（RC-48）", () => {
  it("fork-sync 形状的 HTML 正文（html/text/content）不被拦", () => {
    const { res, status } = makeRes();
    const next = jest.fn() as unknown as NextFunction;

    wafMiddleware(
      makeReq({
        body: {
          to: "ops@example.com",
          subject: "上游同步报告",
          content: FORK_SYNC_HTML,
          html: FORK_SYNC_HTML,
          text: "上游同步报告：本次合并 142 个冲突路径。",
        },
      }),
      res,
      next,
    );

    expect(status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("未在白名单里的字段仍被扫描：`to` / `subject` 里的注入特征会被拦", () => {
    const next = jest.fn() as unknown as NextFunction;

    const first = makeRes();
    wafMiddleware(
      makeReq({ body: { to: "ops@example.com' OR 1=1 --", subject: "hi", content: FORK_SYNC_HTML } }),
      first.res,
      next,
    );
    expect(first.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();

    const second = makeRes();
    const next2 = jest.fn() as unknown as NextFunction;
    wafMiddleware(
      makeReq({ body: { to: "ops@example.com", subject: "<script>alert(1)</script>", content: FORK_SYNC_HTML } }),
      second.res,
      next2,
    );
    expect(second.status).toHaveBeenCalledWith(400);
    expect(next2).not.toHaveBeenCalled();
  });

  it("邮件路径没有前缀级豁免（豁免是字段级、不是整段绕过）", () => {
    expect(isWafBypassPath("/api/email")).toBe(false);
    expect(isWafBypassPath("/api/outemail/send")).toBe(false);
    // 既有的 4 条前缀豁免仍生效（登录/注册/webhook/采集上报）
    expect(isWafBypassPath("/api/auth/login")).toBe(true);
    expect(isWafBypassPath("/api/data-collection")).toBe(true);
  });
});
