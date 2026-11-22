import { api, getApiBaseUrl } from './api';

/**
 * 工单管理页（`/admin/tickets`）的质量与 SLA 只读客户端。
 *
 * 列表、统计、批量、CSAT 等走既有的 `ticketApi`（同一份契约）；这里只补管理端独有的
 * 聚合端点 `GET /api/tickets/admin/insights`，避免把两套工单契约拆开维护。
 *
 * 权限：`admin` + 页面授权 `tickets`；工单写操作仍由路由层 `authenticateSuperAdmin` 收口。
 */

export interface TicketInsightsResponse {
  windowDays: number;
  firstResponse: { p50Hours: number | null; p90Hours: number | null; p95Hours: number | null; samples: number };
  resolution: { p50Hours: number | null; p90Hours: number | null; p95Hours: number | null; samples: number };
  sla: { breached: number; atRisk: number; evaluated: number; slaHours: number };
  csat: { average: number | null; count: number; low: number; distribution: Record<string, number> };
  volumeByService: Record<string, number>;
  volumeByCategory: Record<string, number>;
  trend: Array<{ date: string; created: number; resolved: number }>;
  slaBreachTop: Array<{
    id: string;
    title: string;
    status: string;
    priority: string;
    assigneeName: string | null;
    waitingHours: number | null;
    createdAt: string | null;
  }>;
  lowCsatTop: Array<{
    id: string;
    title: string;
    status: string;
    csatRating: number | null;
    csatComment: string | null;
    assigneeName: string | null;
    resolvedAt: string | null;
  }>;
  assignees: Array<{
    assigneeId: string;
    assigneeName: string | null;
    open: number;
    awaitingReply: number;
    resolvedInWindow: number;
    avgFirstResponseHours: number | null;
    csatAverage: number | null;
    csatCount: number;
  }>;
}

export const ticketInsightsApi = {
  insights: async (windowDays = 30): Promise<TicketInsightsResponse> => {
    const res = await api.get(`${getApiBaseUrl()}/api/tickets/admin/insights`, { params: { windowDays } });
    return res.data;
  },
};
