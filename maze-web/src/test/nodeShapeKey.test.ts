import { describe, it, expect } from "vitest";
import { parseNodeShapeKey } from "../pixi/nodeShapeKey";

describe("parseNodeShapeKey", () => {
  it("parses every key family", () => {
    expect(parseNodeShapeKey("dead_end")).toEqual({ type: "dead_end" });
    expect(parseNodeShapeKey("straight")).toEqual({ type: "straight" });
    expect(parseNodeShapeKey("turn_120")).toEqual({ type: "turn", angle: 120 });
    expect(parseNodeShapeKey("junction_6_0-1-3")).toEqual({ type: "junction", degree: 3, ranks: [0, 1, 3] });
    expect(parseNodeShapeKey("junction_5")).toEqual({ type: "junction", degree: 5, ranks: null });
  });

  it("takes a junction's degree from its ranks, not from its side count", () => {
    expect(parseNodeShapeKey("junction_12_0-2-4-6")?.type === "junction" && parseNodeShapeKey("junction_12_0-2-4-6")).toMatchObject({ degree: 4 });
  });

  it("rejects an unknown or malformed key", () => {
    for (const key of ["mystery", "turn_", "turn_x", "junction_", "junction_6_", "junction_6_a-b", ""]) {
      expect(parseNodeShapeKey(key)).toBeNull();
    }
  });
});
