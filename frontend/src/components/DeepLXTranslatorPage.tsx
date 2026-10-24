import React from 'react';
import { FaCopy, FaExchangeAlt, FaHistory, FaLanguage, FaPaste, FaTrash } from 'react-icons/fa';
import { useAuth } from '../hooks/useAuth';
import { useNotification } from './Notification';
import { InfoQueryHero, studioFieldClassName, studioMainSurfaceClassName, studioPageClassName, studioPanelClassName,
  studioPrimaryButtonClassName, studioSecondaryButtonClassName, studioTextareaClassName } from './studioTheme';
import { StudioEmptyState, StudioErrorNote, StudioErrorState, StudioLoadingState } from './studioFeedback';
import { DonationPanel } from './translate/DonationPanel';
import { SpeechControls } from './translate/SpeechControls';
import { TranslationDetails } from './translate/TranslationDetails';
import { LANGUAGE_NAMES, canonicalCDictLanguage, type TranslationProvider } from './translate/translationModel';
import { useTranslator } from './translate/useTranslator';

// Keep the established lazy route export; /translate now offers both providers.
export const DeepLXTranslatorPage: React.FC = () => {
  const { user } = useAuth();
  const { setNotification } = useNotification();
  const restrictedUntil = user?.translationAccessUntil ? Date.parse(user.translationAccessUntil) : 0;
  const restricted = Number.isFinite(restrictedUntil) && restrictedUntil > Date.now();
  const allowed = !!user && user.isTranslationEnabled !== false && !restricted;
  const translator = useTranslator(allowed);
  const { provider, result } = translator;
  const sourceDisplay = translator.sourceLang === 'auto' ? result?.sourceLang || 'auto' : translator.sourceLang;
  const labelFor = (code: string) => translator.options.find(option => option.code === code)?.label || LANGUAGE_NAMES[canonicalCDictLanguage(code)] || code;
  const copy = async () => {
    if (!result?.translatedText) return;
    try {
      await navigator.clipboard.writeText(result.translatedText);
      setNotification({ type: 'success', message: '译文已复制到剪贴板' });
    } catch { setNotification({ type: 'error', message: '复制失败，请检查浏览器权限。' }); }
  };
  const paste = async () => {
    try { translator.setSourceText(await navigator.clipboard.readText()); }
    catch { setNotification({ type: 'error', message: '读取剪贴板失败，请检查浏览器权限。' }); }
  };
  if (!allowed) return <section className={studioPageClassName}>
    <StudioErrorState message={!user ? '请先登录后使用翻译与朗读。' : restricted ? '当前账户的翻译权限处于限制状态。' : '当前账户未开放翻译功能。'} />
  </section>;
  return <section className={`${studioPageClassName} space-y-6`}>
    <InfoQueryHero eyebrow="TRANSLATE" title="翻译与朗读" icon={FaLanguage} tone="slate"
      description="选择翻译服务，阅读译文与词典释义，也可以朗读原文和译文。"
      meta={<span>单次翻译最多 5000 个字符 · 朗读最多 300 个字符</span>} />
    <div className={`${studioMainSurfaceClassName} space-y-5`}>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <label className="min-w-0 flex-1 text-sm font-semibold text-slate-700">翻译服务
          <select aria-label="翻译服务" className={studioFieldClassName} value={provider}
            onChange={event => translator.setProvider(event.target.value as TranslationProvider)}>
            <option value="cdict">CDict</option><option value="deeplx">DeepLX</option>
          </select>
        </label>
        <label className="flex shrink-0 items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={translator.autoTranslate} onChange={event => translator.setAutoTranslate(event.target.checked)} />自动翻译
        </label>
      </div>
      {provider === 'deeplx' ? <div>
        {translator.configLoading ? <StudioLoadingState text="读取翻译服务状态…" minHeightClassName="min-h-12" />
          : translator.configError ? <StudioErrorState message={translator.configError} onRetry={translator.retryConfig} />
          : <p role="status" className="text-sm text-slate-500">{translator.deepLXEnabled ? '服务可用' : 'DeepLX 当前不可用，请选择 CDict 或稍后重试。'}</p>}
      </div> : <div>
        {translator.languagesLoading && <StudioLoadingState text="正在获取支持的语言，暂显示常用语言…" minHeightClassName="min-h-12" />}
        {translator.languagesError && <StudioErrorState message={translator.languagesError} onRetry={translator.retryLanguages} />}
      </div>}
      <div className="grid min-w-0 gap-3 sm:grid-cols-[1fr_auto_1fr] sm:items-end">
        <label className="min-w-0 text-sm font-semibold text-slate-700">原文语言
          <select aria-label="原文语言" className={studioFieldClassName} value={translator.sourceLang} onChange={event => translator.setSourceLang(event.target.value)}>
            <option value="auto">自动识别</option>{translator.options.map(option => <option key={option.code} value={option.code}>{option.label}</option>)}
          </select>
        </label>
        <button type="button" className={studioSecondaryButtonClassName} onClick={translator.swap}><FaExchangeAlt aria-hidden />交换语言</button>
        <label className="min-w-0 text-sm font-semibold text-slate-700">译文语言
          <select aria-label="译文语言" className={studioFieldClassName} value={translator.targetLang} onChange={event => translator.setTargetLang(event.target.value)}>
            {translator.options.map(option => <option key={option.code} value={option.code}>{option.label}</option>)}
          </select>
        </label>
      </div>
      <p className="text-sm text-slate-500">{labelFor(sourceDisplay)} → {labelFor(translator.targetLang)}</p>
      <div className="grid min-w-0 gap-5 lg:grid-cols-2">
        <section className="min-w-0 space-y-3" aria-label="原文编辑">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="min-w-0 font-semibold text-slate-900">原文</h2>
            <div className="flex shrink-0 gap-2">
              <button type="button" className={studioSecondaryButtonClassName} onClick={() => void paste()}><FaPaste aria-hidden />粘贴</button>
              <button type="button" className={studioSecondaryButtonClassName} onClick={() => translator.setSourceText('')}><FaTrash aria-hidden />清空</button>
            </div>
          </div>
          <textarea aria-label="待翻译文本" className={studioTextareaClassName} rows={10} value={translator.sourceText}
            placeholder="输入想翻译的内容，或者直接把整段文案粘贴进来。" onChange={event => translator.setSourceText(event.target.value)}
            onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); void translator.translateNow(); } }} />
          <p className="text-sm text-slate-500">{translator.sourceText.length} / 5000 个字符 · Ctrl / Command + Enter 立即翻译</p>
          {translator.sourceText.trim().length > 5000 && <StudioErrorNote>单次最多翻译 5000 个字符，请缩短文本。</StudioErrorNote>}
          <SpeechControls side="source" text={translator.sourceText} language={sourceDisplay} speech={translator.speech} disabled={!allowed} />
        </section>
        <section className="min-w-0 space-y-3" aria-label="译文阅读">
          <div className="flex items-center justify-between gap-2">
            <h2 className="min-w-0 font-semibold text-slate-900">译文</h2>
            <button type="button" className={studioSecondaryButtonClassName} disabled={!result?.translatedText} onClick={() => void copy()}><FaCopy aria-hidden />复制</button>
          </div>
          {translator.translating ? <StudioLoadingState text="正在翻译…" minHeightClassName="min-h-32" /> : <TranslationDetails result={result} />}
          <SpeechControls side="target" text={result?.translatedText || ''} language={result?.targetLang || translator.targetLang} speech={translator.speech} disabled={!allowed} />
        </section>
      </div>
      {translator.error && <StudioErrorState message={translator.error} onRetry={() => void translator.translateNow()} />}
      <button type="button" className={studioPrimaryButtonClassName} disabled={!translator.available || translator.translating || !translator.sourceText.trim() || translator.sourceText.trim().length > 5000}
        onClick={() => void translator.translateNow()}>立即翻译</button>
    </div>
    <section className={`${studioPanelClassName} space-y-4`} aria-label="翻译历史">
      <div className="flex items-center justify-between gap-2">
        <h2 className="min-w-0 flex items-center gap-2 font-semibold text-slate-900"><FaHistory aria-hidden />最近翻译</h2>
        <button type="button" className={studioSecondaryButtonClassName} disabled={!translator.history.length} onClick={() => translator.setHistory([])}>清空历史</button>
      </div>
      <p className="text-sm text-slate-500">最近 8 条记录仅保存在本浏览器，可随时清空。</p>
      {translator.history.length ? <ul className="grid min-w-0 gap-3 md:grid-cols-2">
        {translator.history.map(item => <li className="min-w-0" key={item.id}>
          <button type="button" onClick={() => translator.restore(item)} className={`${studioSecondaryButtonClassName} w-full flex-col items-start text-left`}>
            <span className="text-xs text-slate-500">{item.provider === 'cdict' ? 'CDict' : 'DeepLX'} · {labelFor(item.sourceLang)} → {labelFor(item.targetLang)}</span>
            <span className="w-full break-words line-clamp-2">{item.sourceText}</span>
            <span className="w-full break-words line-clamp-2 font-normal text-slate-500">{item.translatedText}</span>
          </button>
        </li>)}
      </ul> : <StudioEmptyState message="还没有翻译记录，完成一次翻译后可在这里重新查看。" />}
    </section>
    <DonationPanel />
  </section>;
};
