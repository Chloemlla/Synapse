import React, { createRef } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import HCaptchaWidget from '../components/HCaptchaWidget';
import { TurnstileWidget } from '../components/TurnstileWidget';
import CapWidget, { type CapWidgetRef } from '../components/CapWidget';

vi.mock('../utils/capCreditsBranding', () => ({ applyCapCreditsBranding: () => () => {} }));
vi.mock('../utils/scheduleAfterPaint', () => ({ afterFirstPaintIdle: async () => {} }));

type Provider = 'hcaptcha' | 'turnstile';
interface SdkCallbacks {
  callback?: (token: string) => void;
  'expired-callback'?: () => void;
  'error-callback'?: () => void;
}

function installSdk(provider: Provider) {
  let widgetCount = 0;
  const sdk = {
    render: vi.fn((_container: string | HTMLElement, _options: SdkCallbacks) => `widget-${++widgetCount}`),
    remove: vi.fn(),
    reset: vi.fn(),
    execute: vi.fn(),
    getResponse: vi.fn(() => ''),
  };
  window[provider] = sdk;
  return sdk;
}

function widget(provider: Provider, props: {
  siteKey: string;
  onVerify: (token: string) => void;
  onExpire: () => void;
  onError: () => void;
}) {
  return provider === 'hcaptcha' ? <HCaptchaWidget {...props} /> : <TurnstileWidget {...props} />;
}

const flush = async () => { await act(async () => {}); };
const scriptFor = (provider: Provider) => document.querySelector<HTMLScriptElement>(
  provider === 'hcaptcha' ? 'script[src*="js.hcaptcha.com"]' : 'script[data-turnstile-api]',
);
const callbacks = () => ({ onVerify: vi.fn(), onExpire: vi.fn(), onError: vi.fn() });

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv('DEV', false);
  Reflect.deleteProperty(window, 'hcaptcha');
  Reflect.deleteProperty(window, 'turnstile');
  window.capWidgetScriptState = undefined;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  cleanup();
  // Shared script requests outlive individual consumers, but always have a bounded timeout.
  await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
  document.querySelectorAll('script[src*="hcaptcha"], script[data-turnstile-api], #cap-widget-script').forEach((script) => script.remove());
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe.each(['hcaptcha', 'turnstile'] as const)('%s SDK lifecycle', (provider) => {
  it('uses fresh callbacks without remounting and removes the old widget on configuration changes', async () => {
    const sdk = installSdk(provider);
    const first = callbacks();
    const latest = callbacks();
    const view = render(widget(provider, { siteKey: 'first', ...first }));
    await flush();
    const oldCallbacks = sdk.render.mock.calls[0][1];
    view.rerender(widget(provider, { siteKey: 'first', ...latest }));
    expect(sdk.render).toHaveBeenCalledTimes(1);
    act(() => oldCallbacks.callback?.('token'));
    expect(first.onVerify).not.toHaveBeenCalled();
    expect(latest.onVerify).toHaveBeenCalledWith('token');
    act(() => oldCallbacks['expired-callback']?.());
    expect(latest.onExpire).toHaveBeenCalledTimes(1);

    view.rerender(widget(provider, { siteKey: 'second', ...latest }));
    await flush();
    expect(sdk.remove).toHaveBeenCalledWith('widget-1');
    expect(sdk.render).toHaveBeenCalledTimes(2);
    expect(sdk.render.mock.calls[1][1]).toMatchObject({ sitekey: 'second' });
    act(() => {
      oldCallbacks.callback?.('stale');
      oldCallbacks['expired-callback']?.();
      oldCallbacks['error-callback']?.();
    });
    expect(latest.onVerify).toHaveBeenCalledTimes(1);
    expect(latest.onExpire).toHaveBeenCalledTimes(1);
    expect(latest.onError).not.toHaveBeenCalled();
    const currentCallbacks = sdk.render.mock.calls[1][1];
    view.unmount();
    act(() => currentCallbacks.callback?.('unmounted'));
    expect(latest.onVerify).toHaveBeenCalledTimes(1);
    expect(sdk.remove).toHaveBeenCalledTimes(2);
  });

  it('shares a pending script across instances and renders both when the API becomes ready', async () => {
    const first = callbacks();
    const second = callbacks();
    render(<>{widget(provider, { siteKey: 'first', ...first })}{widget(provider, { siteKey: 'second', ...second })}</>);
    const script = scriptFor(provider);
    expect(script).not.toBeNull();
    expect(document.querySelectorAll(`script[src="${script!.src}"]`)).toHaveLength(1);
    const sdk = installSdk(provider);
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(sdk.render).toHaveBeenCalledTimes(2);
    act(() => {
      sdk.render.mock.calls[0][1].callback?.('first');
      sdk.render.mock.calls[1][1].callback?.('second');
    });
    expect(first.onVerify).toHaveBeenCalledWith('first');
    expect(second.onVerify).toHaveBeenCalledWith('second');
  });

  it.each(['error', 'timeout'] as const)('removes a script after %s and permits a fresh load', async (failure) => {
    const handlers = callbacks();
    const first = render(widget(provider, { siteKey: 'key', ...handlers }));
    const failedScript = scriptFor(provider)!;
    await act(async () => {
      if (failure === 'error') failedScript.dispatchEvent(new Event('error'));
      else await vi.advanceTimersByTimeAsync(15000);
    });
    expect(handlers.onError).toHaveBeenCalledTimes(1);
    expect(failedScript.isConnected).toBe(false);
    first.unmount();
    render(widget(provider, { siteKey: 'key', ...handlers }));
    expect(scriptFor(provider)).not.toBeNull();
    expect(scriptFor(provider)).not.toBe(failedScript);
    const sdk = installSdk(provider);
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(sdk.render).toHaveBeenCalledTimes(1);
  });
});

describe('Cap lifecycle', () => {
  it.each(['error', 'timeout'] as const)('allows retry after script %s and ignores late load from the failed script', async (failure) => {
    const handlers = callbacks();
    const first = render(<CapWidget siteKey="key" apiEndpoint="/cap" deferUntilIdle={false} {...handlers} />);
    const failedScript = document.getElementById('cap-widget-script')!;
    await act(async () => {
      if (failure === 'error') failedScript.dispatchEvent(new Event('error'));
      else await vi.advanceTimersByTimeAsync(15000);
    });
    expect(handlers.onError).toHaveBeenCalledTimes(1);
    expect(failedScript.isConnected).toBe(false);
    failedScript.dispatchEvent(new Event('load'));
    expect(window.capWidgetScriptState).toBe('failed');
    first.unmount();
    render(<CapWidget siteKey="key" apiEndpoint="/cap" deferUntilIdle={false} {...handlers} />);
    const freshScript = document.getElementById('cap-widget-script')!;
    expect(freshScript).not.toBeNull();
    expect(freshScript).not.toBe(failedScript);
    await act(async () => { freshScript.dispatchEvent(new Event('load')); });
    expect(document.querySelector('cap-widget')).not.toBeNull();
  });

  it('reports async solve rejection and ignores rejection from a removed element', async () => {
    window.capWidgetScriptState = 'ready';
    const ref = createRef<CapWidgetRef>();
    const handlers = callbacks();
    const view = render(<CapWidget ref={ref} siteKey="key" apiEndpoint="/cap" deferUntilIdle={false} {...handlers} />);
    await flush();
    const element = document.querySelector('cap-widget') as HTMLElement & { solve: () => Promise<{ token: string }> };
    const error = new Error('solver unavailable');
    element.solve = () => Promise.reject(error);
    await act(async () => { ref.current!.execute(); });
    expect(handlers.onError).toHaveBeenCalledWith(error);
    let reject!: (reason: unknown) => void;
    element.solve = () => new Promise((_resolve, rejectPromise) => { reject = rejectPromise; });
    act(() => ref.current!.execute());
    view.unmount();
    await act(async () => { reject(new Error('late failure')); });
    expect(handlers.onError).toHaveBeenCalledTimes(1);
  });

  it('delivers real expiry while mounted but ignores disconnected solve, error and reset events', async () => {
    window.capWidgetScriptState = 'ready';
    const handlers = callbacks();
    render(<CapWidget siteKey="key" apiEndpoint="/cap" deferUntilIdle={false} {...handlers} />);
    await flush();
    const element = document.querySelector('cap-widget')!;
    act(() => {
      element.dispatchEvent(new CustomEvent('solve', { detail: { token: 'token' } }));
      element.dispatchEvent(new Event('reset'));
    });
    expect(handlers.onVerify).toHaveBeenCalledWith('token');
    expect(handlers.onExpire).toHaveBeenCalledTimes(1);
    // Simulate disconnectedCallback before React flushes passive cleanup.
    element.remove();
    act(() => {
      element.dispatchEvent(new CustomEvent('solve', { detail: { token: 'stale' } }));
      element.dispatchEvent(new CustomEvent('error', { detail: new Error('disconnected') }));
      element.dispatchEvent(new Event('reset'));
    });
    expect(handlers.onVerify).toHaveBeenCalledTimes(1);
    expect(handlers.onExpire).toHaveBeenCalledTimes(1);
    expect(handlers.onError).not.toHaveBeenCalled();
  });
});
