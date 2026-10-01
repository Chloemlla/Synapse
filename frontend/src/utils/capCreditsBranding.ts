/**
 * Cap（trycap）控件署名覆写。
 *
 * 官方 `<cap-widget>` 会在自己的 **open shadow root** 里插入一枚署名链接：
 *
 *   <a class="credits" aria-label="Secured by Cap" href="https://trycap.dev"
 *      title="Secured by Cap: The self-hosted CAPTCHA for the modern web.">Cap</a>
 *
 * 且控件内部有两处「不让我们改完就走」的行为：
 *   1. `#enforceCredits()` 在创建时、创建后 100ms、以及每次 UI 更新时都会把节点重新
 *      挂回 DOM，并把 textContent 复位成 "Cap"、href 复位成 https://trycap.dev；
 *   2. 点击处理器挂在署名节点上：`preventDefault()` 之后 `window.open()` 到
 *      trycap.dev 的带 utm 参数链接（点击数据会离开站点）。
 *
 * 因此「只改一次 DOM」一定会被控件改回去。这里的做法是：
 *   - 在控件的 shadow root 上装 MutationObserver，发现被复位就立刻改回；
 *   - 在 shadow root 的 **捕获阶段** 拦掉控件自己的 click 处理器
 *     （AT_TARGET 阶段捕获监听先于冒泡监听执行，stopImmediatePropagation 即可阻断），
 *     改为打开本站站点；
 *   - 另补几个定时点，兜住「观察器装上之前控件已经复位过」的时序。
 *
 * 覆写后署名文本为 chloemlla、链接指向 https://chloemlla.com，不再向第三方发出点击。
 */

export const CAP_CREDITS_LABEL = 'chloemlla';
export const CAP_CREDITS_HREF = 'https://chloemlla.com';
export const CAP_CREDITS_TITLE = 'chloemlla：自托管的人机验证服务。';

/** 只认控件用的 class="credits" 链接，避免误伤页面自身的 <a>。 */
const CAP_CREDITS_SELECTOR = 'a.credits';

/** 控件 `#enforceCredits()` 会在创建后 100ms 复位一次；多跟几个时间点兜底。 */
const RE_APPLY_DELAYS_MS = [0, 120, 600, 1500, 3000];

/** 已经装过 click 拦截的 shadow root（控件可能被反复挂载/卸载）。 */
const interceptedRoots = new WeakSet<ShadowRoot>();

export type CapCreditsBrandingDisposer = () => void;

/** 只在值真的变了才写，避免自触发的 MutationObserver 回调打转。 */
const setAttributeIfChanged = (element: Element, name: string, value: string): void => {
  if (element.getAttribute(name) !== value) element.setAttribute(name, value);
};

const isCreditsAnchor = (target: EventTarget | null): target is HTMLAnchorElement => {
  if (!target || (target as Element).nodeType !== Node.ELEMENT_NODE) return false;
  const element = target as Element;
  return element.tagName === 'A' && element.classList.contains('credits');
};

/** 把 shadow root 上的一次点击改道到本站：拦住控件自带的 trycap.dev 跳转。 */
const interceptCreditsClicks = (root: ShadowRoot): void => {
  if (interceptedRoots.has(root)) return;
  interceptedRoots.add(root);
  root.addEventListener(
    'click',
    (event: Event) => {
      if (!isCreditsAnchor(event.target)) return;
      event.preventDefault();
      // 控件把监听器挂在同一个 <a> 上（冒泡阶段），捕获阶段先跑并终止传播即可拦下它。
      event.stopImmediatePropagation();
      window.open(CAP_CREDITS_HREF, '_blank', 'noopener,noreferrer');
    },
    true,
  );
};

/** 覆写 shadow root 内所有署名节点（含被控件新插入的）。 */
const patchCreditsAnchors = (root: ShadowRoot): void => {
  interceptCreditsClicks(root);
  for (const anchor of Array.from(root.querySelectorAll<HTMLAnchorElement>(CAP_CREDITS_SELECTOR))) {
    if (anchor.textContent !== CAP_CREDITS_LABEL) anchor.textContent = CAP_CREDITS_LABEL;
    setAttributeIfChanged(anchor, 'href', CAP_CREDITS_HREF);
    setAttributeIfChanged(anchor, 'aria-label', CAP_CREDITS_LABEL);
    setAttributeIfChanged(anchor, 'title', CAP_CREDITS_TITLE);
    setAttributeIfChanged(anchor, 'rel', 'noopener noreferrer');
  }
};

/**
 * 对一个 `<cap-widget>` 宿主要持续覆写其署名，返回清理函数（组件卸载时调用）。
 *
 * 宿主可能还没 attachShadow（尚未连接），此时由后续定时点补装观察器。
 */
export const applyCapCreditsBranding = (host: Element | null | undefined): CapCreditsBrandingDisposer => {
  if (!host || typeof window === 'undefined' || typeof MutationObserver === 'undefined') {
    return () => {};
  }

  const timers: number[] = [];
  let observer: MutationObserver | null = null;
  let disposed = false;

  const patch = (): void => {
    if (disposed) return;
    const root = (host as HTMLElement).shadowRoot;
    if (root) patchCreditsAnchors(root);
  };

  const observe = (): void => {
    if (disposed || observer) return;
    const root = (host as HTMLElement).shadowRoot;
    if (!root) return;
    observer = new MutationObserver(patch);
    // 控件复位走的是 textContent / href，节点被移出再挂回走 childList，都要盯。
    observer.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['href', 'aria-label', 'title'],
    });
  };

  patch();
  observe();
  for (const delay of RE_APPLY_DELAYS_MS) {
    timers.push(
      window.setTimeout(() => {
        patch();
        observe();
      }, delay),
    );
  }

  return () => {
    disposed = true;
    observer?.disconnect();
    observer = null;
    for (const timer of timers) window.clearTimeout(timer);
    timers.length = 0;
  };
};

export default applyCapCreditsBranding;
