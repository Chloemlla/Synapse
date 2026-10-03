import fs from 'node:fs';

/**
 * 静态检查：多行 import 块里不允许再出现**语句级** import。
 * 这类破坏会产出 TS1003/TS1005 一族语法错，但括号计数仍然平衡、肉眼 diff 也容易漏
 * （本轮已两次踩到：logShare/imports、configurationNoticeCoreIssues）。
 * 动态 import('...') 不算语句级 import，直接跳过。
 */

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (['node_modules', '.git', 'dist', 'build'].includes(entry.name)) continue;
      walk(full, out);
    } else if (/\.(ts|tsx|mts|cts)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const strip = (line) => line.replace(/\/\/.*$/, '').trim();

function check(file, report) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  let open = false;
  lines.forEach((raw, i) => {
    const line = strip(raw);
    if (!line) return;
    if (!open) {
      if (!/^import\b/.test(line)) return;
      if (/^import\s*[.(]/.test(line)) return; // 动态 import('...') 或 import.meta
      if (/\bfrom\s+['"][^'"]+['"]\s*;?\s*$/.test(line)) return; // 单行语句
      if (/^import\s+['"][^'"]+['"]\s*;?\s*$/.test(line)) return; // 副作用 import
      open = true;
      return;
    }
    if (/^import\b/.test(line) && !/^import\s*\(/.test(line)) {
      report.push(`${file}:${i + 1} | ${line.slice(0, 80)}`);
      open = false;
      return;
    }
    if (/\bfrom\s+['"][^'"]+['"]/.test(line)) open = false;
  });
}

const files = process.argv.slice(2).length ? process.argv.slice(2) : [...walk('src'), ...walk('frontend/src')];
const report = [];
for (const file of files) if (fs.existsSync(file)) check(file, report);
for (const line of report) console.log('NESTED-IMPORT', line);
console.log('files checked:', files.length, 'nested-import issues:', report.length);
