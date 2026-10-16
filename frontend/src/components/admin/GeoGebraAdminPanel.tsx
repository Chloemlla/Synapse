import React, { useCallback, useEffect, useState } from "react";
import { FaBroom, FaChartBar, FaComments, FaFileAlt, FaFolderOpen, FaShareAlt, FaSync } from "react-icons/fa";
import { getGeoGebraAdminOverview, runGeoGebraMaintenance, type GeoGebraAdminOverview } from "@/api/geogebraAdmin";
import { InfoBadge, InfoMetricCard, InfoPanel, InfoQueryHero, InfoQueryShell } from "@/components/studioTheme";
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
              className="min-h-11 rounded-2xl border border-slate-200 bg-white px-3 text-sm text-slate-700"
              value={refreshMs}
              onChange={(event) => setRefreshMs(Number(event.target.value))}
              aria-label="自动刷新间隔"
            >
              {REFRESH_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
            <button type="button" onClick={() => void load()} disabled={loading} className="min-h-11 rounded-2xl border border-slate-200 bg-white px-4 text-sm font-semibold text-slate-700 hover:border-slate-300">
              <FaSync className={cn("mr-2 inline", loading && "animate-spin")} />刷新
            </button>
            <button type="button" onClick={() => void handleMaintenance()} disabled={maintaining} className="min-h-11 rounded-2xl border border-slate-200 bg-white px-4 text-sm font-semibold text-rose-700 hover:border-rose-200 hover:bg-rose-50">
              <FaBroom className="mr-2 inline" />{maintaining ? "清理中…" : "清理过期资源"}
            </button>
          </div>
        )}
      />

      {error && <p role="alert" className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</p>}
      {loading && !overview && <p role="status" className="text-sm text-slate-500">正在读取运行概览…</p>}

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

          <InfoPanel>
            <h3 className="text-sm font-semibold text-slate-900">异步任务</h3>
            {Object.keys(overview.jobsByStatus).length === 0
              ? <p className="mt-2 text-sm text-slate-500">还没有任务记录。</p>
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
              ? <p className="mt-2 text-sm text-slate-500">还没有公开分享。</p>
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
            <h3 className="text-sm font-semibold text-slate-900">延迟与体积指标</h3>
            <p className="mt-2 text-sm text-slate-500">{overview.metrics.unavailableReason}</p>
          </InfoPanel>
        </div>
      )}
    </InfoQueryShell>
  );
};

export default GeoGebraAdminPanel;
