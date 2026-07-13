/** Bridges two coordinate systems produced by the event-tape replay engine (`eventTape.ts`,
 *  GitHub issue #125) for the right-panel debug tree UI (issue #127): `debugStep` (0-based index
 *  into the flat mutating-event sequence, what playback controls use) and arena node-table
 *  indices (what the tree layer — `nodeView`/`NodeView` — walks). Pure logic, no React/store. */

import type { NodeDto } from "../wasm/types";
import type { ParsedTape, NodePayload } from "./eventTape";
import { nodeAt, nodeView, mutatingRbEventsWithIndex } from "./eventTape";

export interface StepIndex {
  /** debugStep -> arena nodeIndex. Length === totalSteps. */
  stepToNodeIndex: number[];
  /** arena nodeIndex -> nearest debugStep at or before that node (DFS-preorder = arena index
   *  order = emission order, per the arena's linearization invariant, so "nearest at or before"
   *  is well-defined by construction). Length === tape.nodeCount. */
  nearestStepByNodeIndex: number[];
}

const stepIndexCache = new WeakMap<ParsedTape, StepIndex>();

/** Builds both mappings in one forward pass over `[0, nodeCount)`.
 *
 *  Contract: only ever called with a tape backed by a non-empty `DebugArenaHandle` (the store
 *  only builds one when `totalSteps > 0` — see `generateConfigBuilder.ts`), so `stepToNodeIndex`
 *  is always non-empty here. Before the first mutating event, `nearestStepByNodeIndex` is
 *  clamped to step 0 — not a separate edge case, just the natural initial value of "last seen
 *  step" given that guarantee. */
export function buildStepIndex(tape: ParsedTape): StepIndex {
  const cached = stepIndexCache.get(tape);
  if (cached) return cached;

  const mutating = mutatingRbEventsWithIndex(tape);
  const mutatingNodeIndexSet = new Map<number, number>();
  mutating.forEach(({ nodeIndex }, step) => mutatingNodeIndexSet.set(nodeIndex, step));

  const stepToNodeIndex = mutating.map((m) => m.nodeIndex);
  const nearestStepByNodeIndex = new Array<number>(tape.nodeCount);
  let currentStep = 0;
  for (let i = 0; i < tape.nodeCount; i++) {
    const step = mutatingNodeIndexSet.get(i);
    if (step !== undefined) currentStep = step;
    nearestStepByNodeIndex[i] = currentStep;
  }

  const result: StepIndex = { stepToNodeIndex, nearestStepByNodeIndex };
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

/** DFS over the tree layer, flattened to only the rows currently visible given `expanded`. The
 *  root (arena index 0) is never itself a row — it is not a "step", just the tree's wrapper —
 *  its direct children (the top-level `"step"` scopes) are always included regardless of
 *  `expanded`; deeper descendants only appear once their parent scope is in `expanded`. */
export function flattenVisibleRows(tape: ParsedTape, expanded: ReadonlySet<number>): TreeRow[] {
  const rows: TreeRow[] = [];

  function visit(index: number, depth: number): void {
    const record = nodeAt(tape, index);
    const hasChildren = record.firstChild !== null;
    if (depth > 0) {
      const view = nodeView(tape, index);
      rows.push({ nodeIndex: index, depth, payload: view.payload(), hasChildren });
    }
    if (depth === 0 || (hasChildren && expanded.has(index))) {
      let child = record.firstChild;
      while (child !== null) {
        const childRecord = nodeAt(tape, child);
        visit(child, depth + 1);
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
