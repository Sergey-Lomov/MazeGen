import type { NodeDto, EdgeDto } from "../wasm/types";
import type { DebugArenaHandle } from "./storeTypes";
import { applyRecursiveBacktracker, nearestCheckpointFromAtOrBefore } from "../debug/eventTape";

export interface DebugMazeView {
  nodes: NodeDto[];
  edges: EdgeDto[];
}

// Single-slot memo, keyed on (arena, debugStep) identity — every consumer (currently just
// GenerationRenderer, GitHub issue #139) shares one reconstructed view per pair instead of each
// independently replaying the tape. A single slot is enough since there is only ever one "current"
// debug step at a time; unrelated store updates (e.g. hoveredDebugRef changing on hover) re-call
// this with the same (arena, debugStep) and now get the same object back, letting callers' own
// identity-keyed caches (e.g. GenerationRenderer's geometryCache) skip rebuilding too.
let lastArena: DebugArenaHandle | null = null;
let lastStep: number | null = null;
let lastView: DebugMazeView | null = null;

/** Reconstructs maze state at `debugStep` from `debugArena` via the replay engine (GitHub issue
 *  #125) — memoized per `(arena, debugStep)` pair (GitHub issue #139) so repeated calls with the
 *  same inputs, whether from one consumer re-rendering or several, share a single replay and a
 *  single stable `edges` reference. Returns `null` when there is no debug arena (debug mode off,
 *  or the last run's algorithm isn't instrumented yet).
 *
 *  Resumes from the nearest intermediate snapshot checkpoint at or before `debugStep` (GitHub
 *  issue #128), when one exists, instead of always replaying from the tape's start — bounds the
 *  cost of scrubbing to a large `debugStep` by `CHECKPOINT_INTERVAL` mutating events rather than
 *  by `debugStep` itself. */
export function selectDebugMazeView(arena: DebugArenaHandle | null, debugStep: number): DebugMazeView | null {
  if (!arena) return null;
  if (lastArena === arena && lastStep === debugStep) return lastView;

  const from = nearestCheckpointFromAtOrBefore(arena.checkpointFroms, debugStep) ?? undefined;
  const { edges } = applyRecursiveBacktracker(arena.tape, debugStep, from);
  const view: DebugMazeView = {
    nodes: arena.nodes,
    edges: edges.map((e) => ({ from: Number(e.from), to: Number(e.to), kind: "basic" as const })),
  };

  lastArena = arena;
  lastStep = debugStep;
  lastView = view;
  return view;
}
