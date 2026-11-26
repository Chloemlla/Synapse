// 位置式 XML 扫描器：只给出「这个标签从第几个字符到第几个字符」，不做 parse → stringify。
//
// 为什么不做 DOM/parse 再序列化（这是本方案最容易被质疑、也最需要写清楚的一条）：
//   word/document.xml 里有大量 `xml:space="preserve"`、自闭合标签（`<w:tcPr />`，注意 `/` 前有空格）、
//   命名空间前缀、`mc:Ignorable` 声明、属性顺序。任何一次 parse → stringify 往返都可能：
//     丢掉未使用命名空间声明（Word 会报「内容无法读取」）、把 `<w:tcPr />` 写成 `<w:tcPr/>`（合法但会让
//     逐字节对比失效）、重排属性（幂等性判据随之失效）。
//   所以这里只做「找一个标签的偏移，然后在偏移处插一段字符串」，原始字节一个不动。
//
// 深度配对而不是正则：`<w:tbl>` 可以嵌套（表格里套表格），非贪婪正则 `/<w:tbl>(.*?)<\/w:tbl>/`
// 会在内层 `</w:tbl>` 处提前闭合，于是「给所有表格加框线」会给外层表格加两遍、给内层加错位置。
// 这里的 elements() 用栈做真正的深度配对，嵌套表格天然正确。
//
// 已知取舍：不处理 `<!DOCTYPE ... [ ... ]>` 内部子集（docx 的 XML 里没有 DTD）。

export type TagKind = "open" | "close" | "self";

export interface Tag {
  name: string;
  kind: TagKind;
  /** 标签原文起点（`<` 的位置） */
  start: number;
  /** 标签原文终点（`>` 之后一位） */
  end: number;
  raw: string;
}

export interface Element {
  name: string;
  /** 开标签起点 */
  start: number;
  /** 整个元素（含闭标签）的终点；selfClosing 时等于 end */
  end: number;
  /** 开标签终点（`>` 之后一位）= 内容起点 */
  openEnd: number;
  /** 闭标签起点（内容终点）；selfClosing 时为 -1 */
  closeStart: number;
  selfClosing: boolean;
  /** 开标签原文（`<w:pPr ...>`），读属性时用它，不用再切一次字符串 */
  raw: string;
}

/**
 * 扫出所有标签。跳过注释、CDATA、`<?xml ?>` 声明与 `<!...>`，
 * 属性值里的 `>` 不会提前结束标签（按引号状态走）。
 */
export function scanTags(xml: string): Tag[] {
  const out: Tag[] = [];
  const n = xml.length;
  let i = 0;
  while (i < n) {
    const lt = xml.indexOf("<", i);
    if (lt < 0) break;
    if (xml.startsWith("<!--", lt)) {
      const close = xml.indexOf("-->", lt + 4);
      i = close < 0 ? n : close + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", lt)) {
      const close = xml.indexOf("]]>", lt + 9);
      i = close < 0 ? n : close + 3;
      continue;
    }
    const next = xml[lt + 1];
    if (next === "!" || next === "?") {
      const close = xml.indexOf(">", lt);
      if (close < 0) break;
      i = close + 1;
      continue;
    }
    // 找本标签的 '>'：属性值里的 '>' 不算
    let j = lt + 1;
    let quote = "";
    while (j < n) {
      const ch = xml[j];
      if (quote) {
        if (ch === quote) quote = "";
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === ">") {
        break;
      }
      j += 1;
    }
    if (j >= n) break;
    const raw = xml.slice(lt, j + 1);
    const kind: TagKind = raw.startsWith("</") ? "close" : raw.endsWith("/>") ? "self" : "open";
    const name = kind === "close" ? raw.slice(2, -1).trim() : (raw.slice(1).match(/^[^\s/>]+/) ?? [""])[0];
    if (name) out.push({ name, kind, start: lt, end: j + 1, raw });
    i = j + 1;
  }
  return out;
}

/** 深度配对出所有同名元素（含嵌套）。多余的闭标签忽略（XML 不配平由 C8 单独报）。 */
export function elements(xml: string, name: string): Element[] {
  const out: Element[] = [];
  const stack: number[] = [];
  for (const tag of scanTags(xml)) {
    if (tag.name !== name) continue;
    if (tag.kind === "self") {
      out.push({ name, start: tag.start, end: tag.end, openEnd: tag.end, closeStart: -1, selfClosing: true, raw: tag.raw });
    } else if (tag.kind === "open") {
      stack.push(out.length);
      out.push({ name, start: tag.start, end: -1, openEnd: tag.end, closeStart: -1, selfClosing: false, raw: tag.raw });
    } else {
      const index = stack.pop();
      if (index === undefined) continue;
      out[index].closeStart = tag.start;
      out[index].end = tag.end;
    }
  }
  return out.filter((el) => el.selfClosing || el.end > 0);
}

/** 偏移 start 之后（含）第一个同名元素；用于「外层元素被内层改动挤位移」时重新定位。 */
export function elementAfter(xml: string, name: string, start: number): Element | null {
  return elements(xml, name).find((el) => el.start >= start) ?? null;
}

/** 父元素的直接子标签（只下钻一层，深度用计数器维护）。 */
export function directChildTags(xml: string, parent: Element): Tag[] {
  if (parent.selfClosing || parent.closeStart < 0) return [];
  const out: Tag[] = [];
  let depth = 0;
  for (const tag of scanTags(xml)) {
    if (tag.start < parent.openEnd) continue;
    if (tag.start >= parent.closeStart) break;
    if (tag.kind === "close") {
      depth -= 1;
      continue;
    }
    if (depth === 0) out.push(tag);
    if (tag.kind === "open") depth += 1;
  }
  return out;
}

/**
 * 父元素的第一个同名**直接**子元素（返回带 span 的 Element，供 setChild 之类做「有就替换」）。
 * Tag 只带标签本身，插入/替换需要整个元素的 span，所以这里把两者接起来。
 */
export function firstDirectChildIn(xml: string, parent: Element, name: string): Element | null {
  const tag = directChildTags(xml, parent).find((item) => item.name === name);
  if (!tag) return null;
  return elements(xml, name).find((el) => el.start === tag.start) ?? null;
}

const ATTR_RE = /([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** 取开标签上的属性（键名必须写全前缀，如 `w:val`）。 */
export function attr(tagRaw: string, name: string): string | null {
  const all = attrs(tagRaw);
  return Object.prototype.hasOwnProperty.call(all, name) ? all[name] : null;
}

/** 忽略前缀取属性：`val` 能匹配到 `w:val`。用于 styleId/jc 这类「前缀由文档决定」的属性。 */
export function attrLocal(tagRaw: string, local: string): string | null {
  const all = attrs(tagRaw);
  if (Object.prototype.hasOwnProperty.call(all, local)) return all[local];
  for (const key of Object.keys(all)) {
    if (key.endsWith(`:${local}`)) return all[key];
  }
  return null;
}

export function attrs(tagRaw: string): Record<string, string> {
  const out: Record<string, string> = {};
  ATTR_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ATTR_RE.exec(tagRaw)) !== null) {
    out[match[1]] = match[2] !== undefined ? decodeEntities(match[2]) : decodeEntities(match[3] ?? "");
  }
  return out;
}

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

export function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) return String.fromCodePoint(parseInt(body.slice(2), 16));
    if (body.startsWith("#")) return String.fromCodePoint(parseInt(body.slice(1), 10));
    return NAMED[body] ?? whole;
  });
}

/** 元素的纯文本（拼所有子元素里的文本节点 `<w:t>`）。 */
export function textOf(xml: string, el: Element): string {
  if (el.selfClosing) return "";
  const body = xml.slice(el.openEnd, el.closeStart);
  let out = "";
  const re = /<[^>]*>/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) {
    if (match.index > last) out += body.slice(last, match.index);
    last = match.index + match[0].length;
  }
  if (last < body.length) out += body.slice(last);
  return decodeEntities(out);
}

/**
 * 元素主体（开标签之后到闭标签之前）。给「在一段范围里做正则」用，
 * 但注意：这里**只用于读取**（数属性/找子标签文本），回写一律走偏移插入。
 */
export function innerOf(xml: string, el: Element): string {
  return el.selfClosing ? "" : xml.slice(el.openEnd, el.closeStart);
}

/** 把自闭合元素展开成成对标签（`<w:tcPr />` → `<w:tcPr></w:tcPr>`），返回新字符串。 */
export function expandSelfClosing(xml: string, el: Element): string {
  if (!el.selfClosing) return xml;
  const raw = xml.slice(el.start, el.end);
  const opened = raw.replace(/\s*\/>$/, ">");
  return xml.slice(0, el.start) + opened + `</${el.name}>` + xml.slice(el.end);
}

/** XML 是否配平（栈按名字严格配对）。C8 用它判「改写没把文档写坏」。 */
export function isBalanced(xml: string): boolean {
  const stack: string[] = [];
  for (const tag of scanTags(xml)) {
    if (tag.kind === "self") continue;
    if (tag.kind === "open") {
      stack.push(tag.name);
    } else if (stack.pop() !== tag.name) {
      return false;
    }
  }
  return stack.length === 0;
}

/**
 * 批量编辑：edits 的偏移必须基于**同一份原文**，函数内部按偏移从大到小应用，
 * 因此「一次算出多处插入点再一起写」不会互相污染偏移。
 */
export function applyEdits(xml: string, edits: Array<{ at: number; remove?: number; text: string }>): string {
  const sorted = [...edits].sort((a, b) => b.at - a.at);
  let out = xml;
  for (const edit of sorted) {
    const remove = edit.remove ?? 0;
    out = out.slice(0, edit.at) + edit.text + out.slice(edit.at + remove);
  }
  return out;
}

/**
 * 在**同一份原文**上做「逐元素替换」的安全循环：元素按 start 倒序遍历。
 * 必须先处理靠后的元素，否则前面元素的改动会让后面元素的偏移全部失效。
 */
export function mapElementsReversed(
  xml: string,
  name: string,
  fn: (current: string, element: Element) => string,
): string {
  const list = elements(xml, name);
  let out = xml;
  for (let index = list.length - 1; index >= 0; index -= 1) {
    out = fn(out, list[index]);
  }
  return out;
}
