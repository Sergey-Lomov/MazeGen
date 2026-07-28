// --- Kruskal event replay (GitHub issue #146; decoding lives in generated/kruskal.ts) ---

import { nodeAt, TAG_SCOPE, type ParsedTape } from "./wire";
import { mutatingEventsWithIndex, type MutatingEventAt } from "./scan";
import { validateStepShape, type Edge } from "./applyShared";
import { decodeKruskalEvent, isMutatingKruskalEvent, type KruskalEvent } from "./generated/kruskal";

export type { KruskalEvent } from "./generated/kruskal";
export { decodeKruskalEvent, isMutatingKruskalEvent, KRUSKAL_EVENT_TAG } from "./generated/kruskal";

/** The merged set's new root after a `SetsMerged` event — mirrors
 *  `KruskalEvent::merged_root` in `maze-core/src/generation/kruskal.rs`. A function, not a field
 *  on the event (the wire payload doesn't carry it — see that Rust method's doc comment), so both
 *  sides derive it identically from the same two pre-merge roots. */
export function kruskalMergedRoot(rootA: bigint, rootB: bigint): bigint {
  return rootA < rootB ? rootA : rootB;
}

export type MutatingKruskalEventAt = MutatingEventAt<KruskalEvent>;

/** Flat layer for Kruskal: forward scan over the node table, skipping scope nodes, decoding
 *  events, filtering to mutating ones only. Kruskal produces no checkpoints (GitHub issue #146's
 *  scope), so unlike RB this has no bounded-resume use case yet, but keeps the same
 *  `startIndex`/`limit` shape for consistency and so `applyKruskal` can reuse the same "keep
 *  collecting until limit" loop structure. */
export function mutatingKruskalEventsWithIndex(tape: ParsedTape, limit?: number, startIndex = 0, endIndex?: number): MutatingKruskalEventAt[] {
  return mutatingEventsWithIndex(tape, decodeKruskalEvent, isMutatingKruskalEvent, limit, startIndex, endIndex);
}

/** Convenience wrapper over `mutatingKruskalEventsWithIndex` for callers that only need the
 *  decoded events, not their arena indices — mirrors `mutatingRbEvents`. */
export function mutatingKruskalEvents(tape: ParsedTape, limit?: number, startIndex = 0, endIndex?: number): KruskalEvent[] {
  return mutatingKruskalEventsWithIndex(tape, limit, startIndex, endIndex).map((e) => e.event);
}

/** Minimal union-find over `bigint` ids (path compression + union by min), used only to
 *  reconstruct Kruskal's DSU groups for the debug replay (GitHub issue #146's DSU-groups
 *  extension) — not the same type as `maze-core`'s `Dsu` (that one operates on dense `usize`
 *  indices; this one operates directly on `NodeId`s, since the web side never builds the
 *  dense-index mapping the core algorithm uses internally). Roots are chosen by `union`'s own
 *  `min(a, b)` rule, mirroring `Dsu::union_by_min` — this must stay in sync with the core's
 *  `union_by_min` calls (`kruskal.rs`) for a replayed root to equal the value `RootsCompared`/
 *  `SetsMerged` events actually carried. */
class KruskalDsu {
  private parent = new Map<bigint, bigint>();

  private ensure(id: bigint): void {
    if (!this.parent.has(id)) this.parent.set(id, id);
  }

  find(id: bigint): bigint {
    this.ensure(id);
    let root = id;
    while (this.parent.get(root) !== root) root = this.parent.get(root)!;
    // Path compression: point every visited node directly at the root.
    let cur = id;
    while (cur !== root) {
      const next = this.parent.get(cur)!;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  union(a: bigint, b: bigint): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    if (ra < rb) this.parent.set(rb, ra);
    else this.parent.set(ra, rb);
  }

  /** Every id this DSU has ever seen (via `find`/`union`), each mapped to its current root. */
  groups(): Map<bigint, bigint> {
    const result = new Map<bigint, bigint>();
    for (const id of this.parent.keys()) result.set(id, this.find(id));
    return result;
  }

  /** Restores state from a previously-flattened `groups()` snapshot (GitHub issue #128's generic
   *  resume) — since `groups()` always returns fully path-compressed `id -> root` pairs, seeding
   *  `parent` directly from them (root entries point at themselves) reproduces the exact same
   *  flattened structure `find`/`union` would see, without replaying every original `union` call. */
  seed(id: bigint, root: bigint): void {
    this.parent.set(id, root);
  }
}

/** Locates the single `PresetUnionsApplied` event, if any — emitted once, directly under
 *  Kruskal's own source scope, before any `"edge N"` scope (see `kruskal.rs`'s `generate`).
 *  Absent when the run had no preset connections (`kruskal.rs` skips emitting it entirely rather
 *  than emitting an empty pairs list — see `KruskalEvent::PresetUnionsApplied`'s doc comment). A
 *  plain linear scan from `startIndex` (Kruskal's own source content start within the shared
 *  multi-source tape, GitHub issue #169/#225 — *not* necessarily node 0 once a "preset setup" or
 *  another source precedes Kruskal's), bounded by `endIndex` (or the first "edge N" scope inside
 *  that range, whichever comes first), since this event is trace-only and not part of
 *  `mutatingKruskalEventsWithIndex`'s scan. */
function findPresetUnions(tape: ParsedTape, startIndex: number, endIndex: number): [bigint, bigint, "basic" | "teleport"][] {
  for (let i = startIndex; i < endIndex; i++) {
    const record = nodeAt(tape, i);
    if (record.tag === TAG_SCOPE) {
      // Reached the first "edge N" scope — PresetUnionsApplied (if any) always precedes it.
      if (i > startIndex) break;
      continue;
    }
    const bytes = tape.payload.subarray(record.payloadOffset, record.payloadOffset + record.payloadLen);
    const event = decodeKruskalEvent(record.tag, bytes);
    if (event.kind === "PresetUnionsApplied") return event.pairs;
  }
  return [];
}

export interface KruskalApplyResult {
  edges: Edge[];
  /** Every node id seen so far (via `EdgeAdded`'s endpoints, `PresetUnionsApplied`'s pairs, or a
   *  `SetsMerged` root), mapped to its current DSU root at `step` — GitHub issue #146's DSU-groups
   *  extension. Two ids sharing the same value here are in the same connected component of the
   *  spanning tree Kruskal has built so far. Rebuilt from scratch on every call (see `applyKruskal`'s
   *  doc comment on why there's no `from`-based resume). */
  dsuGroups: Map<bigint, bigint>;
  step: number;
  nodeIndex: number;
}

/** Replays Kruskal `EdgeAdded`/`SetsMerged` events up to and including `targetStep` (the index,
 *  within the flat mutating-event sequence from `mutatingKruskalEvents`, of the last event to
 *  apply) — Kruskal's counterpart to `applyRecursiveBacktracker`, simplified: Kruskal declares no
 *  debug values (GitHub issue #131 is RB-only) and produces no checkpoints (#128 is RB-only), so
 *  there is no `debugValues` output and no `from`-based resume — every call replays from the
 *  tape's start. Always O(targetStep) rather than O(1) after a checkpoint, which is acceptable:
 *  Kruskal runs are dominated by their edge count (bounded by field size), not by the tens-of-
 *  thousands-of-events scale checkpointing was built for.
 *
 *  A bidirectional `EdgeAdded` contributes both `{from, to}` and `{to, from}` to `edges` — mirrors
 *  `applyRecursiveBacktracker`'s handling of the same field. `dsuGroups` starts from
 *  `PresetUnionsApplied`'s pairs (if any — see `findPresetUnions`), then folds in every `SetsMerged`
 *  up to `targetStep` via `KruskalDsu.union(rootA, rootB)`, mirroring the core's own
 *  `union_by_min` — so a replayed root always equals what the core actually computed.
 *
 *  `PresetUnionsApplied`'s own pairs are also seeded into `edges` up front (GitHub issue #193),
 *  each carrying its real `kind` (`"basic"`/`"teleport"`) — those preset connections were
 *  pre-merged into the graph before generation started and produced no corresponding `EdgeAdded`
 *  event, so without this they'd never appear in the reconstructed edge list at all (a preset
 *  teleport rendered as entirely absent, not just as a plain passage). Only seeded once, from
 *  `from` when resuming (never re-added on top of an already-seeded `from.edges`) or from the
 *  tape when starting fresh. */
export function applyKruskal(tape: ParsedTape, targetStep: number, from?: KruskalApplyResult, startIndex = 0, endIndex?: number): KruskalApplyResult {
  validateStepShape("targetStep", targetStep);
  if (from) {
    validateStepShape("from.step", from.step);
    validateStepShape("from.nodeIndex", from.nodeIndex);
    if (from.step > targetStep) {
      throw new Error(`applyKruskal: from.step ${from.step} is ahead of targetStep ${targetStep}`);
    }
    if (from.step === targetStep) {
      return { edges: [...from.edges], dsuGroups: new Map(from.dsuGroups), step: targetStep, nodeIndex: from.nodeIndex };
    }
  }

  const scanStart = from ? from.nodeIndex + 1 : startIndex;
  const needed = targetStep - (from?.step ?? -1);
  const events = mutatingKruskalEventsWithIndex(tape, needed, scanStart, endIndex);
  if (events.length < needed) {
    const total = (from?.step ?? -1) + 1 + events.length;
    throw new Error(`targetStep ${targetStep} out of range [0, ${total})`);
  }

  const dsu = new KruskalDsu();
  const edges = from ? [...from.edges] : [];
  if (from) {
    for (const [id, root] of from.dsuGroups) dsu.seed(id, root);
  } else {
    for (const [a, b, kind] of findPresetUnions(tape, startIndex, endIndex ?? tape.nodeCount)) {
      dsu.union(a, b);
      // One tuple per actual directed graph edge (kruskal.rs no longer canonicalizes direction —
      // a two-way preset already yields both (a,b) and (b,a) as separate pairs; a one-way preset
      // yields only the one direction that really exists), so push exactly one edge per pair here,
      // never a fabricated reverse.
      edges.push({ from: a, to: b, kind });
    }
  }

  for (const { event } of events) {
    if (event.kind === "EdgeAdded") {
      edges.push({ from: event.from, to: event.to });
      if (event.bidirectional) {
        edges.push({ from: event.to, to: event.from });
      }
      dsu.find(event.from);
      dsu.find(event.to);
    } else if (event.kind === "SetsMerged") {
      dsu.union(event.rootA, event.rootB);
    }
  }

  return { edges, dsuGroups: dsu.groups(), step: targetStep, nodeIndex: events[events.length - 1].nodeIndex };
}
