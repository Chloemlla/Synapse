import { useCallback, useEffect, useState } from "react";
import { FaCopy, FaShareAlt, FaTimes } from "react-icons/fa";
import { useAuth } from "../../hooks/useAuth";
import { createGeoGebraShare, deleteGeoGebraShare, listGeoGebraShares } from "../../api/geogebra";
import { cn } from "../../utils/cn";
import FeatureConsentGate from "../FeatureConsentGate";
import { studioFieldClassName, studioGhostButtonClassName, studioPanelClassName, studioPrimaryButtonClassName, studioSubPanelClassName, studioTileClassName } from "../studioTheme";
import { StudioEmptyState, StudioErrorNote, StudioLoadingState, StudioSuccessNote } from "../studioFeedback";
import { prepareGeoGebraScript } from "./script";
import { geoGebraShareUrl, resolveGeoGebraEmbedUrl } from "./embed";
import type { GeoGebraLocalProject, GeoGebraShare } from "../../types/geogebra";

// 后端 shareView 已带 embedUrl；这里用可选交叉类型兼容旧响应，缺失时由 embed.ts 本地推导。
type ShareWithEmbed = GeoGebraShare & { embedUrl?: string | null };

type Props = {
  project: GeoGebraLocalProject | null;
  onGetCover: () => string | null;
};

export default function GeoGebraSharePanel({ project, onGetCover }: Props) {
  const { user } = useAuth();
  const [title, setTitle] = useState(project?.title ?? "GeoGebra 画布");
  const [allowFork, setAllowFork] = useState(true);
  const [shares, setShares] = useState<GeoGebraShare[]>([]);
  const [sharesLoading, setSharesLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");

  useEffect(() => setTitle(project?.title || "GeoGebra 画布"), [project?.projectId, project?.title]);

  const loadShares = useCallback(async () => {
    setSharesLoading(true);
    setError("");
    try {
      setShares(await listGeoGebraShares());
    } catch {
      setShares([]);
      setError("分享列表暂时无法载入，请稍后重试。");
    } finally {
      setSharesLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!user) return;
    void loadShares();
  }, [loadShares, user]);

  const publish = async () => {
    if (!user || !project || busy) return;
    const prepared = prepareGeoGebraScript(project.code);
    if (prepared.errors.length || !prepared.commands.length) {
      setError("请先修正脚本中的问题，再发布分享。");
      return;
    }
    const coverDataUrl = onGetCover();
    if (!coverDataUrl) {
      setError("请先运行画布，再发布分享。");
      return;
    }
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const share = await createGeoGebraShare({
        projectId: project.cloudRevision ? project.projectId : null,
        title: title.trim() || "GeoGebra 画布",
        canvasMode: project.canvasMode,
        commands: prepared.commands,
        coverDataUrl,
        allowFork,
      });
      setShares((items) => [share, ...items.filter((item) => item.shareId !== share.shareId)]);
      setStatus("分享已发布。");
    } catch {
      setError("分享暂时无法发布，请稍后重试。");
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (shareId: string) => {
    try {
      await deleteGeoGebraShare(shareId);
      setShares((items) => items.map((item) => item.shareId === shareId ? { ...item, revokedAt: new Date().toISOString(), coverUrl: null } : item));
      setStatus("分享已撤销。");
    } catch {
      setError("分享暂时无法撤销，请重试。");
    }
  };

  const copyText = async (text: string, message: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setStatus(message);
    } catch {
      setError("无法复制链接，请手动打开分享页面并复制地址。");
    }
  };

  const copy = (slug: string) => copyText(geoGebraShareUrl(slug), "分享链接已复制。");
  const copyEmbed = (share: GeoGebraShare) => copyText(
    resolveGeoGebraEmbedUrl(share as ShareWithEmbed),
    "嵌入链接已复制。",
  );

  if (!user) {
    return <section className={studioPanelClassName}><h2 className="text-lg font-semibold text-slate-900">公开分享</h2><p className="mt-2 text-sm text-slate-600">登录后可发布和管理画布分享。</p><a href="/login" className={cn(studioPrimaryButtonClassName, "mt-4")}>登录后继续</a></section>;
  }

  return (
      <section className={studioPanelClassName} aria-labelledby="geogebra-share-heading">
          <div className="mb-4">
            <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-500">Canvas Sharing</p>
            <h2 id="geogebra-share-heading" className="mt-1 text-lg font-semibold text-slate-900">公开分享</h2>
            <p className="mt-1 text-sm text-slate-500">持有链接的人可以查看这份画布；你可以随时撤销。</p>
          </div>
          {error && <StudioErrorNote className="mb-3">{error}</StudioErrorNote>}
          {status && !error && <StudioSuccessNote className="mb-3">{status}</StudioSuccessNote>}
          <FeatureConsentGate feature="geogebra-projects">
            <FeatureConsentGate feature="geogebra-share">
              <div className={cn(studioSubPanelClassName, "space-y-3")}>
                <label className="block text-xs font-semibold text-slate-600">
                  分享标题
                  <input className={cn(studioFieldClassName, "mt-1")} value={title} maxLength={120} onChange={(event) => setTitle(event.target.value)} />
                </label>
                <label className="flex min-h-11 items-center gap-2 text-sm text-slate-700">
                  <input type="checkbox" checked={allowFork} onChange={(event) => setAllowFork(event.target.checked)} />
                  允许访问者创建自己的副本
                </label>
                <button type="button" onClick={() => void publish()} disabled={busy || !project?.code.trim()} className={studioPrimaryButtonClassName}>
                  <FaShareAlt /> {busy ? "发布中…" : "发布当前画布"}
                </button>
              </div>
            </FeatureConsentGate>
          </FeatureConsentGate>
          <div className="mt-4 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">我的分享</h3>
              <button type="button" onClick={() => void loadShares()} disabled={sharesLoading} className={studioGhostButtonClassName}>刷新</button>
            </div>
            {sharesLoading ? (
              <StudioLoadingState text="加载分享..." minHeightClassName="min-h-[180px]" />
            ) : shares.length ? shares.map((share) => {
              const url = geoGebraShareUrl(share.slug);
              const embedUrl = resolveGeoGebraEmbedUrl(share as ShareWithEmbed);
              return (
                <article key={share.shareId} className={cn(studioTileClassName, "p-3")}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <strong className="block truncate text-sm text-slate-800">{share.title}</strong>
                      <span className="mt-1 block truncate text-xs text-slate-500">{share.revokedAt ? "已撤销" : url}</span>
                      {!share.revokedAt && (
                        <span className="mt-1 block truncate text-xs text-slate-400" title={embedUrl}>嵌入：{embedUrl}</span>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {!share.revokedAt && <button type="button" onClick={() => void copy(share.slug)} className={studioGhostButtonClassName}><FaCopy /> 复制</button>}
                      {!share.revokedAt && <button type="button" onClick={() => void copyEmbed(share)} className={studioGhostButtonClassName}><FaShareAlt /> 复制嵌入</button>}
                      {!share.revokedAt && <button type="button" onClick={() => void revoke(share.shareId)} className={studioGhostButtonClassName}><FaTimes /> 撤销</button>}
                    </div>
                  </div>
                </article>
              );
            }) : (
              <StudioEmptyState message="还没有发布分享。想让别人看到这份画布时，在上方发布即可。" />
            )}
          </div>
      </section>
  );
}
