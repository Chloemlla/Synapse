import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchCDictSpeech, type CDictSpeechPayload } from '../../api/cdict';

export type SpeechMode = 'engine' | 'engine-uk' | 'uk' | 'us';
export interface SpeechState { status: 'idle' | 'loading' | 'playing'; key: string; error: string }
const IDLE: SpeechState = { status: 'idle', key: '', error: '' };

export function useTranslatorSpeech(context: string) {
  const [state, setState] = useState<SpeechState>(IDLE);
  const sequence = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const objectUrl = useRef<string | null>(null);
  const release = useCallback(() => {
    sequence.current++;
    controller.current?.abort();
    controller.current = null;
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
    setState({ status: 'loading', key, error: '' });
    try {
      const blob = await fetchCDictSpeech({ ...payload, text }, request.signal);
      if (version !== sequence.current || request.signal.aborted) return;
      const url = URL.createObjectURL(blob);
      objectUrl.current = url;
      const player = new Audio(url);
      audio.current = player;
      player.onended = () => { if (version === sequence.current) stop(); };
      player.onerror = () => {
        if (version !== sequence.current) return;
        release();
        setState({ status: 'idle', key, error: '语音播放失败，请重试。' });
      };
      await player.play();
      if (version !== sequence.current || request.signal.aborted) return;
      controller.current = null;
      setState({ status: 'playing', key, error: '' });
    } catch {
      if (version !== sequence.current || request.signal.aborted) return;
      release();
      setState({ status: 'idle', key, error: '语音暂时不可用，请重试或选择另一种发音。' });
    }
  }, [release, stop]);
  return { state, play, stop };
}
