import type { NodeDto, EdgeDto } from "../wasm/types";
import type { DebugArenaHandle } from "./storeTypes";
import { applyRecursiveBacktracker } from "../debug/eventTape";

export interface DebugMazeView {
  nodes: NodeDto[];
  edges: EdgeDto[];
}

/** Reconstructs maze state at `debugStep` from `debugArena` via the replay engine (GitHub issue
 *  #125) — derived on demand, never cached in the store (see `Specs/event_log.md`'s Web Replay
 *  Engine section: no LRU/step-result caching in this pass). Returns `null` when there is no
 *  debug arena (debug mode off, or the last run's algorithm isn't instrumented yet). */
export function selectDebugMazeView(arena: DebugArenaHandle | null, debugStep: number): DebugMazeView | null {
  if (!arena) return null;
  const { edges } = applyRecursiveBacktracker(arena.tape, debugStep);
  return {
    nodes: arena.nodes,
    edges: edges.map((e) => ({ from: Number(e.from), to: Number(e.to), kind: "basic" as const })),
  };
}
