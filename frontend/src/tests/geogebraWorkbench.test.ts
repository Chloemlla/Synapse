import { describe, expect, it } from "vitest";
import { GEOGEBRA_WORKBENCH_TABS, resolveGeoGebraWorkbenchTab } from "../components/geogebra/workbenchTabs";

// ?tab= 深链只接受已知值；拼错或注入的值一律回到「项目与版本」，
// 避免页面落到一个没有内容的空面板。
describe("GeoGebra workbench tabs", () => {
  it("接受全部合法标签", () => {
    for (const tab of GEOGEBRA_WORKBENCH_TABS) {
      expect(resolveGeoGebraWorkbenchTab(tab)).toBe(tab);
    }
  });

  it("未知值、空值与大小写不匹配回落 project", () => {
    expect(resolveGeoGebraWorkbenchTab(null)).toBe("project");
    expect(resolveGeoGebraWorkbenchTab(undefined)).toBe("project");
    expect(resolveGeoGebraWorkbenchTab("")).toBe("project");
    expect(resolveGeoGebraWorkbenchTab("../../admin")).toBe("project");
    expect(resolveGeoGebraWorkbenchTab("AI")).toBe("project");
  });
});
