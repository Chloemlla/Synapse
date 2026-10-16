import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  CheckSquare,
  Clipboard,
  Copy,
  Download,
  Eye,
  FileJson,
  KeyRound,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Send,
  Square,
  Trash2,
  Webhook,
  X,
} from 'lucide-react';
import { getApiBaseUrl } from '../api/api';
import { useNotification } from './Notification';
import { useConfirm } from './confirm/ConfirmDialogProvider';
import { useAuth } from '../hooks/useAuth';
import { isSuperAdmin } from '../utils/rbac';

import { getBackendErrorMessage } from '../utils/backendError';
import { buildCsv, csvFileStamp, downloadCsv } from '../utils/csv';
import {
  studioDangerButtonClassName,
  studioFieldClassName,
  studioModalCardClassName,
  studioModalCloseButtonClassName,
  studioModalOverlayClassName,
  studioPillClassName,
  studioPrimaryButtonClassName,
  studioSecondaryButtonClassName,
  studioTextareaClassName,
} from './studioTheme';
import { StudioEmptyState, StudioErrorState, StudioLoadingState, StudioPager } from './studioFeedback';
import { cn } from '../utils/cn';
import {
  STATUS_LABELS,
  STATUS_OPTIONS,
  defaultStats,
  samplePayload,
  statusLabel,
  type ActivePanel,
  type EditMode,
  type GroupRow,
  type WebhookEventItem,
  type WebhookSecretSetting,
  type WebhookStats,
} from './webhook-events/webhookEventsShared';


function apiUrl(path = '') {
  return `${getApiBaseUrl()}/api/webhook-events${path}`;
}

function secretUrl(key?: string) {
  const params = new URLSearchParams();
  if (key) params.set('key', key);
  const query = params.toString();
  return `${getApiBaseUrl()}/api/admin/webhook/secret${query ? `?${query}` : ''}`;
}

function authHeaders(json = false): HeadersInit {
  const headers: Record<string, string> = {};
  if (json) headers['Content-Type'] = 'application/json';
  return headers;
}

function apiFetch(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, { ...init, credentials: 'include' });
}

async function parseApiResponse(res: Response) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) {
    throw new Error(data.error || data.message || `请求失败 (${res.status})`);
  }
  return data;
}

function safeRouteSegment(value: string) {
  return value.trim().replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
}

function buildPublicWebhookPath(kind: 'generic' | 'resend', routeKey: string) {
  const key = safeRouteSegment(routeKey);
  if (kind === 'generic') return key ? `/api/webhooks/generic-${key}` : '/api/webhooks/generic';
  return key && key.toUpperCase() !== 'DEFAULT' ? `/api/webhooks/resend-${key}` : '/api/webhooks/resend';
}

function toAbsoluteUrl(path: string) {
  const base = getApiBaseUrl();
  return new URL(`${base}${path}`, window.location.origin).toString();
}

function formatDate(value?: string | null) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString('zh-CN');
}

function stringifyJson(value: unknown) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

function parseJsonDraft(value: string, fieldLabel: string) {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new Error(`${fieldLabel} 不是有效 JSON`);
  }
}

function statusClass(status?: string) {
  const value = status?.toLowerCase();
  if (value === 'failed' || value === 'error' || value === 'bounced' || value === 'complained') {
    return 'bg-rose-50 text-rose-700 border-rose-200';
  }
  if (value === 'processed' || value === 'delivered') {
    return 'bg-emerald-50 text-emerald-700 border-emerald-200';
  }
  if (value === 'testing' || value === 'replayed') {
    return 'bg-amber-50 text-amber-700 border-amber-200';
  }
  return 'bg-slate-50 text-slate-700 border-slate-200';
}

const WebhookEventsManager: React.FC = () => {
  const { setNotification } = useNotification();
  const confirm = useConfirm();
  const { user } = useAuth();
  const canWrite = isSuperAdmin(user?.role);
  const prefersReducedMotion = useReducedMotion();
  const hoverScale = useCallback(
    (scale: number, enabled = true) => (enabled && !prefersReducedMotion ? { scale } : undefined),
    [prefersReducedMotion],
  );
  const tapScale = useCallback(
    (scale: number, enabled = true) => (enabled && !prefersReducedMotion ? { scale } : undefined),
    [prefersReducedMotion],
  );

  const [items, setItems] = useState<WebhookEventItem[]>([]);
  const [groups, setGroups] = useState<GroupRow[]>([]);
  const [stats, setStats] = useState<WebhookStats>(defaultStats);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  // F4-04：区分「列表加载失败」与「确实没有事件」，失败时给出重试入口
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [activePanel, setActivePanel] = useState<ActivePanel>('usage');

  const [routeKeyFilter, setRouteKeyFilter] = useState<'all' | 'null' | string>('all');
  const [providerFilter, setProviderFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [eventIdFilter, setEventIdFilter] = useState('');
  const [searchFilter, setSearchFilter] = useState('');

  const [endpointRouteKey, setEndpointRouteKey] = useState('');
  const [testSource, setTestSource] = useState('');
  const [testMode, setTestMode] = useState<'public' | 'admin'>('public');
  const [testPayload, setTestPayload] = useState(() => JSON.stringify(samplePayload, null, 2));

  const [secretKeyInput, setSecretKeyInput] = useState('DEFAULT');
  const [secretInput, setSecretInput] = useState('');
  const [secretSetting, setSecretSetting] = useState<WebhookSecretSetting | null>(null);

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const allPageSelected = items.length > 0 && items.every((item) => selectedSet.has(item._id));

  const [selected, setSelected] = useState<WebhookEventItem | null>(null);
  const [editing, setEditing] = useState<WebhookEventItem | null>(null);
  const [editMode, setEditMode] = useState<EditMode>('edit');
  const [dataDraft, setDataDraft] = useState('');
  const [rawDraft, setRawDraft] = useState('');
  const [toDraft, setToDraft] = useState('');

  const totalPages = useMemo(() => Math.max(1, Math.ceil(total / pageSize)), [pageSize, total]);
  const genericPath = buildPublicWebhookPath('generic', endpointRouteKey);
  const resendPath = buildPublicWebhookPath('resend', endpointRouteKey);
  const genericUrl = toAbsoluteUrl(genericPath);
  const resendUrl = toAbsoluteUrl(resendPath);
  const testPath = buildPublicWebhookPath('generic', testSource);

  const fetchStats = useCallback(async () => {
    const data = await parseApiResponse(await apiFetch(apiUrl('/stats'), { headers: authHeaders() }));
    setStats({ ...defaultStats, ...(data.stats || {}) });
  }, []);

  const fetchGroups = useCallback(async () => {
    const data = await parseApiResponse(await apiFetch(apiUrl('/groups'), { headers: authHeaders() }));
    setGroups(data.groups || []);
  }, []);

  const fetchList = useCallback(
    async (
      nextPage = page,
      nextPageSize = pageSize,
      filters?: {
        routeKey?: 'all' | 'null' | string;
        provider?: string;
        type?: string;
        status?: string;
        eventId?: string;
        search?: string;
      },
    ) => {
      try {
        setLoading(true);
        setLoadError(null);
        const routeKey = filters?.routeKey ?? routeKeyFilter;
        const provider = filters?.provider ?? providerFilter;
        const type = filters?.type ?? typeFilter;
        const status = filters?.status ?? statusFilter;
        const eventId = filters?.eventId ?? eventIdFilter;
        const search = filters?.search ?? searchFilter;
        const params = new URLSearchParams({
          page: String(nextPage),
          pageSize: String(nextPageSize),
        });
        if (routeKey !== 'all') params.set('routeKey', routeKey);
        if (provider.trim()) params.set('provider', provider.trim());
        if (type.trim()) params.set('type', type.trim());
        if (status.trim()) params.set('status', status.trim());
        if (eventId.trim()) params.set('eventId', eventId.trim());
        if (search.trim()) params.set('q', search.trim());

        const data = await parseApiResponse(await apiFetch(`${apiUrl()}?${params.toString()}`, { headers: authHeaders() }));
        setItems(data.items || []);
        setTotal(data.total || 0);
        setPage(data.page || nextPage);
        setPageSize(data.pageSize || nextPageSize);
      } catch (error) {
        setNotification({ type: 'error', message: getBackendErrorMessage(error, '获取列表失败') });
        setLoadError(getBackendErrorMessage(error, '获取列表失败，请稍后重试'));
      } finally {
        setLoading(false);
      }
    },
    [eventIdFilter, page, pageSize, providerFilter, routeKeyFilter, searchFilter, setNotification, statusFilter, typeFilter],
  );

  const refreshAll = useCallback(
    async (nextPage = page, nextPageSize = pageSize) => {
      try {
        await Promise.all([fetchGroups(), fetchStats(), fetchList(nextPage, nextPageSize)]);
      } catch (error) {
        setNotification({ type: 'error', message: getBackendErrorMessage(error, '刷新失败') });
      }
    },
    [fetchGroups, fetchList, fetchStats, page, pageSize, setNotification],
  );

  useEffect(() => {
    refreshAll(1, pageSize);
  }, []);

  const notifySuccess = useCallback((message: string) => setNotification({ type: 'success', message }), [setNotification]);

  const copyText = useCallback(
    async (text: string, message = '已复制') => {
      try {
        await navigator.clipboard.writeText(text);
        notifySuccess(message);
      } catch {
        setNotification({ type: 'error', message: '复制失败' });
      }
    },
    [notifySuccess, setNotification],
  );

  const handleFetchSecret = useCallback(async () => {
    try {
      setActionLoading('secret-load');
      const key = secretKeyInput.trim().toUpperCase() || 'DEFAULT';
      const data = await parseApiResponse(await apiFetch(secretUrl(key), { headers: authHeaders() }));
      setSecretSetting({
        key: data.key || key,
        secret: data.secret ?? null,
        updatedAt: data.updatedAt ?? null,
      });
    } catch (error) {
      setNotification({ type: 'error', message: getBackendErrorMessage(error, '获取密钥失败') });
    } finally {
      setActionLoading(null);
    }
  }, [secretKeyInput, setNotification]);

  const handleSaveSecret = useCallback(async () => {
    const key = secretKeyInput.trim().toUpperCase() || 'DEFAULT';
    const secret = secretInput.trim();
    if (!secret) {
      setNotification({ type: 'error', message: '请填写 Webhook 密钥' });
      return;
    }
    try {
      setActionLoading('secret-save');
      await parseApiResponse(
        await apiFetch(secretUrl(), {
          method: 'POST',
          headers: authHeaders(true),
          body: JSON.stringify({ key, secret }),
        }),
      );
      setSecretInput('');
      notifySuccess('密钥已保存');
      await handleFetchSecret();
    } catch (error) {
      setNotification({ type: 'error', message: getBackendErrorMessage(error, '保存密钥失败') });
    } finally {
      setActionLoading(null);
    }
  }, [handleFetchSecret, notifySuccess, secretInput, secretKeyInput, setNotification]);

  const handleDeleteSecret = useCallback(async () => {
    const key = secretKeyInput.trim().toUpperCase() || 'DEFAULT';
    const ok = await confirm({
      title: `删除 Resend Webhook 密钥「${key}」？`,
      description: '删除后该密钥对应的 Webhook 验签会立即失效，需要重新配置才能继续接收回调。',
      tone: 'danger',
      confirmLabel: '删除',
    });
    if (!ok) return;
    try {
      setActionLoading('secret-delete');
      await parseApiResponse(
        await apiFetch(secretUrl(), {
          method: 'DELETE',
          headers: authHeaders(true),
          body: JSON.stringify({ key }),
        }),
      );
      setSecretSetting({ key, secret: null, updatedAt: null });
      notifySuccess('密钥已删除');
    } catch (error) {
      setNotification({ type: 'error', message: getBackendErrorMessage(error, '删除密钥失败') });
    } finally {
      setActionLoading(null);
    }
  }, [notifySuccess, secretKeyInput, setNotification]);

  const handleSendTest = useCallback(async () => {
    let payload: unknown;
    try {
      payload = JSON.parse(testPayload);
    } catch {
      setNotification({ type: 'error', message: '测试 payload 不是有效 JSON' });
      return;
    }

    try {
      setActionLoading('test-send');
      if (testMode === 'public') {
        await parseApiResponse(
          await apiFetch(`${getApiBaseUrl()}${testPath}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          }),
        );
      } else {
        await parseApiResponse(
          await apiFetch(apiUrl('/test'), {
            method: 'POST',
            headers: authHeaders(true),
            body: JSON.stringify({
              source: testSource.trim() || 'generic-test',
              payload,
              status: 'testing',
            }),
          }),
        );
      }
      notifySuccess('测试事件已写入');
      await refreshAll(1, pageSize);
    } catch (error) {
      setNotification({ type: 'error', message: getBackendErrorMessage(error, '测试发送失败') });
    } finally {
      setActionLoading(null);
    }
  }, [notifySuccess, pageSize, refreshAll, setNotification, testMode, testPath, testPayload, testSource]);

  const handleDelete = useCallback(
    async (id: string) => {
      const ok = await confirm({
        title: `删除事件记录 ${id.slice(0, 8)}…？`,
        description: '删除后这条 Webhook 事件不可恢复。',
        tone: 'danger',
        confirmLabel: '删除',
      });
      if (!ok) return;
      try {
        setActionLoading(`delete-${id}`);
        await parseApiResponse(
          await apiFetch(apiUrl(`/${id}`), {
            method: 'DELETE',
            headers: authHeaders(),
          }),
        );
        setSelectedIds((prev) => prev.filter((value) => value !== id));
        notifySuccess('删除成功');
        await refreshAll(page, pageSize);
      } catch (error) {
        setNotification({ type: 'error', message: getBackendErrorMessage(error, '删除失败') });
      } finally {
        setActionLoading(null);
      }
    },
    [notifySuccess, page, pageSize, refreshAll, setNotification],
  );

  const handleReplay = useCallback(
    async (id: string) => {
      const ok = await confirm({
        title: `重放事件 ${id.slice(0, 8)}…？`,
        description: '会按原始 payload 重新投递到下游，可能触发重复的业务副作用。',
        tone: 'danger',
        confirmLabel: '重放',
      });
      if (!ok) return;
      try {
        setActionLoading(`replay-${id}`);
        await parseApiResponse(
          await apiFetch(apiUrl(`/${id}/replay`), {
            method: 'POST',
            headers: authHeaders(true),
            body: JSON.stringify({ status: 'replayed', note: 'admin replay' }),
          }),
        );
        notifySuccess('事件已重放');
        await refreshAll(1, pageSize);
      } catch (error) {
        setNotification({ type: 'error', message: getBackendErrorMessage(error, '重放失败') });
      } finally {
        setActionLoading(null);
      }
    },
    [notifySuccess, pageSize, refreshAll, setNotification],
  );

  const handleStatusChange = useCallback(
    async (id: string, status: string) => {
      try {
        setActionLoading(`status-${id}`);
        const data = await parseApiResponse(
          await apiFetch(apiUrl(`/${id}/status`), {
            method: 'PATCH',
            headers: authHeaders(true),
            body: JSON.stringify({ status }),
          }),
        );
        setItems((prev) => prev.map((item) => (item._id === id ? data.item : item)));
        notifySuccess('状态已更新');
        await fetchStats();
      } catch (error) {
        setNotification({ type: 'error', message: getBackendErrorMessage(error, '更新状态失败') });
      } finally {
        setActionLoading(null);
      }
    },
    [fetchStats, notifySuccess, setNotification],
  );

  const handleBulkStatus = useCallback(
    async (status: string) => {
      if (selectedIds.length === 0) {
        setNotification({ type: 'warning', message: '请选择事件' });
        return;
      }
      try {
        setActionLoading('bulk-status');
        await parseApiResponse(
          await apiFetch(apiUrl('/bulk-status'), {
            method: 'POST',
            headers: authHeaders(true),
            body: JSON.stringify({ ids: selectedIds, status }),
          }),
        );
        notifySuccess('批量状态已更新');
        await refreshAll(page, pageSize);
      } catch (error) {
        setNotification({ type: 'error', message: getBackendErrorMessage(error, '批量更新失败') });
      } finally {
        setActionLoading(null);
      }
    },
    [notifySuccess, page, pageSize, refreshAll, selectedIds, setNotification],
  );

  const handleBulkDelete = useCallback(async () => {
    if (selectedIds.length === 0) {
      setNotification({ type: 'warning', message: '请选择事件' });
      return;
    }
    const ok = await confirm({
      title: `批量删除 ${selectedIds.length} 条事件记录？`,
      description: '选中的 Webhook 事件将被永久删除，此操作不可恢复。',
      tone: 'danger',
      confirmLabel: '删除',
    });
    if (!ok) return;
    try {
      setActionLoading('bulk-delete');
      await parseApiResponse(
        await apiFetch(apiUrl('/bulk-delete'), {
          method: 'POST',
          headers: authHeaders(true),
          body: JSON.stringify({ ids: selectedIds }),
        }),
      );
      setSelectedIds([]);
      notifySuccess('批量删除成功');
      await refreshAll(page, pageSize);
    } catch (error) {
      setNotification({ type: 'error', message: getBackendErrorMessage(error, '批量删除失败') });
    } finally {
      setActionLoading(null);
    }
  }, [notifySuccess, page, pageSize, refreshAll, selectedIds, setNotification]);

  const openCreate = useCallback(() => {
    const item: WebhookEventItem = {
      _id: '',
      provider: 'manual',
      routeKey: null,
      type: 'manual.event',
      status: 'received',
      data: {},
      raw: {},
    };
    setEditMode('create');
    setEditing(item);
    setDataDraft('{}');
    setRawDraft('{}');
    setToDraft('');
  }, []);

  const openEdit = useCallback((item: WebhookEventItem) => {
    setEditMode('edit');
    setEditing(item);
    setDataDraft(stringifyJson(item.data));
    setRawDraft(stringifyJson(item.raw));
    setToDraft(stringifyJson(item.to));
  }, []);

  const closeEdit = useCallback(() => {
    setEditing(null);
    setDataDraft('');
    setRawDraft('');
    setToDraft('');
  }, []);

  const handleSave = useCallback(async () => {
    if (!editing) return;
    try {
      const payload = {
        ...editing,
        data: parseJsonDraft(dataDraft, 'data'),
        raw: parseJsonDraft(rawDraft, 'raw'),
        to: parseJsonDraft(toDraft, 'to'),
      };
      delete (payload as { _id?: string })._id;

      setActionLoading('save-event');
      const res =
        editMode === 'create'
          ? await apiFetch(apiUrl(), {
              method: 'POST',
              headers: authHeaders(true),
              body: JSON.stringify(payload),
            })
          : await apiFetch(apiUrl(`/${editing._id}`), {
              method: 'PUT',
              headers: authHeaders(true),
              body: JSON.stringify(payload),
            });
      await parseApiResponse(res);
      notifySuccess(editMode === 'create' ? '事件已创建' : '事件已保存');
      closeEdit();
      await refreshAll(editMode === 'create' ? 1 : page, pageSize);
    } catch (error) {
      setNotification({ type: 'error', message: getBackendErrorMessage(error, '保存失败') });
    } finally {
      setActionLoading(null);
    }
  }, [closeEdit, dataDraft, editMode, editing, notifySuccess, page, pageSize, rawDraft, refreshAll, setNotification, toDraft]);

  const togglePageSelection = useCallback(() => {
    if (allPageSelected) {
      const pageIds = new Set(items.map((item) => item._id));
      setSelectedIds((prev) => prev.filter((id) => !pageIds.has(id)));
      return;
    }
    setSelectedIds((prev) => Array.from(new Set([...prev, ...items.map((item) => item._id)])));
  }, [allPageSelected, items]);

  const toggleOne = useCallback((id: string) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((value) => value !== id) : [...prev, id]));
  }, []);

  const exportEvents = useCallback(
    (format: 'json' | 'csv') => {
      if (items.length === 0) {
        setNotification({ type: 'warning', message: '当前列表没有可导出的事件' });
        return;
      }
      const timestamp = csvFileStamp();
      if (format === 'json') {
        const blob = new Blob([JSON.stringify(items, null, 2)], { type: 'application/json;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `webhook-events-${timestamp}.json`;
        link.click();
        URL.revokeObjectURL(url);
        return;
      }

      // 事件字段完全由外部投递方控制：走共用 csvCell 做公式注入中和（原来裸拼字符串，
      // 管理员在 Excel 里打开就会求值），行分隔用 CRLF，落盘带 BOM 让中文不乱码。
      const csv = buildCsv(
        ['id', 'provider', 'routeKey', 'eventId', 'type', 'status', 'subject', 'receivedAt'],
        items.map((item) => [
          item._id,
          item.provider || '',
          item.routeKey || '',
          item.eventId || '',
          item.type || '',
          item.status || '',
          item.subject || item.title || '',
          item.receivedAt || item.created_at || '',
        ]),
      );
      downloadCsv(`webhook-events-${timestamp}.csv`, csv);
    },
    [items, setNotification],
  );

  const renderPanel = () => {
    if (activePanel === 'test') {
      return (
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="rounded-2xl border border-slate-200 bg-white/90 p-4 shadow-sm">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">来源 routeKey</label>
              <input
                value={testSource}
                onChange={(event) => setTestSource(event.target.value)}
                placeholder="github"
                className={studioFieldClassName}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">写入方式</label>
              <div className="grid grid-cols-2 gap-2">
                <button type="button"
                  onClick={() => setTestMode('public')}
                  className={studioPillClassName(testMode === 'public')}>
                  公开端点
                </button>
                <button type="button"
                  onClick={() => setTestMode('admin')}
                  className={studioPillClassName(testMode === 'admin')}>
                  管理接口
                </button>
              </div>
            </div>
            <div className="flex items-end">
              <motion.button type="button"
                onClick={handleSendTest}
                disabled={actionLoading === 'test-send'}
                className={`${studioPrimaryButtonClassName} w-full`}
                whileHover={hoverScale(1.02)}
                whileTap={tapScale(0.98)}>
                <Send className="w-4 h-4" /> {actionLoading === 'test-send' ? '发送中' : '发送测试'}
              </motion.button>
            </div>
          </div>
          <div className="mt-3">
            <div className="flex items-center justify-between mb-1 gap-2">
              <label className="text-xs font-medium text-slate-600">Payload JSON</label>
              <button type="button"
                onClick={() => setTestPayload(JSON.stringify(samplePayload, null, 2))}
                className="rounded-2xl border border-slate-200 px-2.5 py-1 text-xs text-slate-600 transition hover:bg-slate-50">
                重置样例
              </button>
            </div>
            <textarea
              value={testPayload}
              onChange={(event) => setTestPayload(event.target.value)}
              spellCheck={false}
              className={`${studioTextareaClassName} min-h-56 font-mono text-xs`}
            />
          </div>
          <div className="mt-3 text-xs text-slate-500 break-all">POST {toAbsoluteUrl(testPath)}</div>
        </motion.div>
      );
    }

    if (activePanel === 'secrets') {
      return (
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="rounded-2xl border border-slate-200 bg-white/90 p-4 shadow-sm">
          <div className="grid grid-cols-1 lg:grid-cols-4 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Resend key</label>
              <input
                value={secretKeyInput}
                onChange={(event) => setSecretKeyInput(event.target.value.toUpperCase())}
                placeholder="DEFAULT"
                className={studioFieldClassName}
              />
            </div>
            <div className="lg:col-span-2">
              <label className="block text-xs font-medium text-slate-600 mb-1">Secret</label>
              <input
                value={secretInput}
                onChange={(event) => setSecretInput(event.target.value)}
                type="password"
                placeholder="whsec_xxx 或 Base64"
                className={studioFieldClassName}
              />
            </div>
            <div className="grid grid-cols-3 gap-2 lg:flex lg:items-end">
              <button type="button"
                onClick={handleFetchSecret}
                disabled={actionLoading === 'secret-load'}
                className={studioSecondaryButtonClassName}>
                <RefreshCw className="w-4 h-4" /> 读取
              </button>
              {canWrite && (
              <button type="button"
                onClick={handleSaveSecret}
                disabled={actionLoading === 'secret-save'}
                className={studioPrimaryButtonClassName}>
                <Save className="w-4 h-4" /> 保存
              </button>
              )}
              {canWrite && (
              <button type="button"
                onClick={handleDeleteSecret}
                disabled={actionLoading === 'secret-delete'}
                className={studioDangerButtonClassName}>
                <Trash2 className="w-4 h-4" /> 删除
              </button>
              )}
            </div>
          </div>
          <div className="mt-3 grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
              <div className="text-xs text-slate-500">当前 key</div>
              <div className="font-mono text-slate-900 break-all">{secretSetting?.key || '-'}</div>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
              <div className="text-xs text-slate-500">密钥状态</div>
              <div className="font-mono text-slate-900 break-all">{secretSetting?.secret ?? '未读取'}</div>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
              <div className="text-xs text-slate-500">更新时间</div>
              <div className="text-slate-900">{formatDate(secretSetting?.updatedAt)}</div>
            </div>
          </div>
        </motion.div>
      );
    }

    const curlPayload = JSON.stringify(samplePayload);
    const genericCurl = `curl -X POST "${genericUrl}" -H "Content-Type: application/json" -d '${curlPayload}'`;
    const resendCurl = `curl -X POST "${resendUrl}" -H "Content-Type: application/json" -H "svix-id: msg_xxx" -H "svix-timestamp: 1700000000" -H "svix-signature: v1,xxx" -d '{"type":"email.delivered","data":{"id":"email_xxx"}}'`;

    return (
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="rounded-2xl border border-slate-200 bg-white/90 p-4 shadow-sm">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">routeKey</label>
            <input
              value={endpointRouteKey}
              onChange={(event) => setEndpointRouteKey(event.target.value)}
              placeholder="留空使用默认路由"
              className={studioFieldClassName}
            />
          </div>
          <EndpointBox label="Generic" value={genericUrl} onCopy={() => copyText(genericUrl, 'Generic URL 已复制')} />
          <EndpointBox label="Resend" value={resendUrl} onCopy={() => copyText(resendUrl, 'Resend URL 已复制')} />
        </div>
        <div className="mt-3 grid grid-cols-1 lg:grid-cols-2 gap-3">
          <CodeBlock title="Generic curl" value={genericCurl} onCopy={() => copyText(genericCurl, 'Generic curl 已复制')} />
          <CodeBlock title="Resend curl" value={resendCurl} onCopy={() => copyText(resendCurl, 'Resend curl 已复制')} />
        </div>
      </motion.div>
    );
  };

  return (
    <div className="max-w-7xl mx-auto px-2 sm:px-4 space-y-5">
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-slate-900 text-white rounded-2xl shadow-xl border border-slate-200 p-4 sm:p-6"
      >
        <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-white/10">
              <Webhook className="w-5 h-5" />
            </div>
            <div>
              <div className="text-lg font-semibold">Webhook 事件管理</div>
              <div className="text-slate-300 text-sm">接收端点、Resend 密钥、测试投递与事件处理</div>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2 sm:flex sm:flex-wrap">
            <HeaderStat label="总数" value={stats.total} />
            <HeaderStat label="24h" value={stats.last24h} />
            <HeaderStat label="异常" value={stats.failed} tone="warning" />
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 lg:grid-cols-4 gap-2">
          {(stats.byStatus.length ? stats.byStatus.slice(0, 4) : [{ key: 'received', total: 0 }]).map((row) => (
            <div key={String(row.key)} className="min-w-0 rounded-2xl border border-white/10 bg-white/10 px-3 py-2">
              <div className="text-xs text-slate-300 truncate">{row.key || '未设置状态'}</div>
              <div className="text-base font-semibold">{row.total}</div>
            </div>
          ))}
        </div>
      </motion.div>

      {!canWrite ? (
        <div className="rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          当前账号是只读管理员：测试投递、批量改状态、事件清理等写操作需要超级管理员权限，相关入口已隐藏或禁用。
        </div>
      ) : null}

      <div className="bg-white/80 backdrop-blur-sm border border-slate-200 rounded-2xl p-3 shadow-sm">
        <div className="flex flex-col xl:flex-row gap-3 xl:items-center xl:justify-between">
          <div className="grid grid-cols-3 gap-2">
            <PanelButton icon={<Clipboard className="w-4 h-4" />} active={activePanel === 'usage'} onClick={() => setActivePanel('usage')}>
              使用
            </PanelButton>
            {canWrite && (
            <PanelButton icon={<Play className="w-4 h-4" />} active={activePanel === 'test'} onClick={() => setActivePanel('test')}>
              测试
            </PanelButton>
            )}
            <PanelButton icon={<KeyRound className="w-4 h-4" />} active={activePanel === 'secrets'} onClick={() => setActivePanel('secrets')}>
              密钥
            </PanelButton>
          </div>
          <div className="flex flex-wrap gap-2">
            <motion.button type="button"
              onClick={() => refreshAll(page, pageSize)}
              disabled={loading}
              className={studioSecondaryButtonClassName}
              whileHover={hoverScale(1.02)}
              whileTap={tapScale(0.98)}>
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> 刷新
            </motion.button>
            {canWrite && (
            <motion.button type="button"
              onClick={openCreate}
              className={studioPrimaryButtonClassName}
              whileHover={hoverScale(1.02)}
              whileTap={tapScale(0.98)}>
              <Plus className="w-4 h-4" /> 新增
            </motion.button>
            )}
          </div>
        </div>
        <div className="mt-3">{renderPanel()}</div>
      </div>

      <div className="bg-white/80 backdrop-blur-sm border border-slate-200 rounded-2xl p-3 shadow-sm">
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-6 gap-3">
          <div>
            <label className="block text-xs text-slate-500 mb-1">routeKey</label>
            <select
              value={routeKeyFilter}
              onChange={(event) => setRouteKeyFilter(event.target.value)}
              className={studioFieldClassName}
            >
              <option value="all">全部</option>
              <option value="null">未分组</option>
              {groups.map((group) => (
                <option key={String(group.routeKey ?? group.key ?? 'null')} value={String(group.routeKey ?? group.key ?? 'null')}>
                  {String(group.routeKey ?? group.key ?? '未分组')} ({group.total})
                </option>
              ))}
            </select>
          </div>
          <FilterInput label="provider" value={providerFilter} onChange={setProviderFilter} placeholder="resend" />
          <FilterInput label="type" value={typeFilter} onChange={setTypeFilter} placeholder="email.delivered" />
          <FilterInput label="status" value={statusFilter} onChange={setStatusFilter} placeholder="processed" />
          <FilterInput label="eventId" value={eventIdFilter} onChange={setEventIdFilter} placeholder="evt_xxx" />
          <FilterInput label="搜索" value={searchFilter} onChange={setSearchFilter} placeholder="标题/主题" />
        </div>
        <div className="mt-3 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-2">
          <div className="flex flex-wrap gap-2">
            <motion.button type="button"
              onClick={() => fetchList(1, pageSize)}
              className={studioPrimaryButtonClassName}
              whileHover={hoverScale(1.02)}
              whileTap={tapScale(0.98)}>
              <Search className="w-4 h-4" /> 应用筛选
            </motion.button>
            <button type="button"
              onClick={() => {
                setRouteKeyFilter('all');
                setProviderFilter('');
                setTypeFilter('');
                setStatusFilter('');
                setEventIdFilter('');
                setSearchFilter('');
                void fetchList(1, pageSize, {
                  routeKey: 'all',
                  provider: '',
                  type: '',
                  status: '',
                  eventId: '',
                  search: '',
                });
              }}
              className={studioSecondaryButtonClassName}>
              清空
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => exportEvents('json')} className={studioSecondaryButtonClassName}>
              <FileJson className="w-4 h-4" /> JSON
            </button>
            <button type="button" onClick={() => exportEvents('csv')} className={studioSecondaryButtonClassName}>
              <Download className="w-4 h-4" /> CSV
            </button>
          </div>
        </div>
      </div>

      <div className="bg-white/80 backdrop-blur-sm border border-slate-200 rounded-2xl shadow-xl overflow-hidden">
        <div className="p-3 border-b border-slate-200 flex flex-col xl:flex-row xl:items-center xl:justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2 text-sm text-slate-600">
            {canWrite && (
            <button type="button" onClick={togglePageSelection} className={studioSecondaryButtonClassName}>
              {allPageSelected ? <CheckSquare className="w-4 h-4" /> : <Square className="w-4 h-4" />} 当前页
            </button>
            )}
            <span>已选 {selectedIds.length} 条</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {canWrite && (
            <select
              onChange={(event) => {
                if (event.target.value) void handleBulkStatus(event.target.value);
                event.target.value = '';
              }}
              disabled={selectedIds.length === 0 || actionLoading === 'bulk-status'}
              className={studioFieldClassName}
              defaultValue=""
            >
              <option value="" disabled>批量状态</option>
              {STATUS_OPTIONS.map((status) => (
                <option key={status} value={status}>{statusLabel(status)}</option>
              ))}
            </select>
            )}
            {canWrite && (
            <button type="button"
              onClick={handleBulkDelete}
              disabled={selectedIds.length === 0 || actionLoading === 'bulk-delete'}
              className={studioDangerButtonClassName}>
              <Trash2 className="w-4 h-4" /> 批量删除
            </button>
            )}
            <select
              value={pageSize}
              onChange={(event) => fetchList(1, Number(event.target.value))}
              className={studioFieldClassName}
            >
              {[10, 20, 50, 100].map((size) => (
                <option key={size} value={size}>{size}/页</option>
              ))}
            </select>
          </div>
        </div>

        <div className="block lg:hidden divide-y divide-slate-200">
          {!loading && loadError && (
            <div className="p-4">
              <StudioErrorState message={loadError} onRetry={() => fetchList(page, pageSize)} />
            </div>
          )}
          {items.map((item) => (
            <EventCard
              key={item._id}
              item={item}
              checked={selectedSet.has(item._id)}
              onCheck={() => toggleOne(item._id)}
              onDetail={() => setSelected(item)}
              onEdit={() => openEdit(item)}
              onReplay={() => handleReplay(item._id)}
              onDelete={() => handleDelete(item._id)}
              onStatusChange={(status) => handleStatusChange(item._id, status)}
              actionLoading={actionLoading}
              canWrite={canWrite}
            />
          ))}
          {!loading && !loadError && items.length === 0 && (
            <div className="p-4">
              <StudioEmptyState
                message="还没有收到任何 Webhook 事件。"
                action={<button type="button" onClick={() => fetchList(1, pageSize)} className={studioSecondaryButtonClassName}>刷新列表</button>}
              />
            </div>
          )}
        </div>

        <div className="hidden lg:block overflow-x-auto">
          <table className="min-w-full text-sm table-fixed">
            <thead className="bg-slate-50">
              <tr className="text-left text-slate-900">
                <th className="p-3 w-12"></th>
                <th className="p-3 w-32">来源</th>
                <th className="p-3 w-40">类型</th>
                <th className="p-3 w-44">事件 ID</th>
                <th className="p-3 w-64">摘要</th>
                <th className="p-3 w-40">状态</th>
                <th className="p-3 w-44">时间</th>
                <th className="p-3 w-64">操作</th>
              </tr>
            </thead>
            <tbody>
              {!loading && loadError && (
                <tr>
                  <td className="p-4" colSpan={8}>
                    <StudioErrorState message={loadError} onRetry={() => fetchList(page, pageSize)} />
                  </td>
                </tr>
              )}
              {items.map((item) => (
                <tr key={item._id} className="border-t border-slate-200 hover:bg-slate-50">
                  <td className="p-3">
                    {canWrite && (
                    <button type="button" onClick={() => toggleOne(item._id)} className="text-slate-600 hover:text-slate-900" aria-label="选择事件">
                      {selectedSet.has(item._id) ? <CheckSquare className="w-4 h-4" /> : <Square className="w-4 h-4" />}
                    </button>
                    )}
                  </td>
                  <td className="p-3 text-slate-900">
                    <div className="font-medium truncate">{item.provider || '-'}</div>
                    <div className="text-xs text-slate-500 truncate">{item.routeKey || '默认'}</div>
                  </td>
                  <td className="p-3 text-slate-900 truncate" title={item.type}>{item.type || '-'}</td>
                  <td className="p-3 text-slate-600 font-mono truncate" title={item.eventId || ''}>{item.eventId || '-'}</td>
                  <td className="p-3 text-slate-900">
                    <div className="truncate">{item.title || item.subject || '-'}</div>
                    <div className="text-xs text-slate-500 truncate">{item.renderedContent || stringifyJson(item.to) || ''}</div>
                  </td>
                  <td className="p-3">
                    {canWrite ? (
                    <select
                      value={item.status || ''}
                      onChange={(event) => handleStatusChange(item._id, event.target.value)}
                      className={`w-full rounded-full border px-2 py-1 text-xs ${statusClass(item.status)}`}
                    >
                      <option value="">未设置</option>
                      {STATUS_OPTIONS.map((status) => (
                        <option key={status} value={status}>{statusLabel(status)}</option>
                      ))}
                      {item.status && !STATUS_OPTIONS.includes(item.status) && <option value={item.status}>{item.status}</option>}
                    </select>
                    ) : (
                      <span className={`inline-flex rounded-full border px-2 py-1 text-xs ${statusClass(item.status)}`}>{statusLabel(item.status) || '-'}</span>
                    )}
                  </td>
                  <td className="p-3 text-slate-600 whitespace-nowrap">{formatDate(item.receivedAt)}</td>
                  <td className="p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <IconButton title="详情" onClick={() => setSelected(item)}><Eye className="w-4 h-4" /></IconButton>
                      {canWrite && (<IconButton title="编辑" onClick={() => openEdit(item)} tone="warning"><Pencil className="w-4 h-4" /></IconButton>)}
                      {canWrite && (<IconButton title="重放" onClick={() => handleReplay(item._id)}><RotateCcw className="w-4 h-4" /></IconButton>)}
                      {canWrite && (<IconButton title="删除" onClick={() => handleDelete(item._id)} tone="danger"><Trash2 className="w-4 h-4" /></IconButton>)}
                    </div>
                  </td>
                </tr>
              ))}
              {!loading && !loadError && items.length === 0 && (
                <tr>
                  <td className="p-4" colSpan={8}>
                    <StudioEmptyState
                      message="还没有收到任何 Webhook 事件。"
                      action={<button type="button" onClick={() => fetchList(1, pageSize)} className={studioSecondaryButtonClassName}>刷新列表</button>}
                    />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {loading && <StudioLoadingState minHeightClassName="min-h-[160px]" />}
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white/80 p-3 text-sm text-slate-600 backdrop-blur-sm">
        共 {total} 条，第 {page}/{totalPages} 页
        <StudioPager
          page={page}
          pageSize={pageSize}
          total={total}
          loading={loading}
          onPageChange={(next) => fetchList(next, pageSize)}
        />
      </div>

      {ReactDOM.createPortal(
        <AnimatePresence>
          {selected && (
            <Modal onClose={() => setSelected(null)} title="事件详情">
              <div className="space-y-3">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
                  <SummaryField label="来源" value={`${selected.provider || '-'} / ${selected.routeKey || '默认'}`} />
                  <SummaryField label="类型" value={selected.type || '-'} />
                  <SummaryField label="状态" value={selected.status || '-'} />
                </div>
                {(selected.title || selected.renderedContent) && (
                  <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
                    <div className="font-semibold text-slate-900">{selected.title || selected.subject || '摘要'}</div>
                    {selected.renderedContent && <div className="mt-1 text-sm text-slate-600 whitespace-pre-wrap">{selected.renderedContent}</div>}
                  </div>
                )}
                <div className="flex flex-wrap gap-2">
                  <button type="button" onClick={() => copyText(JSON.stringify(selected, null, 2), '事件 JSON 已复制')} className={studioSecondaryButtonClassName}>
                    <Copy className="w-4 h-4" /> 复制 JSON
                  </button>
                  {canWrite && (
                  <button type="button" onClick={() => handleReplay(selected._id)} className={studioSecondaryButtonClassName}>
                    <RotateCcw className="w-4 h-4" /> 重放
                  </button>
                  )}
                </div>
                <pre className="max-h-[50vh] overflow-auto rounded-2xl border border-slate-200 bg-white p-3 text-xs text-slate-800">{JSON.stringify(selected, null, 2)}</pre>
              </div>
            </Modal>
          )}
        </AnimatePresence>,
        document.body,
      )}

      {ReactDOM.createPortal(
        <AnimatePresence>
          {editing && (
            <Modal onClose={closeEdit} title={editMode === 'create' ? '新增事件' : '编辑事件'} width="max-w-3xl">
              <div className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <EditInput label="provider" value={editing.provider || ''} onChange={(value) => setEditing({ ...editing, provider: value })} />
                  <EditInput label="routeKey" value={editing.routeKey || ''} onChange={(value) => setEditing({ ...editing, routeKey: value || null })} />
                  <EditInput label="type" value={editing.type || ''} onChange={(value) => setEditing({ ...editing, type: value })} />
                  <EditInput label="eventId" value={editing.eventId || ''} onChange={(value) => setEditing({ ...editing, eventId: value })} />
                  <EditInput label="status" value={editing.status || ''} onChange={(value) => setEditing({ ...editing, status: value })} />
                  <EditInput label="subject" value={editing.subject || ''} onChange={(value) => setEditing({ ...editing, subject: value })} />
                  <div className="md:col-span-2">
                    <EditInput label="title" value={editing.title || ''} onChange={(value) => setEditing({ ...editing, title: value })} />
                  </div>
                  <div className="md:col-span-2">
                    <label className="block text-sm text-slate-600 mb-1">content</label>
                    <textarea
                      value={editing.content || ''}
                      onChange={(event) => setEditing({ ...editing, content: event.target.value })}
                      className={`${studioTextareaClassName} h-20`}
                    />
                  </div>
                  <JsonDraft label="to" value={toDraft} onChange={setToDraft} height="h-20" />
                  <JsonDraft label="data" value={dataDraft} onChange={setDataDraft} />
                  <JsonDraft label="raw" value={rawDraft} onChange={setRawDraft} />
                </div>
                <div className="flex justify-end gap-2 pt-3 border-t border-slate-200">
                  <button type="button" onClick={closeEdit} className={studioSecondaryButtonClassName}>
                    取消
                  </button>
                  {canWrite && (
                  <button type="button"
                    onClick={handleSave}
                    disabled={actionLoading === 'save-event'}
                    className={studioPrimaryButtonClassName}>
                    <Save className="w-4 h-4" /> {actionLoading === 'save-event' ? '保存中' : '保存'}
                  </button>
                  )}
                </div>
              </div>
            </Modal>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </div>
  );
};

function HeaderStat({ label, value, tone }: { label: string; value: number; tone?: 'warning' }) {
  return (
    <div className={`rounded-2xl border px-3 py-2 ${tone === 'warning' ? 'bg-rose-500/15 border-rose-300/20' : 'bg-white/10 border-white/10'}`}>
      <div className="text-xs text-slate-300">{label}</div>
      <div className="text-lg font-semibold">{value}</div>
    </div>
  );
}

function PanelButton({ active, icon, children, onClick }: { active: boolean; icon: React.ReactNode; children: React.ReactNode; onClick: () => void }) {
  return (
    <button type="button"
      onClick={onClick}
      className={studioPillClassName(active)}>
      {icon}
      {children}
    </button>
  );
}

function EndpointBox({ label, value, onCopy }: { label: string; value: string; onCopy: () => void }) {
  return (
    <div className="min-w-0 rounded-2xl border border-slate-200 bg-slate-50 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs font-semibold text-slate-600">{label}</div>
        <button type="button" onClick={onCopy} className="rounded-full p-1.5 text-slate-500 transition hover:bg-slate-100 hover:text-slate-700" title={`复制 ${label}`}>
          <Copy className="w-4 h-4" />
        </button>
      </div>
      <div className="mt-1 text-xs font-mono text-slate-900 break-all">{value}</div>
    </div>
  );
}

function CodeBlock({ title, value, onCopy }: { title: string; value: string; onCopy: () => void }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-200">
        <div className="text-xs text-slate-500">{title}</div>
        <button type="button" onClick={onCopy} className="rounded-full p-1.5 text-slate-500 transition hover:bg-slate-100" title="复制">
          <Copy className="w-4 h-4" />
        </button>
      </div>
      <pre className="p-3 overflow-auto text-xs text-slate-800 whitespace-pre-wrap break-all">{value}</pre>
    </div>
  );
}

function FilterInput({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (value: string) => void; placeholder: string }) {
  return (
    <div>
      <label className="block text-xs text-slate-500 mb-1">{label}</label>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className={studioFieldClassName}
      />
    </div>
  );
}

function IconButton({ children, title, onClick, tone }: { children: React.ReactNode; title: string; onClick: () => void; tone?: 'warning' | 'danger' }) {
  const toneClass =
    tone === 'danger'
      ? 'bg-rose-50 text-rose-700 border-rose-200 hover:bg-rose-100'
      : tone === 'warning'
        ? 'bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100'
        : 'bg-slate-100 text-sky-700 border-slate-200 hover:bg-slate-200';
  return (
    <button type="button" onClick={onClick} title={title} className={`min-h-11 rounded-2xl border p-2 ${toneClass}`}>
      {children}
    </button>
  );
}

function EventCard({
  item,
  checked,
  onCheck,
  onDetail,
  onEdit,
  onReplay,
  onDelete,
  onStatusChange,
  canWrite,
}: {
  item: WebhookEventItem;
  checked: boolean;
  actionLoading: string | null;
  onCheck: () => void;
  onDetail: () => void;
  onEdit: () => void;
  onReplay: () => void;
  onDelete: () => void;
  onStatusChange: (status: string) => void;
  canWrite: boolean;
}) {
  return (
    <div className="p-4">
      <div className="flex items-start gap-3">
        {canWrite && (
        <button type="button" onClick={onCheck} className="mt-1 min-h-11 text-slate-600" aria-label="选择事件">
          {checked ? <CheckSquare className="w-4 h-4" /> : <Square className="w-4 h-4" />}
        </button>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-sky-100 text-sky-700">{item.type || '未分类'}</span>
            <span className={`inline-flex items-center px-2 py-0.5 rounded-full border text-[11px] font-medium ${statusClass(item.status)}`}>{item.status || '未设置'}</span>
            {item.eventId && <span className="inline-flex max-w-full items-center truncate rounded-full bg-slate-50 px-2 py-0.5 font-mono text-[11px] text-slate-600">#{item.eventId}</span>}
          </div>
          <div className="mt-1 text-xs text-slate-500">
            {item.provider || '-'} / {item.routeKey || '默认'} / {formatDate(item.receivedAt)}
          </div>
          <div className="mt-2 text-sm font-medium text-slate-900 truncate">{item.title || item.subject || '-'}</div>
          {item.renderedContent && <div className="mt-1 text-xs text-slate-600 line-clamp-2 whitespace-pre-wrap">{item.renderedContent}</div>}
        </div>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        {canWrite ? (
        <select value={item.status || ''} onChange={(event) => onStatusChange(event.target.value)} className={`rounded-full border px-2 py-2 text-xs ${statusClass(item.status)}`}>
          <option value="">未设置</option>
          {STATUS_OPTIONS.map((status) => (
            <option key={status} value={status}>{statusLabel(status)}</option>
          ))}
          {item.status && !STATUS_OPTIONS.includes(item.status) && <option value={item.status}>{item.status}</option>}
        </select>
        ) : (
          <span className={`inline-flex items-center rounded-full border px-2 py-2 text-xs ${statusClass(item.status)}`}>{statusLabel(item.status) || '-'}</span>
        )}
        <div className="grid grid-cols-4 gap-2">
          <IconButton title="详情" onClick={onDetail}><Eye className="w-4 h-4" /></IconButton>
          {canWrite && (<IconButton title="编辑" onClick={onEdit} tone="warning"><Pencil className="w-4 h-4" /></IconButton>)}
          {canWrite && (<IconButton title="重放" onClick={onReplay}><RotateCcw className="w-4 h-4" /></IconButton>)}
          {canWrite && (<IconButton title="删除" onClick={onDelete} tone="danger"><Trash2 className="w-4 h-4" /></IconButton>)}
        </div>
      </div>
    </div>
  );
}

function Modal({ title, onClose, children, width = 'max-w-4xl' }: { title: string; onClose: () => void; children: React.ReactNode; width?: string }) {
  const titleId = useId();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previouslyFocusedRef.current = (document.activeElement as HTMLElement | null) ?? null;
    containerRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      previouslyFocusedRef.current?.focus?.();
    };
  }, [onClose]);

  return (
    <motion.div className={studioModalOverlayClassName} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <motion.div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cn(studioModalCardClassName, width, 'flex max-h-[90vh] w-[95vw] flex-col outline-none')}
        initial={{ scale: 0.96, y: 10, opacity: 0 }}
        animate={{ scale: 1, y: 0, opacity: 1 }}
        exit={{ scale: 0.96, y: 10, opacity: 0 }}
      >
        <div className="flex items-center justify-between gap-3 mb-3 flex-shrink-0">
          <div id={titleId} className="font-semibold text-slate-900">{title}</div>
          <button type="button" onClick={onClose} className={studioModalCloseButtonClassName} title="关闭">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 overflow-auto min-h-0">{children}</div>
      </motion.div>
    </motion.div>
  );
}

function SummaryField({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="text-slate-900 break-all">{value}</div>
    </div>
  );
}

function EditInput({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <div>
      <label className="block text-sm text-slate-600 mb-1">{label}</label>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={studioFieldClassName}
      />
    </div>
  );
}

function JsonDraft({ label, value, onChange, height = 'h-32' }: { label: string; value: string; onChange: (value: string) => void; height?: string }) {
  return (
    <div className="md:col-span-2">
      <label className="block text-sm text-slate-600 mb-1">{label}</label>
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        spellCheck={false}
        className={`${studioTextareaClassName} ${height} font-mono text-xs`}
      />
    </div>
  );
}

export default WebhookEventsManager;
