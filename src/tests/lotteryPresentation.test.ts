import { describe, expect, it } from "@jest/globals";
import { normalizePresentation } from "../services/lottery/presentation";

describe("lottery/presentation 无代码区块", () => {
  it("归一化合法区块并补齐 id", () => {
    const result = normalizePresentation({
      theme: "festival",
      rules: "每人每日 3 次",
      blocks: [{ type: "text", props: { text: "欢迎" } }, { id: "b2", type: "spacer" }],
    });

    expect(result).toMatchObject({ theme: "festival", rules: "每人每日 3 次" });
    expect(result?.blocks).toHaveLength(2);
    expect(result?.blocks[0]).toMatchObject({ type: "text", props: { text: "欢迎" } });
    expect(result?.blocks[1].id).toBe("b2");
  });

  it("非法类型 / 非数组 / 超量区块一律拒绝", () => {
    expect(normalizePresentation(null)).toBeNull();
    expect(normalizePresentation({ blocks: "x" })).toBeNull();
    expect(normalizePresentation({ blocks: [{ type: "iframe" }] })).toBeNull();
    expect(normalizePresentation({ blocks: Array.from({ length: 31 }, () => ({ type: "text" })) })).toBeNull();
  });

  it("props 过滤危险键与超长字符串", () => {
    const result = normalizePresentation({
      blocks: [{ type: "text", props: { text: "a".repeat(2000), $where: "x", "a.b": "y", count: 3 } }],
    });
    const props = result?.blocks[0].props ?? {};
    expect(String(props.text)).toHaveLength(1000);
    expect(props).not.toHaveProperty("$where");
    expect(props).not.toHaveProperty("a.b");
    expect(props.count).toBe(3);
  });
});
