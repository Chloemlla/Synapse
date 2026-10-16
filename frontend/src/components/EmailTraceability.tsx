import React, { useEffect, useState, useCallback } from "react";
import { api } from "@/api";
import { FaSearch, FaRedo, FaEnvelope, FaDatabase, FaGlobe, FaEye, FaCopy, FaCheck, FaCode, FaFileAlt } from "react-icons/fa";
import { cn } from '../utils/cn';
import {
  studioFieldClassName,
  studioGhostButtonClassName,
  studioPrimaryButtonClassName,
  studioSecondaryButtonClassName,
  studioSoftBadgeClassName,
  studioSurfaceClassName,
} from './studioTheme';
import {
  StudioEmptyState,
  StudioErrorState,
  StudioLoadingState,
  StudioModal,
  StudioModalHeader,
  StudioPager,
} from './studioFeedback';

interface EmailRecord {
  _id: string;
  to: string;
  subject: string;
  content: string;
  sentAt: string;
  ip: string;
}

interface RecordsResponse {
  success: boolean;
  records: EmailRecord[];
  total: number;
  page: number;
  pageSize: number;
}

interface FullRecord {
  _id: string;
  to: string;
  subject: string;
  content: string;
  sentAt: string;
  ip: string;
}

interface QuotaInfo {
  used: number;
  total: number;
  resetAt: string;
}

interface ServiceStatus {
  available: boolean;
  error?: string;
  domain?: string;
  authConfigured?: boolean;
}

const PAGE_SIZE = 20;

function formatDateTime(value?: string) {
  if (!value) return "-";
  try {
    const d = new Date(value);
    return d.toLocaleString("zh-CN", { hour12: false });
  } catch {
    return value;
  }
}

const EmailTraceability: React.FC = () => {
  const [records, setRecords] = useState<EmailRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [searchTo, setSearchTo] = useState("");
  const [searchSubject, setSearchSubject] = useState("");
  const [status, setStatus] = useState<ServiceStatus | null>(null);
  const [quota, setQuota] = useState<QuotaInfo>({ used: 0, total: 0, resetAt: "" });

  // 详情弹窗状态
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailRecord, setDetailRecord] = useState<FullRecord | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detailError, setDetailError] = useState("");
  const [detailOpen, setDetailOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [viewMode, setViewMode] = useState<"text" | "html">("text");

  const fetchRecords = useCallback(async (p: number) => {
    setLoading(true);
    try {
      setLoadError(null);
      const params = new URLSearchParams();
      params.set("page", String(p));
      params.set("pageSize", String(PAGE_SIZE));
      if (searchTo.trim()) params.set("to", searchTo.trim());
      if (searchSubject.trim()) params.set("subject", searchSubject.trim());

      const res = await api.get(`/api/outemail/records?${params.toString()}`);
      const data = res.data as RecordsResponse;
      if (data.success) {
        setRecords(data.records);
        setTotal(data.total);
        setPage(data.page);
      }
    } catch (e) {
      console.error("获取邮件记录失败", e);
      setLoadError("获取邮件发送记录失败，请稍后重试");
    } finally {
      setLoading(false);
    }
  }, [searchTo, searchSubject]);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await api.get("/api/outemail/status");
      setStatus(res.data);
    } catch {
      // ignore
    }
  }, []);

  const fetchQuota = useCallback(async () => {
    try {
      const res = await api.get("/api/outemail/quota");
      if (res.data?.success) {
        setQuota({ used: res.data.used, total: res.data.total, resetAt: res.data.resetAt });
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    fetchRecords(1);
    fetchStatus();
    fetchQuota();
  }, [fetchRecords, fetchStatus, fetchQuota]);

  const handleSearch = () => fetchRecords(1);
  const handleRefresh = () => {
    fetchStatus();
    fetchQuota();
    fetchRecords(page);
  };

  const handleViewDetail = async (id: string) => {
    setDetailId(id);
    setDetailLoading(true);
    setDetailError("");
    setDetailRecord(null);
    setDetailOpen(true);
    setCopied(false);
    setViewMode("text");
    try {
      const res = await api.get(`/api/outemail/records/${id}`);
      if (res.data?.success && res.data?.record) {
        setDetailRecord(res.data.record);
      } else {
        setDetailError("读取邮件详情失败，请重试。");
      }
    } catch {
      setDetailError("读取邮件详情失败，请检查网络后重试。");
    } finally {
      setDetailLoading(false);
    }
  };

  const handleCloseDetail = () => {
    setDetailOpen(false);
    setDetailRecord(null);
    setDetailId(null);
    setDetailError("");
    setCopied(false);
    setViewMode("text");
  };

  const handleCopyContent = async () => {
    if (!detailRecord?.content) return;
    try {
      await navigator.clipboard.writeText(detailRecord.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  };

  const totalPages = Math.ceil(total / PAGE_SIZE);
  const quotaPercent = quota.total > 0 ? Math.min((quota.used / quota.total) * 100, 100) : 0;

  return (
    <div className="space-y-6">
      {/* 标题 */}
      <div className="flex items-center gap-3">
        <div className={cn(studioSoftBadgeClassName, "h-10 w-10 sm:h-10 sm:w-10")}>
          <FaDatabase className="size-4" aria-hidden />
        </div>
        <div>
          <h2 className="text-lg font-bold text-slate-900">邮件发信溯源日志</h2>
          <p className="text-sm text-slate-500">对外邮件发送记录查询与追踪</p>
        </div>
      </div>

      {/* 状态卡片 */}
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-2xl border border-slate-200/90 bg-white/90 p-4 shadow-sm">
          <div className="flex items-center gap-2">
            <FaGlobe className="size-4 text-slate-400" />
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">服务状态</span>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <span className={`size-2.5 rounded-full ${status?.available ? "bg-emerald-500" : "bg-rose-500"}`} />
            <span className="text-sm font-semibold text-slate-700">
              {status?.available ? "正常" : status?.error || "异常"}
            </span>
          </div>
          <div className="mt-1 text-xs text-slate-400">
            {status?.domain || "未配置域名"}
          </div>
        </div>

        <div className="rounded-2xl border border-slate-200/90 bg-white/90 p-4 shadow-sm">
          <div className="flex items-center gap-2">
            <FaEnvelope className="size-4 text-slate-400" />
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">今日配额</span>
          </div>
          <div className="mt-2 text-sm font-semibold text-slate-700">
            {quota.used} / {quota.total}
          </div>
          <div className="mt-1.5 h-1.5 rounded-full bg-slate-100">
            <div
              className="h-1.5 rounded-full bg-slate-900 transition-all"
              style={{ width: `${quotaPercent}%` }}
            />
          </div>
          <div className="mt-1 text-xs text-slate-400">
            重置时间：{formatDateTime(quota.resetAt)}
          </div>
        </div>

        <div className="rounded-2xl border border-slate-200/90 bg-white/90 p-4 shadow-sm">
          <div className="flex items-center gap-2">
            <FaDatabase className="size-4 text-slate-400" />
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">记录总数</span>
          </div>
          <div className="mt-2 text-2xl font-bold text-slate-900">{total}</div>
          <div className="mt-1 text-xs text-slate-400">
            当前第 {page} / {totalPages || 1} 页
          </div>
        </div>
      </div>

      {/* 搜索栏 */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <FaSearch className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-slate-400" aria-hidden />
          <input
            type="text"
            placeholder="搜索收件人邮箱..."
            aria-label="按收件人邮箱搜索"
            value={searchTo}
            onChange={(e) => setSearchTo(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            className={cn(studioFieldClassName, "py-2 pl-9 pr-3")}
          />
        </div>
        <div className="relative flex-1 min-w-[200px]">
          <FaSearch className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-slate-400" aria-hidden />
          <input
            type="text"
            placeholder="搜索邮件主题..."
            aria-label="按邮件主题搜索"
            value={searchSubject}
            onChange={(e) => setSearchSubject(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            className={cn(studioFieldClassName, "py-2 pl-9 pr-3")}
          />
        </div>
        <button
          type="button"
          onClick={handleSearch}
          className={studioPrimaryButtonClassName}
        >
          <FaSearch className="size-3.5" aria-hidden />
          查询
        </button>
        <button
          type="button"
          onClick={handleRefresh}
          className={studioSecondaryButtonClassName}
        >
          <FaRedo className="size-3.5" aria-hidden />
          刷新
        </button>
      </div>

      {/* 记录列表 */}
      <div className={cn(studioSurfaceClassName, "border-slate-200/90 bg-white/90")}>
        {loading ? (
          <StudioLoadingState text="加载中..." minHeightClassName="min-h-[320px]" />
        ) : loadError ? (
          <StudioErrorState message={loadError} onRetry={() => fetchRecords(page)} className="m-4" />
        ) : records.length === 0 ? (
          <StudioEmptyState
            message="暂无邮件发送记录"
            className="m-4"
            action={
              <button type="button" onClick={() => fetchRecords(1)} className={studioGhostButtonClassName}>
                <FaRedo aria-hidden /> 重新读取
              </button>
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50/50">
                  <th className="px-3 sm:px-4 py-3 font-semibold text-slate-500">发送时间</th>
                  <th className="px-3 sm:px-4 py-3 font-semibold text-slate-500">收件人</th>
                  <th className="px-3 sm:px-4 py-3 font-semibold text-slate-500">主题</th>
                  <th className="px-3 sm:px-4 py-3 font-semibold text-slate-500">内容摘要</th>
                  <th className="px-3 sm:px-4 py-3 font-semibold text-slate-500">来源 IP</th>
                  <th className="px-3 sm:px-4 py-3 font-semibold text-slate-500">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {records.map((rec, i) => (
                  <tr key={rec._id || i} className="hover:bg-slate-50/50">
                    <td className="whitespace-nowrap px-3 sm:px-4 py-3 text-slate-600">
                      {formatDateTime(rec.sentAt)}
                    </td>
                    <td className="max-w-[120px] sm:max-w-[200px] truncate px-3 sm:px-4 py-3 font-medium text-slate-800">
                      {rec.to}
                    </td>
                    <td className="max-w-[120px] sm:max-w-[200px] truncate px-3 sm:px-4 py-3 text-slate-600">
                      {rec.subject}
                    </td>
                    <td className="max-w-[150px] sm:max-w-[250px] truncate px-3 sm:px-4 py-3 text-slate-500">
                      {rec.content}
                    </td>
                    <td className="whitespace-nowrap px-3 sm:px-4 py-3 font-mono text-xs text-slate-400">
                      {rec.ip || "-"}
                    </td>
                    <td className="whitespace-nowrap px-3 sm:px-4 py-3">
                      <button
                        type="button"
                        onClick={() => handleViewDetail(rec._id)}
                        className={studioGhostButtonClassName}
                      >
                        <FaEye aria-hidden />
                        查看详情
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* 分页 */}
        <StudioPager
          page={page}
          pageSize={PAGE_SIZE}
          total={total}
          loading={loading}
          onPageChange={(next) => fetchRecords(next)}
          label="邮件记录分页"
          className="border-t border-slate-100 px-3 py-3 sm:px-4"
        />
      </div>

      {/* 详情弹窗 */}
      <StudioModal
        open={detailOpen}
        onClose={handleCloseDetail}
        labelledBy="email-traceability-detail-title"
        maxWidthClassName="max-w-2xl"
      >
        <StudioModalHeader
          title="邮件详情"
          titleId="email-traceability-detail-title"
          description="完整邮件内容查看"
          icon={<FaEnvelope className="size-4" aria-hidden />}
          iconClassName="bg-slate-100 text-slate-600"
          onClose={handleCloseDetail}
        />

        <div className="mt-5">
          {detailLoading ? (
            <StudioLoadingState text="加载中..." minHeightClassName="min-h-[280px]" />
          ) : detailError ? (
            <StudioErrorState
              message={detailError}
              onRetry={detailId ? () => void handleViewDetail(detailId) : undefined}
            />
          ) : detailRecord ? (
            <div className="space-y-4">
              {/* 元信息 */}
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-2xl bg-slate-50 p-3">
                  <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">收件人</span>
                  <p className="mt-1 text-sm font-medium text-slate-800 break-all">{detailRecord.to}</p>
                </div>
                <div className="rounded-2xl bg-slate-50 p-3">
                  <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">发送时间</span>
                  <p className="mt-1 text-sm font-medium text-slate-800">{formatDateTime(detailRecord.sentAt)}</p>
                </div>
                <div className="rounded-2xl bg-slate-50 p-3">
                  <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">主题</span>
                  <p className="mt-1 text-sm font-medium text-slate-800 break-all">{detailRecord.subject}</p>
                </div>
                <div className="rounded-2xl bg-slate-50 p-3">
                  <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">来源 IP</span>
                  <p className="mt-1 text-sm font-medium text-slate-800 font-mono">{detailRecord.ip || "-"}</p>
                </div>
              </div>

              {/* 完整内容 */}
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">完整内容</span>
                  <div className="flex items-center gap-2">
                    {/* 视图切换 */}
                    <div className="flex overflow-hidden rounded-2xl border border-slate-200 text-xs">
                      <button
                        type="button"
                        onClick={() => setViewMode("text")}
                        aria-pressed={viewMode === "text"}
                        className={`inline-flex min-h-11 items-center gap-1.5 px-2.5 py-1.5 font-medium ${
                          viewMode === "text"
                            ? "bg-slate-900 text-white"
                            : "bg-white text-slate-600 hover:bg-slate-50"
                        }`}
                      >
                        <FaFileAlt className="size-3" aria-hidden />
                        文本
                      </button>
                      <button
                        type="button"
                        onClick={() => setViewMode("html")}
                        aria-pressed={viewMode === "html"}
                        className={`inline-flex min-h-11 items-center gap-1.5 px-2.5 py-1.5 font-medium ${
                          viewMode === "html"
                            ? "bg-slate-900 text-white"
                            : "bg-white text-slate-600 hover:bg-slate-50"
                        }`}
                      >
                        <FaCode className="size-3" aria-hidden />
                        HTML
                      </button>
                    </div>
                    <button
                      type="button"
                      onClick={handleCopyContent}
                      className={`${studioGhostButtonClassName} min-h-11`}
                    >
                      {copied ? (
                        <>
                          <FaCheck className="size-3 text-emerald-500" />
                          已复制
                        </>
                      ) : (
                        <>
                          <FaCopy className="size-3" />
                          复制内容
                        </>
                      )}
                    </button>
                  </div>
                </div>
                {viewMode === "text" ? (
                  <div className="max-h-[300px] overflow-y-auto rounded-2xl border border-slate-200 bg-slate-50 p-4">
                    <pre className="whitespace-pre-wrap break-all text-sm text-slate-700 font-sans">
                      {detailRecord.content}
                    </pre>
                  </div>
                ) : (
                  <div className="max-h-[400px] overflow-hidden rounded-2xl border border-slate-200 bg-white">
                    <iframe
                      srcDoc={detailRecord.content}
                      title="邮件 HTML 预览"
                      sandbox="allow-same-origin"
                      className="h-[400px] w-full"
                      style={{ border: "none" }}
                    />
                  </div>
                )}
              </div>
            </div>
          ) : (
            <StudioEmptyState message="这条记录暂时没有可展示的邮件内容" />
          )}
        </div>
      </StudioModal>
    </div>
  );
};

export default EmailTraceability;