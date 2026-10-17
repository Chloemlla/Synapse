import { extractTopLevelAssignment } from "./script";

// 对象依赖的本地视图（GEO-16）。
//
// AI 的「对象依赖解释」给的是文字说明，但用户更常问的是「这个对象到底依赖谁」——
// 这件事不必调用模型：脚本里的顶层赋值已经把依赖写死了。这里用与预检同一套
// 行解析（strip 注释、顶层赋值、函数形参排除）推出一棵确定性的依赖树，
// 断网或 AI 未配置时也能用，且与 AI 的解释互相印证。
//
// 刻意不把 GeoGebra 指令名（`Midpoint(`、`Segment(`）当依赖：它们后面紧跟括号，
// 与变量同名时会先按「已定义名字」判定，避免把内建指令画进依赖图。

const IDENTIFIER_SCAN = /[_\p{L}][_\p{L}\p{N}’']*/gu;
const BUILTINS = new Set(["pi", "e", "true", "false", "x", "y", "z"]);

export type GeoGebraDependencyNode = {
  name: string;
  lineNumber: number | null;
  /** 该对象直接引用的其它用户对象（保持脚本出现顺序）。 */
  dependencies: string[];
  /** 是否在脚本里找到定义；画布对象可能是 GeoGebra 自动命名的辅助对象。 */
  defined: boolean;
};

export type GeoGebraDependencyTree = {
  root: GeoGebraDependencyNode;
  /** 深度优先展开，最多 maxDepth 层；重复出现的对象标记为 circular 不再展开。 */
  children: Array<{ node: GeoGebraDependencyNode; depth: number; circular: boolean }>;
  missing: string[];
};

function stripLineComment(line: string): string {
  let quote: string | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === "/" && line[index + 1] === "/") return line.slice(0, index);
  }
  return line;
}

/** 字符串字面量里的名字不是引用：只扫代码部分，避免 "x0" 被当成依赖。 */
function stripStrings(value: string): string {
  let output = "";
  let quote: string | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (character === "\\") {
        output += "  ";
        index += 1;
        continue;
      }
      if (character === quote) quote = null;
      output += " ";
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      output += " ";
      continue;
    }
    output += character;
  }
  return output;
}

function parseTarget(left: string): { name: string; params: string[] } | null {
  const match = /^([_\p{L}][_\p{L}\p{N}'’]*)(?:\s*\(([^()]*)\))?$/u.exec(left.trim());
  if (!match) return null;
  const params = (match[2] ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  return { name: match[1], params };
}

/** 解析整份脚本的顶层定义与直接依赖；返回 name → 节点。 */
export function collectGeoGebraDependencies(source: string): Map<string, GeoGebraDependencyNode> {
  const lines = (typeof source === "string" ? source : "").split("\n");
  const parsed = lines
    .map((line, index) => {
      const cleaned = stripLineComment(line).trim();
      const assignment = cleaned ? extractTopLevelAssignment(cleaned) : null;
      if (!assignment) return null;
      const target = parseTarget(assignment.left);
      return target ? { target, right: assignment.right, lineNumber: index + 1 } : null;
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  const definedNames = new Set(parsed.map((entry) => entry.target.name));
  const nodes = new Map<string, GeoGebraDependencyNode>();
  for (const entry of parsed) {
    const dependencies: string[] = [];
    const seen = new Set<string>();
    for (const match of stripStrings(entry.right).matchAll(IDENTIFIER_SCAN)) {
      const name = match[0];
      if (BUILTINS.has(name) || seen.has(name) || name === entry.target.name) continue;
      if (entry.target.params.includes(name)) continue;
      if (!definedNames.has(name)) continue;
      seen.add(name);
      dependencies.push(name);
    }
    // 同名多次定义时保留最后一次定义：依赖树要反映「当前脚本实际生效的那一条」。
    nodes.set(entry.target.name, {
      name: entry.target.name,
      lineNumber: entry.lineNumber,
      dependencies,
      defined: true,
    });
  }
  return nodes;
}

/** 以某个对象为根展开依赖树；画布对象没定义时返回空树 + missing 提示。 */
export function buildGeoGebraDependencyTree(
  source: string,
  rootName: string,
  maxDepth = 6,
): GeoGebraDependencyTree {
  const nodes = collectGeoGebraDependencies(source);
  const root = nodes.get(rootName) ?? {
    name: rootName,
    lineNumber: null,
    dependencies: [],
    defined: false,
  };
  const children: GeoGebraDependencyTree["children"] = [];
  const missing: string[] = [];
  const visited = new Set<string>([rootName]);

  const walk = (name: string, depth: number) => {
    if (depth > maxDepth) return;
    const node = nodes.get(name);
    if (!node) return;
    for (const child of node.dependencies) {
      const circular = visited.has(child);
      const childNode = nodes.get(child);
      if (!childNode) {
        if (!missing.includes(child)) missing.push(child);
        continue;
      }
      children.push({ node: childNode, depth, circular });
      if (circular) continue;
      visited.add(child);
      walk(child, depth + 1);
    }
  };
  walk(rootName, 1);
  return { root, children, missing };
}

/** 把依赖树压成可读文本（用于复制或降级展示）。 */
export function formatGeoGebraDependencyTree(tree: GeoGebraDependencyTree): string {
  const lines: string[] = [];
  lines.push(`${tree.root.name}${tree.root.lineNumber ? `（第 ${tree.root.lineNumber} 行）` : "（脚本里没有定义）"}`);
  for (const entry of tree.children) {
    lines.push(`${"  ".repeat(entry.depth)}- ${entry.node.name}${entry.circular ? "（已在上层出现）" : ""}`);
  }
  if (tree.missing.length) lines.push(`未找到定义：${tree.missing.join("、")}`);
  return lines.join("\n");
}
