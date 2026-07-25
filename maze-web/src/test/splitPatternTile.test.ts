import { describe, it, expect } from "vitest";
import { degreeFor, resizePatternNodes, removePatternNode } from "../pixi/splitPatternTile";
import type { SplitPattern } from "../wasm/types";

describe("degreeFor", () => {
  it("returns 4 for square", () => {
    expect(degreeFor({ type: "square", width: 3, height: 3 })).toBe(4);
  });

  it("returns 6 for hex", () => {
    expect(degreeFor({ type: "hex_parallelogram", width: 3, height: 3, orientation: "flat_top" } as never)).toBe(6);
  });

  it("returns 3 for triangle", () => {
    expect(degreeFor({ type: "triangle_rect", width: 3, height: 3 } as never)).toBe(3);
  });
});

describe("resizePatternNodes", () => {
  const pattern = (nodeCount: number, faces: SplitPattern["faces"]): SplitPattern => ({ node_count: nodeCount, faces, weight: 1.0 });

  it("truncates extra nodes' face lists when shrinking", () => {
    const p = pattern(3, [[{ face_index: 0, requirement: { kind: "passage" } }], [], [{ face_index: 1, requirement: { kind: "wall" } }]]);
    const next = resizePatternNodes(p, 2);
    expect(next.node_count).toBe(2);
    expect(next.faces).toEqual([[{ face_index: 0, requirement: { kind: "passage" } }], []]);
  });

  it("pads missing nodes with an empty face list when growing", () => {
    const p = pattern(1, [[{ face_index: 0, requirement: { kind: "passage" } }]]);
    const next = resizePatternNodes(p, 3);
    expect(next.node_count).toBe(3);
    expect(next.faces).toEqual([[{ face_index: 0, requirement: { kind: "passage" } }], [], []]);
  });

  it("clamps to a minimum of 1 and truncates a non-integer count", () => {
    const p = pattern(2, [[], []]);
    expect(resizePatternNodes(p, 0).node_count).toBe(1);
    expect(resizePatternNodes(p, -5).node_count).toBe(1);
    expect(resizePatternNodes(p, 2.9).node_count).toBe(2);
  });
});

describe("removePatternNode", () => {
  it("is a no-op when only one node remains", () => {
    const p: SplitPattern = { node_count: 1, faces: [[]], weight: 1.0 };
    expect(removePatternNode(p, 0)).toBe(p);
  });

  it("drops the removed node's face list and shifts remaining indices down", () => {
    const p: SplitPattern = {
      node_count: 3,
      faces: [
        [{ face_index: 0, requirement: { kind: "passage" }, sibling_target: 1 }],
        [{ face_index: 2, requirement: { kind: "passage" }, sibling_target: 0 }],
        [{ face_index: 1, requirement: { kind: "wall" } }],
      ],
      weight: 1.0,
    };
    const next = removePatternNode(p, 1);
    expect(next.node_count).toBe(2);
    // Node 0's face targeting removed node 1 as a sibling is dropped entirely.
    expect(next.faces[0]).toEqual([]);
    // Former node 2 (now node 1) is unaffected — it never referenced the removed node.
    expect(next.faces[1]).toEqual([{ face_index: 1, requirement: { kind: "wall" } }]);
  });

  it("re-indexes a sibling_target above the removed index down by one", () => {
    const p: SplitPattern = {
      node_count: 3,
      faces: [
        [{ face_index: 0, requirement: { kind: "passage" }, sibling_target: 2 }],
        [],
        [{ face_index: 1, requirement: { kind: "passage" }, sibling_target: 0 }],
      ],
      weight: 1.0,
    };
    // Remove node 1 (the middle one, uninvolved) — node 0's reference to node 2 must become
    // a reference to node 1 (its new index), and node 2's own faces survive as the new node 1.
    const next = removePatternNode(p, 1);
    expect(next.node_count).toBe(2);
    expect(next.faces[0]).toEqual([{ face_index: 0, requirement: { kind: "passage" }, sibling_target: 1 }]);
    expect(next.faces[1]).toEqual([{ face_index: 1, requirement: { kind: "passage" }, sibling_target: 0 }]);
  });

  it("leaves a sibling_target below the removed index untouched", () => {
    const p: SplitPattern = {
      node_count: 3,
      faces: [
        [],
        [],
        [{ face_index: 0, requirement: { kind: "passage" }, sibling_target: 0 }],
      ],
      weight: 1.0,
    };
    const next = removePatternNode(p, 1);
    expect(next.faces[1]).toEqual([{ face_index: 0, requirement: { kind: "passage" }, sibling_target: 0 }]);
  });
});
