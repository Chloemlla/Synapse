import React, { useCallback, useEffect, useMemo, useState } from "react";
import { FaCopy, FaExclamationTriangle, FaPlus, FaSyncAlt, FaTicketAlt, FaTrash } from "react-icons/fa";
import { api } from "../api/api";
import { useNotification } from "./Notification";
import { useConfirm } from './confirm/ConfirmDialogProvider';
import ConfirmModal from "./ConfirmModal";
import { useAuth } from "../hooks/useAuth";
import { isSuperAdmin } from "../utils/rbac";
import {
  studioBadgeClassName,
  studioDangerButtonClassName,
  studioEyebrowClassName,
  studioFieldClassName,
  studioMetricToneClassName,
  studioPanelClassName,
  studioPrimaryButtonClassName,
  studioSecondaryButtonClassName,
  studioTileClassName,
} from "./studioTheme";

interface RegistrationInvite {
  id: string;
  code: string;
  note: string;
  active: boolean;
  maxUses: number;
  usedCount: number;
  remainingUses: number;
  createdByUsername?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  expired: boolean;
  usedBy: {
    userId: string;
    username: string;
    email: string;
    usedAt: string;
  }[];
}

const inputClass = studioFieldClassName;

function formatDate(value: string | null): string {
  if (!value) return "不限";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "不限";
  return date.toLocaleString("zh-CN", { hour12: false });
}

function toLocalDatetimeInput(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

type InviteEditDraft = {
  maxUses: string;
  expiresAt: string;
};

/** 后端 `/registration-invites/stats` 的聚合视图（跨全部邀请码，不随前端分页变化）。 */
interface InviteStats {
  total: number;
  active: number;
  expired: number;
  exhausted: number;
  totalUses: number;
  remainingUses: number;
  recentUses: Array<{ code: string; username: string; email: string; usedAt: string }>;
}

const buildInviteDraft = (invite: RegistrationInvite): InviteEditDraft => ({
  maxUses: String(invite.maxUses),
  expiresAt: toLocalDatetimeInput(invite.expiresAt),
});

const RegistrationInviteManager: React.FC = () => {
  const { setNotification } = useNotification();
  const confirm = useConfirm();
  const { user } = useAuth();
  const canWrite = isSuperAdmin(user?.role);
  const [invites, setInvites] = useState<RegistrationInvite[]>([]);
  const [stats, setStats] = useState<InviteStats | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [bulkRunning, setBulkRunning] = useState(false);
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [loading, setLoading] = useState(false);
  // F4-04：区分「加载失败」与「确实没有邀请码」，失败时给出重试入口
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [editDrafts, setEditDrafts] = useState<Record<string, InviteEditDraft>>({});
  const [form, setForm] = useState({ code: "", note: "", maxUses: "1", expiresAt: "" });
  const activeCount = useMemo(
    () => invites.filter((invite) => invite.active && !invite.expired && invite.remainingUses > 0).length,
    [invites],
  );

  const loadInvites = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      // 列表与聚合统计并行取：界面上的「总数/可用/已过期/已用尽」以服务端聚合为准，
      // 不再靠前端把当前列表求和（两者口径不同：列表是全部邀请码，但见不到 expired/exhausted 细分）。
      const [listResponse, statsResponse] = await Promise.allSettled([
        api.get("/api/admin/registration-invites"),
        api.get("/api/admin/registration-invites/stats"),
      ]);
      if (listResponse.status === "rejected") {
        throw listResponse.reason;
      }
      const nextInvites = listResponse.value.data?.invites || [];
      setInvites(nextInvites);
      setEditDrafts(Object.fromEntries(nextInvites.map((invite: RegistrationInvite) => [invite.id, buildInviteDraft(invite)])));
      setSelectedIds((current) => current.filter((id) => nextInvites.some((invite: RegistrationInvite) => invite.id === id)));
      if (statsResponse.status === "fulfilled" && statsResponse.value.data?.success) {
        setStats(statsResponse.value.data.stats as InviteStats);
      }
    } catch (error: any) {
      setNotification({ type: "error", message: error?.response?.data?.error || "获取邀请码列表失败" });
      setLoadError(error?.response?.data?.error || "获取邀请码列表失败，请稍后重试");
    } finally {
      setLoading(false);
    }
  }, [setNotification]);

  const toggleSelected = useCallback((id: string) => {
    setSelectedIds((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
  }, []);

  const allSelected = invites.length > 0 && selectedIds.length === invites.length;

  /** 批量启用/停用/删除：后端每个请求最多接受 500 个 id，这里按 200 分批串行，避免一次失败全军覆没。 */
  const runBulk = useCallback(
    async (action: "bulk-active" | "bulk-delete", active?: boolean) => {
      if (selectedIds.length === 0) return;
      setBulkRunning(true);
      const chunks: string[][] = [];
      for (let i = 0; i < selectedIds.length; i += 200) chunks.push(selectedIds.slice(i, i + 200));
      let affected = 0;
      try {
        for (const ids of chunks) {
          const response = await api.post(`/api/admin/registration-invites/${action}`, {
            ids,
            ...(action === "bulk-active" ? { active: active !== false } : {}),
          });
          affected += Number(
            response.data?.modified ?? response.data?.deleted ?? 0,
          );
        }
        const label = action === "bulk-delete" ? "删除" : active === false ? "停用" : "启用";
        setNotification({ type: "success", message: `已${label} ${affected} 个邀请码` });
        setSelectedIds([]);
        await loadInvites();
      } catch (error: any) {
        setNotification({ type: "error", message: error?.response?.data?.error || `批量操作失败（已完成 ${affected} 个）` });
        await loadInvites();
      } finally {
        setBulkRunning(false);
        setConfirmBulkDelete(false);
      }
    },
    [loadInvites, selectedIds, setNotification],
  );

  useEffect(() => {
    void loadInvites();
  }, [loadInvites]);

  const createInvite = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      const payload = {
        code: form.code.trim() || undefined,
        note: form.note.trim(),
        maxUses: Number(form.maxUses) || 1,
        expiresAt: form.expiresAt ? new Date(form.expiresAt).toISOString() : null,
      };
      const response = await api.post("/api/admin/registration-invites", payload);
      const invite = response.data.invite as RegistrationInvite;
      setInvites((current) => [invite, ...current]);
      setEditDrafts((current) => ({ ...current, [invite.id]: buildInviteDraft(invite) }));
      setForm({ code: "", note: "", maxUses: "1", expiresAt: "" });
      setNotification({ type: "success", message: "邀请码已创建" });
    } catch (error: any) {
      setNotification({ type: "error", message: error?.response?.data?.error || "创建邀请码失败" });
    } finally {
      setSaving(false);
    }
  };

  const updateInvite = async (invite: RegistrationInvite, updates: Partial<RegistrationInvite>) => {
    setUpdatingId(invite.id);
    try {
      const payload = {
        ...updates,
        expiresAt: Object.prototype.hasOwnProperty.call(updates, "expiresAt") ? updates.expiresAt : undefined,
      };
      const response = await api.patch(`/api/admin/registration-invites/${invite.id}`, payload);
      const nextInvite = response.data.invite as RegistrationInvite;
      setInvites((current) => current.map((item) => (item.id === invite.id ? nextInvite : item)));
      setEditDrafts((current) => ({ ...current, [invite.id]: buildInviteDraft(nextInvite) }));
      setNotification({ type: "success", message: "邀请码已更新" });
    } catch (error: any) {
      setNotification({ type: "error", message: error?.response?.data?.error || "更新邀请码失败" });
    } finally {
      setUpdatingId(null);
    }
  };

  const updateInviteDraft = (inviteId: string, patch: Partial<InviteEditDraft>) => {
    setEditDrafts((current) => ({
      ...current,
      [inviteId]: {
        ...(current[inviteId] || { maxUses: "1", expiresAt: "" }),
        ...patch,
      },
    }));
  };

  const saveInviteDraft = async (invite: RegistrationInvite) => {
    const draft = editDrafts[invite.id] || buildInviteDraft(invite);
    const nextMaxUses = Math.max(invite.usedCount || 1, Number(draft.maxUses) || 1);
    const nextExpiresAt = draft.expiresAt ? new Date(draft.expiresAt).toISOString() : null;
    const currentExpiresAt = invite.expiresAt ? new Date(invite.expiresAt).toISOString() : null;
    const maxUsesChanged = nextMaxUses !== invite.maxUses;
    const expiresChanged = nextExpiresAt !== currentExpiresAt;

    if (!maxUsesChanged && !expiresChanged) {
      setNotification({ type: "info", message: "没有需要保存的更改" });
      return;
    }

    await updateInvite(invite, {
      ...(maxUsesChanged ? { maxUses: nextMaxUses } : {}),
      ...(expiresChanged ? { expiresAt: nextExpiresAt } : {}),
    } as Partial<RegistrationInvite>);
  };

  const isInviteDraftDirty = (invite: RegistrationInvite) => {
    const draft = editDrafts[invite.id] || buildInviteDraft(invite);
    const nextMaxUses = Math.max(invite.usedCount || 1, Number(draft.maxUses) || 1);
    const nextExpiresAt = draft.expiresAt ? new Date(draft.expiresAt).toISOString() : null;
    const currentExpiresAt = invite.expiresAt ? new Date(invite.expiresAt).toISOString() : null;
    return nextMaxUses !== invite.maxUses || nextExpiresAt !== currentExpiresAt;
  };

  const deleteInvite = async (invite: RegistrationInvite) => {
    const ok = await confirm({
      title: `删除邀请码「${invite.code}」？`,
      description: `已使用 ${invite.usedCount}/${invite.maxUses} 次；删除后该邀请码立即失效，其使用记录也不可再查。`,
      tone: 'danger',
      confirmLabel: '删除',
    });
    if (!ok) return;
    try {
      await api.delete(`/api/admin/registration-invites/${invite.id}`);
      setInvites((current) => current.filter((item) => item.id !== invite.id));
      setEditDrafts((current) => {
        const next = { ...current };
        delete next[invite.id];
        return next;
      });
      setNotification({ type: "success", message: "邀请码已删除" });
    } catch (error: any) {
      setNotification({ type: "error", message: error?.response?.data?.error || "删除邀请码失败" });
    }
  };

  const copyCode = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setNotification({ type: "success", message: "邀请码已复制" });
    } catch {
      setNotification({ type: "warning", message: "复制失败，请手动复制" });
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className={`flex items-center gap-2 ${studioEyebrowClassName}`}>
            <FaTicketAlt />
            Registration Invites
          </div>
          <h2 className="mt-2 text-xl font-semibold text-slate-900">注册邀请码</h2>
          <p className="mt-1 text-sm leading-6 text-slate-600">
            管理本地账号注册使用的邀请码；在 env-manager 的「注册邀请码」分区开启开关后，注册必须提供有效邀请码。
          </p>
        </div>
        <button
          type="button"
          onClick={() => void loadInvites()}
          className={studioSecondaryButtonClassName}
          disabled={loading}
        >
          <FaSyncAlt className={loading ? "animate-spin" : ""} />
          刷新
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <div className={`rounded-2xl border p-4 ${studioMetricToneClassName("slate")}`}>
          <div className="text-xs font-semibold text-slate-500">总数</div>
          <div className="mt-2 text-2xl font-semibold text-slate-900">{stats?.total ?? invites.length}</div>
        </div>
        <div className={`rounded-2xl border p-4 ${studioMetricToneClassName("emerald")}`}>
          <div className="text-xs font-semibold text-emerald-700">可用</div>
          <div className="mt-2 text-2xl font-semibold text-emerald-800">{stats?.active ?? activeCount}</div>
        </div>
        <div className={`rounded-2xl border p-4 ${studioMetricToneClassName("amber")}`}>
          <div className="text-xs font-semibold text-amber-700">已过期</div>
          <div className="mt-2 text-2xl font-semibold text-amber-800">{stats?.expired ?? 0}</div>
        </div>
        <div className={`rounded-2xl border p-4 ${studioMetricToneClassName("slate")}`}>
          <div className="text-xs font-semibold text-slate-500">已用尽</div>
          <div className="mt-2 text-2xl font-semibold text-slate-900">{stats?.exhausted ?? 0}</div>
        </div>
        <div className={`rounded-2xl border p-4 ${studioMetricToneClassName("slate")}`}>
          <div className="text-xs font-semibold text-slate-500">已使用次数</div>
          <div className="mt-2 text-2xl font-semibold text-slate-900">
            {stats?.totalUses ?? invites.reduce((sum, invite) => sum + invite.usedCount, 0)}
          </div>
        </div>
        <div className={`rounded-2xl border p-4 ${studioMetricToneClassName("slate")}`}>
          <div className="text-xs font-semibold text-slate-500">剩余可用次数</div>
          <div className="mt-2 text-2xl font-semibold text-slate-900">{stats?.remainingUses ?? "—"}</div>
        </div>
      </div>

      {stats && stats.recentUses.length > 0 ? (
        <div className={`${studioTileClassName} p-4`}>
          <div className="text-xs font-semibold text-slate-500">最近使用</div>
          <ul className="mt-2 space-y-1 text-xs text-slate-600">
            {stats.recentUses.slice(0, 5).map((item) => (
              <li key={`${item.code}-${item.usedAt}-${item.username}`} className="flex flex-wrap gap-x-2">
                <code className="font-mono text-slate-800">{item.code}</code>
                <span>{item.username || item.email}</span>
                <span className="text-slate-400">{formatDate(item.usedAt)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {canWrite && (
        <form onSubmit={createInvite} className={studioPanelClassName}>
          <div className="grid gap-3 lg:grid-cols-[1fr_1.4fr_0.7fr_1fr_auto] lg:items-end">
            <label className="block">
              <span className="text-xs font-semibold text-slate-600">邀请码</span>
              <input
                className={`${inputClass} mt-1 font-mono uppercase`}
                value={form.code}
                maxLength={32}
                placeholder="留空自动生成"
                onChange={(event) => setForm((current) => ({ ...current, code: event.target.value.toUpperCase() }))}
              />
            </label>
            <label className="block">
              <span className="text-xs font-semibold text-slate-600">备注</span>
              <input
                className={`${inputClass} mt-1`}
                value={form.note}
                maxLength={200}
                placeholder="用途或发放对象"
                onChange={(event) => setForm((current) => ({ ...current, note: event.target.value }))}
              />
            </label>
            <label className="block">
              <span className="text-xs font-semibold text-slate-600">次数</span>
              <input
                className={`${inputClass} mt-1`}
                type="number"
                min={1}
                max={10000}
                value={form.maxUses}
                onChange={(event) => setForm((current) => ({ ...current, maxUses: event.target.value }))}
              />
            </label>
            <label className="block">
              <span className="text-xs font-semibold text-slate-600">过期时间</span>
              <input
                className={`${inputClass} mt-1`}
                type="datetime-local"
                value={form.expiresAt}
                onChange={(event) => setForm((current) => ({ ...current, expiresAt: event.target.value }))}
              />
            </label>
            <button
              type="submit"
              disabled={saving}
              className={studioPrimaryButtonClassName}
            >
              <FaPlus />
              创建
            </button>
          </div>
        </form>
      )}

      <div className="space-y-3">
        {loading && <div className={`${studioPanelClassName} text-sm text-slate-600`}>正在加载...</div>}
        {!loading && loadError && (
          <div className={`${studioPanelClassName} flex flex-col items-center gap-2 py-6 text-center`}>
            <FaExclamationTriangle className="text-xl text-red-500" aria-hidden />
            <div className="text-sm text-slate-600">{loadError}</div>
            <button
              type="button"
              onClick={() => void loadInvites()}
              className={studioSecondaryButtonClassName}
            >
              <FaSyncAlt />
              重试
            </button>
          </div>
        )}
        {!loading && !loadError && invites.length === 0 && (
          <div className={`${studioPanelClassName} text-sm text-slate-600`}>暂无邀请码。</div>
        )}

        {canWrite && invites.length > 0 ? (
          <div className={`${studioPanelClassName} flex flex-wrap items-center gap-2 py-3`}>
            <label className="flex items-center gap-2 text-xs font-semibold text-slate-600">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={() => setSelectedIds(allSelected ? [] : invites.map((invite) => invite.id))}
                className="size-4 rounded border-slate-300"
                aria-label="全选邀请码"
              />
              全选
            </label>
            <span className="text-xs text-slate-500">已选 {selectedIds.length} 个</span>
            {selectedIds.length > 0 ? (
              <>
                <button
                  type="button"
                  disabled={bulkRunning}
                  onClick={() => void runBulk("bulk-active", true)}
                  className={studioSecondaryButtonClassName}
                >
                  批量启用
                </button>
                <button
                  type="button"
                  disabled={bulkRunning}
                  onClick={() => void runBulk("bulk-active", false)}
                  className={studioSecondaryButtonClassName}
                >
                  批量停用
                </button>
                <button
                  type="button"
                  disabled={bulkRunning}
                  onClick={() => setConfirmBulkDelete(true)}
                  className={studioDangerButtonClassName}
                >
                  <FaTrash />
                  批量删除
                </button>
                <button
                  type="button"
                  disabled={bulkRunning}
                  onClick={() => setSelectedIds([])}
                  className={studioSecondaryButtonClassName}
                >
                  取消选择
                </button>
              </>
            ) : null}
            {bulkRunning ? <span className="text-xs text-slate-500">批量操作进行中...</span> : null}
          </div>
        ) : null}

        {invites.map((invite) => (
          <div key={invite.id} className={studioPanelClassName}>
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
              <div className="flex min-w-0 items-start gap-3">
                {canWrite ? (
                  <input
                    type="checkbox"
                    checked={selectedIds.includes(invite.id)}
                    onChange={() => toggleSelected(invite.id)}
                    className="mt-1.5 size-4 shrink-0 rounded border-slate-300"
                    aria-label={`选择邀请码 ${invite.code}`}
                  />
                ) : null}
                <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <code className="rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-sm font-semibold text-slate-900">
                    {invite.code}
                  </code>
                  <button
                    type="button"
                    onClick={() => void copyCode(invite.code)}
                    className={studioSecondaryButtonClassName}
                    aria-label="复制邀请码"
                  >
                    <FaCopy />
                  </button>
                  <span
                    className={studioBadgeClassName(
                      invite.active && !invite.expired && invite.remainingUses > 0
                        ? "green"
                        : "slate",
                    )}
                  >
                    {invite.active ? (invite.expired ? "已过期" : "启用") : "停用"}
                  </span>
                </div>
                <div className="mt-2 text-sm text-slate-600">{invite.note || "无备注"}</div>
                <div className="mt-2 flex flex-wrap gap-2 text-xs text-slate-500">
                  <span>已用 {invite.usedCount}/{invite.maxUses}</span>
                  <span>剩余 {invite.remainingUses}</span>
                  <span>过期 {formatDate(invite.expiresAt)}</span>
                  <span>创建人 {invite.createdByUsername || "未知"}</span>
                </div>
                </div>
              </div>

              {canWrite && (() => {
                const draft = editDrafts[invite.id] || buildInviteDraft(invite);
                const isUpdating = updatingId === invite.id;
                const dirty = isInviteDraftDirty(invite);
                return (
                  <div className="grid gap-2 sm:grid-cols-[120px_190px_auto_auto_auto]">
                    <input
                      className={inputClass}
                      type="number"
                      min={Math.max(1, invite.usedCount)}
                      max={10000}
                      value={draft.maxUses}
                      onChange={(event) => updateInviteDraft(invite.id, { maxUses: event.target.value })}
                      disabled={isUpdating}
                      aria-label="最大使用次数"
                    />
                    <input
                      className={inputClass}
                      type="datetime-local"
                      value={draft.expiresAt}
                      onChange={(event) => updateInviteDraft(invite.id, { expiresAt: event.target.value })}
                      disabled={isUpdating}
                      aria-label="过期时间"
                    />
                    <button
                      type="button"
                      onClick={() => void saveInviteDraft(invite)}
                      disabled={isUpdating || !dirty}
                      className={studioSecondaryButtonClassName}
                    >
                      {isUpdating ? "保存中" : "保存"}
                    </button>
                    <button
                      type="button"
                      onClick={() => void updateInvite(invite, { active: !invite.active })}
                      disabled={isUpdating}
                      className={studioSecondaryButtonClassName}
                    >
                      {invite.active ? "停用" : "启用"}
                    </button>
                    <button
                      type="button"
                      onClick={() => void deleteInvite(invite)}
                      disabled={isUpdating}
                      className={studioDangerButtonClassName}
                    >
                      <FaTrash />
                      删除
                    </button>
                  </div>
                );
              })()}
            </div>

            {invite.usedBy.length > 0 && (
              <div className={`mt-4 overflow-x-auto ${studioTileClassName}`}>
                <table className="min-w-full divide-y divide-slate-100 text-left text-xs">
                  <thead className="bg-slate-50 text-slate-500">
                    <tr>
                      <th className="px-3 py-2 font-semibold">用户</th>
                      <th className="px-3 py-2 font-semibold">邮箱</th>
                      <th className="px-3 py-2 font-semibold">使用时间</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {invite.usedBy.map((item) => (
                      <tr key={`${invite.id}-${item.userId}-${item.usedAt}`}>
                        <td className="px-3 py-2 text-slate-700">{item.username}</td>
                        <td className="px-3 py-2 text-slate-500">{item.email}</td>
                        <td className="px-3 py-2 text-slate-500">{formatDate(item.usedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ))}
      </div>

      <ConfirmModal
        open={confirmBulkDelete}
        onClose={() => setConfirmBulkDelete(false)}
        onConfirm={() => void runBulk("bulk-delete")}
        title="批量删除邀请码"
        message={`确认删除选中的 ${selectedIds.length} 个邀请码？已使用过的邀请码也会一并删除，其使用记录不再可查。`}
        confirmText="确认删除"
        type="danger"
      />
    </div>
  );
};

export default RegistrationInviteManager;
