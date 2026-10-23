import { describe, expect, it } from "vitest";
import { emptyPostEditHoverState, sameHoverCell, sameHoverEdge, shouldClearPostEditHover } from "../pixi/postEditHoverState";

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

describe("post-edit hover dedup (GitHub issue #739)", () => {
  it("compares cells by coordinates", () => {
    expect(sameHoverCell([1, 2], [1, 2])).toBe(true);
    expect(sameHoverCell([1, 2], [2, 1])).toBe(false);
    expect(sameHoverCell(null, null)).toBe(true);
    expect(sameHoverCell(null, [0, 0])).toBe(false);
  });

  it("compares edges by key and both cells", () => {
    const edge = { key: "0,0|1,0", from: [0, 0] as [number, number], to: [1, 0] as [number, number] };
    expect(sameHoverEdge(edge, { ...edge, from: [0, 0], to: [1, 0] })).toBe(true);
    expect(sameHoverEdge(edge, { ...edge, key: "0,0|0,1", to: [0, 1] })).toBe(false);
    expect(sameHoverEdge(edge, null)).toBe(false);
    expect(sameHoverEdge(null, null)).toBe(true);
  });
});
