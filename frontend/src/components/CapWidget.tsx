import React, { useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import { applyCapCreditsBranding, type CapCreditsBrandingDisposer } from '../utils/capCreditsBranding';
import { getCapThemeStyle, type CaptchaWidgetTheme } from '../utils/captchaSelection';
import { afterFirstPaintIdle } from '../utils/scheduleAfterPaint';

/**
 * trycap（Cap）控件封装。
 *
 * Cap 的官方控件是自定义元素 `<cap-widget>`：脚本加载后由元素自己取挑战、解题，
 * 解完派发 `solve` 事件（detail.token）。这里把它包成与 Turnstile/hCaptcha 一致的
 * ref 契约（execute / reset / getResponse），上层无需为第三家写分支逻辑。
 *
 * 版本按 Cap 官方建议在生产环境钉死，避免上游发布改行为。
 */
const CAP_WIDGET_SCRIPT_ID = 'cap-widget-script';
const CAP_WIDGET_SCRIPT_SRC = 'https://cdn.jsdelivr.net/npm/@cap.js/widget@0.1.58';

/**
 * Cap 默认按 `navigator.hardwareConcurrency || 8` 开解题 Worker（官方文档的 data-cap-worker-count）。
 * 线上 trace（docs/perf/2026-10-01-captcha-verify-trace-analysis.md）里这台 13 核机器一次起了
 * 13 个 WASM Worker，在首帧后满核跑了 ~5.9 s CPU。这里按官方默认上限收敛到 8，既保留并行度
 * （解题耗时不会明显变长）又避免低端/多核机器把 CPU 全吃干净。
 */
const DEFAULT_MAX_CAP_WORKERS = 8;

/**
 * CDN 挂起保护：脚本既不会派发 load 也不会派发 error 时，控件容器会一直空白。
 * 超过这个时间仍未就绪就按加载失败处理（走 onError 通路），让上层能换下一家/提示重试。
 */
const CAP_WIDGET_SCRIPT_TIMEOUT_MS = 15000;

function defaultCapWorkerCount(): number {
  if (typeof navigator === 'undefined') return DEFAULT_MAX_CAP_WORKERS;
  const cores = Number(navigator.hardwareConcurrency) || DEFAULT_MAX_CAP_WORKERS;
  return Math.max(1, Math.min(cores, DEFAULT_MAX_CAP_WORKERS));
}

interface CapWidgetElement extends HTMLElement {
  reset?: () => void;
  solve?: () => Promise<{ token: string }> | void;
}

interface CapWidgetProps {
  siteKey: string;
  apiEndpoint: string;
  onVerify: (token: string) => void;
  onExpire?: () => void;
  onError?: (error: unknown) => void;
  /** 管理端统一调控（/admin/captcha-providers → 组件外观）。 */
  theme?: CaptchaWidgetTheme;
  language?: string;
  /** 解题 Worker 数；默认 min(hardwareConcurrency, 8)，下限 1。 */
  workerCount?: number;
  /** 是否等首帧绘制后再注入 Cap 脚本（默认 true，避免和首屏渲染争主线程/CPU）。 */
  deferUntilIdle?: boolean;
  'aria-label'?: string;
}

export interface CapWidgetRef {
  execute: () => void;
  reset: () => void;
  getResponse: () => string;
}

declare global {
  interface Window {
    capWidgetScriptState?: 'loading' | 'ready' | 'failed';
    /** Cap 的 instrumentation 在 sandbox iframe 里跑内联脚本，需要把页面 CSP nonce 透给控件。 */
    CAP_SCRIPT_NONCE?: string;
    CAP_CSS_NONCE?: string;
  }
}

let capScriptPromise: Promise<void> | null = null;

function loadCapScript(): Promise<void> {
  if (window.capWidgetScriptState === 'ready') return Promise.resolve();
  if (capScriptPromise) return capScriptPromise;
  capScriptPromise = new Promise<void>((resolve, reject) => {
    const existing = document.getElementById(CAP_WIDGET_SCRIPT_ID) as HTMLScriptElement | null;
    const script = existing ?? document.createElement('script');
    let settled = false;
    const cleanup = () => {
      window.clearTimeout(timeout);
      script.removeEventListener('load', ready);
      script.removeEventListener('error', fail);
    };
    const ready = () => {
      if (settled) return;
      settled = true;
      cleanup();
      window.capWidgetScriptState = 'ready';
      resolve();
    };
    const fail = () => {
      if (settled) return;
      settled = true;
      cleanup();
      script.remove();
      window.capWidgetScriptState = 'failed';
      reject(new Error('Cap widget script failed to load'));
    };
    const timeout = window.setTimeout(fail, CAP_WIDGET_SCRIPT_TIMEOUT_MS);
    script.addEventListener('load', ready);
    script.addEventListener('error', fail);
    window.capWidgetScriptState = 'loading';
    if (!existing) {
      script.id = CAP_WIDGET_SCRIPT_ID;
      script.src = CAP_WIDGET_SCRIPT_SRC;
      script.async = true;
      document.head.appendChild(script);
    }
  }).then(() => {
    capScriptPromise = null;
  }, (error) => {
    capScriptPromise = null;
    throw error;
  });
  return capScriptPromise;
}

type CapWidgetInternalProps = CapWidgetProps & { ref?: React.Ref<CapWidgetRef> };

const CapWidget = ({
  siteKey,
  apiEndpoint,
  onVerify,
  onExpire,
  onError,
  theme = 'auto',
  language,
  workerCount,
  deferUntilIdle = true,
  'aria-label': ariaLabel = 'trycap 人机验证',
  ref,
}: CapWidgetInternalProps) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const elementRef = useRef<CapWidgetElement | null>(null);
  const tokenRef = useRef('');
  const callbacksRef = useRef({ onVerify, onExpire, onError });
  callbacksRef.current = { onVerify, onExpire, onError };

  const resetToken = useCallback(() => {
    tokenRef.current = '';
  }, []);

  useEffect(() => {
    let cancelled = false;
    let disposeBranding: CapCreditsBrandingDisposer | null = null;
    const container = containerRef.current;
    if (!container || !siteKey) return;

    const mount = async () => {
      try {
        // 首帧之前的 Cap 脚本注入 + WASM 求值会直接和页面渲染抢主线程（trace 里表现为 3 624 次
        // UpdateLayer 与 9 次丢帧），所以默认等首帧绘制完、浏览器空闲时再开工。
        if (deferUntilIdle) {
          await afterFirstPaintIdle(1000);
          if (cancelled) return;
        }

        // 严格 CSP 下（script-src 只放行 nonce）不给 nonce，instrumentation 的内联脚本会被浏览器拦掉，
        // 表现为 instr_timeout / blocked。把页面自身的 nonce 透给 Cap 即可。
        // CAP_CSS_NONCE 作用在控件自己注入的 <style> 上（若后端把 style-src-elem 收成 nonce-only，
        // 缺了它控件会变成无样式），一起透过去成本为零。
        if (!window.CAP_SCRIPT_NONCE || !window.CAP_CSS_NONCE) {
          const nonceSource = document.querySelector<HTMLScriptElement>('script[nonce]')?.nonce;
          if (nonceSource) {
            if (!window.CAP_SCRIPT_NONCE) window.CAP_SCRIPT_NONCE = nonceSource;
            if (!window.CAP_CSS_NONCE) window.CAP_CSS_NONCE = nonceSource;
          }
        }
        await loadCapScript();
      } catch (error) {
        if (!cancelled) callbacksRef.current.onError?.(error);
        return;
      }
      if (cancelled || !containerRef.current) return;

      container.replaceChildren();
      const element = document.createElement('cap-widget') as CapWidgetElement;
      const effectiveWorkerCount = workerCount ?? defaultCapWorkerCount();
      if (Number.isFinite(effectiveWorkerCount) && effectiveWorkerCount > 0) {
        element.setAttribute('data-cap-worker-count', String(Math.floor(effectiveWorkerCount)));
      }
      // 尾斜杠是 Cap 端点约定的一部分，缺了会 404。
      element.setAttribute('data-cap-api-endpoint', `${apiEndpoint.replace(/\/+$/, '')}/${siteKey}/`);
      element.setAttribute('aria-label', ariaLabel);
      // 文本语言由控件自己的 i18n 表决定（data-cap-lang），auto 时不设，跟随浏览器。
      if (language && language !== 'auto') element.setAttribute('data-cap-lang', language);
      element.addEventListener('solve', (event: Event) => {
        if (cancelled || !element.isConnected) return;
        const detail = (event as CustomEvent<{ token?: string }>).detail;
        const token = detail?.token ?? '';
        if (!token) {
          callbacksRef.current.onError?.(new Error('Cap 返回了空令牌'));
          return;
        }
        tokenRef.current = token;
        callbacksRef.current.onVerify(token);
      });
      element.addEventListener('error', (event: Event) => {
        if (cancelled || !element.isConnected) return;
        resetToken();
        callbacksRef.current.onError?.((event as CustomEvent).detail);
      });
      element.addEventListener('reset', () => {
        // Cap 控件在断连/卸载时会自己走一遍 reset() 并派发 reset 事件，这**不是**用户令牌过期。
        // 若据实上报，上层刚收到的「验证成功」会被立刻抹掉、只剩「验证码已过期」，且每次重挂都复现。
        //
        // 只靠 `cancelled` 不够：卸载时 React 的 useEffect 清理（passive effect）是在 DOM 变更
        // **之后**才 flush 的，而 disconnectedCallback 在 DOM 变更时就已经派发了 reset —— 此时
        // cancelled 仍是 false。所以再加一道「元素已经不在文档里」的判定：真正的超时过期发生时
        // 控件还挂在树上（isConnected === true），照常上报。
        if (cancelled || !element.isConnected) return;
        resetToken();
        callbacksRef.current.onExpire?.();
      });
      container.appendChild(element);
      elementRef.current = element;

      // Cap 的 CDN 脚本会在控件的 open shadow root 里插入 trycap.dev 署名链接，
      // 并反复把它复位、点击时 preventDefault 后跳去 trycap.dev。
      // 这里把它持续覆写成 chloemlla（详见 utils/capCreditsBranding）。
      disposeBranding = applyCapCreditsBranding(element);
    };

    void mount();

    return () => {
      cancelled = true;
      resetToken();
      disposeBranding?.();
      disposeBranding = null;
      elementRef.current = null;
      container.replaceChildren();
    };
  }, [apiEndpoint, siteKey, ariaLabel, language, workerCount, deferUntilIdle, resetToken]);

  useImperativeHandle(
    ref,
    () => ({
      execute: () => {
        const element = elementRef.current;
        if (element?.isConnected && element.solve) {
          const reportError = (error: unknown) => {
            if (elementRef.current === element && element.isConnected) {
              resetToken();
              callbacksRef.current.onError?.(error);
            }
          };
          try {
            void Promise.resolve(element.solve()).catch(reportError);
          } catch (error) {
            reportError(error);
          }
        }
      },
      reset: () => {
        resetToken();
        try {
          elementRef.current?.reset?.();
        } catch (error) {
          console.warn('Failed to reset Cap widget:', error);
        }
      },
      getResponse: () => tokenRef.current,
    }),
    [resetToken],
  );

  return (
    <div
      ref={containerRef}
      role="region"
      aria-label={ariaLabel}
      className="cap-widget-container"
      // Cap 只用 --cap-* CSS 变量描述外观，自定义属性会继承进 shadow root；
      // 深色主题在宿主上给出变量即可，无需侵入控件内部样式。
      style={getCapThemeStyle(theme)}
    />
  );
};

CapWidget.displayName = 'CapWidget';

export default CapWidget;
