/** Shared types and helpers every algorithm's `applyX` function (`recursiveBacktracker.ts`,
 *  `kruskal.ts`, `wilson.ts`, `vertexBased.ts`, `qc.ts`) builds on: the `Edge`/
 *  `DebugValues`/`DebugMaps`/`DebugVertices` result shapes, step-validation, and the
 *  copy-on-write clone/fold helpers every adapter's replay loop repeats. Each `applyX` still owns
 *  its own loop (result shapes differ enough — `edges` vs `edges`+`removedEdges`,
 *  `debugValues`-only vs `debugValues`+`debugMaps`+`debugVertices` — that a single generic loop
 *  would trade this file's clarity for a callback pile), but the pieces that *are* identical live
 *  here once. */

export interface Edge {
  from: bigint;
  to: bigint;
  /** This edge's `EdgeKind` when it isn't a plain `Basic` passage — optional and unset for
   *  RB/Kruskal/Wilson (none of those algorithms produce anything but basic edges); set by
   *  `applyVertexBased` from its own mutating events (`EdgeAdded`/
   *  `CyclicEdgeAdded.teleport` for `"teleport"`, GitHub issue #144's teleport-rendering fix —
   *  `selectDebugMazeView` used to hardcode every reconstructed edge's `EdgeDto.kind` to `"basic"`,
   *  so a teleport edge rendered as a plain passage in debug mode even though the underlying graph
   *  edge was `EdgeKind::Teleport`; `VerticalPassageAdded`/`ElevatorAdded` for `"vertical_passage"`/
   *  `"elevator"`, GitHub issue #337/#347's same class of bug for vertical connections). */
  kind?: "basic" | "teleport" | "vertical_passage" | "elevator";
}

/** A named, session-specific set of node ids an algorithm evolves over the run (e.g. Recursive
 *  Backtracker's `"recursion_stack"`) — mirrors `DebugValueOp`/`DebugValueDelta` in
 *  `maze-core/src/event_log/mod.rs`. Deliberately derived from the *existing* mutating events
 *  (e.g. `VertexPushed`/`VertexPopped`) rather than a separate wire event — see that trait's doc
 *  comment for why (no extra mutating events inflating step numbering, no payload duplication). */
export type DebugValueOp = "insert" | "remove";

/** Semantic shape of a debug value's id collection — mirrors `DebugValueKind` in
 *  `maze-core/src/event_log/mod.rs`. Affects rendering:
 *  - `"region"` — unordered set, no relationship between members (e.g. `"visited"`), rendered as
 *    independent per-node highlights. Reported via `insert`/`remove` on a single id.
 *  - `"sequence"` — ordered list where adjacent members are connected (e.g. `"recursion_stack"`,
 *    the DFS stack in push order), rendered as a chain of arrows between consecutive ids.
 *    Reported the same way as `"region"` (`insert`/`remove` on a single id) — only the rendering
 *    differs.
 *  - `"map"` — key-to-value pairs with overwrite-by-key semantics (e.g. Wilson's
 *    `"current_walk"`, GitHub issue #145's follow-up), rendered as an independent arrow from each
 *    key to its value. Reported via `set`/`clear` (see `DebugMapOp`), not `insert`/`remove` —
 *    `insert`/`remove` on a single id can't express "setting a key that already has a value
 *    replaces it".
 *  - `"vertex"` — a single, reassignable node id, not a `"region"` with one member (e.g. Wilson's
 *    `"walk_start"`/`"walk_head"`, GitHub issue #145's follow-up) — the slot is *replaced*
 *    wholesale rather than accumulating insert/remove entries. Reported via `set`/`clear` (see
 *    `DebugVertexOp`), same shape as `"map"` minus the value half of the pair. */
export type DebugValueKind = "region" | "sequence" | "map" | "vertex";

/** One debug value the instrumented algorithm declares — name plus its rendering kind. Mirrors
 *  the wire pair `GenerateResult::debugValueNames()`/`debugValueKinds()` return (parallel
 *  arrays, zipped together on the JS side — see `mazeService.ts`). */
export interface DebugValueDescriptor {
  name: string;
  kind: DebugValueKind;
}

/** Named debug-value id lists (GitHub issue #131), keyed by name — e.g.
 *  `debugValues.get("recursion_stack")`. `bigint[]`, not `Set<bigint>` — order matters for
 *  `DebugValueKind.Sequence` values (e.g. `"recursion_stack"`, rendered as a chain of arrows
 *  between consecutive ids in insertion order); `Region` values are unordered by nature but a
 *  duplicate-free array is still a valid representation. Never mutated in place by any `applyX`
 *  function; a fresh `Map`/`Array` is built whenever a delta is folded in, mirroring `edges`' own
 *  copy-on-write discipline. */
export type DebugValues = Map<string, bigint[]>;

/** Clones a `DebugValues` map one level deep (fresh `Map` and fresh arrays) — used whenever an
 *  `applyX` function folds in new deltas on top of an existing `from.debugValues`, so the
 *  caller-supplied `from` is never mutated in place (same discipline as `edges`). */
export function cloneDebugValues(values: DebugValues): DebugValues {
  const result: DebugValues = new Map();
  for (const [name, ids] of values) result.set(name, [...ids]);
  return result;
}

/** Set/clear operation on a named map debug value — mirrors `DebugMapOp` in
 *  `maze-core/src/event_log/mod.rs` (GitHub issue #145's follow-up). `"clear"` carries no
 *  key/value (mirrors the Rust enum's unit `Clear` variant not needing placeholder ids). */
export type DebugMapOp =
  | { op: "set"; key: bigint; value: bigint }
  | { op: "clear" };

/** Named map debug-value state (GitHub issue #145's follow-up), keyed by name — e.g.
 *  `debugMaps.get("current_walk")`. Mirrors `DebugValues`' role for `Insert`/`Remove`-based debug
 *  values, but for `Set`/`Clear`-based ones. Never mutated in place; a fresh `Map` is built
 *  whenever a delta is folded in, mirroring `debugValues`'/`edges`' own copy-on-write discipline. */
export type DebugMaps = Map<string, Map<bigint, bigint>>;

/** Clones a `DebugMaps` map two levels deep (fresh outer `Map`, fresh inner `Map` per name) —
 *  same never-mutate-the-caller's-`from` discipline as `cloneDebugValues`. */
export function cloneDebugMaps(maps: DebugMaps): DebugMaps {
  const result: DebugMaps = new Map();
  for (const [name, m] of maps) result.set(name, new Map(m));
  return result;
}

/** Set/clear operation on a named vertex debug value — mirrors `DebugVertexOp` in
 *  `maze-core/src/event_log/mod.rs` (GitHub issue #145's follow-up). `"clear"` carries no id
 *  (mirrors the Rust enum's unit `Clear` variant). */
export type DebugVertexOp =
  | { op: "set"; id: bigint }
  | { op: "clear" };

/** Named vertex debug-value state (GitHub issue #145's follow-up), keyed by name — e.g.
 *  `debugVertices.get("walk_head")`. Each entry is at most one id (or absent, if never set /
 *  cleared) — mirrors `DebugMaps`' role but for a single reassignable slot instead of a map. */
export type DebugVertices = Map<string, bigint | null>;

export function validateStepShape(name: string, step: number): void {
  if (!Number.isInteger(step) || step < 0) {
    throw new Error(`${name} ${step} must be a non-negative integer`);
  }
}

/** Folds one `(name, op, id)` delta into a `DebugValues` map plus its parallel per-name presence
 *  `Set` (kept alongside `ids` purely so `insert`'s dedup check and `remove`'s membership check
 *  are O(1) instead of an O(n) `Array.includes`/`indexOf` scan — without it, a
 *  monotonically-growing Region value, e.g. "visited" with one insert per node and no removes,
 *  makes a full replay O(n²): every scrub/autoplay tick re-scans a list approaching the full node
 *  count on every single insert, GitHub issue #142's follow-up). Mutates `debugValues`/`presence`
 *  in place — callers own the copy-on-write discipline (cloning `from.debugValues` before the
 *  replay loop starts), this helper only folds one delta at a time into whatever maps it's given. */
export function foldDebugValueDelta(
  debugValues: DebugValues,
  presence: Map<string, Set<bigint>>,
  name: string,
  op: DebugValueOp,
  id: bigint,
): void {
  let ids = debugValues.get(name);
  let seen = presence.get(name);
  if (!ids) {
    ids = [];
    debugValues.set(name, ids);
  }
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
