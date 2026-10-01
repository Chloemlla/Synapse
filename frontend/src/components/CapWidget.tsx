import React, { useCallback, useEffect, useImperativeHandle, useRef } from 'react';

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

type CapWidgetInternalProps = CapWidgetProps & { ref?: React.Ref<CapWidgetRef> };

const CapWidget = ({
  siteKey,
  apiEndpoint,
  onVerify,
  onExpire,
  onError,
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

  const loadScript = useCallback(
    () =>
      new Promise<void>((resolve, reject) => {
        if (window.capWidgetScriptState === 'ready') {
          resolve();
          return;
        }

        const existing = document.getElementById(CAP_WIDGET_SCRIPT_ID) as HTMLScriptElement | null;
        if (existing) {
          existing.addEventListener('load', () => resolve(), { once: true });
          existing.addEventListener('error', () => reject(new Error('Cap widget script failed to load')), { once: true });
          return;
        }

        window.capWidgetScriptState = 'loading';
        const script = document.createElement('script');
        script.id = CAP_WIDGET_SCRIPT_ID;
        script.src = CAP_WIDGET_SCRIPT_SRC;
        script.async = true;
        script.addEventListener(
          'load',
          () => {
            window.capWidgetScriptState = 'ready';
            resolve();
          },
          { once: true },
        );
        script.addEventListener(
          'error',
          () => {
            window.capWidgetScriptState = 'failed';
            reject(new Error('Cap widget script failed to load'));
          },
          { once: true },
        );
        document.head.appendChild(script);
      }),
    [],
  );

  useEffect(() => {
    let cancelled = false;
    const container = containerRef.current;
    if (!container || !siteKey) return;

    const mount = async () => {
      try {
        // 严格 CSP 下（script-src 只放行 nonce）不给 nonce，instrumentation 的内联脚本会被浏览器拦掉，
        // 表现为 instr_timeout / blocked。把页面自身的 nonce 透给 Cap 即可。
        if (!window.CAP_SCRIPT_NONCE) {
          const nonceSource = document.querySelector<HTMLScriptElement>('script[nonce]')?.nonce;
          if (nonceSource) window.CAP_SCRIPT_NONCE = nonceSource;
        }
        await loadScript();
      } catch (error) {
        if (!cancelled) callbacksRef.current.onError?.(error);
        return;
      }
      if (cancelled || !containerRef.current) return;

      container.replaceChildren();
      const element = document.createElement('cap-widget') as CapWidgetElement;
      // 尾斜杠是 Cap 端点约定的一部分，缺了会 404。
      element.setAttribute('data-cap-api-endpoint', `${apiEndpoint.replace(/\/+$/, '')}/${siteKey}/`);
      element.setAttribute('aria-label', ariaLabel);
      element.addEventListener('solve', (event: Event) => {
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
        resetToken();
        callbacksRef.current.onError?.((event as CustomEvent).detail);
      });
      element.addEventListener('reset', () => {
        resetToken();
        callbacksRef.current.onExpire?.();
      });
      container.appendChild(element);
      elementRef.current = element;
    };

    void mount();

    return () => {
      cancelled = true;
      resetToken();
      elementRef.current = null;
      container.replaceChildren();
    };
  }, [apiEndpoint, siteKey, ariaLabel, loadScript, resetToken]);

  useImperativeHandle(
    ref,
    () => ({
      execute: () => {
        const element = elementRef.current;
        if (element?.solve) {
          try {
            void element.solve();
          } catch (error) {
            callbacksRef.current.onError?.(error);
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

  return <div ref={containerRef} role="region" aria-label={ariaLabel} className="cap-widget-container" />;
};

CapWidget.displayName = 'CapWidget';

export default CapWidget;
