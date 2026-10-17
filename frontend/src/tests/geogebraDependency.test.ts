import { describe, expect, it } from "vitest";
import {
  buildGeoGebraDependencyTree,
  collectGeoGebraDependencies,
  formatGeoGebraDependencyTree,
} from "../components/geogebra/dependency";

// GEO-16：对象依赖解释除了 AI 文本，还要有一条本地推导、断网也可用的依赖关系。
const SCRIPT = [
  "A = (1, 2)",
  "B = (4, 6)",
  "s = Segment(A, B)",
  "M = Midpoint(s)",
  "c = Circle(M, 2)",
  "label = Text(\"圆的圆心\", M)",
].join("\n");

describe("GeoGebra dependency graph", () => {
  it("只把脚本里定义过的名字算作依赖，指令名不算", () => {
    const nodes = collectGeoGebraDependencies(SCRIPT);
    expect(nodes.get("s")?.dependencies).toEqual(["A", "B"]);
    expect(nodes.get("M")?.dependencies).toEqual(["s"]);
    // Segment / Midpoint / Circle / Text 是 GeoGebra 指令，不该出现在依赖里。
    expect(nodes.get("c")?.dependencies).toEqual(["M"]);
    expect(nodes.get("A")?.dependencies).toEqual([]);
  });

  it("按对象展开多层依赖树", () => {
    const tree = buildGeoGebraDependencyTree(SCRIPT, "c");
    expect(tree.root).toMatchObject({ name: "c", lineNumber: 5, defined: true });
    expect(tree.children.map((entry) => [entry.node.name, entry.depth])).toEqual([
      ["M", 1],
      ["s", 2],
      ["A", 3],
      ["B", 3],
    ]);
  });

  it("循环引用不会无限展开", () => {
    const tree = buildGeoGebraDependencyTree("a = b + 1\nb = a + 1", "a");
    expect(tree.children.map((entry) => [entry.node.name, entry.circular])).toEqual([["b", false], ["a", true]]);
  });

  it("画布对象没有顶层定义时明确标记，而不是假装依赖为空", () => {
    const tree = buildGeoGebraDependencyTree(SCRIPT, "p7");
    expect(tree.root.defined).toBe(false);
    expect(tree.children).toEqual([]);
    expect(formatGeoGebraDependencyTree(tree)).toContain("脚本里没有定义");
  });

  it("注释行与字符串里的名字不产生依赖", () => {
    const nodes = collectGeoGebraDependencies([
      "x0 = 1",
      "// y0 = x0",
      't = "x0"',
    ].join("\n"));
    expect(nodes.get("t")?.dependencies).toEqual([]);
  });
});
