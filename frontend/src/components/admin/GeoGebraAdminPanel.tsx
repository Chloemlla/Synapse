import React, { useCallback, useEffect, useState } from "react";
import { FaBroom, FaChartBar, FaComments, FaFileAlt, FaFolderOpen, FaShareAlt, FaSync } from "react-icons/fa";
import { getGeoGebraAdminOverview, runGeoGebraMaintenance, type GeoGebraAdminOverview } from "@/api/geogebraAdmin";
import { InfoBadge, InfoMetricCard, InfoPanel, InfoQueryHero, InfoQueryShell, studioDangerButtonClassName, studioFieldClassName, studioSecondaryButtonClassName } from "@/components/studioTheme";
import { StudioEmptyState, StudioErrorNote, StudioErrorState, StudioLoadingState } from "@/components/studioFeedback";
import { useNotification } from "@/components/Notification";
import { cn } from "@/lib/utils";

// GeoGebra 诊断面板（GEO-22 / GEO-24）。
// 只展示服务端真实能给出的数据；延迟/体积分位没有数据源时按「无数据」渲染，不编造数字。
const REFRESH_OPTIONS = [
  { value: 0, label: "手动刷新" },
  { value: 15_000, label: "15 秒" },
  { value: 60_000, label: "1 分钟" },
];

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  if (minutes > 0) return `${minutes} 分 ${seconds % 60} 秒`;
  return `${seconds} 秒`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

const GeoGebraAdminPanel: React.FC = () => {
  const { setNotification } = useNotification();
  const [overview, setOverview] = useState<GeoGebraAdminOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refreshMs, setRefreshMs] = useState(0);
  const [maintaining, setMaintaining] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setOverview(await getGeoGebraAdminOverview());
    } catch {
      setError("暂时无法读取 GeoGebra 运行概览。");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!refreshMs) return undefined;
    const timer = window.setInterval(() => { void load(); }, refreshMs);
    return () => window.clearInterval(timer);
  }, [load, refreshMs]);

  const handleMaintenance = async () => {
    setMaintaining(true);
    try {
      const result = await runGeoGebraMaintenance();
      setNotification?.({ type: "success", message: `已清理 ${result.removedAssets} 个过期资源，标记 ${result.expiredJobs} 个过期任务。` });
      await load();
    } catch {
      setNotification?.({ type: "error", message: "清理未完成，请稍后重试。" });
    } finally {
      setMaintaining(false);
    }
  };

  return (
    <InfoQueryShell maxWidthClassName="max-w-6xl">
      <InfoQueryHero
        eyebrow="GeoGebra"
        title="GeoGebra 诊断"
        description="工作台的项目、分享、资源与异步任务的运行概览。"
        icon={FaChartBar}
        meta={<InfoBadge tone={overview?.ai.configured ? "emerald" : "amber"}>{overview?.ai.configured ? "AI 已配置" : "AI 未配置"}</InfoBadge>}
        actions={(
          <div className="flex flex-wrap items-center gap-2">
            <select
              className={`${studioFieldClassName} min-h-11 w-auto text-sm sm:min-h-0`}
              value={refreshMs}
              onChange={(event) => setRefreshMs(Number(event.target.value))}
              aria-label="自动刷新间隔"
            >
              {REFRESH_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
            <button
              type="button"
              onClick={() => void load()}
              disabled={loading}
              className={cn(studioSecondaryButtonClassName, 'min-h-11 sm:min-h-0')}
            >
              <FaSync className={cn("mr-2 inline", loading && "animate-spin")} />刷新
            </button>
            <button
              type="button"
              onClick={() => void handleMaintenance()}
              disabled={maintaining}
              className={cn(studioDangerButtonClassName, 'min-h-11 sm:min-h-0')}
            >
              <FaBroom className="mr-2 inline" />{maintaining ? "清理中…" : "清理过期资源"}
            </button>
          </div>
        )}
      />

      {error && !overview ? <StudioErrorState message={error} onRetry={() => void load()} /> : null}
      {error && overview ? (
        <StudioErrorNote className="flex flex-wrap items-center gap-3">
          <span className="min-w-0 flex-1">{error}</span>
          <button type="button" onClick={() => void load()} className={studioSecondaryButtonClassName}>
            重试
          </button>
        </StudioErrorNote>
      ) : null}
      {loading && !overview ? (
        <StudioLoadingState minHeightClassName="min-h-[280px]" text="正在读取运行概览…" />
      ) : null}

      {overview && (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <InfoMetricCard label="项目" value={overview.counts.projects} detail={`版本 ${overview.counts.versions}`} icon={FaFolderOpen} />
            <InfoMetricCard label="分享" value={overview.counts.shares} detail={`有效 ${overview.counts.activeShares}`} icon={FaShareAlt} />
            <InfoMetricCard label="资源" value={overview.counts.assets} detail="到期自动清理" icon={FaFileAlt} />
            <InfoMetricCard label="评论" value={overview.counts.comments} icon={FaComments} />
          </div>

          <InfoPanel>
            <h3 className="text-sm font-semibold text-slate-900">服务状态</h3>
            <dl className="mt-2 grid gap-2 text-sm text-slate-600 sm:grid-cols-2 lg:grid-cols-4">
              <div><dt className="text-xs text-slate-500">运行时长</dt><dd>{formatDuration(overview.service.uptimeSeconds)}</dd></div>
              <div><dt className="text-xs text-slate-500">Mongo</dt><dd>{overview.mongo.state}{overview.mongo.database ? ` · ${overview.mongo.database}` : ""}</dd></div>
              <div><dt className="text-xs text-slate-500">Node</dt><dd>{overview.service.nodeVersion}</dd></div>
              <div><dt className="text-xs text-slate-500">AI 图片能力</dt><dd>{overview.ai.configured ? (overview.ai.vision ? "已开启" : "未开启") : "未配置"}</dd></div>
            </dl>
            {!overview.ai.configured && overview.ai.reason && <p className="mt-2 text-xs text-amber-700">{overview.ai.reason}</p>}
          </InfoPanel>

          {overview.worker && overview.queue && (
            <InfoPanel>
              <h3 className="text-sm font-semibold text-slate-900">任务队列与处理进程</h3>
              <dl className="mt-2 grid gap-2 text-sm text-slate-600 sm:grid-cols-2 lg:grid-cols-4">
                <div><dt className="text-xs text-slate-500">调度方式</dt><dd>{overview.worker.scheduler}</dd></div>
                <div><dt className="text-xs text-slate-500">处理进程</dt><dd>{overview.worker.running ? "运行中" : "未启动"} · PID {overview.worker.pid}</dd></div>
                <div><dt className="text-xs text-slate-500">排队 / 运行中</dt><dd>{overview.queue.queued} / {overview.queue.running}</dd></div>
                <div><dt className="text-xs text-slate-500">单用户并发上限</dt><dd>{overview.queue.maxActiveJobsPerUser}</dd></div>
              </dl>
              <p className="mt-2 text-xs text-slate-500">{overview.queue.note}</p>
            </InfoPanel>
          )}

          {overview.staticAssets && (
            <InfoPanel>
              <h3 className="text-sm font-semibold text-slate-900">静态资源</h3>
              <dl className="mt-2 grid gap-2 text-sm text-slate-600 sm:grid-cols-3">
                <div><dt className="text-xs text-slate-500">有效分享封面</dt><dd>{overview.staticAssets.shareCovers.active} 张</dd></div>
                <div><dt className="text-xs text-slate-500">AI 参考图</dt><dd>{overview.staticAssets.aiReferenceAssets.count} 个 · {formatBytes(overview.staticAssets.aiReferenceAssets.bytes)}</dd></div>
                <div><dt className="text-xs text-slate-500">导出包</dt><dd>{overview.staticAssets.exportBundles.count} 个 · {formatBytes(overview.staticAssets.exportBundles.bytes)}</dd></div>
              </dl>
              <p className="mt-2 text-xs text-slate-500">过期资产由后台定时清理，也可以在右上角手动触发一次清理。</p>
            </InfoPanel>
          )}

          <InfoPanel>
            <h3 className="text-sm font-semibold text-slate-900">异步任务</h3>
            {Object.keys(overview.jobsByStatus).length === 0
              ? <StudioEmptyState className="mt-2 py-8" message="还没有任务记录。在工作台发起一次编辑导出后，任务状态会出现在这里。" />
              : <div className="mt-2 flex flex-wrap gap-2">{Object.entries(overview.jobsByStatus).map(([status, count]) => <InfoBadge key={status}>{status}: {count}</InfoBadge>)}</div>}
            {overview.recentJobs.length > 0 && (
              <ul className="mt-3 space-y-2">
                {overview.recentJobs.map((job) => (
                  <li key={job.jobId} className="rounded-2xl border border-slate-200 bg-white/80 px-3 py-2 text-xs text-slate-600">
                    <span className="font-semibold text-slate-700">{job.kind}</span>
                    <span className="ml-2">{job.status}</span>
                    <span className="ml-2 text-slate-400">{job.owner}</span>
                    {job.errorCode && <span className="ml-2 text-rose-700">{job.errorCode}</span>}
                    <span className="ml-2 text-slate-400">{new Date(job.createdAt).toLocaleString("zh-CN")}</span>
                  </li>
                ))}
              </ul>
            )}
          </InfoPanel>

          <InfoPanel>
            <h3 className="text-sm font-semibold text-slate-900">最近分享</h3>
            {overview.recentShares.length === 0
              ? <StudioEmptyState className="mt-2 py-8" message="还没有公开分享。在工作板里点「分享」生成链接后会出现在这里。" />
              : <ul className="mt-3 space-y-2">{overview.recentShares.map((share) => (
                <li key={share.shareId} className="rounded-2xl border border-slate-200 bg-white/80 px-3 py-2 text-xs text-slate-600">
                  <span className="font-semibold text-slate-700">{share.title}</span>
                  <span className="ml-2 text-slate-400">{share.slug}</span>
                  <span className="ml-2">{share.commandCount} 条指令</span>
                  <span className="ml-2 text-slate-400">{share.owner}</span>
                  {share.revoked && <span className="ml-2 text-rose-700">已撤销</span>}
                </li>
              ))}</ul>}
          </InfoPanel>

          <InfoPanel>
            <h3 className="text-sm font-semibold text-slate-900">最近资源</h3>
            {(overview.recentAssets ?? []).length === 0
              ? <StudioEmptyState className="mt-2 py-8" message="还没有资源记录。AI 参考图与导出包只保留到各自有效期。" />
              : <ul className="mt-3 space-y-2">{(overview.recentAssets ?? []).map((asset) => (
                <li key={asset.assetId} className="rounded-2xl border border-slate-200 bg-white/80 px-3 py-2 text-xs text-slate-600">
                  <span className="font-semibold text-slate-700">{asset.purpose}</span>
                  <span className="ml-2">{asset.mimeType}</span>
                  <span className="ml-2">{formatBytes(asset.byteSize)}</span>
                  <span className="ml-2 text-slate-400">{asset.owner}</span>
                  <span className="ml-2 text-slate-400">到期 {new Date(asset.expiresAt).toLocaleString("zh-CN")}</span>
                </li>
              ))}</ul>}
          </InfoPanel>

          <InfoPanel>
            <h3 className="text-sm font-semibold text-slate-900">延迟与体积指标</h3>
            <StudioEmptyState className="mt-2 py-8" message={overview.metrics.unavailableReason} />
          </InfoPanel>
        </div>
      )}
    </InfoQueryShell>
  );
};

export default GeoGebraAdminPanel;
