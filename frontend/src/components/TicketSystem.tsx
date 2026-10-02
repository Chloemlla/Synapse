import React, { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { useAuth } from "../hooks/useAuth";
import { isAdminRole, isSuperAdmin } from "../utils/rbac";
import { ticketApi, ITicket, ITicketSummary, TicketListMeta, TicketStats } from "../api/ticketApi";
import TicketListItem from "./ticket/TicketListItem";
import TicketFilters, { EMPTY_TICKET_FILTER, type TicketFilterValue } from "./ticket/TicketFilters";
import TicketStatsBar from "./ticket/TicketStatsBar";
import TicketHeroBody, { type TicketPenaltyAppeal } from "./ticket/TicketHero";
import TicketComposer from "./ticket/TicketComposer";
import { OverLengthMailNotice, type OverLengthDraft } from "./ticket/OverLengthMailNotice";
import TicketProcessingToast from "./ticket/TicketProcessingToast";
import {
  MAX_TICKET_DESC_LEN,
  MAX_TICKET_REPLY_LEN,
  MAX_TICKET_TITLE_LEN,
  TICKET_CATEGORY_META,
  TICKET_CATEGORY_ORDER,
  TICKET_PAGE_SIZE,
  TICKET_PRIORITY_META,
  TICKET_STATUS_META,
  TICKET_STATUS_ORDER,
} from "./ticket/ticketConstants";
import { useNotification } from "./Notification";
import { useWebSocket, WsServerMessage } from "../hooks/useWebSocket";
import {
  FiSend, FiPlus, FiMessageSquare, FiClock,
  FiCheckCircle, FiAlertCircle, FiX, FiFilter,
  FiUser, FiChevronRight, FiSearch, FiInfo,
  FiCpu, FiCheck, FiTerminal, FiEdit2, FiTrash2,
  FiRefreshCw, FiMail, FiLink, FiLock, FiCheckSquare, FiLoader,
} from "react-icons/fi";
import MarkdownRenderer, { type MarkdownReaderControls } from './MarkdownRenderer';
import { AiErrorDetailsPanel } from './AiErrorDetailsPanel';
import { SUPPORT_EMAIL } from './PenaltyAppealActions';
import { emitPenaltyAppealRequired, isTicketPermissionBanError } from '../utils/penaltyAppeal';
import { cn } from '../utils/cn';
import {
  studioAccentBlobBlueClassName,
  studioAccentBlobSkyClassName,
  studioBadgeClassName,
  studioDisplayFont,
  studioEyebrowClassName,
  studioFieldClassName,
  studioGhostButtonClassName,
  studioHeroCardClassName,
  studioMainSurfaceClassName,
  studioPageClassName,
  studioPageFont,
  studioPanelClassName,
  studioPrimaryButtonClassName,
  studioStrongBadgeClassName,
  studioTextareaClassName,
} from './studioTheme';

type TicketProcessStep = "audit_start" | "audit_passed" | "ai_start" | "ai_complete" | "saving" | "audit_failed" | "error";
type ApiErrorResponse = {
  status?: number;
  data?: {
    error?: string;
    punishment?: string;
    details?: string;
    code?: string;
  };
};

const ROW_INITIAL = { opacity: 0, x: -16 } as const;
const ROW_ANIMATE = { opacity: 1, x: 0 } as const;
const CHAT_MARKDOWN_CONTROLS: MarkdownReaderControls = {
  showCopy: true,
  showSourceToggle: true,
  showExpandToggle: true,
  defaultExpanded: true,
  collapsedHeight: 420,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}

// G12-21：输入长度上限统一来自 ./ticket/ticketConstants（前端限制，不是安全边界）

function getApiErrorResponse(error: unknown): ApiErrorResponse | null {
  if (!isRecord(error) || !isRecord(error.response)) return null;
  const { response } = error;
  const data = isRecord(response.data) ? response.data : {};
  return {
    status: typeof response.status === 'number' ? response.status : undefined,
    data: {
      error: typeof data.error === 'string' ? data.error : undefined,
      punishment: typeof data.punishment === 'string' ? data.punishment : undefined,
      details: typeof data.details === 'string' ? data.details : undefined,
      code: typeof data.code === 'string' ? data.code : undefined,
    },
  };
}

// 列表按 updatedAt 倒序：WS 到达的最新更新应沉到列表顶部，而不是呆在原位
function compareTicketsByUpdatedDesc<T extends { updatedAt: string }>(a: T, b: T): number {
  return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
}

// 「专注模式」：桌面端收起顶部说明区，把整块纵向空间让给工单列表与会话。
// 存 localStorage 是因为这是纯展示偏好，刷新/切页后应当保持一致；写入失败（隐私模式）只影响本次记忆。
const FOCUS_MODE_STORAGE_KEY = "synapse.ticket.focusMode";

function readFocusModePreference(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(FOCUS_MODE_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeFocusModePreference(value: boolean): void {
  try {
    window.localStorage.setItem(FOCUS_MODE_STORAGE_KEY, value ? "1" : "0");
  } catch {
    // 忽略：偏好写不进去时只影响下次访问的默认展开状态。
  }
}

/**
 * 手机端切换「列表 ↔ 详情」后把外层滚动容器拉回顶部：移动端滚动在文档或
 * #app-main-content 上，不复位会直接停在对话中段。
 */
function scrollTicketPaneToTop(): void {
  if (typeof window === "undefined") return;
  try {
    document.getElementById("app-main-content")?.scrollTo({ top: 0 });
    window.scrollTo({ top: 0 });
  } catch {
    // 滚动失败不影响功能
  }
}


const TicketSystem: React.FC = () => {
  const { user } = useAuth();
  const isAdmin = isAdminRole(user?.role);
  const canWrite = isSuperAdmin(user?.role);
  const { setNotification } = useNotification();
  const [tickets, setTickets] = useState<ITicketSummary[]>([]);
  const [selectedTicket, setSelectedTicket] = useState<ITicket | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [listMeta, setListMeta] = useState<TicketListMeta>({
    total: 0,
    page: 1,
    pageSize: TICKET_PAGE_SIZE,
    hasMore: false,
  });
  const [stats, setStats] = useState<TicketStats | null>(null);
  const [unreadCount, setUnreadCount] = useState(0);
  const [bulkMode, setBulkMode] = useState(false);
  const [checkedIds, setCheckedIds] = useState<string[]>([]);
  const [overLengthDraft, setOverLengthDraft] = useState<OverLengthDraft>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [newTicket, setNewTicket] = useState({ title: "", description: "", priority: "medium", category: "other" });
  const [adminFilter, setAdminFilter] = useState<TicketFilterValue>({ ...EMPTY_TICKET_FILTER });
  // 输入即改 adminFilter.q，但只有停止输入 350ms 后才拿去请求，避免每敲一个字打一次接口。
  const [queryFilter, setQueryFilter] = useState<TicketFilterValue>({ ...EMPTY_TICKET_FILTER });
  const [isMobile, setIsMobile] = useState(false);
  const [showDetailOnMobile, setShowDetailOnMobile] = useState(false);
  // 桌面端顶部说明区是否收起（详见 readFocusModePreference）。
  const [focusMode, setFocusMode] = useState<boolean>(() => readFocusModePreference());
  const toggleFocusMode = useCallback(() => {
    setFocusMode((current) => {
      const next = !current;
      writeFocusModePreference(next);
      return next;
    });
  }, []);

  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editValue, setEditValue] = useState("");
  const [isUpdating, setIsUpdating] = useState(false);

  const [processingStep, setProcessingStep] = useState<TicketProcessStep | null>(null);

  const [streamingAiResponse, setStreamingAiResponse] = useState<{ ticketId: string, content: string } | null>(null);
  const [penaltyAppeal, setPenaltyAppeal] = useState<TicketPenaltyAppeal | null>(null);

  // G12-21：提交/回复 in-flight 防护，双击只触发一次
  const [isSubmitting, setIsSubmitting] = useState(false);
  // G12-22：AI 流式内容累计（ref 版本，供 isFinished 收尾用，避免闭包读到过期 state）
  const streamingAiRef = useRef<{ ticketId: string; content: string } | null>(null);
  // G12-22：等待 ticket:update 的超时兜底
  const aiReplyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectedTicketRef = useRef<ITicket | null>(null);
  useEffect(() => {
    selectedTicketRef.current = selectedTicket;
  }, [selectedTicket]);

  // 切换工单时丢弃上一个回复残留的超长引导，避免错位
  useEffect(() => {
    setOverLengthDraft(null);
  }, [selectedTicket?._id]);

  const adminFilterRef = useRef(adminFilter);
  useEffect(() => {
    adminFilterRef.current = adminFilter;
  }, [adminFilter]);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const prefersReducedMotion = useReducedMotion();
  const notifyMarkdownCopy = useCallback((success: boolean, wholeMessage = false) => {
    setNotification({
      type: success ? 'success' : 'error',
      message: success ? (wholeMessage ? 'Markdown内容已复制到剪贴板' : '代码已复制') : '复制失败',
    });
  }, [setNotification]);

  useEffect(() => {
    let timer: NodeJS.Timeout;
    if (processingStep) {
      const isEnding = ["ai_complete", "audit_failed", "error"].includes(processingStep);
      timer = setTimeout(() => {
        setProcessingStep(null);
      }, isEnding ? 3000 : 20000);
    }
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [processingStep]);

  const toSummary = useCallback((ticket: ITicket): ITicketSummary => {
    const messages = ticket.messages || [];
    const visible = messages.filter((m) => (m as { visibility?: string }).visibility !== 'internal');
    const last = visible[visible.length - 1];
    const lastSenderRole = last?.senderRole;
    const fromOtherSide = isAdmin
      ? lastSenderRole === 'user'
      : lastSenderRole === 'admin' || lastSenderRole === 'ai';
    const isOpenHere = selectedTicketRef.current?._id === ticket._id;
    return {
      _id: ticket._id,
      userId: ticket.userId,
      username: ticket.username,
      title: ticket.title,
      description: ticket.description,
      status: ticket.status,
      priority: ticket.priority,
      category: (ticket.category || 'other') as ITicketSummary['category'],
      assigneeId: ticket.assigneeId ?? null,
      assigneeName: ticket.assigneeName ?? null,
      createdAt: ticket.createdAt,
      updatedAt: ticket.updatedAt,
      messageCount: visible.length,
      internalNoteCount: messages.length - visible.length,
      lastMessagePreview: (last?.content || '').replace(/\s+/g, ' ').trim().slice(0, 140),
      lastSenderRole,
      lastMessageAt: last?.createdAt ?? null,
      hasUnread: !isOpenHere && fromOtherSide,
      awaitingReply: lastSenderRole === 'user',
      ageHours: 0,
    };
  }, [isAdmin]);

  const applyTicketUpdate = useCallback((updatedTicket: ITicket) => {
    const summary = toSummary(updatedTicket);
    setTickets(prev => {
      // 落库版本到达后先剔除旧条目再按最新位置插入，并让列表始终按 updatedAt 倒序，
      // 避免「已解决/已关闭」等更新后仍停留在原位、与筛选结果不一致。
      const { status: statusFilter, priority: priorityFilter } = adminFilterRef.current;
      const passesFilter = (!statusFilter || updatedTicket.status === statusFilter)
        && (!priorityFilter || updatedTicket.priority === priorityFilter);
      const next = prev.filter(ticket => ticket._id !== updatedTicket._id);
      if (!passesFilter) {
        return next.sort(compareTicketsByUpdatedDesc);
      }
      return [summary, ...next].sort(compareTicketsByUpdatedDesc);
    });

    setSelectedTicket(prev => prev?._id === updatedTicket._id ? updatedTicket : prev);
  }, [toSummary]);

  // G12-22：isFinished 时把累计内容乐观追加为一条 AI 消息，等待 ticket:update 用服务端版本替换
  const appendOptimisticAiMessage = useCallback((ticketId: string, content: string) => {
    setSelectedTicket(prev => {
      if (!prev || prev._id !== ticketId) return prev;
      const alreadyExists = prev.messages.some(m => m.senderRole === 'ai' && m.content === content);
      if (alreadyExists) return prev;
      return {
        ...prev,
        messages: [...prev.messages, {
          senderId: 'ai',
          senderRole: 'ai' as const,
          content,
          isAi: true,
          createdAt: new Date().toISOString(),
        }],
      };
    });
  }, []);

  // G12-22：ticket:update 迟迟未到时主动拉取一次，避免流式回复凭空消失
  const scheduleAiReplyRefresh = useCallback((ticketId: string) => {
    if (aiReplyTimeoutRef.current) clearTimeout(aiReplyTimeoutRef.current);
    aiReplyTimeoutRef.current = setTimeout(() => {
      aiReplyTimeoutRef.current = null;
      if (selectedTicketRef.current?._id === ticketId) {
        void ticketApi.getTicket(ticketId)
          .then(applyTicketUpdate)
          .catch(() => {});
      }
    }, 5000);
  }, [applyTicketUpdate]);

  const onMessage = useCallback((msg: WsServerMessage) => {
    if (msg.type === "ticket:ai_response") {
      const { ticketId, content, isFinished } = msg.data;
      if (ticketId === selectedTicketRef.current?._id || (!selectedTicketRef.current && ticketId === "new")) {
        if (isFinished) {
          // G12-22：不要直接清空——把累计内容作为乐观消息写入消息流，避免整段回复凭空消失
          const finalContent = streamingAiRef.current?.content || "";
          if (finalContent.trim() && ticketId !== "new") {
            appendOptimisticAiMessage(ticketId, finalContent);
            scheduleAiReplyRefresh(ticketId);
          }
          streamingAiRef.current = null;
          setStreamingAiResponse(null);
        } else {
          streamingAiRef.current = {
            ticketId,
            content: (streamingAiRef.current && streamingAiRef.current.ticketId === ticketId ? streamingAiRef.current.content : "") + content
          };
          setStreamingAiResponse({ ...streamingAiRef.current });
        }
      }
    }

    if (msg.type === "ticket:update") {
      if (!isRecord(msg.data) || typeof msg.data._id !== "string") return;
      // G12-22：服务端版本到达，取消超时兜底
      if (aiReplyTimeoutRef.current) {
        clearTimeout(aiReplyTimeoutRef.current);
        aiReplyTimeoutRef.current = null;
      }
      const updatedTicket = msg.data as unknown as ITicket;
      // 服务端已把 AI 回复落库并广播：若本地仍挂着同内容的流式气泡（例如 isFinished 事件丢失），
      // 借此机会一并清掉，避免留下永不消失的「正在输入...」
      if (streamingAiRef.current) {
        const aiTailPersisted = (updatedTicket.messages || []).some(
          (m) => m.senderRole === 'ai' && m.content === streamingAiRef.current?.content,
        );
        if (aiTailPersisted) {
          streamingAiRef.current = null;
          setStreamingAiResponse(null);
        }
      }
      if (isAdmin) {
        void ticketApi.getTicket(updatedTicket._id)
          .then(applyTicketUpdate)
          .catch(() => applyTicketUpdate(updatedTicket));
      } else {
        applyTicketUpdate(updatedTicket);
      }

      setProcessingStep(null);
    }

    if (msg.type === "ticket:process") {
      const { ticketId, step } = msg.data;
      if (ticketId === "new" || ticketId === selectedTicketRef.current?._id) {
        setProcessingStep(step);
      }
    }
  }, [applyTicketUpdate, isAdmin, appendOptimisticAiMessage, scheduleAiReplyRefresh]);

  useWebSocket({ onMessage });

  const handleAdminEdit = async (ticketId: string, idx: number) => {
    if (!canWrite) return;
    if (!editValue.trim()) return;
    setIsUpdating(true);
    try {
      const updated = await ticketApi.adminEditMessage(ticketId, idx, editValue);
      setSelectedTicket(updated);
      applyTicketUpdate(updated);
      setEditingIdx(null);
      setNotification({ type: 'success', message: "消息已修改" });
    } catch (error) {
      setNotification({ type: 'error', message: "修改失败" });
    } finally {
      setIsUpdating(false);
    }
  };

  const handleAdminDelete = async (ticketId: string, idx: number) => {
    if (!canWrite) return;
    if (!window.confirm("确定要删除这条消息吗？此操作不可撤销。")) return;
    try {
      const updated = await ticketApi.adminDeleteMessage(ticketId, idx);
      setSelectedTicket(updated);
      applyTicketUpdate(updated);
      setNotification({ type: 'success', message: "消息已删除" });
    } catch (error) {
      setNotification({ type: 'error', message: "删除失败" });
    }
  };

  useEffect(() => {
    const checkMobile = () => {
      // Align with app shell breakpoint (md: 768px), not lg:1024.
      setIsMobile(window.innerWidth < 768);
    };
    checkMobile();
    window.addEventListener("resize", checkMobile);
    return () => window.removeEventListener("resize", checkMobile);
  }, []);

  // 手机端在「列表 / 详情 / 新建」切换后回到顶部（见 scrollTicketPaneToTop）。
  useEffect(() => {
    if (!isMobile) return;
    scrollTicketPaneToTop();
  }, [isMobile, showDetailOnMobile, isCreating]);

  const hoverScale = useCallback((scale: number, enabled: boolean = true) => (
    enabled && !prefersReducedMotion ? { scale } : undefined
  ), [prefersReducedMotion]);

  const tapScale = useCallback((scale: number, enabled: boolean = true) => (
    enabled && !prefersReducedMotion ? { scale } : undefined
  ), [prefersReducedMotion]);

  // 打开工单：列表只有摘要，正文在选中时才拉（列表响应因此与对话长度解耦）。
  // 详情接口同时会在服务端标记本侧已读。
  const openTicket = useCallback(async (summary: ITicketSummary) => {
    setIsCreating(false);
    setShowDetailOnMobile(true);
    setDetailLoading(true);
    setSelectedTicket(prev => (prev?._id === summary._id ? prev : null));
    try {
      const full = await ticketApi.getTicket(summary._id);
      setSelectedTicket(full);
      setTickets(prev => prev.map(t => (t._id === full._id ? { ...t, hasUnread: false } : t)));
      if (summary.hasUnread) setUnreadCount(prev => Math.max(0, prev - 1));
      if (typeof window !== 'undefined') {
        const url = new URL(window.location.href);
        url.searchParams.set('ticket', full._id);
        window.history.replaceState({}, '', `${url.pathname}?${url.searchParams.toString()}`);
      }
    } catch {
      setNotification({ type: 'error', message: '打开工单失败，请重试' });
    } finally {
      setDetailLoading(false);
    }
  }, [setNotification]);

  const refreshAdminStats = useCallback(() => {
    if (!isAdmin) return;
    void ticketApi.getStats().then(setStats).catch(() => undefined);
  }, [isAdmin]);

  const fetchTickets = useCallback(async (options: { page?: number; append?: boolean } = {}) => {
    const page = options.page ?? 1;
    const append = options.append === true;
    try {
      if (!append) setLoading(true);
      setListError(null);
      const result = isAdmin
        ? await ticketApi.getAllTickets({
          status: queryFilter.status || undefined,
          priority: queryFilter.priority || undefined,
          category: queryFilter.category || undefined,
          assignee: queryFilter.assignee || undefined,
          awaitingReply: queryFilter.awaitingReply || undefined,
          unread: queryFilter.unread || undefined,
          sort: queryFilter.sort || undefined,
          q: queryFilter.q || undefined,
          page,
          limit: TICKET_PAGE_SIZE,
        })
        : await ticketApi.getMyTickets({ page, limit: TICKET_PAGE_SIZE });
      setListMeta(result.meta);
      setTickets(prev => {
        if (!append) return result.tickets;
        const seen = new Set(prev.map(t => t._id));
        return [...prev, ...result.tickets.filter(t => !seen.has(t._id))];
      });
      if (!append && result.tickets.length > 0 && !selectedTicketRef.current && !isCreating && !isMobile) {
        void openTicket(result.tickets[0]);
      }
    } catch (error) {
      const apiError = getApiErrorResponse(error);
      setListError(apiError?.data?.error || '加载工单失败');
    } finally {
      setLoading(false);
    }
  }, [isAdmin, isCreating, isMobile, openTicket, queryFilter]);

  // 关键词防抖：输入改 adminFilter，停顿 350ms 后才进 queryFilter 触发请求。
  useEffect(() => {
    const timer = window.setTimeout(() => setQueryFilter(adminFilter), 350);
    return () => window.clearTimeout(timer);
  }, [adminFilter]);

  useEffect(() => {
    void fetchTickets({ page: 1 });
    // fetchTickets 会随 isCreating/isMobile 变化重建，但这两者不应触发重新拉列表。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin, queryFilter, user?.id]);

  // 导航角标用：未读数单独取，不依赖列表已加载。
  useEffect(() => {
    void ticketApi.getUnreadCount().then(setUnreadCount).catch(() => undefined);
  }, [user?.id, isAdmin, queryFilter]);

  useEffect(() => {
    refreshAdminStats();
  }, [refreshAdminStats]);

  // 深链：支持 ?ticket=<id> 从通知/邮件直达（打开即拉详情）。
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const ticketId = new URLSearchParams(window.location.search).get('ticket');
    if (!ticketId) return;
    void ticketApi.getTicket(ticketId)
      .then(full => {
        setSelectedTicket(full);
        setShowDetailOnMobile(true);
        setIsCreating(false);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [selectedTicket?.messages]);

  // 统一的失败处理：403（审查违规 / 工单权限封禁）进入申诉引导，其它错误直接透出服务端文案。
  // 创建与回复共用，避免两处 heuristic 判定与通道文案漂移（封禁时不应再引导走工单通道）。
  const showTicketSubmitError = useCallback((apiError: ApiErrorResponse | null, fallbackMessage: string) => {
    if (apiError?.status === 403 && apiError.data) {
      const data = apiError.data as Record<string, unknown>;
      const error = typeof data.error === 'string' ? data.error : '';
      const punishment = typeof data.punishment === 'string' ? data.punishment : '';
      const details = typeof data.details === 'string' ? data.details : '';
      const isPermissionBan = isTicketPermissionBanError(data, error);
      const title = error || fallbackMessage;
      const reason = punishment || (isPermissionBan ? '工单权限当前不可用' : '内容未能通过 AI 审核');
      setPenaltyAppeal({
        kind: isPermissionBan ? 'ticket_permission_ban' : 'ticket_moderation',
        title,
        reason,
        details: details || undefined,
      });
      emitPenaltyAppealRequired({
        kind: isPermissionBan ? 'ticket_permission_ban' : 'ticket_moderation',
        title,
        reason,
        details: details || undefined,
        ticketChannelEnabled: !isPermissionBan,
        supportEmail: SUPPORT_EMAIL,
        source: "ticket-system",
      });
      setNotification({
        type: 'error',
        title,
        message: reason,
        details: [
          ...(details ? details.split("\n") : []),
          `申诉邮箱: ${SUPPORT_EMAIL}`,
          isPermissionBan
            ? "工单提交通道已被限制，请通过页面上的申诉卡片或申诉邮箱发起申诉。"
            : "如对判定有异议，可使用页面中的“提交工单申诉”按钮。",
        ],
        duration: 6000,
      });
      return;
    }
    if (apiError?.data?.error) {
      setNotification({ type: 'error', message: apiError.data.error });
      return;
    }
    setNotification({ type: 'error', message: fallbackMessage });
  }, [setPenaltyAppeal, setNotification]);

  const handleCreateTicket = async (e: React.FormEvent) => {
    e.preventDefault();
    // G12-21：in-flight 防双击，避免重复工单 + 重复 AI 审核
    if (isSubmitting) return;
    // 超长描述聊天通道无法承载：本地拦截并引导走邮件，保留原文供用户继续编辑
    if (newTicket.description.trim().length > MAX_TICKET_DESC_LEN) {
      setOverLengthDraft({ kind: "create", title: newTicket.title.trim(), content: newTicket.description });
      return;
    }
    setOverLengthDraft(null);
    setIsSubmitting(true);
    try {
      const created = await ticketApi.createTicket(newTicket);
      setNotification({ type: 'success', message: "工单已提交" });
      setIsCreating(false);
      setShowDetailOnMobile(false);
      setNewTicket({ title: "", description: "", priority: "medium", category: "other" });
      setSelectedTicket(created);
      fetchTickets();
    } catch (error: unknown) {
      const apiError = getApiErrorResponse(error);
      // 后端兜底的超长拦截：仍把输入框里的完整原文交给邮件引导
      if (apiError?.data?.code === "CONTENT_TOO_LONG") {
        setOverLengthDraft({ kind: "create", title: newTicket.title.trim(), content: newTicket.description });
        return;
      }
      showTicketSubmitError(apiError, "提交失败");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleReply = async (content: string, internal: boolean): Promise<boolean> => {
    if (!selectedTicket || !content.trim()) return false;
    // G12-21：in-flight 防双击，同一条回复不能发两次
    if (isSubmitting) return false;
    setIsSubmitting(true);
    try {
      const updated = await ticketApi.replyTicket(selectedTicket._id, content, internal);
      setSelectedTicket(updated);
      applyTicketUpdate(updated);
      setNotification({
        type: 'success',
        message: internal
          ? '内部备注已保存（用户不可见）'
          : isAdmin
            ? '回复已发送，用户会收到邮件通知'
            : '已发送，客服会尽快跟进',
      });
      window.setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 60);
      refreshAdminStats();
      return true;
    } catch (error: unknown) {
      showTicketSubmitError(getApiErrorResponse(error), "发送失败");
      return false;
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleUpdateStatus = async (id: string, status: string) => {
    if (!canWrite) return;
    try {
      const updated = await ticketApi.updateStatus(id, status);
      if (selectedTicket?._id === id) setSelectedTicket(updated);
      applyTicketUpdate(updated);
      setNotification({ type: 'success', message: "工单状态已更新" });
      refreshAdminStats();
    } catch (error) {
      const apiError = getApiErrorResponse(error);
      setNotification({ type: 'error', message: apiError?.data?.error || "更新状态失败" });
    }
  };

  // 管理端综合更新：优先级 / 分类 / 受理人（认领）
  const handleUpdateFields = async (id: string, fields: { priority?: string; category?: string; assignee?: string | null }) => {
    if (!canWrite) return;
    try {
      const updated = await ticketApi.updateFields(id, fields);
      if (selectedTicket?._id === id) setSelectedTicket(updated);
      applyTicketUpdate(updated);
      setNotification({ type: 'success', message: "工单信息已更新" });
      refreshAdminStats();
    } catch (error) {
      const apiError = getApiErrorResponse(error);
      setNotification({ type: 'error', message: apiError?.data?.error || "更新工单失败" });
    }
  };

  // 批量改状态（列表多选），成功后重拉列表以反映筛选结果
  const handleBulkStatus = async (status: string) => {
    if (!canWrite || checkedIds.length === 0) return;
    try {
      const result = await ticketApi.bulkUpdateStatus(checkedIds, status);
      setNotification({ type: 'success', message: `已更新 ${result.updated} 个工单为「${status}」` });
      setCheckedIds([]);
      setBulkMode(false);
      await fetchTickets({ page: 1 });
      refreshAdminStats();
    } catch (error) {
      const apiError = getApiErrorResponse(error);
      setNotification({ type: 'error', message: apiError?.data?.error || "批量更新失败" });
    }
  };

  const toggleChecked = useCallback((id: string) => {
    setCheckedIds(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]));
  }, []);

  // 复制工单直达链接（URL 带 ?ticket=<id>，打开页面会自动定位到该工单）
  const handleCopyLink = useCallback(() => {
    if (!selectedTicket || typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    url.searchParams.set('ticket', selectedTicket._id);
    void navigator.clipboard.writeText(url.toString()).then(
      () => setNotification({ type: 'success', message: '工单链接已复制' }),
      () => setNotification({ type: 'error', message: '复制失败，请手动复制地址栏链接' }),
    );
  }, [selectedTicket, setNotification]);

  // 属主自助关闭工单
  const handleCloseTicket = async () => {
    if (!selectedTicket) return;
    if (!window.confirm('确定关闭这个工单吗？关闭后如需继续咨询请发起新工单。')) return;
    try {
      const updated = await ticketApi.closeTicket(selectedTicket._id);
      setSelectedTicket(updated);
      applyTicketUpdate(updated);
      setNotification({ type: 'success', message: '工单已关闭' });
    } catch (error) {
      const apiError = getApiErrorResponse(error);
      setNotification({ type: 'error', message: apiError?.data?.error || '关闭工单失败' });
    }
  };

  // 导出当前已加载列表为 CSV（管理端对账/汇报用）
  const handleExportCsv = useCallback(() => {
    if (tickets.length === 0) return;
    const header = ['ID', '标题', '用户', '状态', '优先级', '分类', '受理人', '消息数', '未读', '待回复', '创建时间', '更新时间'];
    const rows = tickets.map(t => [
      t._id, t.title, t.username, t.status, t.priority, t.category,
      t.assigneeName || '', String(t.messageCount), t.hasUnread ? '是' : '否',
      t.awaitingReply ? '是' : '否', t.createdAt, t.updatedAt,
    ]);
    const escapeCell = (value: string) => `"${String(value).replace(/"/g, '""')}"`;
    const csv = [header, ...rows].map(row => row.map(escapeCell).join(',')).join('\r\n');
    const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `tickets-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }, [tickets]);

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "open":
        return <span className={studioBadgeClassName('blue')}>待处理</span>;
      case "in-progress":
        return <span className={studioBadgeClassName('yellow')}>处理中</span>;
      case "resolved":
        return <span className={studioBadgeClassName('green')}>已解决</span>;
      case "closed":
        return <span className={studioBadgeClassName('slate')}>已关闭</span>;
      default: return null;
    }
  };

  const getPriorityBadge = (priority: string) => {
    switch (priority) {
      case "high": return <span className={studioBadgeClassName('rose')}>紧急</span>;
      case "medium": return <span className={studioBadgeClassName('yellow')}>一般</span>;
      case "low": return <span className={studioBadgeClassName('green')}>低</span>;
      default: return null;
    }
  };

  return (
    <div
      className={cn(
        studioPageClassName,
        // 桌面端至少占满主窗（100svh - 外壳 header 3.5rem - 主窗 py-6）。用 min-h 而非定高：
        // 定高 + 工作区 22rem 下限会让内容溢出页面盒子、画到页脚上（工单台与 footer 重合）。
        "md:flex md:min-h-[calc(100svh-8rem)] md:flex-col md:py-0",
      )}
      style={{ fontFamily: studioPageFont }}
    >
      <div className="mx-auto flex w-full max-w-7xl min-w-0 flex-1 flex-col gap-4 md:min-h-0 md:gap-5">
        {/* Hero */}
        <AnimatePresence>
          {(!isMobile || !showDetailOnMobile) && (
            <motion.div
              key="ticket-hero"
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.45 }}
              className={cn(
                "relative shrink-0 overflow-hidden transition-[padding] duration-200",
                studioHeroCardClassName,
                // 手机 p-4、平板 p-6（原样式是 p-6 → sm:p-10，平板/小笔记本上白白多出 32px）。
                // 专注模式再收到 p-3 且只留一行标题。
                focusMode ? "p-3" : "p-4 sm:p-6",
              )}
            >
              <div className={cn(studioAccentBlobBlueClassName, "-right-12 top-0")} aria-hidden />
              <div className={cn(studioAccentBlobSkyClassName, "-left-10 bottom-0")} aria-hidden />

              <TicketHeroBody
                isAdmin={isAdmin}
                unreadCount={unreadCount}
                focusMode={focusMode}
                onToggleFocusMode={toggleFocusMode}
                penaltyAppeal={penaltyAppeal}
              />
            </motion.div>
          )}
        </AnimatePresence>

        {/* 手机端打开详情后，概览条也一起收起：它只服务于「挑工单」这一步，
            留着会白占一屏高度。 */}
        {isAdmin && (!isMobile || !showDetailOnMobile) && (
          <div className="shrink-0">
            <TicketStatsBar
              stats={stats}
              loading={loading}
              onQuickFilter={(patch) => setAdminFilter(prev => ({ ...prev, ...patch }))}
            />
          </div>
        )}

        {/*
          手机：面板不定高也不裁切，整页文档滚动（嵌套的 overflow-hidden + 内层滚动区会吃掉手势，
          表现为「滑不动」）。
          桌面（md+）：flex-1 吃满主窗、面板定高 + 内部滚动；md:min-h-[22rem] 是矮窗口的底线，
          此时整页改为滚动，而不是把列表压到几行。
        */}
        <div className="flex min-h-[min(420px,50svh)] flex-col gap-3 md:min-h-[22rem] md:flex-1 md:flex-row md:gap-4 lg:gap-6">
          {/* 左侧列表 */}
          <AnimatePresence mode="wait">
            {(!isMobile || !showDetailOnMobile) && (
              <motion.div
                key="list"
                className={cn(
                  // 列表宽度随视口平滑变化：窄屏保住 17rem 可读下限，宽屏最多 26rem，
                  // 中间按 24vw 过渡，而不是 21/23/25rem 三档跳变（拉窗口时不会突然抽一下）。
                  "w-full flex flex-col md:h-full md:overflow-hidden md:w-[clamp(17rem,24vw,26rem)] md:shrink-0",
                  studioPanelClassName,
                  "p-0 sm:p-0",
                )}
                initial={isMobile ? { opacity: 0, x: -20 } : { opacity: 0 }}
                animate={{ opacity: 1, x: 0 }}
                exit={isMobile ? { opacity: 0, x: -20 } : undefined}
                transition={{ duration: 0.3 }}
              >
                <div className="flex items-center justify-between gap-2 border-b border-slate-200/80 p-3 shrink-0 sm:p-4">
                  <div className="flex items-center gap-2 min-w-0">
                    <div className="flex h-9 w-9 items-center justify-center rounded-2xl bg-slate-900 text-white shrink-0">
                      <FiFilter size={14} />
                    </div>
                    <div className="min-w-0">
                      <div className={studioEyebrowClassName}>
                        {isAdmin ? "Admin" : "History"}
                      </div>
                      <div className="text-sm font-semibold text-slate-900 truncate">
                        {isAdmin ? "工单广场" : "历史工单"}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => fetchTickets()}
                      className={cn(studioGhostButtonClassName, "h-9 w-9 px-0 py-0 sm:h-9 sm:w-9 sm:px-0 sm:py-0", loading && "text-slate-400")}
                      title="刷新列表"
                    >
                      <FiRefreshCw size={14} className={loading ? 'animate-spin' : undefined} />
                    </button>
                    {!isAdmin && (
                      <motion.button
                        onClick={() => {
                          setOverLengthDraft(null);
                          setIsCreating(true);
                          if (isMobile) setShowDetailOnMobile(true);
                        }}
                        className={cn(studioPrimaryButtonClassName, "h-9 w-9 px-0 py-0 sm:h-9 sm:w-9 sm:px-0 sm:py-0")}
                        whileHover={hoverScale(1.04)}
                        whileTap={tapScale(0.96)}
                        title="发起新工单"
                      >
                        <FiPlus size={16} />
                      </motion.button>
                    )}
                  </div>
                </div>

                {isAdmin && (
                  <TicketFilters
                    value={adminFilter}
                    searchInput={adminFilter.q}
                    onSearchChange={(value) => setAdminFilter(prev => ({ ...prev, q: value }))}
                    onChange={(patch) => setAdminFilter(prev => ({ ...prev, ...patch }))}
                    onReset={() => setAdminFilter({ ...EMPTY_TICKET_FILTER })}
                    onRefresh={() => void fetchTickets({ page: 1 })}
                    onExport={handleExportCsv}
                    loading={loading}
                    total={listMeta.total}
                    shown={tickets.length}
                  />
                )}

                {isAdmin && (
                  <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-slate-200/80 bg-white px-3 py-2">
                    <button
                      type="button"
                      onClick={() => {
                        setBulkMode(current => !current);
                        setCheckedIds([]);
                      }}
                      aria-pressed={bulkMode}
                      className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-slate-600 transition hover:border-slate-300 hover:text-slate-900"
                    >
                      <FiCheckSquare size={11} /> {bulkMode ? '退出批量' : '批量处理'}
                    </button>
                    {bulkMode && (
                      <>
                        <span className="text-[11px] text-slate-500">已选 {checkedIds.length}</span>
                        <button
                          type="button"
                          disabled={checkedIds.length === 0}
                          onClick={() => void handleBulkStatus('resolved')}
                          className="rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold text-emerald-700 transition hover:bg-emerald-100 disabled:opacity-50"
                        >
                          标记已解决
                        </button>
                        <button
                          type="button"
                          disabled={checkedIds.length === 0}
                          onClick={() => void handleBulkStatus('closed')}
                          className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] font-semibold text-slate-600 transition hover:bg-slate-100 disabled:opacity-50"
                        >
                          关闭
                        </button>
                        <button
                          type="button"
                          onClick={() => setCheckedIds(tickets.map(t => t._id))}
                          className="ml-auto text-[11px] font-semibold text-slate-500 underline decoration-slate-300 underline-offset-2 hover:text-slate-800"
                        >
                          全选本页
                        </button>
                      </>
                    )}
                  </div>
                )}

                <div className="flex-1 hover-scrollbar md:overflow-y-auto md:overscroll-contain">
                  {loading ? (
                    <div className="flex flex-col items-center justify-center p-12 space-y-3">
                      <div className="h-8 w-8 animate-spin rounded-full border-2 border-slate-200 border-t-slate-900" />
                      <span className="text-slate-400 text-sm">加载中...</span>
                    </div>
                  ) : listError ? (
                    <div className="p-8 text-center">
                      <FiAlertCircle className="mx-auto mb-2 text-rose-300" size={28} />
                      <p className="text-sm text-slate-500">{listError}</p>
                      <button
                        type="button"
                        onClick={() => void fetchTickets({ page: 1 })}
                        className={cn(studioPrimaryButtonClassName, "mt-3 px-4 py-2 text-xs")}
                      >
                        重试
                      </button>
                    </div>
                  ) : tickets.length === 0 ? (
                    <div className="p-12 text-center">
                      <FiInfo className="mx-auto text-slate-200 mb-2" size={32} />
                      <p className="text-slate-400 text-sm">暂无工单数据</p>
                    </div>
                  ) : (
                    <div className="divide-y divide-slate-100">
                      {tickets.map((ticket, idx) => (
                        <TicketListItem
                          key={ticket._id}
                          ticket={ticket}
                          index={idx}
                          selected={selectedTicket?._id === ticket._id}
                          isAdmin={isAdmin}
                          bulkMode={bulkMode}
                          checked={checkedIds.includes(ticket._id)}
                          onToggleCheck={toggleChecked}
                          onOpen={(summary) => void openTicket(summary)}
                        />
                      ))}
                      {listMeta.hasMore && (
                        <div className="p-3 text-center">
                          <button
                            type="button"
                            onClick={() => void fetchTickets({ page: listMeta.page + 1, append: true })}
                            className="rounded-full border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-600 transition hover:border-slate-300 hover:text-slate-900"
                          >
                            加载更多（已显示 {tickets.length}/{listMeta.total}）
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* 右侧详情 */}
          <AnimatePresence mode="wait">
            {(!isMobile || showDetailOnMobile) && (
              <motion.div
                key="detail-container"
                className={cn(
                  "w-full flex flex-col relative md:flex-1 md:h-full md:overflow-hidden",
                  studioMainSurfaceClassName,
                  "p-0 sm:p-0",
                )}
                initial={isMobile ? { opacity: 0, x: 20 } : { opacity: 0 }}
                animate={{ opacity: 1, x: 0 }}
                exit={isMobile ? { opacity: 0, x: 20 } : undefined}
                transition={{ duration: 0.3 }}
              >
                {isMobile && (showDetailOnMobile || isCreating) && (
                  <div className="flex items-center justify-between gap-2 border-b border-slate-200/80 bg-white/80 backdrop-blur-md p-3 sticky top-0 z-20 shrink-0">
                    <button
                      onClick={() => {
                        setShowDetailOnMobile(false);
                        setIsCreating(false);
                      }}
                      className={cn(studioGhostButtonClassName, "py-2")}
                    >
                      <FiChevronRight className="rotate-180" size={16} /> 返回
                    </button>
                    <div className="text-xs font-semibold text-slate-500 truncate max-w-[180px] px-2">
                      {isCreating ? "发起新工单" : selectedTicket?.title}
                    </div>
                  </div>
                )}

                <AnimatePresence mode="wait">
                  {isCreating ? (
                    <motion.div
                      key="create"
                      initial={{ opacity: 0, scale: 0.98 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.98 }}
                      className="p-5 sm:p-8 md:h-full md:overflow-y-auto"
                    >
                      <div className="max-w-xl mx-auto">
                        <div className="mb-5 flex items-center gap-3">
                          <div className={studioStrongBadgeClassName}>
                            <FiPlus />
                          </div>
                          <div>
                            <div className={studioEyebrowClassName}>New Ticket</div>
                            <h3
                              className="text-xl font-semibold text-slate-900"
                              style={{ fontFamily: studioDisplayFont }}
                            >
                              发起新工单
                            </h3>
                          </div>
                        </div>
                        <form onSubmit={handleCreateTicket} className="space-y-4 sm:space-y-5">
                          <div>
                            <div className="mb-2 flex items-center justify-between">
                              <label className={cn(studioEyebrowClassName, "block")}>工单标题</label>
                              <span className="text-[10px] text-slate-400">{newTicket.title.length}/{MAX_TICKET_TITLE_LEN}</span>
                            </div>
                            <input
                              type="text"
                              required
                              maxLength={MAX_TICKET_TITLE_LEN}
                              placeholder="请输入简明扼要的标题"
                              className={studioFieldClassName}
                              value={newTicket.title}
                              onChange={e => setNewTicket(prev => ({ ...prev, title: e.target.value }))}
                            />
                          </div>
                          <div>
                            <label className={cn(studioEyebrowClassName, "mb-2 block")}>问题分类</label>
                            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                              {TICKET_CATEGORY_ORDER.map((category) => {
                                const meta = TICKET_CATEGORY_META[category];
                                const isActive = newTicket.category === category;
                                return (
                                  <label key={category} className="min-w-0">
                                    <input
                                      type="radio"
                                      name="category"
                                      value={category}
                                      checked={isActive}
                                      onChange={e => setNewTicket(prev => ({ ...prev, category: e.target.value }))}
                                      className="hidden peer"
                                    />
                                    <div
                                      className={cn(
                                        "cursor-pointer rounded-2xl border px-3 py-2 text-left transition",
                                        isActive ? "border-slate-900 bg-white" : "border-slate-200 bg-white hover:border-slate-300",
                                      )}
                                    >
                                      <span className="block text-xs font-semibold text-slate-900">{meta.label}</span>
                                      <span className="mt-0.5 block text-[10px] leading-4 text-slate-500">{meta.hint}</span>
                                    </div>
                                  </label>
                                );
                              })}
                            </div>
                          </div>
                          <div>
                            <label className={cn(studioEyebrowClassName, "mb-2 block")}>紧急程度</label>
                            <div className="flex gap-2 sm:gap-3">
                              {(['low', 'medium', 'high'] as const).map(p => {
                                const isActive = newTicket.priority === p;
                                const toneActiveClass =
                                  p === 'high' ? 'bg-rose-50 border-rose-300 text-rose-700' :
                                  p === 'medium' ? 'bg-amber-50 border-amber-300 text-amber-700' :
                                  'bg-emerald-50 border-emerald-300 text-emerald-700';
                                return (
                                  <label key={p} className="flex-1">
                                    <input
                                      type="radio"
                                      name="priority"
                                      value={p}
                                      checked={isActive}
                                      onChange={e => setNewTicket(prev => ({ ...prev, priority: e.target.value }))}
                                      className="hidden peer"
                                    />
                                    <div
                                      className={cn(
                                        "text-center py-2.5 rounded-2xl border cursor-pointer transition-all text-xs sm:text-sm font-semibold sm:rounded-2xl",
                                        isActive ? toneActiveClass : "border-slate-200 bg-white text-slate-500 hover:border-slate-300 hover:text-slate-700",
                                      )}
                                    >
                                      {p === 'high' ? '紧急' : p === 'medium' ? '一般' : '低'}
                                    </div>
                                  </label>
                                );
                              })}
                            </div>
                          </div>
                          <div>
                            <div className="mb-2 flex items-center justify-between">
                              <label className={cn(studioEyebrowClassName, "block")}>详细描述</label>
                              <span className={cn("text-[10px]", newTicket.description.length > MAX_TICKET_DESC_LEN ? "text-rose-500 font-semibold" : "text-slate-400")}>
                                {newTicket.description.length}/{MAX_TICKET_DESC_LEN}
                              </span>
                            </div>
                            <textarea
                              required
                              rows={isMobile ? 6 : 8}
                              maxLength={MAX_TICKET_DESC_LEN + 200}
                              placeholder="请尽可能详细地说明您遇到的问题或建议，以便我们能更快为您处理..."
                              className={studioTextareaClassName}
                              value={newTicket.description}
                              onChange={e => setNewTicket(prev => ({ ...prev, description: e.target.value }))}
                            />
                          </div>
                          {overLengthDraft?.kind === "create" && (
                            <OverLengthMailNotice
                              draft={overLengthDraft}
                              account={user?.id ?? ""}
                              onDismiss={() => setOverLengthDraft(null)}
                            />
                          )}
                          <div className="flex flex-col gap-2 pt-2 sm:flex-row">
                            <motion.button
                              type="submit"
                              disabled={isSubmitting}
                              className={cn(studioPrimaryButtonClassName, "flex-1")}
                              whileHover={hoverScale(1.01)}
                              whileTap={tapScale(0.99)}
                            >
                              <FiSend size={14} />
                              {isSubmitting ? '提交中...' : '提交工单'}
                            </motion.button>
                            <motion.button
                              type="button"
                              onClick={() => {
                                setIsCreating(false);
                                if (isMobile) setShowDetailOnMobile(false);
                              }}
                              className={cn(studioGhostButtonClassName, "px-6 py-3")}
                              whileHover={hoverScale(1.01)}
                              whileTap={tapScale(0.99)}
                            >
                              取消
                            </motion.button>
                          </div>
                        </form>
                      </div>
                    </motion.div>
                  ) : selectedTicket ? (
                    <motion.div
                      key="detail"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      className="flex flex-col md:h-full"
                    >
                      {/* Detail header */}
                      <div className="flex flex-col gap-3 border-b border-slate-200/80 bg-slate-50/40 p-4 sm:p-5 sm:flex-row sm:items-center sm:justify-between">
                        <div className="space-y-2 min-w-0">
                          <div className="flex items-center gap-2 sm:gap-3 flex-wrap">
                            <h3 className="font-semibold text-slate-900 text-sm sm:text-base truncate">{selectedTicket.title}</h3>
                            {getPriorityBadge(selectedTicket.priority)}
                          </div>
                          <div className="flex items-center gap-4 text-[10px] sm:text-[11px] text-slate-500 font-mono flex-wrap">
                            <span className="flex items-center gap-1"><FiUser className="text-slate-400" /> {selectedTicket.username}</span>
                            <span className="flex items-center gap-1"><FiClock className="text-slate-400" /> {new Date(selectedTicket.createdAt).toLocaleString()}</span>
                          </div>
                        </div>
                        <div className="flex w-full items-center gap-2 overflow-x-auto pb-1 sm:w-auto sm:flex-wrap sm:justify-end sm:overflow-visible sm:pb-0">
                          {canWrite ? (
                            <>
                              <select
                                aria-label="工单状态"
                                className={cn(studioFieldClassName, "shrink-0 py-2 text-xs sm:w-auto")}
                                value={selectedTicket.status}
                                onChange={e => handleUpdateStatus(selectedTicket._id, e.target.value)}
                              >
                                {TICKET_STATUS_ORDER.map((status) => (
                                  <option key={status} value={status}>
                                    设为{TICKET_STATUS_META[status].label}
                                  </option>
                                ))}
                              </select>
                              <select
                                aria-label="优先级"
                                className={cn(studioFieldClassName, "shrink-0 py-2 text-xs sm:w-auto")}
                                value={selectedTicket.priority}
                                onChange={e => void handleUpdateFields(selectedTicket._id, { priority: e.target.value })}
                              >
                                {Object.entries(TICKET_PRIORITY_META).map(([key, meta]) => (
                                  <option key={key} value={key}>{meta.label}优先</option>
                                ))}
                              </select>
                              <select
                                aria-label="工单分类"
                                className={cn(studioFieldClassName, "shrink-0 py-2 text-xs sm:w-auto")}
                                value={selectedTicket.category || 'other'}
                                onChange={e => void handleUpdateFields(selectedTicket._id, { category: e.target.value })}
                              >
                                {TICKET_CATEGORY_ORDER.map((category) => (
                                  <option key={category} value={category}>{TICKET_CATEGORY_META[category].label}</option>
                                ))}
                              </select>
                              <button
                                type="button"
                                onClick={() => void handleUpdateFields(selectedTicket._id, {
                                  assignee: selectedTicket.assigneeId === user?.id ? null : 'me',
                                })}
                                className={cn(
                                  "shrink-0 rounded-full border px-3 py-2 text-[11px] font-semibold transition",
                                  selectedTicket.assigneeId === user?.id
                                    ? "border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
                                    : "border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:text-slate-900",
                                )}
                                title={selectedTicket.assigneeName ? `当前受理：${selectedTicket.assigneeName}` : '尚未分配受理人'}
                              >
                                {selectedTicket.assigneeId === user?.id ? '已认领 · 退回' : '认领工单'}
                              </button>
                            </>
                          ) : (
                            <>
                              {getStatusBadge(selectedTicket.status)}
                              {selectedTicket.status !== 'closed' && (
                                <button
                                  type="button"
                                  onClick={() => void handleCloseTicket()}
                                  className="shrink-0 rounded-full border border-slate-200 bg-white px-3 py-2 text-[11px] font-semibold text-slate-600 transition hover:border-rose-200 hover:text-rose-600"
                                >
                                  关闭工单
                                </button>
                              )}
                            </>
                          )}
                          <button
                            type="button"
                            onClick={handleCopyLink}
                            className="shrink-0 rounded-full border border-slate-200 bg-white px-3 py-2 text-[11px] font-semibold text-slate-600 transition hover:border-slate-300 hover:text-slate-900"
                            title="复制可直达该工单的链接"
                          >
                            <FiLink className="inline" size={11} /> 复制链接
                          </button>
                        </div>
                      </div>

                      {/* Messages */}
                      <div className="p-4 sm:p-6 2xl:p-8 space-y-4 sm:space-y-6 bg-white hover-scrollbar md:flex-1 md:overflow-y-auto md:overscroll-contain">
                        {selectedTicket.messages.map((msg, idx) => {
                          const isAi = msg.senderRole === "ai" || msg.isAi;
                          const isMe = msg.senderId === user?.id;
                          const isAdminMsg = msg.senderRole === "admin";
                          // 内部备注：后端只对 superadmin 下发，这里再做一层样式区分。
                          const isInternal = (msg as { visibility?: string }).visibility === "internal";

                          return (
                            <motion.div
                              key={`${selectedTicket._id}-${idx}`}
                              className={`flex ${isMe ? 'justify-end' : 'justify-start'} group mb-4`}
                              initial={ROW_INITIAL}
                              animate={ROW_ANIMATE}
                              transition={{ duration: 0.3 }}
                            >
                              {/* 气泡宽度按视口放宽：手机 92% 够用，2xl 收到 70% 避免一行读太长。 */}
                              <div className={`max-w-[92%] sm:max-w-[85%] lg:max-w-[78%] 2xl:max-w-[70%] relative ${isMe ? 'order-1' : 'order-2'}`}>
                                <div className={`flex items-center gap-2 mb-1 text-[10px] text-slate-400 ${isMe ? 'justify-end' : 'justify-start'}`}>
                                  {!isMe && !isInternal && (
                                    <span className={cn(
                                      "font-semibold",
                                      isAdminMsg ? "text-slate-700" : "text-slate-500",
                                    )}>
                                      {isAi ? (
                                        <>
                                          <FiCpu className="inline" size={11} /> 智能助手
                                        </>
                                      ) : isAdminMsg ? (
                                        "Official Customer Service"
                                      ) : (
                                        <>
                                          <FiUser className="inline" size={11} /> 用户
                                        </>
                                      )}
                                    </span>
                                  )}
                                  <span>{new Date(msg.createdAt).toLocaleString()}</span>
                                </div>

                                <div className={cn(
                                  "relative rounded-2xl p-3.5 sm:p-4 sm:rounded-2xl transition-shadow",
                                  isMe
                                    ? "bg-slate-900 text-white rounded-tr-[10px] shadow-sm"
                                    : isInternal
                                      ? "bg-violet-50 border border-violet-200 text-slate-900 rounded-tl-[10px]"
                                      : isAi
                                        ? "bg-white border border-slate-200 text-slate-900 rounded-tl-[10px] shadow-sm"
                                        : "bg-slate-50 border border-slate-200 text-slate-900 rounded-tl-[10px]",
                                )}>
                                  {isInternal && (
                                    <div className={cn(studioEyebrowClassName, "mb-1 flex items-center gap-1 text-[10px] tracking-[0.22em] text-violet-600")}>
                                      <FiLock size={10} /> 内部备注（用户不可见）
                                    </div>
                                  )}
                                  {isAdminMsg && !isInternal && (
                                    <div className={cn(studioEyebrowClassName, "mb-1 flex items-center gap-1 text-[10px] tracking-[0.22em]")}>
                                      <FiCheckCircle size={10} /> Official Reply
                                    </div>
                                  )}
                                  {editingIdx === idx ? (
                                    <div className="space-y-2">
                                      <textarea
                                        className="w-full bg-white/10 border border-white/30 rounded-[14px] p-2 text-sm focus:outline-none focus:ring-1 focus:ring-white/50 min-h-[100px] text-white placeholder:text-white/60"
                                        value={editValue}
                                        maxLength={MAX_TICKET_REPLY_LEN}
                                        onChange={(e) => setEditValue(e.target.value)}
                                        autoFocus
                                      />
                                      <div className="flex gap-2 justify-end">
                                        <button
                                          onClick={() => handleAdminEdit(selectedTicket._id, idx)}
                                          disabled={isUpdating}
                                          className="px-3 py-1 bg-emerald-500 text-white text-xs rounded-full font-semibold flex items-center gap-1 hover:bg-emerald-600 transition"
                                        >
                                          {isUpdating ? <FiLoader className="animate-spin" /> : <FiCheck />} 保存
                                        </button>
                                        <button
                                          onClick={() => setEditingIdx(null)}
                                          className="px-3 py-1 bg-white/20 text-white text-xs rounded-full font-semibold hover:bg-white/30 transition"
                                        >
                                          取消
                                        </button>
                                      </div>
                                    </div>
                                  ) : (
                                    <MarkdownRenderer
                                      content={msg.content}
                                      density="compact"
                                      controls={CHAT_MARKDOWN_CONTROLS}
                                      onContentCopy={(success) => notifyMarkdownCopy(success, true)}
                                      onCodeCopy={(success) => notifyMarkdownCopy(success)}
                                      invert={isMe}
                                    />
                                  )}

                                  {isAdmin && isAi && msg.aiErrorDetails && (
                                    <AiErrorDetailsPanel diagnostics={msg.aiErrorDetails} />
                                  )}

                                  {canWrite && editingIdx !== idx && (
                                    <div className={`absolute -bottom-6 ${isMe ? 'left-0' : 'right-0'} opacity-0 group-hover:opacity-100 transition-opacity flex gap-2`}>
                                      <button
                                        onClick={() => {
                                          setEditingIdx(idx);
                                          setEditValue(msg.content);
                                        }}
                                        className="p-1 text-slate-400 hover:text-slate-700 transition-colors"
                                        title="编辑消息"
                                      >
                                        <FiEdit2 size={12} />
                                      </button>
                                      <button
                                        onClick={() => handleAdminDelete(selectedTicket._id, idx)}
                                        className="p-1 text-slate-400 hover:text-rose-500 transition-colors"
                                        title="删除消息"
                                      >
                                        <FiTrash2 size={12} />
                                      </button>
                                    </div>
                                  )}
                                </div>
                              </div>
                            </motion.div>
                          );
                        })}

                        <AnimatePresence>
                          {streamingAiResponse && streamingAiResponse.ticketId === selectedTicket?._id && (
                            <motion.div
                              initial={{ opacity: 0, y: 10 }}
                              animate={{ opacity: 1, y: 0 }}
                              exit={{ opacity: 0 }}
                              className="flex justify-start mb-4"
                            >
                              <div className="max-w-[92%] sm:max-w-[85%] lg:max-w-[78%] 2xl:max-w-[70%] relative order-2">
                                <div className="flex items-center gap-2 mb-1 text-[10px] text-slate-400 justify-start">
                                  <span className="inline-flex items-center gap-1 font-semibold text-slate-500">
                                    <FiCpu size={11} /> 智能助手（正在输入…）
                                  </span>
                                </div>
                                <div className="relative rounded-2xl p-3.5 sm:p-4 bg-white border border-slate-200 text-slate-900 rounded-tl-[10px] shadow-sm sm:rounded-2xl">
                                  <MarkdownRenderer content={streamingAiResponse.content} density="compact" />
                                  <span className="inline-block w-1.5 h-4 ml-1 bg-slate-700 animate-pulse align-middle" />
                                </div>
                              </div>
                            </motion.div>
                          )}
                        </AnimatePresence>

                                                <div ref={messagesEndRef} />
                      </div>

                      {/* Reply form */}
                      {selectedTicket.status === "closed" ? (
                        <div className="border-t border-slate-200/80 bg-slate-50 p-4 sm:p-6 text-center shrink-0">
                          <p className="text-xs sm:text-sm text-slate-500 font-medium flex items-center justify-center gap-2">
                            <FiX /> {canWrite
                              ? "此工单已关闭，可通过上方状态下拉重新开启"
                              : "此工单已关闭，如需继续咨询请发起新工单"}
                          </p>
                        </div>
                      ) : isAdmin && !canWrite ? (
                        <div className="border-t border-slate-200/80 bg-slate-50 p-4 sm:p-6 text-center shrink-0">
                          <p className="text-xs sm:text-sm text-slate-500 font-medium flex items-center justify-center gap-2">
                            <FiInfo /> 只读管理员无回复权限，处理工单请使用超级管理员账号
                          </p>
                        </div>
                      ) : (
                        <TicketComposer
                          draftKey={selectedTicket._id}
                          disabled={isSubmitting}
                          isAdmin={isAdmin}
                          canWriteInternal={isSuperAdmin(user?.role)}
                          onSend={handleReply}
                        />
                      )}
                    </motion.div>
                  ) : (
                    <motion.div
                      key="empty"
                      className="flex flex-col items-center justify-center h-full text-slate-300 p-8 sm:p-12"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                    >
                      <div className="flex h-16 w-16 sm:h-20 sm:w-20 items-center justify-center rounded-2xl border border-slate-200 bg-slate-50 text-slate-400 mb-4 shadow-inner sm:rounded-2xl">
                        <FiMessageSquare size={isMobile ? 32 : 40} />
                      </div>
                      <h3 className="text-lg sm:text-xl font-semibold text-slate-700 mb-2 text-center" style={{ fontFamily: studioDisplayFont }}>选择一个工单</h3>
                      <p className="text-xs sm:text-sm text-slate-400 text-center max-w-xs leading-relaxed">
                        <span className="md:hidden">请从工单列表选择已有工单查看详情，或点「发起新工单」开始新的对话请求。</span>
                        <span className="hidden md:inline">请从左侧列表选择已有工单查看详情，或点击上方按钮开启新的对话请求。</span>
                      </p>
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      <TicketProcessingToast step={processingStep} onDismiss={() => setProcessingStep(null)} />
    </div>
  );
};

export default TicketSystem;
