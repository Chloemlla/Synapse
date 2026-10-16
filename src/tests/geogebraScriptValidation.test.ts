import { describe, expect, it } from "@jest/globals";
import { validateGeoGebraCommands } from "../geogebra/scriptValidation";

describe("GeoGebra public script validation", () => {
  it("accepts bounded GeoGebra commands and trims surrounding whitespace", () => {
    expect(validateGeoGebraCommands([" A = (0, 0) ", "line = Segment(A, B)"])).toEqual([
      "A = (0, 0)",
      "line = Segment(A, B)",
    ]);
  });

  it("rejects malformed commands and script-like input", () => {
    expect(() => validateGeoGebraCommands(["A = (0, 0"])).toThrow("无法处理");
    expect(() => validateGeoGebraCommands(["<script>alert(1)</script>"])).toThrow("无法处理");
    expect(() => validateGeoGebraCommands(["eval(1)"])).toThrow("无法处理");
  });

  it("rejects empty and oversized command sets", () => {
    expect(() => validateGeoGebraCommands([])).toThrow("格式无效");
    expect(() => validateGeoGebraCommands(Array.from({ length: 5_001 }, () => "A = (0, 0)"))).toThrow("格式无效");
  });
});
