import { afterEach, describe, expect, it, vi } from 'vitest';
import { canFallbackSpeech, isSpeechCancellation, logTranslatorFailure } from './speechFallback';

afterEach(() => vi.restoreAllMocks());
describe('fallback eligibility is limited to service and audio failures', () => {
  it.each([
    [{ code: 'ERR_NETWORK' }, 'http', true],
    [{ response: { status: 504 } }, 'http', true],
    [{ response: { status: 403 } }, 'http', false],
    [{ response: { status: 429 } }, 'invalid-response', false],
    [{ response: { status: 422 } }, 'media', false],
    [{ response: { status: 302 } }, 'http', false],
    [{ code: 'INVALID_AUDIO_RESPONSE', httpStatus: 200 }, 'http', true],
    [{ code: 'INVALID_SPEECH_INPUT' }, 'http', false],
    [new DOMException('decode', 'NotSupportedError'), 'play', true],
    [new DOMException('autoplay', 'NotAllowedError'), 'play', false],
    [new DOMException('autoplay', 'NotAllowedError'), 'media', false],
    [new Error('unknown play failure'), 'play', false],
    [{ code: 'MEDIA_ERROR' }, 'media', true],
    [{ code: 'ERR_CANCELED' }, 'http', false],
    [new DOMException('cancel', 'AbortError'), 'media', false],
  ] as const)('classifies a bounded failure at %s/%s', (error, stage, allowed) => {
    expect(canFallbackSpeech(error, stage)).toBe(allowed);
  });
  it('treats an aborted controller as cancellation even if the transport throws a different error', () => {
    const request = new AbortController(); request.abort();
    expect(isSpeechCancellation(new Error('network'), request.signal)).toBe(true);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    logTranslatorFailure('/api/translate/cdict/tts', 'http', new Error('PRIVATE'), request.signal, undefined, 'microsoft');
    expect(log).not.toHaveBeenCalled();
  });
});
