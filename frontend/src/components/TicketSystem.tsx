import React, { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { useAuth } from "../hooks/useAuth";
import { isAdminRole, isSuperAdmin } from "../utils/rbac";
import {
  ticketApi,
  ITicket,
  ITicketSummary,
  ITicketAttachment,
  TicketCapabilities,
  TicketListMeta,
  TicketStats,
  type TicketCategory,
  type TicketContentFormat,
  type TicketRelatedService,
  type TicketType,
} from "../api/ticketApi";
import TicketListItem from "./ticket/TicketListItem";
import TicketFilters, {
  EMPTY_TICKET_FILTER,
  ticketQuickViewPatch,
  type TicketFilterValue,
} from "./ticket/TicketFilters";
import TicketStatsBar from "./ticket/TicketStatsBar";
import TicketHeroBody, { type TicketPenaltyAppeal } from "./ticket/TicketHero";
import { ticketPriorityBadge, ticketStatusBadge } from "./ticket/ticketBadges";
import TicketComposer from "./ticket/TicketComposer";
import TicketCreateForm, { clearTicketCreateDraft } from "./ticket/TicketCreateForm";
import TicketDetailMeta from "./ticket/TicketDetailMeta";
import TicketAttachmentSettingsCard from "./ticket/TicketAttachmentSettingsCard";
import {
  TicketAttachmentLinks,
  TicketAttachmentList,
} from "./ticket/TicketAttachments";
import { OverLengthMailNotice, type OverLengthDraft } from "./ticket/OverLengthMailNotice";
import TicketProcessingToast from "./ticket/TicketProcessingToast";
import TicketUserFilters, {
  EMPTY_USER_TICKET_FILTER,
  type UserTicketFilterValue,
} from "./ticket/TicketUserFilters";
import TicketConversation from "./ticket/TicketConversation";
import TicketEventTimeline from "./ticket/TicketEventTimeline";
import TicketSatisfactionCard from "./ticket/TicketSatisfactionCard";
import TicketBulkBar, { type TicketBulkPatch } from "./ticket/TicketBulkBar";
import {
  EMPTY_TICKET_URL_STATE,
  readTicketUrlState,
  writeTicketUrlState,
} from "./ticket/ticketUrlState";
import {
  MAX_TICKET_DESC_LEN,
  TICKET_CATEGORY_META,
  TICKET_CATEGORY_ORDER,
  TICKET_PAGE_SIZE,
  TICKET_PRIORITY_META,
  TICKET_SLA_HOURS,
  TICKET_STATUS_META,
  TICKET_STATUS_ORDER,
  TICKET_TYPE_META,
  ticketServiceLabel,
} from "./ticket/ticketConstants";
import { useNotification } from "./Notification";
import { useConfirm } from './confirm/ConfirmDialogProvider';
import { useWebSocket, WsServerMessage } from "../hooks/useWebSocket";
import {
  FiPlus, FiMessageSquare, FiClock,
  FiAlertCircle, FiX, FiFilter,
  FiUser, FiChevronLeft, FiChevronRight, FiInfo,
  FiRefreshCw, FiLink, FiCheckSquare,
} from "react-icons/fi";
import { SUPPORT_EMAIL } from './PenaltyAppealActions';
import { emitPenaltyAppealRequired, isTicketPermissionBanError } from '../utils/penaltyAppeal';
import { cn } from '../utils/cn';
import {
  studioDisplayFont,
  studioEyebrowClassName,
  studioFieldClassName,
  studioGhostButtonClassName,
  studioMainSurfaceClassName,
  studioPageClassName,
  studioPageFont,
  studioPanelClassName,
  studioPrimaryButtonClassName,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}

/** 仅用于列表内的键盘移动：输入框/可选区里按 j/k 仍然是在打字。 */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

/** 详情头部的 SLA 判定：最后一条公开消息来自用户且超过 SLA，且工单未关闭。 */
function isDetailSlaBreached(ticket: ITicket | null): boolean {
  if (!ticket || ticket.status === 'closed') return false;
  const visible = (ticket.messages ?? []).filter(
    (message) => (message as { visibility?: string }).visibility !== 'internal',
  );
  const tail = visible[visible.length - 1];
  if (!tail || tail.senderRole !== 'user') return false;
  const at = new Date(tail.createdAt).getTime();
  return Number.isFinite(at) && Date.now() - at > TICKET_SLA_HOURS * 3_600_000;
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


/**
 * 写操作返回的工单视图不带 `attachments`（只有详情接口带）。
 *
 * 回复 / 改状态 / 认领 / 编辑消息 / 改附件链接成功后都会用它覆盖当前详情；
 * 直接替换会把已加载的附件列表从界面上抹掉，直到用户重新打开工单。
 * 附件元数据不会因这些操作而过期，所以保留上一份；其余字段仍以服务端最新值为准。
 */
function mergeTicketDetail(current: ITicket | null, updated: ITicket): ITicket {
  if (!current || current._id !== updated._id) return updated;
  return {
    ...updated,
    attachments: updated.attachments ?? current.attachments,
    // WebSocket 的局部视图（例如批量更新的广播）可能不带 messages：
    // 直接用它会清空已打开的会话，所以缺字段时保留上一份。
    messages: updated.messages ?? current.messages,
  };
}

const TicketSystem: React.FC = () => {
  const { user } = useAuth();
  const isAdmin = isAdminRole(user?.role);
  const canWrite = isSuperAdmin(user?.role);
  const { setNotification } = useNotification();
  const confirm = useConfirm();
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
  const [bulkBusy, setBulkBusy] = useState(false);
  const [checkedIds, setCheckedIds] = useState<string[]>([]);
  const [overLengthDraft, setOverLengthDraft] = useState<OverLengthDraft>(null);
  const [isCreating, setIsCreating] = useState(false);
  // 创建成功后递增：让已卸载/正在卸载的表单也能可靠清掉本地草稿。
  const [createResetSignal, setCreateResetSignal] = useState(0);
  const [newTicket, setNewTicket] = useState({
    title: "",
    description: "",
    // 描述正文格式：markdown（默认，渲染排版）或 plain（纯文本，原样保留换行与空格）。
    contentFormat: "markdown",
    priority: "medium",
    category: "other",
    type: "inquiry",
    relatedService: "other",
    relatedServiceRef: "",
    contactEmail: "",
    attachmentLinks: [] as Array<{ url: string; label?: string | null }>,
    relatedTicketIds: [] as string[],
  });
  // 创建工单时单据还未存在，附件只能先攒在内存里，提交成功后再逐个上传。
  const [pendingAttachments, setPendingAttachments] = useState<File[]>([]);
  // 关联工单候选（创建表单用）：只拉自己最近的工单，避免为一次选择单独建一个搜索接口。
  const [linkingCandidates, setLinkingCandidates] = useState<Array<{ _id: string; title: string }>>([]);
  // 工单能力（附件上传开关与限额）。服务端是执行边界，这里只用于渲染。
  const [capabilities, setCapabilities] = useState<TicketCapabilities | null>(null);

  // 初始筛选只从 URL 读一次：之后筛选由用户操作驱动、再写回 URL。
  // 双向监听 popstate 会让「输入中」的状态被历史记录覆盖，所以刻意不做。
  const [initialUrlState] = useState(() =>
    readTicketUrlState(typeof window === 'undefined' ? '' : window.location.search),
  );
  const [adminFilter, setAdminFilter] = useState<TicketFilterValue>(() => ({
    ...EMPTY_TICKET_FILTER,
    status: initialUrlState.status,
    priority: initialUrlState.priority,
    category: initialUrlState.category,
    type: initialUrlState.type,
    service: initialUrlState.service,
    assignee: initialUrlState.assignee,
    awaitingReply: initialUrlState.awaitingReply,
    unread: initialUrlState.unread,
    csat: initialUrlState.csat,
    sort: initialUrlState.sort || EMPTY_TICKET_FILTER.sort,
    q: initialUrlState.q,
    from: initialUrlState.from,
    to: initialUrlState.to,
    limit: initialUrlState.limit,
  }));
  // 输入即改 adminFilter.q，但只有停止输入 350ms 后才拿去请求，避免每敲一个字打一次接口。
  const [queryFilter, setQueryFilter] = useState<TicketFilterValue>(() => ({
    ...EMPTY_TICKET_FILTER,
    status: initialUrlState.status,
    priority: initialUrlState.priority,
    category: initialUrlState.category,
    type: initialUrlState.type,
    service: initialUrlState.service,
    assignee: initialUrlState.assignee,
    awaitingReply: initialUrlState.awaitingReply,
    unread: initialUrlState.unread,
    csat: initialUrlState.csat,
    sort: initialUrlState.sort || EMPTY_TICKET_FILTER.sort,
    q: initialUrlState.q,
    from: initialUrlState.from,
    to: initialUrlState.to,
    limit: initialUrlState.limit,
  }));
  // 当前快捷视图（all/mine/unassigned/awaiting/overdue/lowCsat）：仅用于高亮，不参与请求。
  const [activeView, setActiveView] = useState('all');

  // 用户端筛选：与管理端共用同一份 URL 参数，但只有关键词/状态/排序。
  const [userFilter, setUserFilter] = useState<UserTicketFilterValue>(() => ({
    status: initialUrlState.status,
    q: initialUrlState.q,
    sort: initialUrlState.sort || EMPTY_USER_TICKET_FILTER.sort,
  }));
  const [userSearchInput, setUserSearchInput] = useState(initialUrlState.q);
  const [userQuery, setUserQuery] = useState<UserTicketFilterValue>(() => ({
    status: initialUrlState.status,
    q: initialUrlState.q,
    sort: initialUrlState.sort || EMPTY_USER_TICKET_FILTER.sort,
  }));
  // 深链：只认第一次读到的 ?ticket=id，之后由选中状态驱动。
  const initialTicketIdRef = useRef(initialUrlState.ticketId);
  // 深链还没落地前不要先把它从地址栏抹掉（否则用户在这几百毫秒里复制的链接会丢工单参数）。
  // 用 state 而不是 ref：落地后要触发一次 URL 同步，把失败的深链参数清掉。
  const [deepLinkPending, setDeepLinkPending] = useState(Boolean(initialUrlState.ticketId));
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

  const prefersReducedMotion = useReducedMotion();
  const notifyMarkdownCopy = useCallback((success: boolean, wholeMessage = false) => {
    setNotification({
      type: success ? 'success' : 'error',
      message: success ? (wholeMessage ? 'Markdown内容已复制到剪贴板' : '代码已复制') : '复制失败',
    });
  }, [setNotification]);

  useEffect(() => {
    if (!processingStep) return;
    // F5-31：失败态常驻到用户主动关闭——原先 3 秒就消失，用户既看不到原因也无从补救
    if (processingStep === "audit_failed" || processingStep === "error") return;
    const isEnding = processingStep === "ai_complete";
    const timer = setTimeout(() => {
      setProcessingStep(null);
    }, isEnding ? 3000 : 20000);
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
    // TP-07：WS `ticket:update` 路径在本地投影工单，ageHours 写死 0 会让管理端的
    // 「逾期」徽标在刷新列表前失效。这里按后端同一口径（2 位小数小时）算一次。
    const ageAnchor = new Date(ticket.updatedAt || ticket.createdAt).getTime();
    const ageHours = Number.isFinite(ageAnchor)
      ? Math.max(0, Math.round((Date.now() - ageAnchor) / 36_000) / 100)
      : 0;
    return {
      _id: ticket._id,
      userId: ticket.userId,
      username: ticket.username,
      title: ticket.title,
      description: ticket.description,
      status: ticket.status,
      priority: ticket.priority,
      category: (ticket.category || 'other') as ITicketSummary['category'],
      type: ticket.type ?? 'inquiry',
      relatedService: ticket.relatedService ?? 'other',
      relatedServiceRef: ticket.relatedServiceRef ?? null,
      contactEmail: ticket.contactEmail ?? null,
      relatedTickets: ticket.relatedTickets ?? [],
      attachmentLinks: ticket.attachmentLinks ?? [],
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
      attachmentCount: ticket.attachmentCount ?? (ticket.attachments?.length ?? 0),
      // 满意度评分同步到列表徽标：用户刚评价完不必刷新列表才看到自己的星级。
      csatRating: typeof ticket.csatRating === 'number' ? ticket.csatRating : null,
      ageHours,
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

    setSelectedTicket(prev => mergeTicketDetail(prev, updatedTicket));
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
      setSelectedTicket(prev => mergeTicketDetail(prev, updated));
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
    const ok = await confirm({
      title: '确认执行该操作？',
      description: "确定要删除这条消息吗？此操作不可撤销。",
      tone: 'danger',
      confirmLabel: '删除',
    });
    if (!ok) return;
    try {
      const updated = await ticketApi.adminDeleteMessage(ticketId, idx);
      setSelectedTicket(prev => mergeTicketDetail(prev, updated));
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
    // 日期筛选：用户选的是本地日期，这里换成明确的 ISO 瞬时值（含到当天 23:59:59），
    // 避免后端 `new Date("2026-10-16")` 按 UTC 解析造成「差一天」。
    const toIsoBoundary = (value: string, endOfDay: boolean): string | undefined => {
      if (!value) return undefined;
      const parsed = new Date(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00'}`);
      return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
    };
    const pageSize = Number.parseInt((isAdmin ? queryFilter.limit : '') || '', 10);
    const limit = Number.isFinite(pageSize) && pageSize > 0 ? pageSize : TICKET_PAGE_SIZE;
    try {
      if (!append) setLoading(true);
      setListError(null);
      const result = isAdmin
        ? await ticketApi.getAllTickets({
          status: queryFilter.status || undefined,
          priority: queryFilter.priority || undefined,
          category: queryFilter.category || undefined,
          type: queryFilter.type || undefined,
          service: queryFilter.service || undefined,
          assignee: queryFilter.assignee || undefined,
          awaitingReply: queryFilter.awaitingReply || undefined,
          unread: queryFilter.unread || undefined,
          csat: queryFilter.csat || undefined,
          sort: queryFilter.sort || undefined,
          q: queryFilter.q || undefined,
          from: toIsoBoundary(queryFilter.from, false),
          to: toIsoBoundary(queryFilter.to, true),
          page,
          limit,
        })
        : await ticketApi.getMyTickets({
          page,
          limit,
          q: userQuery.q || undefined,
          status: userQuery.status || undefined,
          sort: userQuery.sort || undefined,
        });
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
  }, [isAdmin, isCreating, isMobile, openTicket, queryFilter, userQuery]);

  // 关键词防抖：输入改 adminFilter，停顿 350ms 后才进 queryFilter 触发请求。
  useEffect(() => {
    const timer = window.setTimeout(() => setQueryFilter(adminFilter), 350);
    return () => window.clearTimeout(timer);
  }, [adminFilter]);

  // 用户端同一套防抖：搜索框即时值 → 350ms 后进入真正请求的状态。
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const q = userSearchInput.trim();
      setUserQuery((current) => ({ ...current, q }));
      // 同步展示态：筛选栏的「筛选后 / 共 N 条」按 value.q 判断，不同步就会一直显示未筛选。
      setUserFilter((current) => ({ ...current, q }));
    }, 350);
    return () => window.clearTimeout(timer);
  }, [userSearchInput]);

  useEffect(() => {
    void fetchTickets({ page: 1 });
    // fetchTickets 会随 isCreating/isMobile 变化重建，但这两者不应触发重新拉列表。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin, queryFilter, userQuery, user?.id]);

  // URL 同步：筛选与选中工单写进地址栏（replaceState），刷新/分享/后退都能回到同一视图。
  // 用户端与管理端共用同一组参数名，只写非默认值。
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const source = isAdmin
      ? {
        q: queryFilter.q,
        status: queryFilter.status,
        priority: queryFilter.priority,
        category: queryFilter.category,
        type: queryFilter.type,
        service: queryFilter.service,
        assignee: queryFilter.assignee,
        awaitingReply: queryFilter.awaitingReply,
        unread: queryFilter.unread,
        csat: queryFilter.csat,
        sort: queryFilter.sort,
        from: queryFilter.from,
        to: queryFilter.to,
        limit: queryFilter.limit,
      }
      : {
        q: userQuery.q,
        status: userQuery.status,
        sort: userQuery.sort,
      };
    const ticketId = selectedTicket?._id ?? (deepLinkPending ? initialTicketIdRef.current : '');
    writeTicketUrlState(
      {
        ...EMPTY_TICKET_URL_STATE,
        ...source,
        sort: source.sort || EMPTY_TICKET_URL_STATE.sort,
        ticketId,
      },
      { dropTicket: !ticketId },
    );
  }, [deepLinkPending, isAdmin, queryFilter, userQuery, selectedTicket?._id]);

  // 标签页未读提示：切到别的标签也能看到「有回复」。离开页面时恢复基准标题，
  // 由 App 的路由标题逻辑接管。
  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const baseTitle = 'Synapse - 支持中心';
    document.title = unreadCount > 0 ? `（${unreadCount}）支持中心 - Synapse` : baseTitle;
    return () => {
      // 卸载或计数变化时先回到基准标题：/support 的路由标题就是它，下一次 effect 再按新未读改写。
      document.title = baseTitle;
    };
  }, [unreadCount]);

  // 导航角标用：未读数单独取，不依赖列表已加载。
  useEffect(() => {
    void ticketApi.getUnreadCount().then(setUnreadCount).catch(() => undefined);
  }, [user?.id, isAdmin, queryFilter]);

  // 工单能力（附件上传开关与限额）：只取一次。服务端才是执行边界，这里只是把
  // 「必然 403 的按钮」 换成「附件链接输入框」。
  useEffect(() => {
    void ticketApi.getCapabilities().then(setCapabilities).catch(() => undefined);
  }, [user?.id]);

  // 创建表单的「关联工单」候选：打开创建面板时拉一次自己最近的工单
  // （不为一次选择单独建搜索接口；候选上限 = 列表默认页大小）。
  useEffect(() => {
    if (!isCreating || isAdmin) return;
    let cancelled = false;
    void ticketApi
      .getMyTickets({ page: 1, limit: TICKET_PAGE_SIZE })
      .then((page) => {
        if (cancelled) return;
        setLinkingCandidates(page.tickets.map((item) => ({ _id: item._id, title: item.title })));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [isAdmin, isCreating]);

  useEffect(() => {
    refreshAdminStats();
  }, [refreshAdminStats]);

  // 深链：支持 ?ticket=<id> 从通知/邮件直达（打开即拉详情）。
  // 只读第一次解析出的 ID：后续地址栏由选中状态写回，避免「关闭详情 → 深链把它又打开」。
  useEffect(() => {
    const ticketId = initialTicketIdRef.current;
    if (!ticketId) return;
    void ticketApi.getTicket(ticketId)
      .then(full => {
        setSelectedTicket(full);
        setShowDetailOnMobile(true);
        setIsCreating(false);
      })
      .catch((error) => {
        // F5-32：深链打不开时必须说明原因，不能静默落到默认列表
        const status = (error as { response?: { status?: number } })?.response?.status;
        setNotification({
          type: 'error',
          message:
            status === 403
              ? '该工单不存在，或你没有查看权限'
              : status === 404
                ? '该工单不存在或已被删除'
                : '打开工单失败，请稍后重试',
        });
      })
      .finally(() => {
        setDeepLinkPending(false);
      });
  }, []);

  // 会话滚动由 TicketConversation 自己持有：它区分「切工单」与「消息增加」，
  // 并在用户向上翻阅时不强制回到底部（原实现在这里无条件滚到底）。
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
    const filesToUpload = pendingAttachments;
    try {
      const created = await ticketApi.createTicket({
        title: newTicket.title,
        description: newTicket.description,
        contentFormat: newTicket.contentFormat as TicketContentFormat,
        priority: newTicket.priority,
        category: newTicket.category as TicketCategory,
        type: newTicket.type as TicketType,
        relatedService: newTicket.relatedService as TicketRelatedService,
        relatedServiceRef: newTicket.relatedServiceRef.trim() || null,
        contactEmail: newTicket.contactEmail.trim() || null,
        relatedTicketIds: newTicket.relatedTicketIds,
        attachmentLinks: newTicket.attachmentLinks,
      });
      setNotification({ type: 'success', message: "工单已提交" });
      setIsCreating(false);
      setShowDetailOnMobile(false);
      // 草稿清理：表单马上卸载，只靠表单内的 effect 可能来不及跑；父组件用信号兜底。
      setCreateResetSignal((value) => value + 1);
      clearTicketCreateDraft();
      setNewTicket({
        title: "",
        description: "",
        contentFormat: "markdown",
        priority: "medium",
        category: "other",
        type: "inquiry",
        relatedService: "other",
        relatedServiceRef: "",
        contactEmail: "",
        attachmentLinks: [],
        relatedTicketIds: [],
      });
      setPendingAttachments([]);
      setSelectedTicket(created);
      fetchTickets();

      // 附件：工单已存在后才逐个上传（上传端点需要 ticketId）。
      // 失败的附件不阻断工单本身（它已经建好了），但要如实告知哪几个没传上去。
      if (filesToUpload.length > 0) {
        const failed: string[] = [];
        for (const file of filesToUpload) {
          try {
            await ticketApi.uploadAttachment(created._id, file);
          } catch (uploadError) {
            const reason =
              (uploadError as { response?: { data?: { error?: string } } })?.response?.data?.error || '上传失败';
            failed.push(`${file.name}（${reason}）`);
          }
        }
        if (failed.length > 0) {
          setNotification({
            type: 'error',
            message: `工单已提交，但有 ${failed.length} 个附件未上传：${failed.join('；')}`,
            duration: 8000,
          });
        } else {
          setNotification({ type: 'success', message: `工单已提交，${filesToUpload.length} 个附件已上传` });
        }
        // 附件是通过独立接口写入的，重拉一次详情以显示真实列表与计数
        void ticketApi.getTicket(created._id).then(setSelectedTicket).catch(() => undefined);
      }
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

  const handleReply = async (
    content: string,
    internal: boolean,
    format: TicketContentFormat,
  ): Promise<boolean> => {
    if (!selectedTicket || !content.trim()) return false;
    // G12-21：in-flight 防双击，同一条回复不能发两次
    if (isSubmitting) return false;
    setIsSubmitting(true);
    try {
      const updated = await ticketApi.replyTicket(selectedTicket._id, content, internal, format);
      setSelectedTicket(prev => mergeTicketDetail(prev, updated));
      applyTicketUpdate(updated);
      setNotification({
        type: 'success',
        message: internal
          ? '内部备注已保存（用户不可见）'
          : isAdmin
            ? '回复已发送，用户会收到邮件通知'
            : '已发送，客服会尽快跟进',
      });
      // 不再单独滚动：上面那个 effect 会因为消息数增加而把会话滚到底。
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
      if (selectedTicket?._id === id) setSelectedTicket(prev => mergeTicketDetail(prev, updated));
      applyTicketUpdate(updated);
      setNotification({ type: 'success', message: "工单状态已更新" });
      refreshAdminStats();
    } catch (error) {
      const apiError = getApiErrorResponse(error);
      setNotification({ type: 'error', message: apiError?.data?.error || "更新状态失败" });
    }
  };

  // 管理端综合更新：优先级 / 分类 / 类型 / 相关服务 / 联系邮箱 / 关联工单 / 受理人（认领）
  const handleUpdateFields = async (
    id: string,
    fields: {
      priority?: string;
      category?: string;
      type?: string;
      relatedService?: string;
      relatedServiceRef?: string | null;
      contactEmail?: string | null;
      relatedTickets?: string[];
      assignee?: string | null;
    },
  ) => {
    if (!canWrite) return;
    try {
      const updated = await ticketApi.updateFields(id, fields);
      if (selectedTicket?._id === id) setSelectedTicket(prev => mergeTicketDetail(prev, updated));
      applyTicketUpdate(updated);
      setNotification({ type: 'success', message: "工单信息已更新" });
      refreshAdminStats();
    } catch (error) {
      const apiError = getApiErrorResponse(error);
      setNotification({ type: 'error', message: apiError?.data?.error || "更新工单失败" });
    }
  };

  /**
   * 附件链接：乐观更新后就地提交（每次增/删一个链接 = 一次请求，这是离散动作）。
   * 失败则回滚到请求前的列表，避免界面显示“已保存”但服务端没存上。
   */
  const handleAttachmentLinksChange = useCallback(
    async (links: Array<{ url: string; label?: string | null }>) => {
      const ticket = selectedTicketRef.current;
      if (!ticket) return;
      const previous = ticket.attachmentLinks ?? [];
      setSelectedTicket({ ...ticket, attachmentLinks: links });
      try {
        const updated = await ticketApi.updateAttachmentLinks(ticket._id, links);
        setSelectedTicket(prev => mergeTicketDetail(prev, updated));
        applyTicketUpdate(updated);
      } catch (error) {
        setSelectedTicket({ ...ticket, attachmentLinks: previous });
        const apiError = getApiErrorResponse(error);
        setNotification({ type: 'error', message: apiError?.data?.error || '附件链接保存失败，请重试' });
      }
    },
    [applyTicketUpdate, setNotification],
  );

  const handleAttachmentUploaded = useCallback(
    ({ attachment, attachmentCount }: { attachment: ITicketAttachment; attachmentCount: number }) => {
      setSelectedTicket((prev) =>
        prev ? { ...prev, attachmentCount, attachments: [...(prev.attachments ?? []), attachment] } : prev,
      );
      setNotification({ type: 'success', message: `附件「${attachment.fileName}」已上传` });
    },
    [setNotification],
  );

  const handleAttachmentDeleted = useCallback(
    (attachmentId: string, attachmentCount: number) => {
      setSelectedTicket((prev) =>
        prev
          ? {
              ...prev,
              attachmentCount,
              attachments: (prev.attachments ?? []).filter((item) => item.id !== attachmentId),
            }
          : prev,
      );
      setNotification({ type: 'success', message: '附件已删除' });
    },
    [setNotification],
  );

  /** 打开任意工单（关联工单跳转 / 深链复用）。 */
  const handleOpenTicketById = useCallback(
    (ticketId: string) => {
      if (!ticketId) return;
      void ticketApi
        .getTicket(ticketId)
        .then((full) => {
          setSelectedTicket(full);
          setShowDetailOnMobile(true);
          setIsCreating(false);
          if (typeof window !== 'undefined') {
            const url = new URL(window.location.href);
            url.searchParams.set('ticket', full._id);
            window.history.replaceState({}, '', `${url.pathname}?${url.searchParams.toString()}`);
          }
        })
        .catch((error) => {
          const status = (error as { response?: { status?: number } })?.response?.status;
          setNotification({
            type: 'error',
            message:
              status === 403
                ? '该工单不存在，或你没有查看权限'
                : status === 404
                  ? '该工单不存在或已被删除'
                  : '打开工单失败，请稍后重试',
          });
        });
    },
    [setNotification],
  );

  // 批量操作（状态 / 优先级 / 分类 / 受理人）：确认后一次提交，成功后重拉列表。
  // 返回的 matched/updated 用来如实告知「有多少张其实没变化」。
  const handleBulk = async (patch: TicketBulkPatch) => {
    if (!canWrite || checkedIds.length === 0 || bulkBusy) return;
    const actionLabel =
      patch.status === 'resolved' ? '标记为已解决'
        : patch.status === 'closed' ? '关闭'
          : patch.status === 'open' ? '重新打开'
            : patch.priority ? `修改优先级为「${TICKET_PRIORITY_META[patch.priority]?.label ?? patch.priority}」`
              : patch.category ? `修改分类为「${TICKET_CATEGORY_META[patch.category]?.label ?? patch.category}」`
                : patch.assignee === 'me' ? '认领给我'
                  : patch.assignee === 'none' ? '取消分配'
                    : patch.assignee ? '转派受理人'
                      : '批量更新';
    const ok = await confirm({
      title: `确认批量${actionLabel}？`,
      description: `将应用于已选中的 ${checkedIds.length} 个工单；没有实际变化的工单会被跳过。`,
      confirmLabel: '执行',
      tone: patch.status === 'closed' ? 'danger' : 'default',
    });
    if (!ok) return;
    setBulkBusy(true);
    try {
      const result = await ticketApi.bulkUpdate(checkedIds, patch);
      const unchanged = Math.max(0, result.matched - result.updated);
      setNotification({
        type: 'success',
        message: `已更新 ${result.updated} 个工单${unchanged > 0 ? `，${unchanged} 个无变化` : ''}`,
      });
      setCheckedIds([]);
      await fetchTickets({ page: 1 });
      refreshAdminStats();
    } catch (error) {
      const apiError = getApiErrorResponse(error);
      setNotification({ type: 'error', message: apiError?.data?.error || "批量更新失败" });
    } finally {
      setBulkBusy(false);
    }
  };

  // 满意度评价：成功后把服务端返回的最新视图合并回详情；失败保留表单输入。
  const handleCsatSubmit = async (rating: number, comment: string): Promise<boolean> => {
    if (!selectedTicket) return false;
    try {
      const updated = await ticketApi.submitCsat(selectedTicket._id, rating, comment);
      setSelectedTicket(prev => mergeTicketDetail(prev, updated));
      applyTicketUpdate(updated);
      setNotification({ type: 'success', message: '感谢你的评价' });
      refreshAdminStats();
      return true;
    } catch (error) {
      const apiError = getApiErrorResponse(error);
      setNotification({ type: 'error', message: apiError?.data?.error || '评价提交失败，请重试' });
      return false;
    }
  };

  const toggleChecked = useCallback((id: string) => {
    setCheckedIds(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]));
  }, []);

  // 快捷视图：先应用视图 patch，再记录高亮；用户手动改筛选时清空高亮。
  const handleQuickView = useCallback((view: string) => {
    setActiveView(view);
    setAdminFilter(prev => ({ ...prev, ...ticketQuickViewPatch(view) }));
  }, []);

  const handleAdminFilterChange = useCallback((patch: Partial<TicketFilterValue>) => {
    setActiveView('');
    setAdminFilter(prev => ({ ...prev, ...patch }));
  }, []);

  const handleAdminFilterReset = useCallback(() => {
    setActiveView('');
    setAdminFilter({ ...EMPTY_TICKET_FILTER });
  }, []);

  // 用户端筛选：状态/排序即时生效，关键词走 350ms 防抖（见 userSearchInput effect）。
  const handleUserFilterChange = useCallback((patch: Partial<UserTicketFilterValue>) => {
    setUserFilter(prev => ({ ...prev, ...patch }));
    setUserQuery(prev => ({ ...prev, ...patch }));
  }, []);

  const handleUserFilterReset = useCallback(() => {
    setUserSearchInput('');
    setUserFilter({ ...EMPTY_USER_TICKET_FILTER });
    setUserQuery({ ...EMPTY_USER_TICKET_FILTER });
  }, []);

  // 列表内键盘移动：j 下一条 / k 上一条（不在输入框内时生效），手机端 Esc 返回列表。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === 'Escape' && isMobile && showDetailOnMobile) {
        setShowDetailOnMobile(false);
        setIsCreating(false);
        return;
      }
      if (event.key !== 'j' && event.key !== 'k') return;
      if (isTypingTarget(event.target)) return;
      if (tickets.length === 0) return;
      event.preventDefault();
      const currentIndex = tickets.findIndex((ticket) => ticket._id === selectedTicket?._id);
      const delta = event.key === 'j' ? 1 : -1;
      const nextIndex = currentIndex < 0
        ? 0
        : Math.min(tickets.length - 1, Math.max(0, currentIndex + delta));
      const target = tickets[nextIndex];
      if (target && target._id !== selectedTicket?._id) void openTicket(target);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isMobile, openTicket, selectedTicket?._id, showDetailOnMobile, tickets]);

  // 详情头部「上一条 / 下一条」：只在当前已加载的筛选结果内移动，不额外请求列表。
  const selectedIndex = tickets.findIndex((ticket) => ticket._id === selectedTicket?._id);
  const previousTicket = selectedIndex > 0 ? tickets[selectedIndex - 1] : null;
  const nextTicket = selectedIndex >= 0 && selectedIndex < tickets.length - 1 ? tickets[selectedIndex + 1] : null;
  const detailSlaBreached = isDetailSlaBreached(selectedTicket);
  // 管理端筛选是否生效：用于区分「本来就没有工单」与「筛掉了全部」。
  const activeFilterCount = [
    adminFilter.status,
    adminFilter.priority,
    adminFilter.category,
    adminFilter.type,
    adminFilter.service,
    adminFilter.assignee,
    adminFilter.awaitingReply,
    adminFilter.unread,
    adminFilter.csat,
    adminFilter.from,
    adminFilter.to,
    adminFilter.q,
  ].filter(Boolean).length;

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
    const ok = await confirm({
      title: '确认执行该操作？',
      description: '确定关闭这个工单吗？关闭后如需继续咨询请发起新工单。',
      tone: 'danger',
      confirmLabel: '确认',
    });
    if (!ok) return;
    try {
      const updated = await ticketApi.closeTicket(selectedTicket._id);
      setSelectedTicket(prev => mergeTicketDetail(prev, updated));
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
    const header = ['ID', '标题', '用户', '状态', '优先级', '分类', '类型', '相关服务', '受理人', '附件', '消息数', '未读', '待回复', '创建时间', '更新时间'];
    const rows = tickets.map(t => [
      t._id, t.title, t.username, t.status, t.priority, t.category,
      TICKET_TYPE_META[t.type]?.label || t.type,
      ticketServiceLabel(t.relatedService),
      t.assigneeName || '', String(t.attachmentCount ?? 0), String(t.messageCount), t.hasUnread ? '是' : '否',
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
            // 卡片样式（含装饰 blob）由 TicketHero 自己给：展开态是 InfoQueryHero，专注态是紧凑条。
            <motion.div
              key="ticket-hero"
              initial={prefersReducedMotion ? false : { opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.45 }}
              className="relative shrink-0 transition-[padding] duration-200"
            >
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
              activeView={activeView}
              onQuickFilter={(patch, view) => {
                // 概览卡的 patch 本身就是一套完整筛选；带 view 的卡片同时点亮对应的快捷视图。
                setActiveView(view ?? '');
                setAdminFilter(prev => ({ ...prev, ...patch }));
              }}
            />
          </div>
        )}

        {/* 附件上传承诺开关（超管）：默认关闭，普通用户只能用附件链接。 */}
        {canWrite && (!isMobile || !showDetailOnMobile) && (
          <div className="shrink-0">
            <TicketAttachmentSettingsCard onNotify={setNotification} />
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
                      <FiFilter size={14} aria-hidden />
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
                    <button type="button"
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
                          // 新建时清掉上一次未提交的附件：留着会让用户以“已选好”的错觉漏传
                          setPendingAttachments([]);
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
                    onChange={handleAdminFilterChange}
                    onReset={handleAdminFilterReset}
                    onRefresh={() => void fetchTickets({ page: 1 })}
                    onExport={handleExportCsv}
                    loading={loading}
                    total={listMeta.total}
                    shown={tickets.length}
                    activeView={activeView}
                    onQuickView={handleQuickView}
                  />
                )}

                {!isAdmin && (
                  <TicketUserFilters
                    value={userFilter}
                    searchInput={userSearchInput}
                    onSearchChange={setUserSearchInput}
                    onChange={handleUserFilterChange}
                    onReset={handleUserFilterReset}
                    onRefresh={() => void fetchTickets({ page: 1 })}
                    loading={loading}
                    total={listMeta.total}
                    shown={tickets.length}
                  />
                )}

                {/* 只读管理员没有写权限：批量入口整个不渲染（服务端同样会拒绝） */}
                {isAdmin && canWrite && (
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
                      <FiCheckSquare size={11} aria-hidden /> {bulkMode ? '退出批量' : '批量处理'}
                    </button>
                    {bulkMode && (
                      <span className="text-[11px] text-slate-400">勾选工单后使用下方批量动作</span>
                    )}
                  </div>
                )}

                {isAdmin && canWrite && bulkMode && (
                  <TicketBulkBar
                    checkedCount={checkedIds.length}
                    totalShown={tickets.length}
                    busy={bulkBusy}
                    onSelectAll={() => setCheckedIds(tickets.map(t => t._id))}
                    onClearSelection={() => setCheckedIds([])}
                    onExit={() => {
                      setBulkMode(false);
                      setCheckedIds([]);
                    }}
                    onBulk={(patch) => void handleBulk(patch)}
                  />
                )}

                {/* 不加 overscroll-contain：它会把滚轮/触摸手势锁在面板里，
                    面板滚到底后无法继续滚动整页（页脚、顶部说明区就够不着了）。 */}
                <div className="flex-1 hover-scrollbar md:overflow-y-auto">
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
                    <div className="p-10 text-center">
                      <FiInfo className="mx-auto text-slate-200 mb-2" size={32} />
                      {isAdmin && activeFilterCount > 0 ? (
                        <>
                          <p className="text-sm text-slate-500">没有符合当前筛选的工单</p>
                          <button
                            type="button"
                            onClick={handleAdminFilterReset}
                            className={cn(studioGhostButtonClassName, 'mt-3 px-4 py-2 text-xs normal-case tracking-normal')}
                          >
                            清空筛选
                          </button>
                        </>
                      ) : !isAdmin && (userQuery.q || userQuery.status) ? (
                        <>
                          <p className="text-sm text-slate-500">没有符合条件的工单</p>
                          <button
                            type="button"
                            onClick={handleUserFilterReset}
                            className={cn(studioGhostButtonClassName, 'mt-3 px-4 py-2 text-xs normal-case tracking-normal')}
                          >
                            清空筛选
                          </button>
                        </>
                      ) : (
                        <>
                          <p className="text-sm text-slate-500">
                            {isAdmin ? '暂无工单数据' : '你还没有提交过工单'}
                          </p>
                          {!isAdmin && (
                            <button
                              type="button"
                              onClick={() => {
                                setPendingAttachments([]);
                                setIsCreating(true);
                                if (isMobile) setShowDetailOnMobile(true);
                              }}
                              className={cn(studioPrimaryButtonClassName, 'mt-3 px-4 py-2 text-xs')}
                            >
                              发起新工单
                            </button>
                          )}
                        </>
                      )}
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
                    <button type="button"
                      onClick={() => {
                        setShowDetailOnMobile(false);
                        setIsCreating(false);
                      }}
                      className={cn(studioGhostButtonClassName, "shrink-0 py-2")}
                    >
                      <FiChevronRight className="rotate-180" size={16} aria-hidden /> 返回
                    </button>
                    <div className="min-w-0 truncate max-w-[180px] px-2 text-xs font-semibold text-slate-500">
                      {isCreating ? "发起新工单" : selectedTicket?.title}
                    </div>
                  </div>
                )}

                <AnimatePresence mode="wait">
                  {isCreating ? (
                    <motion.div
                      key="create"
                      initial={prefersReducedMotion ? false : { opacity: 0, scale: 0.98 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.98 }}
                      className="p-5 sm:p-8 md:h-full md:overflow-y-auto"
                    >
                      {/* 票据表单（票面字段全量）抽到 ticket/TicketCreateForm：
                          TicketSystem.tsx 贴着体积闸门，表单留在本文件会超预算。 */}
                      <TicketCreateForm
                        value={newTicket}
                        onChange={(patch) => setNewTicket(prev => ({ ...prev, ...patch }))}
                        pendingFiles={pendingAttachments}
                        onPendingFilesChange={setPendingAttachments}
                        linkingCandidates={linkingCandidates}
                        capabilities={capabilities}
                        isMobile={isMobile}
                        isSubmitting={isSubmitting}
                        resetSignal={createResetSignal}
                        overlengthNotice={
                          overLengthDraft?.kind === 'create' ? (
                            <OverLengthMailNotice
                              draft={overLengthDraft}
                              account={user?.id ?? ''}
                              onDismiss={() => setOverLengthDraft(null)}
                            />
                          ) : null
                        }
                        onSubmit={handleCreateTicket}
                        onCancel={() => {
                          setPendingAttachments([]);
                          setIsCreating(false);
                          if (isMobile) setShowDetailOnMobile(false);
                        }}
                        onError={(message) => setNotification({ type: 'error', message })}
                      />
                    </motion.div>
                  ) : selectedTicket ? (
                    <motion.div
                      key="detail"
                      initial={prefersReducedMotion ? false : { opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      className="flex flex-col md:h-full"
                    >
                      {/* Detail header */}
                      <div className="flex flex-col gap-3 border-b border-slate-200/80 bg-slate-50/40 p-4 sm:p-5 sm:flex-row sm:items-center sm:justify-between">
                        <div className="space-y-2 min-w-0">
                          <div className="flex items-center gap-2 sm:gap-3 flex-wrap">
                            <h3 className="min-w-0 truncate font-semibold text-slate-900 text-sm sm:text-base">{selectedTicket.title}</h3>
                            {ticketPriorityBadge(selectedTicket.priority)}
                            {detailSlaBreached ? (
                              <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-rose-200 bg-rose-50 px-2 py-0.5 text-[10px] font-semibold text-rose-700">
                                <FiAlertCircle size={10} aria-hidden /> 逾期未回复
                              </span>
                            ) : null}
                            {typeof selectedTicket.csatRating === 'number' ? (
                              <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[10px] font-semibold text-slate-600">
                                满意度 {selectedTicket.csatRating}/5
                              </span>
                            ) : null}
                          </div>
                          <div className="flex items-center gap-4 text-[10px] sm:text-[11px] text-slate-500 font-mono flex-wrap">
                            <span className="flex min-w-0 items-center gap-1"><FiUser className="text-slate-400" aria-hidden /> {selectedTicket.username}</span>
                            <span className="flex items-center gap-1"><FiClock className="text-slate-400" aria-hidden /> {new Date(selectedTicket.createdAt).toLocaleString()}</span>
                            {selectedTicket.firstResponseAt ? (
                              <span title="首次响应时间">
                                首响 {new Date(selectedTicket.firstResponseAt).toLocaleString()}
                              </span>
                            ) : null}
                          </div>
                        </div>
                        <div className="flex w-full items-center gap-2 overflow-x-auto pb-1 sm:w-auto sm:flex-wrap sm:justify-end sm:overflow-visible sm:pb-0">
                          {/* 上一条 / 下一条：只在当前筛选结果内移动 */}
                          <div className="flex shrink-0 items-center gap-1">
                            <button
                              type="button"
                              onClick={() => previousTicket && void openTicket(previousTicket)}
                              disabled={!previousTicket}
                              aria-label="上一条工单"
                              title="上一条（k）"
                              className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 transition hover:border-slate-300 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-40"
                            >
                              <FiChevronLeft size={14} aria-hidden />
                            </button>
                            <button
                              type="button"
                              onClick={() => nextTicket && void openTicket(nextTicket)}
                              disabled={!nextTicket}
                              aria-label="下一条工单"
                              title="下一条（j）"
                              className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 transition hover:border-slate-300 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-40"
                            >
                              <FiChevronRight size={14} aria-hidden />
                            </button>
                          </div>
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
                              {ticketStatusBadge(selectedTicket.status)}
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
                            <FiLink className="inline" size={11} aria-hidden /> 复制链接
                          </button>
                        </div>
                      </div>

                      {/* 票面字段：类型 / 相关服务 / 联系邮箱 / 关联工单（超管可就地改） */}
                      <TicketDetailMeta
                        ticket={selectedTicket}
                        canEdit={canWrite}
                        onUpdateFields={(fields) => handleUpdateFields(selectedTicket._id, fields)}
                        onOpenTicket={handleOpenTicketById}
                        onError={(message) => setNotification({ type: 'error', message })}
                      />

                      {/* 处理记录：状态/受理人/优先级/分类/满意度变更（默认折叠，客服按需展开） */}
                      <TicketEventTimeline events={selectedTicket.events} />

                      <TicketConversation
                        ticket={selectedTicket}
                        currentUserId={user?.id}
                        isAdmin={isAdmin}
                        canWrite={canWrite}
                        streamingAiResponse={streamingAiResponse}
                        editingIdx={editingIdx}
                        editValue={editValue}
                        isUpdating={isUpdating}
                        onStartEdit={(index, content) => {
                          setEditingIdx(index);
                          setEditValue(content);
                        }}
                        onCancelEdit={() => setEditingIdx(null)}
                        onEditValueChange={setEditValue}
                        onSaveEdit={(index) => void handleAdminEdit(selectedTicket._id, index)}
                        onDeleteMessage={(index) => void handleAdminDelete(selectedTicket._id, index)}
                        onCopyMarkdown={notifyMarkdownCopy}
                      />

                      {/*
                        附件区（链接 + 文件）。
                        链接输入框在「上传开关关闭」时是提交截图的主通道，打开后也保留；
                        文件上传入口仅在 capabilities.canUploadAttachments 为真时渲染（超管或已开启）。
                      */}
                      <div className="shrink-0 space-y-4 border-t border-slate-200/80 bg-slate-50/40 p-4 sm:p-5">
                        <TicketAttachmentLinks
                          links={selectedTicket.attachmentLinks ?? []}
                          canEdit={
                            selectedTicket.status !== 'closed' &&
                            (selectedTicket.userId === user?.id || canWrite)
                          }
                          policyHint={
                            capabilities?.canUploadAttachments ? null : capabilities?.attachmentUploadPolicy ?? null
                          }
                          onError={(message) => setNotification({ type: 'error', message })}
                          onChange={(links) => void handleAttachmentLinksChange(links)}
                        />
                        {/*
                          即使上传开关关闭（capabilities=false），已存在的附件也必须能下载/删除：
                          「关闭上传」只阻止新增，不是把历史附件从界面上藏起来。
                          因此列表在「可上传」或「已有附件」时都渲染，只是隐藏上传入口。
                        */}
                        {(capabilities?.canUploadAttachments || (selectedTicket.attachments?.length ?? 0) > 0) && (
                          <TicketAttachmentList
                            ticketId={selectedTicket._id}
                            attachments={selectedTicket.attachments ?? []}
                            canUpload={
                              Boolean(capabilities?.canUploadAttachments) &&
                              selectedTicket.status !== 'closed' &&
                              (selectedTicket.userId === user?.id || canWrite)
                            }
                            uploadDisabledReason={
                              !capabilities?.canUploadAttachments
                                ? capabilities?.attachmentUploadPolicy ??
                                  '附件上传暂未开放；已存在的附件仍可下载与删除'
                                : selectedTicket.status === 'closed'
                                  ? '此工单已关闭，无法继续添加附件'
                                  : '你不是该工单的属主，无法添加上传附件'
                            }
                            // 删除权限与后端一致：工单属主 / 上传者 / 超管。
                            // 刻意不因工单关闭或上传开关关闭而禁止 —— 删除已有数据属于用户权利。
                            canDelete={(attachment) =>
                              selectedTicket.userId === user?.id ||
                              attachment.uploadedById === user?.id ||
                              canWrite
                            }
                            onUploaded={handleAttachmentUploaded}
                            onDeleted={handleAttachmentDeleted}
                            onError={(message) => setNotification({ type: 'error', message })}
                          />
                        )}
                      </div>

                      {/*
                        满意度：属主在 resolved/closed 后可填写与修改；客服（超管）只读查看
                        用户写了什么（星级 + 补充说明 + 提交时间）。
                        组件自身也会判权限，这里先判一次，避免给无权用户留一条空边框。
                      */}
                      {((!isAdmin &&
                        selectedTicket.userId === user?.id &&
                        (selectedTicket.status === 'resolved' || selectedTicket.status === 'closed')) ||
                        (isAdmin && typeof selectedTicket.csatRating === 'number')) ? (
                        <div className="shrink-0 border-t border-slate-200/80 bg-slate-50/40 px-4 pt-4 sm:px-5">
                          <TicketSatisfactionCard
                            ticket={selectedTicket}
                            currentUserId={user?.id}
                            isAdmin={isAdmin}
                            onSubmit={handleCsatSubmit}
                          />
                        </div>
                      ) : null}

                      {/* Reply form */}
                      {selectedTicket.status === "closed" ? (
                        <div className="border-t border-slate-200/80 bg-slate-50 p-4 sm:p-6 text-center shrink-0">
                          <p className="text-xs sm:text-sm text-slate-500 font-medium flex items-center justify-center gap-2">
                            <FiX className="shrink-0" aria-hidden /> {canWrite
                              ? "此工单已关闭，可通过上方状态下拉重新开启"
                              : "此工单已关闭，如需继续咨询请发起新工单"}
                          </p>
                        </div>
                      ) : isAdmin && !canWrite ? (
                        <div className="border-t border-slate-200/80 bg-slate-50 p-4 sm:p-6 text-center shrink-0">
                          <p className="text-xs sm:text-sm text-slate-500 font-medium flex items-center justify-center gap-2">
                            <FiInfo className="shrink-0" aria-hidden /> 只读管理员无回复权限，处理工单请使用超级管理员账号
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
                      initial={prefersReducedMotion ? false : { opacity: 0 }}
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
