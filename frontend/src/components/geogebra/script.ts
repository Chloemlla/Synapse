import type { GeoGebraMode } from "../../types/geogebra";

// 画布模式是领域类型，唯一定义在 types/geogebra.ts；此处重导出，保持既有 `from "./script"` 的引用。
export type { GeoGebraMode };

export const GEO_GEBRA_MAX_CODE_LENGTH = 50_000;
export const GEO_GEBRA_MAX_COMMANDS = 5_000;
export const GEO_GEBRA_MAX_EXECUTION_MS = 30_000;

// 预检阈值允许调用方覆盖：来源只给出行为基线，最终数值应由实测与运营决策调整，
// 而不是散落在多个调用点的硬编码常量。
export type GeoGebraScriptLimits = {
  maxCodeLength: number;
  maxCommands: number;
};

export type GeoGebraScalar = number | boolean | string;
export type GeoGebraControl = {
  name: string;
  lineNumber: number;
  type: "number" | "boolean" | "string";
  value: GeoGebraScalar;
  min?: number;
  max?: number;
  step?: number;
};
export type GeoGebraIssue = {
  lineNumber: number;
  message: string;
  command?: string;
};
export type GeoGebraPreparedScript = {
  commands: string[];
  errors: GeoGebraIssue[];
  warnings: GeoGebraIssue[];
  stats: {
    totalLines: number;
    commandLines: number;
    emptyLines: number;
    commentLines: number;
  };
};
export type GeoGebraPointState = { name: string; x: number; y: number };

const BRACKET_PAIRS: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
const DANGEROUS_PATTERNS = [
  /javascript\s*:/i,
  /<\s*script/i,
  /\bon\w+\s*=/i,
  /\beval\s*\(/i,
  /\bfunction\s*\(/i,
];
const RISKY_FUNCTIONS = ["Sequence", "Iteration", "RecursiveSequence"];
const IDENTIFIER = /^[_\p{L}][_\p{L}\p{N}'’]*$/u;
const ASSIGNMENT_TARGET = /^(?<name>[_\p{L}][_\p{L}\p{N}'’]*)(?:\s*\((?<params>[^()]*)\))?$/u;
const NUMBER_VALUE = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
const BOOLEAN_VALUE = /^(true|false)$/i;

function stripLineComment(line: string): string {
  let quote: '"' | null = null;
  let escaped = false;

  for (let index = 0; index < line.length - 1; index += 1) {
    const character = line[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '"') {
      quote = character;
      continue;
    }
    if (character === "/" && line[index + 1] === "/") return line.slice(0, index);
  }

  return line;
}

export function extractTopLevelAssignment(command: string): { left: string; right: string } | null {
  let depth = 0;
  let quote: '"' | null = null;
  let escaped = false;
  let assignmentIndex = -1;

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '"') {
      quote = character;
      continue;
    }
    if (character === "(" || character === "[" || character === "{") {
      depth += 1;
      continue;
    }
    if (character === ")" || character === "]" || character === "}") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (character === "=" && depth === 0) {
      const previous = command[index - 1] ?? "";
      const next = command[index + 1] ?? "";
      if (previous === "=" || previous === "<" || previous === ">" || previous === "!" || next === "=") {
        continue;
      }
      if (assignmentIndex >= 0) return null;
      assignmentIndex = index;
    }
  }

  if (assignmentIndex < 0) return null;
  return {
    left: command.slice(0, assignmentIndex).trim(),
    right: command.slice(assignmentIndex + 1).trim(),
  };
}

function parseAssignmentTarget(value: string): { name: string; params: string[] } | null {
  const match = value.trim().match(ASSIGNMENT_TARGET);
  const name = match?.groups?.name;
  if (!name || !IDENTIFIER.test(name)) return null;
  const params = match.groups?.params
    ? match.groups.params.split(",").map((item) => item.trim()).filter(Boolean)
    : [];
  if (params.some((item) => !IDENTIFIER.test(item))) return null;
  return { name, params };
}

function bracketsMatch(command: string): boolean {
  const stack: string[] = [];
  let quote: '"' | null = null;
  let escaped = false;

  for (const character of command) {
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"') {
      quote = character;
    } else if (character in BRACKET_PAIRS) {
      stack.push(character);
    } else if (Object.values(BRACKET_PAIRS).includes(character)) {
      const open = stack.pop();
      if (!open || BRACKET_PAIRS[open] !== character) return false;
    }
  }
  return stack.length === 0 && quote === null;
}

function maxNestingDepth(command: string): number {
  let depth = 0;
  let maximum = 0;
  let quote: '"' | null = null;
  let escaped = false;
  for (const character of command) {
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"') quote = character;
    else if (character === "(" || character === "[" || character === "{") {
      depth += 1;
      maximum = Math.max(maximum, depth);
    } else if (character === ")" || character === "]" || character === "}") {
      depth = Math.max(0, depth - 1);
    }
  }
  return maximum;
}

export function prepareGeoGebraScript(source: string, limits?: GeoGebraScriptLimits): GeoGebraPreparedScript {
  const input = typeof source === "string" ? source : "";
  const maxCodeLength = limits?.maxCodeLength ?? GEO_GEBRA_MAX_CODE_LENGTH;
  const maxCommands = limits?.maxCommands ?? GEO_GEBRA_MAX_COMMANDS;
  const lines = input.split("\n");
  const commands: string[] = [];
  const errors: GeoGebraIssue[] = [];
  const warnings: GeoGebraIssue[] = [];

  if (input.length > maxCodeLength) {
    errors.push({ lineNumber: 1, message: `脚本超过 ${maxCodeLength} 字符限制。` });
  }

  lines.forEach((line, index) => {
    const cleaned = stripLineComment(line).trim();
    if (!cleaned) return;
    const lineNumber = index + 1;
    commands.push(cleaned);

    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.test(cleaned)) {
        errors.push({ lineNumber, message: "脚本包含不允许的内容。", command: cleaned });
        break;
      }
    }
    if (!bracketsMatch(cleaned)) {
      errors.push({ lineNumber, message: "括号或引号不匹配。", command: cleaned });
    }
    const assignment = extractTopLevelAssignment(cleaned);
    if (assignment) {
      const target = parseAssignmentTarget(assignment.left);
      if (!target || !assignment.right) {
        errors.push({ lineNumber, message: "赋值语句格式不正确。", command: cleaned });
      }
    }
    for (const functionName of RISKY_FUNCTIONS) {
      if (new RegExp(`\\b${functionName}\\s*\\(`, "i").test(cleaned)) {
        warnings.push({ lineNumber, message: `复杂迭代 ${functionName} 可能影响运行时间。`, command: cleaned });
      }
    }
    if (maxNestingDepth(cleaned) > 12) {
      warnings.push({ lineNumber, message: "表达式嵌套较深，请确认脚本可及时完成。", command: cleaned });
    }
  });

  if (commands.length > maxCommands) {
    errors.push({ lineNumber: lines.length, message: `脚本超过 ${maxCommands} 条指令限制。` });
  }

  return {
    commands,
    errors,
    warnings,
    stats: {
      totalLines: lines.length,
      commandLines: commands.length,
      emptyLines: lines.filter((line) => line.trim() === "").length,
      commentLines: lines.filter((line) => line.trim().startsWith("//")).length,
    },
  };
}

export function extractGeoGebraControls(source: string): GeoGebraControl[] {
  const prepared = prepareGeoGebraScript(source);
  if (prepared.errors.length > 0) return [];

  return prepared.commands.flatMap((command, index): GeoGebraControl[] => {
    const assignment = extractTopLevelAssignment(command);
    if (!assignment) return [];
    const target = parseAssignmentTarget(assignment.left);
    if (!target || target.params.length > 0) return [];
    const value = assignment.right;
    if (NUMBER_VALUE.test(value)) {
      const number = Number(value);
      const range = Math.max(Math.abs(number), 1) * 4;
      return [{
        name: target.name,
        lineNumber: index + 1,
        type: "number" as const,
        value: number,
        min: Number((number - range).toFixed(2)),
        max: Number((number + range).toFixed(2)),
        step: Math.abs(number) < 1 ? 0.1 : Math.abs(number) < 10 ? 0.5 : 1,
      }];
    }
    if (BOOLEAN_VALUE.test(value)) {
      return [{ name: target.name, lineNumber: index + 1, type: "boolean" as const, value: value.toLowerCase() === "true" }];
    }
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      try {
        const parsed: unknown = JSON.parse(value);
        if (typeof parsed === "string") {
          return [{ name: target.name, lineNumber: index + 1, type: "string" as const, value: parsed }];
        }
      } catch {
        return [];
      }
    }
    return [];
  });
}

export function formatGeoGebraScalar(value: GeoGebraScalar): string {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("参数必须是有限数字。");
    const rounded = Number(value.toFixed(6));
    return Object.is(rounded, -0) ? "0" : String(rounded);
  }
  return typeof value === "boolean" ? String(value) : JSON.stringify(value);
}

export function replaceGeoGebraAssignment(source: string, name: string, value: GeoGebraScalar): string {
  if (!IDENTIFIER.test(name)) return source;
  const formatted = formatGeoGebraScalar(value);
  const target = new RegExp(`^(\\s*)${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=\\s*(.+?)(\\s*//.*)?$`);
  return source.split("\n").map((line) => {
    const match = line.match(target);
    return match ? `${match[1]}${name} = ${formatted}${match[3] ?? ""}` : line;
  }).join("\n");
}

function formatCoordinate(value: number): string {
  if (!Number.isFinite(value)) throw new Error("自由点坐标无效。");
  const rounded = Number(value.toFixed(6));
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

export function mergeFreePointStates(source: string, points: GeoGebraPointState[]): string {
  if (!points.length) return source;
  const replacements = new Map<string, string>();
  for (const point of points) {
    if (!IDENTIFIER.test(point.name)) continue;
    replacements.set(point.name, `${point.name} = (${formatCoordinate(point.x)}, ${formatCoordinate(point.y)})`);
  }
  const lines = source.split("\n");
  const matched = new Set<string>();
  const updated = lines.map((line) => {
    for (const [name, command] of replacements) {
      const pattern = new RegExp(`^(\\s*)${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=\\s*\\(([^()]*)\\)(\\s*//.*)?$`);
      const match = line.match(pattern);
      if (!match) continue;
      matched.add(name);
      return `${match[1]}${command}${match[3] ? ` ${match[3].trimStart()}` : ""}`;
    }
    return line;
  });
  const appended = [...replacements.entries()].filter(([name]) => !matched.has(name)).map(([, command]) => command);
  if (!appended.length) return updated.join("\n");
  const base = updated.join("\n").trimEnd();
  return `${base}${base ? "\n\n" : ""}// 从画布同步的自由点\n${appended.join("\n")}`;
}

export function summarizeGeoGebraDiff(before: string, after: string) {
  const oldLines = before.split("\n");
  const newLines = after.split("\n");
  const samples: Array<{ lineNumber: number; before: string | null; after: string | null }> = [];
  let changedLines = 0;
  let addedLines = 0;
  let removedLines = 0;
  for (let index = 0; index < Math.max(oldLines.length, newLines.length); index += 1) {
    const previous = oldLines[index] ?? null;
    const next = newLines[index] ?? null;
    if (previous === next) continue;
    if (previous === null) addedLines += 1;
    else if (next === null) removedLines += 1;
    else changedLines += 1;
    if (samples.length < 5) samples.push({ lineNumber: index + 1, before: previous, after: next });
  }
  return { beforeLineCount: oldLines.length, afterLineCount: newLines.length, changedLines, addedLines, removedLines, samples };
}

export type GeoGebraVariableDefinition = {
  name: string;
  lineNumber: number;
  kind: "value" | "function";
  usedAtLines: number[];
};

export type GeoGebraVariableReport = {
  definitions: GeoGebraVariableDefinition[];
  unusedNames: string[];
  undefinedNames: string[];
  duplicateNames: string[];
  stats: { definitions: number; references: number; unused: number; undefined: number; duplicates: number };
};

// 只把确属用户变量的名字当变量：内建常量、GeoGebra 指令调用（Cmd(...)）与函数形参都不算，
// 否则报告会被一堆假阳性的“未定义”淹没，用户反而不再看它。
const GEO_GEBRA_BUILTIN_NAMES = new Set(["pi", "e", "true", "false", "x", "y", "z"]);
const IDENTIFIER_SCAN = /[_\p{L}][_\p{L}\p{N}’']*/gu;

export function analyzeGeoGebraVariables(source: string): GeoGebraVariableReport {
  const lines = (typeof source === "string" ? source : "").split("\n");
  type RawDefinition = { name: string; lineNumber: number; kind: "value" | "function"; params: string[] };
  const parsed: Array<{ lineNumber: number; body: string; definition: RawDefinition | null }> = [];
  const rawDefinitions: RawDefinition[] = [];

  lines.forEach((line, index) => {
    const cleaned = stripLineComment(line).trim();
    if (!cleaned) return;
    const lineNumber = index + 1;
    const assignment = extractTopLevelAssignment(cleaned);
    const target = assignment ? parseAssignmentTarget(assignment.left) : null;
    const definition: RawDefinition | null = target && assignment
      ? { name: target.name, lineNumber, kind: target.params.length ? "function" : "value", params: target.params }
      : null;
    if (definition) rawDefinitions.push(definition);
    parsed.push({ lineNumber, body: assignment ? assignment.right : cleaned, definition });
  });

  const definedNames = new Set(rawDefinitions.map((item) => item.name));
  const references = new Map<string, number[]>();
  for (const entry of parsed) {
    const seen = new Set<string>();
    for (const match of entry.body.matchAll(IDENTIFIER_SCAN)) {
      const name = match[0];
      if (GEO_GEBRA_BUILTIN_NAMES.has(name) || seen.has(name)) continue;
      if (entry.definition?.name === name) continue;
      if (entry.definition?.kind === "function" && entry.definition.params.includes(name)) continue;
      const trailing = entry.body.slice((match.index ?? 0) + name.length);
      // 后面紧跟左括号且不是本地定义的名字 ⇒ 内建指令或未知函数调用，不计为用户变量引用。
      if (/^\s*\(/.test(trailing) && !definedNames.has(name)) continue;
      seen.add(name);
      references.set(name, [...(references.get(name) ?? []), entry.lineNumber]);
    }
  }

  const definitions: GeoGebraVariableDefinition[] = rawDefinitions.map((item) => ({
    name: item.name,
    lineNumber: item.lineNumber,
    kind: item.kind,
    usedAtLines: (references.get(item.name) ?? []).filter((lineNumber) => lineNumber !== item.lineNumber),
  }));
  const duplicateNames = [...definedNames].filter((name) => rawDefinitions.filter((item) => item.name === name).length > 1);
  const undefinedNames = [...references.keys()].filter((name) => !definedNames.has(name));
  // “未使用”按名字判定：同名被多次定义时，只要任意一处被引用就不算未使用，
  // 否则 `a = 1 / a = 5 / b = a + 2` 这种常见写法会误报。
  const definitionLines = new Map<string, Set<number>>();
  for (const item of rawDefinitions) {
    definitionLines.set(item.name, new Set([...(definitionLines.get(item.name) ?? []), item.lineNumber]));
  }
  const unusedNames = [...definedNames].filter((name) =>
    (references.get(name) ?? []).every((lineNumber) => definitionLines.get(name)?.has(lineNumber) === true));
  const referenceCount = [...references.values()].reduce((total, list) => total + list.length, 0);

  return {
    definitions,
    unusedNames,
    undefinedNames,
    duplicateNames,
    stats: {
      definitions: definitions.length,
      references: referenceCount,
      unused: unusedNames.length,
      undefined: undefinedNames.length,
      duplicates: duplicateNames.length,
    },
  };
}

// 把“画布拖动后的点”与“脚本里的原定义”放在一起，用户才能判断这次改动到底改了什么，
// 否则只能看到对象名（GEO-06 要求展示原/新指令）。
export function describeGeoGebraPointChanges(
  source: string,
  points: GeoGebraPointState[],
): Array<{ name: string; before: string | null; after: string }> {
  const definitions = new Map<string, string>();
  (typeof source === "string" ? source : "").split("\n").forEach((line) => {
    const cleaned = stripLineComment(line).trim();
    const assignment = extractTopLevelAssignment(cleaned);
    if (!assignment) return;
    const target = parseAssignmentTarget(assignment.left);
    if (target && target.params.length === 0) definitions.set(target.name, cleaned);
  });
  return points.filter((point) => IDENTIFIER.test(point.name)).map((point) => ({
    name: point.name,
    before: definitions.get(point.name) ?? null,
    after: `${point.name} = (${formatCoordinate(point.x)}, ${formatCoordinate(point.y)})`,
  }));
}
