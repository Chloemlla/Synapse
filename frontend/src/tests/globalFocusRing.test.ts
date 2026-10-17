import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 焦点兜底的层级回归闸门（2026-10-17 线上现象）。
 *
 * 现象：首屏加载后整个内容区外围出现一圈深色方框，点一下或按方向键后消失。
 * 根因：全局焦点兜底规则写在 index.css **顶层**（unlayered）。Tailwind v4 把所有
 * 工具类放在 `@layer utilities`，而未分层规则**优先级高于任何图层**（与特异度无关），
 * 于是 `outline-none` / `focus:outline-none` 全部失效；首屏脚本给
 * `#app-main-content`（`tabindex="-1"`）的 `.focus()` 就把 2px 外框画了出来。
 *
 * 闸门只钉两件事：
 *   1) 兜底规则必须在 `@layer base` 内，工具类才能按预期覆盖它；
 *   2) 选择器排除 `tabindex="-1"`（脚本聚焦落点 / 跳转目标不是键盘导航焦点）。
 *
 * 只读源码，不依赖构建产物。
 */
const indexCss = fs.readFileSync(path.join(__dirname, '..', 'index.css'), 'utf8');

/** 取出所有 `@layer <name> { ... }` 的块内容（够用的花括号配平，不处理字符串里的括号）。 */
function layerBlocks(css: string, layerName: string): string[] {
  const blocks: string[] = [];
  const marker = `@layer ${layerName} {`;
  let cursor = 0;
  while (true) {
    const start = css.indexOf(marker, cursor);
    if (start === -1) break;
    let depth = 0;
    let index = start + marker.length - 1;
    for (; index < css.length; index += 1) {
      if (css[index] === '{') depth += 1;
      else if (css[index] === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    blocks.push(css.slice(start + marker.length, index));
    cursor = index + 1;
  }
  return blocks;
}

describe('全局焦点兜底', () => {
  const FOCUS_SELECTOR = ':where(button, a, input, select, textarea, summary';

  it('规则位于 @layer base，工具类的 outline-none 才能覆盖它', () => {
    const base = layerBlocks(indexCss, 'base');
    expect(base.some((block) => block.includes(FOCUS_SELECTOR))).toBe(true);
  });

  it('顶层不再有同一条兜底规则（unlayered 会压过所有工具类）', () => {
    const withoutBase = layerBlocks(indexCss, 'base').reduce((css, block) => css.replace(block, ''), indexCss);
    expect(withoutBase).not.toContain(FOCUS_SELECTOR);
  });

  it('排除 tabindex="-1"：脚本聚焦落点不应画出焦点框', () => {
    const rule = layerBlocks(indexCss, 'base').find((block) => block.includes(FOCUS_SELECTOR)) ?? '';
    expect(rule).toContain('[tabindex]:not([tabindex="-1"])');
  });
});
