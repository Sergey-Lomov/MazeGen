import type { NodeDto, EdgeDto } from "../wasm/types";

const n = (id: number, x: number, y: number, level?: number): NodeDto => ({ id, x, y, i: 0, level });
const e = (from: number, to: number): EdgeDto => ({ from, to, kind: "basic" });

// Point (0,0) split into node 0 (slot 0: east+west) and node 4 (slot 1: north+south) — a
// recognized "bridge" special shape (see `mazeSelectors.test.ts`'s own bridge-topology test for
// the geometry this produces). Node 6 sits on a plain, non-split, non-special cell.
export const bridgeSplitNodes: NodeDto[] = [
  n(0, 0, 0), n(1, 1, 0), n(2, -1, 0),
  n(3, 0, 1), n(4, 0, 0), n(5, 0, -1),
  n(6, 5, 5),
];
export const bridgeSplitEdges: EdgeDto[] = [e(0, 1), e(1, 0), e(0, 2), e(2, 0), e(4, 3), e(3, 4), e(4, 5), e(5, 4)];

// A plain (non-special) 2-node split point at (1,1) — no recognized bridge/diagonal topology.
export const plainSplitNodes: NodeDto[] = [n(0, 1, 1), n(1, 1, 1), n(2, 5, 5)];
