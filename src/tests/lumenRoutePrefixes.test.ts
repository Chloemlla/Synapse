import "./helpers/mockAppSecurityBoundaries";
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import request from "supertest";
import app from "../app";
import { LUMEN_API_PREFIXES } from "../routes/lumen/index";

/**
 * 回归：Lumen 必须同时挂在 `/api/lumen` 与 `/api/lumen/v1` 上。
 *
 * 背景（2026-11-11 生产排障）：已发布的 Project-Lumen 安装包按 `/api/lumen/v1/<resource>`
 * 拼请求（它的后端原本就是 `/api/v1/...`，迁到 Synapse 时只换了基址），而服务端只挂
 * `/api/lumen`，于是除 `health` 之外**每一个**业务请求都落到 Express 兜底 404：
 * 响应体是 `{"error":"Not Found"}`（`error` 是字符串，客户端取不到 message），
 * 表现成一句毫无线索的 "Project Lumen API request failed with HTTP 404"。
 *
 * 这条用例不碰 Mongo：`/api/lumen/health` 与平台静态 spec `/api/lumen/openapi.json`
 * 都不查库，正好用来证明“前缀真的挂上了”（404 与 200 的差别就足够）。
 */
describe("Lumen 挂载前缀", () => {
  const previousLumenEnabled = process.env.LUMEN_ENABLED;

  beforeAll(() => {
    // 闸门（fail-closed 503）按请求读环境变量，所以在这里打开即可，不必重载模块。
    process.env.LUMEN_ENABLED = "true";
  });

  afterAll(() => {
    if (previousLumenEnabled === undefined) {
      delete process.env.LUMEN_ENABLED;
    } else {
      process.env.LUMEN_ENABLED = previousLumenEnabled;
    }
  });

  it("两个前缀都暴露 health", async () => {
    for (const prefix of LUMEN_API_PREFIXES) {
      const response = await request(app).get(`${prefix}/health`).expect(200);
      expect(response.body).toMatchObject({ status: "ok", service: "project-lumen-api" });
    }
  });

  it("兼容前缀下的业务路由不会落到 404", async () => {
    for (const prefix of LUMEN_API_PREFIXES) {
      const response = await request(app).get(`${prefix}/openapi.json`).expect(200);
      expect(response.body).toMatchObject({ openapi: "3.0.3" });
    }
  });

  it("未知的第三套前缀仍然是 404（别名不是通配）", async () => {
    const response = await request(app).get("/api/lumen/v2/health");
    expect(response.status).toBe(404);
  });
});
