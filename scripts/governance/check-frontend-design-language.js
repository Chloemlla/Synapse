#!/usr/bin/env node
/**
 * 前端设计语言闸门。
 *
 * 视觉基准（唯一事实源）：
 *   frontend/src/components/ResourceStoreList.tsx
 *   frontend/src/components/studioTheme.tsx
 * 审查与修复清单：docs/audit/audit-2026-10-16-frontend-design-language.md（FD-001～FD-080）
 *
 * 本闸门只做**静态、无依赖、不需构建**的扫描：把「第二套配色 / 禁用色 / 非 slate 中性 /
 * 语义色漂移 / 任意颜色值 / 高饱和渐变 / 第二套 UI kit token / 独立视觉覆盖层 / 非 2xl 圆角」
 * 逐条计数，与基线比对。**基线只允许下降**：每个修复批次结束都要把基线调到新的更低值，
 * 不允许「把基线设成当前值然后不管」。
 *
 * 用法：
 *   node scripts/governance/check-frontend-design-language.js
 *   node scripts/governance/check-frontend-design-language.js --report   # 打印每个违规点
 *   node scripts/governance/check-frontend-design-language.js --update-baseline
 */

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "..");
const frontendSrc = path.join(root, "frontend", "src");
const baselineFile = path.join(__dirname, "frontend-design-language-baseline.json");

const argv = process.argv.slice(2);
const REPORT = argv.includes("--report");
const UPDATE_BASELINE = argv.includes("--update-baseline");

/**
 * 规则表。
 * - id: 基线与报告里的键，改动前先读 docs/audit 里对应 FD 编号。
 * - re: 全局正则。
 * - globs: 参与扫描的文件后缀。
 * - why: 失败信息里给人类看的判据（必须是「怎么改」而不是「别用」）。
 */
const RULES = [
  {
    id: "palette-forbidden-hue",
    why: "禁用色族 indigo/purple/fuchsia/pink；改用 slate-900 主操作 + sky/blue 轻装饰（studioTheme tokens）",
    re: /\b(?:bg|text|border|from|to|via|ring|shadow|fill|stroke|divide|placeholder|outline|accent|caret|decoration)-(?:indigo|purple|fuchsia|pink)(?:-\d{2,3})?(?:\/\d+)?\b/g,
    globs: [".tsx", ".ts"],
  },
  {
    id: "arbitrary-color-value",
    why: "任意颜色值（bg-[#…] / text-[rgb(…)] 等）；改用 studioTheme 的 slate/white 刻度或语义色",
    re: /\b(?:bg|text|border|from|to|via|ring|shadow|fill|stroke|outline|divide|placeholder|caret|decoration)-\[(?:#|rgb|hsl|oklch|color-mix)[^\]]*\]/g,
    globs: [".tsx", ".ts"],
  },
  {
    id: "non-slate-neutral",
    why: "非 slate 中性阶（gray/zinc/neutral/stone）；基准只用 slate-50…950",
    re: /\b(?:bg|text|border|from|to|via|ring|divide|placeholder|shadow|outline)-(?:gray|zinc|neutral|stone)-\d{2,3}\b/g,
    globs: [".tsx", ".ts"],
  },
  {
    id: "semantic-color-drift",
    why: "语义色漂移；成功用 emerald、警告用 amber、错误用 rose（red/green/yellow 不是基准色）",
    re: /\b(?:bg|text|border|from|to|via|ring|divide|placeholder|shadow|outline|fill|stroke)-(?:red|green|yellow)-\d{2,3}\b/g,
    globs: [".tsx", ".ts"],
  },
  {
    id: "saturated-gradient",
    why: "高饱和双色渐变；只允许 studioAccentBlob*ClassName 的 blue/sky 径向装饰",
    re: /\bbg-gradient-to-[a-z]+\b/g,
    globs: [".tsx", ".ts"],
  },
  {
    id: "second-ui-kit-token",
    why: "shadcn/base-ui 语义 token（bg-primary / text-muted-foreground / border-sidebar …）；改用 studioTheme 常量",
    re: /\b(?:bg|text|border|ring|fill|stroke|from|to|via|outline|divide)-(?:primary|secondary|muted|accent|destructive|popover|card|input|sidebar)(?:-foreground)?(?:\/\d+)?\b/g,
    globs: [".tsx", ".ts"],
  },
  {
    id: "legacy-palette-name",
    why: "已被删除的 legacy 色板/字体（ink-black/dark-slate/wheat/burnt-orange/midnight-violet/font-songti）",
    re: /\b(?:ink-black|dark-slate|wheat|burnt-orange|midnight-violet|font-songti)\b/g,
    globs: [".tsx", ".ts", ".css"],
  },
  {
    id: "second-brand-color-literal",
    why: "第二套品牌色字面量（indigo/violet 十六进制、Apple 系统蓝）；主操作用 #0f172a，信息色用 sky-600 #0284c7",
    re: /#(?:6366f1|818cf8|4f46e5|8b5cf6|a855f7|007AFF|0A84FF|2563eb|3b82f6|1d4ed8)\b|\brgb\(\s*99\s*,\s*102\s*,\s*241\s*\)|\brgb\(\s*139\s*,\s*92\s*,\s*246\s*\)/gi,
    globs: [".tsx", ".ts", ".css"],
  },
  {
    id: "independent-visual-overlay",
    why: "以 !important CSS 覆盖层伪装的独立视觉语言；改为直接把页面配色改到 token 后删除该 class",
    re: /logshare-admin-surface/g,
    globs: [".tsx", ".ts"],
  },
  {
    id: "off-scale-radius",
    why: "非基准圆角；卡片/面/表单/按钮/弹窗统一 rounded-2xl，pill/徽标 rounded-full",
    re: /\brounded-(?:sm|md|lg|xl)\b/g,
    globs: [".tsx"],
  },
  {
    // 四态/弹窗原语住在 components/studioFeedback.tsx，不在 studioTheme 里。
    // lane 反复踩过这个坑：从 studioTheme 导入 StudioErrorState/StudioPager 会得到
    // TS2305（module has no exported member），而它只在 type-check 阶段才暴露。
    id: "mislocated-studio-primitive",
    why: "Studio* 四态/弹窗原语必须从 studioFeedback 导入（studioTheme 只导出 token/Info* 族）",
    re: null,
    globs: [".tsx", ".ts"],
    custom: "studio-primitive-source",
  },
];

const STUDIO_PRIMITIVE_NAMES = [
  "StudioErrorState",
  "StudioErrorNote",
  "StudioSuccessNote",
  "StudioEmptyState",
  "StudioLoadingState",
  "StudioPager",
  "StudioModal",
  "StudioModalHeader",
  "StudioModalPrimaryButton",
  "StudioModalDangerButton",
];

/**
 * 找出「从 studioTheme 导入 Studio* 原语」的 import 块（应为 studioFeedback）。
 * 返回 [{ line, text }]。
 */
function findMislocatedStudioPrimitives(content) {
  const out = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!/^\s*import\b/.test(line)) continue;
    // 收集直到 import 语句结束（含 '...' from '...'; 这一行）
    let block = line;
    let end = i;
    while (end < lines.length && !/from\s+['"][^'"]+['"]/.test(block)) {
      end += 1;
      if (end >= lines.length) break;
      block += '\n' + lines[end];
    }
    const fromMatch = block.match(/from\s+['"]([^'"]+)['"]/);
    if (!fromMatch) continue;
    const source = fromMatch[1];
    if (!/(^|\/)studioTheme$/.test(source)) continue;
    for (const name of STUDIO_PRIMITIVE_NAMES) {
      if (new RegExp(`(^|[^A-Za-z0-9_])${name}([^A-Za-z0-9_]|$)`).test(block)) {
        out.push({ line: i + 1, text: name });
      }
    }
    i = end;
  }
  return out;
}

function walk(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", "dist", ".git"].includes(entry.name)) continue;
      walk(full, acc);
    } else {
      acc.push(full);
    }
  }
  return acc;
}

function rel(file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function main() {
  if (!fs.existsSync(frontendSrc)) {
    console.error(`Design language guard: 找不到 ${rel(frontendSrc)}，fail-closed。`);
    process.exit(1);
  }

  const files = walk(frontendSrc).filter((f) => !/\.(test|spec)\.tsx?$/.test(f));
  const counts = Object.fromEntries(RULES.map((r) => [r.id, 0]));
  const hits = Object.fromEntries(RULES.map((r) => [r.id, []]));

  for (const file of files) {
    const ext = path.extname(file);
    const applicable = RULES.filter((r) => r.globs.includes(ext));
    if (!applicable.length) continue;
    const content = fs.readFileSync(file, "utf8");
    const lines = content.split(/\r?\n/);
    for (const rule of applicable) {
      if (!rule.re) {
        if (rule.custom === "studio-primitive-source") {
          for (const hit of findMislocatedStudioPrimitives(content)) {
            counts[rule.id] += 1;
            if (hits[rule.id].length < 400) {
              hits[rule.id].push({ file: rel(file), line: hit.line, text: hit.text });
            }
          }
        }
        continue;
      }
      lines.forEach((line, index) => {
        rule.re.lastIndex = 0;
        let match;
        while ((match = rule.re.exec(line)) !== null) {
          counts[rule.id] += 1;
          if (hits[rule.id].length < 400) {
            hits[rule.id].push({ file: rel(file), line: index + 1, text: match[0] });
          }
          if (rule.re.lastIndex === match.index) rule.re.lastIndex += 1;
        }
      });
    }
  }

  if (UPDATE_BASELINE) {
    fs.writeFileSync(baselineFile, `${JSON.stringify(counts, null, 2)}\n`);
    console.log(`Design language guard: 基线已更新 → ${rel(baselineFile)}`);
    console.log(JSON.stringify(counts, null, 2));
    return;
  }

  if (!fs.existsSync(baselineFile)) {
    console.error(
      `Design language guard: 缺少基线文件 ${rel(baselineFile)}（fail-closed）。` +
        "先跑一次 --update-baseline 生成，并把数值与本清单 FD 编号对账。",
    );
    process.exit(1);
  }
  const baseline = JSON.parse(fs.readFileSync(baselineFile, "utf8"));

  const regressions = [];
  const improvements = [];
  for (const rule of RULES) {
    const allowed = Number(baseline[rule.id] ?? 0);
    const actual = counts[rule.id];
    if (actual > allowed) regressions.push({ rule, allowed, actual });
    else if (actual < allowed) improvements.push({ rule, allowed, actual });
  }

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const totalAllowed = RULES.reduce((a, r) => a + Number(baseline[r.id] ?? 0), 0);
  console.log(
    `Design language guard: ${files.length} 个源文件，命中 ${total} 处（基线上限 ${totalAllowed}）。`,
  );
  for (const rule of RULES) {
    console.log(
      `  ${String(counts[rule.id]).padStart(6)} / ≤${String(baseline[rule.id] ?? 0).padStart(6)}  ${rule.id}`,
    );
  }

  if (REPORT) {
    for (const { rule, allowed, actual } of [...regressions, ...improvements]) {
      console.log(`\n--- ${rule.id} (${actual}, 基线 ${allowed}) ---`);
      console.log(`    判据：${rule.why}`);
      for (const hit of hits[rule.id].slice(0, 40)) {
        console.log(`    ${hit.file}:${hit.line}  ${hit.text}`);
      }
    }
  }

  if (regressions.length) {
    console.error("\nDesign language guard 失败：以下规则超过基线（新增违规）：");
    for (const { rule, allowed, actual } of regressions) {
      console.error(`  ${rule.id}: ${actual} > ${allowed}`);
      console.error(`    判据：${rule.why}`);
      for (const hit of hits[rule.id].slice(0, 15)) {
        console.error(`    ${hit.file}:${hit.line}  ${hit.text}`);
      }
    }
    console.error(
      "\n修复指引：docs/audit/audit-2026-10-16-frontend-design-language.md（按规则名查对应 FD 编号）。" +
        "确属基线内清理把数值调低时，跑 --update-baseline 并同步回填清单 §6。",
    );
    process.exit(1);
  }

  if (improvements.length) {
    console.log(
      `\n注意：${improvements.length} 条规则已低于基线（` +
        improvements.map((i) => `${i.rule.id} ${i.allowed}→${i.actual}`).join(", ") +
        "）。修复批次结束时请跑 --update-baseline 把上限收紧。",
    );
  }
  console.log("Design language guard 通过。");
}

main();
