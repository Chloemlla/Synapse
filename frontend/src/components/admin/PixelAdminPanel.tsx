import React, { useCallback, useEffect, useMemo, useState } from "react";
import { FaChartBar, FaCopy, FaDatabase, FaKey, FaList, FaListUl, FaPlus, FaSlidersH, FaSync, FaTrash } from "react-icons/fa";
import {
  createPixelCdk,
  deletePixelCdk,
  getPixelAdminDashboard,
  getPixelCdkUsage,
  getPixelCdkUsageDetail,
  getPixelCdks,
  getPixelIntegrationConfig,
  savePixelIntegrationConfig,
  type PixelAdminDashboardView,
  type PixelCdkMappingCreated,
  type PixelCdkMappingView,
  type PixelIntegrationConfigView,
  type PixelUsageLogView,
} from "@/api/pixelAdmin";
import { useAuth } from "@/hooks/useAuth";
import { useNotification } from "@/components/Notification";
import { InfoBadge, InfoMetricCard, InfoPanel, InfoQueryHero, InfoQueryShell } from "@/components/studioTheme";
import { useConfirm } from "@/components/confirm/ConfirmDialogProvider";
import { cn } from "@/lib/utils";

// Pixel 管理面板（PIX-11…PIX-14）。
//
// 设计要点：
//  - CDK 映射的**分发卡密明文只在创建成功的那一次出现**：用一次性弹窗 + 复制按钮，
//    关闭即消失，且绝不写进 localStorage / URL / console。
//  - 上游 CDK 永远只显示遮罩值；本页面没有任何地方能读到它。
//  - 集成配置的写操作服务端只允许超级管理员：普通管理员看到的是只读视图（按钮禁用 + 说明）。
//  - 没有可核对数据源的指标一律显示「无数据」，不编造。
type TabKey = "overview" | "mappings" | "usage" | "config";

const TABS: ReadonlyArray<{ key: TabKey; label: string; icon: React.ReactNode }> = [
  { key: "overview", label: "总览", icon: <FaSlidersH /> },
  { key: "mappings", label: "CDK 映射", icon: <FaKey /> },
  { key: "usage", label: "使用溯源", icon: <FaListUl /> },
  { key: "config", label: "集成配置", icon: <FaSlidersH /> },
];

function formatTime(value: string | null): string {
  return value ? new Date(value).toLocaleString("zh-CN") : "无数据";
}

const PixelAdminPanel: React.FC = () => {
  const { setNotification } = useNotification();
  const { user } = useAuth();
  const confirm = useConfirm();
  const [tab, setTab] = useState<TabKey>("overview");
  const [dashboard, setDashboard] = useState<PixelAdminDashboardView | null>(null);
  const [mappings, setMappings] = useState<PixelCdkMappingView[]>([]);
  const [usage, setUsage] = useState<PixelUsageLogView[]>([]);
  const [usageCursor, setUsageCursor] = useState<string | null>(null);
  const [usageDetail, setUsageDetail] = useState<PixelUsageLogView | null>(null);
  const [config, setConfig] = useState<PixelIntegrationConfigView | null>(null);
  const [created, setCreated] = useState<PixelCdkMappingCreated | null>(null);
  const [form, setForm] = useState({ distributionCdk: "", upstreamCdk: "", note: "" });
  const [configForm, setConfigForm] = useState({ upstreamBaseUrl: "", allowedHosts: "", enabled: false, requestTimeoutMs: 20000 });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const isSuperAdmin = useMemo(() => String(user?.role ?? "") === "superadmin", [user?.role]);

  const loadDashboard = useCallback(async () => {
    try {
      setDashboard(await getPixelAdminDashboard());
    } catch {
      setError("暂时无法读取总览数据。");
    }
  }, []);

  const loadMappings = useCallback(async () => {
    try {
      setMappings(await getPixelCdks());
    } catch {
      setError("暂时无法读取映射列表。");
    }
  }, []);

  const loadUsage = useCallback(async (cursor?: string) => {
    try {
      const page = await getPixelCdkUsage({ limit: 50, cursor });
      setUsage((items) => (cursor ? [...items, ...page.items] : page.items));
      setUsageCursor(page.nextCursor);
    } catch {
      setError("暂时无法读取溯源记录。");
    }
  }, []);

  const loadConfig = useCallback(async () => {
    try {
      const view = await getPixelIntegrationConfig();
      setConfig(view);
      setConfigForm({
        upstreamBaseUrl: view.upstreamBaseUrl,
        allowedHosts: view.allowedHosts.join("\n"),
        enabled: view.enabled,
        requestTimeoutMs: view.requestTimeoutMs,
      });
    } catch {
      setError("暂时无法读取集成配置。");
    }
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    await Promise.all([loadDashboard(), loadMappings(), loadUsage(), loadConfig()]);
    setLoading(false);
  }, [loadConfig, loadDashboard, loadMappings, loadUsage]);

  useEffect(() => { void refresh(); }, [refresh]);

  const handleCreate = async () => {
    if (!form.upstreamCdk.trim()) {
      setNotification?.({ type: "error", message: "请填写上游卡密。" });
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await createPixelCdk({
        distributionCdk: form.distributionCdk.trim() || undefined,
        upstreamCdk: form.upstreamCdk.trim(),
        note: form.note.trim() || undefined,
      });
      // 明文只进这一次的弹窗 state；表单立刻清空，避免它留在 DOM 里。
      setCreated(result);
      setForm({ distributionCdk: "", upstreamCdk: "", note: "" });
      setMappings((items) => [result.mapping, ...items]);
      setNotification?.({ type: "success", message: "映射已创建，请立刻复制分发给用户的卡密。" });
    } catch (caught) {
      const status = (caught as { response?: { status?: number } })?.response?.status;
      setError(status === 409 ? "这张分发卡密已经存在，请换一个或留空自动生成。" : "创建失败，请检查上游卡密后重试。");
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (mapping: PixelCdkMappingView) => {
    const approved = await confirm({
      title: "删除卡密映射",
      description: "删除后使用这张分发卡密的新任务将无法提交，已有任务不受影响。",
      confirmLabel: "删除映射",
      tone: "danger",
    });
    if (!approved) return;
    try {
      await deletePixelCdk(mapping.mappingId);
      setMappings((items) => items.filter((item) => item.mappingId !== mapping.mappingId));
      setNotification?.({ type: "success", message: "映射已删除。" });
    } catch {
      setError("删除失败，请稍后重试。");
    }
  };

  const handleSaveConfig = async () => {
    if (!isSuperAdmin) return;
    setBusy(true);
    setError("");
    try {
      const view = await savePixelIntegrationConfig({
        upstreamBaseUrl: configForm.upstreamBaseUrl.trim(),
        allowedHosts: configForm.allowedHosts.split(/\r?\n/).map((item) => item.trim()).filter(Boolean),
        enabled: configForm.enabled,
        requestTimeoutMs: Number(configForm.requestTimeoutMs) || 20000,
      });
      setConfig(view);
      setNotification?.({ type: "success", message: "集成配置已保存。" });
    } catch {
      setError("保存失败：地址必须为 HTTPS 公网地址，且主机需在允许清单内。");
    } finally {
      setBusy(false);
    }
  };

  const copyCreated = async () => {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.distributionCdk);
      setNotification?.({ type: "success", message: "已复制分发卡密。" });
    } catch {
      setNotification?.({ type: "error", message: "复制失败，请手动选中后复制。" });
    }
  };

  return (
    <InfoQueryShell maxWidthClassName="max-w-6xl">
      <InfoQueryHero
        eyebrow="Pixel"
        title="Pixel 任务与卡密"
        description="卡密映射、调用溯源与上游集成配置。上游未配置时所有任务接口一律拒绝（fail-closed）。"
        icon={FaKey}
        meta={(
          <div className="flex flex-wrap gap-2">
            <InfoBadge tone={config?.configured && config?.enabled ? "emerald" : "amber"}>
              {config?.configured ? (config.enabled ? "上游已启用" : "上游已配置但已关闭") : "上游未配置"}
            </InfoBadge>
            {!isSuperAdmin && <InfoBadge tone="slate">只读（写操作需超级管理员）</InfoBadge>}
          </div>
        )}
        actions={(
          <button type="button" onClick={() => void refresh()} disabled={loading} className="min-h-11 rounded-2xl border border-slate-200 bg-white px-4 text-sm font-semibold text-slate-700 hover:border-slate-300">
            <FaSync className={cn("mr-2 inline", loading && "animate-spin")} />刷新
          </button>
        )}
      />

      <div className="flex flex-wrap gap-2">
        {TABS.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => setTab(item.key)}
            aria-pressed={tab === item.key}
            className={cn(
              "inline-flex min-h-10 items-center gap-2 rounded-full border px-4 text-sm font-semibold",
              tab === item.key ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 bg-white text-slate-700 hover:border-slate-300",
            )}
          >
            {item.icon}{item.label}
          </button>
        ))}
      </div>

      {error && <p role="alert" className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</p>}

      {tab === "overview" && (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <InfoMetricCard label="卡密映射" value={dashboard?.mappings.total ?? 0} detail={`启用 ${dashboard?.mappings.enabled ?? 0}`} icon={FaKey} />
            <InfoMetricCard label="调用总数" value={dashboard?.usage.total ?? 0} detail={`24 小时 ${dashboard?.usage.last24h ?? 0} · 7 天 ${dashboard?.usage.last7d ?? 0}`} icon={FaDatabase} />
            <InfoMetricCard label="任务归属" value={dashboard?.tasks.total ?? 0} icon={FaList} />
            <InfoMetricCard label="最近调用" value={dashboard?.usage.lastAt ? new Date(dashboard.usage.lastAt).toLocaleString("zh-CN") : "无数据"} icon={FaChartBar} />
          </div>
          <InfoPanel>
            <h3 className="text-sm font-semibold text-slate-900">保留策略</h3>
            <p className="mt-2 text-sm text-slate-600">
              脱敏溯源保留 {dashboard?.usage.retentionDays ?? "—"} 天（环境变量 <code>PIXEL_USAGE_LOG_RETENTION_DAYS</code>，
              改后需重建 TTL 索引才真正生效）。溯源里只有遮罩卡密、账号数、上游状态与耗时，不含账号内容。
            </p>
            <p className="mt-1 text-xs text-slate-500">需要为法律程序保全证据时，拉一份受限快照，而不是把全库保留期调长。</p>
          </InfoPanel>
          <InfoPanel>
            <h3 className="text-sm font-semibold text-slate-900">上游状态</h3>
            <dl className="mt-2 grid gap-2 text-sm text-slate-600 sm:grid-cols-2">
              <div><dt className="text-xs text-slate-500">主机</dt><dd>{dashboard?.config.host || "无数据"}</dd></div>
              <div><dt className="text-xs text-slate-500">启用状态</dt><dd>{dashboard?.config.configured ? (dashboard.config.enabled ? "已启用" : "已关闭") : "未配置"}</dd></div>
            </dl>
          </InfoPanel>
          <InfoPanel>
            <h3 className="text-sm font-semibold text-slate-900">任务提交状态分布</h3>
            {dashboard && Object.keys(dashboard.tasks.bySubmitState).length > 0
              ? <div className="mt-2 flex flex-wrap gap-2">{Object.entries(dashboard.tasks.bySubmitState).map(([state, count]) => <InfoBadge key={state}>{state}: {count}</InfoBadge>)}</div>
              : <p className="mt-2 text-sm text-slate-500">无数据。</p>}
          </InfoPanel>
        </div>
      )}

      {tab === "mappings" && (
        <div className="space-y-4">
          <InfoPanel>
            <h3 className="text-sm font-semibold text-slate-900">新建映射</h3>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <label className="text-xs font-semibold text-slate-600">分发卡密（留空自动生成）
                <input className="mt-1 block min-h-11 w-full rounded-2xl border border-slate-200 px-3 text-sm" value={form.distributionCdk} onChange={(event) => setForm((prev) => ({ ...prev, distributionCdk: event.target.value }))} autoComplete="off" spellCheck={false} />
              </label>
              <label className="text-xs font-semibold text-slate-600">上游卡密（必填，加密存储）
                <input className="mt-1 block min-h-11 w-full rounded-2xl border border-slate-200 px-3 text-sm" value={form.upstreamCdk} onChange={(event) => setForm((prev) => ({ ...prev, upstreamCdk: event.target.value }))} autoComplete="off" spellCheck={false} />
              </label>
              <label className="text-xs font-semibold text-slate-600">备注（可选）
                <input className="mt-1 block min-h-11 w-full rounded-2xl border border-slate-200 px-3 text-sm" value={form.note} onChange={(event) => setForm((prev) => ({ ...prev, note: event.target.value }))} />
              </label>
            </div>
            <button type="button" onClick={() => void handleCreate()} disabled={busy || !isSuperAdmin} className="mt-3 min-h-11 rounded-2xl bg-slate-900 px-4 text-sm font-semibold text-white disabled:opacity-50">
              <FaPlus className="mr-2 inline" />{busy ? "创建中…" : "创建映射"}
            </button>
            {!isSuperAdmin && <p className="mt-2 text-xs text-slate-500">上游卡密属于凭据，创建与删除仅超级管理员可操作。</p>}
          </InfoPanel>

          <InfoPanel>
            <h3 className="text-sm font-semibold text-slate-900">映射列表（{mappings.length}）</h3>
            {mappings.length === 0
              ? <p className="mt-2 text-sm text-slate-500">还没有映射。</p>
              : (
                <ul className="mt-3 space-y-2">
                  {mappings.map((mapping) => (
                    <li key={mapping.mappingId} className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-slate-200 bg-white/80 px-3 py-2 text-xs text-slate-600">
                      <span className="min-w-0">
                        <span className="block font-mono text-sm text-slate-800">{mapping.distributionCdkMasked}</span>
                        <span className="mt-0.5 block">上游 {mapping.upstreamCdkMasked} · {mapping.note || "无备注"} · {mapping.createdByUsername || "未知"}</span>
                        <span className="mt-0.5 block text-slate-400">{formatTime(mapping.createdAt)}</span>
                      </span>
                      <span className="flex items-center gap-2">
                        <InfoBadge tone={mapping.enabled ? "emerald" : "slate"}>{mapping.enabled ? "启用" : "停用"}</InfoBadge>
                        {isSuperAdmin && (
                          <button type="button" onClick={() => void handleDelete(mapping)} aria-label="删除映射" className="min-h-9 rounded-2xl border border-slate-200 px-3 text-rose-700 hover:border-rose-200 hover:bg-rose-50">
                            <FaTrash />
                          </button>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
          </InfoPanel>
        </div>
      )}

      {tab === "usage" && (
        <InfoPanel>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-slate-900">调用溯源（默认 50 条）</h3>
            <button type="button" onClick={() => void loadUsage()} className="min-h-10 rounded-2xl border border-slate-200 bg-white px-3 text-sm text-slate-700">重新载入</button>
          </div>
          <p className="mt-1 text-xs text-slate-500">这里只有脱敏摘要：不含账号文本、密码、辅助邮箱、2FA 秘钥与完整结果链接。</p>
          {usage.length === 0
            ? <p className="mt-3 text-sm text-slate-500">无数据。</p>
            : (
              <>
                <ul className="mt-3 space-y-2">
                  {usage.map((item) => (
                    <li key={item.logId} className="rounded-2xl border border-slate-200 bg-white/80 px-3 py-2 text-xs text-slate-600">
                      <button type="button" onClick={() => void getPixelCdkUsageDetail(item.logId).then(setUsageDetail).catch(() => setError("暂时无法读取该条详情。"))} className="w-full text-left">
                        <span className="block text-sm text-slate-800">{item.method} {item.path}</span>
                        <span className="mt-0.5 block">卡密 {item.requestedCdkMasked} · 命中映射 {item.matchedMapping ? "是" : "否"} · 结果 {item.outcome} · {item.durationMs} ms</span>
                        <span className="mt-0.5 block text-slate-400">{formatTime(item.createdAt)} · 账号数 {item.accountCount ?? "—"} · 上游状态 {item.upstreamStatus ?? "—"}</span>
                      </button>
                    </li>
                  ))}
                </ul>
                {usageCursor && (
                  <button type="button" onClick={() => void loadUsage(usageCursor)} className="mt-3 min-h-10 rounded-2xl border border-slate-200 bg-white px-3 text-sm text-slate-700">加载更多</button>
                )}
              </>
            )}
          {usageDetail && (
            <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50/80 p-3 text-xs text-slate-600">
              <div className="flex items-center justify-between gap-2">
                <h4 className="text-sm font-semibold text-slate-900">详情</h4>
                <button type="button" onClick={() => setUsageDetail(null)} className="text-slate-500 underline-offset-2 hover:underline">关闭</button>
              </div>
              <dl className="mt-2 grid gap-1 sm:grid-cols-2">
                <div><dt className="text-slate-500">请求标识</dt><dd className="font-mono">{usageDetail.requestId}</dd></div>
                <div><dt className="text-slate-500">用户</dt><dd>{usageDetail.userId}</dd></div>
                <div><dt className="text-slate-500">服务类型</dt><dd>{usageDetail.serviceType ?? "—"}</dd></div>
                <div><dt className="text-slate-500">请求/响应字节</dt><dd>{usageDetail.requestBytes} / {usageDetail.responseBytes ?? "—"}</dd></div>
              </dl>
            </div>
          )}
        </InfoPanel>
      )}

      {tab === "config" && (
        <InfoPanel>
          <h3 className="text-sm font-semibold text-slate-900">上游集成配置</h3>
          <p className="mt-1 text-xs text-slate-500">
            未配置或关闭时，用户侧的任务接口一律拒绝（fail-closed），不会回落到任何默认地址。
            {config ? ` 最近更新：${formatTime(config.updatedAt)}${config.updatedByUsername ? ` · ${config.updatedByUsername}` : ""}` : ""}
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="text-xs font-semibold text-slate-600">上游地址（https）
              <input className="mt-1 block min-h-11 w-full rounded-2xl border border-slate-200 px-3 text-sm" value={configForm.upstreamBaseUrl} onChange={(event) => setConfigForm((prev) => ({ ...prev, upstreamBaseUrl: event.target.value }))} disabled={!isSuperAdmin} placeholder="https://upstream.example.com" />
            </label>
            <label className="text-xs font-semibold text-slate-600">请求超时（毫秒）
              <input type="number" min={1000} max={60000} className="mt-1 block min-h-11 w-full rounded-2xl border border-slate-200 px-3 text-sm" value={configForm.requestTimeoutMs} onChange={(event) => setConfigForm((prev) => ({ ...prev, requestTimeoutMs: Number(event.target.value) }))} disabled={!isSuperAdmin} />
            </label>
            <label className="text-xs font-semibold text-slate-600 sm:col-span-2">允许主机清单（每行一个）
              <textarea className="mt-1 block min-h-24 w-full rounded-2xl border border-slate-200 px-3 py-2 text-sm" value={configForm.allowedHosts} onChange={(event) => setConfigForm((prev) => ({ ...prev, allowedHosts: event.target.value }))} disabled={!isSuperAdmin} />
            </label>
          </div>
          <label className="mt-3 flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" checked={configForm.enabled} onChange={(event) => setConfigForm((prev) => ({ ...prev, enabled: event.target.checked }))} disabled={!isSuperAdmin} />
            启用该上游（关闭后所有任务接口立即拒绝）
          </label>
          <button type="button" onClick={() => void handleSaveConfig()} disabled={busy || !isSuperAdmin} className="mt-3 min-h-11 rounded-2xl bg-slate-900 px-4 text-sm font-semibold text-white disabled:opacity-50">
            {busy ? "保存中…" : "保存配置"}
          </button>
        </InfoPanel>
      )}

      {created && (
        <div className="fixed inset-0 z-[10050] grid place-items-center bg-slate-950/30 p-4 backdrop-blur-sm" role="presentation">
          <section role="dialog" aria-modal="true" aria-labelledby="pixel-cdk-created-title" className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-5 shadow-xl">
            <h2 id="pixel-cdk-created-title" className="text-lg font-semibold text-slate-900">分发卡密（只显示这一次）</h2>
            <p className="mt-2 text-sm text-slate-600">请立刻复制并发给用户；关闭本窗口后无法再次查看。</p>
            <p className="mt-3 break-all rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-sm text-slate-800">{created.distributionCdk}</p>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => void copyCreated()} className="min-h-11 rounded-2xl border border-slate-200 bg-white px-4 text-sm font-semibold text-slate-700">
                <FaCopy className="mr-2 inline" />复制
              </button>
              <button type="button" onClick={() => setCreated(null)} className="min-h-11 rounded-2xl bg-slate-900 px-4 text-sm font-semibold text-white">我已保存，关闭</button>
            </div>
          </section>
        </div>
      )}
    </InfoQueryShell>
  );
};

export default PixelAdminPanel;
