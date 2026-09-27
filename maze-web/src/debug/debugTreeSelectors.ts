/** Bridges two coordinate systems produced by the event-tape replay engine (`eventTape.ts`,
 *  GitHub issue #125) for the right-panel debug tree UI (issue #127): `debugStep` (0-based index
 *  into the flat mutating-event sequence, what playback controls use) and arena node-table
 *  indices (what the tree layer — `nodeView`/`NodeView` — walks). Pure logic, no React/store. */

import type { NodeDto } from "../wasm/types";
import type { EventedEventKind } from "../wasm/mazeService";
import type { HoveredDebugRef } from "../store/storeTypes";
import type { ParsedTape, NodePayload } from "./eventTape";
import { nodeAt, nodeView, sourceContentStart } from "./eventTape";
import { adapterForKind } from "./algorithmRegistry";

export interface StepIndex {
  /** debugStep -> arena nodeIndex. Length === totalSteps. */
  stepToNodeIndex: number[];
  /** arena nodeIndex -> nearest debugStep at or before that node (DFS-preorder = arena index
   *  order = emission order, per the arena's linearization invariant, so "nearest at or before"
   *  is well-defined by construction). Length === tape.nodeCount. */
  nearestStepByNodeIndex: number[];
  /** arena nodeIndex -> debugStep, but only for nodes that are themselves a mutating event
   *  (exact membership, unlike `nearestStepByNodeIndex`'s "at or before" semantics) — backs the
   *  step-column label (`displayStepForRow`). */
  mutatingNodeIndexToStep: ReadonlyMap<number, number>;
}

const stepIndexCache = new WeakMap<ParsedTape, StepIndex>();

/** Builds both mappings in one forward pass over `[0, nodeCount)`.
 *
 *  `stepToNodeIndex` can be empty (GitHub issue #173 — a `qc_experiment` run with zero repair
 *  mutations still builds a `DebugArenaHandle`, just with `totalSteps: 0`) — callers that index
 *  into it by `debugStep` (`nodeIndexForStep`, `resolveHighlightTarget`) must check length first
 *  rather than assume a match always exists. Before the first mutating event (or when there is
 *  none at all), `nearestStepByNodeIndex` is clamped to step 0 — not a separate edge case, just
 *  the natural initial value of "last seen step".
 *
 *  `sources` (GitHub issue #147) is one entry per top-level source scope, in the same order as
 *  `debugArena.sources`/`topLevelSourceScopes` — global `debugStep` numbering (Contract A,
 *  `Specs/event_log.md`'s #147 section) means `stepToNodeIndex` is built by concatenating each
 *  source's own `mutatingNodeIndices()` in scope order: source 0's steps come first, source 1's
 *  immediately after, with no interleaving — this mirrors how `debugArena.sources[i].startStep/
 *  endStep` are computed in `generateConfigBuilder.ts`. Defaults to a single implicit
 *  `recursive_backtracker` source starting at arena index 0 when omitted, for callers (mostly
 *  tests) working with a single, unwrapped, single-source tape that predates GitHub issue #169's
 *  merge-wrapper shape. */
export function buildStepIndex(
  tape: ParsedTape,
  sources: readonly { kind: EventedEventKind; nodeIndex: number }[] = [{ kind: "recursive_backtracker", nodeIndex: 0 }],
): StepIndex {
  const cached = stepIndexCache.get(tape);
  if (cached) return cached;

  const mutatingNodeIndices: number[] = [];
  for (let i = 0; i < sources.length; i++) {
    const source = sources[i];
    // See `sourceContentStart`'s doc comment (GitHub issue #147) for why this isn't just
    // `source.nodeIndex`/`sources[i + 1].nodeIndex`.
    const startIndex = sourceContentStart(tape, source.nodeIndex);
    const endIndex = i + 1 < sources.length ? sourceContentStart(tape, sources[i + 1].nodeIndex) : tape.nodeCount;
    mutatingNodeIndices.push(...adapterForKind(source.kind).mutatingNodeIndices(tape, startIndex, endIndex));
  }
  const mutatingNodeIndexSet = new Map<number, number>();
  mutatingNodeIndices.forEach((nodeIndex, step) => mutatingNodeIndexSet.set(nodeIndex, step));

  const stepToNodeIndex = mutatingNodeIndices;
  const nearestStepByNodeIndex = new Array<number>(tape.nodeCount);
  let currentStep = 0;
  for (let i = 0; i < tape.nodeCount; i++) {
    const step = mutatingNodeIndexSet.get(i);
    if (step !== undefined) currentStep = step;
    nearestStepByNodeIndex[i] = currentStep;
  }

  const result: StepIndex = { stepToNodeIndex, nearestStepByNodeIndex, mutatingNodeIndexToStep: mutatingNodeIndexSet };
  stepIndexCache.set(tape, result);
  return result;
}

/** Row click -> jump-to-step. O(1). Always returns a number (never `null`) — the "no preceding
 *  mutating event" case is already resolved inside `buildStepIndex` (clamp to step 0). */
export function stepForNode(stepIndex: StepIndex, arenaNodeIndex: number): number {
  return stepIndex.nearestStepByNodeIndex[arenaNodeIndex];
}

/** Playback -> highlight. O(1). */
export function nodeIndexForStep(stepIndex: StepIndex, debugStep: number): number {
  return stepIndex.stepToNodeIndex[debugStep];
}

export interface TreeRow {
  nodeIndex: number;
  depth: number;
  payload: NodePayload;
  hasChildren: boolean;
}

/** `debugStep` of `nodeIndex`'s subtree's first child (document/DFS order) — mutating or
 *  trace-only alike, a trace-only child resolving to its nearest preceding mutating step just
 *  like a leaf row does (GitHub issue #186: a scope's displayed step must always be its first
 *  child's step, never skip ahead to the first *mutating* one) — or `null` if the subtree is
 *  empty. A real structural walk via `firstChild`/`nextSibling`, not an arena-index range scan. A
 *  plain "ordinary" scope's subtree *is* the contiguous arena-index range `[nodeIndex + 1,
 *  nextSibling-or-ancestor's-nextSibling)` (the arena's DFS-preorder linearization invariant), but
 *  a top-level source scope's real content is *not* contiguous with its own index — `merge_tapes`
 *  lays every top-level scope's wrapper node out first, before any source's actual content
 *  (`maze-core/src/event_log/mod.rs`), so an index-range scan starting at `nodeIndex + 1` for a
 *  top-level scope would only ever see the next sibling *scope wrapper*, not real content, and
 *  wrongly report no mutating events at all (GitHub issue #147's regression). Walking
 *  `firstChild`/`nextSibling` structurally instead is correct for every scope shape, top-level or
 *  not, without needing to special-case which shape a given `nodeIndex` is. */
function firstStepInSubtree(tape: ParsedTape, stepIndex: StepIndex, nodeIndex: number): number | null {
  const record = nodeAt(tape, nodeIndex);
  const child = record.firstChild;
  if (child === null) return null;
  const view = nodeView(tape, child);
  if (view.payload().kind === "scope") return firstStepInSubtree(tape, stepIndex, child);
  return stepIndex.mutatingNodeIndexToStep.get(child) ?? stepIndex.nearestStepByNodeIndex[child];
}

/** The step-column label for a row (left-hand step-number column): a mutating leaf event shows
 *  its own `debugStep`; a trace-only leaf shows the nearest preceding mutating step (GitHub issue
 *  #166 — the step already executed at the time this trace event was emitted), never `null`; a
 *  scope shows the step of its own first child (document/arena-index order), mutating or
 *  trace-only alike (GitHub issue #186), or `null` if it has no children at all. */
export function displayStepForRow(
  tape: ParsedTape,
  stepIndex: StepIndex,
  row: Pick<TreeRow, "nodeIndex" | "payload">,
): number | null {
  if (row.payload.kind !== "scope") {
    return stepIndex.mutatingNodeIndexToStep.get(row.nodeIndex) ?? stepIndex.nearestStepByNodeIndex[row.nodeIndex];
  }
  return firstStepInSubtree(tape, stepIndex, row.nodeIndex);
}

/** DFS over the tree layer, flattened to only the rows currently visible given `expanded`. The
 *  tape's own root (arena index 0) is never itself a row — it is not a "step", just the tree's
 *  wrapper — its direct children are always included regardless of `expanded`.
 *
 *  `transparentNodeIndices` (GitHub issue #147) names additional nodes to skip the exact same way
 *  the root is skipped: never their own row, always expanded, their children rendered one depth
 *  shallower than they'd otherwise sit at. The intended caller is `DebugEventTree.tsx`, passing
 *  each top-level source scope's own former-root merge artifact — every source's own tape (before
 *  merging, GitHub issue #169) is built by `EventLog::new()`, whose root becomes that source's
 *  sole child once `merge_tapes` reparents it under a new top-level source scope
 *  (`maze-core/src/event_log/mod.rs`), never renamed or removed, so every source's real content
 *  sits one extra, purely structural level deeper than its top-level source scope. Rendering it as
 *  its own row would show a meaningless "step 0"-shaped label (no adapter's `scopeLabel` was ever
 *  designed to name a plain former-root scope) between the source scope and its real steps.
 *
 *  Deliberately *not* inferred from tree shape (e.g. "any depth-2 scope") inside this function —
 *  `flattenVisibleRows` is a generic tree-flattening utility with no built-in notion of merged
 *  tapes/source scopes; a fixed-depth heuristic here would misfire on any non-merged or
 *  differently-shaped tree (this module's own unit tests build several). Callers that know which
 *  nodes are merge artifacts (via `topLevelSourceScopes`) say so explicitly instead. Defaults to
 *  empty, so callers unaware of merge semantics keep exactly their previous behavior. */
/** Module-level empty set — a shared immutable default so callers that don't pass
 *  `transparentNodeIndices` don't allocate a fresh `Set` per call (and don't destabilize a
 *  `useMemo` that lists it as a dependency). */
const EMPTY_NODE_INDEX_SET: ReadonlySet<number> = new Set();

/** Shared DFS walk backing `flattenVisibleRows` and `allRenderableRows` (GitHub issue #482).
 *  `descend(index, hasChildren)` decides whether to recurse into a node's children — the only
 *  difference between the two callers: the visible-rows walk gates on `expanded`, the all-rows
 *  walk always descends. Root (index 0) and `transparentNodeIndices` are skipped as rows and
 *  rendered one depth shallower, identically for both. */
function walkTree(
  tape: ParsedTape,
  transparentNodeIndices: ReadonlySet<number>,
  descend: (index: number, hasChildren: boolean) => boolean,
): TreeRow[] {
  const rows: TreeRow[] = [];

  function visit(index: number, depth: number): void {
    const record = nodeAt(tape, index);
    const hasChildren = record.firstChild !== null;
    const isTransparent = depth > 0 && transparentNodeIndices.has(index);
    if (depth > 0 && !isTransparent) {
      const view = nodeView(tape, index);
      rows.push({ nodeIndex: index, depth, payload: view.payload(), hasChildren });
    }
    if (depth === 0 || isTransparent || (hasChildren && descend(index, hasChildren))) {
      let child = record.firstChild;
      while (child !== null) {
        const childRecord = nodeAt(tape, child);
        visit(child, isTransparent ? depth : depth + 1);
        child = childRecord.nextSibling;
      }
    }
  }

  visit(0, 0);
  return rows;
}

export function flattenVisibleRows(
  tape: ParsedTape,
  expanded: ReadonlySet<number>,
  transparentNodeIndices: ReadonlySet<number> = EMPTY_NODE_INDEX_SET,
): TreeRow[] {
  return walkTree(tape, transparentNodeIndices, (index) => expanded.has(index));
}

/** Every row the tree *could* show, ignoring the current `expanded` state — the collapsed-scope-
 *  independent row set the debug search index (`buildSearchMatches`) is built over (GitHub issue
 *  #482), so a match inside a collapsed scope is still found. Same row shape, skip rules, and
 *  DFS order (= visual row order) as `flattenVisibleRows` with everything expanded.
 *
 *  Callers building the search index MUST pass the real `transparentNodeIndices` (each merged
 *  source's former-root artifact) — with the default empty set those nodes would appear as rows
 *  with a meaningless label. */
export function allRenderableRows(
  tape: ParsedTape,
  transparentNodeIndices: ReadonlySet<number> = EMPTY_NODE_INDEX_SET,
): TreeRow[] {
  return walkTree(tape, transparentNodeIndices, () => true);
}

/** Resolves the row to scroll to / highlight for the current `debugStep`. If the target node
 *  itself isn't currently visible (a collapsed scope ancestor — per the issue, playback sync
 *  never auto-expands), walks up via the raw `NodeRecord.parent` (not `NodeView.parent()`, which
 *  would allocate a full view object per step of the walk) until it finds a `nodeIndex` present
 *  in `visibleRowIndexByNodeIndex`. Always terminates without reaching `parent === null`: every
 *  top-level "step" scope is unconditionally present in `visibleRowIndexByNodeIndex` (see
 *  `flattenVisibleRows`), so any node's walk up stops at its own top-level ancestor at the
 *  latest.
 *
 *  `stepIndex.stepToNodeIndex` can be empty (GitHub issue #173 — a `qc_experiment` run with zero
 *  repair mutations still builds a debug arena, just with `totalSteps: 0`) — `nodeIndexForStep`
 *  then has no arena index for `debugStep` to resolve, so this falls back to `fallbackNodeIndex`
 *  (the caller's first top-level source scope — the merged tape's own root, arena index 0, is
 *  never itself a row per `flattenVisibleRows`'s doc comment, so it can't serve as this
 *  fallback). */
export function resolveHighlightTarget(
  tape: ParsedTape,
  stepIndex: StepIndex,
  debugStep: number,
  visibleRowIndexByNodeIndex: ReadonlyMap<number, number>,
  fallbackNodeIndex: number,
): number {
  const start =
    debugStep < stepIndex.stepToNodeIndex.length ? nodeIndexForStep(stepIndex, debugStep) : fallbackNodeIndex;
  return nearestVisibleAncestor(tape, start, visibleRowIndexByNodeIndex);
}

/** Walks up via the raw `NodeRecord.parent` (not `NodeView.parent()`, which allocates a full view
 *  object per step) from `nodeIndex` until it finds a node present in `visibleRowIndexByNodeIndex`,
 *  returning that node — `nodeIndex` itself if it's already visible. Always terminates without
 *  reaching `parent === null`: every top-level source/step scope is unconditionally present in
 *  the visible-rows map (see `flattenVisibleRows`), so any walk stops at its top-level ancestor at
 *  the latest. Throws if it somehow reaches the root without a hit (a malformed visible-rows map).
 *  Used both by `resolveHighlightTarget` (playback highlight) and by the debug tree's search-match
 *  focus-scroll (GitHub issue #482), where the target may be a scope/trace node with no `debugStep`. */
export function nearestVisibleAncestor(
  tape: ParsedTape,
  nodeIndex: number,
  visibleRowIndexByNodeIndex: ReadonlyMap<number, number>,
): number {
  let current: number | null = nodeIndex;
  while (current !== null && !visibleRowIndexByNodeIndex.has(current)) {
    current = nodeAt(tape, current).parent;
  }
  if (current === null) {
    throw new Error(
      `nearestVisibleAncestor: no visible ancestor found for node ${nodeIndex} — ` +
      "visibleRowIndexByNodeIndex must contain every top-level scope (see flattenVisibleRows)",
    );
  }
  return current;
}

/** Substring search over the debug event tree's rendered row text (GitHub issue #482). `rows` is
 *  the full renderable-row set in visual order (from `allRenderableRows` + `buildDebugRowText` +
 *  `normalizeSearchText`, done once per tape in `DebugEventTree`); `normalizedQuery` is the
 *  already-trimmed, already-case-folded query (empty string when there's nothing to search).
 *  Returns the matching rows' arena node indices, order preserved (= visual row order — never
 *  re-sorted). Pure: no knowledge of tokens, adapters, or the store. */
export function buildSearchMatches(
  rows: ReadonlyArray<{ nodeIndex: number; text: string }>,
  normalizedQuery: string,
): number[] {
  if (normalizedQuery === "") return [];
  const result: number[] = [];
  for (const row of rows) {
    if (row.text.includes(normalizedQuery)) result.push(row.nodeIndex);
  }
  return result;
}

export interface NodeCoordIndex {
  /** `i` is `NodeDto.i` — the node's 0-based per-point index (`0` = the point's original node);
   *  `split` is true when more than one node sits at this point on this floor, i.e. a split point
   *  (GitHub issue #468 — used to append a "Node N" suffix to a split node's narration label). */
  get(id: bigint): { x: number; y: number; level: number; i: number; split: boolean } | null;
}

const coordIndexCache = new WeakMap<NodeDto[], NodeCoordIndex>();

/** Joins RB event node ids (`bigint`, `u64` in core) against `NodeDto.id` for narration text
 *  (`(x, y)` display, per user decision) and, since GitHub issue #350, the node's floor (used to
 *  prefix a multi-floor maze's bubble label and to drive floor-switching on bubble click — see
 *  `DebugEventTree.tsx`'s `bubbleLabel`/`resolveBubbleFloor`). Keeps the `bigint` key as-is rather
 *  than narrowing to `number` — `NodeId` is a `u64` and narrowing is unsafe in general even though
 *  a real maze will never approach 2^53 nodes in practice. */
export function buildNodeCoordIndex(nodes: NodeDto[]): NodeCoordIndex {
  const cached = coordIndexCache.get(nodes);
  if (cached) return cached;

  const map = new Map<bigint, NodeDto>();
  for (const node of nodes) map.set(BigInt(node.id), node);

  // Point-key ("x,y,level") -> node count, to flag split points (GitHub issue #468).
  const countByPoint = new Map<string, number>();
  for (const node of map.values()) {
    const key = `${node.x},${node.y},${node.level ?? 0}`;
    countByPoint.set(key, (countByPoint.get(key) ?? 0) + 1);
  }

  const result: NodeCoordIndex = {
    get(id: bigint) {
      const node = map.get(id);
      if (!node) return null;
      const level = node.level ?? 0;
      const split = (countByPoint.get(`${node.x},${node.y},${level}`) ?? 0) > 1;
      return { x: node.x, y: node.y, level, i: node.i, split };
    },
  };
  coordIndexCache.set(nodes, result);
  return result;
}

/** Resolves which floor, if any, a clicked debug-tree ref bubble (GitHub issue #350) should
 *  switch the active floor to. `null` means "don't switch" — either every referenced node is
 *  already on the same floor as `currentFloorIndex`, the ids don't resolve to a floor at all
 *  (stale tape reference), or there's no single floor to jump to.
 *
 *  `edge`/`issue`-with-cycle-target is the one case with two floors in play at once
 *  (`vertical_passage`/`elevator` connect different floors) — per explicit user decision: switch
 *  to `from`'s floor unless already standing on `to`'s floor, in which case stay put rather than
 *  jumping back to `from`. Every other multi-id shape (`cycle`, `region`, `issue`-with-region-
 *  target) has no such asymmetry — if every referenced node shares one floor, jump there;
 *  otherwise stay (there's no principled single target floor to pick). */
export function resolveBubbleFloor(
  target: HoveredDebugRef,
  coords: (id: bigint) => { level: number } | null,
  currentFloorIndex: number,
): number | null {
  const levelOf = (id: bigint): number | null => coords(id)?.level ?? null;

  const singleFloorOf = (ids: bigint[]): number | null => {
    if (ids.length === 0) return null;
    const levels = ids.map(levelOf);
    if (levels.some((l) => l === null)) return null;
    const first = levels[0] as number;
    return levels.every((l) => l === first) ? first : null;
  };

  switch (target.kind) {
    case "node":
      return levelOf(target.id);
    case "edge": {
      const fromLevel = levelOf(target.from);
      const toLevel = levelOf(target.to);
      if (fromLevel === null || toLevel === null) return null;
      if (fromLevel === toLevel) return fromLevel;
      return currentFloorIndex === toLevel ? null : fromLevel;
    }
    case "cycle":
      return singleFloorOf(target.edges.flatMap(([f, t]) => [f, t]));
    case "region":
      return singleFloorOf(target.nodes);
    case "issue": {
      if (!target.target) return null;
      const ids = [
        ...(target.target.cycle?.edges.flatMap(([f, t]) => [f, t]) ?? []),
        ...(target.target.region?.groups.flatMap((group) => group.nodes) ?? []),
      ];
      return singleFloorOf(ids);
    }
  }
}

/** Every distinct floor an `issue` bubble's structural payload touches, deduplicated and sorted
 *  ascending — drives the debug issue bubble's `FloorBadgeRow` (GitHub issue #467), matching the
 *  Analytics `IssueBubble`'s own `IssueFloorBadges` behavior. Unlike `resolveBubbleFloor` this
 *  keeps every resolved floor rather than collapsing a multi-floor payload to `null`, and it
 *  silently skips ids that don't resolve (stale/removed node), same convention as
 *  `IssueFloorBadges`. Returns `[]` for a non-`issue` target or an issue with no `target` payload
 *  (a whole-maze issue with no per-element highlight data — nothing to badge). */
export function resolveIssueBubbleFloors(
  target: HoveredDebugRef,
  coords: (id: bigint) => { level: number } | null,
): number[] {
  if (target.kind !== "issue" || !target.target) return [];
  const ids = [
    ...(target.target.cycle?.edges.flatMap(([f, t]) => [f, t]) ?? []),
    ...(target.target.region?.groups.flatMap((group) => group.nodes) ?? []),
  ];
  const levels = new Set<number>();
  for (const id of ids) {
    const level = coords(id)?.level;
    if (level !== undefined) levels.add(level);
  }
  return Array.from(levels).sort((a, b) => a - b);
}
