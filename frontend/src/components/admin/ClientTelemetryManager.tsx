import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  FaBug,
  FaCheckCircle,
  FaChevronDown,
  FaCopy,
  FaExclamationTriangle,
  FaHistory,
  FaSearch,
  FaSyncAlt,
} from 'react-icons/fa';
import { api } from '@/api/api';
import { useAuth } from '@/hooks/useAuth';
import { isSuperAdmin } from '@/utils/rbac';
import { useNotification } from '@/components/Notification';
import {
  InfoBadge,
  InfoMetricCard,
  InfoPanel,
  InfoQueryHero,
  InfoQueryShell,
  studioFieldClassName,
  studioPrimaryButtonClassName,
  studioSecondaryButtonClassName,
} from '@/components/studioTheme';
import { StudioEmptyState, StudioErrorNote, StudioLoadingState } from '@/components/studioFeedback';

/**
 * 客户端遥测（/admin/client-errors）。
 *
 * 用户把首访验证页上的「问题追踪码」报给管理员后，这里就是复盘入口：
 *  1. 用追踪码查「同一次请求」的验证链路与浏览器报错；
 *  2. 按类型/级别/关键字浏览最近的错误；
 *  3. 两串数据用同一个 requestId 串起来，可与操作审计对照。
 *
 * 界面只呈现「发生了什么」，不展示内部实现；原始上下文收在「详情」折叠区。
 */

type TelemetryKind =
  | 'console'
  | 'window-error'
  | 'unhandled-rejection'
  | 'resource'
  | 'security-policy'
  | 'network'
  | 'verification'
  | 'performance'
  | 'navigation'
  | 'lifecycle'
  | 'manual';

interface TelemetryItem {
  _id: string;
  kind: TelemetryKind;
  level: 'error' | 'warn' | 'info' | 'debug';
  source: string;
  message: string;
  stack: string;
  path: string;
  traceId: string;
  providerTraceId: string;
  outcome: string;
  context: Record<string, unknown>;
  appVersion: string;
  buildSha: string;
  userAgent: string;
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
  receivedAt: string;
}

interface TelemetryStats {
  windowHours: number;
  total: number;
  byKind: Record<string, number>;
  byLevel: Record<string, number>;
  topPaths: Array<{ path: string; count: number }>;
}

interface TraceReplay {
  traceId: string;
  found: boolean;
  verification: TelemetryItem[];
  browser: TelemetryItem[];
  providerTraceIds: string[];
}

const KIND_LABELS: Record<TelemetryKind, string> = {
  console: '控制台',
  'window-error': '页面异常',
  'unhandled-rejection': '未处理 Promise',
  resource: '资源加载',
  'security-policy': '安全策略拦截',
  network: '接口失败',
  verification: '人机验证',
  performance: '性能',
  navigation: '路由切换',
  lifecycle: '页面生命周期',
  manual: '手动上报',
};

const LEVEL_TONE: Record<TelemetryItem['level'], 'rose' | 'amber' | 'sky' | 'slate'> = {
  error: 'rose',
  warn: 'amber',
  info: 'sky',
  debug: 'slate',
};

const LEVEL_LABELS: Record<TelemetryItem['level'], string> = {
  error: '错误',
  warn: '警告',
  info: '信息',
  debug: '调试',
};

const PAGE_SIZE = 30;

function formatTime(value: string | undefined): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString('zh-CN', { hour12: false });
}

/** 明文 HTTP 下 navigator.clipboard 不可用，需要兜底。 */
async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    try {
      const textarea = document.createElement('textarea');
      textarea.value = value;
      textarea.readOnly = true;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      const ok = document.execCommand('copy');
      textarea.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

const TelemetryRow: React.FC<{
  item: TelemetryItem;
  onReplay: (traceId: string) => void;
  onDelete?: (id: string) => void;
}> = ({ item, onReplay, onDelete }) => {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const contextText = useMemo(() => {
    try {
      return JSON.stringify(item.context ?? {}, null, 2);
    } catch {
      return '{}';
    }
  }, [item.context]);

  return (
    <li className="rounded-2xl border border-slate-200 bg-white/80 p-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <InfoBadge tone={LEVEL_TONE[item.level] ?? 'slate'}>{LEVEL_LABELS[item.level] ?? item.level}</InfoBadge>
        <span className="font-semibold text-slate-700">{KIND_LABELS[item.kind] ?? item.kind}</span>
        <span className="break-all font-mono text-[11px] text-slate-500">{item.source}</span>
        {item.count > 1 ? <span className="text-slate-500">×{item.count}</span> : null}
        <span className="ml-auto shrink-0 text-slate-500">{formatTime(item.receivedAt)}</span>
      </div>

      <p className="mt-1.5 break-words text-sm leading-6 text-slate-800">{item.message || '(无文本)'}</p>

      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500">
        {item.path ? <span className="break-all">页面 {item.path}</span> : null}
        {item.outcome ? <span>结果 {item.outcome}</span> : null}
        {item.traceId ? (
          <button
            type="button"
            onClick={() => onReplay(item.traceId)}
            className="inline-flex items-center gap-1 font-semibold text-sky-700 hover:underline"
            title="用这个追踪码复盘同一次请求"
          >
            <FaSearch aria-hidden /> {item.traceId}
          </button>
        ) : null}
        {item.appVersion || item.buildSha ? <span>版本 {item.appVersion}{item.buildSha ? ` · ${item.buildSha}` : ''}</span> : null}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {item.traceId ? (
          <button
            type="button"
            onClick={async () => {
              if (await copyText(item.traceId)) {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1600);
              }
            }}
            className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white px-2.5 py-0.5 text-[11px] font-semibold text-slate-500 hover:border-slate-300 hover:text-slate-700"
          >
            {copied ? <FaCheckCircle aria-hidden /> : <FaCopy aria-hidden />}
            {copied ? '已复制追踪码' : '复制追踪码'}
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white px-2.5 py-0.5 text-[11px] font-semibold text-slate-500 hover:border-slate-300 hover:text-slate-700"
        >
          <FaChevronDown className={open ? 'rotate-180 transition-transform' : 'transition-transform'} aria-hidden />
          {open ? '收起详情' : '详情'}
        </button>
        {onDelete ? (
          <button
            type="button"
            onClick={() => onDelete(item._id)}
            className="ml-auto inline-flex items-center rounded-full border border-rose-200 bg-rose-50 px-2.5 py-0.5 text-[11px] font-semibold text-rose-600 hover:bg-rose-100"
          >
            删除
          </button>
        ) : null}
      </div>

      {open ? (
        <div className="mt-2 space-y-2 border-t border-slate-100 pt-2">
          {item.stack ? (
            <pre className="max-h-64 overflow-auto rounded-xl bg-slate-50 p-2 text-[11px] leading-5 text-slate-700">{item.stack}</pre>
          ) : null}
          <pre className="max-h-64 overflow-auto rounded-xl bg-slate-50 p-2 text-[11px] leading-5 text-slate-700">{contextText}</pre>
          {item.userAgent ? <p className="break-all text-[11px] text-slate-500">UA：{item.userAgent}</p> : null}
          {item.providerTraceId ? <p className="break-all text-[11px] text-slate-500">验证溯源：{item.providerTraceId}</p> : null}
        </div>
      ) : null}
    </li>
  );
};

const ClientTelemetryManager: React.FC = () => {
  const { user } = useAuth();
  const canDelete = isSuperAdmin(user?.role);
  const { setNotification } = useNotification();

  const [stats, setStats] = useState<TelemetryStats | null>(null);
  const [items, setItems] = useState<TelemetryItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [traceInput, setTraceInput] = useState('');
  const [kind, setKind] = useState('');
  const [level, setLevel] = useState('');
  const [pathFilter, setPathFilter] = useState('');
  const [keyword, setKeyword] = useState('');
  const [replay, setReplay] = useState<TraceReplay | null>(null);
  const [replayLoading, setReplayLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [statsResponse, listResponse] = await Promise.all([
        api.get('/api/admin/client-errors/stats'),
        api.get('/api/admin/client-errors', {
          params: {
            traceId: traceInput.trim() || undefined,
            kind: kind || undefined,
            level: level || undefined,
            path: pathFilter.trim() || undefined,
            keyword: keyword.trim() || undefined,
            page,
            pageSize: PAGE_SIZE,
          },
        }),
      ]);
      setStats(statsResponse.data?.data ?? null);
      setItems(Array.isArray(listResponse.data?.items) ? listResponse.data.items : []);
      setTotal(typeof listResponse.data?.total === 'number' ? listResponse.data.total : 0);
    } catch (caught) {
      setError('暂时无法读取客户端遥测，请稍后重试。');
      setItems([]);
      setTotal(0);
      void caught;
    } finally {
      setLoading(false);
    }
  }, [traceInput, kind, level, pathFilter, keyword, page]);

  useEffect(() => {
    void load();
  }, [load]);

  const replayTrace = useCallback(async (traceId: string) => {
    const value = traceId.trim();
    if (!value) return;
    setReplayLoading(true);
    setTraceInput(value);
    try {
      const { data } = await api.get(`/api/admin/client-errors/trace/${encodeURIComponent(value)}`);
      setReplay({
        traceId: data?.traceId ?? value,
        found: data?.found === true,
        verification: Array.isArray(data?.verification) ? data.verification : [],
        browser: Array.isArray(data?.browser) ? data.browser : [],
        providerTraceIds: Array.isArray(data?.providerTraceIds) ? data.providerTraceIds : [],
      });
    } catch {
      setNotification({ message: '复盘该追踪码失败，请稍后重试。', type: 'error' });
    } finally {
      setReplayLoading(false);
    }
  }, [setNotification]);

  const handleDelete = useCallback(async (id: string) => {
    if (!canDelete) return;
    try {
      await api.delete(`/api/admin/client-errors/${id}`);
      setNotification({ message: '记录已删除。', type: 'success' });
      await load();
    } catch {
      setNotification({ message: '删除失败，请稍后重试。', type: 'error' });
    }
  }, [canDelete, load, setNotification]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="mx-auto max-w-6xl space-y-4 px-4 py-6">
      <InfoQueryHero
        eyebrow="Telemetry"
        title="客户端遥测"
        description="浏览器控制台报错、接口失败与人机验证结果的现场记录；用一个追踪码就能把用户报的问题与服务端审计对上。"
        icon={FaBug}
      />

      {stats ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <InfoMetricCard label={`近 ${stats.windowHours} 小时事件`} value={stats.total} icon={FaHistory} />
          <InfoMetricCard label="错误" value={stats.byLevel.error ?? 0} detail="level=error" icon={FaExclamationTriangle} />
          <InfoMetricCard label="接口失败" value={stats.byKind.network ?? 0} detail="5xx / 网络层" icon={FaSyncAlt} />
          <InfoMetricCard label="验证相关" value={stats.byKind.verification ?? 0} detail="首访门禁" icon={FaCheckCircle} />
        </div>
      ) : null}

      {stats?.topPaths?.length ? (
        <InfoPanel>
          <h3 className="text-sm font-semibold text-slate-900">出错最多的页面</h3>
          <ul className="mt-2 space-y-1 text-xs text-slate-600">
            {stats.topPaths.map((entry) => (
              <li key={entry.path} className="flex items-center justify-between gap-3">
                <button type="button" onClick={() => { setPathFilter(entry.path); setPage(1); }} className="min-w-0 break-all text-left text-sky-700 hover:underline">
                  {entry.path || '(未知页面)'}
                </button>
                <span className="shrink-0 font-mono">{entry.count}</span>
              </li>
            ))}
          </ul>
        </InfoPanel>
      ) : null}

      <InfoPanel>
        <div className="flex flex-col gap-3">
          <form
            className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5"
            onSubmit={(event) => { event.preventDefault(); setPage(1); if (traceInput.trim()) void replayTrace(traceInput); else void load(); }}
          >
            <input className={studioFieldClassName} placeholder="问题追踪码" value={traceInput} onChange={(event) => setTraceInput(event.target.value)} />
            <input className={studioFieldClassName} placeholder="关键字（消息/来源/结果）" value={keyword} onChange={(event) => setKeyword(event.target.value)} />
            <input className={studioFieldClassName} placeholder="页面路径，如 /geogebra" value={pathFilter} onChange={(event) => setPathFilter(event.target.value)} />
            <select className={studioFieldClassName} value={kind} onChange={(event) => { setKind(event.target.value); setPage(1); }}>
              <option value="">全部类型</option>
              {Object.entries(KIND_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
            <select className={studioFieldClassName} value={level} onChange={(event) => { setLevel(event.target.value); setPage(1); }}>
              <option value="">全部级别</option>
              {Object.entries(LEVEL_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
            <div className="flex items-center gap-2 sm:col-span-2 lg:col-span-5">
              <button type="submit" className={studioPrimaryButtonClassName}>
                <FaSearch aria-hidden /> 查询 / 复盘
              </button>
              <button type="button" className={studioSecondaryButtonClassName} onClick={() => void load()} disabled={loading}>
                <FaSyncAlt className={loading ? 'animate-spin' : undefined} aria-hidden /> 刷新
              </button>
              {traceInput ? (
                <button type="button" className={studioSecondaryButtonClassName} onClick={() => { setTraceInput(''); setReplay(null); setPage(1); }}>
                  清除追踪码
                </button>
              ) : null}
            </div>
          </form>
        </div>
      </InfoPanel>

      {error ? <StudioErrorNote>{error}</StudioErrorNote> : null}

      {replay ? (
        <InfoPanel>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-slate-900">
              追踪码复盘 <code className="break-all font-mono text-xs text-slate-600">{replay.traceId}</code>
            </h3>
            {replay.providerTraceIds.length > 0 ? (
              <span className="text-[11px] text-slate-500">人机验证溯源：{replay.providerTraceIds.join('、')}</span>
            ) : null}
          </div>
          {!replay.found ? (
            <p className="mt-2 text-xs text-slate-500">该追踪码没有客户端事件记录（可能来自更早的会话，或遥测被关闭）。</p>
          ) : null}
          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            <div>
              <h4 className="text-xs font-semibold text-slate-600">验证链路</h4>
              {replay.verification.length === 0 ? (
                <p className="mt-1 text-xs text-slate-500">没有验证相关事件。</p>
              ) : (
                <ul className="mt-1 space-y-2">
                  {replay.verification.map((item) => (
                    <TelemetryRow key={item._id} item={item} onReplay={(value) => void replayTrace(value)} />
                  ))}
                </ul>
              )}
            </div>
            <div>
              <h4 className="text-xs font-semibold text-slate-600">浏览器事件</h4>
              {replay.browser.length === 0 ? (
                <p className="mt-1 text-xs text-slate-500">没有浏览器事件。</p>
              ) : (
                <ul className="mt-1 space-y-2">
                  {replay.browser.map((item) => (
                    <TelemetryRow key={item._id} item={item} onReplay={(value) => void replayTrace(value)} />
                  ))}
                </ul>
              )}
            </div>
          </div>
          {replayLoading ? <p className="mt-2 text-xs text-slate-500">正在复盘…</p> : null}
        </InfoPanel>
      ) : null}

      <InfoPanel>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-slate-900">事件列表（{total}）</h3>
          <span className="text-[11px] text-slate-500">仅保留最近 30 天；同一类错误 10 分钟窗口内合并计数。</span>
        </div>
        {loading && items.length === 0 ? (
          <StudioLoadingState minHeightClassName="min-h-[200px]" text="正在读取客户端遥测…" />
        ) : items.length === 0 ? (
          <StudioEmptyState message="没有匹配的事件。用户报问题后，请用他提供的追踪码查询。" />
        ) : (
          <ul className="mt-3 space-y-2">
            {items.map((item) => (
              <TelemetryRow
                key={item._id}
                item={item}
                onReplay={(value) => void replayTrace(value)}
                onDelete={canDelete ? (id) => void handleDelete(id) : undefined}
              />
            ))}
          </ul>
        )}

        {totalPages > 1 ? (
          <div className="mt-4 flex items-center justify-between text-xs text-slate-600">
            <button type="button" className={studioSecondaryButtonClassName} disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>
              上一页
            </button>
            <span>第 {page} / {totalPages} 页</span>
            <button type="button" className={studioSecondaryButtonClassName} disabled={page >= totalPages} onClick={() => setPage((value) => Math.min(totalPages, value + 1))}>
              下一页
            </button>
          </div>
        ) : null}
      </InfoPanel>

      <InfoQueryShell className="!py-0">
        <p className="text-xs leading-6 text-slate-500">
          采集范围：控制台输出、未捕获异常、资源与接口失败、安全策略拦截、人机验证结果、Web Vitals、路由与页面生命周期。
          不采集请求体、表单内容、Cookie 与本地存储；IP 与设备标识只存不可逆摘要。
          本站可在浏览器里用 <code className="font-mono">localStorage['synapse:client-telemetry']='off'</code> 关闭上报。
        </p>
      </InfoQueryShell>
    </div>
  );
};

export default ClientTelemetryManager;
