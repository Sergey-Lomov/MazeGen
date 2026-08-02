import {
  parseTape,
  TAG_SCOPE, NO_NODE, RECURSIVE_BACKTRACKER_EVENT_TAG, QC_EVENT_TAG,
  type ParsedTape,
} from "../debug/eventTape";

// --- Fixture encoder, mirroring eventTape.test.ts's own local encoder (same precedent: small
// enough not to be worth a shared test-util yet) — shared here across the QC test files that
// were split out of a single eventTapeQc.test.ts.

export interface FixtureNode {
  parent: number | null;
  firstChild: number | null;
  nextSibling: number | null;
  tag: number;
  payloadBytes: Uint8Array;
}

export function u64le(v: bigint): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, v, true);
  return bytes;
}

export function u32le(v: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, v, true);
  return bytes;
}

export function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

export function scopePayload(name: string): Uint8Array {
  return new TextEncoder().encode(name);
}

export function strPayload(s: string): Uint8Array {
  const bytes = new TextEncoder().encode(s);
  return concatBytes([u32le(bytes.length), bytes]);
}

export function edgeAddedPayload(from: bigint, to: bigint, bidirectional = true): Uint8Array {
  return concatBytes([u64le(from), u64le(to), new Uint8Array([bidirectional ? 1 : 0])]);
}

export function nodeIdListPayload(ids: bigint[]): Uint8Array {
  return concatBytes([u32le(ids.length), ...ids.map(u64le)]);
}

/** `PointNodesReplaced { at, old_nodes, new_nodes, nodes }` wire payload — `nodes` here is always
 *  passed empty (no `SplitNodeEdge`s) since these tests only care about `old_nodes`/`new_nodes`
 *  folding into `removedNodes`/`createdNodes`, mirroring `write_split_nodes`'s per-node u32
 *  edge-count-then-edges shape with a count of 0 for every entry. */
export function pointNodesReplacedPayload(at: bigint, oldNodes: bigint[], newNodes: bigint[], nodeCount: number): Uint8Array {
  return concatBytes([
    u64le(at),
    nodeIdListPayload(oldNodes),
    nodeIdListPayload(newNodes),
    u32le(nodeCount), ...Array.from({ length: nodeCount }, () => u32le(0)),
  ]);
}

export function buildFixture(nodes: FixtureNode[]): ParsedTape {
  const payloadChunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let cursor = 0;
  for (const n of nodes) {
    offsets.push(cursor);
    payloadChunks.push(n.payloadBytes);
    cursor += n.payloadBytes.byteLength;
  }
  const payload = concatBytes(payloadChunks);

  const nodeTable = new Uint8Array(nodes.length * 22);
  const dv = new DataView(nodeTable.buffer);
  nodes.forEach((n, i) => {
    const base = i * 22;
    dv.setUint32(base + 0, n.parent ?? NO_NODE, true);
    dv.setUint32(base + 4, n.firstChild ?? NO_NODE, true);
    dv.setUint32(base + 8, n.nextSibling ?? NO_NODE, true);
    dv.setUint16(base + 12, n.tag, true);
    dv.setUint32(base + 14, offsets[i], true);
    dv.setUint32(base + 18, n.payloadBytes.byteLength, true);
  });

  return parseTape(nodeTable, payload);
}

// root (0) -> "generation" scope (1) -> RB former root (2) -> EdgeAdded(1,2) (3)
//          -> "quality_control" scope (4) -> QC former root (5)
//               -> "stage s1" scope (6) -> "iteration 1" scope (7)
//                    -> IterationStarted(0) (8)
//                    -> "rule r1" scope (9)
//                         -> StartSet(10) (10)
//                         -> FinishSet(20) (11)
//                         -> BidirectionalEdgeAdded(10,20) (12)
//                         -> EdgeRemovedBetween(1,2) (13)
//                         -> DirectedEdgeDeclined(30,40) (14)
export function buildQcTwoSourceTape(): ParsedTape {
  return buildFixture([
    { parent: null, firstChild: 1, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") },
    { parent: 0, firstChild: 2, nextSibling: 4, tag: TAG_SCOPE, payloadBytes: scopePayload("generation") },
    { parent: 1, firstChild: 3, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") },
    { parent: 2, firstChild: null, nextSibling: null, tag: RECURSIVE_BACKTRACKER_EVENT_TAG.EDGE_ADDED, payloadBytes: edgeAddedPayload(1n, 2n) },
    { parent: 0, firstChild: 5, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("quality_control") },
    { parent: 4, firstChild: 6, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") },
    { parent: 5, firstChild: 7, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("stage s1") },
    { parent: 6, firstChild: 8, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("iteration 1") },
    { parent: 7, firstChild: null, nextSibling: 9, tag: QC_EVENT_TAG.ITERATION_STARTED, payloadBytes: u32le(0) },
    { parent: 7, firstChild: 10, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("rule r1") },
    { parent: 9, firstChild: null, nextSibling: 11, tag: QC_EVENT_TAG.START_SET, payloadBytes: u64le(10n) },
    { parent: 9, firstChild: null, nextSibling: 12, tag: QC_EVENT_TAG.FINISH_SET, payloadBytes: u64le(20n) },
    { parent: 9, firstChild: null, nextSibling: 13, tag: QC_EVENT_TAG.BIDIRECTIONAL_EDGE_ADDED, payloadBytes: concatBytes([u64le(10n), u64le(20n)]) },
    { parent: 9, firstChild: null, nextSibling: 14, tag: QC_EVENT_TAG.EDGE_REMOVED_BETWEEN, payloadBytes: concatBytes([u64le(1n), u64le(2n)]) },
    { parent: 9, firstChild: null, nextSibling: null, tag: QC_EVENT_TAG.DIRECTED_EDGE_DECLINED, payloadBytes: concatBytes([u64le(30n), u64le(40n)]) },
  ]);
}

/** A flat tape of `count` sequential `DirectedEdgeAdded(i, i+1)` events, directly under root
 *  (no generation source prefix — `applyQc`'s own `startNodeIndex` defaults to 0, matching a
 *  from-scratch scan starting right at this tape's own first node). `DirectedEdgeAdded` alone
 *  is mutating for QC and exercises the `net`/`removedFromEarlierSources` keyed-accumulator
 *  resume path this issue's generalization added. */
export function buildLongQcChainTape(count: number): ParsedTape {
  const nodes: FixtureNode[] = [{ parent: null, firstChild: 1, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") }];
  for (let i = 0; i < count; i++) {
    nodes.push({
      parent: 0,
      firstChild: null,
      nextSibling: i + 1 < count ? i + 2 : null,
      tag: QC_EVENT_TAG.DIRECTED_EDGE_ADDED,
      payloadBytes: concatBytes([u64le(BigInt(i + 1)), u64le(BigInt(i + 2))]),
    });
  }
  return buildFixture(nodes);
}

/** 600 `DirectedEdgeAdded(i, i+1)` events (steps 0..599, crossing the first CHECKPOINT_INTERVAL
 *  boundary at step 499), followed by `EdgeRemovedBetween` events removing edge 1 (added at
 *  step 0, well before the snapshot) and edge 550 (added at step 549, after the snapshot but
 *  before targetStep) — exercises `removedFromEarlierSources`/`net.delete` seeded from a
 *  resumed `from`, not just monotonic growth (GitHub issue #128's review follow-up: none of
 *  the other long-chain assertions ever remove or re-add an id after the snapshot point). */
export function buildQcChainWithRemovals(): ParsedTape {
  const nodes: FixtureNode[] = [{ parent: null, firstChild: 1, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") }];
  const addCount = 600;
  for (let i = 0; i < addCount; i++) {
    nodes.push({
      parent: 0, firstChild: null, nextSibling: i + 1,
      tag: QC_EVENT_TAG.DIRECTED_EDGE_ADDED,
      payloadBytes: concatBytes([u64le(BigInt(i + 1)), u64le(BigInt(i + 2))]),
    });
  }
  // Remove edge (1,2) [added at step 0, before the snapshot] and edge (550,551) [added at
  // step 549, after the snapshot].
  nodes.push({
    parent: 0, firstChild: null, nextSibling: addCount + 2,
    tag: QC_EVENT_TAG.EDGE_REMOVED_BETWEEN,
    payloadBytes: concatBytes([u64le(1n), u64le(2n)]),
  });
  nodes.push({
    parent: 0, firstChild: null, nextSibling: null,
    tag: QC_EVENT_TAG.EDGE_REMOVED_BETWEEN,
    payloadBytes: concatBytes([u64le(550n), u64le(551n)]),
  });
  return buildFixture(nodes);
}
