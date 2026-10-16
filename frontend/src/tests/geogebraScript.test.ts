import { describe, expect, it } from "vitest";
import {
  analyzeGeoGebraVariables,
  describeGeoGebraPointChanges,
  extractGeoGebraControls,
  mergeFreePointStates,
  prepareGeoGebraScript,
  replaceGeoGebraAssignment,
  summarizeGeoGebraDiff,
} from "../components/geogebra/script";

describe("GeoGebra script helpers", () => {
  it("removes comments outside strings and keeps quoted slashes", () => {
    const result = prepareGeoGebraScript('url = "https://example.test/a//b" // note\n// comment\nA = (1, 2)');
    expect(result.commands).toEqual(['url = "https://example.test/a//b"', "A = (1, 2)"]);
    expect(result.errors).toEqual([]);
    expect(result.stats.commentLines).toBe(1);
  });

  it("rejects invalid brackets and executable-looking content", () => {
    expect(prepareGeoGebraScript("A = (1, 2").errors[0]?.message).toContain("括号");
    expect(prepareGeoGebraScript("x = eval(1)").errors).toHaveLength(1);
  });

  it("extracts only simple scalar controls", () => {
    const controls = extractGeoGebraControls([
      "slider = 2.5",
      "enabled = true",
      'caption = "triangle"',
      "f(x) = x^2",
    ].join("\n"));
    expect(controls.map(({ name, type }) => [name, type])).toEqual([
      ["slider", "number"],
      ["enabled", "boolean"],
      ["caption", "string"],
    ]);
  });

  it("replaces a scalar value without dropping an inline comment", () => {
    expect(replaceGeoGebraAssignment("a = 1 // radius", "a", 2.25)).toBe("a = 2.25 // radius");
  });

  it("syncs only supplied free points and appends new definitions", () => {
    const result = mergeFreePointStates("A = (0, 0) // origin\nB = (2, 0)", [
      { name: "A", x: 1.25, y: 3 },
      { name: "C", x: -2, y: 4.5 },
    ]);
    expect(result).toContain("A = (1.25, 3) // origin");
    expect(result).toContain("B = (2, 0)");
    expect(result).toContain("C = (-2, 4.5)");
  });

  it("summarizes line changes with bounded samples", () => {
    expect(summarizeGeoGebraDiff("A = 1\nB = 2", "A = 1\nB = 3\nC = 4")).toMatchObject({
      changedLines: 1,
      addedLines: 1,
      removedLines: 0,
      samples: [{ lineNumber: 2, before: "B = 2", after: "B = 3" }, { lineNumber: 3, before: null, after: "C = 4" }],
    });
  });

  it("honours overridden precheck limits instead of hard-coded thresholds", () => {
    const tight = prepareGeoGebraScript("A = (0, 0)\nB = (1, 1)", { maxCodeLength: 8, maxCommands: 1 });
    expect(tight.errors.map((item) => item.message)).toEqual([
      "脚本超过 8 字符限制。",
      "脚本超过 1 条指令限制。",
    ]);
    expect(prepareGeoGebraScript("A = (0, 0)").errors).toEqual([]);
  });

  it("reports defined, referenced, unused, undefined and duplicated variables", () => {
    const report = analyzeGeoGebraVariables([
      "a = 1",
      "b = a + 2",
      "unused = 4",
      "c = missing + 1",
      "a = 5",
      "f(x) = x^2",
      "g = f(3)",
      "p = Polygon((0, 0), (1, 1), (2, 2))",
    ].join("\n"));
    expect(report.undefinedNames).toEqual(["missing"]);
    expect(report.unusedNames).toEqual(["b", "unused", "g", "p"]);
    expect(report.duplicateNames).toEqual(["a"]);
    expect(report.stats.definitions).toBe(7);
    expect(report.definitions.filter((item) => item.name === "a")).toEqual([
      { name: "a", lineNumber: 1, kind: "value", usedAtLines: [2] },
      { name: "a", lineNumber: 5, kind: "value", usedAtLines: [2] },
    ]);
    expect(report.definitions.find((item) => item.name === "f")).toMatchObject({ lineNumber: 6, kind: "function", usedAtLines: [7] });
    // 内建指令 Polygon( 不是用户变量引用。
    expect(report.undefinedNames).not.toContain("Polygon");
  });

  it("describes moved points against the current script text", () => {
    const changes = describeGeoGebraPointChanges("A = (0, 0) // origin\nB = (2, 0)", [
      { name: "A", x: 1.5, y: 3 },
      { name: "C", x: -2, y: 4.5 },
    ]);
    expect(changes).toEqual([
      { name: "A", before: "A = (0, 0) // origin", after: "A = (1.5, 3)" },
      { name: "C", before: null, after: "C = (-2, 4.5)" },
    ]);
  });
});
