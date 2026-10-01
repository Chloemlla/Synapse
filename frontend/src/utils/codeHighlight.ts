import { PrismLight as SyntaxHighlighter } from 'react-syntax-highlighter';
import bash from 'react-syntax-highlighter/dist/esm/languages/prism/bash';
import c from 'react-syntax-highlighter/dist/esm/languages/prism/c';
import cpp from 'react-syntax-highlighter/dist/esm/languages/prism/cpp';
import css from 'react-syntax-highlighter/dist/esm/languages/prism/css';
import diff from 'react-syntax-highlighter/dist/esm/languages/prism/diff';
import docker from 'react-syntax-highlighter/dist/esm/languages/prism/docker';
import go from 'react-syntax-highlighter/dist/esm/languages/prism/go';
import ini from 'react-syntax-highlighter/dist/esm/languages/prism/ini';
import java from 'react-syntax-highlighter/dist/esm/languages/prism/java';
import javascript from 'react-syntax-highlighter/dist/esm/languages/prism/javascript';
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json';
import jsx from 'react-syntax-highlighter/dist/esm/languages/prism/jsx';
import markdown from 'react-syntax-highlighter/dist/esm/languages/prism/markdown';
import markup from 'react-syntax-highlighter/dist/esm/languages/prism/markup';
import python from 'react-syntax-highlighter/dist/esm/languages/prism/python';
import rust from 'react-syntax-highlighter/dist/esm/languages/prism/rust';
import sql from 'react-syntax-highlighter/dist/esm/languages/prism/sql';
import tsx from 'react-syntax-highlighter/dist/esm/languages/prism/tsx';
import typescript from 'react-syntax-highlighter/dist/esm/languages/prism/typescript';
import yaml from 'react-syntax-highlighter/dist/esm/languages/prism/yaml';

/**
 * 代码高亮的统一入口。
 *
 * 为什么不用 `{ Prism }`（全量构建）：`react-syntax-highlighter` 的全量 Prism 会走
 * `refractor/all`，在模块求值时逐个注册 **298 个语法**，每个语法都会触发
 * `languages.extend / insertBefore / util.clone / languages.DFS`。线上性能 trace
 * （docs/perf/2026-10-01-captcha-verify-trace-analysis.md）实测这一步独占 621 ms
 * 同步长任务中的约 200 ms。
 *
 * 这里改用 `PrismLight` + 白名单注册：只装应用真正会展示的语法（约 20 个），
 * 其余语言走 `resolveCodeLanguage()` 返回 null，由调用方退化成等宽 `<pre>`，
 * 既不会抛 `Unknown language: \`x\` is not registered`，也不会把整包 Prism 拉进来。
 */
const GRAMMARS = {
  bash,
  c,
  cpp,
  css,
  diff,
  docker,
  go,
  ini,
  java,
  javascript,
  json,
  jsx,
  markdown,
  markup,
  python,
  rust,
  sql,
  tsx,
  typescript,
  yaml,
};

// refractor 的 register() 用语法自身的 displayName 作为键，这里的对象键与之一一对应。
for (const [name, grammar] of Object.entries(GRAMMARS)) {
  SyntaxHighlighter.registerLanguage(name, grammar);
}

/** markdown 里常见的简写/别名 → 已注册语法。 */
const LANGUAGE_ALIASES: Record<string, string[]> = {
  bash: ['sh', 'shell', 'zsh', 'console'],
  cpp: ['c++', 'cc', 'hxx'],
  docker: ['dockerfile'],
  ini: ['conf', 'properties', 'toml'],
  javascript: ['js', 'mjs', 'cjs', 'node'],
  markdown: ['md'],
  markup: ['html', 'xml', 'svg', 'vue'],
  python: ['py', 'python3'],
  typescript: ['ts'],
  yaml: ['yml'],
};

for (const [language, aliases] of Object.entries(LANGUAGE_ALIASES)) {
  SyntaxHighlighter.alias(language, aliases);
}

const REGISTERED_LANGUAGES: ReadonlySet<string> = new Set([
  ...Object.keys(GRAMMARS),
  ...Object.values(LANGUAGE_ALIASES).flat(),
]);

/** 把 markdown 围栏语言名收敛成已注册的 Prism 语言；未注册返回 null（调用方走纯文本兜底）。 */
export function resolveCodeLanguage(raw?: string | null): string | null {
  const normalized = (raw || '').trim().toLowerCase();
  if (!normalized) return null;
  return REGISTERED_LANGUAGES.has(normalized) ? normalized : null;
}

export const CodeHighlighter = SyntaxHighlighter;

export { REGISTERED_LANGUAGES };
