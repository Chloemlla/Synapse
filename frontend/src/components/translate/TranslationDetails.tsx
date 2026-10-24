import { StudioEmptyState } from '../studioFeedback';
import { studioSubPanelClassName } from '../studioTheme';
import type { TranslationResult } from './translationModel';

export function TranslationDetails({ result }: { result: TranslationResult | null }) {
  if (!result) return <StudioEmptyState message="输入文本后开始翻译，译文会显示在这里。" />;
  return <div className="space-y-4">
    <div className={studioSubPanelClassName}>
      <p className="whitespace-pre-wrap break-words text-base leading-8 text-slate-900" aria-label="翻译结果">{result.translatedText}</p>
      {result.phonetic && <p className="mt-3 break-words text-sm text-slate-500" aria-label="音标">{result.phonetic}</p>}
    </div>
    {result.alternatives.length > 0 && <section aria-label="其他译法">
      <h3 className="text-sm font-semibold text-slate-700">其他译法</h3>
      <ul className="mt-2 space-y-2 text-sm leading-7 text-slate-600">{result.alternatives.map((text, index) => <li className="whitespace-pre-wrap break-words" key={index}>{text}</li>)}</ul>
    </section>}
    {result.dictionary.length > 0 && <section aria-label="词典释义">
      <h3 className="text-sm font-semibold text-slate-700">词典释义与例句</h3>
      <ul className="mt-2 space-y-2 text-sm leading-7 text-slate-600">{result.dictionary.map((text, index) => <li className="whitespace-pre-wrap break-words" key={index}>{text}</li>)}</ul>
    </section>}
    {result.frequency !== undefined && <p className="text-sm text-slate-500">词频：{result.frequency}</p>}
  </div>;
}
