import { useCallback, useEffect, useRef, useState } from 'react';
import ManagedCaptcha, { type ManagedCaptchaChallenge, type ManagedCaptchaRef } from './ManagedCaptcha';
import {
  completeStepUp,
  consumeStepUpGrantForDiscard,
  failStepUp,
  onStepUpRequired,
  solveStepUpPow,
  takePendingTickets,
  type StepUpRequiredDetail,
} from '../utils/stepUp';
import { api } from '../api/api';
import {
  studioModalCardClassName,
  studioModalOverlayClassName,
  studioEyebrowClassName,
  studioDisplayFont,
  studioPrimaryButtonClassName,
  studioGhostButtonClassName,
  studioSoftBadgeClassName,
} from './studioTheme';

/**
 * 全局逐步验证弹窗（B5 / RC-08）。
 *
 * 为什么必须是**全局单例**：并发的写请求会各自收到 403 STEP_UP_REQUIRED，
 * 若每个请求各弹一个窗，用户要解 N 次人机验证。这里只保留一个弹窗，
 * 把队列里所有票据一起提交换一枚 grant，再让各请求带同一枚 grant 重放（RC-46）。
 *
 * 复用 `ManagedCaptcha` 的历史修复（一次性令牌消费、过期信号、并发单飞），
 * scenario 固定 `step_up`（供应商白名单默认 trycap / Turnstile，RC-24）。
 */
const StepUpGate = () => {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<StepUpRequiredDetail | null>(null);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [challenge, setChallenge] = useState<ManagedCaptchaChallenge | null>(null);
  const [powNonce, setPowNonce] = useState<string | null>(null);
  const [powSolving, setPowSolving] = useState(false);
  const captchaRef = useRef<ManagedCaptchaRef>(null);

  useEffect(() => {
    const unsubscribe = onStepUpRequired((payload) => {
      setDetail(payload);
      setError('');
      setChallenge(null);
      setPowNonce(null);
      captchaRef.current?.reset();
      setOpen(true);
    });
    return unsubscribe;
  }, []);

  // PoW 路线（RC-36/RC-54）：客户端声明 x-step-up-type: pow 时服务端发来 seed 与难度，
  // 这里在浏览器里算前像难度。低端设备上可能耗时较长，因此只在用户显式走这条路时才做。
  useEffect(() => {
    const pow = detail?.pow;
    if (!open || detail?.challengeType !== 'pow' || !pow) return;
    let cancelled = false;
    setPowSolving(true);
    solveStepUpPow(pow.seed, pow.difficulty)
      .then((nonce) => {
        if (!cancelled) setPowNonce(nonce);
      })
      .catch(() => {
        if (!cancelled) setError('工作量证明计算失败，请重试');
      })
      .finally(() => {
        if (!cancelled) setPowSolving(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, detail]);

  const close = useCallback((reason: string) => {
    setOpen(false);
    setDetail(null);
    setSubmitting(false);
    setChallenge(null);
    setPowNonce(null);
    captchaRef.current?.reset();
    failStepUp(new Error(reason));
  }, []);

  const submit = useCallback(async () => {
    if (submitting) return;
    const isPow = detail?.challengeType === 'pow';
    if (!isPow && !challenge) return;
    if (isPow && !powNonce) return;
    setSubmitting(true);
    setError('');
    try {
      const tickets = takePendingTickets();
      const body: Record<string, unknown> = { challengeTickets: tickets };
      if (isPow) body.powNonce = powNonce;
      else {
        body.captchaToken = challenge?.token;
        body.captchaProvider = challenge?.provider;
      }
      const response = await api.post('/api/step-up/grant', body);
      const grant = response?.data;
      if (!grant?.grantId) {
        throw new Error('验证服务返回异常，请重试');
      }
      completeStepUp({
        grantId: String(grant.grantId),
        expiresAt: Number(grant.expiresAt) || Date.now() + 30_000,
        remainingUses: Number(grant.remainingUses) || 1,
      });
      setOpen(false);
      setDetail(null);
      setChallenge(null);
      setPowNonce(null);
      captchaRef.current?.reset(challenge?.token);

      // 队列排空即主动作废 grant，不让它白挂到过期（RC-46 补遗）。
      // 留 2 秒窗口：重放中的请求需要它把 X-Step-Up-Grant 用掉。
      setTimeout(() => {
        const grantId = consumeStepUpGrantForDiscard();
        if (!grantId) return;
        void api.post('/api/step-up/discard', { grantId }).catch(() => {
          // 作废失败只是“多挂 30 秒”，不影响用户。
        });
      }, 2_000);
    } catch (submitError: unknown) {
      const message =
        (submitError as { response?: { data?: { error?: string } } })?.response?.data?.error ||
        (submitError instanceof Error ? submitError.message : '验证失败，请重试');
      setError(message);
      // 令牌已被消费（不论成功与否），必须换一张新挑战再试。
      captchaRef.current?.reset(challenge?.token);
      setChallenge(null);
      setPowNonce(null);
    } finally {
      setSubmitting(false);
    }
  }, [challenge, detail, powNonce, submitting]);

  if (!open) return null;

  const isPow = detail?.challengeType === 'pow';

  return (
    <div
      className={studioModalOverlayClassName}
      role="dialog"
      aria-modal="true"
      aria-labelledby="step-up-title"
      data-testid="step-up-gate"
    >
      <div className={`${studioModalCardClassName} max-w-md`}>
        <div className="flex items-start gap-3">
          <div className={studioSoftBadgeClassName} aria-hidden="true">
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.7">
              <path d="M12 3l7 3v6c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6l7-3z" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M9.5 12.2l1.8 1.8 3.4-3.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <div className="min-w-0 flex-1">
            <p className={studioEyebrowClassName}>Account verification</p>
            <h2 id="step-up-title" className={`${studioDisplayFont} mt-1 text-lg text-slate-900`}>
              需要完成一次人机验证
            </h2>
            <p className="mt-1 text-[13px] leading-relaxed text-slate-600">
              为保护账户安全，本次操作需要先验证。完成后原来的操作会自动继续，无需重新填写。
            </p>
          </div>
        </div>

        <div className="mt-4">
          {isPow ? (
            <p className="text-[13px] text-slate-600">
              {powSolving
                ? '正在计算工作量证明，请稍候（通常 2～5 秒）。'
                : '工作量证明已计算完成，请提交。'}
            </p>
          ) : (
            <ManagedCaptcha
              ref={captchaRef}
              scenario="step_up"
              compact
              onSolved={(solved) => {
                setChallenge(solved);
              }}
              onCleared={() => {
                setChallenge(null);
              }}
            />
          )}
        </div>

        {error ? (
          <p className="mt-3 rounded-2xl border-2 border-rose-100 bg-rose-50/70 px-4 py-3 text-[13px] text-rose-700" role="alert">
            {error}
          </p>
        ) : null}

        <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            className={studioGhostButtonClassName}
            onClick={() => close('已取消验证')}
            disabled={submitting}
          >
            暂不验证
          </button>
          <button
            type="button"
            className={studioPrimaryButtonClassName}
            onClick={submit}
            disabled={submitting || (isPow ? !powNonce : !challenge)}
          >
            {submitting ? '验证中…' : isPow && powSolving ? '计算中…' : '提交验证'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default StepUpGate;
