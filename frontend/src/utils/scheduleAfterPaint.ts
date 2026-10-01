/**
 * 把「非首屏必需」的第三方脚本/计算推迟到首帧绘制之后、浏览器空闲时再执行。
 *
 * 背景：/captcha-verify 的 trace 显示 cap 控件（13 个 WASM Worker）、Microsoft Clarity
 * 的脚本求值都和首屏渲染挤在同一时间窗里，直接造成丢帧。
 * 见 docs/perf/2026-10-01-captcha-verify-trace-analysis.md。
 */

type IdleCallbackWindow = Window & {
  requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
};

/**
 * 解析时机：连等两帧（确保首帧已提交）后交给 requestIdleCallback；
 * 不支持 requestIdleCallback 时退化成 `setTimeout(…, 0)`。timeoutMs 是兜底上限，
 * 即使一直不空闲也不会晚于它执行。
 */
export function afterFirstPaintIdle(timeoutMs = 800): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window === 'undefined') {
      resolve();
      return;
    }

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    const scheduleIdle = () => {
      const idleWindow = window as IdleCallbackWindow;
      if (typeof idleWindow.requestIdleCallback === 'function') {
        idleWindow.requestIdleCallback(finish, { timeout: timeoutMs });
        return;
      }
      window.setTimeout(finish, Math.min(timeoutMs, 200));
    };

    if (typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(() => window.requestAnimationFrame(scheduleIdle));
      return;
    }
    window.setTimeout(scheduleIdle, 0);
  });
}
