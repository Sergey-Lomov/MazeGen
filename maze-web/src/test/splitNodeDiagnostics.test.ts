import { describe, it, expect } from "vitest";
import { splitNodeDiagnostics, patternEmptyNodeDiagnostics, patternSiblingDiagnostics } from "../pixi/splitNodeDiagnostics";
import type { TileFaceNode } from "../components/features/TileFaceEditor";
import type { SplitPattern } from "../wasm/types";

function node(faces: TileFaceNode["faces"]): TileFaceNode {
  return { color: "#000000", faces };
}

describe("splitNodeDiagnostics", () => {
  it("flags a node whose only non-boundary faces are all walls as a dead node", () => {
    const nodes = [node([{ kind: "wall", boundary: false }, { kind: "wall", boundary: false }])];
    expect(splitNodeDiagnostics(nodes)).toEqual(["Node 1 only has wall faces and no valid neighbor, it will be unreachable."]);
  });

  it("flags a node whose only faces are boundary walls as unreachable, not dead", () => {
    // No non-boundary faces at all -> the dead-node check (which only looks at openable faces)
    // doesn't fire, but the node still has zero connections, so it's flagged unreachable instead.
    const nodes = [node([{ kind: "wall", boundary: true }, { kind: "wall", boundary: true }])];
    expect(splitNodeDiagnostics(nodes)).toEqual(["Node 1 has no connections at all, it will be unreachable."]);
  });

  it("flags a node with one non-boundary wall face as dead, not unreachable", () => {
    // At least one openable (non-boundary) face exists and it's a wall -> dead-node check fires
    // first and returns early, so the unreachable message is never also produced for this node.
    const nodes = [node([{ kind: "wall", boundary: true }, { kind: "wall", boundary: false }])];
    expect(splitNodeDiagnostics(nodes)).toEqual(["Node 1 only has wall faces and no valid neighbor, it will be unreachable."]);
  });

  it("treats a passage face as a valid connection", () => {
    const nodes = [node([{ kind: "passage", boundary: false }])];
    expect(splitNodeDiagnostics(nodes)).toEqual([]);
  });

  it("treats one_way_out/one_way_in faces as valid connections", () => {
    expect(splitNodeDiagnostics([node([{ kind: "one_way_out", boundary: false }])])).toEqual([]);
    expect(splitNodeDiagnostics([node([{ kind: "one_way_in", boundary: false }])])).toEqual([]);
  });

  it("treats an undefined (preset optional) face as a valid connection, not unreachable", () => {
    const nodes = [node([{ kind: "undefined", boundary: false }])];
    expect(splitNodeDiagnostics(nodes)).toEqual([]);
  });

  it("skips indices listed in skipIndices", () => {
    const nodes = [node([{ kind: "wall", boundary: false }]), node([{ kind: "wall", boundary: false }])];
    const result = splitNodeDiagnostics(nodes, new Set([0]));
    expect(result).toEqual(["Node 2 only has wall faces and no valid neighbor, it will be unreachable."]);
  });

  it("reports one message per flagged node, in node order", () => {
    const nodes = [
      node([{ kind: "wall", boundary: false }]),
      node([{ kind: "passage", boundary: false }]),
      node([{ kind: "wall", boundary: false }]),
    ];
    expect(splitNodeDiagnostics(nodes)).toEqual([
      "Node 1 only has wall faces and no valid neighbor, it will be unreachable.",
      "Node 3 only has wall faces and no valid neighbor, it will be unreachable.",
    ]);
  });

});

describe("patternEmptyNodeDiagnostics", () => {
  function pattern(faces: SplitPattern["faces"], nodeCount = faces.length): SplitPattern {
    return { node_count: nodeCount, faces, weight: 1.0 };
  }

  it("flags a node with an empty face list", () => {
    const p = pattern([[]]);
    expect(patternEmptyNodeDiagnostics(p)).toEqual(["Node 1 has no faces defined."]);
  });

  it("does not flag a node with at least one face entry", () => {
    const p = pattern([[{ face_index: 0, requirement: { kind: "wall" } }]]);
    expect(patternEmptyNodeDiagnostics(p)).toEqual([]);
  });

  it("treats a missing faces entry (index beyond the array) as empty too", () => {
    const p = pattern([[{ face_index: 0, requirement: { kind: "passage" } }]], 2);
    expect(patternEmptyNodeDiagnostics(p)).toEqual(["Node 2 has no faces defined."]);
  });
});

describe("patternSiblingDiagnostics", () => {
  function pattern(faces: SplitPattern["faces"], nodeCount: number): SplitPattern {
    return { node_count: nodeCount, faces, weight: 1.0 };
  }

  it("flags a sibling_target outside [0, node_count)", () => {
    for (const target of [5, -1]) {
      const p = pattern([[{ face_index: 0, requirement: { kind: "passage" }, sibling_target: target }]], 2);
      expect(patternSiblingDiagnostics(p)).toEqual(["Node 1, face 0: sibling target no longer exists."]);
    }
  });

  it("does not flag a sibling_target within range", () => {
    const p = pattern([[{ face_index: 0, requirement: { kind: "passage" }, sibling_target: 1 }]], 2);
    expect(patternSiblingDiagnostics(p)).toEqual([]);
  });

  it("does not flag a face with no sibling_target at all", () => {
    const p = pattern([[{ face_index: 0, requirement: { kind: "wall" } }]], 2);
    expect(patternSiblingDiagnostics(p)).toEqual([]);
  });
});
