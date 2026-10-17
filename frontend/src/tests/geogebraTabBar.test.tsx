import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import GeoGebraTabBar from "../components/geogebra/GeoGebraTabBar";

// 功能区标签是工作台的主要导航：键盘方向键必须能切换，且同一时刻只有一个 tab
// 进入 Tab 序列（roving tabindex），否则键盘用户要按很多次才能离开标签栏。
const TABS = [
  { id: "project", label: "项目与版本", badge: "2" },
  { id: "collab", label: "协作与分享" },
  { id: "tools", label: "参数与样式" },
];

function Harness() {
  const [value, setValue] = useState("project");
  return <GeoGebraTabBar tabs={TABS} value={value} onChange={setValue} ariaLabel="工作台功能区" />;
}

afterEach(() => cleanup());

describe("GeoGebraTabBar", () => {
  it("点击切换选中项并同步 aria-selected", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("tab", { name: /协作与分享/ }));
    expect(screen.getByRole("tab", { name: /协作与分享/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: /项目与版本/ })).toHaveAttribute("aria-selected", "false");
  });

  it("方向键 / Home / End 切换，并保持 roving tabindex", () => {
    render(<Harness />);
    fireEvent.keyDown(screen.getByRole("tab", { name: /项目与版本/ }), { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: /协作与分享/ })).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(screen.getByRole("tab", { name: /协作与分享/ }), { key: "End" });
    expect(screen.getByRole("tab", { name: /参数与样式/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: /参数与样式/ })).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("tab", { name: /项目与版本/ })).toHaveAttribute("tabindex", "-1");
    fireEvent.keyDown(screen.getByRole("tab", { name: /参数与样式/ }), { key: "Home" });
    expect(screen.getByRole("tab", { name: /项目与版本/ })).toHaveAttribute("aria-selected", "true");
  });
});
