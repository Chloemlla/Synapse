import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchDeepLXConfig, translateWithDeepLX } from '../../api/deeplx';
import { fetchCDictLanguages, translateWithCDict } from '../../api/cdict';
import { CDICT_FALLBACK_LANGUAGES, DEEPLX_LANGUAGES, loadHistory, saveHistory, selectProviderLanguages, languageForProvider,
  type LanguageOption, type TranslationProvider, type TranslationResult, type TranslatorHistoryItem } from './translationModel';
import { useTranslatorSpeech } from './useTranslatorSpeech';

export function useTranslator(allowed: boolean) {
  const [provider, setProviderState] = useState<TranslationProvider>('cdict');
  const [sourceText, setSourceTextState] = useState('');
  const [sourceLang, setSourceLangState] = useState('auto');
  const [targetLang, setTargetLangState] = useState('en');
  const [result, setResult] = useState<TranslationResult | null>(null);
  const [autoTranslate, setAutoTranslate] = useState(true);
  const [translating, setTranslating] = useState(false);
  const [error, setError] = useState('');
  const [history, setHistory] = useState(loadHistory);
  const [deepLXEnabled, setDeepLXEnabled] = useState(false);
  const [configLoading, setConfigLoading] = useState(true);
  const [configError, setConfigError] = useState('');
  const [configAttempt, setConfigAttempt] = useState(0);
  const [languages, setLanguages] = useState<LanguageOption[]>(CDICT_FALLBACK_LANGUAGES);
  const [languagesLoading, setLanguagesLoading] = useState(true);
  const [languagesError, setLanguagesError] = useState('');
  const [languagesAttempt, setLanguagesAttempt] = useState(0);
  const controller = useRef<AbortController | null>(null);
  const version = useRef(0);
  const speech = useTranslatorSpeech(JSON.stringify([allowed, provider, sourceText, sourceLang, targetLang, result?.translatedText, result?.sourceLang]));
  const invalidate = useCallback(() => {
    version.current++; controller.current?.abort(); controller.current = null;
    setTranslating(false); setError(''); speech.stop();
  }, [speech.stop]);
  const clearResult = useCallback(() => { invalidate(); setResult(null); }, [invalidate]);
  const setSourceText = useCallback((value: string) => { clearResult(); setSourceTextState(value); }, [clearResult]);
  const setSourceLang = useCallback((value: string) => { clearResult(); setSourceLangState(value); }, [clearResult]);
  const setTargetLang = useCallback((value: string) => { clearResult(); setTargetLangState(value); }, [clearResult]);
  const options = useMemo(() => provider === 'cdict' ? languages : DEEPLX_LANGUAGES, [provider, languages]);
  const setProvider = useCallback((value: TranslationProvider) => {
    if (value === provider) return;
    clearResult();
    const next = selectProviderLanguages(sourceLang, targetLang, value, value === 'cdict' ? languages : DEEPLX_LANGUAGES);
    setProviderState(value); setSourceLangState(next.source); setTargetLangState(next.target);
    if (next.source !== languageForProvider(sourceLang, value) || next.target !== languageForProvider(targetLang, value)) {
      setAutoTranslate(false);
      setError('已切换服务，原语言不受支持，已调整为可用语言，请确认后翻译。');
    }
  }, [provider, clearResult, sourceLang, targetLang, languages]);
  useEffect(() => { saveHistory(history); }, [history]);
  useEffect(() => {
    if (!allowed) { invalidate(); return; }
    let active = true;
    setConfigLoading(true); setConfigError('');
    void fetchDeepLXConfig().then(config => { if (active) setDeepLXEnabled(config.enabled); })
      .catch(() => { if (active) { setDeepLXEnabled(false); setConfigError('暂时无法读取 DeepLX 状态。'); } })
      .finally(() => { if (active) setConfigLoading(false); });
    return () => { active = false; };
  }, [allowed, configAttempt, invalidate]);
  useEffect(() => {
    if (!allowed || provider !== 'cdict') return;
    const request = new AbortController();
    setLanguagesLoading(true); setLanguagesError('');
    void fetchCDictLanguages(request.signal).then(next => {
      if (request.signal.aborted) return;
      setLanguages(next);
    }).catch(() => {
      if (!request.signal.aborted) setLanguagesError('语言列表读取失败，暂用常用语言；可重试获取完整列表。');
    }).finally(() => { if (!request.signal.aborted) setLanguagesLoading(false); });
    return () => request.abort();
  }, [allowed, provider, languagesAttempt]);
  useEffect(() => {
    if (provider !== 'cdict') return;
    const next = selectProviderLanguages(sourceLang, targetLang, provider, languages);
    if (next.source !== sourceLang || next.target !== targetLang) {
      clearResult(); setSourceLangState(next.source); setTargetLangState(next.target);
      setAutoTranslate(false);
      setError('支持的语言列表已更新，已调整为可用语言，请确认后翻译。');
    }
  }, [provider, languages, sourceLang, targetLang, clearResult]);
  useEffect(() => () => { version.current++; controller.current?.abort(); }, []);
  const available = allowed && (provider === 'cdict' || deepLXEnabled);
  const translateNow = useCallback(async () => {
    const text = sourceText.trim();
    if (!text) { clearResult(); return; }
    if (text.length > 5000) { invalidate(); setError('单次最多翻译 5000 个字符，请缩短文本。'); return; }
    if (!available) { invalidate(); setError('当前翻译服务不可用，请选择其他服务或稍后重试。'); return; }
    invalidate();
    const generation = version.current;
    const request = new AbortController(); controller.current = request;
    setTranslating(true); setResult(null);
    try {
      let next: TranslationResult;
      if (provider === 'cdict') next = await translateWithCDict({ text, from: sourceLang, to: targetLang }, request.signal);
      else {
        const response = await translateWithDeepLX({ text, sourceLang, targetLang }, request.signal);
        if (response.success === false || !response.translatedText?.trim()) throw new Error('No translation');
        next = { ...response, alternatives: response.alternatives || [], dictionary: [] };
      }
      if (generation !== version.current || request.signal.aborted) return;
      setResult(next);
      const item: TranslatorHistoryItem = {
        id: `${provider}:${next.sourceLang}:${next.targetLang}:${text}`, provider, createdAt: new Date().toISOString(),
        sourceText: text, translatedText: next.translatedText, sourceLang: next.sourceLang, targetLang: next.targetLang, result: next,
      };
      setHistory(previous => [item, ...previous.filter(entry => entry.id !== item.id)].slice(0, 8));
    } catch {
      if (generation === version.current && !request.signal.aborted) setError('暂时无法完成翻译，请检查网络或选择其他服务后重试。');
    } finally {
      if (generation === version.current && !request.signal.aborted) { controller.current = null; setTranslating(false); }
    }
  }, [available, sourceText, sourceLang, targetLang, provider, invalidate, clearResult]);
  useEffect(() => {
    if (!autoTranslate || !available || !sourceText.trim() || sourceText.trim().length > 5000) return;
    const timeout: number = window.setTimeout(() => void translateNow(), 550);
    return () => window.clearTimeout(timeout);
  }, [autoTranslate, available, translateNow, sourceText]);
  const swap = () => {
    const from = sourceLang === 'auto' ? result?.sourceLang : sourceLang;
    if (!from || from === 'auto') { setError('自动识别时，请先完成一次翻译再交换语言。'); return; }
    const next = selectProviderLanguages(targetLang, from, provider, options);
    if (next.target !== languageForProvider(from, provider)) { setError('当前服务不支持交换后的语言，请重新选择。'); return; }
    const previous = sourceText;
    clearResult(); setSourceLangState(next.source); setTargetLangState(next.target);
    setSourceTextState(result?.translatedText || previous);
    if (result) setResult({ translatedText: previous, sourceLang: next.source, targetLang: next.target, alternatives: [], dictionary: [] });
  };
  const restore = (item: TranslatorHistoryItem) => {
    clearResult();
    const next = selectProviderLanguages(item.sourceLang, item.targetLang, item.provider, item.provider === 'cdict' ? languages : DEEPLX_LANGUAGES);
    setProviderState(item.provider); setSourceLangState(next.source); setTargetLangState(next.target); setSourceTextState(item.sourceText);
    setResult(item.result || { translatedText: item.translatedText, sourceLang: item.sourceLang, targetLang: item.targetLang, alternatives: [], dictionary: [] });
  };
  return { provider, setProvider, sourceText, setSourceText, sourceLang, setSourceLang, targetLang, setTargetLang,
    result, autoTranslate, setAutoTranslate, translating, error, history, setHistory, options, available,
    deepLXEnabled, configLoading, configError, retryConfig: () => setConfigAttempt(value => value + 1),
    languagesLoading, languagesError, retryLanguages: () => setLanguagesAttempt(value => value + 1),
    translateNow, swap, restore, speech };
}
