import type { NodeDto, EdgeDto } from "../wasm/types";
import type { DebugArenaHandle } from "./storeTypes";
import { applyRecursiveBacktracker, nearestCheckpointFromAtOrBefore } from "../debug/eventTape";

export interface DebugMazeView {
  nodes: NodeDto[];
  edges: EdgeDto[];
}

/** Reconstructs maze state at `debugStep` from `debugArena` via the replay engine (GitHub issue
 *  #125) — derived on demand, never cached in the store (see `Specs/event_log.md`'s Web Replay
 *  Engine section: no LRU/step-result caching in this pass). Returns `null` when there is no
 *  debug arena (debug mode off, or the last run's algorithm isn't instrumented yet).
 *
 *  Resumes from the nearest intermediate snapshot checkpoint at or before `debugStep` (GitHub
 *  issue #128), when one exists, instead of always replaying from the tape's start — bounds the
 *  cost of scrubbing to a large `debugStep` by `CHECKPOINT_INTERVAL` mutating events rather than
 *  by `debugStep` itself. Still no cross-render caching: each call independently finds its own
 *  nearest checkpoint and replays forward from there. */
export function selectDebugMazeView(arena: DebugArenaHandle | null, debugStep: number): DebugMazeView | null {
  if (!arena) return null;
  const from = nearestCheckpointFromAtOrBefore(arena.checkpointFroms, debugStep) ?? undefined;
  const { edges } = applyRecursiveBacktracker(arena.tape, debugStep, from);
  return {
    nodes: arena.nodes,
    edges: edges.map((e) => ({ from: Number(e.from), to: Number(e.to), kind: "basic" as const })),
  };
}
