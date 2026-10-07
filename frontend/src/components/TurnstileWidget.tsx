import React, { useEffect, useRef } from 'react';

interface TurnstileWidgetProps {
  siteKey: string;
  onVerify: (token: string) => void;
  onExpire: () => void;
  onError: () => void;
  size?: 'normal' | 'compact' | 'flexible';
  /** 管理端统一调控（/admin/captcha-providers → 组件外观）。 */
  theme?: 'auto' | 'light' | 'dark';
  language?: string;
}

interface TurnstileRenderOptions {
  sitekey: string;
  size?: 'normal' | 'compact' | 'flexible';
  theme?: 'auto' | 'light' | 'dark';
  language?: string;
  callback?: (token: string) => void;
  'expired-callback'?: () => void;
  'error-callback'?: () => void;
}

declare global {
  interface Window {
    turnstile: {
      render: (
        container: string | HTMLElement,
        options: TurnstileRenderOptions
      ) => string;
      reset: (widgetId: string) => void;
      remove?: (widgetId: string) => void;
    };
  }
}

// 全局脚本加载状态
let turnstileScriptPromise: Promise<void> | null = null;
const TURNSTILE_SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
const TURNSTILE_SCRIPT_SELECTOR = 'script[data-turnstile-api="true"], script[src^="https://challenges.cloudflare.com/turnstile/v0/api.js"]';
const TURNSTILE_LOAD_TIMEOUT_MS = 10000;

const debugTurnstile = (..._args: unknown[]) => {};

const warnTurnstile = (..._args: unknown[]) => {};

const installDevelopmentTurnstile = () => {
  window.turnstile = {
    render: (container: string | HTMLElement, options: TurnstileRenderOptions) => {
      const element = typeof container === 'string' ? document.getElementById(container) : container;
      if (element) {
        element.replaceChildren();

        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = '点击模拟验证 (开发模式)';
        button.style.width = options.size === 'compact' ? '130px' : '300px';
        button.style.height = options.size === 'compact' ? '120px' : '65px';
        button.style.border = '2px dashed #9ca3af';
        button.style.display = 'flex';
        button.style.alignItems = 'center';
        button.style.justifyContent = 'center';
        button.style.background = '#f9fafb';
        button.style.color = '#4b5563';
        button.style.fontFamily = 'Arial, sans-serif';
        button.style.fontSize = '14px';
        button.style.cursor = 'pointer';

        button.addEventListener('click', () => {
          button.style.background = '#e8f5e8';
          button.textContent = '验证成功 (开发模式)';
          window.setTimeout(() => options.callback?.(`mock-token-${Date.now()}`), 500);
        });

        element.appendChild(button);
      }

      return 'mock-widget-id';
    },
    reset: (widgetId: string) => {
      debugTurnstile('开发环境：重置 Turnstile widget', widgetId);
    },
    remove: (widgetId: string) => {
      debugTurnstile('开发环境：移除 Turnstile widget', widgetId);
    },
  };
};

const loadTurnstileScript = (): Promise<void> => {
  if (window.turnstile) return Promise.resolve();
  if (turnstileScriptPromise) return turnstileScriptPromise;
  if (import.meta.env.DEV) {
    installDevelopmentTurnstile();
    return Promise.resolve();
  }

  turnstileScriptPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(TURNSTILE_SCRIPT_SELECTOR);
    const script = existing ?? document.createElement('script');
    let settled = false;
    const cleanup = () => {
      window.clearTimeout(timeout);
      window.clearInterval(poll);
      script.removeEventListener('error', fail);
    };
    const ready = () => {
      if (settled || !window.turnstile) return;
      settled = true;
      cleanup();
      resolve();
    };
    const fail = () => {
      if (settled) return;
      settled = true;
      cleanup();
      script.remove();
      reject(new Error('Turnstile script failed to load'));
    };
    const timeout = window.setTimeout(fail, TURNSTILE_LOAD_TIMEOUT_MS);
    const poll = window.setInterval(ready, 100);
    script.addEventListener('error', fail);
    if (!existing) {
      script.src = TURNSTILE_SCRIPT_SRC;
      script.async = true;
      script.defer = true;
      script.dataset.turnstileApi = 'true';
      script.setAttribute('data-cfasync', 'false');
      document.head.appendChild(script);
    }
    ready();
  }).then(() => {
    turnstileScriptPromise = null;
  }, (error) => {
    turnstileScriptPromise = null;
    throw error;
  });
  return turnstileScriptPromise;
};

export const TurnstileWidget: React.FC<TurnstileWidgetProps> = ({
  siteKey,
  onVerify,
  onExpire,
  onError,
  size = 'normal',
  theme = 'auto',
  language,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const callbacksRef = useRef({ onVerify, onExpire, onError });
  callbacksRef.current = { onVerify, onExpire, onError };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;
    let widgetId: string | null = null;
    const active = () => !cancelled && container.isConnected;
    const mount = async () => {
      try {
        const cleanSiteKey = typeof siteKey === 'string' ? siteKey.trim() : '';
        if (!cleanSiteKey) throw new Error('Invalid Turnstile site key');
        await loadTurnstileScript();
        if (!active()) return;
        widgetId = window.turnstile.render(container, {
          sitekey: cleanSiteKey,
          size,
          theme,
          ...(language && language !== 'auto' ? { language } : {}),
          callback: (token) => { if (active()) callbacksRef.current.onVerify(token); },
          'expired-callback': () => { if (active()) callbacksRef.current.onExpire(); },
          'error-callback': () => { if (active()) callbacksRef.current.onError(); },
        });
      } catch (error) {
        console.error('Turnstile initialization error:', error);
        if (active()) callbacksRef.current.onError();
      }
    };
    void mount();

    return () => {
      // remove/reset 可能同步派发 SDK 回调，必须先使本轮失效。
      cancelled = true;
      if (widgetId !== null && window.turnstile) {
        try {
          if (window.turnstile.remove) window.turnstile.remove(widgetId);
          else window.turnstile.reset(widgetId);
        } catch (error) {
          warnTurnstile('Turnstile cleanup error:', error);
        }
      }
      container.replaceChildren();
    };
  }, [siteKey, size, theme, language]);

  return (
    <div className="turnstile-widget">
      <div ref={containerRef} className="turnstile-widget-container" />
    </div>
  );
};
