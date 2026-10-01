import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CAP_CREDITS_HREF,
  CAP_CREDITS_LABEL,
  CAP_CREDITS_TITLE,
  applyCapCreditsBranding,
  type CapCreditsBrandingDisposer,
} from './capCreditsBranding';

/**
 * 这些用例钉的是 Cap 控件的真实结构：署名链接在控件的 open shadow root 里，
 * 且控件自己会把它复位（textContent="Cap"、href=trycap.dev）、点击时跳去 trycap.dev。
 * 一旦有人在 utils/capCreditsBranding.ts 里只做一次性覆写，第 2、3 个用例就会红。
 */

const flushMutations = async (): Promise<void> => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
};

interface FakeCapWidget {
  host: HTMLElement;
  shadow: ShadowRoot;
  credits: HTMLAnchorElement;
}

/** 复刻 @cap.js/widget 0.1.58 createUI() 造出来的那棵子树。 */
const createFakeCapWidget = (): FakeCapWidget => {
  const host = document.createElement('cap-widget');
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });

  const container = document.createElement('div');
  container.className = 'captcha';

  const credits = document.createElement('a');
  credits.className = 'credits';
  credits.setAttribute('aria-label', 'Secured by Cap');
  credits.setAttribute('href', 'https://trycap.dev');
  credits.setAttribute('target', '_blank');
  credits.setAttribute('title', 'Secured by Cap: The self-hosted CAPTCHA for the modern web.');
  credits.textContent = 'Cap';

  container.appendChild(credits);
  shadow.appendChild(container);

  return { host, shadow, credits };
};

/** 控件的 #enforceCredits()：把节点挂回原处并复位文本/href。 */
const enforceCredits = (widget: FakeCapWidget): void => {
  widget.credits.parentNode?.removeChild(widget.credits);
  widget.shadow.querySelector('.captcha')?.appendChild(widget.credits);
  widget.credits.textContent = 'Cap';
  widget.credits.setAttribute('href', 'https://trycap.dev');
};

describe('capCreditsBranding', () => {
  const disposers: CapCreditsBrandingDisposer[] = [];

  const apply = (host: HTMLElement): CapCreditsBrandingDisposer => {
    const dispose = applyCapCreditsBranding(host);
    disposers.push(dispose);
    return dispose;
  };

  afterEach(() => {
    while (disposers.length > 0) disposers.pop()?.();
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it('rewrites the Cap credits link to chloemlla', () => {
    const { host, credits } = createFakeCapWidget();

    apply(host);

    expect(credits.textContent).toBe(CAP_CREDITS_LABEL);
    expect(credits.getAttribute('href')).toBe(CAP_CREDITS_HREF);
    expect(credits.getAttribute('aria-label')).toBe(CAP_CREDITS_LABEL);
    expect(credits.getAttribute('title')).toBe(CAP_CREDITS_TITLE);
    expect(credits.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('re-applies the rewrite after the widget resets its credits', async () => {
    const { host, credits } = createFakeCapWidget();

    apply(host);
    enforceCredits({ host, shadow: host.shadowRoot!, credits });
    await flushMutations();

    expect(credits.textContent).toBe(CAP_CREDITS_LABEL);
    expect(credits.getAttribute('href')).toBe(CAP_CREDITS_HREF);
  });

  it('rewrites a credits link the widget inserts later', async () => {
    const widget = createFakeCapWidget();
    apply(widget.host);

    // 控件重新 createUI()（或换实例）时会塞一个新的署名节点进来。
    const lateCredits = document.createElement('a');
    lateCredits.className = 'credits';
    lateCredits.setAttribute('href', 'https://trycap.dev');
    lateCredits.textContent = 'Cap';
    widget.shadow.querySelector('.captcha')?.appendChild(lateCredits);
    await flushMutations();

    expect(lateCredits.textContent).toBe(CAP_CREDITS_LABEL);
    expect(lateCredits.getAttribute('href')).toBe(CAP_CREDITS_HREF);
  });

  it('sends credits clicks to chloemlla instead of trycap.dev', () => {
    const { host, credits } = createFakeCapWidget();
    const widgetClickHandler = vi.fn();
    credits.addEventListener('click', widgetClickHandler);
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);

    apply(host);
    credits.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }));

    expect(openSpy).toHaveBeenCalledWith(CAP_CREDITS_HREF, '_blank', 'noopener,noreferrer');
    expect(widgetClickHandler).not.toHaveBeenCalled();
  });

  it('stops rewriting once disposed', async () => {
    const { host, credits } = createFakeCapWidget();
    const dispose = apply(host);
    dispose();

    enforceCredits({ host, shadow: host.shadowRoot!, credits });
    await flushMutations();

    expect(credits.textContent).toBe('Cap');
    expect(credits.getAttribute('href')).toBe('https://trycap.dev');
  });
});
