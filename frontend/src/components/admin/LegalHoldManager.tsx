import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  FaBan,
  FaCheckDouble,
  FaDownload,
  FaFileExport,
  FaLock,
  FaPlus,
  FaShieldAlt,
  FaSync,
  FaTrashAlt,
} from 'react-icons/fa';
import {
  legalHoldApi,
  extractLegalHoldDownloadError,
  extractLegalHoldErrorCode,
  type ForensicAuditEvent,
  type ForensicExportRequestRow,
  type LegalHoldRow,
  type LegalHoldScope,
} from '@/api/legalHold';
import EstablishSecuritySession from '@/components/EstablishSecuritySession';
import { useNotification } from '@/components/Notification';
import {
  InfoBadge,
  InfoMetricCard,
  InfoPanel,
  InfoQueryHero,
  InfoQueryShell,
  InfoSectionTitle,
  studioFieldClassName,
  studioSecondaryButtonClassName,
  studioPrimaryButtonClassName,
  studioTextareaClassName,
} from '@/components/studioTheme';
import {
  StudioEmptyState,
  StudioErrorNote,
  StudioErrorState,
  StudioLoadingState,
  StudioSuccessNote,
} from '@/components/studioFeedback';
import { useAuth } from '@/hooks/useAuth';
import { useSecuritySession } from '@/hooks/useSecuritySession';
import { isSuperAdmin } from '@/utils/rbac';
import { getBackendErrorMessage } from '@/utils/backendError';

/**
 * 法律保留与取证管理页（RC-22 / RC-35 / RC-58）。
 *
 * 视觉纪律：只用 studioTheme + studioFeedback 原语与 Slate 中性色（状态色用
 * sky/amber/emerald/rose 语义色），不引入新的调色板。
 *
 * 权限纪律：读列表是 admin 页面；登记/解除/导出/审计读取全部要求 superadmin + 安全会话。
 * 页面本身不代替服务端授权，未建立安全会话时写操作区只展示建立入口、不发请求。
 */

type TabKey = 'holds' | 'forensic';

const SCOPES: ReadonlyArray<{ value: LegalHoldScope; label: string; hint: string }> = [
  { value: 'user', label: '用户', hint: 'Synapse 用户 ID' },
  { value: 'ip', label: 'IP', hint: '单个 IPv4 / IPv6 地址' },
  { value: 'fingerprint', label: '指纹', hint: '设备指纹 ID' },
];

const STATUS_LABEL: Record<ForensicExportRequestRow['status'], string> = {
  pending: '待批准',
  approved: '已批准',
  downloaded: '已下载',
  expired: '已过期',
};

function formatTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('zh-CN', { hour12: false });
}

function scopeLabel(scope: LegalHoldScope | string): string {
  return SCOPES.find((item) => item.value === scope)?.label ?? scope;
}

const emptyHoldForm = {
  scope: 'user' as LegalHoldScope,
  value: '',
  caseRef: '',
  reason: '',
  expiresAt: '',
};

const emptyExportForm = {
  scope: 'user' as LegalHoldScope,
  value: '',
  caseRef: '',
  reason: '',
  from: '',
  to: '',
};

export default function LegalHoldManager() {
  const { user } = useAuth();
  const { setNotification } = useNotification();
  const { verificationToken, isActive } = useSecuritySession();
  const canWrite = isSuperAdmin(user?.role) && isActive && Boolean(verificationToken);

  const [tab, setTab] = useState<TabKey>('holds');
  const [holds, setHolds] = useState<LegalHoldRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [includeReleased, setIncludeReleased] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [holdForm, setHoldForm] = useState(emptyHoldForm);
  const [creating, setCreating] = useState(false);
  const [releaseFor, setReleaseFor] = useState<string | null>(null);
  const [releaseCaseRef, setReleaseCaseRef] = useState('');
  const [releaseReason, setReleaseReason] = useState('');
  const [releasing, setReleasing] = useState(false);

  const [cleanupRunning, setCleanupRunning] = useState(false);
  const [cleanupSummary, setCleanupSummary] = useState<string | null>(null);

  const [auditEvents, setAuditEvents] = useState<ForensicAuditEvent[]>([]);
  const [auditCursor, setAuditCursor] = useState<string | null>(null);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [auditCaseRef, setAuditCaseRef] = useState('');

  const [exportForm, setExportForm] = useState(emptyExportForm);
  const [exportPending, setExportPending] = useState(false);
  const [exportRequest, setExportRequest] = useState<ForensicExportRequestRow | null>(null);
  const [approveId, setApproveId] = useState('');
  const [approving, setApproving] = useState(false);
  const [downloadId, setDownloadId] = useState('');
  const [downloading, setDownloading] = useState(false);
  const [lastDownload, setLastDownload] = useState<{ checksum: string; rowCount: number; filename: string } | null>(
    null,
  );

  const loadHolds = useCallback(
    async (cursor?: string) => {
      const firstPage = !cursor;
      if (firstPage) {
        setLoading(true);
        setError(null);
      } else {
        setLoadingMore(true);
      }
      try {
        const res = await legalHoldApi.list({
          includeReleased,
          limit: 50,
          cursor,
        });
        setHolds((current) => (firstPage ? res.holds : [...current, ...res.holds]));
        setNextCursor(res.nextCursor);
        if (res.auditWarning) setNotice(res.auditWarning);
      } catch (loadError) {
        const message = getBackendErrorMessage(loadError, '加载法律保留列表失败');
        setError(message);
        if (firstPage) setNotification({ message, type: 'error' });
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [includeReleased, setNotification],
  );

  useEffect(() => {
    void loadHolds();
  }, [loadHolds]);

  const loadAudit = useCallback(
    async (cursor?: string, caseRef = auditCaseRef) => {
      if (!canWrite) return;
      const firstPage = !cursor;
      if (firstPage) setAuditLoading(true);
      setAuditError(null);
      try {
        const res = await legalHoldApi.listForensicAudit(
          { limit: 50, cursor, caseRef: caseRef || undefined },
          verificationToken,
        );
        setAuditEvents((current) => (firstPage ? res.events : [...current, ...res.events]));
        setAuditCursor(res.nextCursor);
      } catch (loadError) {
        setAuditError(getBackendErrorMessage(loadError, '读取取证审计失败'));
      } finally {
        if (firstPage) setAuditLoading(false);
      }
    },
    [auditCaseRef, canWrite, verificationToken],
  );

  useEffect(() => {
    if (tab !== 'forensic') return;
    if (!canWrite) {
      setAuditEvents([]);
      setAuditCursor(null);
      return;
    }
    setAuditEvents([]);
    setAuditCursor(null);
    void loadAudit(undefined, auditCaseRef);
    // 只在切到取证 tab 或安全会话建立后拉一次；筛选用按钮显式触发。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, canWrite, verificationToken]);

  const activeHolds = useMemo(() => holds.filter((hold) => !hold.releasedAt), [holds]);
  const releasedHolds = useMemo(() => holds.filter((hold) => Boolean(hold.releasedAt)), [holds]);

  const submitHold = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canWrite) return;
    setCreating(true);
    setError(null);
    setNotice(null);
    try {
      const res = await legalHoldApi.create(
        {
          scope: holdForm.scope,
          value: holdForm.value.trim(),
          caseRef: holdForm.caseRef.trim(),
          reason: holdForm.reason.trim(),
          expiresAt: holdForm.expiresAt ? new Date(holdForm.expiresAt).toISOString() : undefined,
        },
        verificationToken,
      );
      setNotice(`已登记法律保留（案件 ${res.hold.caseRef}），该对象的物理删除现已冻结。`);
      setHoldForm(emptyHoldForm);
      await loadHolds();
    } catch (createError) {
      setError(getBackendErrorMessage(createError, '登记法律保留失败'));
    } finally {
      setCreating(false);
    }
  };

  const submitRelease = async (holdId: string) => {
    if (!canWrite) return;
    setReleasing(true);
    setError(null);
    setNotice(null);
    try {
      await legalHoldApi.release(
        holdId,
        { caseRef: releaseCaseRef.trim(), releaseReason: releaseReason.trim() },
        verificationToken,
      );
      setNotice('已解除法律保留；请在解除理由中留下法务确认依据。');
      setReleaseFor(null);
      setReleaseCaseRef('');
      setReleaseReason('');
      await loadHolds();
    } catch (releaseError) {
      setError(getBackendErrorMessage(releaseError, '解除法律保留失败'));
    } finally {
      setReleasing(false);
    }
  };

  const runCleanup = async () => {
    if (!canWrite) return;
    setCleanupRunning(true);
    setError(null);
    setCleanupSummary(null);
    try {
      const res = await legalHoldApi.runCleanup(true, verificationToken);
      const report = res.report;
      setCleanupSummary(
        `预演完成：扫描 ${report.targets.reduce((sum, item) => sum + item.scanned, 0)} 行，` +
          `可清理 ${report.totalDeleted} 行，命中 hold 跳过 ${report.totalSkippedHeld} 行。` +
          `本轮是 dryRun，没有删除任何数据。`,
      );
    } catch (cleanupError) {
      setError(getBackendErrorMessage(cleanupError, '执行清理预演失败'));
    } finally {
      setCleanupRunning(false);
    }
  };

  const submitExport = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canWrite) return;
    setExportPending(true);
    setError(null);
    setNotice(null);
    try {
      const res = await legalHoldApi.createExport(
        {
          scope: exportForm.scope,
          value: exportForm.value.trim(),
          caseRef: exportForm.caseRef.trim(),
          reason: exportForm.reason.trim(),
          from: exportForm.from ? new Date(exportForm.from).toISOString() : undefined,
          to: exportForm.to ? new Date(exportForm.to).toISOString() : undefined,
        },
        verificationToken,
      );
      setExportRequest(res.request);
      setNotice(
        `导出申请 ${res.request.requestId} 已创建（预计 ${res.potentialRows} 行）。` +
          `请让另一位超级管理员在 15 分钟内批准；发起人不能批准自己的申请。`,
      );
    } catch (exportError) {
      const code = extractLegalHoldErrorCode(exportError);
      setError(
        code === 'EXPORT_LIMIT_EXCEEDED'
          ? getBackendErrorMessage(exportError, '导出行数超过硬顶，已拒绝导出（未截断）')
          : getBackendErrorMessage(exportError, '发起取证导出失败'),
      );
    } finally {
      setExportPending(false);
    }
  };

  const approveExport = async () => {
    if (!canWrite || !approveId.trim()) return;
    setApproving(true);
    setError(null);
    setNotice(null);
    try {
      const res = await legalHoldApi.approveExport(approveId.trim(), verificationToken);
      setNotice(`申请 ${res.request.requestId} 已批准，可由发起人或批准人下载。`);
      setApproveId('');
      await loadAudit();
    } catch (approveError) {
      setError(getBackendErrorMessage(approveError, '批准取证导出失败'));
    } finally {
      setApproving(false);
    }
  };

  const downloadExport = async () => {
    if (!canWrite || !downloadId.trim()) return;
    setDownloading(true);
    setError(null);
    setNotice(null);
    setLastDownload(null);
    try {
      const result = await legalHoldApi.downloadExport(downloadId.trim(), verificationToken);
      const url = URL.createObjectURL(result.blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = result.filename;
      anchor.rel = 'noopener';
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
      setLastDownload({ checksum: result.checksum, rowCount: result.rowCount, filename: result.filename });
      setNotice(`归档已下载：${result.rowCount} 行，SHA-256 ${result.checksum || '未解析到'}。`);
      setDownloadId('');
      await loadAudit();
    } catch (downloadError) {
      const parsed = await extractLegalHoldDownloadError(downloadError, '下载取证归档失败');
      setError(
        parsed.code === 'EXPORT_LIMIT_EXCEEDED'
          ? `${parsed.message}（未截断）`
          : parsed.message,
      );
    } finally {
      setDownloading(false);
    }
  };

  const requiresSession = isSuperAdmin(user?.role) && !isActive;

  return (
    <InfoQueryShell maxWidthClassName="max-w-7xl">
      <InfoQueryHero
        eyebrow="取证与法律保留"
        title="法律保留管理"
        description={
          '登记法律保留后，命中对象（用户 / IP / 指纹）的物理删除一律被冻结；清理任务逐条校验 hold，' +
          '数据库不可用时按“疑似被保留”fail-closed 处理。取证导出仅限 superadmin 手工触发，' +
          '需要第二位超级管理员批准，产出带 SHA-256 校验和的 NDJSON 归档，并把交付本身写入不设 TTL 的取证审计。'
        }
        icon={FaShieldAlt}
        tone="slate"
        meta={
          <>
            <InfoBadge tone="slate">本页生效中 {activeHolds.length}</InfoBadge>
            <InfoBadge tone="slate">本页已解除 {releasedHolds.length}</InfoBadge>
            <InfoBadge tone={isActive ? 'emerald' : 'amber'}>
              {isActive ? '安全会话有效' : '安全会话未建立'}
            </InfoBadge>
          </>
        }
      />

      {requiresSession ? (
        <div className="mt-6">
          <InfoPanel>
            <InfoSectionTitle
              title="建立安全会话"
              description="登记/解除法律保留与取证导出属于高危动作，需要先通过密码、TOTP 或 Passkey 二次验证。读取列表不需要。"
              icon={FaLock}
              tone="slate"
            />
            <EstablishSecuritySession showActiveBar={false} />
          </InfoPanel>
        </div>
      ) : null}

      <div className="mt-6 flex flex-wrap gap-2" role="tablist" aria-label="法律保留管理分区">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'holds'}
          onClick={() => setTab('holds')}
          className={`${studioSecondaryButtonClassName} ${tab === 'holds' ? 'border-slate-900 text-slate-900' : ''}`}
        >
          <FaBan aria-hidden /> 保留登记
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'forensic'}
          onClick={() => setTab('forensic')}
          className={`${studioSecondaryButtonClassName} ${tab === 'forensic' ? 'border-slate-900 text-slate-900' : ''}`}
        >
          <FaFileExport aria-hidden /> 取证导出与审计
        </button>
      </div>

      {error ? (
        <div className="mt-4">
          <StudioErrorNote>{error}</StudioErrorNote>
        </div>
      ) : null}
      {notice ? (
        <div className="mt-4">
          <StudioSuccessNote>{notice}</StudioSuccessNote>
        </div>
      ) : null}

      {tab === 'holds' ? (
        <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <InfoPanel>
            <InfoSectionTitle
              title="法律保留"
              description="生效中的保留会阻止该对象的任何物理删除；解除需要案件编号与理由。"
              icon={FaBan}
              tone="slate"
              action={
                <button
                  type="button"
                  className={studioSecondaryButtonClassName}
                  onClick={() => void loadHolds()}
                  disabled={loading}
                >
                  <FaSync aria-hidden /> 刷新
                </button>
              }
            />

            <label className="mb-4 flex items-center gap-2 text-sm text-slate-600">
              <input
                type="checkbox"
                checked={includeReleased}
                onChange={(event) => setIncludeReleased(event.target.checked)}
              />
              同时显示已解除的记录
            </label>

            {loading ? <StudioLoadingState text="加载法律保留记录..." minHeightClassName="min-h-[220px]" /> : null}

            {!loading && error && holds.length === 0 ? (
              <StudioErrorState message={error} onRetry={() => void loadHolds()} />
            ) : null}

            {!loading && !error && holds.length === 0 ? (
              <StudioEmptyState message="还没有登记任何法律保留。收到执法/监管调取要求后，在右侧登记第一条。" />
            ) : null}

            {!loading && holds.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] border-collapse text-left text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-xs uppercase tracking-[0.14em] text-slate-500">
                      <th className="px-2 py-3">范围</th>
                      <th className="px-2 py-3">对象</th>
                      <th className="px-2 py-3">案件</th>
                      <th className="px-2 py-3">登记人 / 时间</th>
                      <th className="px-2 py-3">状态</th>
                      <th className="px-2 py-3">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {holds.map((hold) => (
                      <React.Fragment key={hold.id}>
                        <tr className="border-b border-slate-100 align-top text-slate-700">
                          <td className="px-2 py-3">{scopeLabel(hold.scope)}</td>
                          <td className="max-w-[220px] break-all px-2 py-3 font-mono text-xs text-slate-600">
                            {hold.value}
                          </td>
                          <td className="px-2 py-3">
                            <div className="font-semibold text-slate-900">{hold.caseRef}</div>
                            <div className="mt-1 max-w-[240px] text-xs text-slate-500">{hold.reason}</div>
                          </td>
                          <td className="px-2 py-3 text-xs text-slate-500">
                            {hold.issuedBy}
                            <br />
                            {formatTime(hold.issuedAt)}
                          </td>
                          <td className="px-2 py-3">
                            <InfoBadge tone={hold.releasedAt ? 'slate' : 'rose'}>
                              {hold.releasedAt ? '已解除' : '生效中'}
                            </InfoBadge>
                            {hold.expiresAt ? (
                              <div className="mt-1 text-xs text-slate-500">到期 {formatTime(hold.expiresAt)}</div>
                            ) : null}
                          </td>
                          <td className="px-2 py-3">
                            {hold.releasedAt ? (
                              <div className="max-w-[220px] text-xs text-slate-500">
                                解除人 {hold.releasedBy || '—'}
                                <br />
                                {hold.releaseReason || '—'}
                              </div>
                            ) : (
                              <button
                                type="button"
                                className={studioSecondaryButtonClassName}
                                disabled={!canWrite}
                                onClick={() => {
                                  setReleaseFor(releaseFor === hold.id ? null : hold.id);
                                  setReleaseCaseRef(hold.caseRef);
                                  setReleaseReason('');
                                }}
                              >
                                <FaTrashAlt aria-hidden /> 解除
                              </button>
                            )}
                          </td>
                        </tr>
                        {releaseFor === hold.id ? (
                          <tr className="border-b border-slate-100 bg-slate-50">
                            <td colSpan={6} className="px-3 py-4">
                              <div className="grid gap-3 md:grid-cols-2">
                                <label className="text-sm text-slate-700">
                                  案件编号（必须与记录一致）
                                  <input
                                    className={`${studioFieldClassName} mt-2`}
                                    value={releaseCaseRef}
                                    onChange={(event) => setReleaseCaseRef(event.target.value)}
                                  />
                                </label>
                                <label className="text-sm text-slate-700">
                                  解除理由（法务确认依据）
                                  <input
                                    className={`${studioFieldClassName} mt-2`}
                                    value={releaseReason}
                                    onChange={(event) => setReleaseReason(event.target.value)}
                                  />
                                </label>
                              </div>
                              <div className="mt-3 flex flex-wrap gap-2">
                                <button
                                  type="button"
                                  className={studioPrimaryButtonClassName}
                                  disabled={releasing || !releaseCaseRef.trim() || !releaseReason.trim()}
                                  onClick={() => void submitRelease(hold.id)}
                                >
                                  <FaCheckDouble aria-hidden /> {releasing ? '解除中...' : '确认解除'}
                                </button>
                                <button
                                  type="button"
                                  className={studioSecondaryButtonClassName}
                                  onClick={() => setReleaseFor(null)}
                                >
                                  取消
                                </button>
                              </div>
                            </td>
                          </tr>
                        ) : null}
                      </React.Fragment>
                    ))}
                  </tbody>
                </table>
                {nextCursor ? (
                  <div className="mt-4 flex justify-center">
                    <button
                      type="button"
                      className={studioSecondaryButtonClassName}
                      disabled={loadingMore}
                      onClick={() => void loadHolds(nextCursor)}
                    >
                      {loadingMore ? '加载中...' : '加载更多'}
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}
          </InfoPanel>

          <div className="grid gap-6">
            <InfoPanel>
              <InfoSectionTitle
                title="登记法律保留"
                description="理由与案件编号都是必填：调查结束或监管询问时，他人要能仅凭记录判断保留是否仍成立。"
                icon={FaPlus}
                tone="slate"
              />
              <form className="grid gap-3" onSubmit={submitHold}>
                <label className="text-sm text-slate-700">
                  范围
                  <select
                    className={`${studioFieldClassName} mt-2`}
                    value={holdForm.scope}
                    onChange={(event) =>
                      setHoldForm((current) => ({ ...current, scope: event.target.value as LegalHoldScope }))
                    }
                  >
                    {SCOPES.map((scope) => (
                      <option key={scope.value} value={scope.value}>
                        {scope.label} — {scope.hint}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-sm text-slate-700">
                  对象值
                  <input
                    className={`${studioFieldClassName} mt-2`}
                    value={holdForm.value}
                    onChange={(event) => setHoldForm((current) => ({ ...current, value: event.target.value }))}
                    placeholder={SCOPES.find((scope) => scope.value === holdForm.scope)?.hint}
                    required
                  />
                </label>
                <label className="text-sm text-slate-700">
                  案件编号
                  <input
                    className={`${studioFieldClassName} mt-2`}
                    value={holdForm.caseRef}
                    onChange={(event) => setHoldForm((current) => ({ ...current, caseRef: event.target.value }))}
                    placeholder="例如 2026-京-刑-0123"
                    required
                  />
                </label>
                <label className="text-sm text-slate-700">
                  保留理由
                  <textarea
                    className={`${studioTextareaClassName} mt-2`}
                    rows={3}
                    value={holdForm.reason}
                    onChange={(event) => setHoldForm((current) => ({ ...current, reason: event.target.value }))}
                    placeholder="法律依据 / 文书编号 / 用户授权"
                    required
                  />
                </label>
                <label className="text-sm text-slate-700">
                  到期时间（可选；到期不会删数据，只是不再阻止后续清理）
                  <input
                    type="datetime-local"
                    className={`${studioFieldClassName} mt-2`}
                    value={holdForm.expiresAt}
                    onChange={(event) => setHoldForm((current) => ({ ...current, expiresAt: event.target.value }))}
                  />
                </label>
                <button
                  type="submit"
                  className={studioPrimaryButtonClassName}
                  disabled={!canWrite || creating}
                >
                  <FaShieldAlt aria-hidden /> {creating ? '登记中...' : '登记并为该对象冻结删除'}
                </button>
                {!canWrite ? (
                  <p className="text-xs text-slate-500">需要超级管理员 + 有效安全会话才能登记或解除保留。</p>
                ) : null}
              </form>
            </InfoPanel>

            <InfoPanel>
              <InfoSectionTitle
                title="清理预演"
                description="裁决三：关键集合去掉物理 TTL，改应用层清理，清理前逐条校验 hold。这里只跑 dryRun，不会删除任何数据。"
                icon={FaSync}
                tone="slate"
              />
              <button
                type="button"
                className={studioSecondaryButtonClassName}
                disabled={!canWrite || cleanupRunning}
                onClick={() => void runCleanup()}
              >
                {cleanupRunning ? '预演中...' : '运行 dryRun 清理预演'}
              </button>
              {cleanupSummary ? <p className="mt-3 text-sm text-slate-600">{cleanupSummary}</p> : null}
            </InfoPanel>
          </div>
        </div>
      ) : null}

      {tab === 'forensic' ? (
        <div className="mt-6 grid gap-6">
          <div className="grid gap-4 md:grid-cols-3">
            <InfoMetricCard
              label="导出硬顶"
              value="20,000 行"
              detail="按 _id 游标流式读取；超限返回 EXPORT_LIMIT_EXCEEDED，不截断"
              icon={FaFileExport}
              tone="slate"
            />
            <InfoMetricCard
              label="双人确认"
              value="发起 + 批准"
              detail="两位不同的 superadmin；申请 15 分钟内有效"
              icon={FaCheckDouble}
              tone="slate"
            />
            <InfoMetricCard
              label="取证审计"
              value="不设 TTL"
              detail="交付记录与校验和留在 forensic_audit_logs"
              icon={FaShieldAlt}
              tone="slate"
            />
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <InfoPanel>
              <InfoSectionTitle
                title="发起导出申请"
                description="只允许导出有生效中法律保留的对象；最多 20,000 行，超过会被拒绝而不是截断。"
                icon={FaFileExport}
                tone="slate"
              />
              <form className="grid gap-3" onSubmit={submitExport}>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="text-sm text-slate-700">
                    范围
                    <select
                      className={`${studioFieldClassName} mt-2`}
                      value={exportForm.scope}
                      onChange={(event) =>
                        setExportForm((current) => ({ ...current, scope: event.target.value as LegalHoldScope }))
                      }
                    >
                      {SCOPES.map((scope) => (
                        <option key={scope.value} value={scope.value}>
                          {scope.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="text-sm text-slate-700">
                    对象值
                    <input
                      className={`${studioFieldClassName} mt-2`}
                      value={exportForm.value}
                      onChange={(event) => setExportForm((current) => ({ ...current, value: event.target.value }))}
                      required
                    />
                  </label>
                </div>
                <label className="text-sm text-slate-700">
                  案件编号
                  <input
                    className={`${studioFieldClassName} mt-2`}
                    value={exportForm.caseRef}
                    onChange={(event) => setExportForm((current) => ({ ...current, caseRef: event.target.value }))}
                    required
                  />
                </label>
                <label className="text-sm text-slate-700">
                  导出理由
                  <textarea
                    className={`${studioTextareaClassName} mt-2`}
                    rows={2}
                    value={exportForm.reason}
                    onChange={(event) => setExportForm((current) => ({ ...current, reason: event.target.value }))}
                    required
                  />
                </label>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="text-sm text-slate-700">
                    起始时间（可选）
                    <input
                      type="datetime-local"
                      className={`${studioFieldClassName} mt-2`}
                      value={exportForm.from}
                      onChange={(event) => setExportForm((current) => ({ ...current, from: event.target.value }))}
                    />
                  </label>
                  <label className="text-sm text-slate-700">
                    结束时间（可选）
                    <input
                      type="datetime-local"
                      className={`${studioFieldClassName} mt-2`}
                      value={exportForm.to}
                      onChange={(event) => setExportForm((current) => ({ ...current, to: event.target.value }))}
                    />
                  </label>
                </div>
                <button type="submit" className={studioPrimaryButtonClassName} disabled={!canWrite || exportPending}>
                  <FaFileExport aria-hidden /> {exportPending ? '创建中...' : '创建导出申请'}
                </button>
                {!canWrite ? <p className="text-xs text-slate-500">需要超级管理员 + 有效安全会话。</p> : null}
              </form>

              {exportRequest ? (
                <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
                  <div className="font-semibold text-slate-900">申请 {exportRequest.requestId}</div>
                  <div className="mt-2 grid gap-1 text-xs text-slate-600">
                    <span>状态：{STATUS_LABEL[exportRequest.status]}</span>
                    <span>案件：{exportRequest.caseRef}</span>
                    <span>对象：{scopeLabel(exportRequest.scope)} / {exportRequest.subjectValue}</span>
                    <span>有效期至：{formatTime(exportRequest.expiresAt)}</span>
                  </div>
                  <div className="mt-2 break-all font-mono text-[11px] text-slate-500">
                    下载编号：{exportRequest.requestId}
                  </div>
                </div>
              ) : null}
            </InfoPanel>

            <InfoPanel>
              <InfoSectionTitle
                title="双人确认与下载"
                description="批准必须由另一位超级管理员完成。下载为流式 NDJSON，最后一行 manifest 携带 SHA-256。"
                icon={FaCheckDouble}
                tone="slate"
              />
              <div className="grid gap-3">
                <label className="text-sm text-slate-700">
                  批准导出申请
                  <div className="mt-2 flex flex-wrap gap-2">
                    <input
                      className={studioFieldClassName}
                      value={approveId}
                      onChange={(event) => setApproveId(event.target.value)}
                      placeholder="fxr_..."
                    />
                    <button
                      type="button"
                      className={studioSecondaryButtonClassName}
                      disabled={!canWrite || approving || !approveId.trim()}
                      onClick={() => void approveExport()}
                    >
                      {approving ? '批准中...' : '批准'}
                    </button>
                  </div>
                </label>

                <label className="text-sm text-slate-700">
                  下载归档
                  <div className="mt-2 flex flex-wrap gap-2">
                    <input
                      className={studioFieldClassName}
                      value={downloadId}
                      onChange={(event) => setDownloadId(event.target.value)}
                      placeholder="fxr_..."
                    />
                    <button
                      type="button"
                      className={studioPrimaryButtonClassName}
                      disabled={!canWrite || downloading || !downloadId.trim()}
                      onClick={() => void downloadExport()}
                    >
                      <FaDownload aria-hidden /> {downloading ? '下载中...' : '下载'}
                    </button>
                  </div>
                </label>

                {lastDownload ? (
                  <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
                    <div className="font-semibold text-slate-900">{lastDownload.filename}</div>
                    <div className="mt-2 text-xs text-slate-600">行数：{lastDownload.rowCount}</div>
                    <div className="mt-1 break-all font-mono text-[11px] text-slate-500">
                      SHA-256：{lastDownload.checksum || '未解析到 manifest'}
                    </div>
                  </div>
                ) : null}
              </div>
            </InfoPanel>
          </div>

          <InfoPanel>
            <InfoSectionTitle
              title="取证审计（不设 TTL）"
              description="法律保留的登记/解除、导出申请/批准/下载都会双写普通审计与 forensic_audit_logs。"
              icon={FaShieldAlt}
              tone="slate"
              action={
                canWrite ? (
                  <div className="flex flex-wrap gap-2">
                    <input
                      className={studioFieldClassName}
                      value={auditCaseRef}
                      onChange={(event) => setAuditCaseRef(event.target.value)}
                      placeholder="按案件编号筛选"
                    />
                    <button
                      type="button"
                      className={studioSecondaryButtonClassName}
                      onClick={() => {
                        setAuditEvents([]);
                        setAuditCursor(null);
                        void loadAudit(undefined, auditCaseRef);
                      }}
                    >
                      <FaSync aria-hidden /> 查询
                    </button>
                  </div>
                ) : undefined
              }
            />

            {!canWrite ? (
              <StudioEmptyState message="建立安全会话后可查看不设 TTL 的取证审计。" />
            ) : auditLoading ? (
              <StudioLoadingState text="读取取证审计..." minHeightClassName="min-h-[180px]" />
            ) : auditError ? (
              <StudioErrorState message={auditError} onRetry={() => void loadAudit(undefined, auditCaseRef)} />
            ) : auditEvents.length === 0 ? (
              <StudioEmptyState message="当前筛选下没有取证事件。" />
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[760px] border-collapse text-left text-sm">
                    <thead>
                      <tr className="border-b border-slate-200 text-xs uppercase tracking-[0.14em] text-slate-500">
                        <th className="px-2 py-3">时间</th>
                        <th className="px-2 py-3">动作</th>
                        <th className="px-2 py-3">操作者</th>
                        <th className="px-2 py-3">案件</th>
                        <th className="px-2 py-3">对象</th>
                        <th className="px-2 py-3">来源</th>
                      </tr>
                    </thead>
                    <tbody>
                      {auditEvents.map((event) => (
                        <tr key={event.eventId} className="border-b border-slate-100 align-top text-slate-700">
                          <td className="px-2 py-3 text-xs text-slate-500">{formatTime(event.createdAt)}</td>
                          <td className="px-2 py-3 font-mono text-xs">{event.action}</td>
                          <td className="px-2 py-3 text-xs">
                            {event.actorUsername}
                            <br />
                            <span className="text-slate-500">{event.actorRole}</span>
                          </td>
                          <td className="px-2 py-3 text-xs">{event.caseRef || '—'}</td>
                          <td className="max-w-[220px] px-2 py-3 break-all font-mono text-xs text-slate-600">
                            {event.scope ? `${scopeLabel(event.scope)} / ${event.subjectValue}` : '—'}
                          </td>
                          <td className="px-2 py-3 text-xs text-slate-500">
                            {event.ip}
                            <br />
                            {event.path || '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {auditCursor ? (
                  <div className="mt-4 flex justify-center">
                    <button
                      type="button"
                      className={studioSecondaryButtonClassName}
                      onClick={() => void loadAudit(auditCursor, auditCaseRef)}
                    >
                      加载更多
                    </button>
                  </div>
                ) : null}
              </>
            )}
          </InfoPanel>
        </div>
      ) : null}
    </InfoQueryShell>
  );
}
