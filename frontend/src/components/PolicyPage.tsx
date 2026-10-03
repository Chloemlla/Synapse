import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import {
  FaCopy,
  FaDownload,
  FaExclamationTriangle,
  FaFileAlt,
  FaFileContract,
  FaHistory,
  FaPrint,
  FaSyncAlt,
  FaVolumeUp,
} from 'react-icons/fa';
import type { PolicyDocumentResponse } from '../types/policy';
import { fetchPolicyArchive } from '../api/policy';
import { usePolicyDocument } from '../hooks/usePolicyDocument';
import { searchPolicySections, type PolicySearchResult } from '../utils/policySearch';
import { cn } from '../utils/cn';
import {
  InfoBadge,
  InfoPanel,
  InfoPrimaryButton,
  InfoQueryHero,
  InfoQueryShell,
  InfoSectionTitle,
  studioSecondaryButtonClassName,
  type InfoTone,
} from './studioTheme';
import PolicyToc from './policy/PolicyToc';
import { AgreementCard, HighlightCard, WarningCard } from './policy/policyCards';
import PolicySearchBar, { PolicyReadingControls, READING_SCALES, type ReadingScale } from './policy/PolicySearchBar';
import PolicyConsentStatusPanel from './policy/PolicyConsentStatusPanel';
import PolicySectionPanel from './policy/PolicySectionPanel';
import PolicyDataInventoryPanel from './policy/PolicyDataInventoryPanel';
import PolicyFooter from './policy/PolicyFooter';

// 条文正文由后端单点维护（src/config/policyDocument.ts），本页只负责阅读体验：
// 检索、定位、字号、打印、以及「本设备同意状态」的就地查看与同意。

const READING_SCALE_STORAGE_KEY = 'policy-reading-scale';
const LAST_SECTION_STORAGE_KEY = 'policy-last-section';

/** 上次读到哪一章：长文重进时可以直接跳回去，不必重新滑。 */
const readStoredSection = (): string | null => {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(LAST_SECTION_STORAGE_KEY);
    return raw && raw.trim() ? raw.trim() : null;
  } catch {
    return null;
  }
};

/** 当前焦点是否在可输入元素内（用来避免「/」快捷键抢走键入）。 */
const isTypingTarget = (target: EventTarget | null): boolean => {
  const element = target as HTMLElement | null;
  if (!element) return false;
  const tag = element.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || element.isContentEditable;
};

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

const readStoredScale = (): ReadingScale => {
  if (typeof window === 'undefined') return 1;
  const raw = Number(window.localStorage.getItem(READING_SCALE_STORAGE_KEY));
  return (READING_SCALES as readonly number[]).includes(raw) ? (raw as ReadingScale) : 1;
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
  const { document: policy, loading, error: loadError, reload } = usePolicyDocument();
  const error = loadError ? resolveLoadError(loadError) : null;
  const [progress, setProgress] = useState(0);
  const [activeId, setActiveId] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [readingScale, setReadingScale] = useState<ReadingScale>(readStoredScale);
  const [resumeSectionId, setResumeSectionId] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  // 条文存档下载的进行中状态与结果提示（成功/失败都说清楚，不弹全局通知）
  const [archiving, setArchiving] = useState(false);
  const [archiveNotice, setArchiveNotice] = useState<string | null>(null);
  const copyTimer = useRef<number | null>(null);

  useEffect(() => () => {
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
  }, []);

  const changeScale = useCallback((next: ReadingScale) => {
    setReadingScale(next);
    try {
      window.localStorage.setItem(READING_SCALE_STORAGE_KEY, String(next));
    } catch {
      // 隐私模式下 localStorage 可能不可写：字号仅本次会话生效，不影响阅读
    }
  }, []);

  // 阅读进度与目录高亮共用一个 rAF 节流的滚动监听，避免两套监听互相抢帧。
  useEffect(() => {
    if (!policy) return;
    const ids = policy.sections.map((section) => `policy-${section.id}`);
    let frame = 0;
    let lastSaved = '';

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

      // 只在章节切换时写 localStorage（避免每帧写盘）：下次进入可以「继续阅读」。
      if (current && current !== lastSaved) {
        lastSaved = current;
        try {
          window.localStorage.setItem(LAST_SECTION_STORAGE_KEY, current);
        } catch {
          // 隐私模式不可写：仅失去「继续阅读」能力
        }
      }
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

  // 上次读到哪一章：带了 hash 深链时以深链为准，否则提供「继续阅读」入口（不自动跳，避免打断）。
  useEffect(() => {
    if (!policy) return;
    if (window.location.hash.startsWith('#policy-')) {
      setResumeSectionId(null);
      return;
    }
    const stored = readStoredSection();
    if (!stored) return;
    const id = stored.replace(/^#/, '');
    const index = policy.sections.findIndex((section) => `policy-${section.id}` === id);
    // 首章不提示（那等于从顶部开始），也不提示已经不存在的章节
    setResumeSectionId(index > 0 ? id : null);
  }, [policy]);

  // 「/」聚焦检索框：条文页最常用的动作，鼠标不必先找输入框。
  // 正在输入（input/textarea/contenteditable）时不抢键。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;
      const input = searchInputRef.current;
      if (!input) return;
      event.preventDefault();
      input.focus();
      input.select();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const scrollToAnchor = useCallback((anchor: string) => {
    const element = document.getElementById(anchor);
    if (!element) return;
    setActiveId(anchor);
    window.history.replaceState(null, '', `#${anchor}`);
    element.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  const jumpTo = useCallback((id: string) => scrollToAnchor(`policy-${id}`), [scrollToAnchor]);

  /** 章节 id → 标题，供数据清单表的「详见」链接显示目标章节名。 */
  const sectionTitles = useMemo(() => {
    const map: Record<string, string> = {};
    for (const section of policy?.sections ?? []) map[section.id] = section.title;
    return map;
  }, [policy]);

  const scrollToTop = useCallback(() => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  // 锚点已自带 policy- 前缀（章节是 policy-<id>，四份文件是 policy-agreement-<key>），
  // 因此这里按完整锚点拼分享链接，复制出来的地址能直接落到该段。
  const copyText = useCallback(async (text: string, feedbackKey: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(feedbackKey);
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopiedId(null), 2000);
    } catch {
      setCopiedId(null);
    }
  }, []);

  const copyAnchorLink = useCallback(
    async (anchor: string) => {
      await copyText(`${window.location.origin}${window.location.pathname}#${anchor}`, anchor);
    },
    [copyText],
  );

  // 下载条文存档副本：用户可以把「我同意的那份文本」存到本地，并凭指纹与同意记录对账。
  const handleDownloadArchive = useCallback(async () => {
    setArchiving(true);
    setArchiveNotice(null);
    try {
      const { filename, content } = await fetchPolicyArchive();
      const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setArchiveNotice(`已下载条文存档：${filename}`);
    } catch (err) {
      setArchiveNotice(resolveLoadError(err));
    } finally {
      setArchiving(false);
    }
  }, []);

  const highlightTones: InfoTone[] = useMemo(() => ['sky', 'emerald', 'rose'], []);

  const search: PolicySearchResult = useMemo(
    () => searchPolicySections(policy?.sections ?? [], query),
    [policy, query],
  );
  const searching = search.query.length > 0;
  const matchedSectionIds = useMemo(() => new Set(search.matchedSectionIds), [search.matchedSectionIds]);
  const visibleSections = useMemo(
    () =>
      policy
        ? searching
          ? policy.sections.filter((section) => matchedSectionIds.has(section.id))
          : policy.sections
        : [],
    [policy, searching, matchedSectionIds],
  );
  const itemsTotal = useMemo(
    () => (policy?.sections ?? []).reduce((total, section) => total + section.items.length, 0),
    [policy],
  );
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
            <div className="flex flex-wrap items-center gap-3 print:hidden">
              <InfoPrimaryButton type="button" tone="slate" onClick={() => window.print()}>
                <span className="inline-flex items-center gap-2">
                  <FaPrint className="text-[12px]" /> 打印 / 另存为 PDF
                </span>
              </InfoPrimaryButton>
              <button
                type="button"
                className={studioSecondaryButtonClassName}
                onClick={() => void handleDownloadArchive()}
                disabled={archiving}
                title="下载当前条文的 Markdown 存档副本（含版本与条文指纹，可与同意记录对账）"
              >
                <span className="inline-flex items-center gap-2">
                  <FaDownload className={cn('text-[12px]', archiving && 'animate-pulse')} />
                  {archiving ? '正在生成存档…' : '下载条文存档 (.md)'}
                </span>
              </button>
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

        {error && !policy && (
          <InfoPanel className="border-rose-200 bg-rose-50/85">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-3 text-rose-800">
                <FaExclamationTriangle className="mt-1 shrink-0" />
                <div className="text-sm leading-6">
                  <div className="font-semibold">无法加载政策条文</div>
                  <div className="mt-1 whitespace-pre-line">{error}</div>
                </div>
              </div>
              <button type="button" className={studioSecondaryButtonClassName} onClick={reload}>
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
                    matchedSectionIds={matchedSectionIds}
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
                  matchedSectionIds={matchedSectionIds}
                  onJump={jumpTo}
                  onTop={scrollToTop}
                />
              </InfoPanel>
            </div>

            <div className="space-y-5" style={{ zoom: readingScale }}>
              <InfoPanel className="print:border-0 print:shadow-none">
                <div className="space-y-4">
                  <PolicySearchBar
                    value={query}
                    onChange={setQuery}
                    itemMatchCount={search.itemMatchCount}
                    sectionMatchCount={search.matchedSectionIds.length}
                    sectionsTotal={policy.sections.length}
                    itemsTotal={itemsTotal}
                    inputRef={searchInputRef}
                  />
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <PolicyReadingControls scale={readingScale} onChange={changeScale} />
                    <div className="flex flex-wrap items-center gap-2 print:hidden">
                      {resumeSectionId && (
                        <button
                          type="button"
                          onClick={() => scrollToAnchor(resumeSectionId)}
                          className="inline-flex items-center gap-2 rounded-2xl border border-sky-200 bg-sky-50 px-3 py-1.5 text-xs font-semibold text-sky-700 transition hover:border-sky-300"
                          title="继续上次读到的那一章"
                        >
                          <FaHistory className="text-[11px]" />
                          继续阅读：
                          {policy.sections.find((section) => `policy-${section.id}` === resumeSectionId)?.title ?? '上次位置'}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => void copyAnchorLink(`policy-${visibleSections[0]?.id ?? policy.sections[0]?.id ?? ''}`)}
                        className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 bg-white/80 px-3 py-1.5 text-xs font-semibold text-slate-500 transition hover:border-slate-300 hover:text-slate-700"
                      >
                        <FaCopy className="text-[11px]" /> 复制当前条文链接
                      </button>
                    </div>
                  </div>
                  {archiveNotice && (
                    <p className="flex items-start gap-2 rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-600" role="status">
                      <FaDownload className="mt-0.5 shrink-0 text-slate-400" />
                      <span>{archiveNotice}</span>
                    </p>
                  )}
                </div>
              </InfoPanel>

              <PolicyConsentStatusPanel documentVersion={policy.version} documentHash={policy.documentHash} />

              <InfoPanel className="print:border-0 print:shadow-none">
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

              <InfoPanel className="print:border-0 print:shadow-none">
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
                      searchQuery={search.query}
                    />
                  ))}
                </div>
              </InfoPanel>

              {searching && visibleSections.length === 0 && (
                <InfoPanel className="print:border-0 print:shadow-none">
                  <div className="flex items-start gap-3 text-amber-800">
                    <FaExclamationTriangle className="mt-1 shrink-0" />
                    <div className="text-sm leading-6">
                      <div className="font-semibold">没有条文命中「{query.trim()}」</div>
                      <div className="mt-1">
                        换个关键词（例如「撤回」「保留」「Cookie」「跨境」），或清空检索查看全部 {policy.sections.length} 章。
                      </div>
                    </div>
                  </div>
                </InfoPanel>
              )}

              {visibleSections.map((section, index) => {
                const anchor = `policy-${section.id}`;
                return (
                  <React.Fragment key={section.id}>
                    <PolicySectionPanel
                      section={section}
                      index={policy.sections.findIndex((item) => item.id === section.id)}
                      totalSections={policy.sections.length}
                      matchedItemIndexes={search.matchedItemIndexes[section.id] ?? []}
                      searchQuery={search.query}
                      copied={copiedId === anchor}
                      onCopy={() => void copyAnchorLink(anchor)}
                    />
                    {/* 数据清单章节后面补一张结构化表格：正文里已有逐条文字（可检索/可打印），
                        表格是为了「一眼对比各类信息的保留期与删除方式」。只在未检索或该章命中时渲染，
                        避免检索结果里混入一大块不相关内容。 */}
                    {section.id === 'data-inventory' &&
                    !search.query.trim() &&
                    (policy.dataInventory?.length ?? 0) > 0 ? (
                      <PolicyDataInventoryPanel
                        entries={policy.dataInventory ?? []}
                        updatedAt={policy.dataInventoryUpdatedAt}
                        searchQuery={search.query}
                        sectionTitles={sectionTitles}
                        onJumpToSection={jumpTo}
                      />
                    ) : null}
                  </React.Fragment>
                );
              })}
              <InfoPanel className="border-rose-100 print:border-0 print:shadow-none">
                <InfoSectionTitle
                  title="重点风险提示"
                  description="以下条款涉及账户、授权与平台责任边界，请重点阅读。"
                  icon={FaExclamationTriangle}
                  tone="rose"
                />
                <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                  {policy.warnings.map((warning) => (
                    <WarningCard key={warning.title} warning={warning} searchQuery={search.query} />
                  ))}
                </div>
              </InfoPanel>

              <PolicyFooter
                policy={policy}
                searchQuery={search.query}
                copiedKey={copiedId}
                onCopyHash={() => void copyText(policy.documentHash, "document-hash")}
              />
            </div>
          </div>
        )}
      </div>
    </InfoQueryShell>
  );
};

export default PolicyPage;
