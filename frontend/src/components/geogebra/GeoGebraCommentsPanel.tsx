import { useEffect, useState } from "react";
import { FaComment, FaCheck } from "react-icons/fa";
import { useAuth } from "../../hooks/useAuth";
import { createGeoGebraComment, listGeoGebraComments, resolveGeoGebraComment } from "../../api/geogebra";
import { cn } from "../../utils/cn";
import FeatureConsentGate from "../FeatureConsentGate";
import { studioFieldClassName, studioGhostButtonClassName, studioPanelClassName, studioPrimaryButtonClassName, studioSubPanelClassName } from "../studioTheme";
import type { GeoGebraLocalProject, GeoGebraReviewComment } from "../../types/geogebra";

type Props = { project: GeoGebraLocalProject | null; objectNames: string[] };

export default function GeoGebraCommentsPanel({ project, objectNames }: Props) {
  const { user } = useAuth();
  const [comments, setComments] = useState<GeoGebraReviewComment[]>([]);
  const [body, setBody] = useState("");
  const [objectName, setObjectName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");

  useEffect(() => {
    if (!user || !project?.cloudRevision) {
      setComments([]);
      return;
    }
    let active = true;
    void listGeoGebraComments(project.projectId).then((items) => {
      if (active) setComments(items);
    }).catch(() => {
      if (active) setError("评论暂时无法载入，请稍后重试。");
    });
    return () => { active = false; };
  }, [project?.cloudRevision, project?.projectId, user]);

  const submit = async () => {
    if (!project?.cloudRevision || !body.trim() || busy) return;
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const comment = await createGeoGebraComment({ projectId: project.projectId, objectName: objectName || null, body: body.trim() });
      setComments((items) => [...items, comment]);
      setBody("");
      setStatus("评论已添加。");
    } catch {
      setError("评论暂时无法提交，请确认项目权限后重试。");
    } finally {
      setBusy(false);
    }
  };

  const resolve = async (commentId: string) => {
    try {
      const updated = await resolveGeoGebraComment(commentId);
      setComments((items) => items.map((item) => item.commentId === commentId ? updated : item));
    } catch {
      setError("评论状态暂时无法更新。");
    }
  };

  if (!user) {
    return <section className={studioPanelClassName}><h2 className="text-lg font-semibold text-slate-900">团队评论</h2><p className="mt-2 text-sm text-slate-600">登录后可在云端项目中与团队成员交流。</p></section>;
  }
  if (!project?.cloudRevision) {
    return <section className={studioPanelClassName}><h2 className="text-lg font-semibold text-slate-900">团队评论</h2><p className="mt-2 text-sm text-slate-600">保存项目到云端后，即可添加版本或图形对象评论。</p></section>;
  }

  return (
      <section className={studioPanelClassName} aria-labelledby="geogebra-comments-heading">
        <div className="mb-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-500">Project Review</p>
          <h2 id="geogebra-comments-heading" className="mt-1 text-lg font-semibold text-slate-900">团队评论</h2>
        </div>
        {error && <p role="alert" className="mb-3 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</p>}
        {status && <p role="status" className="mb-3 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{status}</p>}
        <FeatureConsentGate feature="geogebra-projects">
          <div className={cn(studioSubPanelClassName, "space-y-3")}>
            <label className="block text-xs font-semibold text-slate-600">
              关联图形对象
              <select className={cn(studioFieldClassName, "mt-1")} value={objectName} onChange={(event) => setObjectName(event.target.value)}>
                <option value="">仅关联当前项目</option>
                {objectNames.map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
            </label>
            <label className="block text-xs font-semibold text-slate-600">
              评论
              <textarea className={cn(studioFieldClassName, "mt-1 min-h-24 resize-y")} maxLength={4_000} value={body} onChange={(event) => setBody(event.target.value)} placeholder="写下需要团队成员查看的意见" />
            </label>
            <button type="button" onClick={() => void submit()} disabled={busy || !body.trim()} className={studioPrimaryButtonClassName}><FaComment /> {busy ? "提交中…" : "添加评论"}</button>
          </div>
        </FeatureConsentGate>
        <div className="mt-4 space-y-2">
          {comments.length ? comments.map((comment) => (
            <article key={comment.commentId} className="rounded-2xl border border-slate-200 bg-white/80 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-xs font-semibold text-slate-700">{comment.objectName || "项目评论"} · {comment.status === "resolved" ? "已处理" : "待处理"}</div>
                {comment.status === "open" && comment.canResolve && (
                  <button type="button" onClick={() => void resolve(comment.commentId)} className={studioGhostButtonClassName}><FaCheck /> 标记已处理</button>
                )}
              </div>
              <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-slate-600">{comment.body}</p>
              <time className="mt-2 block text-xs text-slate-400" dateTime={comment.createdAt}>{new Date(comment.createdAt).toLocaleString("zh-CN")}</time>
            </article>
          )) : <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50/80 px-4 py-8 text-center text-sm text-slate-500">还没有评论。</div>}
        </div>
      </section>
  );
}
