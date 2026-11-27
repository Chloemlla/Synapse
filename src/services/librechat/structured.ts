/**
 * 结构化抽取通道(X2-02 ~ X2-06)——纯函数层,不发请求。
 *
 * 要解决的问题:模型被要求"只回 JSON"时,真实输出常见四种脏样 ——
 *  ① 前后带说明句;② 用 ```json 围栏包着;③ 键名跑偏/多给键;④ 类型漂移(把数组写成字符串、
 *  把 3 写成 "3.0")。仓库里现有两处内部服务各自 `text.match(/\{[\s\S]*\}/)` 现抓现用:
 *  那个贪婪匹配会把「JSON + 后面一段带花括号的废话」整段吞进来再解析失败,而解析失败在
 *  `qqGuardModerationService` 里的表现是**降级为"不违规"** —— 抽取层的形状问题会直接变成
 *  业务判定问题,所以这里收一份正确的实现,并让调用方拿得到「为什么不行」。
 *
 * 一条硬约束(G-06):失败要带稳定 `code` 与逐字段原因,**绝不返回编造的默认值**。
 */

export const STRUCTURED_FIELD_TYPES = ["string", "number", "boolean", "enum", "string[]"] as const;
export type StructuredFieldType = (typeof STRUCTURED_FIELD_TYPES)[number];

export interface StructuredFieldSpec {
  name: string;
  type: StructuredFieldType;
  required?: boolean;
  /** 出现在提示里,告诉模型这个字段到底要什么(写"做什么",不写实现术语)。 */
  description?: string;
  /** type === "enum" 时的合法取值。 */
  enumValues?: readonly string[];
  maxLen?: number;
  maxItems?: number;
  min?: number;
  max?: number;
}

export interface StructuredSpec {
  fields: readonly StructuredFieldSpec[];
  /** 单个字符串未写 `maxLen` 时的默认上限,防止模型把整段独白塞进一个字段。 */
  defaultMaxLen?: number;
}

export const STRUCTURED_DEFAULT_MAX_LEN = 500;
export const STRUCTURED_DEFAULT_MAX_ITEMS = 20;
export const STRUCTURED_REPAIR_PREVIOUS_BUDGET = 2000;

export type StructuredIssueCode =
  | "NO_JSON"
  | "UNBALANCED_JSON"
  | "INVALID_JSON"
  | "NOT_AN_OBJECT"
  | "EMPTY_OUTPUT"
  | "PARSE_FAILED"
  | "MISSING_FIELD"
  | "TYPE_MISMATCH"
  | "OUT_OF_ENUM"
  | "OUT_OF_RANGE"
  | "EMPTY_VALUE";

export type StructuredNoteCode = "UNKNOWN_FIELD" | "COERCED" | "TRUNCATED" | "DROPPED_ITEM";

export interface StructuredIssue {
  code: StructuredIssueCode;
  /** 归属字段;整份文档级问题(NO_JSON 等)时省略。 */
  field?: string;
  /** 面向人的一句话(会被拼进修复提示,也可能进管理端「详情」)。 */
  message: string;
}

export interface StructuredNote {
  code: StructuredNoteCode;
  field: string;
  message: string;
}

function specFields(spec: StructuredSpec): StructuredFieldSpec[] {
  return Array.isArray(spec?.fields) ? spec.fields.filter((f) => f && typeof f.name === "string" && f.name) : [];
}

export function fieldNames(spec: StructuredSpec): string[] {
  return specFields(spec).map((field) => field.name);
}

function maxLenOf(field: StructuredFieldSpec, spec: StructuredSpec): number {
  const raw = Number(field.maxLen);
  if (Number.isFinite(raw) && raw > 0) return Math.trunc(raw);
  const fallback = Number(spec?.defaultMaxLen);
  return Number.isFinite(fallback) && fallback > 0 ? Math.trunc(fallback) : STRUCTURED_DEFAULT_MAX_LEN;
}

function maxItemsOf(field: StructuredFieldSpec): number {
  const raw = Number(field.maxItems);
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : STRUCTURED_DEFAULT_MAX_ITEMS;
}

export type JsonObjectResult =
  | { ok: true; json: unknown; raw: string }
  | { ok: false; code: StructuredIssueCode; message: string };

/**
 * 从自由文本里取出**第一个完整的 JSON 对象**(X2-02)。
 *
 * 与贪婪正则的差别:括号深度扫描,且知道 `{` 出现在字符串里时不算数、`\"` 不算收尾引号。
 * 因此「先说一句人话,再给对象,后面再补一句带 `}` 的话」这种输出不会被整段吞掉。
 */
export function extractJsonObject(text: unknown): JsonObjectResult {
  const source = typeof text === "string" ? text : "";
  if (!source.trim()) return { ok: false, code: "NO_JSON", message: "没有可解析的内容" };

  const candidates: number[] = [];
  // 围栏里的对象优先:模型"补一段解释"时,JSON 通常在第一个 ``` 块里。
  const fenceRe = /```(?:json|JSON)?\s*([\s\S]*?)```/g;
  let fence: RegExpExecArray | null;
  while ((fence = fenceRe.exec(source))) {
    const start = source.indexOf(fence[1]);
    if (start >= 0 && fence[1].includes("{")) candidates.push(source.indexOf("{", start));
  }
  candidates.push(source.indexOf("{"));

  for (const start of candidates) {
    if (start < 0) continue;
    const slice = scanBalancedObject(source, start);
    if (!slice) continue;
    try {
      return { ok: true, json: JSON.parse(slice) as unknown, raw: slice };
    } catch {
      // 括号配平但语法非法(尾逗号、单引号)——继续找下一个起点,最后才定性。
      continue;
    }
  }
  return source.includes("{")
    ? { ok: false, code: "INVALID_JSON", message: "内容里有花括号,但不是合法的 JSON 对象" }
    : { ok: false, code: "NO_JSON", message: "没有找到 JSON 对象" };
}

/** 从 `start` 处的 `{` 扫到配对的 `}`;字符串字面量与转义按语义处理。 */
function scanBalancedObject(source: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function emptyish(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") {
    const trimmed = value.trim().toLowerCase();
    return !trimmed || ["null", "undefined", "unknown", "未知", "无法确定", "无"].includes(trimmed);
  }
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function cleanString(value: string, cap: number): { text: string; truncated: boolean } {
  // 折叠所有空白:模型的换行/缩进对下游没有意义,还会把枚举比较搞成永远不相等。
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > cap ? { text: text.slice(0, cap), truncated: true } : { text, truncated: false };
}

export interface StructuredValidation<T = Record<string, unknown>> {
  ok: boolean;
  value?: T;
  issues: StructuredIssue[];
  /** 类型纠正与裁剪清单:不是错误,但是"模型有多不听话"的可用信号(喂给 X4 评测)。 */
  notes: StructuredNote[];
  /** 被白名单挡掉的多余键(G-06:宁可丢,不猜)。 */
  droppedKeys: string[];
}

/** 按字段规格校验 + 收敛(X2-04)。未知键一律丢弃。 */
export function validateStructuredPayload(input: unknown, spec: StructuredSpec): StructuredValidation {
  const issues: StructuredIssue[] = [];
  const notes: StructuredNote[] = [];
  const droppedKeys: string[] = [];
  const parsed = isPlainObject(input) ? input : null;
  if (!parsed) {
    return {
      ok: false,
      issues: [{ code: "NOT_AN_OBJECT", message: "内容不是一个 JSON 对象" }],
      notes,
      droppedKeys,
    };
  }

  const fields = specFields(spec);
  const allowed = new Set(fields.map((field) => field.name));
  for (const key of Object.keys(parsed)) {
    if (!allowed.has(key)) droppedKeys.push(key);
  }

  const value: Record<string, unknown> = {};
  for (const field of fields) {
    const raw = parsed[field.name];
    if (emptyish(raw)) {
      if (field.required) {
        // 键写了但只有空白 → 「是空的」；键根本没给 / 写了「未知」这类占位 → 「缺少」。
        // 两者对使用者的修法不同（补一下 vs 这条通知里就没这个信息），不能都报成缺失。
        const present = Object.prototype.hasOwnProperty.call(parsed, field.name);
        const blank = present && (raw === null || (typeof raw === "string" && !raw.trim()));
        issues.push(
          blank
            ? { code: "EMPTY_VALUE", field: field.name, message: `「${field.name}」是空的` }
            : { code: "MISSING_FIELD", field: field.name, message: `缺少「${field.description || field.name}」` },
        );
      }
      continue;
    }

    switch (field.type) {
      case "string": {
        if (typeof raw !== "string") {
          issues.push({ code: "TYPE_MISMATCH", field: field.name, message: `「${field.name}」应是文字` });
          break;
        }
        const { text, truncated } = cleanString(raw, maxLenOf(field, spec));
        if (!text) {
          if (field.required) issues.push({ code: "EMPTY_VALUE", field: field.name, message: `「${field.name}」是空的` });
          break;
        }
        if (truncated) notes.push({ code: "TRUNCATED", field: field.name, message: `「${field.name}」过长,已截断` });
        value[field.name] = text;
        break;
      }
      case "number": {
        let num: number | null = null;
        let coerced = false;
        if (typeof raw === "number" && Number.isFinite(raw)) num = raw;
        else if (typeof raw === "string" && raw.trim() && Number.isFinite(Number(raw))) {
          num = Number(raw);
          coerced = true;
        }
        if (num === null) {
          issues.push({ code: "TYPE_MISMATCH", field: field.name, message: `「${field.name}」应是数字` });
          break;
        }
        const min = Number(field.min);
        const max = Number(field.max);
        if (Number.isFinite(min) && num < min) {
          issues.push({ code: "OUT_OF_RANGE", field: field.name, message: `「${field.name}」不能小于 ${min}` });
          break;
        }
        if (Number.isFinite(max) && num > max) {
          issues.push({ code: "OUT_OF_RANGE", field: field.name, message: `「${field.name}」不能大于 ${max}` });
          break;
        }
        if (coerced) notes.push({ code: "COERCED", field: field.name, message: `「${field.name}」按数字理解` });
        value[field.name] = num;
        break;
      }
      case "boolean": {
        if (typeof raw === "boolean") {
          value[field.name] = raw;
          break;
        }
        if (typeof raw === "string") {
          const lowered = raw.trim().toLowerCase();
          if (lowered === "true" || lowered === "是" || lowered === "yes") {
            value[field.name] = true;
            notes.push({ code: "COERCED", field: field.name, message: `「${field.name}」按是否理解` });
            break;
          }
          if (lowered === "false" || lowered === "否" || lowered === "no") {
            value[field.name] = false;
            notes.push({ code: "COERCED", field: field.name, message: `「${field.name}」按是否理解` });
            break;
          }
        }
        if (raw === 1 || raw === 0) {
          value[field.name] = raw === 1;
          notes.push({ code: "COERCED", field: field.name, message: `「${field.name}」按是否理解` });
          break;
        }
        issues.push({ code: "TYPE_MISMATCH", field: field.name, message: `「${field.name}」应是「是/否」` });
        break;
      }
      case "enum": {
        const allowedValues = (field.enumValues || []).map((v) => String(v));
        if (typeof raw !== "string") {
          issues.push({ code: "TYPE_MISMATCH", field: field.name, message: `「${field.name}」只能从给定选项里选` });
          break;
        }
        const { text } = cleanString(raw, maxLenOf(field, spec));
        const exact = allowedValues.find((candidate) => candidate === text);
        const loose = exact ?? allowedValues.find((candidate) => candidate.toLowerCase() === text.toLowerCase());
        if (loose === undefined) {
          issues.push({
            code: "OUT_OF_ENUM",
            field: field.name,
            message: `「${field.name}」只能是:${allowedValues.join(" / ")}`,
          });
          break;
        }
        if (loose !== exact) notes.push({ code: "COERCED", field: field.name, message: `「${field.name}」大小写已归一` });
        value[field.name] = loose;
        break;
      }
      case "string[]": {
        let items: unknown[];
        if (Array.isArray(raw)) items = raw;
        else if (typeof raw === "string") {
          items = raw.split(/\r?\n|,/);
          notes.push({ code: "COERCED", field: field.name, message: `「${field.name}」按多条理解` });
        } else {
          issues.push({ code: "TYPE_MISMATCH", field: field.name, message: `「${field.name}」应是一组文字` });
          break;
        }
        const cap = maxItemsOf(field);
        const list: string[] = [];
        let droppedItems = 0;
        let capped = false;
        for (const item of items) {
          if (typeof item !== "string") {
            droppedItems += 1;
            continue;
          }
          const { text: itemText } = cleanString(item, maxLenOf(field, spec));
          if (!itemText || list.includes(itemText)) continue;
          if (list.length >= cap) {
            capped = true;
            break;
          }
          list.push(itemText);
        }
        if (droppedItems) notes.push({ code: "DROPPED_ITEM", field: field.name, message: `「${field.name}」去掉了 ${droppedItems} 条不是文字的内容` });
        if (capped) notes.push({ code: "TRUNCATED", field: field.name, message: `「${field.name}」最多 ${cap} 条,已裁到 ${cap} 条` });
        if (!list.length) {
          if (field.required) issues.push({ code: "EMPTY_VALUE", field: field.name, message: `「${field.name}」没有可用内容` });
          break;
        }
        value[field.name] = list;
        break;
      }
      default: {
        issues.push({ code: "TYPE_MISMATCH", field: field.name, message: `「${field.name}」的字段定义无法识别` });
      }
    }
  }

  if (droppedKeys.length) {
    notes.push({ code: "UNKNOWN_FIELD", field: droppedKeys.join(","), message: `忽略了未在清单里的字段:${droppedKeys.join("、")}` });
  }
  return { ok: issues.length === 0, value, issues, notes, droppedKeys };
}

export function parseAndValidate(raw: unknown, spec: StructuredSpec): StructuredValidation {
  const extracted = extractJsonObject(raw);
  if (!extracted.ok) {
    return { ok: false, issues: [{ code: extracted.code, message: extracted.message }], notes: [], droppedKeys: [] };
  }
  return validateStructuredPayload(extracted.json, spec);
}

/**
 * 生成"只要 JSON"的系统提示(X2-05)。
 *
 * 「不确定就省略这个键」是刻意留的出口:没有它,模型会为了填满字段而编造,
 * 下游(X3-05 的逐字段多数)就再也分不清"没提到"和"瞎猜的"。
 */
export function buildStructuredSystemPrompt(base: string, spec: StructuredSpec): string {
  const fields = specFields(spec);
  const lines = fields.map((field) => {
    const bits = [`- ${field.name}: ${field.type}`];
    if (field.required) bits.push("必填");
    if (field.description) bits.push(field.description);
    if (field.type === "enum" && field.enumValues?.length) bits.push(`只能取:${field.enumValues.join(" / ")}`);
    const cap = maxLenOf(field, spec);
    if (field.type === "string" || field.type === "enum") bits.push(`不超过 ${cap} 字`);
    if (field.type === "string[]") bits.push(`不超过 ${maxItemsOf(field)} 条`);
    if (Number.isFinite(Number(field.min))) bits.push(`不小于 ${field.min}`);
    if (Number.isFinite(Number(field.max))) bits.push(`不大于 ${field.max}`);
    return bits.join(";");
  });
  const shape = `{${fields.map((field) => `"${field.name}":<${field.type}>`).join(",")}}`;
  return [
    base,
    "",
    "【输出要求】只输出一个 JSON 对象,不要输出任何其他文字,不要用代码块包裹。",
    `字段清单(不在清单里的键会被丢弃):\n${lines.join("\n")}`,
    `形如:${shape}`,
    "无法确定的字段请**直接省略该键**,不要猜测、不要填 null、不要写「未知」。",
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

/** 把校验问题翻成人话清单,供修复轮使用(X2-06)。 */
export function formatStructuredIssues(issues: readonly StructuredIssue[]): string[] {
  return issues.map((issue) => `- ${issue.field ? `字段 ${issue.field}:` : ""}${issue.message}`);
}

export function buildRepairPrompt(
  issues: readonly StructuredIssue[],
  spec: StructuredSpec,
  previousRaw?: unknown,
): string {
  const previous = typeof previousRaw === "string" ? previousRaw.trim() : "";
  const clipped = previous.length > STRUCTURED_REPAIR_PREVIOUS_BUDGET ? `${previous.slice(0, STRUCTURED_REPAIR_PREVIOUS_BUDGET)}…` : previous;
  const shape = `{${fieldNames(spec).map((name) => `"${name}":…`).join(",")}}`;
  return [
    "上一次的输出不符合要求,请修正后重新给出。",
    "需要修正的地方:",
    ...(formatStructuredIssues(issues).length ? formatStructuredIssues(issues) : ["- 无法解析成 JSON 对象"]),
    "",
    `只输出一个 JSON 对象(形如 ${shape}),不要任何解释、不要代码块。`,
    "仍然无法确定的字段请省略该键。",
    ...(clipped ? ["", "上一次输出的内容(可能已截断):", clipped] : []),
  ].join("\n");
}
