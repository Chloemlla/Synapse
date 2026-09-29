import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import { motion } from 'framer-motion';
import {
  FaAddressBook,
  FaArrowUp,
  FaBalanceScale,
  FaBan,
  FaCheckCircle,
  FaClock,
  FaCode,
  FaCookieBite,
  FaCopy,
  FaCopyright,
  FaEnvelope,
  FaExclamationTriangle,
  FaFileAlt,
  FaFileAudio,
  FaFileContract,
  FaGavel,
  FaGlobe,
  FaGlobeAsia,
  FaHistory,
  FaInfoCircle,
  FaLock,
  FaPrint,
  FaScroll,
  FaServer,
  FaShieldAlt,
  FaSyncAlt,
  FaUserSecret,
  FaUserShield,
  FaVolumeUp,
} from 'react-icons/fa';
import type { IconType } from 'react-icons';
import { apiWithRetry } from '../api';
import type {
  PolicyAgreement,
  PolicyDocument,
  PolicyDocumentResponse,
  PolicyHighlight,
  PolicyIconKey,
  PolicySection,
  PolicyWarning,
} from '../types/policy';
import type { PolicyAgreementKey } from '../utils/policyConsent';
import { cn } from '../utils/cn';
import {
  InfoBadge,
  InfoPanel,
  InfoPrimaryButton,
  InfoQueryHero,
  InfoQueryShell,
  InfoSectionTitle,
  studioElevatedPanelClassName,
  studioSecondaryButtonClassName,
  type InfoTone,
} from './studioTheme';

// 图标与配色由前端决定：后端只给语义键（icon / emphasis），换风格不必动条文。
const sectionIcons: Record<PolicyIconKey, IconType> = {
  info: FaInfoCircle,
  service: FaFileAudio,
  account: FaLock,
  conduct: FaBan,
  privacy: FaUserSecret,
  'third-party': FaServer,
  retention: FaHistory,
  rights: FaUserShield,
  cookies: FaCookieBite,
  enforcement: FaShieldAlt,
  copyright: FaCopyright,
  liability: FaBalanceScale,
  changes: FaSyncAlt,
  law: FaGavel,
  contact: FaAddressBook,
};

const accentPalette: InfoTone[] = ['sky', 'emerald', 'violet', 'slate', 'teal'];

// 登录/注册的四份必读文件各自的图标与强调色，与 PolicyConsentChecklist 的勾选项一一对应
const agreementIcons: Record<PolicyAgreementKey, IconType> = {
  terms: FaFileContract,
  usage: FaShieldAlt,
  'specific-terms': FaScroll,
  'supported-regions': FaGlobeAsia,
};

const agreementTones: Record<PolicyAgreementKey, InfoTone> = {
  terms: 'sky',
  usage: 'amber',
  'specific-terms': 'violet',
  'supported-regions': 'emerald',
};

function resolveIcon(key: PolicyIconKey): IconType {
  return sectionIcons[key] || FaFileAlt;
}

// critical / notice 章节固定用警示色，其余按顺序轮转强调色。
function resolveTone(emphasis: PolicySection['emphasis'], index: number): InfoTone {
  if (emphasis === 'critical') return 'rose';
  if (emphasis === 'notice') return 'amber';
  return accentPalette[index % accentPalette.length];
}

/** 条文接口的失败原因归一化成一句用户能看懂的中文提示。 */
function resolveLoadError(err: unknown): string {
  if (axios.isAxiosError(err)) {
    if (err.code === 'ECONNABORTED' || err.message?.includes('timeout')) {
      return '请求超时，请稍后重试。';
    }
    if (!err.response) {
      return '网络连接异常，请检查网络后重试。';
    }
    const data = err.response.data as PolicyDocumentResponse | undefined;
    if (data?.errorCode === 'IP_VERIFICATION_REQUIRED') {
      return '请先完成安全验证后重试。';
    }
    if (err.response.status >= 500) {
      return '服务暂时不可用，请稍后重试。';
    }
    if (data?.error) return data.error;
  }
  if (err instanceof Error && err.message) return err.message;
  return '加载失败，请刷新页面或稍后重试。';
}

function formatSectionNumber(index: number): string {
  return String(index + 1).padStart(2, '0');
}

const PolicyToc: React.FC<{
  sections: PolicySection[];
  activeId: string;
  progress: number;
  onJump: (id: string) => void;
  onTop: () => void;
}> = ({ sections, activeId, progress, onJump, onTop }) => (
  <>
    <div className="mb-4">
      <div className="flex items-center justify-between text-xs font-semibold text-slate-500">
        <span>阅读进度</span>
        <span>{progress}%</span>
      </div>
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
        <div
          className="h-full rounded-full bg-slate-900 transition-[width] duration-150"
          style={{ width: `${progress}%` }}
        />
      </div>
    </div>
    <nav aria-label="条款目录" className="max-h-[60vh] space-y-1 overflow-y-auto pr-1">
      {sections.map((section, index) => {
        const target = `policy-${section.id}`;
        const active = activeId === target;
        return (
          <button
            key={section.id}
            type="button"
            onClick={() => onJump(section.id)}
            aria-current={active ? 'true' : undefined}
            className={cn(
              'flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm transition',
              active
                ? 'bg-slate-900 text-white'
                : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
            )}
          >
            <span className={cn('font-mono text-[11px]', active ? 'text-white/70' : 'text-slate-400')}>
              {formatSectionNumber(index)}
            </span>
            <span className="flex-1 leading-5">{section.title}</span>
          </button>
        );
      })}
    </nav>
    <button
      type="button"
      onClick={onTop}
      className="mt-4 inline-flex items-center gap-2 text-xs font-semibold text-slate-500 transition hover:text-slate-900"
    >
      <FaArrowUp className="text-[10px]" /> 回到顶部
    </button>
  </>
);

const HighlightCard: React.FC<{ highlight: PolicyHighlight; tone: InfoTone }> = ({ highlight, tone }) => {
  const Icon = resolveIcon(highlight.icon);
  return (
    <div className={cn(studioElevatedPanelClassName, 'border')}>
      <Icon
        className={cn(
          tone === 'emerald' && 'text-emerald-600',
          tone === 'sky' && 'text-sky-600',
          tone === 'rose' && 'text-rose-600',
          tone === 'amber' && 'text-amber-600',
          tone === 'violet' && 'text-violet-600',
          tone === 'teal' && 'text-teal-600',
          tone === 'slate' && 'text-slate-600',
        )}
      />
      <h3 className="mt-3 font-semibold text-slate-950">{highlight.title}</h3>
      <p className="mt-2 text-sm leading-6 text-slate-600">{highlight.body}</p>
    </div>
  );
};

const AgreementCard: React.FC<{
  agreement: PolicyAgreement;
  copied: boolean;
  onCopy: () => void;
  onOpenSection: (sectionId: string) => void;
  sectionTitle: (sectionId: string) => string;
}> = ({ agreement, copied, onCopy, onOpenSection, sectionTitle }) => {
  const Icon = agreementIcons[agreement.key] || FaFileContract;
  const tone = agreementTones[agreement.key] || 'slate';
  return (
    <div id={agreement.anchor} className={cn(studioElevatedPanelClassName, 'scroll-mt-24 border')}>
      <div className="flex items-start gap-3">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-white ring-1 ring-slate-100">
          <Icon
            className={cn(
              tone === 'sky' && 'text-sky-600',
              tone === 'emerald' && 'text-emerald-600',
              tone === 'violet' && 'text-violet-600',
              tone === 'amber' && 'text-amber-600',
              tone === 'teal' && 'text-teal-600',
            )}
          />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-semibold text-slate-950">{agreement.title}</h3>
            <InfoBadge tone={tone}>登录 / 注册勾选项</InfoBadge>
          </div>
          <p className="mt-2 rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-500">{agreement.label}</p>
        </div>
      </div>
      <p className="mt-3 text-sm leading-7 text-slate-600">{agreement.summary}</p>
      <ul className="mt-3 space-y-2 text-sm leading-6 text-slate-600">
        {agreement.points.map((point) => (
          <li key={point} className="flex items-start gap-2">
            <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-slate-300" />
            <span>{point}</span>
          </li>
        ))}
      </ul>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {agreement.sectionIds.map((sectionId) => (
          <button
            key={sectionId}
            type="button"
            onClick={() => onOpenSection(sectionId)}
            className="rounded-full border border-slate-200 bg-white/80 px-3 py-1 text-xs font-medium text-slate-600 transition hover:border-slate-300 hover:text-slate-800"
          >
            相关章节：{sectionTitle(sectionId)}
          </button>
        ))}
        <button
          type="button"
          onClick={onCopy}
          aria-label={`复制「${agreement.title}」链接`}
          className={cn(
            'ml-auto inline-flex shrink-0 items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold transition print:hidden',
            copied
              ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
              : 'border-slate-200 bg-white/80 text-slate-500 hover:border-slate-300 hover:text-slate-700',
          )}
        >
          {copied ? <FaCheckCircle className="text-[11px]" /> : <FaCopy className="text-[11px]" />}
          {copied ? '已复制' : '复制链接'}
        </button>
      </div>
    </div>
  );
};

const WarningCard: React.FC<{ warning: PolicyWarning }> = ({ warning }) => {
  const Icon = resolveIcon(warning.icon);
  return (
    <div className="rounded-2xl border border-rose-200 bg-rose-50/75 p-5 text-rose-800">
      <div className="flex items-start gap-3">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-white text-rose-700 ring-1 ring-rose-100">
          <Icon />
        </div>
        <div>
          <h3 className="font-semibold">{warning.title}</h3>
          <p className="mt-2 text-sm leading-7">{warning.body}</p>
        </div>
      </div>
    </div>
  );
};

function PolicySkeleton() {
  return (
    <div className="space-y-4" aria-hidden="true">
      <InfoPanel>
        <div className="animate-pulse space-y-3">
          <div className="h-5 w-40 rounded-full bg-slate-200" />
          <div className="h-4 w-full rounded-full bg-slate-100" />
          <div className="h-4 w-4/5 rounded-full bg-slate-100" />
        </div>
      </InfoPanel>
      {[0, 1, 2].map((key) => (
        <InfoPanel key={key}>
          <div className="animate-pulse space-y-3">
            <div className="h-5 w-32 rounded-full bg-slate-200" />
            <div className="h-4 w-full rounded-full bg-slate-100" />
            <div className="h-4 w-5/6 rounded-full bg-slate-100" />
            <div className="h-4 w-2/3 rounded-full bg-slate-100" />
          </div>
        </InfoPanel>
      ))}
    </div>
  );
}

const PolicyPage: React.FC = () => {
  const [policy, setPolicy] = useState<PolicyDocument | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [activeId, setActiveId] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const copyTimer = useRef<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data } = await apiWithRetry.get<PolicyDocumentResponse>('/api/policy/document');
      if (data?.success && data.document) {
        setPolicy(data.document);
      } else {
        setError('条文数据不完整，请稍后重试。');
      }
    } catch (err) {
      setError(resolveLoadError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => () => {
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
  }, []);

  // 阅读进度与目录高亮共用一个 rAF 节流的滚动监听，避免两套监听互相抢帧。
  useEffect(() => {
    if (!policy) return;
    const ids = policy.sections.map((section) => `policy-${section.id}`);
    let frame = 0;

    const update = () => {
      frame = 0;
      const scrollTop = window.scrollY;
      const scrollable = document.documentElement.scrollHeight - window.innerHeight;
      setProgress(scrollable > 0 ? Math.min(100, Math.max(0, Math.round((scrollTop / scrollable) * 100))) : 100);

      let current = ids[0] || '';
      for (const id of ids) {
        const element = document.getElementById(id);
        if (element && element.getBoundingClientRect().top <= 140) current = id;
      }
      setActiveId(current);
    };

    const onScroll = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
    };

    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [policy]);

  // 支持直接分享 #policy-<id>：条文渲染完成后跳到对应章节。
  useEffect(() => {
    if (!policy) return;
    const hash = window.location.hash;
    if (!hash.startsWith('#policy-')) return;
    const element = document.getElementById(hash.slice(1));
    if (element) element.scrollIntoView({ block: 'start' });
  }, [policy]);

  const scrollToAnchor = useCallback((anchor: string) => {
    const element = document.getElementById(anchor);
    if (!element) return;
    setActiveId(anchor);
    window.history.replaceState(null, '', `#${anchor}`);
    element.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  const jumpTo = useCallback((id: string) => scrollToAnchor(`policy-${id}`), [scrollToAnchor]);

  const scrollToTop = useCallback(() => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  // 锚点已自带 policy- 前缀（章节是 policy-<id>，四份文件是 policy-agreement-<key>），
  // 因此这里按完整锚点拼分享链接，复制出来的地址能直接落到该段。
  const copyAnchorLink = useCallback(async (anchor: string) => {
    const url = `${window.location.origin}${window.location.pathname}#${anchor}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopiedId(anchor);
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopiedId(null), 2000);
    } catch {
      setCopiedId(null);
    }
  }, []);

  const highlightTones: InfoTone[] = useMemo(() => ['sky', 'emerald', 'rose'], []);
  const sessionSection = policy?.sections.find((section) => section.id === 'changes');

  return (
    <InfoQueryShell maxWidthClassName="max-w-7xl">
      <div className="space-y-6">
        <InfoQueryHero
          eyebrow={policy?.eyebrow || 'Terms And Privacy'}
          title={policy?.title || '服务条款与隐私政策'}
          description={
            policy?.description ||
            'Synapse - 综合服务平台的使用规则、数据处理方式、用户权利、安全限制与联系方式，集中说明于本页。'
          }
          icon={FaVolumeUp}
          tone="slate"
          meta={(
            <>
              {policy && <InfoBadge tone="slate">版本 v{policy.version}</InfoBadge>}
              {policy && <InfoBadge tone="sky">生效 {policy.effectiveDate}</InfoBadge>}
              {policy && <InfoBadge tone="slate">最近修订 {policy.lastUpdated}</InfoBadge>}
              {policy && (
                <InfoBadge tone="emerald">同意有效期 {policy.procedures.consentValidityDays} 天</InfoBadge>
              )}
              <InfoBadge tone="rose">风险提示</InfoBadge>
            </>
          )}
          actions={(
            <div className="flex flex-wrap gap-3 print:hidden">
              <InfoPrimaryButton type="button" tone="slate" onClick={() => window.print()}>
                <span className="inline-flex items-center gap-2">
                  <FaPrint className="text-[12px]" /> 打印 / 另存为 PDF
                </span>
              </InfoPrimaryButton>
              <button
                type="button"
                className={studioSecondaryButtonClassName}
                onClick={() => jumpTo(sessionSection?.id ?? policy?.sections[0]?.id ?? '')}
              >
                <span className="inline-flex items-center gap-2">
                  <FaHistory className="text-[12px]" /> 查看本次修订
                </span>
              </button>
            </div>
          )}
        />

        {loading && !policy && <PolicySkeleton />}

        {error && (
          <InfoPanel className="border-rose-200 bg-rose-50/85">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-3 text-rose-800">
                <FaExclamationTriangle className="mt-1 shrink-0" />
                <div className="text-sm leading-6">
                  <div className="font-semibold">无法加载政策条文</div>
                  <div className="mt-1 whitespace-pre-line">{error}</div>
                </div>
              </div>
              <button type="button" className={studioSecondaryButtonClassName} onClick={() => void load()}>
                <span className="inline-flex items-center gap-2">
                  <FaSyncAlt className="text-[12px]" /> 重新加载
                </span>
              </button>
            </div>
          </InfoPanel>
        )}

        {policy && (
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]">
            <div className="lg:sticky lg:top-24 lg:self-start print:hidden">
              <details className="lg:hidden">
                <summary className="cursor-pointer rounded-2xl border border-slate-200 bg-white/80 px-4 py-3 text-sm font-semibold text-slate-700">
                  条款目录（{policy.sections.length} 章）
                </summary>
                <div className="mt-3">
                  <PolicyToc
                    sections={policy.sections}
                    activeId={activeId}
                    progress={progress}
                    onJump={jumpTo}
                    onTop={scrollToTop}
                  />
                </div>
              </details>
              <InfoPanel compact className="hidden lg:block">
                <div className="mb-3 text-[11px] font-semibold uppercase tracking-[0.26em] text-slate-500">
                  条款目录
                </div>
                <PolicyToc
                  sections={policy.sections}
                  activeId={activeId}
                  progress={progress}
                  onJump={jumpTo}
                  onTop={scrollToTop}
                />
              </InfoPanel>
            </div>

            <div className="space-y-5">
              <InfoPanel>
                <InfoSectionTitle
                  title="阅读摘要"
                  description="以下摘要帮助快速定位条款主题，完整内容请按章节阅读。"
                  icon={FaFileAlt}
                  tone="slate"
                />
                <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                  {policy.highlights.map((highlight, index) => (
                    <HighlightCard
                      key={highlight.title}
                      highlight={highlight}
                      tone={highlightTones[index % highlightTones.length]}
                    />
                  ))}
                </div>
              </InfoPanel>

              <InfoPanel>
                <InfoSectionTitle
                  title="登录与注册须逐项同意的文件"
                  description="登录与注册页面会逐项要求勾选下列四份文件；每一项对应本页条款的一部分，正文按章节排列在本页下方。"
                  icon={FaFileContract}
                  tone="teal"
                />
                <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                  {policy.agreements.map((agreement) => (
                    <AgreementCard
                      key={agreement.key}
                      agreement={agreement}
                      copied={copiedId === agreement.anchor}
                      onCopy={() => void copyAnchorLink(agreement.anchor)}
                      onOpenSection={(sectionId) => scrollToAnchor(`policy-${sectionId}`)}
                      sectionTitle={(sectionId) =>
                        policy.sections.find((section) => section.id === sectionId)?.title ?? sectionId
                      }
                    />
                  ))}
                </div>
              </InfoPanel>

              {policy.sections.map((section, index) => {
                const Icon = resolveIcon(section.icon);
                const tone = resolveTone(section.emphasis, index);
                const anchor = `policy-${section.id}`;
                const copied = copiedId === anchor;
                return (
                  <motion.section
                    key={section.id}
                    id={`policy-${section.id}`}
                    className="scroll-mt-24"
                    initial={{ opacity: 0, y: 14 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.22, delay: Math.min(index * 0.03, 0.3) }}
                  >
                    <InfoPanel>
                      <InfoSectionTitle
                        eyebrow={`第 ${formatSectionNumber(index)} 章 / 共 ${policy.sections.length} 章`}
                        title={section.title}
                        description={section.summary}
                        icon={Icon}
                        tone={tone}
                        action={(
                          <button
                            type="button"
                            onClick={() => void copyAnchorLink(anchor)}
                            aria-label={`复制「${section.title}」章节链接`}
                            className={cn(
                              'inline-flex shrink-0 items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold transition print:hidden',
                              copied
                                ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                                : 'border-slate-200 bg-white/80 text-slate-500 hover:border-slate-300 hover:text-slate-700',
                            )}
                          >
                            {copied ? <FaCheckCircle className="text-[11px]" /> : <FaCopy className="text-[11px]" />}
                            {copied ? '已复制' : '复制链接'}
                          </button>
                        )}
                      />
                      <ul className="space-y-3 text-sm leading-7 text-slate-600">
                        {section.items.map((item, itemIndex) => (
                          <li
                            key={item}
                            className="flex items-start gap-3 rounded-2xl border border-slate-100 bg-white/65 p-3"
                          >
                            <span className="mt-1 font-mono text-[11px] text-slate-400">
                              {formatSectionNumber(index)}.{itemIndex + 1}
                            </span>
                            <span>{item}</span>
                          </li>
                        ))}
                      </ul>
                      {section.emphasis === 'critical' && (
                        <p className="mt-4 rounded-2xl border border-rose-100 bg-rose-50/70 px-4 py-3 text-xs leading-6 text-rose-700">
                          本章节涉及账户处置、数据保留或自动化风控，请重点阅读。
                        </p>
                      )}
                    </InfoPanel>
                  </motion.section>
                );
              })}

              <InfoPanel className="border-rose-100">
                <InfoSectionTitle
                  title="重点风险提示"
                  description="以下条款涉及账户、授权与平台责任边界，请重点阅读。"
                  icon={FaExclamationTriangle}
                  tone="rose"
                />
                <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                  {policy.warnings.map((warning) => (
                    <WarningCard key={warning.title} warning={warning} />
                  ))}
                </div>
              </InfoPanel>

              <InfoPanel>
                <InfoSectionTitle
                  title="本次修订"
                  description="版本变化意味着此前的同意不再覆盖新条文，依赖同意的功能会要求重新同意。"
                  icon={FaHistory}
                  tone="sky"
                />
                <div className="space-y-4">
                  {policy.revisions.map((revision) => (
                    <div key={revision.version} className="rounded-2xl border border-slate-100 bg-white/65 p-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <InfoBadge tone="sky">v{revision.version}</InfoBadge>
                        <span className="inline-flex items-center gap-1.5 text-xs text-slate-500">
                          <FaClock className="text-[10px]" /> {revision.date}
                        </span>
                      </div>
                      <ul className="mt-3 space-y-2 text-sm leading-6 text-slate-600">
                        {revision.changes.map((change) => (
                          <li key={change} className="flex items-start gap-2">
                            <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-sky-400" />
                            <span>{change}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                  <p className="text-xs leading-6 text-slate-500">{policy.historyNote}</p>
                </div>
              </InfoPanel>

              <InfoPanel>
                <InfoSectionTitle
                  title="联系方式与程序化入口"
                  description="咨询、反馈、数据权利请求与侵权投诉请使用官方邮箱；自动化客户端可直接调用下列接口。"
                  icon={FaAddressBook}
                  tone="sky"
                />
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  {policy.contacts.map((contact) => (
                    <a
                      key={contact.email}
                      href={`mailto:${contact.email}`}
                      className={cn(studioElevatedPanelClassName, 'border transition hover:-translate-y-0.5 hover:shadow-md')}
                    >
                      <div className="flex items-start gap-3">
                        <FaEnvelope className="mt-1 text-sky-600" />
                        <div>
                          <div className="font-semibold text-slate-950">{contact.label}</div>
                          <div className="text-sm text-slate-600">{contact.email}</div>
                          <div className="mt-1 text-xs leading-5 text-slate-500">{contact.scope}</div>
                        </div>
                      </div>
                    </a>
                  ))}
                </div>
                <div className="mt-5 rounded-2xl border border-slate-100 bg-white/65 p-4">
                  <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                    <FaCode className="text-slate-500" /> 接口说明
                  </div>
                  <dl className="mt-3 grid grid-cols-1 gap-2 text-xs text-slate-600 sm:grid-cols-2">
                    {[
                      { label: '获取条文', value: policy.procedures.documentEndpoint },
                      { label: '获取版本', value: policy.procedures.versionEndpoint },
                      { label: '记录同意', value: policy.procedures.recordConsentEndpoint },
                      { label: '撤回同意', value: policy.procedures.revokeConsentEndpoint },
                      { label: '查询同意', value: policy.procedures.checkConsentEndpoint },
                    ].map((entry) => (
                      <div key={entry.value} className="flex items-center justify-between gap-3 rounded-xl bg-slate-50 px-3 py-2">
                        <dt className="text-slate-500">{entry.label}</dt>
                        <dd className="font-mono text-[11px] text-slate-700">{entry.value}</dd>
                      </div>
                    ))}
                  </dl>
                  <p className="mt-3 inline-flex items-center gap-2 text-xs text-slate-500">
                    <FaGlobe className="text-[10px]" />
                    同意记录默认有效 {policy.procedures.consentValidityDays} 天，过期后需重新同意。
                  </p>
                </div>
              </InfoPanel>

              <p className="px-1 text-xs leading-6 text-slate-400">
                本页条文版本 v{policy.version}，生效日期 {policy.effectiveDate}，最近修订 {policy.lastUpdated}。
              </p>
            </div>
          </div>
        )}
      </div>
    </InfoQueryShell>
  );
};

export default PolicyPage;
