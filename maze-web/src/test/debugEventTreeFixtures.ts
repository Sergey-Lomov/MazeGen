import { parseTape, TAG_SCOPE, NO_NODE, RECURSIVE_BACKTRACKER_EVENT_TAG, WILSON_EVENT_TAG, QC_EVENT_TAG, type ParsedTape } from "../debug/eventTape";

// --- Fixture encoder — same shape as debugTreeSelectors.test.ts's buildTwoStepTape, duplicated
// locally per that file's own precedent (small enough not to be worth a shared test-util yet).

interface FixtureNode {
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

export function edgeAddedPayload(from: bigint, to: bigint): Uint8Array {
  // bidirectional=true (GitHub issue #135).
  return concatBytes([u64le(from), u64le(to), new Uint8Array([1])]);
}

export function vertexPayload(id: bigint): Uint8Array {
  return u64le(id);
}

export function stepTakenPayload(from: bigint, to: bigint): Uint8Array {
  return concatBytes([u64le(from), u64le(to)]);
}

export function u32le(v: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, v, true);
  return bytes;
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

// Every fixture is wrapped in the merge shape `event_log::merge_tapes` always produces (GitHub
// issue #169): node 0 = merged root, node 1 = "generation" top-level source scope, node 2 =
// the algorithm's own former root, one level deeper than pre-#169 fixtures had it. Real tags
// aren't namespaced here (single source, source_index 0 -> tag unchanged, see merge_tapes' docs)
// — only the extra two wrapper nodes need to exist for DebugEventTree's auto-expand-the-source-
// scope behavior to land on the right node.

// root (0) -> "generation" scope (1) -> former root (2) -> "step 1" scope (3)
//   -> EdgeAdded(1,2) (4) -> VertexVisited(2) (5) -> VertexPushed(2) (6)
//   -> "step 2" scope (7) -> DeadEnd (8) -> VertexPopped(2) (9)
export function buildTwoStepTape(): ParsedTape {
  return buildFixture([
    { parent: null, firstChild: 1, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") },
    { parent: 0, firstChild: 2, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("generation") },
    { parent: 1, firstChild: 3, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") },
    { parent: 2, firstChild: 4, nextSibling: 7, tag: TAG_SCOPE, payloadBytes: scopePayload("step 1") },
    { parent: 3, firstChild: null, nextSibling: 5, tag: RECURSIVE_BACKTRACKER_EVENT_TAG.EDGE_ADDED, payloadBytes: edgeAddedPayload(1n, 2n) },
    { parent: 3, firstChild: null, nextSibling: 6, tag: RECURSIVE_BACKTRACKER_EVENT_TAG.VERTEX_VISITED, payloadBytes: vertexPayload(2n) },
    { parent: 3, firstChild: null, nextSibling: null, tag: RECURSIVE_BACKTRACKER_EVENT_TAG.VERTEX_PUSHED, payloadBytes: vertexPayload(2n) },
    { parent: 2, firstChild: 8, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("step 2") },
    { parent: 7, firstChild: null, nextSibling: 9, tag: RECURSIVE_BACKTRACKER_EVENT_TAG.DEAD_END, payloadBytes: new Uint8Array(0) },
    { parent: 7, firstChild: null, nextSibling: null, tag: RECURSIVE_BACKTRACKER_EVENT_TAG.VERTEX_POPPED, payloadBytes: vertexPayload(2n) },
  ]);
}

// root (0) -> "generation" scope (1) -> former root (2) -> "walk 1" scope (3) -> WalkStartPicked(1) (4)
//                                                        -> "search" scope (5) -> StepTaken(1,2) (6)
//                                                        -> "commit" scope (7) -> EdgeAdded(1,2) (8) -> NodeVisited(1) (9)
// Mirrors wilson.rs's `generate`'s new two-phase shape (GitHub issue #145's follow-up) — a walk
// scope's only nested scopes are exactly "search" then "commit", not one "step M" scope per step.
export function buildOneWalkWilsonTape(): ParsedTape {
  return buildFixture([
    { parent: null, firstChild: 1, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") },
    { parent: 0, firstChild: 2, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("generation") },
    { parent: 1, firstChild: 3, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") },
    { parent: 2, firstChild: 4, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("walk 1") },
    { parent: 3, firstChild: null, nextSibling: 5, tag: WILSON_EVENT_TAG.WALK_START_PICKED, payloadBytes: vertexPayload(1n) },
    { parent: 3, firstChild: 6, nextSibling: 7, tag: TAG_SCOPE, payloadBytes: scopePayload("search") },
    { parent: 5, firstChild: null, nextSibling: null, tag: WILSON_EVENT_TAG.STEP_TAKEN, payloadBytes: stepTakenPayload(1n, 2n) },
    { parent: 3, firstChild: 8, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("commit") },
    { parent: 7, firstChild: null, nextSibling: 9, tag: WILSON_EVENT_TAG.EDGE_ADDED, payloadBytes: edgeAddedPayload(1n, 2n) },
    { parent: 7, firstChild: null, nextSibling: null, tag: WILSON_EVENT_TAG.NODE_VISITED, payloadBytes: vertexPayload(1n) },
  ]);
}

// root (0) -> "generation" scope (1) -> former root (2) -> "walk 1" scope (3) -> WalkStartPicked(1) (4)
//                                                        -> "search" scope (5) -> StepTaken(1,2) (6) -> LoopErased(2) (7) -> WalkDeadEnd (8)
// Covers wilsonNarrationTokensFor's LoopErased/WalkDeadEnd branches, which buildOneWalkWilsonTape
// doesn't exercise (its walk connects straight into "commit" without a loop or a dead end).
export function buildLoopErasedDeadEndWilsonTape(): ParsedTape {
  return buildFixture([
    { parent: null, firstChild: 1, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") },
    { parent: 0, firstChild: 2, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("generation") },
    { parent: 1, firstChild: 3, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") },
    { parent: 2, firstChild: 4, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("walk 1") },
    { parent: 3, firstChild: null, nextSibling: 5, tag: WILSON_EVENT_TAG.WALK_START_PICKED, payloadBytes: vertexPayload(1n) },
    { parent: 3, firstChild: 6, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("search") },
    { parent: 5, firstChild: null, nextSibling: 7, tag: WILSON_EVENT_TAG.STEP_TAKEN, payloadBytes: stepTakenPayload(1n, 2n) },
    { parent: 5, firstChild: null, nextSibling: 8, tag: WILSON_EVENT_TAG.LOOP_ERASED, payloadBytes: vertexPayload(2n) },
    { parent: 5, firstChild: null, nextSibling: null, tag: WILSON_EVENT_TAG.WALK_DEAD_END, payloadBytes: new Uint8Array(0) },
  ]);
}

// root (0) -> "generation" scope (1) -> RB former root (2) -> "step 1" scope (3) -> EdgeAdded(1,2) (4)
//          -> "quality_control" scope (5) -> QC former root (6)
//               -> "stage s1" scope (7) -> "iteration 1" scope (8)
//                    -> IterationStarted(0) (9)
//                    -> "rule r1" scope (10) -> BidirectionalEdgeAdded(1,2) (11)
// Mirrors the real generation+QC merge shape `run_generate`/`merge_tapes` produce (GitHub issue
// #147) — covers all three tree-rendering regressions from that issue's bug batch at once: double
// nesting under a spurious extra "step 0" wrapper, wrong top-level step numbering, and raw
// `quality_control`/scope-name text instead of localized "Quality Control"/quoted stage-rule titles.
export function buildGenerationPlusQcTape(): ParsedTape {
  return buildFixture([
    { parent: null, firstChild: 1, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") },
    { parent: 0, firstChild: 2, nextSibling: 5, tag: TAG_SCOPE, payloadBytes: scopePayload("generation") },
    { parent: 1, firstChild: 3, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") },
    { parent: 2, firstChild: 4, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("step 1") },
    { parent: 3, firstChild: null, nextSibling: null, tag: RECURSIVE_BACKTRACKER_EVENT_TAG.EDGE_ADDED, payloadBytes: edgeAddedPayload(1n, 2n) },
    { parent: 0, firstChild: 6, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("quality_control") },
    { parent: 5, firstChild: 7, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("root") },
    { parent: 6, firstChild: 8, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("stage s1") },
    { parent: 7, firstChild: 9, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("iteration 1") },
    { parent: 8, firstChild: null, nextSibling: 10, tag: QC_EVENT_TAG.ITERATION_STARTED, payloadBytes: u32le(0) },
    { parent: 8, firstChild: 11, nextSibling: null, tag: TAG_SCOPE, payloadBytes: scopePayload("rule r1") },
    { parent: 10, firstChild: null, nextSibling: null, tag: QC_EVENT_TAG.BIDIRECTIONAL_EDGE_ADDED, payloadBytes: concatBytes([u64le(1n), u64le(2n)]) },
  ]);
}
