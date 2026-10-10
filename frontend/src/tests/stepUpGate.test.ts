import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  StepUpUnsupportedError,
  completeStepUp,
  failStepUp,
  isStepUpRequiredPayload,
  leadingZeroBits,
  onStepUpRequired,
  resetStepUpState,
  requestStepUpGrant,
  solveStepUpPow,
  takePendingTickets,
  waitingRequestCount,
} from '../utils/stepUp';

/**
 * step-up 前端编排（B5 / RC-08 / RC-46）。
 *
 * 重点覆盖三条容易回归的性质：
 * 1. 并发被拦的多个请求**只弹一个窗**，且票据全部进入同一批；
 * 2. 同一枚 grant 被这批请求共用，用完/取消后状态清干净（不穿透到下一个用户）；
 * 3. 原生客户端（unsupported: interactive）直接拒绝，不等一个弹不出的弹窗。
 */

const detail = (ticket: string) => ({
  scenario: 'step_up',
  routeKey: '/api/tts/generate',
  challengeTicket: ticket,
  challengeType: 'captcha',
  expiresAt: Date.now() + 120_000,
});

afterEach(() => {
  resetStepUpState();
  vi.restoreAllMocks();
});

describe('isStepUpRequiredPayload', () => {
  it('只认稳定 code（不靠文案匹配）', () => {
    expect(isStepUpRequiredPayload({ code: 'STEP_UP_REQUIRED' })).toBe(true);
    expect(isStepUpRequiredPayload({ code: 'STEP_UP_UNAVAILABLE' })).toBe(false);
    expect(isStepUpRequiredPayload(null)).toBe(false);
    expect(isStepUpRequiredPayload('需要验证')).toBe(false);
  });
});

describe('票据收集与单例弹窗', () => {
  it('并发多个被拦请求只 emit 一次，票据全部入队', async () => {
    const handler = vi.fn();
    const unsubscribe = onStepUpRequired(handler);

    const first = requestStepUpGrant(detail('t1'));
    const second = requestStepUpGrant(detail('t2'));
    const third = requestStepUpGrant(detail('t3'));

    // emit 走 queueMicrotask，等一个微任务让三条登记都完成。
    await Promise.resolve();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(takePendingTickets()).toEqual(['t1', 't2', 't3']);
    expect(waitingRequestCount()).toBe(3);

    completeStepUp({ grantId: 'g1', expiresAt: Date.now() + 30_000, remainingUses: 3 });
    const [a, b, c] = await Promise.all([first, second, third]);
    expect(a.grantId).toBe('g1');
    expect(b.grantId).toBe('g1');
    expect(c.grantId).toBe('g1');
    expect(waitingRequestCount()).toBe(0);
    unsubscribe();
  });

  it('已持有有效 grant 时直接复用，不再弹窗', async () => {
    const handler = vi.fn();
    const unsubscribe = onStepUpRequired(handler);
    completeStepUp({ grantId: 'g2', expiresAt: Date.now() + 30_000, remainingUses: 2 });

    const grant = await requestStepUpGrant(detail('t4'));
    expect(grant.grantId).toBe('g2');
    expect(handler).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('票据去重且不超过 5 枚（与后端 D22 的次数上限一致）', async () => {
    const handler = vi.fn();
    const unsubscribe = onStepUpRequired(handler);
    const requests = ['t1', 't1', 't2', 't3', 't4', 't5', 't6'].map((ticket) => requestStepUpGrant(detail(ticket)));
    await Promise.resolve();
    expect(takePendingTickets()).toEqual(['t1', 't2', 't3', 't4', 't5']);
    failStepUp(new Error('cancel'));
    await Promise.allSettled(requests);
    unsubscribe();
  });

  it('取消验证时所有等待者都被拒绝（不静默吞掉）', async () => {
    const unsubscribe = onStepUpRequired(() => {});
    const pending = requestStepUpGrant(detail('t9'));
    await Promise.resolve();
    failStepUp(new Error('已取消验证'));
    await expect(pending).rejects.toThrow('已取消验证');
    // 状态清干净：下一次请求会重新弹窗
    const handler = vi.fn();
    unsubscribe();
    const next = onStepUpRequired(handler);
    const retry = requestStepUpGrant(detail('t10'));
    await Promise.resolve();
    expect(handler).toHaveBeenCalledTimes(1);
    completeStepUp({ grantId: 'g3', expiresAt: Date.now() + 30_000, remainingUses: 1 });
    await retry;
    next();
  });

  it('原生客户端（unsupported: interactive）直接拒绝，不触发弹窗', async () => {
    const handler = vi.fn();
    const unsubscribe = onStepUpRequired(handler);
    await expect(requestStepUpGrant({ ...detail('t11'), unsupported: 'interactive' })).rejects.toBeInstanceOf(
      StepUpUnsupportedError,
    );
    expect(handler).not.toHaveBeenCalled();
    unsubscribe();
  });
});

describe('PoW 路线（RC-36 / RC-54）', () => {
  it('前导零比特计数与后端同口径', () => {
    expect(leadingZeroBits(new Uint8Array([0b1000_0000]))).toBe(0);
    expect(leadingZeroBits(new Uint8Array([0b0100_0000]))).toBe(1);
    expect(leadingZeroBits(new Uint8Array([0x00, 0b0010_0000]))).toBe(10);
  });

  const subtleAvailable = typeof globalThis.crypto !== 'undefined' && !!globalThis.crypto.subtle;
  it.skipIf(!subtleAvailable)('能找到满足难度的 nonce（找不清则报错，不静默返回）', async () => {
    const nonce = await solveStepUpPow('test-seed', 8);
    const digest = await globalThis.crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(`test-seed:${nonce}`),
    );
    expect(leadingZeroBits(new Uint8Array(digest))).toBeGreaterThanOrEqual(8);
  });

  it('难度 0 时立刻返回（不必计算）', async () => {
    if (!subtleAvailable) return;
    await expect(solveStepUpPow('seed', 0)).resolves.toBe('0');
  });
});
