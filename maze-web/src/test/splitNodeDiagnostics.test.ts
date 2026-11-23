import { describe, it, expect } from "vitest";
import { splitNodeDiagnostics } from "../pixi/splitNodeDiagnostics";
import type { TileFaceNode } from "../domain/tileFace";

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
