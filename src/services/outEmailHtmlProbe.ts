/**
 * 对外邮件正文的 HTML 标签探测（纯函数、零依赖，独立成文件便于单测）。
 *
 * 语义与原探测正则
 *   /<(?:[a-z][a-z0-9]*)(?:\s[^>]*)?\/?>|<\/[a-z][a-z0-9]*\s*>/i
 * 逐条对齐：识别「开标签」`<name ...>` / `<name .../>`（属性区不能含 `>`）
 * 与「闭标签」`</name ... >`，大小写不敏感。
 *
 * 为什么不再用正则：该正则的 `[^>]*` 后面必须跟 `>`，而正文完全由调用方提交。
 * 在不含 `>` 的长输入上（例如 `<a ` 重复 20 万次），每个候选起点都要把 `[^>]*`
 * 扫到串尾再回溯失败，整体退化成 O(n²)，被 CodeQL `js/polynomial-redos` 判为
 * 高危 DoS。下面的单遍扫描先用一次 `lastIndexOf(">")` 定界，任何标签都必须在该
 * 位置之前闭合，每个字符最多被看两次，耗时与输入长度成正比。
 */

/** 等价于 JS 正则的 `\s`（用 trim 判定，避免再引入一条正则）。 */
function isWhitespace(ch: string): boolean {
  return ch !== "" && ch.trim() === "";
}

function isAsciiLetter(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z");
}

function isAsciiAlnum(ch: string): boolean {
  return isAsciiLetter(ch) || (ch >= "0" && ch <= "9");
}

/**
 * 判定正文是否含 HTML 开标签或闭标签。
 *
 * 只有以 `>` 闭合的标签才算命中，所以最后一个 `>` 之后的 `<` 不可能成为标签起点，
 * 一次 `lastIndexOf(">")` 就能把绝大部分候选点排除掉。
 */
export function containsHtmlTag(raw: string): boolean {
  const lastGt = raw.lastIndexOf(">");
  let start = raw.indexOf("<");
  while (start >= 0 && start < lastGt) {
    let cursor = start + 1;
    const closing = raw.charAt(cursor) === "/";
    if (closing) cursor += 1;

    if (isAsciiLetter(raw.charAt(cursor))) {
      cursor += 1;
      while (isAsciiAlnum(raw.charAt(cursor))) cursor += 1;

      if (closing) {
        // `</name\s*>`：闭标签只允许名字后跟空白，再跟 `>`。
        while (isWhitespace(raw.charAt(cursor))) cursor += 1;
        if (raw.charAt(cursor) === ">") return true;
      } else if (raw.charAt(cursor) === ">") {
        // `<name>`
        return true;
      } else if (raw.charAt(cursor) === "/" && raw.charAt(cursor + 1) === ">") {
        // `<name/>`
        return true;
      } else if (isWhitespace(raw.charAt(cursor)) && cursor < lastGt) {
        // `<name ...>` / `<name .../>`：属性区是任意非 `>` 字符，直到下一个 `>` 闭合。
        // raw[cursor] 是空白（不可能是 `>`），所以 cursor < lastGt ⇔ 后面还有 `>`。
        return true;
      }
    }

    start = raw.indexOf("<", start + 1);
  }
  return false;
}
