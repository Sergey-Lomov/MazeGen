import type { NodeDto, EdgeDto } from "../wasm/types";
import type { DebugArenaHandle } from "./storeTypes";
import { nearestCheckpointFromAtOrBefore } from "../debug/eventTape";
import { adapterFor } from "../debug/algorithmRegistry";

export interface DebugMazeView {
  nodes: NodeDto[];
  edges: EdgeDto[];
  /** Debug-value id lists (GitHub issue #131) reconstructed at this step, keyed by name — e.g.
   *  `debugValues.get("recursion_stack")`. Node ids as `number` (already joined against `NodeDto.id`,
   *  unlike the `bigint` ids the replay engine itself works in). `number[]`, not a `Set` — order
   *  matters for `DebugValueKind.Sequence` values, which `DebugValueHighlightOverlay` renders as
   *  an arrow chain in this order. Always empty for Kruskal (GitHub issue #131 is RB-only, plus
   *  Wilson's own `"visited"` value — see `wilson::debug_value_names()`). */
  debugValues: Map<string, number[]>;
  /** Kruskal's union-find groups (GitHub issue #146's DSU-groups extension) reconstructed at this
   *  step, keyed by node id (`number`, already joined against `NodeDto.id`) mapped to its current
   *  DSU root (also a joined `number`). Two nodes sharing the same value are in the same connected
   *  component of the spanning tree built so far. `null` for Recursive Backtracker and Wilson (no
   *  DSU concept — GitHub issue #145) and whenever there's no debug arena. */
  dsuGroups: Map<number, number> | null;
  /** Named map debug-value state (GitHub issue #145's follow-up, e.g. Wilson's `"current_walk"`)
   *  reconstructed at this step, keyed by name — e.g. `debugMaps.get("current_walk")`. Each value
   *  is a `from` node id (`number`, already joined against `NodeDto.id`) mapped to a `to` node id.
   *  Mirrors `debugValues` above but for `Set`/`Clear`-based debug values (see `DebugValueKind.Map`
   *  in `maze-core/src/event_log/mod.rs` — overwrite-by-key semantics `Insert`/`Remove` can't
   *  express). Always empty for algorithms that declare no map-shaped debug values. */
  debugMaps: Map<string, Map<number, number>>;
  /** Named vertex debug-value state (GitHub issue #145's follow-up, e.g. Wilson's
   *  `"walk_start"`/`"walk_head"`) reconstructed at this step, keyed by name — e.g.
   *  `debugVertices.get("walk_head")`. Each entry is a single node id (`number`, already joined
   *  against `NodeDto.id`) or `null` if the slot was never set / was cleared. Mirrors `debugMaps`
   *  above but for `DebugValueKind.Vertex` — a single reassignable slot, not a set or a map. Always
   *  empty for algorithms that declare no vertex-shaped debug values. */
  debugVertices: Map<string, number | null>;
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
 *  by `debugStep` itself. Checkpointing is Recursive-Backtracker-only (`arena.checkpointFroms` is
 *  always empty for Kruskal, GitHub issue #146) — `applyKruskal` always replays from the tape's
 *  start, dispatched on `arena.algorithmKind`. */
export function selectDebugMazeView(arena: DebugArenaHandle | null, debugStep: number): DebugMazeView | null {
  if (!arena) return null;
  if (lastArena === arena && lastStep === debugStep) return lastView;

  let edges: { from: bigint; to: bigint }[];
  let debugValues: Map<string, bigint[]>;
  let dsuGroups: Map<number, number> | null = null;
  let debugMaps: Map<string, Map<bigint, bigint>> = new Map();
  let debugVertices: Map<string, bigint | null> = new Map();
  if (arena.algorithmKind === "kruskal") {
    const result = adapterFor("kruskal").apply(arena.tape, debugStep);
    edges = result.edges;
    debugValues = new Map();
    dsuGroups = new Map();
    for (const [id, root] of result.dsuGroups) dsuGroups.set(Number(id), Number(root));
  } else if (arena.algorithmKind === "wilson") {
    const result = adapterFor("wilson").apply(arena.tape, debugStep);
    edges = result.edges;
    debugValues = result.debugValues;
    debugMaps = result.debugMaps;
    debugVertices = result.debugVertices;
  } else {
    const from = nearestCheckpointFromAtOrBefore(arena.checkpointFroms, debugStep) ?? undefined;
    ({ edges, debugValues } = adapterFor("recursive_backtracker").apply(arena.tape, debugStep, from));
  }
  const numberKeyedDebugValues = new Map<string, number[]>();
  for (const [name, ids] of debugValues) {
    numberKeyedDebugValues.set(name, ids.map(Number));
  }
  const numberKeyedDebugMaps = new Map<string, Map<number, number>>();
  for (const [name, map] of debugMaps) {
    const numberMap = new Map<number, number>();
    for (const [key, value] of map) numberMap.set(Number(key), Number(value));
    numberKeyedDebugMaps.set(name, numberMap);
  }
  const numberKeyedDebugVertices = new Map<string, number | null>();
  for (const [name, id] of debugVertices) {
    numberKeyedDebugVertices.set(name, id === null ? null : Number(id));
  }
  const view: DebugMazeView = {
    nodes: arena.nodes,
    edges: edges.map((e) => ({ from: Number(e.from), to: Number(e.to), kind: "basic" as const })),
    debugValues: numberKeyedDebugValues,
    dsuGroups,
    debugMaps: numberKeyedDebugMaps,
    debugVertices: numberKeyedDebugVertices,
  };

  lastArena = arena;
  lastStep = debugStep;
  lastView = view;
  return view;
}
