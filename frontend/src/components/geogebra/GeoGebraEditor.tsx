import { useEffect, useRef } from "react";
// monaco-editor 0.57 的 exports 只有 "."、"./*" 与 "./*.js"，且 "./*" 指向 "./esm/vs/*.js"：
// 所以裸 "esm/vs/..." 前缀会被再拼一次（TS2307 / vite 解析失败），必须写 "./editor/*"。
// editor.api 是不含语言贡献的轻量入口，CSS 由 ESM 模块自己 import（min/** 已不在 exports 内）。
import * as monaco from "monaco-editor/editor/editor.api.js";
import editorWorker from "monaco-editor/editor/editor.worker?worker";

type Props = {
  value: string;
  onChange: (value: string) => void;
  onRun: () => void;
  readOnly?: boolean;
};

type MonacoWindow = Window & {
  MonacoEnvironment?: { getWorker: (_workerId: string, _label: string) => Worker };
};

let configured = false;

function configureGeoGebraLanguage(): void {
  if (configured) return;
  monaco.languages.register({ id: "geogebra" });
  monaco.languages.setMonarchTokensProvider("geogebra", {
    defaultToken: "",
    tokenizer: {
      root: [
        [/\/\/.*$/, "comment"],
        [/"([^"\\]|\\.)*$/, "string.invalid"],
        [/"/, { token: "string.quote", bracket: "@open", next: "@string" }],
        [/\b\d+(?:\.\d+)?\b/, "number"],
        [/\b(Polygon|Circle|Segment|Line|Ray|Midpoint|Text|Point|Translate|Rotate|Tangent|Intersect|PerpendicularLine|ParallelLine|Angle|Area)\b/, "keyword"],
        [/[\p{L}_][\p{L}\p{N}_'’]*(?=\s*\()/u, "type.identifier"],
        [/[\p{L}_][\p{L}\p{N}_'’]*(?=\s*=)/u, "variable"],
        [/[=+\-*/^]/, "operator"],
        [/[()[\]{}]/, "@brackets"],
      ],
      string: [
        [/[^\\"]+/, "string"],
        [/\\./, "string.escape"],
        [/"/, { token: "string.quote", bracket: "@close", next: "@pop" }],
      ],
    },
  });
  monaco.editor.defineTheme("synapse-geogebra", {
    base: "vs",
    inherit: true,
    rules: [
      { token: "comment", foreground: "64748B" },
      { token: "string", foreground: "047857" },
      { token: "number", foreground: "0369A1" },
      { token: "keyword", foreground: "1D4ED8", fontStyle: "bold" },
      { token: "variable", foreground: "0F172A" },
      { token: "type.identifier", foreground: "7C3AED" },
      { token: "operator", foreground: "334155" },
    ],
    colors: {
      "editor.background": "#F8FAFC",
      "editor.foreground": "#0F172A",
      "editor.lineHighlightBackground": "#F1F5F9",
      "editorLineNumber.foreground": "#94A3B8",
      "editorLineNumber.activeForeground": "#334155",
      "editor.selectionBackground": "#BFDBFE",
      "editorCursor.foreground": "#0F172A",
      "editorIndentGuide.background1": "#E2E8F0",
      "editorIndentGuide.activeBackground1": "#CBD5E1",
      "editorWidget.background": "#FFFFFF",
      "editorWidget.border": "#CBD5E1",
      "editorGutter.background": "#F8FAFC",
    },
  });
  configured = true;
}

export default function GeoGebraEditor({ value, onChange, onRun, readOnly = false }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const changeRef = useRef(onChange);
  const runRef = useRef(onRun);
  const externalUpdateRef = useRef(false);
  changeRef.current = onChange;
  runRef.current = onRun;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;

    const environment = window as MonacoWindow;
    environment.MonacoEnvironment ??= { getWorker: () => new editorWorker() };
    configureGeoGebraLanguage();
    monaco.editor.setTheme("synapse-geogebra");

    const editor = monaco.editor.create(host, {
      value,
      language: "geogebra",
      theme: "synapse-geogebra",
      readOnly,
      fontSize: 14,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      lineNumbers: "on",
      lineNumbersMinChars: 3,
      minimap: { enabled: false },
      folding: true,
      wordWrap: "on",
      scrollBeyondLastLine: false,
      automaticLayout: true,
      tabSize: 2,
      insertSpaces: true,
      smoothScrolling: true,
      renderLineHighlight: "line",
      bracketPairColorization: { enabled: true },
      padding: { top: 16, bottom: 16 },
      ariaLabel: "GeoGebra 脚本编辑器",
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
    });
    editorRef.current = editor;
    const changeSubscription = editor.onDidChangeModelContent(() => {
      if (!externalUpdateRef.current) changeRef.current(editor.getValue());
    });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => runRef.current());

    return () => {
      changeSubscription.dispose();
      editor.dispose();
      editorRef.current = null;
    };
  }, []);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || editor.getValue() === value) return;
    externalUpdateRef.current = true;
    editor.setValue(value);
    externalUpdateRef.current = false;
  }, [value]);

  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly });
  }, [readOnly]);

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-slate-50 shadow-sm">
      <div className="flex items-center justify-between border-b border-slate-200 bg-white/80 px-4 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">GeoGebra Script</span>
        <span className="text-xs text-slate-400">Ctrl/Cmd + Enter 运行</span>
      </div>
      <div ref={hostRef} className="min-h-[320px] w-full sm:min-h-[440px]" />
    </div>
  );
}
