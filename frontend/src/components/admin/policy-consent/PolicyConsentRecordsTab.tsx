import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FaDownload, FaFilter, FaUndo } from 'react-icons/fa';
import {
  policyConsentApi,
  type PolicyConsentListParams,
  type PolicyConsentListResponse,
  type PolicyConsentSource,
  type PolicyConsentState,
} from '@/api/policyConsents';
import { useNotification } from '@/components/Notification';
import { InfoPanel } from '@/components/studioTheme';
import { getBackendErrorMessage } from '@/utils/backendError';
import { cn } from '@/lib/utils';
import { PAGE_SIZE_OPTIONS, formatCount } from '../ip-risk-log/format';
import {
  Badge,
  FilterSelect,
  Pager,
  RefreshButton,
  SectionNote,
  TableState,
  TableWrap,
  Td,
  Th,
  useErrorNotice,
} from '../ip-risk-log/ui';
import {
  AgreementsCell,
  Mono,
  SOURCE_FILTER_OPTIONS,
  STATE_FILTER_OPTIONS,
  consentBadge,
  formatIso,
  sourceLabel,
} from './shared';

/**
 * 政策同意面板的逐条记录 tab。
 *
 * 除指纹/IP/来源/状态外，还支持记录时间范围与「只看勾选不完整」，并把撤回留痕
 * （撤回时间 / IP / 原因）与条文指纹一并展示（见 docs/audit-2026-09-30-policy-system.md P-12/P-19）。
 * 右上角导出按钮走同一套筛选条件，服务端封顶 5000 行且有审计留痕。
 */
const PolicyConsentRecordsTab: React.FC<{
  refreshNonce: number;
  agreementKeys: string[];
  /** 「仅看勾选不完整」由概览卡片驱动，状态提到面板层，两个 tab 才能联动 */
  incompleteOnly: boolean;
  onIncompleteOnlyChange: (next: boolean) => void;
}> = ({ refreshNonce, agreementKeys, incompleteOnly, onIncompleteOnlyChange }) => {
  const reportError = useErrorNotice();
  const { setNotification } = useNotification();

  const [fingerprintDraft, setFingerprintDraft] = useState('');
  const [ipDraft, setIpDraft] = useState('');
  const [fingerprint, setFingerprint] = useState('');
  const [ip, setIp] = useState('');
  const [fromDraft, setFromDraft] = useState('');
  const [toDraft, setToDraft] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [source, setSource] = useState<PolicyConsentSource | ''>('');
  const [state, setState] = useState<PolicyConsentState>('valid');
  const [limit, setLimit] = useState(PAGE_SIZE_OPTIONS[1] ?? 50);
  const [offset, setOffset] = useState(0);
  const [manualNonce, setManualNonce] = useState(0);
  const [exporting, setExporting] = useState(false);

  const [data, setData] = useState<PolicyConsentListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);

  const buildParams = useCallback(
    (withPaging: boolean): PolicyConsentListParams => ({
      ...(withPaging ? { limit, offset } : {}),
      fingerprint: fingerprint || undefined,
      ip: ip || undefined,
      source: source || undefined,
      state,
      from: from || undefined,
      to: to || undefined,
      agreementsIncomplete: incompleteOnly ? true : undefined,
    }),
    [limit, offset, fingerprint, ip, source, state, from, to, incompleteOnly],
  );

  useEffect(() => {
    const requestId = ++requestRef.current;
    setLoading(true);
    void (async () => {
      try {
        const res = await policyConsentApi.list(buildParams(true));
        if (requestId !== requestRef.current) return;
        setData(res);
        setError(null);
      } catch (caught) {
        if (requestId !== requestRef.current) return;
        const message = getBackendErrorMessage(caught, '加载同意记录失败');
        setError(message);
        reportError(message);
      } finally {
        if (requestId === requestRef.current) setLoading(false);
      }
    })();
  }, [buildParams, refreshNonce, manualNonce, reportError]);

  const applyText = () => {
    setFingerprint(fingerprintDraft.trim());
    setIp(ipDraft.trim());
    setFrom(fromDraft);
    setTo(toDraft);
    setOffset(0);
  };

  const resetFilters = () => {
    setFingerprintDraft('');
    setIpDraft('');
    setFingerprint('');
    setIp('');
    setFromDraft('');
    setToDraft('');
    setFrom('');
    setTo('');
    setSource('');
    setState('valid');
    onIncompleteOnlyChange(false);
    setOffset(0);
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      const result = await policyConsentApi.exportCsv(buildParams(false));
      if (result.rowCount === 0) {
        setNotification({ message: '当前筛选条件下没有可导出的记录', type: 'info' });
        return;
      }

      const blob = new Blob([result.csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `policy-consents-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);

      setNotification({
        message: result.truncated
          ? `已导出 ${result.rowCount} 行（达到 5000 行上限，请缩小时间范围后重试）`
          : `已导出 ${result.rowCount} 行`,
        type: result.truncated ? 'warning' : 'success',
      });
    } catch (caught) {
      reportError(getBackendErrorMessage(caught, '导出失败'));
    } finally {
      setExporting(false);
    }
  };

  const rows = data?.consents ?? [];
  const total = data?.total ?? 0;
  const filtered = Boolean(
    fingerprint || ip || source || from || to || incompleteOnly || state !== 'valid',
  );

  return (
    <div className="space-y-4">
      <SectionNote>
        指纹与 IP 为<span className="font-semibold">精确匹配</span>（服务端只接受非空短字符串，非法值忽略），
        排序固定为 <code>recordedAt</code> 倒序；时间范围支持 <code>YYYY-MM-DD</code>。
        checksum 与条文指纹都是服务端签名 / 摘要，只回前 12 位用于辨识。
        同一设备重复同意时记录原地续期，所以「有效」记录数通常约等于活跃设备数，而非同意次数。
      </SectionNote>

      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={fingerprintDraft}
          onChange={(event) => setFingerprintDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') applyText();
          }}
          placeholder="按设备指纹精确匹配（可选）"
          aria-label="按设备指纹精确匹配"
          className="min-w-0 flex-1 rounded-2xl border border-slate-200 bg-white/80 px-4 py-2 font-mono text-xs text-slate-700 transition focus:outline-none focus:ring-2 focus:ring-slate-300 sm:max-w-xs"
        />
        <input
          type="text"
          value={ipDraft}
          onChange={(event) => setIpDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') applyText();
          }}
          placeholder="按 IP 精确匹配（可选）"
          aria-label="按 IP 精确匹配"
          className="min-w-0 flex-1 rounded-2xl border border-slate-200 bg-white/80 px-4 py-2 font-mono text-xs text-slate-700 transition focus:outline-none focus:ring-2 focus:ring-slate-300 sm:max-w-[12rem]"
        />
        <label className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 bg-white/80 px-3 py-1.5 text-xs font-semibold text-slate-600">
          同意时间
          <input
            type="date"
            value={fromDraft}
            onChange={(event) => setFromDraft(event.target.value)}
            aria-label="同意时间下界"
            className="bg-transparent text-xs text-slate-700 focus:outline-none"
          />
          <span className="text-slate-400">→</span>
          <input
            type="date"
            value={toDraft}
            onChange={(event) => setToDraft(event.target.value)}
            aria-label="同意时间上界"
            className="bg-transparent text-xs text-slate-700 focus:outline-none"
          />
        </label>
        <button
          type="button"
          onClick={applyText}
          className="inline-flex items-center gap-2 rounded-2xl bg-slate-900 px-4 py-2 text-xs font-semibold text-white transition hover:bg-slate-800"
        >
          <FaFilter className="text-[10px]" /> 查询
        </button>
        <FilterSelect
          title="按来源筛选"
          value={source}
          options={SOURCE_FILTER_OPTIONS}
          onChange={(value) => {
            setSource(value as PolicyConsentSource | '');
            setOffset(0);
          }}
        />
        <FilterSelect
          title="按状态筛选"
          value={state}
          options={STATE_FILTER_OPTIONS}
          onChange={(value) => {
            setState(value as PolicyConsentState);
            setOffset(0);
          }}
        />
        <FilterSelect
          title="每页条数"
          value={limit}
          options={PAGE_SIZE_OPTIONS.map((size) => ({ value: size, label: `每页 ${size} 条` }))}
          onChange={(value) => {
            setLimit(Number(value));
            setOffset(0);
          }}
        />
        <button
          type="button"
          onClick={() => {
            onIncompleteOnlyChange(!incompleteOnly);
            setOffset(0);
          }}
          aria-pressed={incompleteOnly}
          title="只看缺 agreements 字段或未勾满四份文件的记录（这些记录不会被门禁当作有效同意）"
          className={cn(
            'rounded-2xl border px-3 py-2 text-xs font-semibold transition',
            incompleteOnly
              ? 'border-amber-300 bg-amber-50 text-amber-800'
              : 'border-slate-200 bg-white/80 text-slate-600 hover:border-slate-300',
          )}
        >
          仅看勾选不完整
        </button>
        <RefreshButton onClick={() => setManualNonce((current) => current + 1)} loading={loading} />
        <button
          type="button"
          onClick={() => void handleExport()}
          disabled={exporting || loading}
          title="按当前筛选导出 CSV（服务端上限 5000 行，导出动作会写审计日志）"
          className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 bg-white/80 px-4 py-2 text-xs font-semibold text-slate-600 transition hover:border-slate-300 disabled:opacity-50"
        >
          <FaDownload className="text-[10px]" />
          {exporting ? '导出中…' : '导出 CSV'}
        </button>
        {filtered ? (
          <button
            type="button"
            onClick={resetFilters}
            className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 bg-white/80 px-4 py-2 text-xs font-semibold text-slate-600 transition hover:border-slate-300"
          >
            <FaUndo className="text-[10px]" /> 重置筛选
          </button>
        ) : null}
        <span className="text-xs text-slate-500">
          命中 {formatCount(total)} 条{loading ? '（正在刷新…）' : ''}
        </span>
      </div>

      <InfoPanel compact>
        <TableWrap minWidth="min-w-[1420px]">
          <thead>
            <tr>
              <Th>同意时间</Th>
              <Th>状态</Th>
              <Th>版本</Th>
              <Th>来源</Th>
              <Th>设备指纹</Th>
              <Th>IP</Th>
              <Th>
                <span title={`需勾选：${agreementKeys.join(', ')}`}>勾选文件</span>
              </Th>
              <Th>到期时间</Th>
              <Th>撤回时间</Th>
              <Th>撤回 IP</Th>
              <Th>条文指纹</Th>
              <Th>checksum</Th>
              <Th>User-Agent</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            <TableState
              loading={loading && rows.length === 0}
              error={rows.length === 0 ? error : null}
              empty={!loading && rows.length === 0}
              emptyText="当前筛选条件下没有同意记录"
              colSpan={13}
            />
            {rows.map((row) => (
              <tr key={row.id} className="align-top hover:bg-slate-50/60">
                <Td className="whitespace-nowrap text-slate-700">{formatIso(row.recordedAt)}</Td>
                <Td>
                  <Badge style={consentBadge(row)} />
                </Td>
                <Td className="font-mono text-xs text-slate-600">{row.version || '-'}</Td>
                <Td className="text-slate-600">{sourceLabel(row.source)}</Td>
                <Td>
                  <Mono value={row.fingerprint} max={20} title={row.fingerprint} />
                </Td>
                <Td>
                  <Mono value={row.ipAddress} title={row.ipAddress} />
                </Td>
                <Td>
                  <AgreementsCell row={row} />
                </Td>
                <Td className="whitespace-nowrap text-slate-600">{formatIso(row.expiresAt)}</Td>
                <Td className="whitespace-nowrap text-slate-600">
                  <span title={row.revokedReason || undefined}>{formatIso(row.revokedAt)}</span>
                </Td>
                <Td>
                  <Mono value={row.revokedIP} title={row.revokedIP} />
                </Td>
                <Td>
                  <Mono value={row.documentHashPreview ? `${row.documentHashPreview}…` : null} />
                </Td>
                <Td>
                  <Mono value={row.checksumPreview ? `${row.checksumPreview}…` : null} />
                </Td>
                <Td className="max-w-[220px]">
                  <span className="block truncate text-[11px] text-slate-500" title={row.userAgent}>
                    {row.userAgent || '-'}
                  </span>
                </Td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
        {data && data.total > 0 ? (
          <Pager total={data.total} limit={data.limit} offset={data.offset} loading={loading} onChange={setOffset} />
        ) : null}
      </InfoPanel>
    </div>
  );
};

export default PolicyConsentRecordsTab;
