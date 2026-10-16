import { useCallback, useEffect, useRef, useState } from "react";
import { FaDownload, FaFileArchive } from "react-icons/fa";
import { cn } from "../../utils/cn";
import { studioGhostButtonClassName, studioPanelClassName, studioSubPanelClassName } from "../studioTheme";
import {
  createGeoGebraExportJob,
  downloadGeoGebraAsset,
  getGeoGebraExportJob,
  listGeoGebraExportCapabilities,
} from "../../api/geogebra";
import type { GeoGebraExportCapability, GeoGebraExportFormat, GeoGebraJob, GeoGebraLocalProject } from "../../types/geogebra";

// 异步导出面板（GEO-21）。
//
// 关键取舍：**只列出服务端真能产出的格式**。渲染类格式（SVG/PDF/GIF/MP4/PPTX）在目标端
// 由画布自身完成，这里如实标注为「画布侧」，而不是给一个点了必然失败的按钮。
// 能力清单来自服务端 /exports/capabilities，前端不硬编码第二份判断。
const POLL_INTERVAL_MS = 2_500;
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "expired"]);

type Props = {
  project: GeoGebraLocalProject | null;
};

export default function GeoGebraExportPanel({ project }: Props) {
  const [capabilities, setCapabilities] = useState<GeoGebraExportCapability[]>([]);
  const [format, setFormat] = useState<GeoGebraExportFormat>("zip-bundle");
  const [job, setJob] = useState<GeoGebraJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const pollRef = useRef<number | null>(null);

  const serverSideFormats = capabilities.filter((item) => item.serverSide);
  const canvasSideFormats = capabilities.filter((item) => !item.serverSide);

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    void listGeoGebraExportCapabilities()
      .then((items) => {
        if (!active) return;
        setCapabilities(items);
        const firstServerSide = items.find((item) => item.serverSide);
        if (firstServerSide) setFormat(firstServerSide.format);
      })
      .catch(() => { if (active) setError("导出能力暂时无法读取。"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    stopPolling();
    setJob(null);
  }, [project?.projectId, stopPolling]);

  useEffect(() => {
    if (!job || TERMINAL_STATUSES.has(job.status)) {
      stopPolling();
      return undefined;
    }
    pollRef.current = window.setInterval(() => {
      void getGeoGebraExportJob(job.jobId).then(setJob).catch(() => {
        stopPolling();
        setError("导出状态暂时无法刷新。");
      });
    }, POLL_INTERVAL_MS);
    return () => stopPolling();
  }, [job, stopPolling]);

  const handleCreate = async () => {
    if (!project || busy) {
      if (!project) setError("请先创建或打开一个项目。");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const created = await createGeoGebraExportJob(project.projectId, format);
      setJob(created);
      setNotice("已提交打包，完成后可在下方下载。");
    } catch (caught) {
      const status = (caught as { response?: { status?: number } })?.response?.status;
      setError(status === 409 ? "该格式不在服务端能力范围内，请用画布自身导出。" : "暂时无法提交导出，请稍后重试。");
    } finally {
      setBusy(false);
    }
  };

  const handleDownload = async () => {
    const assetId = job?.result?.assetId;
    if (!assetId) return;
    try {
      const file = await downloadGeoGebraAsset(assetId);
      const url = URL.createObjectURL(file);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${project?.title ?? "geogebra"}-bundle.zip`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch {
      setError("下载失败，请在有效期内重试。");
    }
  };

  return (
    <section className={studioPanelClassName} aria-labelledby="geogebra-export-heading">
      <div className="mb-3">
        <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">Export</p>
        <h2 id="geogebra-export-heading" className="mt-1 text-lg font-semibold text-slate-900">导出</h2>
        <p className="mt-1 text-sm text-slate-500">画布上的 PNG / GGB / 脚本文本可直接导出；需要打包归档时用下面的后台任务。</p>
      </div>

      {loading ? <p role="status" className="text-sm text-slate-500">正在读取可用格式…</p> : (
        <div className="space-y-3">
          <div className={studioSubPanelClassName}>
            <h3 className="text-sm font-semibold text-slate-900">服务端打包</h3>
            {serverSideFormats.length ? (
              <div className="mt-2 flex flex-wrap items-end gap-2">
                <label className="text-xs font-semibold text-slate-600">
                  格式
                  <select
                    className="mt-1 block min-h-11 rounded-2xl border border-slate-200 bg-white px-3 text-sm text-slate-700"
                    value={format}
                    onChange={(event) => setFormat(event.target.value as GeoGebraExportFormat)}
                  >
                    {serverSideFormats.map((item) => <option key={item.format} value={item.format}>{item.format}</option>)}
                  </select>
                </label>
                <button type="button" onClick={() => void handleCreate()} disabled={busy || !project} className={studioGhostButtonClassName}>
                  <FaFileArchive /> {busy ? "提交中…" : "开始打包"}
                </button>
              </div>
            ) : <p className="mt-2 text-sm text-slate-500">服务端暂不提供打包格式。</p>}
            {serverSideFormats[0] && <p className="mt-2 text-xs text-slate-500">{serverSideFormats.find((item) => item.format === format)?.note}</p>}
          </div>

          {canvasSideFormats.length > 0 && (
            <div className={studioSubPanelClassName}>
              <h3 className="text-sm font-semibold text-slate-900">由画布侧完成</h3>
              <ul className="mt-2 space-y-1 text-xs text-slate-600">
                {canvasSideFormats.map((item) => (
                  <li key={item.format}><span className="font-semibold text-slate-700">{item.format}</span>：{item.note}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {error && <p role="alert" className="mt-3 rounded-2xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}
      {notice && !error && <p role="status" aria-live="polite" className="mt-3 rounded-2xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{notice}</p>}

      {job && (
        <div className={cn(studioSubPanelClassName, "mt-3")}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-semibold text-slate-800">打包任务</span>
            <span className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs text-slate-600">
              {job.status === "queued" ? "排队中" : job.status === "running" ? "处理中" : job.status === "completed" ? "已完成" : job.status === "cancelled" ? "已取消" : job.status === "expired" ? "已过期" : "未完成"}
            </span>
          </div>
          {job.status === "failed" && <p className="mt-2 text-sm text-rose-700">{job.errorMessage ?? "打包未完成，请重试。"}</p>}
          {job.result?.summary && <p className="mt-2 text-sm text-slate-700">{job.result.summary}</p>}
          {job.result?.notes?.length ? <ul className="mt-1 list-disc space-y-1 pl-5 text-xs text-slate-600">{job.result.notes.map((note) => <li key={note}>{note}</li>)}</ul> : null}
          {job.result?.assetId && (
            <button type="button" onClick={() => void handleDownload()} className={cn(studioGhostButtonClassName, "mt-2")}>
              <FaDownload /> 下载打包文件
            </button>
          )}
        </div>
      )}
    </section>
  );
}
