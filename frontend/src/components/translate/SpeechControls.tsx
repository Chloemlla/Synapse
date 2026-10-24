import { useState } from 'react';
import { FaStop, FaVolumeUp } from 'react-icons/fa';
import { studioFieldClassName, studioSecondaryButtonClassName } from '../studioTheme';
import { StudioErrorNote, StudioLoadingState } from '../studioFeedback';
import { canonicalCDictLanguage, engineLanguage } from './translationModel';
import type { SpeechMode, useTranslatorSpeech } from './useTranslatorSpeech';

type Speech = ReturnType<typeof useTranslatorSpeech>;
export function SpeechControls({ side, text, language, speech, disabled }: {
  side: 'source' | 'target'; text: string; language: string; speech: Speech; disabled: boolean;
}) {
  const [mode, setMode] = useState<SpeechMode>('engine');
  const english = canonicalCDictLanguage(language).startsWith('en');
  const effectiveMode = english ? mode : 'engine';
  const langType = engineLanguage(language);
  const active = speech.state.key === side && speech.state.status !== 'idle';
  const label = side === 'source' ? '原文' : '译文';
  const tooLong = text.trim().length > 300;
  return <div className="mt-3 space-y-2">
    <div className="flex flex-wrap items-center gap-2">
      <label className="min-w-0 flex-1 text-sm text-slate-600">
        <span className="sr-only">{label}发音方式</span>
        <select aria-label={`${label}发音方式`} value={effectiveMode} disabled={disabled} className={studioFieldClassName}
          onChange={event => { speech.stop(); setMode(event.target.value as SpeechMode); }}>
          <option value="engine">{english ? '在线美式朗读' : '在线朗读'}</option>
          {english && <option value="engine-uk">在线英式朗读</option>}
          <option value="uk" disabled={!english}>词典英式发音</option>
          <option value="us" disabled={!english}>词典美式发音</option>
        </select>
      </label>
      <button type="button" className={studioSecondaryButtonClassName} disabled={disabled || !text.trim() || tooLong || !langType}
        onClick={() => active ? speech.stop() : void speech.play(side, effectiveMode === 'uk' || effectiveMode === 'us'
          ? { text, source: 'youdao', type: effectiveMode === 'uk' ? 1 : 2 }
          : { text, source: 'engine', langType: effectiveMode === 'engine-uk' ? 'en-GBR' : langType })}>
        {active ? <FaStop aria-hidden /> : <FaVolumeUp aria-hidden />}{active ? `停止${label}朗读` : `朗读${label}`}
      </button>
    </div>
    {tooLong && <p className="text-sm text-slate-500">朗读最多 300 个字符，请缩短文本；不会截取内容。</p>}
    {!langType && text.trim() && <p className="text-sm text-slate-500">请先选择原文语言，或翻译后使用识别结果朗读。</p>}
    {speech.state.key === side && speech.state.status === 'loading' && <StudioLoadingState text="正在准备语音…" minHeightClassName="min-h-12" />}
    {speech.state.key === side && speech.state.status === 'playing' && <p role="status" className="text-sm text-slate-500">正在朗读{label}</p>}
    {speech.state.key === side && speech.state.error && <StudioErrorNote>{speech.state.error}</StudioErrorNote>}
  </div>;
}
