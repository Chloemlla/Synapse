import { pixelCdkMappingService } from "./cdkMappingService";
import { getPixelIntegrationConfigView } from "./integrationConfigService";
import { pixelLimitsFromEnv } from "./runtime";
import { pixelTaskAccessStore } from "./taskAccessStore";
import { pixelUsageLogService } from "./usageLogService";
import type { PixelAdminDashboardView } from "./types";

/**
 * Pixel 管理总览（PIX-14）。
 *
 * 只报**可验证**的数字：映射计数、脱敏溯源的计数/聚合、按本地提交状态的任务计数、
 * 以及「上游是否已配置」这个开关态。没有数据源就显式 `null` + 原因，不虚构指标：
 *   · proxy / worker / queue：仓库里没有这三类运行时组件（上游是请求内直连、任务在请求进程内
 *     执行、没有本地队列），因此固定 null，并在 unavailableReasons 里写明为什么没有；
 *   · errors / latency / requestSize：来自 `pixel_usage_logs` 的真实聚合，没有样本时
 *     返回 null + 原因，而不是 0。
 */
export async function getPixelAdminDashboard(): Promise<PixelAdminDashboardView> {
  const [config, mappings, usage, tasks, metrics] = await Promise.all([
    getPixelIntegrationConfigView(),
    pixelCdkMappingService.stats(),
    pixelUsageLogService.stats(),
    pixelTaskAccessStore.countBySubmitState(),
    pixelUsageLogService.metrics(),
  ]);

  let host = "";
  if (config.upstreamBaseUrl) {
    try {
      host = new URL(config.upstreamBaseUrl).hostname;
    } catch {
      host = "";
    }
  }

  return {
    config: {
      configured: config.configured,
      enabled: config.enabled,
      host,
      source: config.source,
      reload: config.reload,
    },
    mappings,
    usage: {
      ...usage,
      // 典量保留期要让管理员看得见（它在环境变量里），否则没人知道溯源什么时候会过期。
      retentionDays: pixelLimitsFromEnv().usageLogRetentionDays,
    },
    tasks: {
      total: tasks.total,
      bySubmitState: tasks.bySubmitState,
    },
    runtime: {
      upstream: {
        configured: config.configured,
        enabled: config.enabled,
        host,
        source: config.source,
        reload: config.reload,
      },
      proxy: null,
      worker: null,
      queue: null,
      unavailableReasons: {
        proxy: "Pixel 上游调用由服务端在请求内直连，没有独立代理进程，也没有可核对的代理指标。",
        worker: "Pixel 任务在请求进程内同步提交，没有独立 worker 进程登记表，无法给出 worker 指标。",
        queue: "Pixel 没有本地任务队列：提交直接发往上游，排队位以上游返回为准，因此没有本地队列深度可报（本地提交态见任务分布）。",
      },
    },
    metrics: {
      errors: metrics.errors,
      latency: metrics.latency,
      requestSize: metrics.requestSize,
      unavailableReasons: metrics.unavailableReasons,
    },
  };
}
