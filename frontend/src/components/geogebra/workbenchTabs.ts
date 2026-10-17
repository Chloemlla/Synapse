// GeoGebra 工作台下方功能区（项目/协作/工具/AI/讲解）的标签定义。
// 单独成文件是给页面减负，也让「URL ?tab= 的合法值」有一处可测的真相源：
// 未知值一律回落到 project，避免深链被一个拼错的参数带到空白面板。
export const GEOGEBRA_WORKBENCH_TABS = ["project", "collab", "tools", "ai", "learn"] as const;
export type GeoGebraWorkbenchTabId = (typeof GEOGEBRA_WORKBENCH_TABS)[number];

export function resolveGeoGebraWorkbenchTab(value: string | null | undefined): GeoGebraWorkbenchTabId {
  return (GEOGEBRA_WORKBENCH_TABS as readonly string[]).includes(value ?? "")
    ? value as GeoGebraWorkbenchTabId
    : "project";
}
