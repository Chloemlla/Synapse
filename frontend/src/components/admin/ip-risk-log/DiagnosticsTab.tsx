import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  FaAngleDoubleDown,
  FaAngleDoubleUp,
  FaBug,
  FaExclamationTriangle,
  FaFingerprint,
  FaTimes,
} from 'react-icons/fa';
import {
  ipRiskLogsApi,
  type ProxycheckSignatureVerdict,
  type SignatureVerifyResponse,
  type SignatureVerdictFilter,
  type TriStateFilter,
  type UpstreamDiagnosticRow,
} from '@/api/ipRiskLogs';
import {
  InfoPanel,
  InfoSectionTitle,
  studioFieldClassName,
  studioGhostButtonClassName,
  studioPrimaryButtonClassName,
} from '@/components/studioTheme';
import { StudioErrorNote } from '@/components/studioFeedback';
import { getBackendErrorMessage } from '@/utils/backendError';
import { DEFAULT_PAGE_SIZE, PAGE_SIZE_OPTIONS, formatCount, formatDurationMs, type BadgeStyle } from './format';
import {
  Badge,
  Chip,
  DataPanel,
  FieldGrid,
  FieldRow,
  FilterSelect,
  JsonBlock,
  Pager,
  RefreshButton,
  SectionNote,
  TableState,
  TableWrap,
  Td,
  Th,
  TimeCell,
  IpCell,
  useErrorNotice,
} from './ui';

/**
 * 「上游诊断」页：把每一次失败（以及「验签未过但已采信」）的上游交互摊开。
 *
 * 目标只有一个：线上那句 `[IpRisk] proxycheck 配置错误` 要能在这里被回答成
 * 「头没回 / 头对不上 / 密钥长度不对 / 请求根本没出去」，而不是靠猜。
 *
 * 一以贯之的边界：**密钥明文永不出现**。页面上的密钥信息只有「长度 + 指纹」，
 * 要确认某把 Dashboard 密钥对不对得上，用行内的「用候选密钥重算验签」——
 * 服务端在已存响应体上算一遍 HMAC 并回答对不对，候选密钥不落库、不进日志。
 */

interface Props {
  refreshNonce: number;
}

const VERDICT_CONFIG: Record<
  ProxycheckSignatureVerdict,
  { label: string; style: BadgeStyle; why: string }
> = {
  verified: {
    label: '验签通过',
    style: { label: '验签通过', badgeClass: 'border-emerald-200 bg-emerald-50 text-emerald-700', dotClass: 'bg-emerald-500' },
    why: '上游回签值与「当前密钥 + 这份响应体」算出来的一致。这一行本该是成功行，出现即说明后续解析或状态判定另有问题。',
  },
  not_configured: {
    label: '未配置验签密钥',
    style: { label: '未配置验签密钥', badgeClass: 'border-slate-200 bg-slate-50 text-slate-600', dotClass: 'bg-slate-400' },
    why: '没有填 API Payload Verification Key，本服务不做验签、只依赖 TLS。这不是错误，但也就没有「响应未被篡改」这层保障。',
  },
  header_missing: {
    label: '上游未回签名头',
    style: { label: '上游未回签名头', badgeClass: 'border-rose-200 bg-rose-50 text-rose-700', dotClass: 'bg-rose-500' },
    why:
      '响应里没有 http_x_signature。最常见的原因是验签密钥与 apiKey 不是同一账号的（换 key 后 Dashboard 会重新生成验签密钥），' +
      '其次是请求没走 HTTPS 或中间层剥掉了该响应头。先看上面的响应头快照确认它真的不存在。',
  },
  header_malformed: {
    label: '签名头格式不对',
    style: { label: '签名头格式不对', badgeClass: 'border-rose-200 bg-rose-50 text-rose-700', dotClass: 'bg-rose-500' },
    why: 'http_x_signature 不是 64 位小写 hex。多半不是上游的签名，而是某个代理/CDN 注入的同名头，或响应被改写过。',
  },
  mismatch: {
    label: '签名不匹配',
    style: { label: '签名不匹配', badgeClass: 'border-rose-200 bg-rose-50 text-rose-700', dotClass: 'bg-rose-500' },
    why:
      '上游回签值存在，但用当前密钥对这一份响应体重算的结果与之不同。典型原因是密钥失效或属于另一个账号；' +
      '用行内「用候选密钥重算验签」粘一次 Dashboard 上的最新密钥即可定性。',
  },
  key_malformed: {
    label: '验签密钥长度不对',
    style: { label: '验签密钥长度不对', badgeClass: 'border-amber-200 bg-amber-50 text-amber-800', dotClass: 'bg-amber-500' },
    why:
      '配置的验签密钥不是 64 字符（官方约定）。常见形态是把本服务的「自建 HMAC 验签主密钥」填到了「API Payload Verification Key」里 —— ' +
      '看下方四把密钥的指纹是否成对相同即可确认。',
  },
  no_response: {
    label: '未取得响应',
    style: { label: '未取得响应', badgeClass: 'border-slate-200 bg-slate-50 text-slate-600', dotClass: 'bg-slate-400' },
    why: '请求没拿到上游响应（DNS / TLS / 超时 / 重定向被拒）。看上面的错误文案，与验签无关。',
  },
};

const VERDICT_OPTIONS: ReadonlyArray<{ value: SignatureVerdictFilter; label: string }> = [
  { value: '', label: '验签结论：全部' },
  { value: 'header_missing', label: '上游未回签名头' },
  { value: 'mismatch', label: '签名不匹配' },
  { value: 'header_malformed', label: '签名头格式不对' },
  { value: 'key_malformed', label: '密钥长度不对' },
  { value: 'no_response', label: '未取得响应' },
  { value: 'not_configured', label: '未配置验签密钥' },
  { value: 'verified', label: '验签通过' },
];

const TRUSTED_OPTIONS: ReadonlyArray<{ value: TriStateFilter; label: string }> = [
  { value: '', label: '采信情况：全部' },
  { value: 'true', label: '验签未过但已采信' },
  { value: 'false', label: '未采信（真失败）' },
];

const KeyShapeCell: React.FC<{ shape: { present: boolean; length: number; fingerprint: string } | undefined }> = ({
  shape,
}) => {
  if (!shape || !shape.present) return <span className="text-slate-400">未配置</span>;
  return (
    <span className="font-mono text-[11px] text-slate-600" title="长度 + sha256 前 12 位指纹；密钥明文不会出现在任何接口响应里">
      {shape.length} 字符 · {shape.fingerprint || '—'}
    </span>
  );
};

const DiagnosticsTab: React.FC<Props> = ({ refreshNonce }) => {
  const notice = useErrorNotice();

  const [draftIp, setDraftIp] = useState('');
  const [ip, setIp] = useState('');
  const [verdict, setVerdict] = useState<SignatureVerdictFilter>('');
  const [trusted, setTrusted] = useState<TriStateFilter>('');
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [offset, setOffset] = useState(0);
  const [manualNonce, setManualNonce] = useState(0);

  const [rows, setRows] = useState<UpstreamDiagnosticRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  /** 每行的候选密钥输入与重算结果。候选密钥只活在内存里，不写回表单以外的任何地方。 */
  const [candidateKeys, setCandidateKeys] = useState<Record<string, string>>({});
  const [verifyResults, setVerifyResults] = useState<Record<string, SignatureVerifyResponse>>({});
  const [verifyErrors, setVerifyErrors] = useState<Record<string, string>>({});
  const [verifying, setVerifying] = useState<Record<string, boolean>>({});

  const requestRef = useRef(0);

  useEffect(() => {
    const requestId = ++requestRef.current;
    setLoading(true);
    void (async () => {
      try {
        const res = await ipRiskLogsApi.upstreamDiagnostics({
          limit: pageSize,
          offset,
          ip: ip || undefined,
          verdict: verdict || undefined,
          trusted: trusted || undefined,
        });
        if (requestId !== requestRef.current) return;
        setRows(res.rows ?? []);
        setTotal(res.total ?? 0);
        setError(null);
        notice.reset();
      } catch (err) {
        if (requestId !== requestRef.current) return;
        const message = getBackendErrorMessage(err, '加载上游诊断失败');
        setError(message);
        notice(message);
      } finally {
        if (requestId === requestRef.current) setLoading(false);
      }
    })();
  }, [pageSize, offset, ip, verdict, trusted, refreshNonce, manualNonce, notice]);

  const toggle = useCallback((key: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const rowKey = (row: UpstreamDiagnosticRow, index: number): string => row._id || `${row.createdAt}-${index}`;
  const allExpanded = rows.length > 0 && rows.every((row, index) => expanded.has(rowKey(row, index)));

  const verify = useCallback(
    (id: string) => {
      const candidate = (candidateKeys[id] ?? '').trim();
      if (!candidate) return;
      setVerifying((current) => ({ ...current, [id]: true }));
      setVerifyErrors((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      void (async () => {
        try {
          const result = await ipRiskLogsApi.verifyDiagnosticSignature(id, candidate);
          setVerifyResults((current) => ({ ...current, [id]: result }));
        } catch (err) {
          setVerifyErrors((current) => ({
            ...current,
            [id]: getBackendErrorMessage(err, '重算验签失败'),
          }));
        } finally {
          setVerifying((current) => ({ ...current, [id]: false }));
          // 候选密钥用完即弃：不留在组件状态里，避免它在页面上多待一会儿。
          setCandidateKeys((current) => ({ ...current, [id]: '' }));
        }
      })();
    },
    [candidateKeys],
  );

  const applyIp = () => {
    setIp(draftIp.trim());
    setOffset(0);
  };

  const resetFilters = () => {
    setDraftIp('');
    setIp('');
    setVerdict('');
    setTrusted('');
    setOffset(0);
  };

  const hasFilters = Boolean(ip || verdict || trusted);

  return (
    <div className="space-y-5">
      <InfoSectionTitle
        title="上游交互诊断"
        description="每一次上游失败（以及「验签未过但按配置采信」）的请求与响应快照：请求 URL（key 已脱敏）、上游状态与响应头、上游回签值、用当前密钥重算的期望签名、响应原文，以及四把密钥的长度与指纹。"
        icon={FaBug}
        eyebrow="§2.6 upstream-diagnostics"
        action={<RefreshButton onClick={() => setManualNonce((current) => current + 1)} loading={loading} />}
      />

      <SectionNote>
        写入点：<code>src/services/ipRiskService.ts</code>（<code>performLookup</code> 的失败分支与「验签未过但已采信」分支）。
        成功且验签通过的请求不写，避免把集合撑大。
        <br />
        <span className="font-semibold">密钥明文不会出现在本页，也不会出现在任何接口响应或日志里</span>
        （仓库硬约束）。要确认某把密钥对不对得上，用行内「用候选密钥重算验签」：服务端在已存响应体上重算 HMAC，
        只为回答「对不对得上」，候选密钥不落库、不进日志。
      </SectionNote>

      {error && rows.length > 0 ? (
        <StudioErrorNote className="flex flex-wrap items-center gap-3">
          <span className="min-w-0 flex-1">{error}</span>
          <button
            type="button"
            onClick={() => setManualNonce((current) => current + 1)}
            className={studioGhostButtonClassName}
          >
            重试
          </button>
        </StudioErrorNote>
      ) : null}

      <InfoPanel compact>
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <div className="relative flex-1">
            <input
              value={draftIp}
              onChange={(event) => setDraftIp(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') applyIp();
                if (event.key === 'Escape') {
                  setDraftIp('');
                  setIp('');
                  setOffset(0);
                }
              }}
              placeholder="按 IP 前缀筛选（最长 45 字符，回车立即查询）"
              aria-label="按 IP 前缀筛选"
              className={studioFieldClassName}
            />
            {draftIp ? (
              <button
                type="button"
                onClick={() => setDraftIp('')}
                title="清空输入"
                aria-label="清空输入"
                className="inline-flex min-h-11 min-w-11 items-center justify-center absolute right-3 top-1/2 -translate-y-1/2 rounded-full p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300 sm:min-h-0 sm:min-w-0"
              >
                <FaTimes />
              </button>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <FilterSelect
              title="按验签结论筛选"
              value={verdict}
              options={VERDICT_OPTIONS}
              onChange={(value) => {
                setVerdict(value as SignatureVerdictFilter);
                setOffset(0);
              }}
            />
            <FilterSelect
              title="按采信情况筛选"
              value={trusted}
              options={TRUSTED_OPTIONS}
              onChange={(value) => {
                setTrusted(value as TriStateFilter);
                setOffset(0);
              }}
            />
            <FilterSelect
              title="每页条数"
              value={pageSize}
              options={PAGE_SIZE_OPTIONS.map((size) => ({ value: size, label: `每页 ${size} 条` }))}
              onChange={(value) => {
                setPageSize(Number(value));
                setOffset(0);
              }}
            />
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Chip active={!hasFilters} label="重置筛选" onClick={resetFilters} title="清空全部筛选条件" />
          <button
            type="button"
            onClick={() =>
              setExpanded(allExpanded ? new Set() : new Set(rows.map((row, index) => rowKey(row, index))))
            }
            className="inline-flex min-h-11 items-center gap-1.5 rounded-2xl border border-slate-200 bg-white/80 px-3 text-xs font-semibold text-slate-700 transition hover:border-slate-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300 sm:min-h-0 sm:py-1.5"
          >
            {allExpanded ? <FaAngleDoubleUp /> : <FaAngleDoubleDown />}
            {allExpanded ? '折叠全部' : '展开全部'}
          </button>
          <span className="text-xs text-slate-500">
            命中 {formatCount(total)} 条{loading ? '（正在刷新…）' : ''}
          </span>
        </div>
      </InfoPanel>

      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white/80 backdrop-blur-xl">
        <TableWrap minWidth="min-w-[1180px]">
          <thead>
            <tr className="border-b border-slate-200">
              <Th>时间</Th>
              <Th>IP</Th>
              <Th>错误码</Th>
              <Th>验签结论</Th>
              <Th>上游回签</Th>
              <Th>当前密钥</Th>
              <Th>采信</Th>
              <Th>耗时</Th>
              <Th className="text-right">明细</Th>
            </tr>
          </thead>
          <tbody>
            <TableState
              loading={loading && rows.length === 0}
              error={rows.length === 0 ? error : null}
              empty={!loading && rows.length === 0}
              emptyText={
                hasFilters
                  ? '当前筛选条件下没有上游诊断记录。可以点「重置筛选」回到全量数据。'
                  : '还没有上游诊断记录：说明目前没有失败调用，也没有「验签未过但已采信」的情况。'
              }
              colSpan={9}
              onRetry={() => setManualNonce((current) => current + 1)}
            />
            {rows.map((row, index) => {
              const key = rowKey(row, index);
              const isOpen = expanded.has(key);
              const diagnostics = row.diagnostics;
              const verdictKey = (diagnostics?.signature?.verdict ?? 'no_response') as ProxycheckSignatureVerdict;
              const config = VERDICT_CONFIG[verdictKey] ?? VERDICT_CONFIG.no_response;
              const result = verifyResults[key];
              return (
                <React.Fragment key={key}>
                  <tr className="border-b border-slate-100 align-top hover:bg-slate-50/60">
                    <Td>
                      <TimeCell value={row.createdAt} />
                    </Td>
                    <Td>
                      <IpCell ip={row.ip} />
                    </Td>
                    <Td className="max-w-[220px] text-rose-600">
                      {row.error ? (
                        <span className="break-all" title={row.error}>
                          {row.error}
                        </span>
                      ) : (
                        <span className="text-slate-400">-</span>
                      )}
                    </Td>
                    <Td>
                      <Badge style={config.style} title={config.why} />
                    </Td>
                    <Td>
                      <span className="font-mono text-[11px] text-slate-600">
                        {diagnostics?.signature?.headerValue
                          ? `${diagnostics.signature.headerValue.slice(0, 12)}…`
                          : '—'}
                      </span>
                    </Td>
                    <Td>
                      <KeyShapeCell shape={diagnostics?.signature?.key} />
                    </Td>
                    <Td>
                      {diagnostics?.trustedWithoutSignature ? (
                        <span className="font-semibold text-amber-700">已采信（未验签）</span>
                      ) : (
                        <span className="text-slate-600">未采信</span>
                      )}
                    </Td>
                    <Td className="whitespace-nowrap text-slate-600">{formatDurationMs(row.durationMs)}</Td>
                    <Td className="text-right">
                      <button
                        type="button"
                        onClick={() => toggle(key)}
                        className="rounded-2xl border border-slate-200 bg-white/80 px-2.5 py-1 text-xs font-semibold text-slate-600 transition hover:border-slate-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300"
                      >
                        {isOpen ? '收起' : '展开'}
                      </button>
                    </Td>
                  </tr>
                  {isOpen ? (
                    <tr className="border-b border-slate-200 bg-slate-50/60">
                      <td colSpan={9} className="px-4 py-4">
                        <div className="space-y-4">
                          <div className="rounded-2xl border border-slate-200 bg-white/80 p-3">
                            <p className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-slate-700">
                              <FaExclamationTriangle className="text-amber-500" />
                              为什么这次没验过
                            </p>
                            <p className="text-xs leading-5 text-slate-600">{config.why}</p>
                            {diagnostics?.keys?.payloadVerificationKeyMatchesHmacSecret ? (
                              <p className="mt-2 rounded-2xl border border-rose-200 bg-rose-50/80 px-3 py-2 text-xs font-semibold text-rose-700">
                                两把密钥的指纹相同：payloadVerificationKey 被填成了本服务的 hmacSecret。
                                请到配置分区清除它，或改成 proxycheck 官方 Dashboard 生成的 64 字符密钥。
                              </p>
                            ) : null}
                          </div>

                          {diagnostics ? (
                            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                              <div className="space-y-3">
                                <div>
                                  <p className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                                    请求（key 已脱敏）
                                  </p>
                                  <FieldGrid>
                                    <FieldRow label="method" value={diagnostics.method} always mono />
                                    <FieldRow label="status" value={diagnostics.status === null ? '无响应' : String(diagnostics.status)} always />
                                    <FieldRow label="URL" value={diagnostics.url} always mono copyValue={diagnostics.url} />
                                    {diagnostics.requestBody ? (
                                      <FieldRow label="body" value={diagnostics.requestBody} always mono copyValue={diagnostics.requestBody} />
                                    ) : null}
                                  </FieldGrid>
                                  <details className="mt-2">
                                    <summary className="cursor-pointer text-xs font-semibold text-slate-500">
                                      请求头（{Object.keys(diagnostics.requestHeaders ?? {}).length}）
                                    </summary>
                                    <JsonBlock className="mt-1" value={diagnostics.requestHeaders} />
                                  </details>
                                </div>

                                <div>
                                  <p className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                                    签名对照
                                  </p>
                                  <FieldGrid>
                                    <FieldRow label="上游回签" value={diagnostics.signature.headerValue || '（未回）'} always mono copyValue={diagnostics.signature.headerValue || undefined} />
                                    <FieldRow label="按当前密钥重算" value={diagnostics.signature.expectedSignature || '（无法重算）'} always mono copyValue={diagnostics.signature.expectedSignature || undefined} />
                                    <FieldRow label="响应体字节" value={`${diagnostics.bodyBytes}${diagnostics.bodyTruncated ? '（已截断）' : ''}`} always />
                                  </FieldGrid>
                                </div>

                                <div>
                                  <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                                    <FaFingerprint /> 四把密钥（长度 + 指纹，无明文）
                                  </p>
                                  <FieldGrid>
                                    <FieldRow label="apiKey" value={<KeyShapeCell shape={diagnostics.keys?.apiKey} />} always />
                                    <FieldRow label="publicApiKey" value={<KeyShapeCell shape={diagnostics.keys?.publicApiKey} />} always />
                                    <FieldRow label="payloadVerificationKey" value={<KeyShapeCell shape={diagnostics.keys?.payloadVerificationKey} />} always />
                                    <FieldRow label="hmacSecret" value={<KeyShapeCell shape={diagnostics.keys?.hmacSecret} />} always />
                                  </FieldGrid>
                                </div>
                              </div>

                              <div className="space-y-3">
                                <div>
                                  <p className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                                    上游响应
                                  </p>
                                  <details className="mb-2">
                                    <summary className="cursor-pointer text-xs font-semibold text-slate-500">
                                      响应头（{Object.keys(diagnostics.responseHeaders ?? {}).length}）
                                    </summary>
                                    <JsonBlock className="mt-1" value={diagnostics.responseHeaders} />
                                  </details>
                                  <JsonBlock value={diagnostics.body || '（空响应体）'} />
                                </div>

                                <div className="rounded-2xl border border-slate-200 bg-white/80 p-3">
                                  <p className="text-xs font-semibold text-slate-700">用候选密钥重算验签</p>
                                  <p className="mt-1 text-xs leading-5 text-slate-500">
                                    粘一次 Dashboard 上的 API Payload Verification Key：服务端会在上面这份已存响应体上重算 HMAC-SHA256，
                                    直接回答「对不对得上上游回签值」。候选密钥不落库、不写日志，提交后即从页面清空。
                                  </p>
                                  <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                                    <input
                                      type="password"
                                      value={candidateKeys[key] ?? ''}
                                      onChange={(event) =>
                                        setCandidateKeys((current) => ({ ...current, [key]: event.target.value }))
                                      }
                                      onKeyDown={(event) => {
                                        if (event.key === 'Enter') verify(key);
                                      }}
                                      placeholder="粘贴候选密钥（64 字符）"
                                      autoComplete="off"
                                      spellCheck={false}
                                      aria-label="候选验签密钥"
                                      className={studioFieldClassName}
                                    />
                                    <button
                                      type="button"
                                      onClick={() => verify(key)}
                                      disabled={verifying[key] || !(candidateKeys[key] ?? '').trim()}
                                      className={`${studioPrimaryButtonClassName} shrink-0`}
                                    >
                                      {verifying[key] ? '重算中…' : '重算验签'}
                                    </button>
                                  </div>
                                  {verifyErrors[key] ? (
                                    <p className="mt-2 text-xs text-rose-600">{verifyErrors[key]}</p>
                                  ) : null}
                                  {result ? (
                                    <div className="mt-2 space-y-1 rounded-2xl border border-slate-200 bg-slate-50/80 px-3 py-2 text-xs">
                                      <p className={result.matches ? 'font-semibold text-emerald-700' : 'font-semibold text-rose-600'}>
                                        {result.matches
                                          ? '对得上：这把密钥与上游回签值一致。'
                                          : '对不上：这把密钥算出的签名与上游回签值不同。'}
                                      </p>
                                      {result.bodyTruncated ? (
                                        <p className="text-amber-700">
                                          响应体已截断（{result.bodyBytes} 字节），截断后的内容不能作为判据 —— 上面的
                                          「对不上」可能只是截断导致，请以未截断的记录复核。
                                        </p>
                                      ) : null}
                                      <p className="break-all font-mono text-[11px] text-slate-600">
                                        候选 {result.candidateLength} 字符 · {result.candidateFingerprint}；
                                        当前配置 {result.configuredKeyLength} 字符 · {result.configuredKeyFingerprint}
                                        {result.candidateMatchesConfiguredKey ? '（同一把）' : '（不同）'}
                                      </p>
                                      <p className="break-all font-mono text-[11px] text-slate-600">
                                        重算 {result.expectedSignature}
                                      </p>
                                      <p className="break-all font-mono text-[11px] text-slate-600">
                                        上游 {result.upstreamSignature || '（未回签名头）'}
                                      </p>
                                    </div>
                                  ) : null}
                                </div>

                                <details>
                                  <summary className="cursor-pointer text-xs font-semibold text-slate-500">原始 JSON</summary>
                                  <JsonBlock className="mt-1" value={row.diagnostics} />
                                </details>
                              </div>
                            </div>
                          ) : (
                            <p className="text-xs text-slate-500">该行没有排障快照（旧数据）。</p>
                          )}
                        </div>
                      </td>
                    </tr>
                  ) : null}
                </React.Fragment>
              );
            })}
          </tbody>
        </TableWrap>
        <Pager total={total} limit={pageSize} offset={offset} loading={loading} onChange={setOffset} />
      </div>

      <DataPanel className="border-slate-200 bg-white/60">
        <p className="text-xs leading-6 text-slate-500">
          筛选按服务端执行：<code>ip</code> 前缀匹配、<code>verdict</code> 为验签结论、<code>trusted</code> 区分
          「验签未过但已采信」与「真失败」。排序固定为 <code>createdAt</code> 倒序。
        </p>
      </DataPanel>
    </div>
  );
};

export default DiagnosticsTab;
