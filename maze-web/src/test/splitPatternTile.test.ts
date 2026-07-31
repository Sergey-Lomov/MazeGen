import { describe, it, expect } from "vitest";
import { degreeFor, resizePatternNodes, removePatternNode, tileNodesForTopology } from "../pixi/splitPatternTile";
import { titleKeyForTopology } from "../pixi/splitPatternTitles";
import type { SplitPattern, SplitFaceRequirement } from "../wasm/types";

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

describe("tileNodesForTopology", () => {
  const PASSAGE: SplitFaceRequirement = { kind: "passage" };
  const WALL: SplitFaceRequirement = { kind: "wall" };
  const cfg = { type: "square", width: 3, height: 3 } as const;

  it("converts core face positions to web face positions per node", () => {
    // Square core order is [N, S, E, W] (indices 0-3); splitFaceIndexToCore's web->core table is
    // [2, 0, 3, 1], so web position 0 reads core position 2 (E), web 1 reads core 0 (N), web 2
    // reads core 3 (W), web 3 reads core 1 (S).
    const topology: SplitFaceRequirement[][] = [
      [PASSAGE, WALL, WALL, PASSAGE], // core: N=passage, S=wall, E=wall, W=passage
    ];
    const nodes = tileNodesForTopology(topology, cfg);
    expect(nodes).toHaveLength(1);
    // web0(E)->core2=wall, web1(N)->core0=passage, web2(W)->core3=passage, web3(S)->core1=wall
    expect(nodes[0].faces.map((f) => f.kind)).toEqual(["wall", "passage", "passage", "wall"]);
  });

  it("assigns each node a distinct color and no boundary flag", () => {
    const topology: SplitFaceRequirement[][] = [[PASSAGE, WALL, WALL, WALL], [WALL, PASSAGE, WALL, WALL]];
    const nodes = tileNodesForTopology(topology, cfg);
    expect(nodes).toHaveLength(2);
    expect(nodes[0].color).not.toBe(nodes[1].color);
    expect(nodes.every((n) => n.faces.every((f) => f.boundary === false))).toBe(true);
  });
});

describe("titleKeyForTopology", () => {
  const PASSAGE: SplitFaceRequirement = { kind: "passage" };
  const WALL: SplitFaceRequirement = { kind: "wall" };

  it("matches the square Bridge topology by exact structural equality", () => {
    const topology: SplitFaceRequirement[][] = [
      [PASSAGE, PASSAGE, WALL, WALL],
      [WALL, WALL, PASSAGE, PASSAGE],
    ];
    expect(titleKeyForTopology(topology)).toBe("split_pattern_title.bridge");
  });

  it("returns null for an unregistered topology", () => {
    const topology: SplitFaceRequirement[][] = [
      [PASSAGE, WALL, WALL, WALL],
      [WALL, PASSAGE, WALL, WALL],
    ];
    expect(titleKeyForTopology(topology)).toBeNull();
  });

  it("returns null for an empty topology", () => {
    expect(titleKeyForTopology([])).toBeNull();
  });

  it("distinguishes a one_way requirement from passage/wall by direction", () => {
    const topology: SplitFaceRequirement[][] = [
      [{ kind: "one_way", direction: "forward" }, PASSAGE, WALL, WALL],
      [WALL, WALL, PASSAGE, PASSAGE],
    ];
    expect(titleKeyForTopology(topology)).toBeNull();
  });
});
