import { useEffect, useRef } from 'react';
import getApiBaseUrl from '../api';
import { fetchWithTimeout } from '../utils/fetchWithTimeout';
import { normalizeWebSocketUrl } from '../utils/webSocketUrl';

/**
 * 客户端出口探测（网络出口 / IPv6 出口 / WebSocket 请求泄露 / WebRTC 泄露），无可见 UI，
 * 一个会话最多上报一次。契约见 .audit-reports/synapse-proxycheck-2026-09-25.md §5/§6。
 *
 * 探测流程刻意挂在模块级 promise 上、而不是 React effect 的生命周期里：React 19 StrictMode 会
 * 双跑 effect（mount → cleanup → mount），若把取消逻辑挂进 cleanup，第一轮探测会被中途掐断，
 * 第二轮又被 startedRef 挡掉，整轮探测就丢了。探测本身有界（最坏约 10s）且全程只 console.debug，
 * 不随组件卸载停止没有副作用。
 */

const PROBE_SESSION_STORAGE_KEY = 'synapse_ip_probe_v1';

const DEFAULT_PROBE_CONFIG_PATH = '/api/ip-risk/probe-config';
const DEFAULT_ECHO_PATH = '/api/ip-risk/echo';
const DEFAULT_REPORT_PATH = '/api/ip-risk/report';
const DEFAULT_WS_PROBE_PATH = '/ws/ip-probe';

const CONFIG_TIMEOUT_MS = 5000;
const ECHO_TIMEOUT_MS = 8000;
const REPORT_TIMEOUT_MS = 8000;
const WS_PROBE_TIMEOUT_MS = 10000;
const WEBRTC_PROBE_TIMEOUT_MS = 5000;

const MAX_LANGUAGES = 10;
const MAX_USER_AGENT_LENGTH = 512;
/**
 * 多个公开 STUN server：Google / Cloudflare 在部分网络（如中国大陆）不可达，
 * 补入国内公开 STUN（小米路由、bilibili）确保各网络环境下都能拿到 srflx 公网映射候选。
 * 单个 RTCPeerConnection 会向全部 STUN 并行收集候选，结果按地址去重。
 */
const WEBRTC_STUN_SERVERS: readonly string[] = [
  'stun:stun.l.google.com:19302',
  'stun:stun.cloudflare.com:3478',
  'stun:stun.miwifi.com:3478',
  'stun:stun.chat.bilibili.com:3478',
];

const IPV4_LITERAL = /^\d{1,3}(?:\.\d{1,3}){3}$/;
// 至少两个冒号才算 IPv6 字面量（排除 host:port 之类的误命中）。
const IPV6_LITERAL = /^[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}$/i;
// RFC1918 私网 + 环回 + 链路本地：这些地址不可能是「出口 IP」，不参与泄露判定。
const PRIVATE_IPV4_PATTERN = /^(?:10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/;
// IPv6 非公网段：环回 ::1、未指定 ::、链路本地 fe80::/10、唯一本地 fc00::/7。
const PRIVATE_IPV6_PATTERN = /^(?:::1?$|fe[89ab]|f[cd])/i;

interface ClientProbeConfig {
  enabled?: boolean;
  hmacEnabled?: boolean;
  echoPath?: string;
  reportPath?: string;
  wsProbePath?: string;
}

interface ProbeConfigResponse {
  success?: boolean;
  data?: ClientProbeConfig;
}

interface ProbeEchoObserved {
  ipv4?: string | null;
  ipv6?: string | null;
  socket?: string | null;
  primary?: string | null;
  isProxyHeader?: boolean;
  headers?: Record<string, string>;
  warning?: string[];
}

interface ProbeEchoProbe {
  probeId?: string;
  probeKey?: string;
  nonce?: string;
  expiresInSec?: number;
}

interface ProbeEchoResponse {
  success?: boolean;
  data?: ProbeEchoObserved;
  probe?: ProbeEchoProbe;
}

interface ClientProbeFingerprint {
  timezone: string;
  timezoneOffsetMin: number;
  languages: string[];
  userAgent: string;
  uaPlatform: string;
  hardwareConcurrency: number;
  deviceMemory: number | null;
  screenRes: string;
  webdriver: boolean;
  collectedAt: string;
}

interface ClientProbePayload extends ClientProbeFingerprint {
  httpExitIp: string | null;
  wsExitIp: string | null;
  ipv6Exit: string | null;
  webrtcLeak: boolean;
  /** WebRTC host 候选暴露的地址（局域网/本机；mDNS 混淆下通常为空）。 */
  webrtcHostIps: string[];
  /** WebRTC srflx 候选——经 STUN 观测到的公网映射地址，是真正的泄露向量。 */
  webrtcSrflxIps: string[];
}

interface ClientProbeReportBody {
  probeId: string;
  nonce: string;
  payload: ClientProbePayload;
  signature: string;
}

function debugLog(message: string, detail?: unknown): void {
  if (detail === undefined) {
    console.debug(`[ClientOriginProbe] ${message}`);
    return;
  }
  console.debug(`[ClientOriginProbe] ${message}`, detail);
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** 路径只接受我们自己下发的站内相对路径，绝不接受配置里塞进来的绝对 URL。 */
function resolveEndpointPath(configured: string | undefined, fallback: string): string {
  return typeof configured === 'string' && configured.startsWith('/') ? configured : fallback;
}

function isPrivateIpv4(ip: string): boolean {
  return PRIVATE_IPV4_PATTERN.test(ip);
}

/** 私网 / 环回 / 链路本地（v4 与 v6 通吃）：不是任何客户端的出口，不参与泄露判定。 */
function isPrivateIp(ip: string): boolean {
  return ip.includes(':') ? PRIVATE_IPV6_PATTERN.test(ip) : isPrivateIpv4(ip);
}

function isIpLiteral(value: string): boolean {
  return IPV4_LITERAL.test(value) || IPV6_LITERAL.test(value);
}

/**
 * 从 ICE 候选里抠出连接地址：优先用 RTCIceCandidate.address；mDNS 混淆的 host 候选
 * （xxx.local）拿不到真实 IP，返回 null。老浏览器 address 为空时回退解析 candidate SDP 行
 * （candidate:foundation component transport priority CONN-ADDR port typ TYPE …）。
 */
function extractCandidateIp(candidate: RTCIceCandidate): string | null {
  const address = (candidate.address ?? '').trim();
  if (address && !address.endsWith('.local') && isIpLiteral(address)) return address;
  const raw = candidate.candidate ?? '';
  const connAddr = raw.split(' ')[4] ?? '';
  if (connAddr && !connAddr.endsWith('.local') && isIpLiteral(connAddr)) return connAddr;
  return null;
}

async function fetchProbeJson<T>(path: string, timeoutMs: number): Promise<T | null> {
  try {
    const response = await fetchWithTimeout(
      `${getApiBaseUrl()}${path}`,
      {
        credentials: 'include',
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
      },
      timeoutMs,
    );
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

function buildProbeWebSocketUrl(path: string): string {
  // 与 hooks/useWebSocket.ts 的 getWsUrl 同源：base 去尾斜杠 + 共享的 normalizeWebSocketUrl
  // （它负责 http→ws / https→wss 的协议映射，并剥掉 URL 里的凭据参数）。
  const wsBase = getApiBaseUrl().replace(/\/+$/, '');
  return normalizeWebSocketUrl(`${wsBase}${path}`, window.location.origin);
}

function readWsObservedPrimary(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const message = parsed as { type?: unknown; observed?: unknown };
    if (message.type !== 'ip-probe') return null;
    const observed = message.observed;
    if (!observed || typeof observed !== 'object') return null;
    return asNonEmptyString((observed as { primary?: unknown }).primary);
  } catch {
    return null;
  }
}

function createProbeSocket(url: string): WebSocket | null {
  try {
    return new WebSocket(url);
  } catch {
    return null;
  }
}

/** 连一次 /ws/ip-probe，取服务端观测到的 WS 出口地址；超时/出错/被关闭一律 null，不阻塞后续步骤。 */
function probeWebSocketExitIp(path: string): Promise<string | null> {
  return new Promise((resolve) => {
    const socket = createProbeSocket(buildProbeWebSocketUrl(path));
    if (!socket) {
      resolve(null);
      return;
    }

    let settled = false;
    // 定时器显式声明为 number：本仓 CI 曾两次因 ReturnType<typeof setTimeout> 解析为 Timeout 而失败。
    let timer: number | null = null;

    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      try {
        socket.close();
      } catch {
        // 连接已关闭
      }
      resolve(value);
    };

    timer = window.setTimeout(() => finish(null), WS_PROBE_TIMEOUT_MS);

    socket.onmessage = (event) => finish(readWsObservedPrimary(event.data));
    socket.onerror = () => finish(null);
    socket.onclose = () => finish(null);
  });
}

interface WebRtcProbeResult {
  /** type=host 候选暴露的地址（局域网/本机；mDNS 混淆下通常为空）。 */
  hostIps: string[];
  /** type=srflx 候选——经 STUN 观测到的公网映射地址，真正的泄露向量。 */
  srflxIps: string[];
}

function createProbePeerConnection(): RTCPeerConnection | null {
  try {
    return new RTCPeerConnection({ iceServers: [{ urls: [...WEBRTC_STUN_SERVERS] }] });
  } catch {
    return null;
  }
}

/**
 * 静默收集 WebRTC ICE 候选：host（局域网/本机）与 srflx（经 STUN 观测到的公网映射地址）。
 * srflx 是真正的泄露向量——即便浏览器普通流量走了代理/VPN，STUN 请求也可能沿真实链路发出，
 * 从而暴露真实公网出口。mDNS 混淆下 host 候选拿不到 IP，会自然为空；ICE 收集完成或超时即结束。
 */
function probeWebRtc(): Promise<WebRtcProbeResult> {
  return new Promise((resolve) => {
    const pc = createProbePeerConnection();
    if (!pc) {
      resolve({ hostIps: [], srflxIps: [] });
      return;
    }

    const hostIps = new Set<string>();
    const srflxIps = new Set<string>();
    let settled = false;
    let timer: number | null = null;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
      pc.onicecandidate = null;
      pc.onicegatheringstatechange = null;
      try {
        pc.close();
      } catch {
        // 连接已关闭
      }
      resolve({ hostIps: [...hostIps], srflxIps: [...srflxIps] });
    };

    timer = window.setTimeout(finish, WEBRTC_PROBE_TIMEOUT_MS);

    pc.onicecandidate = (event) => {
      const candidate = event.candidate;
      // 空/结束候选：ICE 收集完成信号。
      if (!candidate || !candidate.candidate) {
        finish();
        return;
      }
      const type = candidate.type;
      if (type !== 'host' && type !== 'srflx') return;
      const ip = extractCandidateIp(candidate);
      if (!ip) return;
      if (type === 'host') hostIps.add(ip);
      else srflxIps.add(ip);
    };

    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === 'complete') finish();
    };

    try {
      // 无 m-line 不会触发 ICE 收集；建一个数据通道即可让浏览器发起 STUN 询问。
      pc.createDataChannel('probe');
      void pc
        .createOffer()
        .then((offer) => pc.setLocalDescription(offer))
        .catch(() => finish());
    } catch {
      finish();
    }
  });
}

function collectLocalFingerprint(): ClientProbeFingerprint {
  const nav = navigator as Navigator & { deviceMemory?: number };
  return {
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    timezoneOffsetMin: new Date().getTimezoneOffset(),
    languages: Array.from(navigator.languages ?? []).slice(0, MAX_LANGUAGES),
    userAgent: navigator.userAgent.slice(0, MAX_USER_AGENT_LENGTH),
    uaPlatform: navigator.platform,
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : null,
    screenRes: `${window.screen.width}x${window.screen.height}`,
    webdriver: navigator.webdriver === true,
    collectedAt: new Date().toISOString(),
  };
}

/**
 * canonical 规则（必须与服务端 clientProbeService.canonicalizePayload 逐字一致）：
 * 对象键按 Object.keys().sort() 升序；字符串用 JSON.stringify；undefined/null 一律写 null；
 * 数组保持顺序；嵌套对象递归。产出 = JSON.stringify(canonicalize(payload))（UTF-8）。
 */
function canonicalizePayload(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) return value.map((item) => canonicalizePayload(item));
  if (typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const canonical: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      canonical[key] = canonicalizePayload(source[key]);
    }
    return canonical;
  }
  return value;
}

function hexToBytes(hex: string) {
  const normalized = hex.trim();
  const bytes = new Uint8Array(Math.floor(normalized.length / 2));
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(normalized.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** signature = HMAC-SHA256(probeKey, canonical(payload)) 的 64 位小写 hex；WebCrypto 不可用时返回 null。 */
async function signPayloadHex(probeKeyHex: string, canonicalJson: string): Promise<string | null> {
  if (typeof crypto === 'undefined' || !crypto.subtle) return null;
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      hexToBytes(probeKeyHex) as BufferSource,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(canonicalJson));
    return toHex(new Uint8Array(signature));
  } catch {
    return null;
  }
}

async function postProbeReport(path: string, body: ClientProbeReportBody): Promise<unknown> {
  try {
    const response = await fetchWithTimeout(
      `${getApiBaseUrl()}${path}`,
      {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify(body),
      },
      REPORT_TIMEOUT_MS,
    );
    if (!response.ok) return null;
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}

let probeConfigPromise: Promise<ClientProbeConfig | null> | null = null;
let probeRunPromise: Promise<void> | null = null;

/** 单飞：一次页面生命周期内只拉一次 probe-config。 */
function loadProbeConfig(): Promise<ClientProbeConfig | null> {
  if (!probeConfigPromise) {
    probeConfigPromise = fetchProbeJson<ProbeConfigResponse>(DEFAULT_PROBE_CONFIG_PATH, CONFIG_TIMEOUT_MS)
      .then((response) => response?.data ?? null)
      .catch(() => null);
  }
  return probeConfigPromise;
}

/** sessionStorage 读写会抛（隐私模式/被禁用），必须 try/catch；不可用时退化为「每次挂载跑一次」。 */
function claimProbeSession(): boolean {
  try {
    if (window.sessionStorage.getItem(PROBE_SESSION_STORAGE_KEY)) return false;
    window.sessionStorage.setItem(PROBE_SESSION_STORAGE_KEY, new Date().toISOString());
    return true;
  } catch {
    return true;
  }
}

async function runClientOriginProbe(): Promise<void> {
  try {
    const config = await loadProbeConfig();
    if (config?.enabled !== true) {
      debugLog('探测未启用或 probe-config 不可用，跳过');
      return;
    }

    if (!claimProbeSession()) {
      debugLog('本会话已探测过，跳过');
      return;
    }

    const echo = await fetchProbeJson<ProbeEchoResponse>(
      resolveEndpointPath(config.echoPath, DEFAULT_ECHO_PATH),
      ECHO_TIMEOUT_MS,
    );
    const observed = echo?.data;
    if (!observed) {
      debugLog('echo 探测失败，无需上报');
      return;
    }

    const httpExitIp = asNonEmptyString(observed.primary);
    const ipv6Exit = asNonEmptyString(observed.ipv6);

    const wsExitIp = await probeWebSocketExitIp(resolveEndpointPath(config.wsProbePath, DEFAULT_WS_PROBE_PATH));

    const webrtc = await probeWebRtc();
    // WebRTC 暴露的公网地址（srflx 为主，公网 host 候选同样算）：私网/环回/链路本地不参与判定。
    const webrtcPublicIps = [...webrtc.srflxIps, ...webrtc.hostIps].filter((ip) => !isPrivateIp(ip));
    // 泄露 = 已知 HTTP 出口 IP 时，WebRTC 暴露了与之不同的公网地址（权威判定在服务端）。
    const webrtcLeak = httpExitIp !== null && webrtcPublicIps.some((ip) => ip !== httpExitIp);

    const payload: ClientProbePayload = {
      httpExitIp,
      wsExitIp,
      ipv6Exit,
      webrtcLeak,
      webrtcHostIps: webrtc.hostIps,
      webrtcSrflxIps: webrtc.srflxIps,
      ...collectLocalFingerprint(),
    };

    debugLog('探测结果', {
      httpExitIp,
      wsExitIp,
      ipv6Exit,
      // 只是「两侧地址不同」的原始事实：两侧同口径（升级路径同样按 trust proxy 解析），
      // 正常情况下应当相等，不等即值得排查；但不构成泄漏结论（判定在服务端，见 comparability）。
      wsExitDiffersFromHttp: wsExitIp !== null && wsExitIp !== httpExitIp,
      webrtcHostIps: webrtc.hostIps,
      webrtcSrflxIps: webrtc.srflxIps,
      webrtcPublicIps,
      webrtcLeak,
      observationWarnings: observed.warning ?? [],
    });

    // hmacEnabled=false 时后端固定 403，不发这个注定被拒的请求。
    if (config.hmacEnabled !== true) {
      debugLog('hmac 未启用，跳过上报');
      return;
    }

    const probeId = asNonEmptyString(echo?.probe?.probeId);
    const nonce = asNonEmptyString(echo?.probe?.nonce);
    const probeKey = asNonEmptyString(echo?.probe?.probeKey);
    if (!probeId || !nonce || !probeKey) {
      debugLog('缺少探测会话凭证，跳过上报');
      return;
    }

    const signature = await signPayloadHex(probeKey, JSON.stringify(canonicalizePayload(payload)));
    if (!signature) {
      debugLog('签名不可用（非安全上下文或 WebCrypto 缺失），跳过上报');
      return;
    }

    const result = await postProbeReport(resolveEndpointPath(config.reportPath, DEFAULT_REPORT_PATH), {
      probeId,
      nonce,
      payload,
      signature,
    });
    debugLog('上报完成', result ?? '未收到响应');
  } catch (error) {
    debugLog('探测流程异常', error);
  }
}

function startClientOriginProbe(): Promise<void> {
  if (!probeRunPromise) {
    probeRunPromise = runClientOriginProbe();
  }
  return probeRunPromise;
}

export function ClientOriginProbe() {
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void startClientOriginProbe();
  }, []);

  return null;
}
