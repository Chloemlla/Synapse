import { pixelCdkMappingService } from "./cdkMappingService";
import { getPixelIntegrationConfigView } from "./integrationConfigService";
import { pixelLimitsFromEnv } from "./runtime";
import { pixelTaskAccessStore } from "./taskAccessStore";
import { pixelUsageLogService } from "./usageLogService";
import type { PixelAdminDashboardView } from "./types";

/**
 * Pixel 管理总览（PIX-14 的 Phase 4 子集）。
 *
 * 只报**可验证**的数字：映射计数、脱敏溯源的计数与最近时间、按本地提交状态的任务计数、
 * 以及「上游是否已配置」这个开关态。没有数据源就不报数（configured=false / 计数为 0），
 * 不从别的模块拼一个看起来像指标的假数字（PRD PIX-14）。
 */
export async function getPixelAdminDashboard(): Promise<PixelAdminDashboardView> {
  const [config, mappings, usage, tasks] = await Promise.all([
    getPixelIntegrationConfigView(),
    pixelCdkMappingService.stats(),
    pixelUsageLogService.stats(),
    pixelTaskAccessStore.countBySubmitState(),
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
  };
}
