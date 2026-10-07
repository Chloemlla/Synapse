import React, { useEffect, useRef, useCallback, useImperativeHandle } from 'react';

interface HCaptchaWidgetProps {
  siteKey: string;
  onVerify: (token: string) => void;
  onExpire?: () => void;
  onError?: (error: any) => void;
  size?: 'normal' | 'compact' | 'invisible' | 'flexible';
  /** 管理端统一调控（/admin/captcha-providers → 组件外观）。 */
  theme?: 'auto' | 'light' | 'dark';
  language?: string;
  tabIndex?: number;
  'aria-label'?: string;
}

export interface HCaptchaWidgetRef {
  execute: () => void;
  reset: () => void;
  getResponse: () => string;
}

declare global {
  interface Window {
    hcaptcha: {
      render: (container: string | HTMLElement, params: any) => string;
      execute: (widgetId: string) => void;
      reset: (widgetId?: string) => void;
      remove: (widgetId: string) => void;
      getResponse: (widgetId?: string) => string;
    };
  }
}

type HCaptchaWidgetInternalProps = HCaptchaWidgetProps & { ref?: React.Ref<HCaptchaWidgetRef> };

let hcaptchaScriptPromise: Promise<void> | null = null;

function loadHCaptchaScript(): Promise<void> {
  if (window.hcaptcha) return Promise.resolve();
  if (hcaptchaScriptPromise) return hcaptchaScriptPromise;

  hcaptchaScriptPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[src^="https://js.hcaptcha.com/1/api.js"]');
    const script = existing ?? document.createElement('script');
    let settled = false;
    const cleanup = () => {
      window.clearTimeout(timeout);
      window.clearInterval(poll);
      script.removeEventListener('error', fail);
    };
    const ready = () => {
      if (settled || !window.hcaptcha) return;
      settled = true;
      cleanup();
      resolve();
    };
    const fail = () => {
      if (settled) return;
      settled = true;
      cleanup();
      // 失败的元素不会再次派发 load，保留它会让后续手动重试一直失败。
      script.remove();
      reject(new Error('hCaptcha script failed to load'));
    };
    const timeout = window.setTimeout(fail, 15000);
    const poll = window.setInterval(ready, 100);
    script.addEventListener('error', fail);
    if (!existing) {
      // 等待 API 就绪由共享轮询完成，多个实例不再覆盖同一个全局 onload 回调。
      script.src = 'https://js.hcaptcha.com/1/api.js?render=explicit';
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
    }
    ready();
  }).then(() => {
    hcaptchaScriptPromise = null;
  }, (error) => {
    hcaptchaScriptPromise = null;
    throw error;
  });
  return hcaptchaScriptPromise;
}

const HCaptchaWidget = ({
  siteKey,
  onVerify,
  onExpire,
  onError,
  size = 'normal',
  theme = 'auto',
  language,
  tabIndex,
  'aria-label': ariaLabel = 'hCaptcha 人机验证',
  ref
}: HCaptchaWidgetInternalProps) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  const callbacksRef = useRef({ onVerify, onExpire, onError });
  callbacksRef.current = { onVerify, onExpire, onError };

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !siteKey) return;
    let cancelled = false;
    let widgetId: string | null = null;
    const active = () => !cancelled && container.isConnected;
    void loadHCaptchaScript().then(() => {
      if (!active()) return;
      widgetId = window.hcaptcha.render(container, {
        sitekey: siteKey,
        // hCaptcha 没有 flexible 尺寸，自适应需求用 normal 承载。
        size: size === 'flexible' ? 'normal' : size,
        // auto 交给控件按系统主题自选（hCaptcha 不接受 auto 字面量）。
        theme: theme === 'auto' ? undefined : theme,
        ...(language && language !== 'auto' ? { language } : {}),
        tabindex: tabIndex,
        callback: (token: string) => {
          if (active()) callbacksRef.current.onVerify(token);
        },
        'expired-callback': () => {
          if (active()) callbacksRef.current.onExpire?.();
        },
        'error-callback': (error: any) => {
          if (active()) callbacksRef.current.onError?.(error);
        }
      });
      widgetIdRef.current = widgetId;
    }).catch((error) => {
      if (active()) callbacksRef.current.onError?.(error);
    });

    return () => {
      cancelled = true;
      widgetIdRef.current = null;
      if (widgetId !== null && window.hcaptcha) {
        try {
          window.hcaptcha.remove(widgetId);
        } catch (error) {
          console.warn('Failed to remove hCaptcha widget:', error);
        }
      }
      container.replaceChildren();
    };
  }, [siteKey, size, theme, language, tabIndex]);

  const executeChallenge = useCallback(() => {
    if (widgetIdRef.current && window.hcaptcha) {
      try {
        window.hcaptcha.execute(widgetIdRef.current);
      } catch (error) {
        console.error('Failed to execute hCaptcha challenge:', error);
        callbacksRef.current.onError?.(error);
      }
    }
  }, []);

  const resetWidget = useCallback(() => {
    if (widgetIdRef.current && window.hcaptcha) {
      try {
        window.hcaptcha.reset(widgetIdRef.current);
      } catch (error) {
        console.warn('Failed to reset hCaptcha widget:', error);
      }
    }
  }, []);

  const getResponse = useCallback(() => {
    if (widgetIdRef.current && window.hcaptcha) {
      try {
        return window.hcaptcha.getResponse(widgetIdRef.current);
      } catch (error) {
        console.warn('Failed to get hCaptcha response:', error);
        return '';
      }
    }
    return '';
  }, []);

  // Expose methods to parent component via ref
  useImperativeHandle(ref, () => ({
    execute: executeChallenge,
    reset: resetWidget,
    getResponse
  }));

  return (
    <div
      ref={containerRef}
      aria-label={ariaLabel}
      role="region"
      className="hcaptcha-container"
    />
  );
};

HCaptchaWidget.displayName = 'HCaptchaWidget';

export default HCaptchaWidget;
