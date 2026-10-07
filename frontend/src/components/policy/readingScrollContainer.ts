/** DesktopShell owns scrolling; the mobile page uses the document. */
export function getReadingScrollContainer(): HTMLElement | null {
  const pane = document.getElementById('app-main-content');
  return pane && /^(auto|scroll)$/.test(window.getComputedStyle(pane).overflowY) ? pane : null;
}
