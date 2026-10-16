import { describe, expect, it } from "vitest";
import {
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
});
