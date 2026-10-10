/**
 * 前端 step-up 编排（B5 / RC-08 / RC-46）。
 *
 * 三件事严格分开：
 * 1. **票据收集**：并发被拦的写请求各带一枚服务端签名的 `challengeTicket`，
 *    这里把它们收进同一个队列 —— 用户只该看到**一个**弹窗；
 * 2. **一次验证**：`StepUpGate` 用 `ManagedCaptcha scenario="step_up"` 解一次，
 *    把队列里所有票据一起提交换一枚 grant；
 * 3. **重放**：等待中的请求拿到同一枚 grant，各自带 `X-Step-Up-Grant` 重放。
 *
 * 为什么可以重放**非幂等**写请求：命中闸门的 403 发生在 `authenticateToken` 内、
 * 业务 handler **之前**，这次请求根本没有产生副作用 —— 重放的是“第一次执行”，
 * 不是“把已经成功的写再做一次”。（`api.ts` 里“非幂等不自动重试”的规则针对的是
 * 5xx/超时，那些情况下请求可能已经落库。）
 */

export interface StepUpRequiredDetail {
  scenario?: string;
  scope?: string;
  routeKey?: string;
  challengeTicket?: string;
  challengeType?: string;
  expiresAt?: number;
  pow?: { seed: string; difficulty: number };
  /** 原生/脚本客户端：弹不出验证控件，应降级为只读（RC-09）。 */
  unsupported?: string;
}

export interface StepUpGrant {
  grantId: string;
  expiresAt: number;
  remainingUses: number;
}

export class StepUpUnsupportedError extends Error {
  constructor() {
    super('当前客户端无法完成交互式验证');
    this.name = 'StepUpUnsupportedError';
  }
}

export class StepUpCancelledError extends Error {
  constructor(message = '已取消验证') {
    super(message);
    this.name = 'StepUpCancelledError';
  }
}

const EVENT_NAME = 'synapse:step-up-required';
/** grant 只服务“这批已排队的请求”：排队上限与后端 D22 的次数上限一致。 */
const MAX_PENDING_TICKETS = 5;

let pendingTickets: string[] = [];
let waiters: Array<{ resolve: (grant: StepUpGrant) => void; reject: (error: Error) => void }> = [];
let activeGrant: StepUpGrant | null = null;
let modalRequested = false;

export function isStepUpRequiredPayload(data: unknown): data is StepUpRequiredDetail {
  if (!data || typeof data !== 'object') return false;
  return (data as { code?: unknown }).code === 'STEP_UP_REQUIRED';
}

export function emitStepUpRequired(detail: StepUpRequiredDetail): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<StepUpRequiredDetail>(EVENT_NAME, { detail }));
}

export function onStepUpRequired(handler: (detail: StepUpRequiredDetail) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const listener = (event: Event) => handler((event as CustomEvent<StepUpRequiredDetail>).detail);
  window.addEventListener(EVENT_NAME, listener);
  return () => window.removeEventListener(EVENT_NAME, listener);
}

/** 一眼看出是否已经弹过窗：并发的第二个请求不该再触发一次弹窗。 */
export function hasOpenStepUpModal(): boolean {
  return modalRequested;
}

/**
 * 登记一次被拦请求并等待 grant。
 *
 * - `unsupported === "interactive"`（原生客户端）直接拒绝：调用方应降级为只读，
 *   而不是等一个永远弹不出的弹窗；
 * - 已经拿到 grant 且未过期时立即返回（同一批请求共用）；
 * - 首个票据触发弹窗，后续票据只入队（去重）。
 */
export function requestStepUpGrant(detail: StepUpRequiredDetail): Promise<StepUpGrant> {
  if (detail.unsupported === 'interactive') {
    return Promise.reject(new StepUpUnsupportedError());
  }
  if (activeGrant && activeGrant.expiresAt > Date.now()) {
    return Promise.resolve(activeGrant);
  }

  const ticket = typeof detail.challengeTicket === 'string' ? detail.challengeTicket : '';
  if (ticket && !pendingTickets.includes(ticket) && pendingTickets.length < MAX_PENDING_TICKETS) {
    pendingTickets.push(ticket);
  }

  const promise = new Promise<StepUpGrant>((resolve, reject) => {
    waiters.push({ resolve, reject });
  });

  if (!modalRequested) {
    modalRequested = true;
    // 让所有同步被拦的请求先入队，再弹窗（否则先弹的窗口里只有一枚票据）。
    queueMicrotask(() => emitStepUpRequired(detail));
  }

  return promise;
}

export function takePendingTickets(): string[] {
  const tickets = [...pendingTickets];
  pendingTickets = [];
  return tickets;
}

export function pendingTicketCount(): number {
  return pendingTickets.length;
}

export function waitingRequestCount(): number {
  return waiters.length;
}

export function completeStepUp(grant: StepUpGrant): void {
  activeGrant = grant;
  modalRequested = false;
  const current = waiters;
  waiters = [];
  current.forEach(({ resolve }) => resolve(grant));
}

export function failStepUp(error: Error): void {
  modalRequested = false;
  pendingTickets = [];
  const current = waiters;
  waiters = [];
  current.forEach(({ reject }) => reject(error));
}

/**
 * 队列排空后主动作废 grant（不缓存到过期）。
 * 失败只是“多挂 30 秒”，不影响用户，因此不向调用方抛错。
 */
export function consumeStepUpGrantForDiscard(): string | null {
  if (waiters.length > 0) return null;
  const grantId = activeGrant?.grantId ?? null;
  activeGrant = null;
  return grantId;
}

/** 测试/登出用：把编排状态清干净，避免旧 grant 穿透到下一个用户。 */
export function resetStepUpState(): void {
  pendingTickets = [];
  waiters = [];
  activeGrant = null;
  modalRequested = false;
}

/** 哈希前导零**比特**数（与后端 `stepUpService.leadingZeroBits` 同一判据）。 */
export function leadingZeroBits(bytes: Uint8Array): number {
  let bits = 0;
  for (const byte of bytes) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    bits += Math.clz32(byte) - 24;
    break;
  }
  return bits;
}

/**
 * 浏览器侧解 hashcash 前像难度（RC-36 / RC-54）。
 *
 * 注意术语：这是“找 nonce 使摘要前缀有 N 个零比特”，不是“哈希碰撞”。
 * 每 64 次让出一次主线程 —— 验证页面本来就要和验证码控件抢主线程（`CLAUDE.md` 已记录该教训）。
 */
export async function solveStepUpPow(seed: string, difficulty: number, maxAttempts = 4_000_000): Promise<string> {
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    throw new Error('pow_unavailable');
  }
  const target = Math.max(0, Math.min(32, Math.round(Number(difficulty) || 0)));
  const encoder = new TextEncoder();
  for (let nonce = 0; nonce < maxAttempts; nonce += 1) {
    const value = String(nonce);
    const digest = await crypto.subtle.digest('SHA-256', encoder.encode(`${seed}:${value}`));
    if (leadingZeroBits(new Uint8Array(digest)) >= target) return value;
    if ((nonce & 63) === 63) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('pow_exhausted');
}
