import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchCDictSpeech, fetchMicrosoftTranslatorSpeech, type CDictSpeechPayload } from '../../api/cdict';
import { canFallbackSpeech, isSpeechCancellation, logTranslatorFailure, speechFailureMessage,
  type SpeechFailureStage, type SpeechProvider } from './speechFallback';

export type SpeechMode = 'engine' | 'engine-uk' | 'uk' | 'us';
export interface SpeechState { status: 'idle' | 'loading' | 'playing'; key: string; error: string; provider?: SpeechProvider }
const IDLE: SpeechState = { status: 'idle', key: '', error: '' };

export function useTranslatorSpeech(context: string) {
  const [state, setState] = useState<SpeechState>(IDLE);
  const sequence = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const objectUrl = useRef<string | null>(null);
  const releaseMedia = useCallback(() => {
    const current = audio.current;
    audio.current = null;
    if (current) {
      current.onended = null;
      current.onerror = null;
      current.pause();
      current.removeAttribute('src');
      current.load();
    }
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = null;
  }, []);
  const release = useCallback(() => {
    sequence.current++;
    controller.current?.abort();
    controller.current = null;
    releaseMedia();
  }, [releaseMedia]);
  const stop = useCallback(() => { release(); setState(IDLE); }, [release]);
  useEffect(() => { stop(); return release; }, [context, release, stop]);

  const play = useCallback(async (key: string, payload: CDictSpeechPayload) => {
    release();
    const version = sequence.current;
    const text = payload.text.trim();
    if (!text || text.length > 300) {
      setState({ status: 'idle', key, error: '朗读内容需为 1–300 个字符，请缩短文本后重试。' });
      return;
    }
    const request = new AbortController();
    controller.current = request;
    const isCurrent = () => version === sequence.current && !request.signal.aborted;
    const attempt = async (provider: SpeechProvider): Promise<void> => {
      let failed = false;
      let player: HTMLAudioElement | null = null;
      let stage: SpeechFailureStage = 'http';
      const ownsAttempt = () => isCurrent() && !failed && (!player || audio.current === player);
      const fail = async (error: unknown, failureStage: SpeechFailureStage) => {
        if (!ownsAttempt()) return;
        // Media errors and play rejections can describe the same failure. Claim it before any await.
        failed = true;
        if ((error as { code?: unknown } | null)?.code === 'INVALID_AUDIO_RESPONSE') failureStage = 'invalid-response';
        if (isSpeechCancellation(error, request.signal)) { stop(); return; }
        logTranslatorFailure('/api/translate/cdict/tts', failureStage, error, request.signal, undefined, provider);
        releaseMedia();
        if (provider === 'cdict' && canFallbackSpeech(error, failureStage)) {
          // Keep the same generation and controller, including throughout playback.
          await attempt('microsoft');
        } else {
          release();
          setState({ status: 'idle', key, error: speechFailureMessage(error, failureStage) });
        }
      };
      setState({ status: 'loading', key, error: '', provider });
      try {
        const fetchAudio = provider === 'cdict' ? fetchCDictSpeech : fetchMicrosoftTranslatorSpeech;
        const blob = await fetchAudio({ ...payload, text }, request.signal);
        if (!ownsAttempt()) return;
        // Defend the media boundary even if a transport returns a nonaudio value.
        stage = 'invalid-response';
        if (!(blob instanceof Blob) || !blob.size || !blob.type.toLowerCase().startsWith('audio/')) {
          throw Object.assign(new Error('语音暂时不可用。'), { code: 'INVALID_AUDIO_RESPONSE' });
        }
        stage = 'media';
        objectUrl.current = URL.createObjectURL(blob);
        player = new Audio(objectUrl.current);
        audio.current = player;
        player.onended = () => { if (ownsAttempt()) stop(); };
        player.onerror = () => {
          const error = new DOMException('语音播放失败。', player?.error?.code === 1 ? 'AbortError' : 'NotSupportedError');
          void fail(error, 'media');
        };
        stage = 'play';
        await player.play();
        if (!ownsAttempt()) return;
        setState({ status: 'playing', key, error: '', provider });
      } catch (error) {
        await fail(error, stage);
      }
    };
    await attempt('cdict');
  }, [release, releaseMedia, stop]);
  return { state, play, stop };
}
