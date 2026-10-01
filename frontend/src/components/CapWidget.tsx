import React, { useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import { applyCapCreditsBranding, type CapCreditsBrandingDisposer } from '../utils/capCreditsBranding';
import { getCapThemeStyle, type CaptchaWidgetTheme } from '../utils/captchaSelection';

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
  /** 管理端统一调控（/admin/captcha-providers → 组件外观）。 */
  theme?: CaptchaWidgetTheme;
  language?: string;
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
  theme = 'auto',
  language,
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
    let disposeBranding: CapCreditsBrandingDisposer | null = null;
    const container = containerRef.current;
    if (!container || !siteKey) return;

    const mount = async () => {
      try {
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
      // 文本语言由控件自己的 i18n 表决定（data-cap-lang），auto 时不设，跟随浏览器。
      if (language && language !== 'auto') element.setAttribute('data-cap-lang', language);
      element.addEventListener('solve', (event: Event) => {
        if (cancelled) return;
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
        if (cancelled) return;
        callbacksRef.current.onError?.((event as CustomEvent).detail);
      });
      element.addEventListener('reset', () => {
        resetToken();
        // Cap 控件在断连/卸载时会自己走一遍 reset() 并派发 reset 事件，这**不是**用户令牌过期。
        // 若据实上报，上层刚收到的「验证成功」会被立刻抹掉、只剩「验证码已过期」，且每次重挂都复现。
        // 真正因超时过期时组件还挂在树上（cancelled 仍为 false），照常上报。
        if (cancelled) return;
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
  }, [apiEndpoint, siteKey, ariaLabel, language, loadScript, resetToken]);

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
