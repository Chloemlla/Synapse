import React, { useCallback, useEffect, useState } from 'react';
import { FaShieldAlt, FaSync } from 'react-icons/fa';
import { api } from '@/api';
import { InfoBadge, InfoPanel, studioSecondaryButtonClassName } from '@/components/studioTheme';
import { StudioErrorState, StudioLoadingState } from '@/components/studioFeedback';
import { cn } from '@/lib/utils';
import { getBackendErrorMessage } from '@/utils/backendError';
import { formatCount, formatRelativeTime, formatTime } from '../ip-risk-log/format';
import { DataPanel, TableState, TableWrap, Td, Th } from '../account-risk/ui';

/**
 * 功能门禁清单（RC-31）：`config/featureConsent.ts` 的功能键 → 条款 → 依据。
 *
 * 为什么放在政策同意页：门禁与同意是同一件事的两面 —— 用户同意条款后功能才放行。
 * 拆成两页会让「为什么这个功能 403」需要跳来跳去找答案。
 *
 * 只读派生：清单来自服务端同一份配置，前端不维护第二份；
 * 「某功能当前挡住了多少人」刻意不提供（同意有有效期且按 userId 实时判定，
 * 管理端热路径上做该聚合代价高且容易误读），页面显式说明而不是渲染 0。
 */
interface FeatureGate {
  key: string;
  label: string;
  category: string;
  agreements: string[];
  expectedAgreements: string[];
  consistent: boolean;
  rationale: string;
  message: string;
}

interface FeatureGatesResponse {
  success: boolean;
  gates: FeatureGate[];
  /** 本进程内的拒绝计数（不是人数）：多实例各自计数、重启清零。 */
  denials: {
    since: string;
    total: number;
    byFeature: Array<{ feature: string; count: number; lastAt: string | null }>;
    note: string;
  };
}

export const AGREEMENT_LABELS: Record<string, string> = {
  terms: '服务条款',
  usage: '使用政策',
  'specific-terms': '服务专项条款',
  'supported-regions': '可用地区声明',
  privacy: '隐私政策',
};

const agreementLabel = (key: string): string => AGREEMENT_LABELS[key] ?? key;

const CATEGORY_LABELS: Record<string, string> = {
  'content-upload': '用户内容上传',
  'content-publish': '内容对外发布',
  'third-party-transfer': '交由第三方处理',
  'account-credential': '账号与凭据',
  'personal-data': '个人数据与风控',
};

const PolicyConsentFeatureGatesTab: React.FC<{ refreshNonce: number }> = ({ refreshNonce }) => {
  const [data, setData] = useState<FeatureGatesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/api/admin/policy-consents/feature-gates');
      setData(res.data as FeatureGatesResponse);
      setError(null);
    } catch (err) {
      setError(getBackendErrorMessage(err, '读取功能门禁清单失败'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshNonce]);

  if (error && !data) return <StudioErrorState message={error} onRetry={() => void load()} />;
  if (loading && !data) return <StudioLoadingState minHeightClassName="min-h-[200px]" text="正在读取功能门禁清单…" />;
  if (!data) return null;

  const inconsistent = data.gates.filter((gate) => !gate.consistent);
  const denialByFeature = new Map(data.denials.byFeature.map((item) => [item.feature, item]));

  return (
    <div className="space-y-4">
      <InfoPanel compact>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
            <InfoBadge tone="sky">{formatCount(data.gates.length)} 个功能键</InfoBadge>
            {inconsistent.length > 0 ? (
              <InfoBadge tone="rose">{inconsistent.length} 个分类与条款不一致</InfoBadge>
            ) : (
              <InfoBadge tone="emerald">分类与条款一致</InfoBadge>
            )}
          </div>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className={cn(studioSecondaryButtonClassName, 'min-h-11 sm:min-h-0')}
          >
            <FaSync className={cn('mr-1 inline', loading && 'animate-spin')} />刷新
          </button>
        </div>
        <p className="mt-2 text-xs leading-5 text-slate-500">{data.denials.note}</p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <InfoBadge tone={data.denials.total > 0 ? 'amber' : 'slate'}>
            本进程累计拒绝 {formatCount(data.denials.total)} 次
          </InfoBadge>
          <span className="text-[11px] text-slate-400">统计起点 {formatTime(data.denials.since)}</span>
        </div>
      </InfoPanel>

      <InfoPanel compact>
        <TableWrap minWidth="min-w-[980px]">
          <thead>
            <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-400">
              <Th>功能</Th>
              <Th>分类</Th>
              <Th>要求条款</Th>
              <Th>依据</Th>
              <Th>被拒次数</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            <TableState
              loading={loading && data.gates.length === 0}
              error={null}
              empty={!loading && data.gates.length === 0}
              emptyText="没有登记任何功能门禁。新增按同意放行的功能时要在 config/featureConsent.ts 里加键。"
              colSpan={5}
            />
            {data.gates.map((gate) => (
              <tr key={gate.key} className="align-top transition hover:bg-slate-50/80">
                <Td>
                  <div className="flex flex-col gap-0.5">
                    <span className="font-semibold text-slate-800">{gate.label}</span>
                    <span className="font-mono text-[10px] text-slate-400">{gate.key}</span>
                  </div>
                </Td>
                <Td>
                  <div className="flex flex-col gap-0.5">
                    <span className="text-[11px] text-slate-600">{CATEGORY_LABELS[gate.category] ?? gate.category}</span>
                    <span className="font-mono text-[10px] text-slate-400">{gate.category}</span>
                  </div>
                </Td>
                <Td>
                  <span className="flex flex-wrap gap-1">
                    {gate.agreements.map((agreement) => (
                      <InfoBadge key={agreement} tone="slate">{agreementLabel(agreement)}</InfoBadge>
                    ))}
                  </span>
                  {!gate.consistent ? (
                    <span className="mt-1 block text-[10px] text-rose-700">
                      分类规则要求：{gate.expectedAgreements.map(agreementLabel).join('、')}
                    </span>
                  ) : null}
                </Td>
                <Td>
                  <span className="block max-w-[380px] text-[11px] leading-5 text-slate-600">{gate.rationale}</span>
                </Td>
                <Td>
                  {(() => {
                    const denial = denialByFeature.get(gate.key);
                    if (!denial) return <span className="text-slate-400">0</span>;
                    return (
                      <div className="flex flex-col gap-0.5">
                        <span className="tabular-nums font-semibold text-slate-800">{formatCount(denial.count)}</span>
                        <span className="text-[10px] text-slate-400">{formatRelativeTime(denial.lastAt)}</span>
                      </div>
                    );
                  })()}
                </Td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      </InfoPanel>

      <DataPanel>
        <div className="flex items-start gap-2 text-xs leading-5 text-slate-600">
          <FaShieldAlt className="mt-0.5 shrink-0 text-slate-400" aria-hidden />
          <div className="min-w-0">
            <p className="font-semibold text-slate-700">门禁口径</p>
            <p className="mt-1">
              门禁只认 <code className="rounded bg-slate-100 px-1">userId</code>，不回落设备指纹；
              服务层不做缓存，撤销同意后下一个请求立即 403。拒绝统一回
              <code className="mx-1 rounded bg-slate-100 px-1">POLICY_CONSENT_REQUIRED</code>
              + 缺失条款清单，前端据此弹同意面板。
            </p>
          </div>
        </div>
      </DataPanel>
    </div>
  );
};

export default PolicyConsentFeatureGatesTab;
