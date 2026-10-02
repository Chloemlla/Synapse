/**
 * 管理端导出的共用 CSV 工具。
 *
 * 为什么要有它：导出 CSV 有三个必须一起做的动作，之前每个模块各写一份，于是口径不一 ——
 *  1. **公式注入中和**：以 `=` `+` `-` `@` 开头的单元格在 Excel / WPS 里会被当公式求值
 *     （CSV injection，进一步可触发 DDE）。后端 `auditLogService.csvCell` 早做了这件事，
 *     前端两处导出（webhook 事件、崩溃报告）却是裸拼字符串，而这两处的字段完全由外部
 *     控制（webhook 投递方、崩溃上报客户端）—— 管理员一导出就中招。
 *  2. **CRLF 行分隔**：Excel 对 `\n` 的兼容性不一致，RFC 4180 规定 `\r\n`。
 *  3. **UTF-8 BOM**：没有 BOM 时 Excel 在简体中文 Windows 上按 GBK 解码，中文会变乱码。
 */

/** Excel/WPS 认作公式起始的字符（含制表符与回车：它们会被解析器丢弃后露出下一个字符）。 */
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

/** 单个单元格：中和公式起始字符 + 引号翻倍 + 整体加引号（永远加，避免逗号/换行歧义）。 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text =
    typeof value === 'string'
      ? value
      : typeof value === 'number' || typeof value === 'boolean'
        ? String(value)
        : safeJson(value);
  const neutralized = FORMULA_TRIGGER.test(text) ? `'${text}` : text;
  return `"${neutralized.replace(/"/g, '""')}"`;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    // 循环引用等异常形态：导出不该因为一行数据整体失败。
    return String(value);
  }
}

/** 表头 + 数据行 → CSV 文本（不含 BOM，BOM 由 `downloadCsv` 负责）。 */
export function buildCsv(header: readonly string[], rows: readonly (readonly unknown[])[]): string {
  const lines = [header.map(csvCell).join(',')];
  for (const row of rows) {
    lines.push(row.map(csvCell).join(','));
  }
  return lines.join('\r\n');
}

/** 触发浏览器下载。加 BOM，让 Excel 按 UTF-8 识别中文。 */
export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/** 文件名时间戳（`2026-10-02T11-22-33`），冒号与点不适合直接进文件名。 */
export function csvFileStamp(now: Date = new Date()): string {
  return now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
}
