import { useEffect, useRef, useState } from "react";
import { cn } from "../../utils/cn";
import { studioEyebrowClassName, studioSurfaceClassName } from "../studioTheme";

// monaco-editor 0.57 的 exports 只有 "."、"./*" 与 "./*.js"，且 "./*" 指向 "./esm/vs/*.js"：
// 所以裸 "esm/vs/..." 前缀会被再拼一次（TS2307 / vite 解析失败），必须写 "./editor/*"。
// editor.api 是不含语言贡献的轻量入口，CSS 由 ESM 模块自己 import（min/** 已不在 exports 内）。
//
// 性能（FD-071）：编辑器与 worker 都改成动态 import —— monaco 是重依赖，不能让脚本编辑器的代码
// 进 GeoGebra 页面首屏的静态闭包；只有真的需要脚本编辑器时才下载。
import type * as MonacoTypes from "monaco-editor/editor/editor.api.js";

type MonacoModule = typeof import("monaco-editor/editor/editor.api.js");

let monacoPromise: Promise<MonacoModule> | null = null;

function loadMonaco(): Promise<MonacoModule> {
  if (!monacoPromise) {
    monacoPromise = Promise.all([
      import("monaco-editor/editor/editor.api.js"),
      import("monaco-editor/editor/editor.worker?worker"),
    ])
      .then(([monaco, worker]) => {
        const environment = window as MonacoWindow;
        environment.MonacoEnvironment ??= { getWorker: () => new worker.default() };
        return monaco;
      })
      .catch((error: unknown) => {
        monacoPromise = null;
        throw error;
      });
  }
  return monacoPromise;
}

type Props = {
  value: string;
  onChange: (value: string) => void;
  onRun: () => void;
  readOnly?: boolean;
};

type MonacoWindow = Window & {
  MonacoEnvironment?: { getWorker: (_workerId: string, _label: string) => Worker };
};

let configuredMonaco: MonacoModule | null = null;

function configureGeoGebraLanguage(monaco: MonacoModule): void {
  if (configuredMonaco === monaco) return;
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
      { token: "keyword", foreground: "0F172A", fontStyle: "bold" },
      { token: "variable", foreground: "0F172A" },
      { token: "type.identifier", foreground: "0284C7" },
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
  configuredMonaco = monaco;
}

export default function GeoGebraEditor({ value, onChange, onRun, readOnly = false }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<MonacoTypes.editor.IStandaloneCodeEditor | null>(null);
  const changeRef = useRef(onChange);
  const runRef = useRef(onRun);
  const externalUpdateRef = useRef(false);
  const valueRef = useRef(value);
  changeRef.current = onChange;
  runRef.current = onRun;
  valueRef.current = value;
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;

    let cancelled = false;
    let editor: MonacoTypes.editor.IStandaloneCodeEditor | null = null;
    let changeSubscription: { dispose: () => void } | null = null;

    void loadMonaco()
      .then((monaco) => {
        if (cancelled) return;
        configureGeoGebraLanguage(monaco);
        monaco.editor.setTheme("synapse-geogebra");

        editor = monaco.editor.create(host, {
          // 用 ref 里的最新值：动态加载期间内容可能已被用户或自动保存改过。
          value: valueRef.current,
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
        changeSubscription = editor.onDidChangeModelContent(() => {
          if (!externalUpdateRef.current && editor) changeRef.current(editor.getValue());
        });
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => runRef.current());
        setStatus("ready");
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        console.error("[GeoGebraEditor] 编辑器加载失败:", error);
        setLoadError("编辑器加载失败，请检查网络后重试。");
        setStatus("error");
      });

    return () => {
      cancelled = true;
      changeSubscription?.dispose();
      editor?.dispose();
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
    <div className={cn(studioSurfaceClassName, "overflow-hidden bg-slate-50")}>
      <div className="flex items-center justify-between border-b border-slate-200 bg-white/80 px-4 py-2">
        <span className={studioEyebrowClassName}>GeoGebra Script</span>
        <span className="text-xs text-slate-400">Ctrl/Cmd + Enter 运行</span>
      </div>
      <div ref={hostRef} className="relative min-h-[320px] w-full sm:min-h-[440px]">
        {status !== "ready" ? (
          <div
            className="absolute inset-0 grid place-items-center bg-slate-50/80 px-4 text-center text-sm text-slate-500"
            role={status === "error" ? "alert" : "status"}
            aria-live="polite"
          >
            {status === "error" ? loadError : "编辑器加载中…"}
          </div>
        ) : null}
      </div>
    </div>
  );
}
