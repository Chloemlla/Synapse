export type TranslationProvider = 'cdict' | 'deeplx';
export interface LanguageOption { code: string; label: string }
export interface TranslationResult {
  translatedText: string;
  sourceLang: string;
  targetLang: string;
  alternatives: string[];
  phonetic?: string;
  dictionary: string[];
  frequency?: number;
}
export interface TranslatorHistoryItem {
  id: string;
  createdAt: string;
  provider: TranslationProvider;
  sourceText: string;
  translatedText: string;
  sourceLang: string;
  targetLang: string;
  result?: TranslationResult;
}

export const HISTORY_KEY = 'synapse_deeplx_history';
export const LANGUAGE_NAMES: Record<string, string> = {
  auto: '自动识别', 'zh-CHS': '中文（简体）', 'zh-CHT': '中文（繁体）', en: '英语',
  ja: '日语', ko: '韩语', fr: '法语', de: '德语', es: '西班牙语', it: '意大利语',
  pt: '葡萄牙语', ru: '俄语', ar: '阿拉伯语', hi: '印地语', id: '印度尼西亚语',
  th: '泰语', vi: '越南语',
};
export const DEEPLX_LANGUAGES: LanguageOption[] = ['ZH', 'EN', 'JA', 'KO', 'FR', 'DE', 'ES', 'IT', 'PT', 'RU', 'AR']
  .map(code => ({ code, label: LANGUAGE_NAMES[canonicalCDictLanguage(code)] || code }));
// These are the gateway codes pinned by CDict's VivoTranslationClientTest, not a guessed list.
export const CDICT_FALLBACK_LANGUAGES: LanguageOption[] = ['zh-CHS', 'en', 'de', 'es', 'fr', 'hi', 'id', 'it', 'ja', 'ko', 'pt', 'ru', 'th', 'vi']
  .map(code => ({ code, label: LANGUAGE_NAMES[code] || code }));

export function canonicalCDictLanguage(raw: string): string {
  const code = raw.trim().toLowerCase();
  if (['zh', 'zh-cn', 'zh-chs', 'zh-hans'].includes(code)) return 'zh-CHS';
  if (['zh-tw', 'zh-cht', 'zh-hant'].includes(code)) return 'zh-CHT';
  return code;
}
export function languageForProvider(raw: string, provider: TranslationProvider): string {
  if (raw.toLowerCase() === 'auto') return 'auto';
  const code = canonicalCDictLanguage(raw);
  return provider === 'cdict' ? code : code.startsWith('zh-') ? 'ZH' : code.toUpperCase();
}
export function selectProviderLanguages(source: string, target: string, provider: TranslationProvider, options: LanguageOption[]) {
  const nextSource = languageForProvider(source, provider);
  const nextTarget = languageForProvider(target, provider);
  const supports = (code: string) => options.some(option => option.code === code);
  return {
    source: nextSource === 'auto' || supports(nextSource) ? nextSource : 'auto',
    target: supports(nextTarget) ? nextTarget : supports(languageForProvider('en', provider))
      ? languageForProvider('en', provider) : options[0]?.code || languageForProvider('en', provider),
  };
}

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
// Only present natural-language fields, never phonetic service URLs / credentials / raw objects.
export function displayText(value: unknown): string {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  return /https?:\/\/|(?:appKey|ttsId|filename|token|signature)\s*=/i.test(text) ? '' : text;
}
export function normalizePhonetic(value: unknown): string {
  if (typeof value === 'string' && /^[\[{]/.test(value.trim())) {
    try { return normalizePhonetic(JSON.parse(value)); } catch { return ''; }
  }
  if (Array.isArray(value)) return value.map(normalizePhonetic).filter(Boolean).join('，');
  if (value !== null && typeof value === 'object') {
    const node = record(value);
    const text = displayText(node.text);
    if (text) return text;
    return Object.values(node).filter(item => item !== null && typeof item === 'object').map(normalizePhonetic).filter(Boolean).join('，');
  }
  return displayText(value);
}
export function assertCDictSuccess(value: unknown): void {
  const response = record(value);
  const failedCode = ['code', 'retcode'].some(key => response[key] !== undefined && Number(response[key]) !== 0);
  if (response.success === false || failedCode || response.error) throw new Error('服务暂时无法完成请求，请稍后重试。');
}
function translationSegments(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(translationSegments);
  if (value === null || typeof value !== 'object') return [];
  const node = record(value);
  return translationSegments(node.translation ?? node.translatedText ?? node.trans_text ?? node.text);
}
function dictionaryTexts(value: unknown): string[] {
  if (typeof value === 'string') return displayText(value) ? [displayText(value)] : [];
  if (Array.isArray(value)) return value.flatMap(dictionaryTexts);
  const node = record(value);
  return ['text', 'meaning', 'definition', 'explain', 'explains', 'definitions', 'examples', 'word', 'value']
    .flatMap(key => node[key] === undefined ? [] : dictionaryTexts(node[key]));
}
export function normalizeCDictTranslation(value: unknown, from: string, to: string): TranslationResult {
  assertCDictSuccess(value);
  const response = record(value);
  const data = record(response.data);
  const translatedText = translationSegments(data.translation ?? data.translations ?? response.translation ?? response.translations).join('\n');
  if (!translatedText.trim()) throw new Error('暂未获得译文，请调整文本后重试。');
  const basic = record(data.basic);
  const dictionary = [...new Set([
    ...dictionaryTexts(data.dictionary), ...dictionaryTexts(data.explains), ...dictionaryTexts(basic.explains),
    ...dictionaryTexts(data.web), ...dictionaryTexts(data.wordForms),
  ])];
  return {
    translatedText,
    sourceLang: canonicalCDictLanguage(String(data.from || response.from || from)),
    targetLang: canonicalCDictLanguage(String(data.to || response.to || to)),
    alternatives: dictionaryTexts(data.alternatives),
    phonetic: normalizePhonetic(data.phonetic ?? basic.phonetic) || undefined,
    dictionary,
    frequency: typeof data.freq === 'number' && Number.isFinite(data.freq) ? data.freq : undefined,
  };
}
export function normalizeCDictLanguages(value: unknown): LanguageOption[] {
  assertCDictSuccess(value);
  const response = record(value);
  const data = record(response.data);
  const lists = [value, response.data, data.langs, data.list, data.languages, response.list, response.languages, response.langs];
  const options = new Map<string, LanguageOption>();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const node = record(item);
      const raw = typeof item === 'string' ? item : node.code || node.lang || node.langCode || node.name;
      if (typeof raw !== 'string' || !/^[a-z]{2,3}(-[a-z]{2,4})?$/i.test(raw.trim())) continue;
      const code = canonicalCDictLanguage(raw);
      if (code === 'auto' || options.has(code)) continue;
      options.set(code, { code, label: displayText(node.label ?? node.langName ?? node.name) || LANGUAGE_NAMES[code] || code });
    }
  }
  if (!options.size) throw new Error('语言列表暂时不可用。');
  return [...options.values()];
}
export function loadHistory(): TranslatorHistoryItem[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    if (!Array.isArray(value)) return [];
    return value.filter(item => {
      const node = record(item);
      return ['id', 'createdAt', 'sourceText', 'translatedText', 'sourceLang', 'targetLang'].every(key => typeof node[key] === 'string')
        && (node.provider === undefined || node.provider === 'cdict' || node.provider === 'deeplx');
    }).slice(0, 8).map(item => ({ ...item, provider: item.provider || 'deeplx', result: undefined }));
  } catch { return []; }
}
export function saveHistory(items: TranslatorHistoryItem[]): void {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(items.slice(0, 8))); } catch { /* Storage is optional. */ }
}
// English accent codes are pinned by Android's Accent enum; Chinese by its phonetic fixture.
// Other gateway codes are kept as-is, not guessed ISO country suffixes.
export function engineLanguage(language: string): string | undefined {
  const code = canonicalCDictLanguage(language);
  if (!code || code === 'auto') return undefined;
  if (['en', 'en-us', 'en-usa'].includes(code)) return 'en-USA';
  if (['en-gb', 'en-gbr'].includes(code)) return 'en-GBR';
  return code;
}
