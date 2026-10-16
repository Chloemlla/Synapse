import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  studioGhostButtonClassName,
  studioModalCardClassName,
  studioModalOverlayClassName,
  studioSecondaryButtonClassName,
  studioSubPanelClassName,
  studioSurfaceClassName,
} from './studioTheme';
import { StudioErrorNote, StudioSuccessNote } from './studioFeedback';
import { UnifiedLoadingSpinner } from './LoadingSpinner';
import { cn } from '../utils/cn';

interface MermaidProps {
  code: string;
}

const SUPPORTED_MERMAID_PREFIX =
  /^(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie|gitGraph|mindmap|timeline|zenuml|sankey)/i;

// G12-04/G12-05：模块级只初始化一次。
// securityLevel 用默认的 'strict'，禁用 mermaid 的 click 指令与原始 HTML 标签注入；
// flowchart 关闭 htmlLabels，让标签输出原生 <text>，避免 DOMPurify 消毒把 foreignObject 里的文字剥掉。
//
// 性能：`mermaid` 单独一个 chunk（≈1.7 MB gzip）。用动态 import 而不是顶层静态 import，
// 保证「代码块里没有 mermaid 图」的页面（例如 /captcha-verify）永远不会下载/求值它；
// 见 docs/perf/2026-10-01-captcha-verify-trace-analysis.md。
type MermaidApi = typeof import('mermaid')['default'];
type DomPurifyApi = typeof import('dompurify')['default'];

let mermaidLoader: Promise<MermaidApi> | null = null;

function loadMermaid(): Promise<MermaidApi> {
  if (!mermaidLoader) {
    mermaidLoader = import('mermaid')
      .then((mod) => {
        const api = mod.default;
        api.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: 'default',
          fontFamily: 'inherit',
          flowchart: { htmlLabels: false },
        });
        return api;
      })
      .catch((error) => {
        // 失败不缓存，下次进代码块还能重试。
        mermaidLoader = null;
        throw error;
      });
  }
  return mermaidLoader;
}

let domPurifyLoader: Promise<DomPurifyApi> | null = null;

// DOMPurify 同样改成按需加载：mermaid 内部也依赖它，而它俩当前会被 rolldown 合并进同一个
// chunk；若在 Mermaid.tsx 顶层静态引用，就会把该 chunk 变成 MarkdownRenderer 的静态依赖，
// 于是「有 markdown 但没图表」的文章页也要下 1.5 MB gzip 的 mermaid（见 trace 报告 §九）。
function loadDomPurify(): Promise<DomPurifyApi> {
  if (!domPurifyLoader) {
    domPurifyLoader = import('dompurify')
      .then((mod) => mod.default)
      .catch((error) => {
        domPurifyLoader = null;
        throw error;
      });
  }
  return domPurifyLoader;
}

function normalizeMermaidCode(input: string): string {
  return (input || '')
    .replace(/\r\n/g, '\n')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2212\uFE63\uFF0D]/g, '-')
    .replace(/\n\s*--[!>]*>/g, ' -->')
    .trim();
}

const Mermaid: React.FC<MermaidProps> = ({ code }) => {
  const [svg, setSvg] = useState<string | null>(null);
  const zoomCleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => zoomCleanup.current?.(), []);
  const [error, setError] = useState(false);
  const [isRendering, setIsRendering] = useState(true);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const diagramId = useMemo(
    () => `mermaid-${Math.random().toString(36).slice(2, 10)}`,
    []
  );

  useEffect(() => {
    let cancelled = false;

    const renderDiagram = async () => {
      const normalizedCode = normalizeMermaidCode(code);

      setIsRendering(true);
      setError(false);
      setSvg(null);

      if (!normalizedCode) {
        setError(true);
        setIsRendering(false);
        return;
      }

      const candidates = [normalizedCode];
      if (!SUPPORTED_MERMAID_PREFIX.test(normalizedCode)) {
        candidates.push(`graph TD\n${normalizedCode}`);
      }

      try {
        const mermaid = await loadMermaid();
        if (cancelled) {
          return;
        }

        let renderedSvg: string | null = null;
        for (const candidate of candidates) {
          try {
            const result = await mermaid.render(
              `${diagramId}-${candidates.indexOf(candidate)}`,
              candidate
            );
            renderedSvg = result.svg;
            break;
          } catch {
            renderedSvg = null;
          }
        }

        if (!renderedSvg) {
          throw new Error('Unable to render Mermaid diagram');
        }

        const DOMPurify = await loadDomPurify();
        if (cancelled) {
          return;
        }

        setSvg(
          DOMPurify.sanitize(renderedSvg, {
            USE_PROFILES: { svg: true, svgFilters: true },
            ADD_TAGS: ['foreignObject'],
          })
        );
      } catch (renderError) {
        console.error('[Mermaid] render failed:', renderError);
        if (!cancelled) {
          setError(true);
        }
      } finally {
        if (!cancelled) {
          setIsRendering(false);
        }
      }
    };

    void renderDiagram();

    return () => {
      cancelled = true;
    };
  }, [code, diagramId]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopyState('copied');
    } catch (copyError) {
      // 剪贴板不可用时不能只写 console：用户会以为已经复制了。
      console.error('[Mermaid] copy failed:', copyError);
      setCopyState('failed');
    }
  };

  const handleZoom = () => {
    if (!svg) {
      return;
    }

    zoomCleanup.current?.();
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const modal = document.createElement('div');
    modal.className = `${studioModalOverlayClassName} cursor-pointer`;

    const container = document.createElement('div');
    container.className = `${studioModalCardClassName} max-h-[95%] max-w-[95%] overflow-auto`;
    container.innerHTML = svg;
    container.setAttribute('role', 'dialog');
    container.setAttribute('aria-modal', 'true');
    container.setAttribute('aria-label', '图表预览');
    container.onclick = (event) => event.stopPropagation();
    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = cn(studioSecondaryButtonClassName, 'mb-3');
    closeButton.textContent = '关闭图表';
    container.prepend(closeButton);

    modal.appendChild(container);
    document.body.appendChild(modal);

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close(); }
      else if (event.key === 'Tab') { event.preventDefault(); closeButton.focus(); }
    };
    const close = () => {
      window.removeEventListener('keydown', onKeyDown);
      modal.remove();
      zoomCleanup.current = null;
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
    zoomCleanup.current = close;
    modal.onclick = close;
    closeButton.onclick = close;
    closeButton.focus();
    window.addEventListener('keydown', onKeyDown);
  };

  if (isRendering) {
    return (
      <div className={studioSubPanelClassName}>
        <UnifiedLoadingSpinner size="md" text="正在渲染图表..." />
      </div>
    );
  }

  if (error || !svg) {
    return (
      <div className="space-y-2">
        <StudioErrorNote className="flex flex-wrap items-center justify-between gap-2">
          <span>图表渲染失败，可复制下方源码到其它工具里排查。</span>
          <button type="button" onClick={() => void handleCopy()} className={studioGhostButtonClassName}>
            复制原始代码
          </button>
        </StudioErrorNote>
        {copyState === 'copied' ? <StudioSuccessNote className="text-xs">源码已复制。</StudioSuccessNote> : null}
        {copyState === 'failed' ? (
          <StudioErrorNote className="text-xs">复制失败，请手动选中下方源码复制。</StudioErrorNote>
        ) : null}
        <pre className="overflow-x-auto rounded-2xl border border-rose-200 bg-white/80 p-3 font-mono text-xs text-slate-700">
          {code}
        </pre>
      </div>
    );
  }

  return (
    <div className={`${studioSurfaceClassName} group my-4 p-4`}>
      {/* F5-08：放大入口必须是键盘可达的真实按钮（securityLevel=strict 下图表内无交互元素） */}
      <button
        type="button"
        onClick={handleZoom}
        aria-label="放大图表"
        title="放大图表"
        className="block w-full cursor-zoom-in rounded-2xl text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-2"
      >
        <div
          className="mermaid-svg flex max-h-[600px] justify-center overflow-auto"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </button>
      <div
        aria-hidden
        className="pointer-events-none absolute right-2 top-2 rounded-full border border-slate-100 bg-white/90 px-2 py-1 text-[10px] font-medium text-slate-500 opacity-0 shadow-sm backdrop-blur transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
      >
        点击放大
      </div>
    </div>
  );
};

export default Mermaid;
