import { getFingerprint } from './fingerprint';
import { canonicalizeBackendApiUrlObject } from './apiPath';
import { isFirstVisitVerificationEnabled } from './firstVisitVerificationConfig';
import { getApiBaseUrl } from '../api/api';
import { fetchWithTimeout } from './fetchWithTimeout';
import { maybeEmitPenaltyAppealFromResponse } from './penaltyAppeal';

export type IpCaptchaType = 'turnstile' | 'hcaptcha' | 'trycap';

export interface IpVerificationSession {
  success: boolean;
  verified: boolean;
  requiresVerification: boolean;
  fingerprint: string;
  ipAddress: string;
  token?: string;
  expiresAt?: string;
  issuedBy?: 'auto' | 'turnstile' | 'hcaptcha' | 'trycap';
  reason?: string;
  fraudScore?: number;
  riskFlags?: string[];
  tokenTtlMinutes: number;
}

interface StoredIpVerificationToken {
  token: string;
  fingerprint: string;
  expiresAt: number;
  issuedBy?: 'auto' | 'turnstile' | 'hcaptcha' | 'trycap';
}

const STORAGE_KEY = 'chloemlla.com_ip_verification_token_v1';
const EVENT_NAME = 'chloemlla.com:ip-verification-required';

export const EXEMPT_PATH_PREFIXES = [
  '/api/ip-verification',
  '/api/turnstile',
  '/api/human-check',
  '/api/frontend-config',
  '/api/status',
  '/api/auth/linuxdo/',
];

let fetchTransportInstalled = false;

export function isExemptPath(pathname: string): boolean {
  return EXEMPT_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function isBackendRequest(url: URL): boolean {
  const apiOrigin = new URL(getApiBaseUrl(), window.location.origin).origin;
  const sameBackendOrigin = url.origin === apiOrigin || url.origin === window.location.origin;
  const relativeApiPath = url.pathname.startsWith('/api/');
  return sameBackendOrigin && relativeApiPath;
}

function readStoredToken(): StoredIpVerificationToken | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredIpVerificationToken;
    if (!parsed?.token || !parsed?.fingerprint || !parsed?.expiresAt) {
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    if (Date.now() >= parsed.expiresAt) {
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return parsed;
  } catch {
    localStorage.removeItem(STORAGE_KEY);
    return null;
  }
}

export function clearIpVerificationToken(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore storage failures
  }
}

export function getStoredIpVerificationToken(fingerprint?: string): string | null {
  const stored = readStoredToken();
  if (!stored) return null;
  if (fingerprint && stored.fingerprint !== fingerprint) {
    clearIpVerificationToken();
    return null;
  }
  return stored.token;
}

export function getStoredIpVerificationExpiry(): number | null {
  return readStoredToken()?.expiresAt ?? null;
}

export function storeIpVerificationToken(session: IpVerificationSession): void {
  if (!session.token || !session.expiresAt || !session.fingerprint) return;

  try {
    const expiresAt = new Date(session.expiresAt).getTime();
    if (!Number.isFinite(expiresAt)) return;
    const payload: StoredIpVerificationToken = {
      token: session.token,
      fingerprint: session.fingerprint,
      expiresAt,
      issuedBy: session.issuedBy,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // ignore storage failures
  }
}

function normalizeSessionPayload(payload: Partial<IpVerificationSession>, fingerprint: string): IpVerificationSession {
  const verified = Boolean(payload.verified);
  return {
    success: Boolean(payload.success),
    verified,
    // fail-closed：「既未验证、也未要求验证」的握手结论不可信，一律要求验证。
    // 否则会被当成已通过直接放行，而这个会话根本没有令牌：此后每个 /api 请求 403，
    // 每次 403 又触发一次同样的静默握手，闸门永远不弹，用户只看到请求失败。
    requiresVerification: Boolean(payload.requiresVerification) || !verified,
    fingerprint: typeof payload.fingerprint === 'string' && payload.fingerprint ? payload.fingerprint : fingerprint,
    ipAddress: typeof payload.ipAddress === 'string' ? payload.ipAddress : 'unknown',
    token: typeof payload.token === 'string' ? payload.token : undefined,
    expiresAt: typeof payload.expiresAt === 'string' ? payload.expiresAt : undefined,
    issuedBy:
      payload.issuedBy === 'turnstile' || payload.issuedBy === 'hcaptcha' || payload.issuedBy === 'trycap' || payload.issuedBy === 'auto'
        ? payload.issuedBy
        : undefined,
    reason: typeof payload.reason === 'string' ? payload.reason : undefined,
    fraudScore: typeof payload.fraudScore === 'number' ? payload.fraudScore : undefined,
    riskFlags: Array.isArray(payload.riskFlags) ? payload.riskFlags.filter((item): item is string => typeof item === 'string') : [],
    tokenTtlMinutes: typeof payload.tokenTtlMinutes === 'number' ? payload.tokenTtlMinutes : 40,
  };
}

export function emitIpVerificationRequired(detail: Record<string, unknown> = {}): void {
  if (typeof window === 'undefined') return;
  // 不按本地开关拦截。这个载荷只可能由服务端的首访闸门产生，它本身就是"服务端此刻在拦截"
  // 的证据；而本地开关是页面加载时抓的快照，开闸之前打开的页面会永远以为自己不用验证：
  // 请求不带验证头、403 又被静默丢掉，用户只看得到请求失败，验证页始终不弹。
  window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail }));
}

export function onIpVerificationRequired(
  handler: (event: CustomEvent<Record<string, unknown>>) => void,
): () => void {
  const wrapped = (event: Event) => {
    handler(event as CustomEvent<Record<string, unknown>>);
  };
  window.addEventListener(EVENT_NAME, wrapped);
  return () => window.removeEventListener(EVENT_NAME, wrapped);
}

function isIpVerificationErrorPayload(payload: unknown): payload is Record<string, unknown> {
  return Boolean(
    payload &&
      typeof payload === 'object' &&
      ((payload as Record<string, unknown>).errorCode === 'IP_VERIFICATION_REQUIRED' ||
        (payload as Record<string, unknown>).requiresVerification === true),
  );
}

/**
 * 硬封禁载荷（ipBanCheck / 闸门高风险自动拦截）。
 *
 * 封禁不能只靠刷新页面才被发现：用户在站内被封时，后续请求会持续 403，但闸门页不会自己弹。
 * 把它也当作「服务端正在拦我」的信号，交给同一个事件处理——处理链会重跑一次静默握手，
 * 拿到带 banData 的 403 后渲染阻断页。
 */
function isIpBanPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const record = payload as Record<string, unknown>;
  return record.errorCode === 'IP_BANNED' || record.banned === true || record.error === 'IP已被封禁';
}

/**
 * 把封禁载荷转成带 banData 的错误（形状与 useFirstVisitDetection 的读取端对齐），
 * 闸门据此渲染阻断页；initialize 与 complete 两条路径共用，避免各自的解析逻辑漂移。
 */
function createIpBanError(payload: unknown): Error {
  const record = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  const reason = typeof record.reason === 'string' ? record.reason : undefined;
  const expiresAt = typeof record.expiresAt === 'string' ? record.expiresAt : undefined;
  const banError = new Error(`IP已被封禁${reason ? `: ${reason}` : ''}`);
  (banError as { banData?: { reason?: string; expiresAt?: string } }).banData = { reason, expiresAt };
  return banError;
}

async function maybeHandleBlockedResponse(response: Response, url: URL): Promise<void> {
  // 同 emitIpVerificationRequired：只看响应本身，不看本地开关快照。
  if (response.status !== 403 || isExemptPath(url.pathname)) return;

  const payload = await response
    .clone()
    .json()
    .catch(() => null);

  if (!isIpVerificationErrorPayload(payload) && !isIpBanPayload(payload)) return;

  // 这里刻意不抹掉本地令牌：一个 403 只说明"这一次请求没带上有效令牌"，不等于已存的令牌失效
  // ——请求可能在令牌落盘前就发出，也可能走了不注入验证头的路径。真正的判据是
  // initializeIpVerificationSession：只有服务端明确回 requiresVerification 时才清（见下方
  // normalize 分支）。在这里清的话，一次偶发 403 就能把 40 分钟的会话直接毁掉，刷新必然重开门禁。
  emitIpVerificationRequired({
    ...payload,
    url: url.toString(),
  });
}

export async function buildIpVerificationHeaders(): Promise<Record<string, string>> {
  if (!isFirstVisitVerificationEnabled()) return {};

  const fingerprint = await getFingerprint();
  const headers: Record<string, string> = {};

  if (!fingerprint) return headers;

  headers['X-Fingerprint'] = fingerprint;

  const token = getStoredIpVerificationToken(fingerprint);
  if (token) {
    headers['X-IP-Verification-Token'] = token;
  }

  return headers;
}

export async function initializeIpVerificationSession(existingFingerprint?: string): Promise<IpVerificationSession> {
  if (!isFirstVisitVerificationEnabled()) {
    return {
      success: true,
      verified: true,
      requiresVerification: false,
      fingerprint: existingFingerprint || '',
      ipAddress: 'unknown',
      issuedBy: 'auto',
      tokenTtlMinutes: 40,
    };
  }

  const fingerprint = existingFingerprint || (await getFingerprint()) || '';

  const response = await fetchWithTimeout(`${getApiBaseUrl()}/api/ip-verification/session`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    credentials: 'include',
    body: JSON.stringify({ fingerprint }),
  });

  if (!response.ok) {
    // G9-14：后端以 403 + error=IP已被封禁（或 errorCode=IP_BANNED）表达封禁，转成带 banData 的错误，
    // 供 useFirstVisitDetection 读取真实 isIpBanned 并渲染阻断页。
    const errPayload = await response.json().catch(() => ({}));
    if (response.status === 403 && isIpBanPayload(errPayload)) {
      throw createIpBanError(errPayload);
    }
    // 原始状态码与后端原文只进 console；向上抛稳定 code，面向用户的文案由调用方映射。
    console.error('IP verification session init failed:', response.status, errPayload);
    throw new Error('SESSION_INIT_FAILED');
  }

  const payload = await response.json().catch(() => ({}));
  const normalized = normalizeSessionPayload(payload, fingerprint);

  if (normalized.token && normalized.verified) {
    storeIpVerificationToken(normalized);
  } else if (normalized.requiresVerification) {
    clearIpVerificationToken();
  }

  return normalized;
}

export async function completeIpVerification(
  fingerprintInput: string,
  captchaToken: string,
  captchaType: IpCaptchaType,
): Promise<IpVerificationSession> {
  if (!isFirstVisitVerificationEnabled()) {
    return {
      success: true,
      verified: true,
      requiresVerification: false,
      fingerprint: fingerprintInput || '',
      ipAddress: 'unknown',
      issuedBy: 'auto',
      tokenTtlMinutes: 40,
    };
  }

  const fingerprint = fingerprintInput || (await getFingerprint()) || '';

  const response = await fetchWithTimeout(`${getApiBaseUrl()}/api/ip-verification/complete`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    credentials: 'include',
    body: JSON.stringify({
      fingerprint,
      captchaToken,
      captchaType,
    }),
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    // 封禁可能恰在解验证码这一刻生效：complete 命中 EXEMPT_PATH_PREFIXES，transport 的 403
    // 检查根本不看它，此前这条路会把封禁整个吞掉（只显示「未被接受」）。
    // 与 initialize 同形处理：抛带 banData 的错误，让闸门切到阻断页（页面自带申诉入口）。
    if (response.status === 403 && isIpBanPayload(payload)) {
      throw createIpBanError(payload);
    }
    // 其余处罚类失败（如账户封停）交统一分类器派发申诉；普通失败保持原有返回形状。
    maybeEmitPenaltyAppealFromResponse(payload, response.status, 'ip-verification-complete');
  }

  const normalized = normalizeSessionPayload(payload, fingerprint);

  if (normalized.token && normalized.verified) {
    storeIpVerificationToken(normalized);
  }

  return normalized;
}

export function installIpVerificationTransport(): void {
  if (fetchTransportInstalled || typeof window === 'undefined') return;
  fetchTransportInstalled = true;

  const originalFetch = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    let request = new Request(input, init);
    let url = new URL(request.url, window.location.origin);
    const apiOrigin = new URL(getApiBaseUrl(), window.location.origin).origin;
    const sameBackendOrigin = url.origin === apiOrigin || url.origin === window.location.origin;
    const canonicalUrl = sameBackendOrigin ? canonicalizeBackendApiUrlObject(url) : url;

    if (canonicalUrl.toString() !== url.toString()) {
      request = new Request(canonicalUrl.toString(), request);
      url = canonicalUrl;
    }

    if (!isBackendRequest(url)) {
      return originalFetch(request);
    }

    if (isExemptPath(url.pathname)) {
      return originalFetch(request);
    }

    // 本地开关是页面加载时的快照，开闸之前打开的页面会一直以为自己不用验证。
    // 所以"开关关着"只跳过加头，不跳过 403 检查：服务端真开始拦截时，这条响应
    // 会触发重新握手并打开闸门，而不是被静默丢掉。
    let nextRequest = request;
    if (isFirstVisitVerificationEnabled()) {
      const headers = new Headers(request.headers);
      const ipVerificationHeaders = await buildIpVerificationHeaders();

      Object.entries(ipVerificationHeaders).forEach(([key, value]) => {
        if (!headers.has(key)) {
          headers.set(key, value);
        }
      });

      nextRequest = new Request(request, { headers });
    }

    const response = await originalFetch(nextRequest);
    await maybeHandleBlockedResponse(response, url);
    return response;
  };
}

installIpVerificationTransport();

// G9-21：模块加载即预取指纹，让 FingerprintJS 的 canvas/WebGL 采集与 React 首屏渲染并行，
// 避免首个后端请求的拦截器里串行等待指纹计算。
if (typeof window !== 'undefined') {
  void getFingerprint();
}
