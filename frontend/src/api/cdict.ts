import { api } from './api';
import { logTranslatorFailure } from '../components/translate/speechFallback';
import { assertCDictSuccess, displayText, normalizeCDictLanguages, normalizeCDictTranslation, record } from '../components/translate/translationModel';

const PREFIX = '/api/translate/cdict';
export interface CDictTranslatePayload { text: string; from: string; to: string }
export interface CDictSpeechPayload { text: string; source: 'engine' | 'youdao'; langType?: string; type?: 1 | 2 }
export interface DonationChannel { id: string; name: string; hint: string }
export interface DonationInfo { notice: string; channels: DonationChannel[]; supporters: string[] }
export const validDonationChannel = (id: string) => /^[a-z0-9-]{1,32}$/.test(id);

export async function translateWithCDict(payload: CDictTranslatePayload, signal?: AbortSignal) {
  const response = await api.post<unknown>(`${PREFIX}/translate`, payload, { signal });
  return normalizeCDictTranslation(response.data, payload.from, payload.to);
}
export async function fetchCDictLanguages(signal?: AbortSignal) {
  let stage: 'http' | 'invalid-response' = 'http';
  let reply: unknown;
  try {
    const response = await api.get<unknown>(`${PREFIX}/languages`, { signal });
    reply = response;
    stage = 'invalid-response';
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    return normalizeCDictLanguages(response.data);
  } catch (error) {
    logTranslatorFailure(`${PREFIX}/languages`, stage, error, signal, reply);
    throw error;
  }
}
const SPEECH_TIMEOUT = 60000; // CDict can take 20s; the Microsoft Edge request can take 45s.
function speechText(text: string): string {
  const value = text.trim();
  if (!value || value.length > 300) throw Object.assign(
    new Error('朗读内容需为 1–300 个字符，请缩短文本后重试。'), { code: 'INVALID_SPEECH_INPUT' });
  return value;
}
async function fetchSpeech(params: { text: string; source: string; langType?: string; type?: 1 | 2 }, signal?: AbortSignal): Promise<Blob> {
  const response = await api.get<Blob>(`${PREFIX}/tts`, { params, signal, responseType: 'blob', timeout: SPEECH_TIMEOUT });
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const blob = response.data;
  if (!(blob instanceof Blob) || !blob.size || !blob.type.toLowerCase().startsWith('audio/')) throw Object.assign(
    new Error('语音暂时不可用，请稍后重试。'), {
      code: 'INVALID_AUDIO_RESPONSE', httpStatus: response.status,
      requestId: response.headers?.['x-request-id'],
    });
  return blob;
}
export async function fetchCDictSpeech(payload: CDictSpeechPayload, signal?: AbortSignal): Promise<Blob> {
  return fetchSpeech({ ...payload, text: speechText(payload.text) }, signal);
}
export async function fetchMicrosoftTranslatorSpeech(payload: CDictSpeechPayload, signal?: AbortSignal): Promise<Blob> {
  const text = speechText(payload.text);
  const langType = payload.source === 'youdao'
    ? payload.type === 1 ? 'en-GBR' : payload.type === 2 ? 'en-USA' : undefined
    : payload.langType?.trim();
  if (!langType || langType.toLowerCase() === 'auto') throw Object.assign(
    new Error('请先选择朗读语言。'), { code: 'INVALID_SPEECH_INPUT' });
  return fetchSpeech({ source: 'microsoft', text, langType }, signal);
}
export async function fetchCDictDonation(signal?: AbortSignal): Promise<DonationInfo | null> {
  try {
    const response = await api.get<unknown>(`${PREFIX}/donate`, { signal });
    assertCDictSuccess(response.data);
    const data = record(response.data);
    const channels: DonationChannel[] = Array.isArray(data.channels) ? data.channels.flatMap(value => {
      const channel = record(value);
      return typeof channel.id === 'string' && validDonationChannel(channel.id)
        ? [{ id: channel.id, name: displayText(channel.name) || channel.id, hint: displayText(channel.hint) }] : [];
    }) : [];
    return { notice: displayText(data.notice), channels, supporters: Array.isArray(data.supporters) ? data.supporters.map(displayText).filter(Boolean) : [] };
  } catch (error) {
    if (record(record(error).response).status === 404) return null;
    throw error;
  }
}
export type DonationImageSource = { kind: 'blob'; blob: Blob } | { kind: 'remote'; url: string };
export function safeDonationImageUrl(value: unknown): string {
  if (typeof value !== 'string') throw new Error('收款码地址不可用。');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname.includes('.')
    || !/^[a-z0-9.-]+$/i.test(url.hostname) || /^[0-9.]+$/.test(url.hostname)
    || /(^|\.)(localhost|local|internal|test|invalid)$/.test(url.hostname)) throw new Error('收款码地址不可用。');
  return url.href;
}
function readBlobText(blob: Blob): Promise<string> {
  if (typeof blob.text === 'function') return blob.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(new Error('收款码信息读取失败。'));
    reader.readAsText(blob);
  });
}
export async function fetchCDictDonationImage(channel: string, signal?: AbortSignal): Promise<DonationImageSource> {
  if (!validDonationChannel(channel)) throw new Error('请选择有效的赞赏方式。');
  const response = await api.get<Blob>(`${PREFIX}/donate/${encodeURIComponent(channel)}`, { signal, responseType: 'blob' });
  const blob = response.data;
  if (blob instanceof Blob && blob.type.toLowerCase().startsWith('application/json') && blob.size <= 32768) {
    const value: unknown = JSON.parse(await readBlobText(blob));
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    assertCDictSuccess(value);
    return { kind: 'remote', url: safeDonationImageUrl(record(value).imageUrl) };
  }
  if (!(blob instanceof Blob) || !blob.size || !['image/png', 'image/jpeg', 'image/webp'].includes(blob.type.toLowerCase())) {
    throw new Error('收款码暂时不可用，请重试。');
  }
  return { kind: 'blob', blob };
}
export async function claimCDictDonation(payload: { transactionId: string; displayName: string }, signal?: AbortSignal) {
  const transactionId = payload.transactionId.trim();
  const displayName = payload.displayName.trim();
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(transactionId)) throw new Error('交易号需为 6–64 位字母、数字、连字符或下划线。');
  if (!displayName || displayName.length > 32) throw new Error('请填写希望展示的称呼，最多 32 个字。');
  const response = await api.post<unknown>(`${PREFIX}/donate/claim`, { transactionId, displayName }, { signal });
  assertCDictSuccess(response.data);
  const data = record(response.data);
  if (data.success !== true) throw new Error('申请暂时未能提交，请重试。');
  return { duplicated: data.duplicated === true, message: displayText(data.message) || '已提交，请等待核实。' };
}
