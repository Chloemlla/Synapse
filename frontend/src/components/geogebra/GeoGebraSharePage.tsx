import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { FaCopy, FaDownload, FaShareAlt } from "react-icons/fa";
import { useAuth } from "../../hooks/useAuth";
import getApiBaseUrl from "../../api";
import { forkGeoGebraShare, getGeoGebraShare } from "../../api/geogebra";
import { cn } from "../../utils/cn";
import FeatureConsentGate from "../FeatureConsentGate";
import { studioAccentBlobBlueClassName, studioAccentBlobSkyClassName, studioHeroCardClassName, studioPageClassName, studioPanelClassName, studioPrimaryButtonClassName, studioGhostButtonClassName } from "../studioTheme";
import GeoGebraApplet, { type GeoGebraHandle } from "./GeoGebraApplet";
import GeoGebraEditor from "./GeoGebraEditor";
import { prepareGeoGebraScript } from "./script";
import type { GeoGebraMode, GeoGebraShare } from "../../types/geogebra";

export default function GeoGebraSharePage() {
  const { slug = "" } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [share, setShare] = useState<GeoGebraShare | null>(null);
  const [mode, setMode] = useState<GeoGebraMode>("geometry");
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const appletRef = useRef<GeoGebraHandle | null>(null);
  const commands = useMemo(() => prepareGeoGebraScript(code), [code]);
  const coverSrc = share?.coverUrl ? new URL(share.coverUrl, getApiBaseUrl()).toString() : null;

  useEffect(() => {
    let active = true;
    setLoading(true);
    void getGeoGebraShare(slug).then((next) => {
      if (!active) return;
      setShare(next);
      setMode(next.canvasMode);
      setCode(`${next.commands.join("\n")}\n`);
    }).catch(() => {
      if (active) setError("此分享链接不可用或已撤销。");
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [slug]);

  const run = useCallback(async () => {
    if (!appletRef.current || commands.errors.length || commands.commands.length === 0) {
      setError("当前画布暂时无法运行。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const report = await appletRef.current.run(commands.commands);
      if (report.success) setStatus("画布已更新。");
      else setError(`第 ${report.error?.lineNumber ?? 1} 行暂时无法运行，请检查脚本内容。`);
    } catch {
      setError("画布暂时无法运行，请重试。");
    } finally {
      setBusy(false);
    }
  }, [commands]);

  const download = (value: string | null, name: string) => {
    if (!value) {
      setError("暂时无法导出，请先运行画布后重试。");
      return;
    }
    const anchor = document.createElement("a");
    anchor.href = value;
    anchor.download = name;
    anchor.click();
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setStatus("分享链接已复制。");
    } catch {
      setError("无法复制链接，请从地址栏复制。");
    }
  };

  const fork = async () => {
    if (!user || !share?.allowFork || busy) return;
    setBusy(true);
    setError("");
    try {
      const project = await forkGeoGebraShare(slug);
      navigate(`/geogebra?projectId=${encodeURIComponent(project.projectId)}`);
    } catch {
      setError("暂时无法创建项目副本，请登录并重试。");
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return <div className={studioPageClassName}><div className="mx-auto max-w-7xl"><div className={studioPanelClassName} role="status">正在打开分享…</div></div></div>;
  }
  if (!share) {
    return <div className={studioPageClassName}><div className="mx-auto max-w-3xl"><div className={studioPanelClassName}><p className="text-sm text-slate-600">{error || "此分享链接不可用或已撤销。"}</p><a href="/geogebra" className={cn(studioPrimaryButtonClassName, "mt-4")}>打开 GeoGebra 工作台</a></div></div></div>;
  }

  return (
    <div className={studioPageClassName}>
      <div className="mx-auto w-full max-w-7xl space-y-4 sm:space-y-6">
        <section className={cn("relative overflow-hidden", studioHeroCardClassName)}>
          <div className={cn(studioAccentBlobBlueClassName, "-right-12 top-0")} aria-hidden="true" />
          <div className={cn(studioAccentBlobSkyClassName, "-left-10 bottom-0")} aria-hidden="true" />
          <div className="relative flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-500">GeoGebra Share</p>
              <h1 className="mt-2 break-words text-2xl font-semibold text-slate-900 sm:text-4xl">{share.title}</h1>
              <p className="mt-2 text-sm text-slate-600">打开画布后可运行脚本、查看图形或下载文件。</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => void copyLink()} className={studioGhostButtonClassName}><FaCopy /> 复制链接</button>
              {share.allowFork && user && (
                <FeatureConsentGate feature="geogebra-projects">
                  <button type="button" disabled={busy} onClick={() => void fork()} className={studioPrimaryButtonClassName}><FaShareAlt /> {busy ? "创建中…" : "创建项目副本"}</button>
                </FeatureConsentGate>
              )}
              {share.allowFork && !user && <a href={`/login?redirect=${encodeURIComponent(window.location.pathname)}`} className={studioPrimaryButtonClassName}>登录后创建副本</a>}
            </div>
          </div>
        </section>

        {error && <p role="alert" className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</p>}
        {status && <p role="status" aria-live="polite" className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{status}</p>}
        {coverSrc && <img src={coverSrc} alt="画布预览" className="max-h-64 w-full rounded-2xl border border-slate-200 bg-white object-contain" />}

        <div className="grid min-w-0 gap-4 xl:grid-cols-2">
          <div className="min-w-0">
            <GeoGebraEditor value={code} onChange={() => undefined} onRun={() => void run()} readOnly />
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button type="button" onClick={() => void run()} disabled={busy || commands.errors.length > 0} className={studioPrimaryButtonClassName}>运行画布</button>
              <button type="button" onClick={() => download(appletRef.current?.exportPng() ?? null, "geogebra-share.png")} className={studioGhostButtonClassName}><FaDownload /> 下载图片</button>
              <button type="button" onClick={() => download(appletRef.current?.exportGgb() ?? null, "geogebra-share.ggb")} className={studioGhostButtonClassName}><FaDownload /> 下载 GGB</button>
            </div>
          </div>
          <GeoGebraApplet ref={appletRef} mode={mode} height={520} locked onError={setError} />
        </div>
      </div>
    </div>
  );
}
