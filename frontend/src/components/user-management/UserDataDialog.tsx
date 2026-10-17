import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FaDatabase, FaDownload, FaExclamationTriangle, FaSyncAlt, FaTrash } from 'react-icons/fa';
import type { User } from './userManagementShared';
import {
  StudioErrorState,
  StudioLoadingState,
  StudioModal,
  StudioModalHeader,
} from '../studioFeedback';
import EstablishSecuritySession from '../EstablishSecuritySession';
import { useSecuritySession } from '../../hooks/useSecuritySession';
import { useConfirm } from '../confirm/ConfirmDialogProvider';
import { api } from '../../api/api';
import {
  fetchAccountDataSummary,
  downloadAccountData,
  extractAccountDataErrorMessage,
  type AccountDataSummary,
} from '../../api/adminUserData';
import {
  studioDangerButtonClassName,
  studioPrimaryButtonClassName,
  studioSecondaryButtonClassName,
} from '../studioTheme';

/**
 * 用户管理 →「数据」弹窗：账户数据概览、导出与注销。
 *
 * 为什么把注销也放在这里：删除账号是「对一个人的数据做最终处置」，操作者需要先看到
 * 这个账号实际存了哪些数据、导出是否完成，再决定删除。把两者放在同一个面板里，
 * 删除就不再是一次盲按。
 *
 * 安全边界：
 * - 导出需要安全会话（密码 / TOTP / Passkey 二次验证），后端同样强制；
 * - 删除沿用既有的 DELETE /api/admin/users/:id（软删除 + 撤销会话 + 禁用 API Key），
 *   这里只负责把后果讲清楚。
 */

type NotifyPayload = { type: 'success' | 'error' | 'warning'; message: string };

interface UserDataDialogProps {
  open: boolean;
  user: User | null;
  isSelf: boolean;
  /** 该用户是最后一个超级管理员（禁止删除）。 */
  isLastSuperadmin: boolean;
  onClose: () => void;
  /** 删除成功后的回调（调用方负责刷新列表与提示）。 */
  onDeleted: (user: User) => void;
  notify: (payload: NotifyPayload) => void;
}

function formatCount(value: number): string {
  return value.toLocaleString('zh-CN');
}

function formatDeletedAt(value: number | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString('zh-CN');
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${Math.round((bytes / 1024 / 1024) * 10) / 10} MB`;
}

const UserDataDialog: React.FC<UserDataDialogProps> = ({
  open,
  user,
  isSelf,
  isLastSuperadmin,
  onClose,
  onDeleted,
  notify,
}) => {
  const confirm = useConfirm();
  const security = useSecuritySession();
  const [summary, setSummary] = useState<AccountDataSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const userId = user?.id ?? '';

  const load = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    setLoadError(null);
    try {
      setSummary(await fetchAccountDataSummary(userId));
    } catch (error) {
      setSummary(null);
      setLoadError(await extractAccountDataErrorMessage(error, '读取账户数据摘要失败'));
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    if (!open || !userId) {
      setSummary(null);
      setLoadError(null);
      return;
    }
    void load();
  }, [load, open, userId]);

  const datasets = summary?.datasets ?? [];
  const nonEmpty = useMemo(
    () => datasets.filter((dataset) => dataset.count > 0).sort((a, b) => b.count - a.count),
    [datasets],
  );
  const empty = useMemo(() => datasets.filter((dataset) => dataset.count === 0), [datasets]);
  const totalRows = useMemo(() => datasets.reduce((sum, dataset) => sum + dataset.count, 0), [datasets]);
  const deletedAtText = summary ? formatDeletedAt(summary.subject.deletedAt) : null;
  const alreadyDeleted = Boolean(deletedAtText);

  const handleExport = useCallback(async () => {
    if (!user || !security.isActive || exporting) return;
    setExporting(true);
    try {
      const result = await downloadAccountData(user.id);
      notify({
        type: 'success',
        message: `账户数据已导出（${formatBytes(result.blob.size)}）${result.filename ? `：${result.filename}` : ''}`,
      });
    } catch (error) {
      notify({ type: 'error', message: await extractAccountDataErrorMessage(error, '导出失败，请稍后重试') });
    } finally {
      setExporting(false);
    }
  }, [exporting, notify, security.isActive, user]);

  const handleDelete = useCallback(async () => {
    if (!user || isSelf || isLastSuperadmin || deleting) return;
    const ok = await confirm({
      title: `注销账号「${user.username}」？`,
      description:
        '该账号会被立即停用：所有登录会话被撤销、API Key 被禁用、密码与二次验证材料被清除。'
        + '账号数据按法律保留与安全保留策略保留，不能通过重新注册同一邮箱/用户名绕过。此操作不可由用户自助恢复。',
      tone: 'danger',
      confirmLabel: '确认注销账号',
    });
    if (!ok) return;
    setDeleting(true);
    try {
      await api.delete(`/api/admin/users/${encodeURIComponent(user.id)}`);
      notify({ type: 'success', message: `账号「${user.username}」已注销` });
      onDeleted(user);
    } catch (error) {
      const message = (error as { response?: { data?: { error?: string } } })?.response?.data?.error;
      notify({ type: 'error', message: message || '注销失败，请稍后重试' });
    } finally {
      setDeleting(false);
    }
  }, [confirm, deleting, isLastSuperadmin, isSelf, notify, onDeleted, user]);

  const deleteDisabledReason = alreadyDeleted
    ? '该账号已经注销'
    : isSelf
      ? '不能注销自己的账号'
      : isLastSuperadmin
        ? '不能注销最后一个超级管理员'
        : null;

  if (!user) return null;

  return (
    <StudioModal
      open={open}
      onClose={onClose}
      labelledBy="user-data-dialog-title"
      maxWidthClassName="max-w-2xl"
    >
      <StudioModalHeader
        title={`账户数据 - ${user.username}`}
        titleId="user-data-dialog-title"
        description="查看该账号实际存了哪些数据，导出为 JSON，或执行注销。"
        icon={<FaDatabase aria-hidden />}
        onClose={onClose}
      />

      <div className="mt-4 space-y-4">
        {/* 账号标识 */}
        <section aria-label="账号信息" className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4">
          <dl className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
            <div className="min-w-0">
              <dt className="text-slate-500">用户 ID</dt>
              <dd className="truncate font-mono text-slate-800" title={user.id}>{user.id}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-slate-500">邮箱</dt>
              <dd className="truncate text-slate-800" title={user.email}>{user.email || '未填写'}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-slate-500">角色</dt>
              <dd className="text-slate-800">{user.role}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-slate-500">状态</dt>
              <dd className={alreadyDeleted ? 'font-semibold text-rose-700' : 'text-slate-800'}>
                {alreadyDeleted ? `已注销（${deletedAtText}）` : (summary?.subject.accountStatus ?? user.accountStatus ?? 'active')}
              </dd>
            </div>
          </dl>
          {summary?.subject.deleteReason ? (
            <p className="mt-2 text-[11px] text-slate-500">
              注销原因：{summary.subject.deleteReason}
              {summary.subject.deletedBy ? ` · 操作者 ${summary.subject.deletedBy}` : ''}
            </p>
          ) : null}
        </section>

        {/* 数据概览 */}
        <section aria-label="账户数据概览" className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-slate-900">账户数据概览</h3>
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-slate-500">
                {loading ? '统计中…' : `共 ${formatCount(totalRows)} 条记录 / ${datasets.length} 个数据集`}
              </span>
              <button
                type="button"
                onClick={() => void load()}
                disabled={loading}
                className={`${studioSecondaryButtonClassName} h-8 gap-1 px-2.5 py-0 text-[11px]`}
                aria-label="重新统计账户数据"
              >
                <FaSyncAlt size={11} className={loading ? 'animate-spin' : undefined} aria-hidden />
                刷新
              </button>
            </div>
          </div>

          {loading && !summary ? (
            <StudioLoadingState text="正在统计该账号的数据量…" minHeightClassName="min-h-[180px]" />
          ) : loadError ? (
            <StudioErrorState message={loadError} onRetry={() => void load()} />
          ) : (
            <>
              {nonEmpty.length === 0 ? (
                <p className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-6 text-center text-xs text-slate-500">
                  没有查到与该账号关联的数据记录。
                </p>
              ) : (
                <ul className="divide-y divide-slate-100 overflow-hidden rounded-2xl border border-slate-200">
                  {nonEmpty.map((dataset) => (
                    <li key={dataset.id} className="flex min-w-0 items-center justify-between gap-3 px-3 py-2">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="truncate text-xs font-medium text-slate-800">{dataset.label}</span>
                          <span className="shrink-0 rounded-full border border-slate-200 bg-slate-50 px-1.5 py-0.5 font-mono text-[10px] text-slate-500">
                            {dataset.collection}
                          </span>
                          {dataset.support === 'partial' ? (
                            <span
                              className="shrink-0 rounded-full border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700"
                              title={dataset.note || '只导出部分字段（凭据材料除外）'}
                            >
                              部分
                            </span>
                          ) : null}
                        </div>
                        {dataset.note ? (
                          <p className="mt-0.5 truncate text-[10px] text-slate-400" title={dataset.note}>{dataset.note}</p>
                        ) : null}
                      </div>
                      <span className="shrink-0 font-mono text-xs font-semibold text-slate-700">
                        {formatCount(dataset.count)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}

              {empty.length > 0 ? (
                <details className="rounded-2xl border border-slate-200 bg-white/80 px-3 py-2">
                  <summary className="cursor-pointer text-[11px] font-semibold text-slate-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400">
                    无记录的 {empty.length} 个数据集
                  </summary>
                  <p className="mt-2 text-[11px] leading-5 text-slate-500">
                    {empty.map((dataset) => dataset.label).join('、')}
                  </p>
                </details>
              ) : null}

              {summary && summary.omitted.length > 0 ? (
                <details className="rounded-2xl border border-slate-200 bg-white/80 px-3 py-2">
                  <summary className="cursor-pointer text-[11px] font-semibold text-slate-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400">
                    按隐私契约不进入账号导出的 {summary.omitted.length} 类数据
                  </summary>
                  <ul className="mt-2 space-y-1">
                    {summary.omitted.map((item) => (
                      <li key={item.id} className="text-[11px] leading-5 text-slate-500">
                        <span className="font-medium text-slate-700">{item.label}</span>：{item.reason}
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </>
          )}
        </section>

        {/* 导出 */}
        <section aria-label="导出账户数据" className="rounded-2xl border border-slate-200 bg-white p-4">
          <h3 className="text-sm font-semibold text-slate-900">导出账户数据</h3>
          <p className="mt-1 text-[11px] leading-5 text-slate-500">
            生成一份 JSON：账号资料、会话与设备、工单、语音合成、GeoGebra、Pixel、审计等记录。
            密码材料、令牌、密钥、密文与内部存储键会被替换为 <code className="font-mono">[redacted]</code>；
            「未包含的数据」会附上原因。导出动作会写入审计日志。
          </p>

          {!security.isActive ? (
            <div className="mt-3 space-y-2">
              <p className="flex items-start gap-1.5 rounded-2xl border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-5 text-amber-800">
                <FaExclamationTriangle className="mt-0.5 shrink-0" size={11} aria-hidden />
                <span>导出含账号个人信息，需要先完成一次身份验证（密码 / TOTP / Passkey）。验证后 5 分钟内可重复导出。</span>
              </p>
              <EstablishSecuritySession showActiveBar={false} />
            </div>
          ) : (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void handleExport()}
                disabled={exporting || loading}
                className={studioPrimaryButtonClassName}
              >
                {exporting ? <FaSyncAlt className="animate-spin" aria-hidden /> : <FaDownload aria-hidden />}
                {exporting ? '导出中…' : '导出 JSON'}
              </button>
              <span className="text-[10px] text-slate-400">
                安全会话有效至 {security.expiresAt ? new Date(security.expiresAt).toLocaleTimeString() : '本次会话'}
              </span>
            </div>
          )}
        </section>

        {/* 注销 */}
        <section aria-label="注销账户" className="rounded-2xl border border-rose-200 bg-rose-50/70 p-4">
          <h3 className="text-sm font-semibold text-rose-800">注销账号</h3>
          <p className="mt-1 text-[11px] leading-5 text-rose-700">
            注销会立即停用账号：撤销全部登录会话、禁用 API Key、清除密码与二次验证材料，并写入身份墓碑
            （同一邮箱 / 用户名不能重新注册绕过风控）。账号数据按法律保留与安全保留策略留存，不可由用户自助恢复。
            建议先导出数据再执行。
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void handleDelete()}
              disabled={Boolean(deleteDisabledReason) || deleting}
              title={deleteDisabledReason ?? undefined}
              className={studioDangerButtonClassName}
            >
              {deleting ? <FaSyncAlt className="animate-spin" aria-hidden /> : <FaTrash aria-hidden />}
              {deleting ? '注销中…' : alreadyDeleted ? '已注销' : '注销账号'}
            </button>
            {deleteDisabledReason ? (
              <span className="text-[10px] text-rose-600">{deleteDisabledReason}</span>
            ) : null}
          </div>
        </section>
      </div>
    </StudioModal>
  );
};

export default UserDataDialog;
