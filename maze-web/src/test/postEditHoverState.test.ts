import { describe, expect, it } from "vitest";
import { emptyPostEditHoverState, shouldClearPostEditHover } from "../pixi/postEditHoverState";

const base = {
  postEditTool: "reset",
  activeFloorId: "floor-1",
  nodes: {},
  edges: {},
};

describe("post-edit hover invalidation", () => {
  it("keeps hover valid when only the draft changes", () => {
    expect(shouldClearPostEditHover(base, base)).toBe(false);
  });

  it("clears hover when the active tool changes", () => {
    expect(shouldClearPostEditHover({ ...base, postEditTool: "delete" }, base)).toBe(true);
  });

  it("keeps hover when Reset/Delete replace the derived graph", () => {
    expect(shouldClearPostEditHover({ ...base, nodes: {}, edges: {} }, { ...base, nodes: [], edges: [] })).toBe(false);
  });

  it("provides an empty state for a new canvas or changed graph", () => {
    expect(emptyPostEditHoverState()).toEqual({ edge: null, edgeDanger: false, cell: null, cellDanger: false });
  });
});
