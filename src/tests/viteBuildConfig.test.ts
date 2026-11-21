import fs from "node:fs";
import path from "node:path";

// Read config rather than importing it: no Vite hooks, git subprocesses or builds.
// The actual Vercel-mode build remains a CI verification, not a static-test claim.
const vite = fs.readFileSync(path.resolve(__dirname, "../../frontend/vite.config.ts"), "utf8");

/**
 * 取出每一处 `codeSplitting: { groups: [ … ] }` 的**完整**数组文本。
 *
 * 为什么不用 `codeSplitting:\s*\{\s*groups:\s*\[([\s\S]*?)\]` 一趟正则：组里的
 * `test: /vite[\\/]preload-helper/` 自带一个 `]`（正则字符类的收尾），惰性匹配会停在
 * 那里，截出来的「数组」只有第一组的开头，`manual-vendor` 组永远看不到 —— 这正是
 * #1020 引入本用例后 Governance checks 长期红的原因（断言 `priority: 0` 收到 undefined）。
 *
 * 这里改成按 `[` / `]` 计数扫描到配平的收尾括号。字符类 `/vite[\\/]/` 的 `[`、`]`
 * 成对出现，计数净增 0，因此不会误判数组边界。
 */
function codeSplittingGroups(source: string): string[] {
  const found: string[] = [];
  const marker = /codeSplitting:\s*\{\s*groups:\s*\[/g;
  for (let match = marker.exec(source); match; match = marker.exec(source)) {
    const open = source.indexOf("[", match.index);
    let depth = 0;
    for (let i = open; i < source.length; i++) {
      const ch = source[i];
      if (ch === "[") {
        depth += 1;
      } else if (ch === "]") {
        depth -= 1;
        if (depth === 0) {
          found.push(source.slice(open + 1, i));
          marker.lastIndex = i;
          break;
        }
      }
    }
  }
  return found;
}

it("uses only supported Oxc transform options instead of ignored esbuild options", () => {
  expect(vite).not.toMatch(/^\s+esbuild\s*:/m);
  const oxc = vite.match(/^\s+oxc:\s*\{([^}]+)\}\s*satisfies OxcOptions/m)?.[1];
  expect(oxc).toBeDefined();
  expect(oxc).toMatch(/target:\s*"es2020"/);
  expect(oxc).not.toMatch(/\b(?:sourcemap|legalComments|logOverride|treeShaking|minifyIdentifiers|minifySyntax|minifyWhitespace|keepNames)\s*:/);
});

it("retains the effective build minifier, tree shaking and sourcemap settings", () => {
  const build = vite.slice(vite.indexOf("    build: {"), vite.indexOf("    optimizeDeps: {"));
  expect(build).toMatch(/minify:\s*"terser"/);
  expect(build).toMatch(/terserOptions:\s*\{\s*compress:\s*\{\s*drop_console:\s*true,\s*drop_debugger:\s*true/);
  expect(build).toMatch(/mangle:\s*\{\s*toplevel:\s*true/);
  expect(build).toMatch(/treeshake:\s*true/);
  expect(build).toMatch(/sourcemap:\s*false/);
});

it("labels every function-named chunk group without changing chunk selection or priority", () => {
  const groups = codeSplittingGroups(vite);
  expect(groups.length).toBeGreaterThan(0);
  for (const groupArray of groups) {
    // 组对象内部没有嵌套花括号（name/test/debugName/priority 都是标量或单行箭头函数）。
    const groupObjects = [...groupArray.matchAll(/\{[^{}]*\}/g)].map((m) => m[0]);
    const functionalGroup = groupObjects.find((g) => g.includes("=>"));
    expect(functionalGroup).toBeDefined();
    expect(functionalGroup).toMatch(/name:\s*\(moduleId:\s*string\)\s*=>\s*getManualChunk\(moduleId\)/);
    expect(functionalGroup).toMatch(/debugName:\s*"manual-vendor"/);
    expect(functionalGroup).toMatch(/priority:\s*0/);
    expect(groupObjects.some((g) => /name:\s*"vite-runtime"[^}]+priority:\s*100/.test(g))).toBe(true);
  }
});
