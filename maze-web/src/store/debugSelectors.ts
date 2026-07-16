import type { NodeDto, EdgeDto } from "../wasm/types";
import type { DebugArenaHandle } from "./storeTypes";
import { nearestCheckpointFromAtOrBefore, sourceContentStart } from "../debug/eventTape";
import { adapterFor } from "../debug/algorithmRegistry";

export interface DebugMazeView {
  nodes: NodeDto[];
  edges: EdgeDto[];
  /** Debug-value id lists (GitHub issue #131) reconstructed at this step, keyed by name — e.g.
   *  `debugValues.get("recursion_stack")`. Node ids as `number` (already joined against `NodeDto.id`,
   *  unlike the `bigint` ids the replay engine itself works in). `number[]`, not a `Set` — order
   *  matters for `DebugValueKind.Sequence` values, which `DebugValueHighlightOverlay` renders as
   *  an arrow chain in this order. Always empty for Kruskal (GitHub issue #131 is RB-only, plus
   *  Wilson's own `"visited"` value, `CustomEdgeBased`'s own `"active"`/`"visited"`, and
   *  `CustomVertexBased`'s own `"visited"`/`"frontier"`/`"reserve"` — see
   *  `wilson::debug_value_names()`/`edge_based::debug_value_names()`/
   *  `vertex_based::debug_value_names()`, GitHub issues #144/#143). QC (#147) declares no debug
   *  values either (see `quality_control/event.rs`'s doc comment) — always empty from that source. */
  debugValues: Map<string, number[]>;
  /** Kruskal's union-find groups (GitHub issue #146's DSU-groups extension) reconstructed at this
   *  step, keyed by node id (`number`, already joined against `NodeDto.id`) mapped to its current
   *  DSU root (also a joined `number`). Two nodes sharing the same value are in the same connected
   *  component of the spanning tree built so far. `null` for every algorithm without a DSU concept
   *  and whenever there's no debug arena. */
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

/** One source's own reconstructed contribution toward a `DebugMazeView`, before merging (Contract
 *  C, `Specs/event_log.md`'s #147 section). A source never knows about any other source — QC's
 *  contribution, for instance, only carries the edges it itself added/removed, not generation's
 *  full edge list; `mergeDebugMazeView` is the only place contributions from more than one source
 *  are combined. `removedEdges` lets a later source (QC) retract edges an earlier source
 *  (generation) added — a plain `edges` list alone can only express "these edges exist", never "one
 *  fewer edge exists now than before". */
interface DebugMazeViewContribution {
  edges: { from: bigint; to: bigint; kind?: "basic" | "teleport" }[];
  removedEdges: { from: bigint; to: bigint }[];
  start: bigint | null;
  finish: bigint | null;
  debugValues: Map<string, bigint[]>;
  dsuGroups: Map<bigint, bigint> | null;
  debugMaps: Map<string, Map<bigint, bigint>>;
  debugVertices: Map<string, bigint | null>;
}

function emptyContribution(): DebugMazeViewContribution {
  return { edges: [], removedEdges: [], start: null, finish: null, debugValues: new Map(), dsuGroups: null, debugMaps: new Map(), debugVertices: new Map() };
}

/** Prefixes every debug-value/-map/-vertex name in a contribution with `"{scopeName}:"`, mirroring
 *  `maze_core::generation::qualify_debug_value_names` (`maze-core/src/generation/mod.rs`) — the
 *  core side only qualifies `debugValueNames` (the declared name list `DebugPanel.tsx` renders
 *  toggles from) when more than one source is present, so `debugArena.debugValues`/`debugMaps`/
 *  `debugVertices` (the *replayed* state each `applyX` call returns, keyed by each algorithm's own
 *  unqualified name) must be qualified the same way here, or a toggle keyed by the qualified name
 *  would never find a matching unqualified key in the replayed maps (GitHub issue #147's
 *  regression: toggling a debug value silently highlighted nothing once QC became a second
 *  source). Applied only when `arena.sources.length > 1`, matching the core's own condition
 *  exactly — with a single source, names stay unqualified on both sides, unchanged from before
 *  #147. */
function qualifyContribution(contribution: DebugMazeViewContribution, scopeName: string, qualify: boolean): DebugMazeViewContribution {
  if (!qualify) return contribution;
  const prefix = (name: string) => `${scopeName}:${name}`;
  return {
    ...contribution,
    debugValues: new Map([...contribution.debugValues].map(([name, ids]) => [prefix(name), ids])),
    debugMaps: new Map([...contribution.debugMaps].map(([name, v]) => [prefix(name), v])),
    debugVertices: new Map([...contribution.debugVertices].map(([name, v]) => [prefix(name), v])),
  };
}

/** Builds one generation source's contribution — the exact same per-algorithm dispatch
 *  `selectDebugMazeView` used before #147 introduced multiple sources, just packaged as a
 *  contribution instead of applied directly to the final view. `localStep` is relative to this
 *  source's own mutating-event stream (0-based), already resolved from the global `debugStep` by
 *  the caller. */
function generationContribution(arena: DebugArenaHandle, kind: Exclude<DebugArenaHandle["sources"][number]["kind"], "quality_control">, localStep: number, startIndex: number, endIndex: number, scopeName: string, qualify: boolean): DebugMazeViewContribution {
  const contribution = emptyContribution();
  if (kind === "kruskal") {
    const result = adapterFor("kruskal").apply(arena.tape, localStep, startIndex, endIndex);
    contribution.edges = result.edges;
    contribution.dsuGroups = new Map(result.dsuGroups);
  } else if (kind === "wilson") {
    const result = adapterFor("wilson").apply(arena.tape, localStep, startIndex, endIndex);
    contribution.edges = result.edges;
    contribution.debugValues = result.debugValues;
    contribution.debugMaps = result.debugMaps;
    contribution.debugVertices = result.debugVertices;
  } else if (kind === "edge_based") {
    const result = adapterFor("edge_based").apply(arena.tape, localStep, startIndex, endIndex);
    contribution.edges = result.edges;
    contribution.debugValues = result.debugValues;
  } else if (kind === "vertex_based") {
    const result = adapterFor("vertex_based").apply(arena.tape, localStep, startIndex, endIndex);
    contribution.edges = result.edges;
    contribution.debugValues = result.debugValues;
  } else {
    const from = nearestCheckpointFromAtOrBefore(arena.checkpointFroms, localStep) ?? undefined;
    const result = adapterFor("recursive_backtracker").apply(arena.tape, localStep, from, endIndex);
    contribution.edges = result.edges;
    contribution.debugValues = result.debugValues;
  }
  return qualifyContribution(contribution, scopeName, qualify);
}

/** Builds QC's contribution (GitHub issue #147) — `applyQc` already returns an add/remove patch
 *  (see that function's own doc comment on why removal needs a separate list from `edges`), so
 *  this just repackages it, plus `start`/`finish` (QC's own `SetStart`/`SetFinish` mutating
 *  events — a value generation itself never reconstructs, since none of the five generation
 *  algorithms carry start/finish in their own event streams). */
function qcContribution(arena: DebugArenaHandle, startNodeIndex: number, localStep: number): DebugMazeViewContribution {
  const result = adapterFor("quality_control").apply(arena.tape, localStep, startNodeIndex);
  const contribution = emptyContribution();
  contribution.edges = result.edges;
  contribution.removedEdges = result.removedEdges;
  contribution.start = result.start;
  contribution.finish = result.finish;
  return contribution;
}

/** Combines every source's own `DebugMazeViewContribution`s into one final `DebugMazeView`
 *  (Contract C, `Specs/event_log.md`'s #147 section) — the only place contributions from more than
 *  one source are ever combined; each `xContribution` builder above stays unaware any other source
 *  exists. `edges` starts from the first (generation) contribution's own list and QC's `edges`/
 *  `removedEdges` are applied on top as a patch, in source order — mirrors how QC actually mutated
 *  the graph at generation time (repair always runs after generation finishes). With exactly one
 *  contribution (Contract D — no QC source, or QC produced zero events) this reduces to identity:
 *  `edges` is just that one contribution's own list unchanged, `dsuGroups`/`debugMaps`/
 *  `debugVertices` pass through as-is — no `if (sources.length === 1)` special case needed
 *  anywhere, here or in any caller. */
function mergeDebugMazeView(contributions: DebugMazeViewContribution[]): {
  edges: { from: bigint; to: bigint; kind?: "basic" | "teleport" }[];
  start: bigint | null;
  finish: bigint | null;
  debugValues: Map<string, bigint[]>;
  dsuGroups: Map<bigint, bigint> | null;
  debugMaps: Map<string, Map<bigint, bigint>>;
  debugVertices: Map<string, bigint | null>;
} {
  let edges: { from: bigint; to: bigint; kind?: "basic" | "teleport" }[] = [];
  let start: bigint | null = null;
  let finish: bigint | null = null;
  let debugValues: Map<string, bigint[]> = new Map();
  let dsuGroups: Map<bigint, bigint> | null = null;
  let debugMaps: Map<string, Map<bigint, bigint>> = new Map();
  let debugVertices: Map<string, bigint | null> = new Map();

  for (const contribution of contributions) {
    if (contribution.removedEdges.length > 0) {
      const removedKeys = new Set(contribution.removedEdges.map((e) => `${e.from}:${e.to}`));
      edges = edges.filter((e) => !removedKeys.has(`${e.from}:${e.to}`));
    }
    edges = edges.concat(contribution.edges);
    if (contribution.start !== null) start = contribution.start;
    if (contribution.finish !== null) finish = contribution.finish;
    // debugValues/dsuGroups/debugMaps/debugVertices are generation-only (Kruskal/Wilson/EdgeBased/
    // VertexBased/RB) — QC's own contribution never sets these, so a later (QC) contribution never
    // overwrites an earlier (generation) source's values here; whichever contribution actually
    // declares a given map wins, which today is always at most one contribution per view.
    if (contribution.debugValues.size > 0) debugValues = contribution.debugValues;
    if (contribution.dsuGroups) dsuGroups = contribution.dsuGroups;
    if (contribution.debugMaps.size > 0) debugMaps = contribution.debugMaps;
    if (contribution.debugVertices.size > 0) debugVertices = contribution.debugVertices;
  }

  return { edges, start, finish, debugValues, dsuGroups, debugMaps, debugVertices };
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
 *  #125), across every top-level source in the arena's tape (GitHub issue #147: today generation
 *  alone, or generation + QC) — memoized per `(arena, debugStep)` pair (GitHub issue #139) so
 *  repeated calls with the same inputs, whether from one consumer re-rendering or several, share a
 *  single replay and a single stable `edges` reference. Returns `null` when there is no debug
 *  arena (debug mode off, or the last run's algorithm isn't instrumented yet).
 *
 *  `debugStep` is global (Contract A, `Specs/event_log.md`'s #147 section): each `arena.sources`
 *  entry owns a `[startStep, endStep)` half-open range of it. A source only contributes once
 *  `debugStep` has reached its own range; a source whose range starts after `debugStep` doesn't run
 *  at all this call (e.g. scrubbing to step 5 of a 200-step generation run never touches QC).
 *
 *  Resumes generation's own replay from the nearest intermediate snapshot checkpoint at or before
 *  its local step (GitHub issue #128), when one exists, instead of always replaying from the
 *  source's start — bounds the cost of scrubbing to a large `debugStep` by `CHECKPOINT_INTERVAL`
 *  mutating events rather than by `debugStep` itself. Checkpointing is Recursive-Backtracker-only
 *  (`arena.checkpointFroms` is always empty otherwise). */
export function selectDebugMazeView(arena: DebugArenaHandle | null, debugStep: number): DebugMazeView | null {
  if (!arena) return null;
  if (lastArena === arena && lastStep === debugStep) return lastView;

  const contributions: DebugMazeViewContribution[] = [];
  for (let i = 0; i < arena.sources.length; i++) {
    const source = arena.sources[i];
    if (debugStep < source.startStep) break;
    const localStep = Math.min(debugStep, source.endStep - 1) - source.startStep;
    const startIndex = sourceContentStart(arena.tape, source.nodeIndex);
    const endIndex = i + 1 < arena.sources.length
      ? sourceContentStart(arena.tape, arena.sources[i + 1].nodeIndex)
      : arena.tape.nodeCount;
    const qualify = arena.sources.length > 1;
    contributions.push(
      source.kind === "quality_control"
        ? qcContribution(arena, startIndex, localStep)
        : generationContribution(arena, source.kind, localStep, startIndex, endIndex, source.scopeName, qualify),
    );
  }

  const merged = mergeDebugMazeView(contributions);

  const numberKeyedDebugValues = new Map<string, number[]>();
  for (const [name, ids] of merged.debugValues) {
    numberKeyedDebugValues.set(name, ids.map(Number));
  }
  const numberKeyedDebugMaps = new Map<string, Map<number, number>>();
  for (const [name, map] of merged.debugMaps) {
    const numberMap = new Map<number, number>();
    for (const [key, value] of map) numberMap.set(Number(key), Number(value));
    numberKeyedDebugMaps.set(name, numberMap);
  }
  const numberKeyedDebugVertices = new Map<string, number | null>();
  for (const [name, id] of merged.debugVertices) {
    numberKeyedDebugVertices.set(name, id === null ? null : Number(id));
  }
  const dsuGroups: Map<number, number> | null = merged.dsuGroups
    ? new Map([...merged.dsuGroups].map(([id, root]) => [Number(id), Number(root)]))
    : null;

  const view: DebugMazeView = {
    nodes: arena.nodes,
    edges: merged.edges.map((e) => ({ from: Number(e.from), to: Number(e.to), kind: e.kind ?? "basic" })),
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
