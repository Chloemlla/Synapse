import fs from "node:fs";
import path from "node:path";

// Read config rather than importing it: no Vite hooks, git subprocesses or builds.
// The actual Vercel-mode build remains a CI verification, not a static-test claim.
const vite = fs.readFileSync(path.resolve(__dirname, "../../frontend/vite.config.ts"), "utf8");

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
  const groups = [...vite.matchAll(/codeSplitting:\s*\{\s*groups:\s*\[([\s\S]*?)\]/g)];
  expect(groups.length).toBeGreaterThan(0);
  for (const group of groups) {
    const functionalGroup = group[1].match(/\{\s*name:\s*\([^)]*\)\s*=>[^}]+\}/)?.[0];
    expect(functionalGroup).toBeDefined();
    expect(functionalGroup).toMatch(/name:\s*\(moduleId:\s*string\)\s*=>\s*getManualChunk\(moduleId\)/);
    expect(functionalGroup).toMatch(/debugName:\s*"manual-vendor"/);
    expect(functionalGroup).toMatch(/priority:\s*0/);
    expect(group[1]).toMatch(/name:\s*"vite-runtime"[^}]+priority:\s*100/);
  }
});
