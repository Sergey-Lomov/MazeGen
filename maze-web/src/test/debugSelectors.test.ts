import { describe, it, expect } from "vitest";
import { parseTape, RB_TAG, NO_NODE, type ParsedTape } from "../debug/eventTape";
import { selectDebugMazeView } from "../store/debugSelectors";
import type { DebugArenaHandle } from "../store/storeTypes";
import type { NodeDto } from "../wasm/types";

function u64le(v: bigint): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, v, true);
  return bytes;
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

function edgeAddedPayload(from: bigint, to: bigint): Uint8Array {
  // bidirectional=true — mirrors RB's real behavior (GitHub issue #135).
  return concatBytes([u64le(from), u64le(to), new Uint8Array([1])]);
}

interface FixtureNode {
  nextSibling: number | null;
  tag: number;
  payloadBytes: Uint8Array;
}

/** Same flat-under-root shape as eventTape.test.ts's buildThreeEdgeTape — three top-level
 *  EdgeAdded nodes, no nested scopes (parent/firstChild are irrelevant to the flat layer this
 *  selector uses). */
function buildTapeWithEdges(edges: [bigint, bigint][]): ParsedTape {
  const nodes: FixtureNode[] = edges.map(([from, to], i) => ({
    nextSibling: i < edges.length - 1 ? i + 1 : null,
    tag: RB_TAG.EDGE_ADDED,
    payloadBytes: edgeAddedPayload(from, to),
  }));
  const payloadChunks = nodes.map((n) => n.payloadBytes);
  const offsets: number[] = [];
  let cursor = 0;
  for (const chunk of payloadChunks) {
    offsets.push(cursor);
    cursor += chunk.byteLength;
  }
  const payload = concatBytes(payloadChunks);
  const nodeTable = new Uint8Array(nodes.length * 22);
  const dv = new DataView(nodeTable.buffer);
  nodes.forEach((n, i) => {
    const base = i * 22;
    dv.setUint32(base + 0, NO_NODE, true); // parent
    dv.setUint32(base + 4, NO_NODE, true); // firstChild
    dv.setUint32(base + 8, n.nextSibling ?? NO_NODE, true);
    dv.setUint16(base + 12, n.tag, true);
    dv.setUint32(base + 14, offsets[i], true);
    dv.setUint32(base + 18, n.payloadBytes.byteLength, true);
  });
  return parseTape(nodeTable, payload);
}

const nodes: NodeDto[] = [
  { id: 1, x: 0, y: 0 },
  { id: 2, x: 1, y: 0 },
  { id: 3, x: 2, y: 0 },
  { id: 4, x: 3, y: 0 },
];

function arenaWithEdges(edges: [bigint, bigint][]): DebugArenaHandle {
  return { tape: buildTapeWithEdges(edges), nodes, totalSteps: edges.length, checkpointFroms: [] };
}

describe("selectDebugMazeView", () => {
  it("returns null when there is no debug arena", () => {
    expect(selectDebugMazeView(null, 0)).toBeNull();
  });

  it("returns the arena's static node list and the exact edges reconstructed at debugStep, both directions per bidirectional EdgeAdded (GitHub issue #135)", () => {
    const arena = arenaWithEdges([[1n, 2n], [2n, 3n], [3n, 4n]]);
    const view = selectDebugMazeView(arena, 1);
    expect(view).toEqual({
      nodes,
      edges: [
        { from: 1, to: 2, kind: "basic" },
        { from: 2, to: 1, kind: "basic" },
        { from: 2, to: 3, kind: "basic" },
        { from: 3, to: 2, kind: "basic" },
      ],
    });
  });

  it("step 0 reconstructs exactly one bidirectional edge (both directions)", () => {
    const arena = arenaWithEdges([[1n, 2n], [2n, 3n]]);
    const view = selectDebugMazeView(arena, 0);
    expect(view?.edges).toEqual([
      { from: 1, to: 2, kind: "basic" },
      { from: 2, to: 1, kind: "basic" },
    ]);
  });

  it("the last valid step (totalSteps - 1) reconstructs every edge in the tape, both directions each", () => {
    const edgePairs: [bigint, bigint][] = [[1n, 2n], [2n, 3n], [3n, 4n]];
    const arena = arenaWithEdges(edgePairs);
    const view = selectDebugMazeView(arena, arena.totalSteps - 1);
    expect(view?.edges).toHaveLength(edgePairs.length * 2);
  });

  it("converts bigint node ids to number and always tags edges as basic", () => {
    const arena = arenaWithEdges([[1n, 2n]]);
    const view = selectDebugMazeView(arena, 0);
    expect(view?.edges[0]).toEqual({ from: 1, to: 2, kind: "basic" });
    expect(typeof view?.edges[0].from).toBe("number");
  });

  it("resumes from a checkpoint (GitHub issue #128) and reconstructs the same edges as a full replay", () => {
    const edgePairs: [bigint, bigint][] = [[1n, 2n], [2n, 3n], [3n, 4n]];
    const tape = buildTapeWithEdges(edgePairs);
    // A checkpoint at arena node 0 (step 0) reflecting state after the first EdgeAdded.
    const checkpointFroms = [{ edges: [{ from: 1n, to: 2n }, { from: 2n, to: 1n }], step: 0, nodeIndex: 0 }];
    const arenaWithCheckpoint: DebugArenaHandle = { tape, nodes, totalSteps: edgePairs.length, checkpointFroms };
    const arenaWithoutCheckpoint: DebugArenaHandle = { tape, nodes, totalSteps: edgePairs.length, checkpointFroms: [] };

    const withCheckpoint = selectDebugMazeView(arenaWithCheckpoint, 2);
    const withoutCheckpoint = selectDebugMazeView(arenaWithoutCheckpoint, 2);
    expect(withCheckpoint).toEqual(withoutCheckpoint);
  });
});
