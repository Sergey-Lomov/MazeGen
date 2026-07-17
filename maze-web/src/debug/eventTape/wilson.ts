// --- Wilson event decoding + replay (GitHub issue #145) ---

import { expectLen, readNodeId, type ParsedTape } from "./wire";
import { mutatingEventsWithIndex, type MutatingEventAt } from "./scan";
import {
  cloneDebugMaps, cloneDebugValues, validateStepShape,
  type DebugMapOp, type DebugMaps, type DebugValueOp, type DebugValues,
  type DebugVertexOp, type DebugVertices, type Edge,
} from "./applyShared";
import { VISITED } from "./recursiveBacktracker";

export const WILSON_TAG = {
  WALK_START_PICKED: 1,
  STEP_TAKEN: 2,
  LOOP_ERASED: 3,
  WALK_DEAD_END: 4,
  EDGE_ADDED: 5,
  NODE_VISITED: 6,
  START_VISITED: 7,
} as const;

export type WilsonEvent =
  | { kind: "StartVisited"; id: bigint }
  | { kind: "WalkStartPicked"; id: bigint }
  | { kind: "StepTaken"; from: bigint; to: bigint }
  | { kind: "LoopErased"; node: bigint }
  | { kind: "WalkDeadEnd" }
  | { kind: "EdgeAdded"; from: bigint; to: bigint; bidirectional: boolean }
  | { kind: "NodeVisited"; id: bigint };

/** Decodes one Wilson event's binary payload. Contract: only called with `tag >= 1` (a real
 *  Wilson wire tag) — callers filter out `TAG_SCOPE` before invoking this. Throws on an
 *  unrecognized tag or a `payload_len` that doesn't match the wire format — mirrors every other
 *  decoder's error-on-mismatch contract (a malformed tape means a core/web build mismatch, which
 *  must surface immediately). */
export function decodeWilsonEvent(tag: number, bytes: Uint8Array): WilsonEvent {
  switch (tag) {
    case WILSON_TAG.START_VISITED:
      expectLen(tag, bytes, 8);
      return { kind: "StartVisited", id: readNodeId(bytes, 0) };
    case WILSON_TAG.WALK_START_PICKED:
      expectLen(tag, bytes, 8);
      return { kind: "WalkStartPicked", id: readNodeId(bytes, 0) };
    case WILSON_TAG.STEP_TAKEN:
      expectLen(tag, bytes, 16);
      return { kind: "StepTaken", from: readNodeId(bytes, 0), to: readNodeId(bytes, 8) };
    case WILSON_TAG.LOOP_ERASED:
      expectLen(tag, bytes, 8);
      return { kind: "LoopErased", node: readNodeId(bytes, 0) };
    case WILSON_TAG.WALK_DEAD_END:
      expectLen(tag, bytes, 0);
      return { kind: "WalkDeadEnd" };
    case WILSON_TAG.EDGE_ADDED:
      expectLen(tag, bytes, 17);
      return { kind: "EdgeAdded", from: readNodeId(bytes, 0), to: readNodeId(bytes, 8), bidirectional: bytes[16] !== 0 };
    case WILSON_TAG.NODE_VISITED:
      expectLen(tag, bytes, 8);
      return { kind: "NodeVisited", id: readNodeId(bytes, 0) };
    default:
      throw new Error(`WilsonEvent: unknown wire tag ${tag}`);
  }
}

/** Mirrors `DebugEvent::is_mutating`'s split for `WilsonEvent` in
 *  `maze-core/src/generation/wilson.rs` — `WalkStartPicked`/`StepTaken`/`LoopErased` are mutating
 *  alongside `EdgeAdded`/`NodeVisited` because they change the walk's `next` map (the state
 *  `applyWilson`'s `"current_walk"` map debug value reconstructs), not because they touch the
 *  graph. */
export function isMutatingWilsonEvent(event: WilsonEvent): boolean {
  return (
    event.kind === "StartVisited" ||
    event.kind === "WalkStartPicked" ||
    event.kind === "StepTaken" ||
    event.kind === "LoopErased" ||
    event.kind === "EdgeAdded" ||
    event.kind === "NodeVisited"
  );
}

export type MutatingWilsonEventAt = MutatingEventAt<WilsonEvent>;

/** Flat layer for Wilson: forward scan over the node table, skipping scope nodes, decoding
 *  events, filtering to mutating ones only. Wilson produces no checkpoints (GitHub issue #128 is
 *  RB-only), same as Kruskal, so this keeps the same `startIndex`/`limit` shape purely for
 *  consistency, not because `applyWilson` resumes. */
export function mutatingWilsonEventsWithIndex(tape: ParsedTape, limit?: number, startIndex = 0, endIndex?: number): MutatingWilsonEventAt[] {
  return mutatingEventsWithIndex(tape, decodeWilsonEvent, isMutatingWilsonEvent, limit, startIndex, endIndex);
}

/** Convenience wrapper over `mutatingWilsonEventsWithIndex` for callers that only need the
 *  decoded events, not their arena indices — mirrors `mutatingKruskalEvents`. */
export function mutatingWilsonEvents(tape: ParsedTape, limit?: number, startIndex = 0, endIndex?: number): WilsonEvent[] {
  return mutatingWilsonEventsWithIndex(tape, limit, startIndex, endIndex).map((e) => e.event);
}

/** Mirrors `WilsonEvent`'s `DebugValueDelta` impl (`"visited"`-only) in
 *  `maze-core/src/generation/wilson.rs`. */
function wilsonDebugValueDeltasFor(event: WilsonEvent): [string, DebugValueOp, bigint][] {
  return event.kind === "StartVisited" || event.kind === "NodeVisited" ? [[VISITED, "insert", event.id]] : [];
}

export const CURRENT_WALK = "current_walk";

/** Mirrors `WilsonEvent`'s `DebugMapDelta` impl (`"current_walk"`) in
 *  `maze-core/src/generation/wilson.rs`: `StepTaken` sets `next[from] = to` (overwriting any
 *  prior value for `from`, exactly like `HashMap::insert`); `WalkStartPicked` clears the map so a
 *  new walk starts with an empty track; `LoopErased` needs no delta of its own (the preceding
 *  `StepTaken` already performed the overwrite). */
function wilsonDebugMapDeltasFor(event: WilsonEvent): [string, DebugMapOp][] {
  if (event.kind === "WalkStartPicked") return [[CURRENT_WALK, { op: "clear" }]];
  if (event.kind === "StepTaken") return [[CURRENT_WALK, { op: "set", key: event.from, value: event.to }]];
  return [];
}

export const WALK_START = "walk_start";
export const WALK_HEAD = "walk_head";

/** Mirrors `WilsonEvent`'s `DebugVertexDelta` impl (`"walk_start"`/`"walk_head"`) in
 *  `maze-core/src/generation/wilson.rs`: `WalkStartPicked` sets both slots to the walk's origin
 *  (the head starts out equal to the start, before any step); each `StepTaken` then moves only
 *  `walk_head` to `to`. Deliberately *not* derived from `current_walk`'s `Map` state (e.g. "last
 *  key in insertion order") — a `HashMap::insert`-style overwrite of an existing key (which loop
 *  erasure causes) doesn't move that key's position, so "last key" can silently stop tracking the
 *  walk's actual current position once a walk revisits a node. */
function wilsonDebugVertexDeltasFor(event: WilsonEvent): [string, DebugVertexOp][] {
  if (event.kind === "WalkStartPicked") {
    return [[WALK_START, { op: "set", id: event.id }], [WALK_HEAD, { op: "set", id: event.id }]];
  }
  if (event.kind === "StepTaken") return [[WALK_HEAD, { op: "set", id: event.to }]];
  return [];
}

export interface WilsonApplyResult {
  edges: Edge[];
  /** `"visited"` only (GitHub issue #131) — mirrors `debugValues` on `ApplyResult`/`applyRecursiveBacktracker`. */
  debugValues: DebugValues;
  /** `"current_walk"` only (GitHub issue #145's follow-up) — the walk's `next` map (`from` node ->
   *  `to` node) at `step`, reset empty at every `WalkStartPicked`. See `wilsonDebugMapDeltasFor`'s
   *  doc comment for the exact replay rule. */
  debugMaps: DebugMaps;
  /** `"walk_start"`/`"walk_head"` (GitHub issue #145's follow-up) — see `wilsonDebugVertexDeltasFor`'s
   *  doc comment for the exact replay rule. */
  debugVertices: DebugVertices;
  step: number;
  nodeIndex: number;
}

/** Replays Wilson events up to and including `targetStep` (the index, within the flat
 *  mutating-event sequence from `mutatingWilsonEvents`, of the last event to apply) — Wilson's
 *  counterpart to `applyKruskal`: no checkpoints (GitHub issue #128 is RB-only), so every call
 *  replays from the tape's start, same as `applyKruskal`. Unlike `applyKruskal`, Wilson declares
 *  one `Insert`/`Remove`-based debug value (`"visited"`), one `Set`/`Clear`-based map
 *  (`"current_walk"`), and two `Set`/`Clear`-based vertices (`"walk_start"`/`"walk_head"`).
 *
 *  A bidirectional `EdgeAdded` contributes both `{from, to}` and `{to, from}` to `edges` — mirrors
 *  `applyRecursiveBacktracker`/`applyKruskal`'s handling of the same field. */
export function applyWilson(tape: ParsedTape, targetStep: number, from?: WilsonApplyResult, startIndex = 0, endIndex?: number): WilsonApplyResult {
  validateStepShape("targetStep", targetStep);
  if (from) {
    validateStepShape("from.step", from.step);
    validateStepShape("from.nodeIndex", from.nodeIndex);
    if (from.step > targetStep) {
      throw new Error(`applyWilson: from.step ${from.step} is ahead of targetStep ${targetStep}`);
    }
    if (from.step === targetStep) {
      return {
        edges: [...from.edges],
        debugValues: cloneDebugValues(from.debugValues),
        debugMaps: cloneDebugMaps(from.debugMaps),
        debugVertices: new Map(from.debugVertices),
        step: targetStep,
        nodeIndex: from.nodeIndex,
      };
    }
  }

  const scanStart = from ? from.nodeIndex + 1 : startIndex;
  const needed = targetStep - (from?.step ?? -1);
  const events = mutatingWilsonEventsWithIndex(tape, needed, scanStart, endIndex);
  if (events.length < needed) {
    const total = (from?.step ?? -1) + 1 + events.length;
    throw new Error(`targetStep ${targetStep} out of range [0, ${total})`);
  }

  const edges = from ? [...from.edges] : [];
  const debugValues: DebugValues = from ? cloneDebugValues(from.debugValues) : new Map();
  // Presence tracked per debug-value name (mirrors applyEdgeBased's own discipline) — Wilson
  // declares only one Insert/Remove-based value ("visited") today, but a single shared Set would
  // silently misbehave the moment a second one is added, so this doesn't take the VISITED-only
  // shortcut a single Set would tempt.
  const presence = new Map<string, Set<bigint>>();
  for (const [name, ids] of debugValues) presence.set(name, new Set(ids));
  const debugMaps: DebugMaps = from ? cloneDebugMaps(from.debugMaps) : new Map();
  const debugVertices: DebugVertices = from ? new Map(from.debugVertices) : new Map();

  for (const { event } of events) {
    if (event.kind === "EdgeAdded") {
      edges.push({ from: event.from, to: event.to });
      if (event.bidirectional) {
        edges.push({ from: event.to, to: event.from });
      }
    }
    for (const [name, op, id] of wilsonDebugValueDeltasFor(event)) {
      let ids = debugValues.get(name);
      if (!ids) {
        ids = [];
        debugValues.set(name, ids);
      }
      let seen = presence.get(name);
      if (!seen) {
        seen = new Set();
        presence.set(name, seen);
      }
      if (op === "insert") {
        if (!seen.has(id)) { seen.add(id); ids.push(id); }
      } else if (seen.delete(id)) {
        const at = ids.indexOf(id);
        if (at !== -1) ids.splice(at, 1);
      }
    }
    for (const [name, mapOp] of wilsonDebugMapDeltasFor(event)) {
      if (mapOp.op === "clear") {
        debugMaps.set(name, new Map());
      } else {
        let map = debugMaps.get(name);
        if (!map) {
          map = new Map();
          debugMaps.set(name, map);
        }
        map.set(mapOp.key, mapOp.value);
      }
    }
    for (const [name, vertexOp] of wilsonDebugVertexDeltasFor(event)) {
      debugVertices.set(name, vertexOp.op === "clear" ? null : vertexOp.id);
    }
  }

  return { edges, debugValues, debugMaps, debugVertices, step: targetStep, nodeIndex: events[events.length - 1].nodeIndex };
}
