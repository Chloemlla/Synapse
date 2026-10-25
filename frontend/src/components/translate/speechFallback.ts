import { record } from './translationModel';

export type SpeechProvider = 'cdict' | 'microsoft';
export type SpeechFailureStage = 'http' | 'invalid-response' | 'media' | 'play';
type DiagnosticPath = '/api/translate/cdict/languages' | '/api/translate/cdict/tts';
const SAFE_CODES = new Set(['ERR_NETWORK', 'NETWORK_ERROR', 'ECONNABORTED', 'ETIMEDOUT',
  'ERR_BAD_RESPONSE', 'ERR_BAD_REQUEST', 'INVALID_AUDIO_RESPONSE', 'INVALID_SPEECH_INPUT',
  'NotSupportedError', 'NotAllowedError', 'MEDIA_ERROR', 'POLICY_CONSENT_REQUIRED',
  'ACCOUNT_SUSPENDED', 'ACCOUNT_RESTRICTED', 'STEP_UP_REQUIRED', 'IP_VERIFICATION_REQUIRED']);

export function isSpeechCancellation(error: unknown, signal?: AbortSignal): boolean {
  const failure = record(error);
  return signal?.aborted === true || failure.code === 'ERR_CANCELED' || failure.name === 'AbortError';
}
function safeStatus(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;
}
function failureStatus(error: unknown): number | null {
  const failure = record(error);
  return safeStatus(record(failure.response).status) ?? safeStatus(failure.httpStatus);
}
function safeCode(value: unknown): string | number | null {
  if (typeof value === 'string' && SAFE_CODES.has(value)) return value;
  const numeric = typeof value === 'string' && /^-?\d{1,6}$/.test(value) ? Number(value) : value;
  return typeof numeric === 'number' && Number.isInteger(numeric) && Math.abs(numeric) <= 999999 ? numeric : null;
}
function safeRequestId(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9._~-]{1,128}$/.test(value) ? value : null;
}

// Project only bounded diagnostic fields. Never log the error, response, config or spoken text.
export function logTranslatorFailure(path: DiagnosticPath, stage: SpeechFailureStage, error: unknown,
  signal?: AbortSignal, response?: unknown, provider?: SpeechProvider): void {
  if (isSpeechCancellation(error, signal)) return;
  const failure = record(error);
  const reply = record(response ?? failure.response);
  const data = record(reply.data);
  const businessCodes = [safeCode(data.code), safeCode(data.retcode), safeCode(data.errorCode)];
  const businessCode = businessCodes.find(code => code !== null && code !== 0) ?? businessCodes.find(code => code !== null);
  console.error(path === '/api/translate/cdict/languages' ? '[翻译] 语言列表读取失败' : '[翻译] 朗读失败', {
    path,
    httpStatus: safeStatus(reply.status) ?? failureStatus(error),
    errorCode: businessCode ?? safeCode(failure.code) ?? safeCode(failure.name),
    requestId: safeRequestId(record(reply.headers)['x-request-id'])
      ?? safeRequestId(record(reply.headers)['X-Request-Id']) ?? safeRequestId(data.requestId)
      ?? safeRequestId(failure.requestId),
    stage,
    ...(provider ? { provider } : {}),
  });
}

export function canFallbackSpeech(error: unknown, stage: SpeechFailureStage): boolean {
  const failure = record(error);
  if (isSpeechCancellation(error) || failure.name === 'NotAllowedError' || failure.code === 'INVALID_SPEECH_INPUT') return false;
  const status = failureStatus(error);
  if (status !== null && status >= 400 && status < 500) return false;
  if (stage === 'play') return failure.name === 'NotSupportedError';
  if (stage === 'media' || stage === 'invalid-response' || failure.code === 'INVALID_AUDIO_RESPONSE') return true;
  return status === null || status >= 500;
}

export function speechFailureMessage(error: unknown, stage: SpeechFailureStage): string {
  if (record(error).name === 'NotAllowedError') return '浏览器未允许播放语音，请再次点击朗读。';
  const status = failureStatus(error);
  if (status === 401 || status === 403) return '暂时无法朗读，请确认登录状态和翻译权限。';
  if (status === 429) return '朗读请求较多，请稍后重试。';
  return stage === 'media' || stage === 'play' ? '语音播放失败，请重试。' : '语音暂时不可用，请重试或选择另一种发音。';
}
