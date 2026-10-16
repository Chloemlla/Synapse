import React from 'react';

type KatexModule = typeof import('katex');

interface TexProps {
  /** 不含 $ 定界符的 LaTeX 源码 */
  tex: string;
  display?: boolean;
  className?: string;
}

let katexModule: KatexModule | null = null;
let katexPromise: Promise<KatexModule | null> | null = null;

/**
 * KaTeX（含样式表）按需加载：公式只在少数页面出现，静态 import 会把整个
 * 解析器塞进首屏闭包。加载失败返回 null，由调用方降级显示源码。
 */
export function loadKatex(): Promise<KatexModule | null> {
  if (katexModule) return Promise.resolve(katexModule);
  if (!katexPromise) {
    katexPromise = Promise.all([import('katex'), import('katex/dist/katex.min.css')])
      .then(([mod]) => {
        katexModule = (mod as { default?: KatexModule }).default ?? (mod as unknown as KatexModule);
        return katexModule;
      })
      .catch((error) => {
        console.error('[Tex] KaTeX 加载失败:', error);
        katexPromise = null;
        return null;
      });
  }
  return katexPromise;
}

/** 用仓库里已有的 KaTeX 渲染公式；出错时 KaTeX 自己降级为红色原文，不抛异常。 */
export default function Tex({ tex, display = false, className }: TexProps) {
  const [katex, setKatex] = React.useState<KatexModule | null>(katexModule);

  React.useEffect(() => {
    if (katex) return undefined;
    let alive = true;
    void loadKatex().then((mod) => {
      if (alive && mod) setKatex(mod);
    });
    return () => {
      alive = false;
    };
  }, [katex]);

  const html = React.useMemo(() => {
    if (!katex) return null;
    try {
      return katex.renderToString(tex, { displayMode: display, throwOnError: false });
    } catch (error) {
      console.error('[Tex] 公式渲染失败:', error);
      return null;
    }
  }, [katex, tex, display]);

  // 未加载完/渲染失败时先给出源码：公式在这类讲解页里是正文的一部分，不能留空白。
  if (html === null) return <span className={className}>{tex}</span>;

  return (
    <span
      className={className}
      // KaTeX 输出为受控静态标记，源码全部来自本目录的常量
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
