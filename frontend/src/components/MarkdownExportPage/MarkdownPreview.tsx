import React from 'react';
import { FaEye } from 'react-icons/fa';
import { studioPageFont, studioSurfaceClassName } from '../studioTheme';
import { StudioLoadingState } from '../studioFeedback';

interface Props {
  html: string;
  isKatexLoaded: boolean;
  previewRef: React.RefObject<HTMLDivElement | null>;
}

const MarkdownPreview: React.FC<Props> = ({ html, isKatexLoaded, previewRef }) => {
  return (
    <div className={studioSurfaceClassName}>
      <div className="flex items-center gap-2 bg-slate-900 p-4 text-white">
        <FaEye className="text-lg" aria-hidden />
        <h3 className="text-lg font-semibold">实时预览</h3>
      </div>
      <div className="p-4">
        <div
          ref={previewRef}
          className="h-64 overflow-y-auto rounded-2xl border border-slate-200 bg-white p-4 prose prose-sm max-w-none sm:h-96"
          style={{ fontFamily: studioPageFont } as React.CSSProperties}
        >
          {isKatexLoaded ? (
            <div dangerouslySetInnerHTML={{ __html: html }} />
          ) : (
            <StudioLoadingState text="正在准备公式渲染..." minHeightClassName="min-h-[240px]" />
          )}
        </div>
      </div>
    </div>
  );
};

export default MarkdownPreview;
