/** Bridges two coordinate systems produced by the event-tape replay engine (`eventTape.ts`,
 *  GitHub issue #125) for the right-panel debug tree UI (issue #127): `debugStep` (0-based index
 *  into the flat mutating-event sequence, what playback controls use) and arena node-table
 *  indices (what the tree layer — `nodeView`/`NodeView` — walks). Pure logic, no React/store. */

import type { NodeDto } from "../wasm/types";
import type { EventedEventKind } from "../wasm/mazeService";
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
 *  Contract: only ever called with a tape backed by a non-empty `DebugArenaHandle` (the store
 *  only builds one when `totalSteps > 0` — see `generateConfigBuilder.ts`), so `stepToNodeIndex`
 *  is always non-empty here. Before the first mutating event, `nearestStepByNodeIndex` is
 *  clamped to step 0 — not a separate edge case, just the natural initial value of "last seen
 *  step" given that guarantee.
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

/** First `debugStep` anywhere in `nodeIndex`'s subtree (document/DFS order), or `null` if it
 *  contains no mutating event — a real structural walk via `firstChild`/`nextSibling`, not an
 *  arena-index range scan. A plain "ordinary" scope's subtree *is* the contiguous arena-index
 *  range `[nodeIndex + 1, nextSibling-or-ancestor's-nextSibling)` (the arena's DFS-preorder
 *  linearization invariant), but a top-level source scope's real content is *not* contiguous with
 *  its own index — `merge_tapes` lays every top-level scope's wrapper node out first, before any
 *  source's actual content (`maze-core/src/event_log/mod.rs`), so an index-range scan starting at
 *  `nodeIndex + 1` for a top-level scope would only ever see the next sibling *scope wrapper*, not
 *  real content, and wrongly report no mutating events at all (GitHub issue #147's regression).
 *  Walking `firstChild`/`nextSibling` structurally instead is correct for every scope shape,
 *  top-level or not, without needing to special-case which shape a given `nodeIndex` is. */
function firstStepInSubtree(tape: ParsedTape, stepIndex: StepIndex, nodeIndex: number): number | null {
  const record = nodeAt(tape, nodeIndex);
  let child = record.firstChild;
  while (child !== null) {
    const step = stepIndex.mutatingNodeIndexToStep.get(child);
    if (step !== undefined) return step;
    const nested = firstStepInSubtree(tape, stepIndex, child);
    if (nested !== null) return nested;
    child = nodeAt(tape, child).nextSibling;
  }
  return null;
}

/** The step-column label for a row (left-hand step-number column): a mutating leaf event shows
 *  its own `debugStep`; a trace-only leaf shows `null` (rendered as a dash); a scope shows the
 *  step of the first mutating event anywhere in its subtree (in document/arena-index order), or
 *  `null` if it contains none. */
export function displayStepForRow(
  tape: ParsedTape,
  stepIndex: StepIndex,
  row: Pick<TreeRow, "nodeIndex" | "payload">,
): number | null {
  if (row.payload.kind !== "scope") {
    return stepIndex.mutatingNodeIndexToStep.get(row.nodeIndex) ?? null;
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
export function flattenVisibleRows(
  tape: ParsedTape,
  expanded: ReadonlySet<number>,
  transparentNodeIndices: ReadonlySet<number> = new Set(),
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
    if (depth === 0 || isTransparent || (hasChildren && expanded.has(index))) {
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

/** Resolves the row to scroll to / highlight for the current `debugStep`. If the target node
 *  itself isn't currently visible (a collapsed scope ancestor — per the issue, playback sync
 *  never auto-expands), walks up via the raw `NodeRecord.parent` (not `NodeView.parent()`, which
 *  would allocate a full view object per step of the walk) until it finds a `nodeIndex` present
 *  in `visibleRowIndexByNodeIndex`. Always terminates without reaching `parent === null`: every
 *  top-level "step" scope is unconditionally present in `visibleRowIndexByNodeIndex` (see
 *  `flattenVisibleRows`), so any node's walk up stops at its own top-level ancestor at the
 *  latest. */
export function resolveHighlightTarget(
  tape: ParsedTape,
  stepIndex: StepIndex,
  debugStep: number,
  visibleRowIndexByNodeIndex: ReadonlyMap<number, number>,
): number {
  let nodeIndex: number | null = nodeIndexForStep(stepIndex, debugStep);
  while (nodeIndex !== null && !visibleRowIndexByNodeIndex.has(nodeIndex)) {
    nodeIndex = nodeAt(tape, nodeIndex).parent;
  }
  if (nodeIndex === null) {
    throw new Error(
      `resolveHighlightTarget: no visible ancestor found for debugStep ${debugStep} — ` +
      "visibleRowIndexByNodeIndex must contain every top-level step scope (see flattenVisibleRows)",
    );
  }
  return nodeIndex;
}

export interface NodeCoordIndex {
  get(id: bigint): { x: number; y: number } | null;
}

const coordIndexCache = new WeakMap<NodeDto[], NodeCoordIndex>();

/** Joins RB event node ids (`bigint`, `u64` in core) against `NodeDto.id` for narration text
 *  (`(x, y)` display, per user decision). Keeps the `bigint` key as-is rather than narrowing to
 *  `number` — `NodeId` is a `u64` and narrowing is unsafe in general even though a real maze
 *  will never approach 2^53 nodes in practice. */
export function buildNodeCoordIndex(nodes: NodeDto[]): NodeCoordIndex {
  const cached = coordIndexCache.get(nodes);
  if (cached) return cached;

  const map = new Map<bigint, NodeDto>();
  for (const node of nodes) map.set(BigInt(node.id), node);

  const result: NodeCoordIndex = {
    get(id: bigint) {
      const node = map.get(id);
      return node ? { x: node.x, y: node.y } : null;
    },
  };
  coordIndexCache.set(nodes, result);
  return result;
}
