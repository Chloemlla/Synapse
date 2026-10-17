import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import {
  GEO_GEBRA_MAX_EXECUTION_MS,
  type GeoGebraMode,
  type GeoGebraPointState,
} from "./script";
import { studioGhostButtonClassName, studioPanelClassName } from "../studioTheme";

export type GeoGebraApi = {
  evalCommand?: (command: string) => boolean | string;
  getAllObjectNames?: (type?: string) => string[];
  getObjectType?: (name: string) => string;
  isIndependent?: (name: string) => boolean;
  isMoveable?: (name: string) => boolean;
  getXcoord?: (name: string) => number;
  getYcoord?: (name: string) => number;
  setFixed?: (name: string, fixed: boolean, update?: boolean) => void;
  setColor?: (name: string, red: number, green: number, blue: number) => void;
  setLineThickness?: (name: string, thickness: number) => void;
  setPointSize?: (name: string, size: number) => void;
  setLabelVisible?: (name: string, visible: boolean) => void;
  showGrid?: (visible: boolean) => void;
  setAxesVisible?: (x: boolean, y: boolean) => void;
  reset?: () => void;
  deleteObject?: (name: string) => void;
  getPNGBase64?: (scale: number, transparent: boolean) => string;
  getSVGBase64?: (scale: number) => string;
  getScreenshotBase64?: (callback: (value: string) => void) => void;
  getBase64?: () => string;
  registerClientListener?: (listener: (event: unknown) => void) => void;
  unregisterClientListener?: (listener: (event: unknown) => void) => void;
};

type GeoGebraAppletOptions = {
  appName: GeoGebraMode;
  width: number;
  height: number;
  showToolBar: boolean;
  showMenuBar: boolean;
  showAlgebraInput: boolean;
  enableLabelDrags: boolean;
  enableRightClick: boolean;
  language: string;
  useBrowserForJS: boolean;
  appletOnLoad: (api: GeoGebraApi) => void;
};

type GeoGebraAppletInstance = {
  inject: (target: string) => void;
  setSize?: (width: number, height: number) => void;
};

declare global {
  interface Window {
    GGBApplet?: new (options: GeoGebraAppletOptions, html5?: boolean) => GeoGebraAppletInstance;
  }
}

const GEOGEBRA_SCRIPT_URL = "https://www.geogebra.org/apps/deployggb.js";
let scriptLoadPromise: Promise<void> | null = null;

function loadGeoGebraApi(): Promise<void> {
  if (typeof window === "undefined") return Promise.reject(new Error("当前环境无法打开画布。"));
  if (window.GGBApplet) return Promise.resolve();
  if (scriptLoadPromise) return scriptLoadPromise;

  scriptLoadPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${GEOGEBRA_SCRIPT_URL}"]`);
    const script = existing ?? document.createElement("script");
    const onLoad = () => window.GGBApplet ? resolve() : reject(new Error("画布暂时不可用，请稍后重试。"));
    const onError = () => {
      script.remove();
      reject(new Error("画布暂时不可用，请稍后重试。"));
    };
    script.addEventListener("load", onLoad, { once: true });
    script.addEventListener("error", onError, { once: true });
    if (!existing) {
      script.src = GEOGEBRA_SCRIPT_URL;
      script.async = true;
      script.dataset.synapseGeogebra = "true";
      document.head.appendChild(script);
    }
  }).catch((error: unknown) => {
    scriptLoadPromise = null;
    throw error;
  });

  return scriptLoadPromise;
}

export type GeoGebraRunStep = {
  lineNumber: number;
  command: string;
  status: "ok" | "failed";
  durationMs: number;
  message?: string;
};

export type GeoGebraRunReport = {
  success: boolean;
  successCount: number;
  errorCount: number;
  error?: { lineNumber: number; command: string; message: string };
  executionTime: number;
  /** 用户主动停止。与失败区分开：界面不该把「我按了停止」显示成脚本出错。 */
  stopped?: boolean;
  // 逐条明细：单条失败中止后，用户需要看到“跑到第几条、哪条失败、花了多久”，
  // 只有汇总计数无法定位问题。
  steps: GeoGebraRunStep[];
};

export type GeoGebraStyleResult = {
  changed: string[];
  skipped: Array<{ name: string; reason: string }>;
};

export type GeoGebraStyleOptions = {
  names: string[];
  color: string;
  lineThickness: number;
  pointSize: number;
  labelVisible: boolean;
  showGrid: boolean;
  showAxes: boolean;
};

export type GeoGebraHandle = {
  run(commands: string[], onProgress?: (current: number, total: number) => void): Promise<GeoGebraRunReport>;
  stop(): void;
  clear(): void;
  reset(): void;
  exportPng(): string | null;
  exportSvg(): string | null;
  exportGgb(): string | null;
  readFreePoints(names?: string[]): GeoGebraPointState[];
  getObjectNames(): string[];
  lockPoints(locked: boolean): void;
  applyStyles(options: GeoGebraStyleOptions): GeoGebraStyleResult;
};

type Props = {
  mode: GeoGebraMode;
  height: number;
  locked: boolean;
  onReady?: () => void;
  onError?: (message: string) => void;
  onPointsMoved?: (names: string[]) => void;
};

const GeoGebraApplet = forwardRef<GeoGebraHandle, Props>(function GeoGebraApplet(
  { mode, height, locked, onReady, onError, onPointsMoved },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const instanceRef = useRef<GeoGebraAppletInstance | null>(null);
  const apiRef = useRef<GeoGebraApi | null>(null);
  const clientListenerRef = useRef<((event: unknown) => void) | null>(null);
  // 每次 run 取一个令牌；stop() 让令牌失效，执行循环在两条指令之间退出。
  // GeoGebra 的 evalCommand 是同步的，单条指令无法被打断，但「长脚本逐条跑」可以。
  const runTokenRef = useRef(0);
  const callbacksRef = useRef({ onReady, onError, onPointsMoved });
  callbacksRef.current = { onReady, onError, onPointsMoved };
  const [containerId] = useState(() => `geogebra-${Math.random().toString(36).slice(2, 10)}`);
  const [width, setWidth] = useState(0);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return undefined;
    const resize = () => setWidth(element.clientWidth);
    resize();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", resize);
      return () => window.removeEventListener("resize", resize);
    }
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (width > 0) instanceRef.current?.setSize?.(Math.round(width), height);
  }, [height, width]);

  useEffect(() => {
    if (!containerRef.current) return undefined;
    let cancelled = false;
    let timeout: number | undefined;
    setLoading(true);
    setError("");

    const start = async () => {
      try {
        await loadGeoGebraApi();
        const AppletConstructor = window.GGBApplet;
        if (cancelled || !AppletConstructor || !containerRef.current) return;
        const applet = new AppletConstructor({
          appName: mode,
          width: Math.round(containerRef.current.clientWidth || 800),
          height,
          showToolBar: false,
          showMenuBar: false,
          showAlgebraInput: false,
          enableLabelDrags: true,
          enableRightClick: true,
          // 画布内的右键菜单、标签与单位跟随 GeoGebra 的界面语言；工作台本身是中文，
          // 保持 en 会让「设置」「属性」等菜单和页面其余部分对不上。
          language: "zh_CN",
          useBrowserForJS: true,
          appletOnLoad: (api) => {
            if (cancelled) return;
            apiRef.current = api;
            const listener = (event: unknown) => {
              const labels = normalizeMovedLabels(event);
              if (labels.length) callbacksRef.current.onPointsMoved?.(labels);
            };
            clientListenerRef.current = listener;
            api.registerClientListener?.(listener);
            if (timeout) window.clearTimeout(timeout);
            setLoading(false);
            callbacksRef.current.onReady?.();
          },
        }, true);
        instanceRef.current = applet;
        timeout = window.setTimeout(() => {
          if (!apiRef.current && !cancelled) {
            setLoading(false);
            setError("画布暂时无法打开，请稍后重试。");
            callbacksRef.current.onError?.("画布初始化超时。");
          }
        }, 15_000);
        applet.inject(containerId);
      } catch {
        if (cancelled) return;
        setLoading(false);
        setError("画布暂时无法打开，请检查网络后重试。");
        callbacksRef.current.onError?.("画布暂时无法打开。");
      }
    };
    void start();

    return () => {
      cancelled = true;
      // 卸载后正在跑的循环没有意义，且会继续向已清空的容器写对象。
      runTokenRef.current += 1;
      if (timeout) window.clearTimeout(timeout);
      const api = apiRef.current;
      if (clientListenerRef.current) api?.unregisterClientListener?.(clientListenerRef.current);
      clientListenerRef.current = null;
      apiRef.current = null;
      instanceRef.current = null;
      const element = document.getElementById(containerId);
      element?.replaceChildren();
    };
  }, [attempt, containerId, height, mode]);

  useEffect(() => {
    if (!apiRef.current) return;
    const names = apiRef.current.getAllObjectNames?.("point") ?? [];
    for (const name of names) {
      if (isFreePoint(apiRef.current, name)) apiRef.current.setFixed?.(name, locked, true);
    }
  }, [locked, loading]);

  useImperativeHandle(ref, () => ({
    async run(commands, onProgress) {
      const api = requireApi(apiRef.current);
      const started = Date.now();
      const token = ++runTokenRef.current;
      api.reset?.();
      const steps: GeoGebraRunStep[] = [];
      let successCount = 0;
      for (let index = 0; index < commands.length; index += 1) {
        if (runTokenRef.current !== token) {
          const message = "已停止运行。";
          steps.push({ lineNumber: index + 1, command: commands[index] ?? "", status: "failed", durationMs: 0, message });
          return { success: false, successCount, errorCount: 0, stopped: true, executionTime: Date.now() - started, steps };
        }
        const command = commands[index] ?? "";
        const stepStarted = Date.now();
        if (Date.now() - started > GEO_GEBRA_MAX_EXECUTION_MS) {
          const message = "脚本执行超时，已停止。";
          steps.push({ lineNumber: index + 1, command, status: "failed", durationMs: Date.now() - stepStarted, message });
          return { success: false, successCount, errorCount: 1, executionTime: Date.now() - started, error: { lineNumber: index + 1, command, message }, steps };
        }
        let failure: string | null = null;
        try {
          const result = api.evalCommand?.(command);
          if (result === false) failure = "GeoGebra 未能执行该指令。";
        } catch (caught) {
          failure = caught instanceof Error ? caught.message : "指令执行失败。";
        }
        if (failure) {
          steps.push({ lineNumber: index + 1, command, status: "failed", durationMs: Date.now() - stepStarted, message: failure });
          return { success: false, successCount, errorCount: 1, executionTime: Date.now() - started, error: { lineNumber: index + 1, command, message: failure }, steps };
        }
        successCount += 1;
        steps.push({ lineNumber: index + 1, command, status: "ok", durationMs: Date.now() - stepStarted });
        onProgress?.(index + 1, commands.length);
        if (index % 20 === 19) await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      }
      this.lockPoints(locked);
      return { success: true, successCount, errorCount: 0, executionTime: Date.now() - started, steps };
    },
    stop() {
      runTokenRef.current += 1;
    },
    clear() {
      const api = requireApi(apiRef.current);
      for (const name of api.getAllObjectNames?.() ?? []) api.deleteObject?.(name);
    },
    reset() {
      requireApi(apiRef.current).reset?.();
    },
    exportPng() {
      const api = apiRef.current;
      try {
        if (api?.getPNGBase64) return `data:image/png;base64,${api.getPNGBase64(1, true)}`;
      } catch {
        return null;
      }
      return null;
    },
    exportSvg() {
      const api = apiRef.current;
      try {
        const base64 = api?.getSVGBase64?.(1);
        return base64 ? `data:image/svg+xml;base64,${base64}` : null;
      } catch {
        return null;
      }
    },
    exportGgb() {
      const api = apiRef.current;
      try {
        const base64 = api?.getBase64?.();
        return base64 ? `data:application/vnd.geogebra.file;base64,${base64}` : null;
      } catch {
        return null;
      }
    },
    readFreePoints(names) {
      const api = requireApi(apiRef.current);
      const candidates = names?.length ? names : api.getAllObjectNames?.("point") ?? [];
      return candidates.flatMap((name) => {
        if (!isFreePoint(api, name)) return [];
        const x = api.getXcoord?.(name);
        const y = api.getYcoord?.(name);
        return typeof x === "number" && typeof y === "number" && Number.isFinite(x) && Number.isFinite(y)
          ? [{ name, x: roundCoordinate(x), y: roundCoordinate(y) }]
          : [];
      });
    },
    getObjectNames() {
      return requireApi(apiRef.current).getAllObjectNames?.() ?? [];
    },
    lockPoints(lockedValue) {
      const api = requireApi(apiRef.current);
      for (const name of api.getAllObjectNames?.("point") ?? []) {
        if (isFreePoint(api, name)) api.setFixed?.(name, lockedValue, true);
      }
    },
    applyStyles(options) {
      const api = requireApi(apiRef.current);
      const changed: string[] = [];
      const skipped: Array<{ name: string; reason: string }> = [];
      const color = hexToRgb(options.color);
      const available = new Set(api.getAllObjectNames?.() ?? []);
      for (const name of options.names) {
        // 对象可能已被删除或来自旧版本脚本：按对象逐条汇报，而不是只给一个成功计数，
        // 否则用户无法知道“部分成功”到底哪几个没生效。
        if (available.size > 0 && !available.has(name)) {
          skipped.push({ name, reason: "该对象已不在画布上。" });
          continue;
        }
        try {
          if (color) api.setColor?.(name, color.red, color.green, color.blue);
          api.setLineThickness?.(name, options.lineThickness);
          api.setPointSize?.(name, options.pointSize);
          api.setLabelVisible?.(name, options.labelVisible);
          changed.push(name);
        } catch {
          skipped.push({ name, reason: "该对象暂不支持这些显示设置。" });
        }
      }
      api.showGrid?.(options.showGrid);
      api.setAxesVisible?.(options.showAxes, options.showAxes);
      return { changed, skipped };
    },
  }), [locked]);

  return (
    <section className={`${studioPanelClassName} relative min-w-0 overflow-hidden`}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-500">Live Canvas</p>
          <h2 className="mt-1 text-lg font-semibold text-slate-900">GeoGebra 画布</h2>
        </div>
        <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-600">{modeLabel(mode)}</span>
      </div>
      <div ref={containerRef} className="relative min-h-[360px] overflow-hidden rounded-2xl border border-slate-200 bg-white" style={{ height }}>
        <div id={containerId} className="h-full w-full" />
        {loading && (
          <div className="absolute inset-0 grid place-items-center bg-white/90 p-6 text-center" role="status" aria-live="polite">
            <div><span className="block text-sm font-semibold text-slate-700">正在加载画布…</span><span className="mt-1 block text-xs text-slate-500">准备完成后即可开始绘图。</span></div>
          </div>
        )}
        {error && (
          <div className="absolute inset-0 grid place-items-center bg-white/95 p-6 text-center" role="alert">
            <div className="max-w-md"><p className="text-sm font-semibold text-rose-700">画布暂时不可用</p><p className="mt-2 text-sm text-slate-600">{error}</p><button type="button" onClick={() => setAttempt((value) => value + 1)} className={`${studioGhostButtonClassName} mt-4`}>重试</button></div>
          </div>
        )}
      </div>
    </section>
  );
});

function requireApi(api: GeoGebraApi | null): GeoGebraApi {
  if (!api) throw new Error("GeoGebra 画布尚未就绪。");
  return api;
}

function isFreePoint(api: GeoGebraApi, name: string): boolean {
  try {
    return api.getObjectType?.(name)?.toLowerCase() === "point"
      && api.isIndependent?.(name) === true
      && api.isMoveable?.(name) === true;
  } catch {
    return false;
  }
}

function roundCoordinate(value: number): number {
  const rounded = Number(value.toFixed(6));
  return Object.is(rounded, -0) ? 0 : rounded;
}

function normalizeMovedLabels(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const record = value as { type?: unknown; targets?: unknown; argument?: unknown; target?: unknown };
  if (record.type !== "movedGeos") return [];
  const target = record.targets ?? record.argument ?? record.target;
  if (Array.isArray(target)) return target.filter((item): item is string => typeof item === "string" && item.length > 0);
  return typeof target === "string" ? target.split(",").map((item) => item.trim()).filter(Boolean) : [];
}

function hexToRgb(value: string): { red: number; green: number; blue: number } | null {
  const match = /^#([0-9a-f]{6})$/i.exec(value);
  if (!match) return null;
  const color = match[1];
  return { red: parseInt(color.slice(0, 2), 16), green: parseInt(color.slice(2, 4), 16), blue: parseInt(color.slice(4, 6), 16) };
}

function modeLabel(mode: GeoGebraMode): string {
  switch (mode) {
    case "geometry": return "平面几何";
    case "3d": return "立体几何";
    case "graphing": return "函数图形";
    case "classic": return "综合工作台";
  }
}

export default GeoGebraApplet;
