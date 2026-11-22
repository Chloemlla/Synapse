import React, { useCallback, useState } from 'react';
import { FaGavel } from 'react-icons/fa';
import { api, getApiBaseUrl } from '@/api/api';
import {
  studioFieldClassName,
  studioPrimaryButtonClassName,
  studioSecondaryButtonClassName,
  studioTextareaClassName,
} from '@/components/studioTheme';
import { StudioErrorNote, StudioModal } from '@/components/studioFeedback';
import { useNotification } from '@/components/Notification';
import { cn } from '@/lib/utils';
import { getBackendErrorMessage } from '@/utils/backendError';
import { ACTION_LABELS, tierConfig } from './format';
import { FieldGrid, FieldRow } from './ui';

/**
 * 账户处置抽屉（页面 `/admin/account-risk`）。
 *
 * **不新增处罚出口**：这里调的是用户管理页已有的
 * `POST /api/admin/users/:id/translation-penalty`（历史命名，承载 RC-07 全部风险动作），
 * 服务端仍会走 `applyAccountRiskAction`
 * 这一个唯一出口（写档位 + security_events + 审计 + 必要时撤销会话）。
 * 面板只是把它搬到排查现场，省掉「翻到用户页再搜人」的一跳。
 *
 * 权限：该端点要求 `authenticateSuperAdmin`；非超管点开会直接拿 403，
 * 所以入口本身也按角色隐藏（父组件负责）。
 */

type DispositionAction = 'MARK_WATCH' | 'RESTRICT_ACCOUNT' | 'REQUIRE_STEP_UP' | 'SUSPEND_ACCOUNT' | 'UNBAN_ACCOUNT' | 'CLEAR_RISK_FLAGS';

const ACTIONS: ReadonlyArray<{ value: DispositionAction; label: string; hint: string; tone: 'slate' | 'amber' | 'rose' }> = [
  { value: 'MARK_WATCH', label: ACTION_LABELS.mark_watch, hint: '只提升监控档位，不冻结任何功能', tone: 'slate' },
  { value: 'RESTRICT_ACCOUNT', label: ACTION_LABELS.restrict, hint: '冻结算力/转写/兑换/上传/LibreChat，保留工单申诉', tone: 'amber' },
  { value: 'REQUIRE_STEP_UP', label: ACTION_LABELS.require_step_up, hint: '不改档位，只要求每次敏感操作都验一次身份', tone: 'amber' },
  { value: 'SUSPEND_ACCOUNT', label: ACTION_LABELS.suspend, hint: '撤销全部会话并禁止登录；不可对最后一个超管执行', tone: 'rose' },
  { value: 'UNBAN_ACCOUNT', label: ACTION_LABELS.unban, hint: '解除封停并清空旗标与分数', tone: 'slate' },
  { value: 'CLEAR_RISK_FLAGS', label: ACTION_LABELS.clear_flags, hint: '只清旗标与分数，保留档位', tone: 'slate' },
];

const TONE_CLASS: Record<'slate' | 'amber' | 'rose', string> = {
  slate: 'border-slate-300 bg-white text-slate-700 hover:border-slate-400',
  amber: 'border-amber-300 bg-amber-50 text-amber-800 hover:border-amber-400',
  rose: 'border-rose-300 bg-rose-50 text-rose-800 hover:border-rose-400',
};

export interface DispositionTarget {
  id: string;
  username: string | null;
  riskTier: string;
  riskScore: number;
  accountStatus: string;
}

export const AccountDispositionModal: React.FC<{
  target: DispositionTarget | null;
  onClose: () => void;
  onDone: () => void;
}> = ({ target, onClose, onDone }) => {
  const { setNotification } = useNotification();
  const [action, setAction] = useState<DispositionAction>('MARK_WATCH');
  const [reason, setReason] = useState('');
  const [durationHours, setDurationHours] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = useCallback(() => {
    if (busy) return;
    setAction('MARK_WATCH');
    setReason('');
    setDurationHours('');
    setError(null);
    onClose();
  }, [busy, onClose]);

  const submit = useCallback(async () => {
    if (!target) return;
    if (!reason.trim()) {
      setError('必须填写处置理由：它会写进 security_events 与审计，事后要靠它解释这次处置。');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const hours = Number(durationHours);
      // 端点名是历史遗留（早期只服务翻译惩戒），但它承载了 RC-07 的全部风险动作：
      // 内部统一走 applyAccountRiskAction，写档位 + security_events + 审计。
      // 不要换成 bulk-action —— 那个动作集不含风险档位动作。
      await api.post(`${getApiBaseUrl()}/api/admin/users/${encodeURIComponent(target.id)}/translation-penalty`, {
        action,
        reason: reason.trim(),
        ...(Number.isFinite(hours) && hours > 0 ? { durationHours: hours } : {}),
      });
      setNotification({ message: `已对 ${target.username ?? target.id} 执行「${ACTION_LABELS[action] ?? action}」`, type: 'success' });
      setBusy(false);
      close();
      onDone();
    } catch (err) {
      setError(getBackendErrorMessage(err, '处置未完成'));
      setBusy(false);
    }
  }, [action, close, durationHours, onDone, reason, setNotification, target]);

  const tier = tierConfig(target?.riskTier);

  return (
    <StudioModal open={Boolean(target)} onClose={close} titleId="account-disposition-title" maxWidthClassName="max-w-2xl">
      <div className="space-y-4 px-1 py-2">
        <div>
          <h3 id="account-disposition-title" className="text-base font-semibold text-slate-900">
            处置账户
          </h3>
          <p className="mt-1 text-xs leading-5 text-slate-500">
            本操作与服务端唯一出口 <code className="rounded bg-slate-100 px-1">applyAccountRiskAction</code> 同源：
            会写档位、写 <code className="rounded bg-slate-100 px-1">security_events</code> 并留审计；
            封停会撤销该账户全部会话。需要超级管理员权限。
          </p>
        </div>

        {target ? (
          <FieldGrid>
            <FieldRow label="账户" value={target.username ?? target.id} />
            <FieldRow label="用户 ID" value={target.id} mono />
            <FieldRow label="当前档位" value={tier.label} hint={tier.hint} />
            <FieldRow label="风险分" value={String(target.riskScore)} hint="越高越危险" />
            <FieldRow label="账户状态" value={target.accountStatus === 'suspended' ? '已封停' : '正常'} />
          </FieldGrid>
        ) : null}

        <div>
          <p className="text-xs font-semibold text-slate-700">处置动作</p>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {ACTIONS.map((item) => (
              <button
                key={item.value}
                type="button"
                aria-pressed={action === item.value}
                onClick={() => setAction(item.value)}
                title={item.hint}
                className={cn(
                  'flex min-h-11 flex-col items-start gap-0.5 rounded-2xl border px-3 py-2 text-left text-xs transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300',
                  action === item.value ? 'ring-2 ring-slate-900' : '',
                  TONE_CLASS[item.tone],
                )}
              >
                <span className="font-semibold">{item.label}</span>
                <span className="text-[11px] leading-4 opacity-80">{item.hint}</span>
              </button>
            ))}
          </div>
        </div>

        {action === 'RESTRICT_ACCOUNT' || action === 'REQUIRE_STEP_UP' ? (
          <label className="flex flex-col gap-1 text-xs text-slate-600">
            逐步验证时长（小时，留空使用服务端默认）
            <input
              type="number"
              min={1}
              value={durationHours}
              onChange={(event) => setDurationHours(event.target.value)}
              placeholder="例如 24"
              className={studioFieldClassName}
            />
          </label>
        ) : null}

        <label className="flex flex-col gap-1 text-xs text-slate-600">
          处置理由（必填）
          <textarea
            value={reason}
            onChange={(event) => setReason(event.target.value.slice(0, 512))}
            rows={3}
            placeholder="写清依据：例如「同一 IP 跨 5 个账户登录，命中 IDC 出口」"
            className={studioTextareaClassName}
          />
          <span className="text-[11px] text-slate-400">{reason.length} / 512</span>
        </label>

        {error ? <StudioErrorNote>{error}</StudioErrorNote> : null}

        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" onClick={close} disabled={busy} className={cn(studioSecondaryButtonClassName, 'min-h-11 sm:min-h-0')}>
            取消
          </button>
          <button type="button" onClick={() => void submit()} disabled={busy} className={cn(studioPrimaryButtonClassName, 'min-h-11 sm:min-h-0')}>
            <FaGavel className="mr-1 inline" />{busy ? '提交中…' : '确认处置'}
          </button>
        </div>
      </div>
    </StudioModal>
  );
};

export default AccountDispositionModal;
