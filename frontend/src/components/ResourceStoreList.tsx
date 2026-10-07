import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Link } from "react-router-dom";
import {
  FaCalendarAlt,
  FaCheckCircle,
  FaDownload,
  FaExclamationTriangle,
  FaGift,
  FaHistory,
  FaInfoCircle,
  FaKey,
  FaSearch,
  FaStore,
  FaSync,
  FaTag,
  FaUser,
} from "react-icons/fa";
import { cdksApi, type RedeemedResource } from "../api/cdks";
import { resourcesApi, type Resource } from "../api/resources";
import { cn } from "../utils/cn";
import { UnifiedLoadingSpinner } from "./LoadingSpinner";
import {
  studioAccentBlobBlueClassName,
  studioAccentBlobSkyClassName,
  studioDarkPanelClassName,
  studioDisplayFont,
  studioEyebrowPillClassName,
  studioFieldClassName,
  studioGhostButtonClassName,
  studioHeroCardClassName,
  studioMainSurfaceClassName,
  studioMetricToneClassName,
  studioModalCardClassName,
  studioModalOverlayClassName,
  studioPageClassName,
  studioPageFont,
  studioPanelClassName,
  studioPillClassName,
  studioPrimaryButtonClassName,
} from "./studioTheme";
import ManagedCaptcha, {
  type ManagedCaptchaChallenge,
  type ManagedCaptchaRef,
  type ManagedCaptchaStatus,
} from "./ManagedCaptcha";
import { useAuth } from "../hooks/useAuth";
import { isAdminRole } from "../utils/rbac";
import { getCaptchaDisplayName } from "../utils/captchaSelection";

function formatRedeemedDate(value: Date | string): string {
  return new Date(value).toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatRedeemedTime(value: Date | string): string {
  return new Date(value).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatRelativeAge(value: Date | string): string {
  const now = Date.now();
  const target = new Date(value).getTime();
  const diffMinutes = Math.max(0, Math.floor((now - target) / 60000));
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffDays > 0) {
    return `${diffDays} 天 ${diffHours % 24} 小时`;
  }
  if (diffHours > 0) {
    return `${diffHours} 小时 ${diffMinutes % 60} 分钟`;
  }
  if (diffMinutes > 0) {
    return `${diffMinutes} 分钟`;
  }
  return "刚刚";
}

export default function ResourceStoreList() {
  const [resources, setResources] = useState<Resource[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [pageSize, setPageSize] = useState(10);
  const resourceRequest = useRef(0);
  const [redeemedResources, setRedeemedResources] = useState<
    RedeemedResource[]
  >([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [selectedCategory, setSelectedCategory] = useState("");
  const [cdkCode, setCdkCode] = useState("");
  const [loading, setLoading] = useState(true);
  const [cdkLoading, setCdkLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  // 列表加载失败必须与「本来就没有资源」分开：把接口失败渲染成空态会让用户以为商店是空的，
  // 从而放弃重试。这两项只服务于列表本身，不复用 CDK 兑换面板的错误位。
  const [resourcesError, setResourcesError] = useState("");
  const [redeemedError, setRedeemedError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [activeTab, setActiveTab] = useState<"store" | "owned">("store");
  const [redeemedLoading, setRedeemedLoading] = useState(false);
  const [showDuplicateDialog, setShowDuplicateDialog] = useState(false);
  const [duplicateResourceInfo, setDuplicateResourceInfo] = useState<{
    title: string;
    id: string;
  } | null>(null);
  const [pendingCDKCode, setPendingCDKCode] = useState("");
  const [redeemedCount, setRedeemedCount] = useState(0);
  // 人机验证：三家供应商共用同一套下发链路（/admin/captcha-providers 调控）。
  const [captcha, setCaptcha] = useState<ManagedCaptchaChallenge | null>(null);
  const captchaRef = useRef<ManagedCaptchaRef | null>(null);
  const submittingRef = useRef(false);
  const [captchaStatus, setCaptchaStatus] = useState<ManagedCaptchaStatus>({
    required: false,
    loading: true,
    error: null,
    provider: null,
    solved: false,
  });
  const handleCaptchaSolved = useCallback((challenge: ManagedCaptchaChallenge) => setCaptcha(challenge), []);
  const handleCaptchaCleared = useCallback(() => setCaptcha(null), []);
  const handleCaptchaStatus = useCallback((status: ManagedCaptchaStatus) => setCaptchaStatus(status), []);
  const providerLabel = captchaStatus.provider ? getCaptchaDisplayName(captchaStatus.provider) : "人机验证";

  const { user } = useAuth();
  const isAdmin = useMemo(() => isAdminRole(user?.role), [user]);

  const fetchResources = async () => {
    const request = ++resourceRequest.current;
    setLoading(true);
    try {
      const response = await resourcesApi.getResources(page, selectedCategory);
      if (request !== resourceRequest.current) return;
      setTotal(response.total);
      setPageSize(response.pageSize);
      setResources(response.resources);
      setResourcesError("");
    } catch {
      if (request !== resourceRequest.current) return;
      setResourcesError("获取资源列表失败，请检查网络后重试。");
      setResources([]);
    } finally {
      if (request === resourceRequest.current) setLoading(false);
    }
  };

  const fetchCategories = async () => {
    try {
      const response = await resourcesApi.getCategories();
      setCategories(response);
    } catch {
      setCategories([]);
    }
  };

  const fetchRedeemedResources = async () => {
    setRedeemedLoading(true);
    try {
      const response = await cdksApi.getUserRedeemedResources();
      setRedeemedResources(response.resources);
      setRedeemedCount(response.resources.length);
      setRedeemedError("");
    } catch {
      setRedeemedError("获取已兑换资源失败，请稍后重试。");
      setRedeemedResources([]);
      setRedeemedCount(0);
    } finally {
      setRedeemedLoading(false);
    }
  };

  const fetchRedeemedResourcesCount = async () => {
    try {
      const response = await cdksApi.getUserRedeemedResources();
      setRedeemedCount(response.resources.length);
    } catch {
      setRedeemedCount(0);
    }
  };

  useEffect(() => {
    fetchCategories();
    fetchRedeemedResourcesCount();
  }, []);

  useEffect(() => {
    fetchResources();
    return () => { ++resourceRequest.current; };
  }, [selectedCategory, page]);

  useEffect(() => {
    if (activeTab === "owned") {
      fetchRedeemedResources();
    }
  }, [activeTab]);

  const handleRedeemCDK = async (forceRedeem = false) => {
    if (submittingRef.current) return;
    const codeToRedeem = forceRedeem ? pendingCDKCode : cdkCode;

    if (!codeToRedeem.trim()) {
      setError("请输入 CDK 兑换码");
      return;
    }

    if (!isAdmin && captchaStatus.required && !captcha?.token) {
      setError("请先完成人机验证");
      return;
    }

    setCdkLoading(true);
    submittingRef.current = true;
    setError("");
    setSuccess("");

    try {
      const generateSecureId = () => {
        const array = new Uint32Array(2);
        crypto.getRandomValues(array);
        return array[0].toString(36) + array[1].toString(36);
      };
      const generateSecureNumber = () => {
        const array = new Uint32Array(1);
        crypto.getRandomValues(array);
        return array[0] % 10000;
      };

      const requestParams: any = {
        code: codeToRedeem,
        userId: `user_${Date.now()}_${generateSecureId()}`,
        username: `用户${generateSecureNumber()}`,
        forceRedeem,
      };

      if (user?.role) {
        requestParams.userRole = user.role;
      }
      if (!isAdmin && captcha?.token) {
        // cfToken 为历史字段名；captchaProvider 告诉后端这次是哪个供应商签发的。
        requestParams.cfToken = captcha.token;
        requestParams.captchaToken = captcha.token;
        requestParams.captchaProvider = captcha.provider;
      }
      const result = await cdksApi.redeemCDK(requestParams);
      setSuccess(`兑换成功：${result.resource.title}`);
      setCdkCode("");
      setPendingCDKCode("");
      setShowDuplicateDialog(false);
      fetchRedeemedResourcesCount();
      if (activeTab === "owned") {
        fetchRedeemedResources();
      }
      if (result.resource.downloadUrl) {
        window.setTimeout(() => {
          window.open(result.resource.downloadUrl, "_blank");
        }, 800);
      }
    } catch (err: any) {
      if (
        err.response?.status === 409 &&
        err.response?.data?.message === "DUPLICATE_RESOURCE"
      ) {
        setDuplicateResourceInfo({
          title: err.response.data.resourceTitle,
          id: err.response.data.resourceId,
        });
        setPendingCDKCode(codeToRedeem);
        setShowDuplicateDialog(true);
      } else {
        setError("兑换失败，CDK 无效或已经使用");
      }
    } finally {
      if (!isAdmin && captcha?.token) captchaRef.current?.reset(captcha.token);
      submittingRef.current = false;
      setCdkLoading(false);
    }
  };

  const handleRefresh = () => {
    setRefreshing(true);
    fetchResources().finally(() => setRefreshing(false));
    fetchRedeemedResourcesCount();
  };

  const duplicateCancelRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!showDuplicateDialog) return undefined;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const timer = window.setTimeout(() => duplicateCancelRef.current?.focus(), 0);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setShowDuplicateDialog(false);
        setPendingCDKCode("");
        setDuplicateResourceInfo(null);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("keydown", handleKeyDown);
      previouslyFocused?.focus?.();
    };
  }, [showDuplicateDialog]);

  const handleDuplicateDialogKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;
    const focusables = event.currentTarget.querySelectorAll<HTMLElement>(
      'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
    );
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const statusCards = [
    {
      label: "可兑换",
      rawLabel: "Catalog",
      value: `${total} 个在架资源`,
      tone: "sky" as const,
    },
    {
      label: "已拥有",
      rawLabel: "Owned",
      value: `${redeemedCount} 个已解锁`,
      tone: "emerald" as const,
    },
    {
      label: "验证状态",
      rawLabel: "Security",
      value: isAdmin
        ? "管理员免验证"
        : !captchaStatus.required
          ? "未启用验证"
          : captcha?.token
            ? `${providerLabel} 已通过`
            : `等待 ${providerLabel}`,
      tone: "violet" as const,
    },
  ];

  const renderStoreCard = (resource: Resource, index: number) => (
    <motion.article
      key={resource.id}
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.04 }}
      className="overflow-hidden rounded-2xl border border-slate-200 bg-white/90 shadow-sm transition hover:-translate-y-1 hover:shadow-sm"
    >
      <div className="relative h-36 overflow-hidden bg-slate-100 sm:h-48">
        <img
          src={resource.imageUrl || "/placeholder.jpg"}
          alt={resource.title}
          className="h-full w-full object-cover"
        />
        <span className="absolute left-3 top-3 rounded-full bg-white/90 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-700">
          {resource.category}
        </span>
      </div>
      <div className="space-y-4 p-4 sm:p-5">
        <div>
          <h3 className="line-clamp-1 text-lg font-semibold text-slate-900">
            {resource.title}
          </h3>
          <p className="mt-2 line-clamp-2 text-sm leading-7 text-slate-500">
            {resource.description}
          </p>
        </div>
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-[10px] uppercase tracking-[0.24em] text-slate-400" title="Price">
              价格
            </div>
            <div className="mt-1 text-xl font-semibold text-slate-900">
              ￥{resource.price}
            </div>
          </div>
          <Link
            to={`/store/resources/${resource.id}`}
            className={cn(
              studioPrimaryButtonClassName,
              "px-4 py-2 text-xs sm:text-xs",
            )}
          >
            查看详情
          </Link>
        </div>
      </div>
    </motion.article>
  );

  const renderOwnedCard = (resource: RedeemedResource, index: number) => (
    <motion.article
      key={`owned-${resource.id}`}
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.04 }}
      className="overflow-hidden rounded-2xl border border-slate-200 bg-white/90 shadow-sm transition hover:-translate-y-1 hover:shadow-sm"
    >
      <div className="relative h-36 overflow-hidden bg-slate-100 sm:h-48">
        <img
          src={resource.imageUrl || "/placeholder.jpg"}
          alt={resource.title}
          className="h-full w-full object-cover"
        />
        <span className="absolute left-3 top-3 rounded-full bg-white/90 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-700">
          {resource.category}
        </span>
        <span className="absolute right-3 top-3 inline-flex items-center gap-1 rounded-full bg-emerald-500 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-white" title="Owned">
          <FaCheckCircle />
          已拥有
        </span>
      </div>
      <div className="space-y-4 p-4 sm:p-5">
        <div>
          <h3 className="line-clamp-1 text-lg font-semibold text-slate-900">
            {resource.title}
          </h3>
          <p className="mt-2 line-clamp-2 text-sm leading-7 text-slate-500">
            {resource.description}
          </p>
        </div>
        <div className="grid gap-2 rounded-2xl border border-slate-100 bg-slate-50 px-4 py-4 text-sm text-slate-600">
          <div className="flex items-center justify-between gap-3">
            <span className="inline-flex items-center gap-2">
              <FaCalendarAlt />
              兑换日期
            </span>
            <span>{formatRedeemedDate(resource.redeemedAt)}</span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="inline-flex items-center gap-2">
              <FaHistory />
              兑换时间
            </span>
            <span>{formatRedeemedTime(resource.redeemedAt)}</span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="inline-flex items-center gap-2">
              <FaUser />
              持有时长
            </span>
            <span>{formatRelativeAge(resource.redeemedAt)}</span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="inline-flex items-center gap-2">
              <FaKey />
              CDK
            </span>
            <span className="rounded-full bg-white px-3 py-1 font-mono text-xs text-slate-700">
              {resource.cdkCode}
            </span>
          </div>
        </div>
        <a
          href={resource.downloadUrl}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(
            studioPrimaryButtonClassName,
            "w-full px-4 py-2 text-xs sm:text-xs",
          )}
        >
          <FaDownload />
          下载资源
        </a>
      </div>
    </motion.article>
  );

  if (loading) {
    return (
      <div
        className={studioPageClassName}
        style={{ fontFamily: studioPageFont }}
      >
        <div className="flex min-h-[70vh] items-center justify-center">
          <UnifiedLoadingSpinner size="lg" text="加载资源商店..." />
        </div>
      </div>
    );
  }

  return (
    <div className={studioPageClassName} style={{ fontFamily: studioPageFont }}>
      <div className="mx-auto max-w-7xl min-w-0">
        <motion.div
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45 }}
          className={cn("mb-5 sm:mb-8", studioHeroCardClassName)}
        >
          <div
            className={cn(studioAccentBlobBlueClassName, "-right-12 top-0")}
            aria-hidden
          />
          <div
            className={cn(studioAccentBlobSkyClassName, "-left-10 bottom-0")}
            aria-hidden
          />
          <div className="relative flex min-w-0 flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl min-w-0">
              <div className={cn("mb-3", studioEyebrowPillClassName)}>
                <FaStore />
                Resource Store Studio
              </div>
              <h1
                className="text-[2rem] font-semibold leading-[1.05] text-slate-900 sm:text-5xl sm:leading-tight"
                style={{ fontFamily: studioDisplayFont }}
              >
                资源商店
              </h1>
            </div>
            <div className="w-full lg:w-auto">
              <div className="grid gap-2 sm:grid-cols-3 sm:gap-3">
                {statusCards.map((item) => (
                  <div
                    key={item.label}
                    title={item.rawLabel}
                    className={cn(
                      "min-w-0 rounded-2xl border px-3 py-2.5 sm:rounded-2xl sm:px-4 sm:py-3",
                      studioMetricToneClassName(item.tone),
                    )}
                  >
                    <div className="text-[10px] uppercase tracking-[0.24em] text-slate-400">
                      {item.label}
                    </div>
                    <div className="mt-2 break-words text-sm font-semibold text-slate-800">
                      {item.value}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </motion.div>

        <div className="grid gap-4 sm:gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,400px)] xl:grid-cols-[minmax(0,1fr)_minmax(0,400px)]">
          <motion.div
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.05 }}
            className={studioMainSurfaceClassName}
          >
            <div className="rounded-2xl border border-slate-200 bg-white/80 p-3 sm:p-5">
              <div className="mb-4 flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => setActiveTab("store")}
                    className={studioPillClassName(
                      activeTab === "store",
                      "blue",
                    )}
                  >
                    商店资源
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab("owned")}
                    className={studioPillClassName(
                      activeTab === "owned",
                      "green",
                    )}
                  >
                    我的资源 {redeemedCount > 0 ? `(${redeemedCount})` : ""}
                  </button>
                </div>
                <button
                  type="button"
                  onClick={handleRefresh}
                  disabled={refreshing}
                  className={studioGhostButtonClassName}
                >
                  <FaSync className={refreshing ? "animate-spin" : undefined} />
                  刷新内容
                </button>
              </div>

              {activeTab === "store" ? (
                <>
                  <div className="mb-5 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => { setPage(1); setSelectedCategory(""); }}
                      className={studioPillClassName(
                        selectedCategory === "",
                        "dark",
                      )}
                    >
                      全部分类
                    </button>
                    {categories.map((category) => (
                      <button
                        key={category}
                        type="button"
                        onClick={() => { setPage(1); setSelectedCategory(category); }}
                        className={studioPillClassName(
                          selectedCategory === category,
                          "blue",
                        )}
                      >
                        {category}
                      </button>
                    ))}
                  </div>
                  {resourcesError ? (
                    <div
                      role="alert"
                      className="flex flex-col items-center gap-3 rounded-2xl border border-rose-200 bg-rose-50 px-6 py-10 text-center text-sm text-rose-700"
                    >
                      <span className="flex items-center gap-2">
                        <FaExclamationTriangle className="shrink-0" />
                        {resourcesError}
                      </span>
                      <button
                        type="button"
                        onClick={() => void fetchResources()}
                        className={studioGhostButtonClassName}
                      >
                        <FaSync />
                        重试
                      </button>
                    </div>
                  ) : resources.length > 0 ? (
                    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                      {resources.map(renderStoreCard)}
                    </div>
                  ) : (
                    <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50/80 px-6 py-14 text-center text-slate-400">
                      {selectedCategory
                        ? `当前分类 ${selectedCategory} 暂无资源。`
                        : "当前没有可展示的资源。"}
                    </div>
                  )}
                  {!resourcesError && total > pageSize && <nav aria-label="资源分页" className="mt-4 flex items-center justify-center gap-4">
                    <button type="button" disabled={loading || page <= 1} onClick={() => setPage((p) => p - 1)} className={studioGhostButtonClassName}>上一页</button>
                    <span>第 {page} / {Math.max(1, Math.ceil(total / pageSize))} 页 · 共 {total} 项</span>
                    <button type="button" disabled={loading || page * pageSize >= total} onClick={() => setPage((p) => p + 1)} className={studioGhostButtonClassName}>下一页</button>
                  </nav>}
                </>
              ) : redeemedLoading ? (
                <div className="flex min-h-[380px] items-center justify-center">
                  <UnifiedLoadingSpinner size="lg" text="加载我的资源..." />
                </div>
              ) : redeemedError ? (
                <div
                  role="alert"
                  className="flex flex-col items-center gap-3 rounded-2xl border border-rose-200 bg-rose-50 px-6 py-10 text-center text-sm text-rose-700"
                >
                  <span className="flex items-center gap-2">
                    <FaExclamationTriangle className="shrink-0" />
                    {redeemedError}
                  </span>
                  <button
                    type="button"
                    onClick={() => void fetchRedeemedResources()}
                    className={studioGhostButtonClassName}
                  >
                    <FaSync />
                    重试
                  </button>
                </div>
              ) : redeemedResources.length > 0 ? (
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                  {redeemedResources.map(renderOwnedCard)}
                </div>
              ) : (
                <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50/80 px-6 py-14 text-center text-slate-400">
                  还没有已兑换资源，先在右侧输入 CDK 试试看。
                </div>
              )}
            </div>
          </motion.div>

          <div className="min-w-0 space-y-4 sm:space-y-6">
            <motion.section
              initial={{ opacity: 0, y: 24 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.12 }}
              className={studioPanelClassName}
            >
              <div className="mb-4 flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-slate-900 text-white">
                  <FaGift />
                </div>
                <div>
                  <div className="text-lg font-semibold text-slate-900">
                    CDK 兑换
                  </div>
                  <div className="text-sm text-slate-500">
                    右侧保留快速输入与验证状态
                  </div>
                </div>
              </div>
              <div className="space-y-3">
                <label htmlFor="cdk-redeem-input" className="sr-only">
                  CDK 兑换码
                </label>
                <input
                  id="cdk-redeem-input"
                  type="text"
                  value={cdkCode}
                  onChange={(event) => setCdkCode(event.target.value)}
                  placeholder="输入 CDK 兑换码"
                  className={cn(studioFieldClassName, "sm:rounded-2xl")}
                />
                <button
                  type="button"
                  onClick={() => handleRedeemCDK()}
                  disabled={cdkLoading || (!isAdmin && captchaStatus.required && !captcha?.token)}
                  className={cn(studioPrimaryButtonClassName, "w-full")}
                >
                  {cdkLoading ? <FaSync className="animate-spin" /> : <FaKey />}
                  {cdkLoading ? "正在兑换..." : "立即兑换"}
                </button>
              </div>

              {!isAdmin ? (
                <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <ManagedCaptcha
                    ref={captchaRef}
                    scenario="default"
                    onSolved={handleCaptchaSolved}
                    onCleared={handleCaptchaCleared}
                    onStatusChange={handleCaptchaStatus}
                  />
                </div>
              ) : null}

              <AnimatePresence>
                {error ? (
                  <motion.div
                    initial={{ opacity: 0, y: -8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -8 }}
                    role="alert"
                    className="mt-4 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700"
                  >
                    {error}
                  </motion.div>
                ) : null}
              </AnimatePresence>
              <AnimatePresence>
                {success ? (
                  <motion.div
                    initial={{ opacity: 0, y: -8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -8 }}
                    role="status"
                    aria-live="polite"
                    className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700"
                  >
                    {success}
                  </motion.div>
                ) : null}
              </AnimatePresence>
            </motion.section>

            <motion.section
              initial={{ opacity: 0, y: 24 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.18 }}
              className={studioPanelClassName}
            >
              <div className="mb-4 flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-slate-900 text-white">
                  <FaInfoCircle />
                </div>
                <div>
                  <div className="text-lg font-semibold text-slate-900">
                    当前摘要
                  </div>
                  <div className="text-sm text-slate-500">
                    快速确认本页上下文
                  </div>
                </div>
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between rounded-2xl border border-slate-100 px-3 py-3 text-sm">
                  <span className="text-slate-500">当前视图</span>
                  <span className="font-semibold text-slate-900">
                    {activeTab === "store" ? "商店资源" : "我的资源"}
                  </span>
                </div>
                <div className="flex items-center justify-between rounded-2xl border border-slate-100 px-3 py-3 text-sm">
                  <span className="text-slate-500">选中分类</span>
                  <span className="font-semibold text-slate-900">
                    {selectedCategory || "全部"}
                  </span>
                </div>
                <div className="flex items-center justify-between rounded-2xl border border-slate-100 px-3 py-3 text-sm">
                  <span className="text-slate-500">分类数量</span>
                  <span className="font-semibold text-slate-900">
                    {categories.length}
                  </span>
                </div>
                <div className="flex items-center justify-between rounded-2xl border border-slate-100 px-3 py-3 text-sm">
                  <span className="text-slate-500">验证策略</span>
                  <span
                    className="font-semibold text-slate-900"
                    title={
                      isAdmin
                        ? "Admin bypass"
                        : !captchaStatus.required
                          ? "Disabled"
                          : `${providerLabel} enabled`
                    }
                  >
                    {isAdmin
                      ? "管理员豁免"
                      : !captchaStatus.required
                        ? "未启用"
                        : `${providerLabel} 已启用`}
                  </span>
                </div>
              </div>
            </motion.section>
          </div>
        </div>
      </div>

      <AnimatePresence>
        {showDuplicateDialog && duplicateResourceInfo ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className={studioModalOverlayClassName}
            onClick={() => {
              setShowDuplicateDialog(false);
              setPendingCDKCode("");
              setDuplicateResourceInfo(null);
            }}
          >
            <motion.div
              role="dialog"
              aria-modal="true"
              aria-labelledby="duplicate-resource-dialog-title"
              onKeyDown={handleDuplicateDialogKeyDown}
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className={cn(studioModalCardClassName, "max-w-md max-h-[90vh] overflow-y-auto overscroll-contain")}
              onClick={(event) => event.stopPropagation()}
            >
              <div className="flex items-start gap-3">
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-amber-100 text-amber-600">
                  <FaExclamationTriangle />
                </div>
                <div>
                  <h3 id="duplicate-resource-dialog-title" className="text-xl font-semibold text-slate-900">
                    重复资源提醒
                  </h3>
                  <p className="mt-2 text-sm leading-7 text-slate-500">
                    你已经拥有资源“{duplicateResourceInfo.title}
                    ”。继续兑换会消耗一个 CDK，但不会新增访问权限。
                  </p>
                </div>
              </div>
              <div className="mt-6 flex flex-col gap-2 sm:flex-row">
                <button
                  type="button"
                  ref={duplicateCancelRef}
                  onClick={() => {
                    setShowDuplicateDialog(false);
                    setPendingCDKCode("");
                    setDuplicateResourceInfo(null);
                  }}
                  className={cn(studioGhostButtonClassName, "w-full sm:w-auto")}
                >
                  取消兑换
                </button>
                <button
                  type="button"
                  onClick={() => handleRedeemCDK(true)}
                  className={cn(
                    studioPrimaryButtonClassName,
                    "w-full sm:w-auto bg-amber-500 hover:bg-amber-600 shadow-amber-500/20",
                  )}
                >
                  继续兑换
                </button>
              </div>
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
