import { beforeEach, describe, expect, it, jest } from "@jest/globals";

/**
 * `/api/tickets/admin/insights` 的服务端契约（页面 `/admin/tickets` 的质量与 SLA 页签）。
 *
 * 三条口径必须有测试钉住，否则面板会给出错误结论：
 *   1. 分位取不到时返回 null（不是 0 —— 0 会被读成「首响 0 小时」）；
 *   2. SLA 只统计「未关闭且最后一条是用户发言」的工单；
 *   3. 窗口参数被钳在 1..180 天，非法/零值回落默认 30 天。
 */

jest.mock("../utils/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// 只用到 SLA 常量：直接给字面量，避免把整个写路径（用户服务、运行时配置）拖进单测。
jest.mock("../services/ticketWorkflowService", () => ({
  TICKET_SLA_HOURS: 24,
}));

const mockAggregate = jest.fn();
jest.mock("../models/ticketModel", () => ({
  TicketModel: {
    aggregate: (...args: unknown[]) => mockAggregate(...args),
  },
}));

import { computeTicketInsights } from "../services/ticketInsightsService";

function aggregateChain(result: unknown) {
  return { exec: jest.fn().mockResolvedValue(result) };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("computeTicketInsights", () => {
  it("分位取不到时返回 null，不返回 0", async () => {
    mockAggregate.mockImplementation(() => aggregateChain([]));

    const result = await computeTicketInsights({ windowDays: 30 });

    expect(result.firstResponse.p50Hours).toBeNull();
    expect(result.firstResponse.p95Hours).toBeNull();
    expect(result.resolution.p50Hours).toBeNull();
    expect(result.firstResponse.samples).toBe(0);
    expect(result.csat.average).toBeNull();
  });

  it("窗口参数钳在 1..180 天，趋势条数与窗口一致", async () => {
    mockAggregate.mockImplementation(() => aggregateChain([]));

    const tooBig = await computeTicketInsights({ windowDays: 9999 });
    expect(tooBig.windowDays).toBe(180);
    expect(tooBig.trend).toHaveLength(180);

    // 0 / 非法值回落默认 30 天，而不是被钳成 1 天（1 天的 SLA 面板没有意义）。
    const zero = await computeTicketInsights({ windowDays: 0 });
    expect(zero.windowDays).toBe(30);
  });

  it("SLA 聚合只看未关闭且最后一条是用户发言的工单", async () => {
    mockAggregate.mockImplementation((pipeline: unknown) => {
      const serialized = JSON.stringify(Array.isArray(pipeline) ? pipeline : []);
      if (serialized.includes('"breached"')) {
        return aggregateChain([{ evaluated: 12, breached: 3, atRisk: 4 }]);
      }
      return aggregateChain([]);
    });

    const result = await computeTicketInsights({ windowDays: 7 });

    const slaPipeline = mockAggregate.mock.calls
      .map((call) => JSON.stringify(call[0] ?? []))
      .find((text) => text.includes('"breached"'));
    expect(slaPipeline).toBeDefined();
    expect(slaPipeline).toContain('"$eq":["$tail.senderRole","user"]');
    expect(slaPipeline).toContain('"$ne":["closed"');

    expect(result.sla).toEqual({ breached: 3, atRisk: 4, evaluated: 12, slaHours: 24 });
  });

  it("有分位数据时原样透传（首响保留两位小数）", async () => {
    mockAggregate.mockImplementation((pipeline: unknown) => {
      const serialized = JSON.stringify(Array.isArray(pipeline) ? pipeline : []);
      if (serialized.includes("firstResponseAt")) {
        return aggregateChain([{ samples: 10, p: [3.14159, 12.0, 20.5] }]);
      }
      if (serialized.includes("resolvedAt") && serialized.includes("$percentile")) {
        return aggregateChain([{ samples: 8, p: [1.5, 5, 9] }]);
      }
      return aggregateChain([]);
    });

    const result = await computeTicketInsights({ windowDays: 30 });

    expect(result.firstResponse.p50Hours).toBe(3.14);
    expect(result.firstResponse.p90Hours).toBe(12);
    expect(result.firstResponse.samples).toBe(10);
    expect(result.resolution.p50Hours).toBe(1.5);
  });
});
