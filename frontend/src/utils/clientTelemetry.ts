/**
 * 客户端遥测：隐式收集浏览器控制台输出、未捕获异常、网络失败、安全策略拦截、性能指标与页面生命周期，
 * 按批上报到 `/api/client-telemetry/report`。
 *
 * 目的只有一个：用户把首访验证页上的「问题追踪码」报给管理员后，管理员能沿同一个码
 * 看到那一刻浏览器与控制台发生了什么（而不只是服务端收到过一次请求）。
 *
 * 采集面（尽量宽，但仍守边界）：
 *  - console 的 error / warn / log / info / debug / trace；
 *  - window.onerror、unhandledrejection、资源加载失败、securitypolicyviolation；
 *  - API 失败（状态码/耗时/请求 ID，不含请求体）、超时、断网；
 *  - Web Vitals（LCP / CLS / INP / TTFB）、长任务、内存与连接类型；
 *  - SPA 路由切换、页面可见性、在线/离线。
 *
 * 边界（刻意保守）：
 *  - **不收集**请求体、表单值、cookie、localStorage、用户输入；
 *  - 文本先脱敏（JWT / Bearer / 常见密钥 / password= 形态），再截断；
 *  - 同类文本 60 秒内合并，单页最多 60 条，单批 10 条，15 秒一批；
 *  - 上报自身永远不抛错、不递归上报、不影响页面；
 *  - `localStorage['synapse:client-telemetry'] = 'off'` 可显式关闭；
 *    `= 'verbose'` 额外带上资源耗时明细（默认已含 console.log/info）。
 *
 * 与「问题追踪码」的关系：服务端每个响应都带 `X-Request-Id`，首访验证与验证码配置还会在
 * 响应体里回 traceId。这里记住最后一次看到的码，随事件一起上报，管理员据此复盘。
 */

export type ClientTelemetryLevel = 'error' | 'warn' | 'info' | 'debug';
export type ClientTelemetryKind =
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

interface PendingEvent {
  eventId: string;
  kind: ClientTelemetryKind;
  level: ClientTelemetryLevel;
  source: string;
  message: string;
  stack: string;
  path: string;
  traceId: string;
  outcome?: string;
  time: number;
  context?: Record<string, unknown>;
}

const FINGERPRINT_STORAGE_KEY = 'chloemlla.com_fingerprint_v2';
const OPT_OUT_KEY = 'synapse:client-telemetry';
const ENDPOINT = '/api/client-telemetry/report';
const FLUSH_INTERVAL_MS = 15_000;
const MAX_PENDING = 60;
const MAX_EVENTS_PER_BATCH = 10;
const DEDUPE_WINDOW_MS = 60_000;
const MAX_MESSAGE = 2_000;
const MAX_STACK = 8_000;

let installed = false;
let lastTraceId = '';
let lastRequestId = '';
let flushing = false;
let internalWrite = false;
let sequence = 0;
let routeSequence = 0;

const pending: PendingEvent[] = [];
const recent = new Map<string, number>();

function telemetryMode(): 'off' | 'on' | 'verbose' {
  try {
    const value = window.localStorage.getItem(OPT_OUT_KEY);
    if (value === 'off') return 'off';
    if (value === 'verbose') return 'verbose';
  } catch {
    // 存储不可用（隐私模式）按默认开启处理
  }
  return 'on';
}

/** 脱敏：与后端同一组形态，前端先做一次，减少明文离开浏览器的机会。 */
function redact(value: string): string {
  return value
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, '[jwt]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi, 'Bearer [redacted]')
    .replace(/\b(sk|pk|rk|re|ghp|gho|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}/gi, '[secret]')
    .replace(/((?:password|passwd|secret|token|api[_-]?key|authorization|cookie)\s*[:=]\s*)["']?[^\s"',;]{4,}/gi, '$1[redacted]')
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g, '[telegram-token]');
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function currentPath(): string {
  try {
    return (window.location.pathname + window.location.hash).slice(0, 300);
  } catch {
    return '';
  }
}

/** 序列化 console 参数：字符串直接取，Error 取 message+stack，其余对象最多两层。 */
function describeArgument(value: unknown, depth = 0): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  if (value instanceof Error) return `${value.name}: ${value.message}\n${value.stack ?? ''}`;
  if (typeof value === 'function') return `[function ${value.name || 'anonymous'}]`;
  if (depth >= 2) return '[object]';
  if (Array.isArray(value)) {
    return `[${value.slice(0, 10).map((item) => describeArgument(item, depth + 1)).join(', ')}]`;
  }
  if (typeof value === 'object') {
    try {
      const entries = Object.entries(value as Record<string, unknown>).slice(0, 12);
      return `{${entries.map(([key, item]) => `${key}: ${describeArgument(item, depth + 1)}`).join(', ')}}`;
    } catch {
      return '[object]';
    }
  }
  return String(value);
}

function environmentContext(): Record<string, unknown> {
  const context: Record<string, unknown> = {};
  try {
    context.viewport = `${window.innerWidth}x${window.innerHeight}`;
    context.screen = `${window.screen?.width ?? 0}x${window.screen?.height ?? 0}`;
    context.dpr = window.devicePixelRatio;
    context.online = navigator.onLine;
    context.visibility = document.visibilityState;
    context.language = navigator.language;
    context.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const nav = navigator as Navigator & {
      deviceMemory?: number;
      hardwareConcurrency?: number;
      connection?: { effectiveType?: string; downlink?: number; rtt?: number };
    };
    if (typeof nav.hardwareConcurrency === 'number') context.cores = nav.hardwareConcurrency;
    if (typeof nav.deviceMemory === 'number') context.deviceMemoryGb = nav.deviceMemory;
    if (nav.connection?.effectiveType) context.connection = nav.connection.effectiveType;
    if (typeof nav.connection?.rtt === 'number') context.rttMs = nav.connection.rtt;
  } catch {
    // 非浏览器环境（测试）忽略
  }
  if (lastRequestId && lastRequestId !== lastTraceId) context.lastRequestId = lastRequestId;
  return context;
}

function enqueue(
  kind: ClientTelemetryKind,
  level: ClientTelemetryLevel,
  source: string,
  message: string,
  options: { stack?: string; outcome?: string; context?: Record<string, unknown> } = {},
): void {
  if (internalWrite || telemetryMode() === 'off') return;
  const cleanMessage = truncate(redact(String(message || '')).trim(), MAX_MESSAGE);
  const cleanStack = truncate(redact(String(options.stack || '')), MAX_STACK);
  if (!cleanMessage && !cleanStack) return;

  // 60 秒内同一来源、同一消息只记一次：控制台刷屏（渲染循环 / 轮询失败）不应放大成网络风暴。
  const dedupeKey = `${kind}|${level}|${source}|${cleanMessage.slice(0, 400)}`;
  const now = Date.now();
  const seenAt = recent.get(dedupeKey);
  if (seenAt && now - seenAt < DEDUPE_WINDOW_MS) return;
  recent.set(dedupeKey, now);
  if (recent.size > 400) {
    for (const [key, timestamp] of recent) {
      if (now - timestamp >= DEDUPE_WINDOW_MS) recent.delete(key);
    }
  }

  pending.push({
    eventId: `evt-${now.toString(36)}-${(sequence += 1).toString(36)}`,
    kind,
    level,
    source,
    message: cleanMessage,
    stack: cleanStack,
    path: currentPath(),
    traceId: lastTraceId,
    outcome: options.outcome,
    time: now,
    context: { ...environmentContext(), ...(options.context ?? {}) },
  });
  while (pending.length > MAX_PENDING) pending.shift();
  if (pending.length >= MAX_EVENTS_PER_BATCH) void flushClientTelemetry();
}

function readDeviceId(): string {
  try {
    const raw = window.localStorage.getItem(FINGERPRINT_STORAGE_KEY);
    if (!raw) return '';
    const parsed = JSON.parse(raw) as { id?: unknown };
    return typeof parsed.id === 'string' ? parsed.id.slice(0, 200) : '';
  } catch {
    return '';
  }
}

// 构建期由 vite define 注入的常量；未注入时（测试/旧产物）typeof 会安全地返回 undefined。
declare const __FRONTEND_VERSION__: string | undefined;
declare const __GIT_SHORT_SHA__: string | undefined;

function safeGlobalString(name: '__FRONTEND_VERSION__' | '__GIT_SHORT_SHA__'): string {
  if (name === '__FRONTEND_VERSION__') {
    return typeof __FRONTEND_VERSION__ === 'string' ? __FRONTEND_VERSION__ : '';
  }
  return typeof __GIT_SHORT_SHA__ === 'string' ? __GIT_SHORT_SHA__ : '';
}

function takeBatch(): Array<PendingEvent & { appVersion: string; buildSha: string }> {
  if (pending.length === 0) return [];
  const appVersion = safeGlobalString('__FRONTEND_VERSION__');
  const buildSha = safeGlobalString('__GIT_SHORT_SHA__');
  return pending.splice(0, MAX_EVENTS_PER_BATCH).map((event) => ({ ...event, appVersion, buildSha }));
}

/** 上报一批事件。页面离开时用 sendBeacon，其余场景用 keepalive fetch。 */
export async function flushClientTelemetry(options: { beacon?: boolean } = {}): Promise<void> {
  if (flushing || telemetryMode() === 'off') return;
  const batch = takeBatch();
  if (batch.length === 0) return;
  flushing = true;
  internalWrite = true;
  try {
    const payload = JSON.stringify({
      deviceId: readDeviceId(),
      traceId: lastTraceId || lastRequestId || '',
      events: batch,
    });
    if (options.beacon && typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      navigator.sendBeacon(ENDPOINT, new Blob([payload], { type: 'application/json' }));
      return;
    }
    await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      credentials: 'include',
      keepalive: true,
    });
  } catch {
    // 遥测失败是预期内的（断网、离线、后端禁用）：不重试、不弹错、不递归上报。
  } finally {
    internalWrite = false;
    flushing = false;
  }
}

/** 记录当前页面的问题追踪码（首访验证 / 验证码配置响应里带回的那一串）。 */
export function setClientTelemetryTraceId(traceId: unknown): void {
  if (typeof traceId !== 'string') return;
  const value = traceId.trim();
  if (!value || value.length > 128) return;
  lastTraceId = value;
}

/** 记录最近一次 API 响应的请求 ID（X-Request-Id），作为没有验证码 traceId 时的兜底。 */
export function noteClientRequestId(requestId: unknown): void {
  if (typeof requestId !== 'string') return;
  const value = requestId.trim();
  if (!value || value.length > 128) return;
  lastRequestId = value;
}

/** 供业务代码显式上报（验证控件加载失败、断网重试、业务自检失败等）。 */
export function reportClientTelemetry(
  message: string,
  options: {
    kind?: ClientTelemetryKind;
    level?: ClientTelemetryLevel;
    source?: string;
    stack?: string;
    outcome?: string;
    context?: Record<string, unknown>;
  } = {},
): void {
  enqueue(options.kind ?? 'manual', options.level ?? 'error', options.source ?? 'manual', message, options);
}

/** API 失败上报的便捷入口（axios 拦截器与 raw fetch 共用）。 */
export function reportClientNetworkFailure(input: {
  method?: string;
  path: string;
  status?: number;
  durationMs?: number;
  errorCode?: string;
  message?: string;
  requestId?: string;
}): void {
  if (input.requestId) noteClientRequestId(input.requestId);
  const status = typeof input.status === 'number' ? input.status : 0;
  // 4xx 是正常的业务拒绝（校验失败、未登录、同意缺失），只记 5xx / 网络层 / 超时。
  if (status > 0 && status < 500) return;
  const summary = `${input.method ?? 'GET'} ${input.path} → ${status || 'network error'}${input.errorCode ? ` (${input.errorCode})` : ''}`;
  enqueue('network', 'error', 'api', summary, {
    outcome: status ? String(status) : 'network-error',
    context: {
      method: input.method,
      path: input.path,
      status: status || undefined,
      durationMs: input.durationMs,
      errorCode: input.errorCode,
      error: input.message ? truncate(redact(input.message), 500) : undefined,
      requestId: input.requestId,
    },
  });
}

/** 安装全局采集。必须在渲染前调用一次；重复调用幂等。 */
export function installClientTelemetry(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  if (telemetryMode() === 'off') return;

  // 启动快照：设备/网络/内存这类「复现环境」信息只发一次。
  const uaData = (navigator as Navigator & { userAgentData?: { platform?: string; mobile?: boolean } }).userAgentData;
  enqueue('lifecycle', 'info', 'boot', '页面加载', {
    context: {
      route: currentPath(),
      referrer: document.referrer ? redact(document.referrer).slice(0, 200) : '',
      platform: uaData?.platform,
      mobile: uaData?.mobile,
      userAgent: navigator.userAgent.slice(0, 300),
    },
  });

  window.addEventListener('error', (event) => {
    const target = event.target as { src?: string; href?: string; tagName?: string } | null;
    if (target && (target.src || target.href)) {
      enqueue('resource', 'error', target.tagName?.toLowerCase() || 'resource', `资源加载失败：${target.src || target.href}`, {
        context: { url: String(target.src || target.href).slice(0, 500) },
      });
      return;
    }
    const error = event.error instanceof Error ? event.error : null;
    enqueue('window-error', 'error', 'window.onerror', event.message || String(event.error ?? ''), {
      stack: error?.stack ?? '',
      context: { line: event.lineno, column: event.colno, filename: event.filename ? String(event.filename).slice(0, 300) : '' },
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    const message = reason instanceof Error ? `${reason.name}: ${reason.message}` : describeArgument(reason);
    enqueue('unhandled-rejection', 'error', 'unhandledrejection', message, {
      stack: reason instanceof Error ? reason.stack ?? '' : '',
    });
  });

  document.addEventListener('securitypolicyviolation', (event) => {
    enqueue('security-policy', 'warn', 'csp', `内容安全策略拦截：${event.violatedDirective || event.effectiveDirective || 'unknown'}`, {
      context: {
        blockedURI: event.blockedURI ? String(event.blockedURI).slice(0, 300) : '',
        violatedDirective: event.violatedDirective,
        effectiveDirective: event.effectiveDirective,
        sourceFile: event.sourceFile ? String(event.sourceFile).slice(0, 300) : '',
        line: event.lineNumber,
      },
    });
  });

  const wrapConsole = (
    method: 'error' | 'warn' | 'log' | 'info' | 'debug' | 'trace',
    level: ClientTelemetryLevel,
    source: string,
  ) => {
    const original = console[method]?.bind(console);
    if (!original) return;
    (console as unknown as Record<string, (...args: unknown[]) => void>)[method] = (...args: unknown[]) => {
      try {
        const first = args[0];
        enqueue('console', level, source, args.map((item) => describeArgument(item)).join(' '), {
          stack: first instanceof Error ? first.stack ?? '' : '',
        });
      } catch {
        // 采集失败绝不能影响原始输出
      } finally {
        original(...args);
      }
    };
  };
  wrapConsole('error', 'error', 'console.error');
  wrapConsole('warn', 'warn', 'console.warn');
  wrapConsole('log', 'info', 'console.log');
  wrapConsole('info', 'info', 'console.info');
  wrapConsole('debug', 'debug', 'console.debug');
  wrapConsole('trace', 'debug', 'console.trace');

  // SPA 路由切换：pushState/replaceState 与 popstate。只记路径，不记 query。
  try {
    const recordNavigation = (kind: string) => {
      routeSequence += 1;
      enqueue('navigation', 'info', `history.${kind}`, `路由切换→${currentPath()}`, {
        context: { sequence: routeSequence },
      });
    };
    for (const method of ['pushState', 'replaceState'] as const) {
      const original = history[method].bind(history);
      (history as unknown as Record<string, unknown>)[method] = (data: unknown, unused: string, url?: string | URL | null) => {
        const result = original(data, unused, url);
        try {
          recordNavigation(method);
        } catch {
          // ignore
        }
        return result;
      };
    }
    window.addEventListener('popstate', () => {
      try {
        recordNavigation('popstate');
      } catch {
        // ignore
      }
    });
  } catch {
    // 某些内嵌浏览器会冻结 history 对象
  }

  window.addEventListener('online', () => enqueue('lifecycle', 'info', 'network', '网络恢复'));
  window.addEventListener('offline', () => enqueue('lifecycle', 'warn', 'network', '网络断开'));

  // Web Vitals / 长任务：用 PerformanceObserver，不支持时静默跳过。
  try {
    const vitals: Record<string, number> = {};
    const reportVitals = (reason: string) => {
      if (Object.keys(vitals).length === 0) return;
      enqueue('performance', 'info', 'web-vitals', `性能指标（${reason}）`, {
        context: { ...vitals, reason },
      });
    };

    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) vitals.lcpMs = Math.round(entry.startTime);
    }).observe({ type: 'largest-contentful-paint', buffered: true });

    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as Array<PerformanceEntry & { hadRecentInput?: boolean; value?: number }>) {
        if (entry.hadRecentInput) continue;
        vitals.cls = Number(((vitals.cls ?? 0) + (entry.value ?? 0)).toFixed(4));
      }
    }).observe({ type: 'layout-shift', buffered: true });

    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as Array<PerformanceEntry & { duration?: number }>) {
        vitals.inpMs = Math.max(vitals.inpMs ?? 0, Math.round(entry.duration ?? 0));
      }
    }).observe({ type: 'event', buffered: true, durationThreshold: 104 } as PerformanceObserverInit);

    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as Array<PerformanceEntry & { duration?: number }>) {
        if ((entry.duration ?? 0) < 150) continue;
        vitals.longTaskCount = (vitals.longTaskCount ?? 0) + 1;
        vitals.longestTaskMs = Math.max(vitals.longestTaskMs ?? 0, Math.round(entry.duration ?? 0));
      }
    }).observe({ type: 'longtask', buffered: true });

    const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    if (navigation) {
      vitals.ttfbMs = Math.round(navigation.responseStart);
      vitals.domContentLoadedMs = Math.round(navigation.domContentLoadedEventEnd);
      vitals.loadMs = Math.round(navigation.loadEventEnd || navigation.duration);
      vitals.transferKb = Math.round((navigation.transferSize || 0) / 1024);
    }
    const memory = (performance as Performance & { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
    if (memory) {
      vitals.heapUsedMb = Math.round(memory.usedJSHeapSize / 1024 / 1024);
      vitals.heapLimitMb = Math.round(memory.jsHeapSizeLimit / 1024 / 1024);
    }

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') reportVitals('hidden');
    });
    window.addEventListener('pagehide', () => reportVitals('pagehide'));
  } catch {
    // 老浏览器不支持对应 observer 时静默跳过
  }

  // 资源失败明细（只统计失败/超时的资源）：PerformanceObserver('resource') 在部分浏览器不支持。
  try {
    new PerformanceObserver((list) => {
      if (telemetryMode() !== 'verbose' && telemetryMode() !== 'on') return;
      for (const entry of list.getEntries() as Array<PerformanceEntry & { initiatorType?: string; transferSize?: number; decodedBodySize?: number }>) {
        const failed = (entry.transferSize === 0 && entry.decodedBodySize === 0 && entry.duration > 0);
        if (!failed) continue;
        enqueue('resource', 'warn', `resource.${entry.initiatorType || 'unknown'}`, `资源可能加载失败：${entry.name.slice(0, 300)}`, {
          context: { durationMs: Math.round(entry.duration), startTimeMs: Math.round(entry.startTime) },
        });
      }
    }).observe({ type: 'resource', buffered: true });
  } catch {
    // ignore
  }

  window.setInterval(() => {
    void flushClientTelemetry();
  }, FLUSH_INTERVAL_MS);

  // 页面隐藏/卸载时最后一批用 sendBeacon：移动端切后台后定时器会被冻结。
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      enqueue('lifecycle', 'info', 'visibility', '页面进入后台');
      void flushClientTelemetry({ beacon: true });
    }
  });
  window.addEventListener('pagehide', () => {
    void flushClientTelemetry({ beacon: true });
  });
}

/** 测试与调试用：清空缓冲（不影响全局钩子）。 */
export function __resetClientTelemetryForTests(): void {
  pending.length = 0;
  recent.clear();
  lastTraceId = '';
  lastRequestId = '';
  sequence = 0;
  routeSequence = 0;
}
