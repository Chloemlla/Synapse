import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FaCogs, FaLink, FaLock, FaSlidersH } from 'react-icons/fa';
import { accountRiskApi, type AccountRiskConfigResponse } from '@/api/accountRisk';
import { InfoBadge, InfoPanel } from '@/components/studioTheme';
import { StudioErrorState, StudioLoadingState } from '@/components/studioFeedback';
import { getBackendErrorMessage } from '@/utils/backendError';
import { formatCount } from '../ip-risk-log/format';
import { CHANNEL_LABELS, TIER_ORDER, tierConfig } from './format';
import { FieldGrid, FieldRow, RefreshButton, TableWrap, Td, Th, TierBadge } from './ui';

/**
 * 配置与口径：把「当前生效值」「评分权重」「通道株连矩阵」三件事一次讲清。
 *
 * 刻意**只读**：阈值属于运行时配置（`/admin/env` 的 accountRisk 分区，写操作需要
 * 超管 + 安全会话），权重是代码常量。如果这里也放编辑框，就会绕开那两条链路，
 * 出现「面板能改但没有审计」的缺口。
 */
const AccountRiskConfigTab: React.FC<{ refreshNonce: number }> = ({ refreshNonce }) => {
  const [data, setData] = useState<AccountRiskConfigResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestRef.current;
    setLoading(true);
    try {
      const res = await accountRiskApi.config();
      if (requestId !== requestRef.current) return;
      setData(res);
      setError(null);
    } catch (err) {
      if (requestId !== requestRef.current) return;
      setError(getBackendErrorMessage(err, '读取账户风险配置失败'));
    } finally {
      if (requestId === requestRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshNonce]);

  if (error && !data) return <StudioErrorState message={error} onRetry={() => void load()} />;
  if (loading && !data) return <StudioLoadingState minHeightClassName="min-h-[240px]" text="正在读取账户风险配置…" />;
  if (!data) return null;

  const config = data.config as Record<string, unknown>;
  const readBool = (key: string): boolean => config[key] === true;
  const readNum = (key: string): number | null => {
    const value = config[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  };
  const readStr = (key: string): string | null => {
    const value = config[key];
    return typeof value === 'string' ? value : null;
  };

  const booleans: Array<{ key: string; label: string; hint: string }> = [
    { key: 'enabled', label: '总开关', hint: '关闭后聚合任务直接返回，不写库、不升档。' },
    { key: 'evaluateOnLogin', label: '登录时聚合', hint: '登录成功路径上顺带评估一次；热路径只读缓存，不外呼上游。' },
    { key: 'ipRecheckEnabled', label: 'IP 复查（RC-14 / RC-26）', hint: '观察期开关，默认关。开启后 IDC 出口会升档、探测报告才参与评分。' },
    { key: 'stepUpEnabled', label: '逐步验证闸门', hint: '默认关。开启后中高风险账户的写请求会被要求再次验证。' },
    { key: 'fingerprintComponentsEnabled', label: '指纹分量', hint: '关闭后客户端自动化痕迹（RC-57）不再上报。' },
  ];

  return (
    <div className="space-y-4">
      <InfoPanel compact>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <FaSlidersH className="text-slate-400" aria-hidden />
            <h3 className="text-sm font-semibold text-slate-900">运行时开关</h3>
            <span className="text-xs text-slate-400">写操作在「运行时配置」页，需要超管 + 安全会话</span>
          </div>
          <RefreshButton onClick={() => void load()} loading={loading} />
        </div>
        <ul className="mt-3 grid gap-2 sm:grid-cols-2">
          {booleans.map((item) => (
            <li key={item.key} className="flex items-start justify-between gap-3 rounded-2xl border border-slate-200 bg-white/80 px-3 py-2">
              <div className="min-w-0">
                <p className="text-xs font-semibold text-slate-700">{item.label}</p>
                <p className="mt-0.5 text-[11px] leading-5 text-slate-500">{item.hint}</p>
              </div>
              <InfoBadge tone={readBool(item.key) ? 'emerald' : 'slate'} className="shrink-0 whitespace-nowrap">
                {readBool(item.key) ? '已开启' : '已关闭'}
              </InfoBadge>
            </li>
          ))}
        </ul>
      </InfoPanel>

      <InfoPanel compact>
        <div className="flex items-center gap-2">
          <FaCogs className="text-slate-400" aria-hidden />
          <h3 className="text-sm font-semibold text-slate-900">阈值与窗口</h3>
        </div>
        <FieldGrid className="mt-3">
          <FieldRow label="聚合窗口" value={readNum('windowDays') !== null ? `${formatCount(readNum('windowDays'))} 天` : '-'} />
          <FieldRow label="IP 事实保留" value={readNum('ipSignalRetentionDays') !== null ? `${formatCount(readNum('ipSignalRetentionDays'))} 天` : '-'} />
          <FieldRow label="高危 IP 分" value={readNum('highRiskIpScore')} />
          <FieldRow label="最少高危 IP 数" value={readNum('minDistinctHighRiskIps')} />
          <FieldRow label="watch 阈值" value={readNum('watchScoreThreshold')} />
          <FieldRow label="restricted 阈值" value={readNum('restrictedScoreThreshold')} />
          <FieldRow label="danger 阈值" value={readNum('dangerScoreThreshold')} />
          <FieldRow label="自动升档上限" value={readStr('autoEscalationCap')} />
          <FieldRow label="新号观察天数" value={readNum('newAccountWatchDays')} />
          <FieldRow label="逐步验证有效期" value={readNum('stepUpTtlSeconds') !== null ? `${formatCount(readNum('stepUpTtlSeconds'))} 秒` : '-'} />
          <FieldRow label="逐步验证范围" value={readStr('stepUpMode')} />
          <FieldRow label="挑战令牌有效期" value={readNum('stepUpChallengeTtlSeconds') !== null ? `${formatCount(readNum('stepUpChallengeTtlSeconds'))} 秒` : '-'} />
          <FieldRow label="授权有效期" value={readNum('stepUpGrantTtlSeconds') !== null ? `${formatCount(readNum('stepUpGrantTtlSeconds'))} 秒` : '-'} />
          <FieldRow label="授权最多兑换" value={readNum('stepUpGrantMaxUses')} />
        </FieldGrid>
      </InfoPanel>

      <InfoPanel compact>
        <div className="flex items-center gap-2">
          <FaLock className="text-slate-400" aria-hidden />
          <h3 className="text-sm font-semibold text-slate-900">评分权重</h3>
          <span className="text-xs text-slate-400">常量，改动需要发版</span>
        </div>
        <FieldGrid className="mt-3">
          <FieldRow label="匿名信号封顶" value={`${formatCount(data.weights.anonymousAbuseMaxScore)} 分`} hint="匿名来源每件 +5、总额封顶，单独到不了 watch" />
          <FieldRow label="出口不一致" value={`+${formatCount(data.weights.probeExitMismatchScore)} 分`} hint="RC-26 / RC-56，只作加权" />
          <FieldRow label="自动化痕迹" value={`+${formatCount(data.weights.automationHintScore)} 分`} hint="RC-57，单独不升档" />
          <FieldRow label="跨地域跳变" value={`+${formatCount(data.weights.geoJumpScore)} 分`} hint="RC-15" />
        </FieldGrid>
        <p className="mt-2 text-[11px] text-amber-700">{data.weights.note}</p>
      </InfoPanel>

      <InfoPanel compact>
        <div className="flex items-center gap-2">
          <FaLink className="text-slate-400" aria-hidden />
          <h3 className="text-sm font-semibold text-slate-900">通道株连矩阵（RC-38）</h3>
          <span className="text-xs text-slate-400">受限档保留工单作为申诉入口；危险档连工单一起冻结</span>
        </div>
        <TableWrap minWidth="min-w-[680px]">
          <thead>
            <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-400">
              <Th>通道</Th>
              {TIER_ORDER.map((tier) => (
                <Th key={tier}>{tierConfig(tier).label}</Th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {data.channelMatrix.map((row) => (
              <tr key={row.channel}>
                <Td><span className="text-xs font-semibold text-slate-700">{CHANNEL_LABELS[row.channel] ?? row.channel}</span></Td>
                {TIER_ORDER.map((tier) => {
                  const cell = row.byTier.find((entry) => entry.tier === tier);
                  const locked = cell?.locked === true;
                  return (
                    <Td key={tier}>
                      {locked ? (
                        // InfoBadge 不接受 title：说明文字要包一层 span，否则 TS 直接拒收这个属性。
                        <span title={cell?.reason ?? undefined}>
                          <InfoBadge tone="rose" className="whitespace-nowrap">
                            冻结 · {cell?.appealChannel === 'ticket' ? '可提工单' : '邮件申诉'}
                          </InfoBadge>
                        </span>
                      ) : (
                        <InfoBadge tone="emerald" className="whitespace-nowrap">开放</InfoBadge>
                      )}
                    </Td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </TableWrap>
        <p className="mt-2 text-[11px] text-slate-500">
          冻结响应统一为 <code className="rounded bg-slate-100 px-1">{data.restrictedCode}</code>，
          申诉邮箱 <code className="rounded bg-slate-100 px-1">{data.supportEmail}</code>。
          通道自身的处罚（`channel_local`）不跨通道株连（RC-61）；超管豁免（RC-44）。
        </p>
      </InfoPanel>

      <InfoPanel compact>
        <h3 className="text-sm font-semibold text-slate-900">事件命名口径</h3>
        <FieldGrid className="mt-2">
          <FieldRow label="滥用事件前缀" value={data.eventPrefix} mono />
          <FieldRow label="自动化痕迹事件" value={data.automationEvent} mono />
        </FieldGrid>
        <p className="mt-2 text-[11px] text-slate-500">
          账户聚合按 <code className="rounded bg-slate-100 px-1">{data.eventPrefix}_</code> 前缀计数；
          自动化痕迹刻意不带该前缀，避免「既计滥用事件分又计自动化权重」的双重计分。
        </p>
      </InfoPanel>

      <div className="flex flex-wrap items-center gap-2">
        <TierBadge tier="watch" />
        <span className="text-xs text-slate-500">档位会直接显示在账户列表与用户管理页；本页不提供修改入口。</span>
      </div>
    </div>
  );
};

export default AccountRiskConfigTab;
