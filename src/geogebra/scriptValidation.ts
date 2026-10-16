export const MAX_GEO_GEBRA_CODE_LENGTH = 50_000;
export const MAX_GEO_GEBRA_COMMANDS = 5_000;

const BRACKET_PAIRS: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
const DANGEROUS_PATTERNS = [/javascript\s*:/i, /<\s*script/i, /\beval\s*\(/i];

function bracketsMatch(value: string): boolean {
  const stack: string[] = [];
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (const character of value) {
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character in BRACKET_PAIRS) stack.push(character);
    else if (Object.values(BRACKET_PAIRS).includes(character)) {
      const open = stack.pop();
      if (!open || BRACKET_PAIRS[open] !== character) return false;
    }
  }
  return stack.length === 0 && quote === null;
}

export function validateGeoGebraCommands(input: unknown): string[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_GEO_GEBRA_COMMANDS) {
    throw new Error("分享脚本格式无效。");
  }
  const commands = input.map((command) => {
    if (typeof command !== "string") throw new Error("分享脚本格式无效。");
    const normalized = command.trim();
    if (!normalized || normalized.length > MAX_GEO_GEBRA_CODE_LENGTH) throw new Error("分享脚本格式无效。");
    if (DANGEROUS_PATTERNS.some((pattern) => pattern.test(normalized)) || !bracketsMatch(normalized)) {
      throw new Error("分享脚本包含无法处理的内容。");
    }
    return normalized;
  });
  if (commands.reduce((total, command) => total + command.length + 1, 0) > MAX_GEO_GEBRA_CODE_LENGTH) {
    throw new Error("分享脚本超过长度限制。");
  }
  return commands;
}

export function validateGeoGebraProjectCode(value: unknown): string {
  if (typeof value !== "string" || value.length > MAX_GEO_GEBRA_CODE_LENGTH) {
    throw new Error("脚本内容无效或超过长度限制。");
  }
  return value;
}
