import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FaCheckCircle, FaExclamationTriangle, FaHistory, FaUnlock } from 'react-icons/fa';
import {
  turnstileApi,
  type IPBanTrace,
  type IPBanTraceAuditEntry,
  type IPBanTraceEvent,
  type IPBanTraceRule,
} from '../../api/turnstile';
import { getBackendErrorMessage } from '../../utils/backendError';
import { cn } from '../../utils/cn';
import {
  InfoBadge,
  InfoPanel,
  InfoSectionTitle,
  studioPrimaryButtonClassName,
  studioSecondaryButtonClassName,
} from '../studioTheme';
import {
  StudioErrorState,
  StudioLoadingState,
  StudioModal,
  StudioModalHeader,
} from '../studioFeedback';

interface Props {
  open: boolean;
  /** 被溯源的地址（列表行传入）。 */
  ip: string;
  /** 非超管只能看判据与证据，解封入口禁用并说明原因。 */
  canWrite: boolean;
  onClose: () => void;
  /** 解封（父组件负责确认弹窗、通知与列表刷新）；返回 true 表示已解除。 */
  onUnban: (ip: string) => Promise<boolean>;
}

const formatDateTime = (value?: string | null): string => {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('zh-CN', { hour12: false });
};

const EVENT_LABELS: Record<string, string> = {
  HONEYPOT_HIT: '蜜罐命中',
};

const AUDIT_LABELS: Record<string, string> = {
  'ipban.autoHoneypotBan': '自动判定封禁',
  'ipban.ban': '手工封禁',
  'ipban.unban': '手工解封',
  'ipban.batchBan': '批量封禁',
  'ipban.batchUnban': '批量解封',
  'ipban.sync': 'Mongo/Redis 同步',
};

const RULE_TONE: Record<string, string> = {
  triggered: 'border-rose-200 bg-rose-50/70',
  idle: 'border-slate-200 bg-slate-50/70',
};

const RuleCard: React.FC<{ rule: IPBanTraceRule }> = ({ rule }) => (
  <div className={cn('rounded-2xl border-2 px-4 py-3', RULE_TONE[rule.triggered ? 'triggered' : 'idle'])}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-sm font-semibold text-slate-900">{rule.label}</p>
      <InfoBadge tone={rule.triggered ? 'rose' : 'slate'}>{rule.triggered ? '已触发' : '未触发'}</InfoBadge>
    </div>
    <p className="mt-1.5 text-xs leading-5 text-slate-600">
      {rule.windowMinutes} 分钟内<span className="font-semibold text-slate-900">未登录</span>命中 ≥{rule.threshold} 次即自动封禁 {rule.banDays} 天；
      当前窗口实测 <span className="font-semibold text-slate-900 tabular-nums">{rule.hitsInWindow}</span> 次
      {rule.totalHitsInWindow > rule.hitsInWindow ? (
        <>
          （另有{' '}
          <span className="tabular-nums">{rule.totalHitsInWindow - rule.hitsInWindow}</span>{' '}
          次已登录访问不计入判据）
        </>
      ) : (
        '（含本次判据复核时刻）'
      )}
      。
    </p>
  </div>
);

const EventRow: React.FC<{ event: IPBanTraceEvent }> = ({ event }) => (
  <li className="flex flex-col gap-1 border-b border-slate-100 py-2.5 last:border-b-0 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
    <div className="min-w-0">
      <p className="flex flex-wrap items-center gap-2 text-sm text-slate-800">
        <span className="font-semibold">{EVENT_LABELS[event.eventType] ?? event.eventType}</span>
        {event.method ? <span className="font-mono text-[11px] text-slate-500">{event.method}</span> : null}
        <span className="break-all font-mono text-[11px] text-slate-600">{event.path ?? '—'}</span>
      </p>
      {event.userAgent ? (
        <p className="mt-1 break-all text-[11px] text-slate-500" title={event.userAgent}>
          UA：{event.userAgent}
        </p>
      ) : null}
    </div>
    <div className="flex shrink-0 items-center gap-2 text-[11px] text-slate-500">
      <span className="tabular-nums">风险分 {event.riskScore}</span>
      <span className="tabular-nums">{formatDateTime(event.createdAt)}</span>
    </div>
  </li>
);

const AuditRow: React.FC<{ entry: IPBanTraceAuditEntry }> = ({ entry }) => (
  <li className="flex flex-col gap-1 border-b border-slate-100 py-2.5 last:border-b-0 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
    <div className="min-w-0">
      <p className="text-sm text-slate-800">
        <span className="font-semibold">{AUDIT_LABELS[entry.action] ?? entry.action}</span>
        <span className="ml-2 text-xs text-slate-500">
          {entry.username || '未知操作者'}
          {entry.role ? ` · ${entry.role}` : ''}
        </span>
      </p>
      {entry.reason ? (
        <p className="mt-1 break-words text-[11px] text-slate-500">原因：{entry.reason}</p>
      ) : null}
    </div>
    <div className="flex shrink-0 items-center gap-2 text-[11px]">
      <span className={entry.result === 'success' ? 'text-emerald-600' : 'text-rose-600'}>
        {entry.result === 'success' ? '成功' : '失败'}
      </span>
      <span className="tabular-nums text-slate-500">{formatDateTime(entry.createdAt)}</span>
    </div>
  </li>
);

/**
 * 封禁溯源弹窗。
 *
 * 三个问题一次答完：**依据是什么**（判据复核）、**证据在哪**（该 IP 的事件，蜜罐命中带路径与 UA）、
 * **谁动的**（封禁/解封审计）。名单页原来只有一句 reason，误封时管理员无法自证，也无法反驳。
 */
const BanTraceModal: React.FC<Props> = ({ open, ip, canWrite, onClose, onUnban }) => {
  const [trace, setTrace] = useState<IPBanTrace | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unbanning, setUnbanning] = useState(false);
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    if (!ip) return;
    const request = ++requestRef.current;
    setLoading(true);
    setError(null);
    try {
      const result = await turnstileApi.getIPBanTrace(ip);
      if (request !== requestRef.current) return;
      setTrace(result);
    } catch (loadError) {
      if (request !== requestRef.current) return;
      setError(getBackendErrorMessage(loadError, '获取封禁溯源失败'));
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, [ip]);

  useEffect(() => {
    if (!open) {
      ++requestRef.current;
      setTrace(null);
      setError(null);
      setLoading(false);
      return;
    }
    void load();
  }, [load, open]);

  const handleUnban = async () => {
    if (!trace) return;
    setUnbanning(true);
    try {
      const done = await onUnban(trace.ipAddress);
      if (done) onClose();
    } finally {
      setUnbanning(false);
    }
  };

  const ban = trace?.ban ?? null;
  const banActive = ban?.active !== false && Boolean(ban);
  const events = trace?.events ?? [];
  const shownEvents = events.slice(0, 20);
  const auditTrail = trace?.auditTrail ?? [];

  return (
    <StudioModal
      open={open}
      onClose={onClose}
      titleId="ip-ban-trace-title"
      maxWidthClassName="max-w-3xl"
      footer={
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
          <button type="button" onClick={onClose} className={studioSecondaryButtonClassName}>
            关闭
          </button>
          <button
            type="button"
            onClick={() => void handleUnban()}
            disabled={!canWrite || !banActive || unbanning}
            title={canWrite ? undefined : '需要超级管理员权限'}
            className={cn(
              studioPrimaryButtonClassName,
              'disabled:cursor-not-allowed disabled:opacity-50',
            )}
          >
            <FaUnlock className="h-3.5 w-3.5" />
            {unbanning ? '解封中…' : banActive ? '解除封禁' : '无需解封'}
          </button>
        </div>
      }
    >
      <StudioModalHeader
        title={`封禁溯源 · ${ip || '未知地址'}`}
        titleId="ip-ban-trace-title"
        description="判据复核、命中证据与操作史同屏对照 —— 用来判断这次封禁是否成立，而不是只给一句原因。"
        icon={<FaHistory className="h-4 w-4" />}
        onClose={onClose}
      />

      <div className="mt-5 space-y-4">
        {loading && !trace ? (
          <StudioLoadingState text="正在整理溯源材料…" minHeightClassName="min-h-[220px]" />
        ) : error ? (
          <StudioErrorState message={error} onRetry={() => void load()} />
        ) : (
          <>
            <InfoPanel compact>
              <InfoSectionTitle
                eyebrow="Verdict Rules"
                title="自动处置判据"
                description="按当前阈值对本次请求时刻重新计数；「已触发」不代表一定是自动封的，封禁来源看下方记录。"
                tone={trace?.rules.some((rule) => rule.triggered) ? 'rose' : 'slate'}
              />
              <div className="space-y-2">
                {(trace?.rules ?? []).map((rule) => (
                  <RuleCard key={rule.key} rule={rule} />
                ))}
                {trace && trace.rules.length === 0 ? (
                  <p className="text-sm text-slate-500">当前没有可复核的自动判据。</p>
                ) : null}
              </div>
            </InfoPanel>

            <InfoPanel compact>
              <InfoSectionTitle
                eyebrow="Ban Record"
                title="封禁记录"
                description="来源 auto 表示风控自动判定，manual 表示管理员手工封禁。"
                tone={banActive ? 'rose' : 'slate'}
                action={
                  ban ? (
                    <InfoBadge tone={banActive ? 'rose' : 'slate'}>{banActive ? '生效中' : '已过期'}</InfoBadge>
                  ) : undefined
                }
              />
              {ban ? (
                <dl className="space-y-2 text-sm">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <dt className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">来源</dt>
                    <dd>
                      <InfoBadge tone={ban.source === 'manual' ? 'sky' : 'emerald'}>
                        {ban.source === 'manual' ? '手工封禁' : '自动判定'}
                      </InfoBadge>
                    </dd>
                    <dt className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">违规次数</dt>
                    <dd className="tabular-nums text-slate-800">{ban.violationCount}</dd>
                  </div>
                  <div>
                    <dt className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">原因</dt>
                    <dd className="mt-1 whitespace-pre-wrap break-words rounded-2xl border border-slate-200 bg-slate-50/70 px-3 py-2 text-slate-800">
                      {ban.reason || '—'}
                    </dd>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <div>
                      <dt className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">封禁时间</dt>
                      <dd className="tabular-nums text-slate-700">{formatDateTime(ban.bannedAt)}</dd>
                    </div>
                    <div>
                      <dt className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">到期时间</dt>
                      <dd className="tabular-nums text-slate-700">{formatDateTime(ban.expiresAt)}</dd>
                    </div>
                    <div className="sm:col-span-2">
                      <dt className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">设备指纹</dt>
                      <dd className="break-all font-mono text-xs text-slate-700">{ban.fingerprint || '—'}</dd>
                    </div>
                    <div className="sm:col-span-2">
                      <dt className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">User-Agent</dt>
                      <dd className="break-all text-xs text-slate-700">{ban.userAgent || '—'}</dd>
                    </div>
                  </div>
                </dl>
              ) : (
                <p className="rounded-2xl border border-dashed border-slate-200 bg-slate-50/80 px-4 py-6 text-center text-sm text-slate-500">
                  该地址当前没有封禁记录（可能是历史事件，或封禁已被解除）。
                </p>
              )}
            </InfoPanel>

            <InfoPanel compact>
              <InfoSectionTitle
                eyebrow="Evidence"
                title="命中证据"
                description={`近 ${trace?.windows.eventsDays ?? 7} 天内该地址的事件，按时间倒序${events.length > shownEvents.length ? `（仅显示最近 ${shownEvents.length} 条）` : ''}。`}
                tone={events.some((event) => event.eventType === 'HONEYPOT_HIT') ? 'amber' : 'slate'}
              />
              {events.length > 0 ? (
                <ul>
                  {shownEvents.map((event, index) => (
                    <EventRow key={`${event.id}-${index}`} event={event} />
                  ))}
                </ul>
              ) : (
                <p className="flex items-center gap-2 rounded-2xl border border-dashed border-slate-200 bg-slate-50/80 px-4 py-6 text-sm text-slate-500">
                  <FaExclamationTriangle className="h-3.5 w-3.5" />
                  窗口内没有该地址的事件记录（可能已被保留期清理，或事件发生在检索窗口之前）。
                </p>
              )}
            </InfoPanel>

            <InfoPanel compact>
              <InfoSectionTitle
                eyebrow="Audit Trail"
                title="管理操作"
                description={`近 ${trace?.windows.auditDays ?? 60} 天的 IP 封禁审计。批量操作只记录条数，因此不会出现在这里。`}
                tone="slate"
              />
              {auditTrail.length > 0 ? (
                <ul>
                  {auditTrail.map((entry, index) => (
                    <AuditRow key={`${entry.id}-${index}`} entry={entry} />
                  ))}
                </ul>
              ) : (
                <p className="flex items-center gap-2 rounded-2xl border border-dashed border-slate-200 bg-slate-50/80 px-4 py-6 text-sm text-slate-500">
                  <FaCheckCircle className="h-3.5 w-3.5" />
                  没有匹配到该地址的单条管理操作记录。
                </p>
              )}
            </InfoPanel>

            {!canWrite ? (
              <p className="rounded-2xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                当前账号为普通管理员：可以查看溯源材料，解封操作只对超级管理员开放。
              </p>
            ) : null}
          </>
        )}
      </div>
    </StudioModal>
  );
};

export default BanTraceModal;
