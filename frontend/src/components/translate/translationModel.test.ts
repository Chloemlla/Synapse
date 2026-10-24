import { beforeEach, describe, expect, it } from 'vitest';
import { canonicalCDictLanguage, CDICT_FALLBACK_LANGUAGES, DEEPLX_LANGUAGES, engineLanguage, HISTORY_KEY,
  loadHistory, normalizeCDictLanguages, normalizeCDictTranslation, normalizePhonetic, saveHistory, selectProviderLanguages } from './translationModel';

beforeEach(() => localStorage.clear());
describe('CDict translation contract normalization', () => {
  it('preserves multiline translation, detection, dictionary metadata and displayable phonetics', () => {
    const result = normalizeCDictTranslation({ success: true, retcode: 0, code: 0, data: {
      translation: '你好\n世界', from: 'en', to: 'zh-CHS', phonetic: '[{"filename":"https://voice.example/?appKey=private","ttsId":"private","text":"nǐ hǎo"}]',
      freq: 42, basic: { explains: ['问候'] }, dictionary: [{ definition: '打招呼', audio: 'https://private.example' }],
    } }, 'auto', 'zh-CHS');
    expect(result).toMatchObject({ translatedText: '你好\n世界', sourceLang: 'en', targetLang: 'zh-CHS', phonetic: 'nǐ hǎo', frequency: 42, dictionary: ['打招呼', '问候'] });
    expect(JSON.stringify(result)).not.toContain('private');
  });
  it('keeps legitimate technical vocabulary while omitting service metadata', () => {
    const result = normalizeCDictTranslation({ data: {
      translation: '文件名', dictionary: ['filename means 文件名', 'appKey is a configuration term'],
      phonetic: [{ text: '/test/', filename: 'https://voice.example.org/private' }],
    } }, 'en', 'zh-CHS');
    expect(result.dictionary).toEqual(['filename means 文件名', 'appKey is a configuration term']);
    expect(result.phonetic).toBe('/test/');
    expect(JSON.stringify(result)).not.toContain('voice.example.org');
  });
  it('joins array segments by newline, never joins characters of a string', () => {
    expect(normalizeCDictTranslation({ data: { translation: ['one', { translation: 'two' }] } }, 'en', 'de').translatedText).toBe('one\ntwo');
    expect(normalizeCDictTranslation({ data: { translation: 'hello' } }, 'en', 'de').translatedText).toBe('hello');
    expect(normalizeCDictTranslation({ translations: [{ text: 'first' }, { trans_text: 'second' }] }, 'en', 'de').translatedText).toBe('first\nsecond');
  });
  it.each([{ retcode: 10000 }, { retcode: 4 }, { code: 1 }, { code: '9' }, { success: false }])('rejects logical failures at HTTP 200: %j', failure => {
    expect(() => normalizeCDictTranslation({ ...failure, data: { translation: 'not success' } }, 'en', 'de')).toThrow();
  });
  it('rejects empty or malformed translation responses without recursing indefinitely', () => {
    expect(() => normalizeCDictTranslation({}, 'auto', 'en')).toThrow();
    expect(() => normalizeCDictTranslation({ data: { translation: [{}] } }, 'auto', 'en')).toThrow();
  });
  it('drops malformed and service-bearing phonetic data instead of leaking it', () => {
    expect(normalizePhonetic('[{"filename":"https://secret.example"')).toBe('');
    expect(normalizePhonetic('https://secret.example?ttsId=private')).toBe('');
    expect(normalizePhonetic('/hello/')).toBe('/hello/');
  });
});
describe('language and provider mapping', () => {
  it.each([
    ['en', 'ZH-chs', 'ja'], { data: ['en', 'zh-CHS', 'ja'] },
    { data: { list: [{ code: 'en' }, { lang: 'zh-CHS' }, { langCode: 'Ja' }] } },
    { languages: ['en', 'zh-CHS', 'ja'] }, { data: { languages: ['en', 'zh-CHS', 'ja'] } },
    { list: ['en', 'zh-CHS', 'ja'] }, { langs: ['en', 'zh-CHS', 'ja'] },
  ].map(value => ({ value })))('normalizes the Android supported language list envelopes', ({ value }) => {
    expect(normalizeCDictLanguages(value).map(option => option.code)).toEqual(['en', 'zh-CHS', 'ja']);
  });
  it('deduplicates aliases, keeps legitimate dynamic codes and rejects malformed lists', () => {
    expect(normalizeCDictLanguages(['zh', 'zh-CHS', 'en', 'auto', 'xx-ZZZ', 'https://evil', { name: '法语' }]).map(option => option.code)).toEqual(['zh-CHS', 'en', 'xx-zzz']);
    expect(() => normalizeCDictLanguages({ data: { list: [] } })).toThrow();
    expect(() => normalizeCDictLanguages({ code: 5, data: ['en'] })).toThrow();
  });
  it('converts provider codes in both directions and recovers unsupported selections', () => {
    expect(selectProviderLanguages('zh-CHS', 'en', 'deeplx', DEEPLX_LANGUAGES)).toEqual({ source: 'ZH', target: 'EN' });
    expect(selectProviderLanguages('ZH', 'EN', 'cdict', CDICT_FALLBACK_LANGUAGES)).toEqual({ source: 'zh-CHS', target: 'en' });
    expect(selectProviderLanguages('HI', 'AR', 'cdict', CDICT_FALLBACK_LANGUAGES)).toEqual({ source: 'hi', target: 'en' });
    expect(canonicalCDictLanguage('ZH-CHS')).toBe('zh-CHS');
    expect(engineLanguage('EN')).toBe('en-USA');
    expect(engineLanguage('en-GB')).toBe('en-GBR');
    expect(engineLanguage('ZH')).toBe('zh-CHS');
    expect(engineLanguage('auto')).toBeUndefined();
  });
});
describe('backward compatible history', () => {
  it('restores old DeepLX entries and keeps new provider identities', () => {
    const old = { id: 'old', createdAt: 'today', sourceText: 'hello', translatedText: '你好', sourceLang: 'EN', targetLang: 'ZH' };
    localStorage.setItem(HISTORY_KEY, JSON.stringify([old, { ...old, id: 'new', provider: 'cdict' }, { invalid: true }]));
    expect(loadHistory().map(item => item.provider)).toEqual(['deeplx', 'cdict']);
    saveHistory(loadHistory());
    expect(JSON.parse(localStorage.getItem(HISTORY_KEY)!)).toHaveLength(2);
  });
  it('ignores malformed browser storage', () => { localStorage.setItem(HISTORY_KEY, '{'); expect(loadHistory()).toEqual([]); });
});
