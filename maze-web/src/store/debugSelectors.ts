import type { NodeDto, EdgeDto } from "../wasm/types";
import type { DebugArenaHandle } from "./storeTypes";
import { nearestCheckpointFromAtOrBefore, sourceContentStart, nodeView } from "../debug/eventTape";
import type { ApplyFrom, PresetSetupApplyResult, KruskalApplyResult, WilsonApplyResult, VertexBasedApplyResult, QcApplyResult } from "../debug/eventTape";
import { adapterFor, adapterForNode, type Token, type BaseAlgorithmAdapter } from "../debug/algorithmRegistry";
import { buildStepIndex, nodeIndexForStep } from "../debug/debugTreeSelectors";

export interface DebugMazeView {
  nodes: NodeDto[];
  edges: EdgeDto[];
  /** Start/finish node ids (already joined against `NodeDto.id`) reconstructed at this step, or
   *  `null` if not yet set by this point in the replay. Only QC's contribution (GitHub issue #147)
   *  ever sets these — see `qcContribution`'s own doc comment. */
  start: number | null;
  finish: number | null;
  /** Debug-value id lists (GitHub issue #131) reconstructed at this step, keyed by name — e.g.
   *  `debugValues.get("recursion_stack")`. Node ids as `number` (already joined against `NodeDto.id`,
   *  unlike the `bigint` ids the replay engine itself works in). `number[]`, not a `Set` — order
   *  matters for `DebugValueKind.Sequence` values, which `DebugValueHighlightOverlay` renders as
   *  an arrow chain in this order. Always empty for Kruskal (GitHub issue #131 is RB-only, plus
   *  Wilson's own `"visited"` value, and `CustomVertexBased`'s own `"visited"`/`"frontier"`/
   *  `"reserve"` — see `wilson::debug_value_names()`/`vertex_based::debug_value_names()`, GitHub
   *  issue #143). QC (#147) declares no debug values either (see `quality_control/event.rs`'s doc
   *  comment) — always empty from that source. */
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
  edges: { from: bigint; to: bigint; kind?: "basic" | "teleport" | "vertical_passage" | "elevator" }[];
  removedEdges: { from: bigint; to: bigint }[];
  start: bigint | null;
  finish: bigint | null;
  debugValues: Map<string, bigint[]>;
  dsuGroups: Map<bigint, bigint> | null;
  debugMaps: Map<string, Map<bigint, bigint>>;
  debugVertices: Map<string, bigint | null>;
  /** Node ids minted mid-run by a split event that have appeared by this contribution's step — a
   *  generation-time split (GitHub issue #222, `VertexBased`-only) or a QC-time split
   *  (`MutationCommand::ReplacePointNodes`, GitHub issue #247's `AddSplitStrategy`,
   *  `quality_control` only). See `VertexBasedApplyResult.createdNodes`'s doc comment for why this
   *  must gate `DebugMazeView.nodes`, not just `.edges`. Always empty for every other source kind. */
  createdNodes: bigint[];
  /** Maze node ids removed by QC's `remove_split` strategy (GitHub issue #248's `RemoveNode`
   *  mutation command) that have happened by this contribution's step — only `quality_control`
   *  ever sets this. Must gate `DebugMazeView.nodes` the same way `createdNodes` does, or a
   *  removed split node keeps rendering as a stray, edgeless dot for the rest of the replay. */
  removedNodes: bigint[];
}

function emptyContribution(): DebugMazeViewContribution {
  return { edges: [], removedEdges: [], start: null, finish: null, debugValues: new Map(), dsuGroups: null, debugMaps: new Map(), debugVertices: new Map(), createdNodes: [], removedNodes: [] };
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
function generationContribution(arena: DebugArenaHandle, source: DebugArenaHandle["sources"][number], localStep: number, startIndex: number, endIndex: number, qualify: boolean): DebugMazeViewContribution {
  const contribution = emptyContribution();
  const kind = source.kind;
  if (kind === "kruskal") {
    const from = nearestCheckpointFromAtOrBefore<KruskalApplyResult>(source.checkpointFroms, localStep) ?? undefined;
    const result = adapterFor("kruskal").apply(arena.tape, localStep, from, startIndex, endIndex);
    contribution.edges = result.edges;
    contribution.dsuGroups = new Map(result.dsuGroups);
  } else if (kind === "wilson") {
    const from = nearestCheckpointFromAtOrBefore<WilsonApplyResult>(source.checkpointFroms, localStep) ?? undefined;
    const result = adapterFor("wilson").apply(arena.tape, localStep, from, startIndex, endIndex);
    contribution.edges = result.edges;
    contribution.debugValues = result.debugValues;
    contribution.debugMaps = result.debugMaps;
    contribution.debugVertices = result.debugVertices;
  } else if (kind === "vertex_based") {
    const from = nearestCheckpointFromAtOrBefore<VertexBasedApplyResult>(source.checkpointFroms, localStep) ?? undefined;
    const result = adapterFor("vertex_based").apply(arena.tape, localStep, from, startIndex, endIndex);
    contribution.edges = result.edges;
    contribution.debugValues = result.debugValues;
    contribution.createdNodes = result.createdNodes;
  } else {
    const from = nearestCheckpointFromAtOrBefore<ApplyFrom>(source.checkpointFroms, localStep) ?? undefined;
    const result = adapterFor("recursive_backtracker").apply(arena.tape, localStep, from, startIndex, endIndex);
    contribution.edges = result.edges;
    contribution.debugValues = result.debugValues;
  }
  return qualifyContribution(contribution, source.scopeName, qualify);
}

/** Builds the "preset setup" source's contribution (GitHub issue #225) — the preset edges
 *  (Passage/OneWay/Teleport) already in the graph before generation started, algorithm-agnostic
 *  and always the first source when present. Simplest possible contribution: just `edges`, no
 *  debug values/dsuGroups/start/finish — this source declares none of those. */
function presetSetupContribution(arena: DebugArenaHandle, source: DebugArenaHandle["sources"][number], startNodeIndex: number, localStep: number): DebugMazeViewContribution {
  const from = nearestCheckpointFromAtOrBefore<PresetSetupApplyResult>(source.checkpointFroms, localStep) ?? undefined;
  const result = adapterFor("preset_setup").apply(arena.tape, localStep, from, startNodeIndex);
  const contribution = emptyContribution();
  contribution.edges = result.edges;
  return contribution;
}

/** Builds QC's contribution (GitHub issue #147) — `applyQc` already returns an add/remove patch
 *  (see that function's own doc comment on why removal needs a separate list from `edges`), so
 *  this just repackages it, plus `start`/`finish` (QC's own `SetStart`/`SetFinish` mutating
 *  events — a value generation itself never reconstructs, since none of the five generation
 *  algorithms carry start/finish in their own event streams). */
function qcContribution(arena: DebugArenaHandle, source: DebugArenaHandle["sources"][number], startNodeIndex: number, localStep: number): DebugMazeViewContribution {
  const from = nearestCheckpointFromAtOrBefore<QcApplyResult>(source.checkpointFroms, localStep) ?? undefined;
  const result = adapterFor("quality_control").apply(arena.tape, localStep, from, startNodeIndex);
  const contribution = emptyContribution();
  contribution.edges = result.edges;
  contribution.removedEdges = result.removedEdges;
  contribution.removedNodes = result.removedNodes;
  contribution.createdNodes = result.createdNodes;
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
  edges: { from: bigint; to: bigint; kind?: "basic" | "teleport" | "vertical_passage" | "elevator" }[];
  start: bigint | null;
  finish: bigint | null;
  debugValues: Map<string, bigint[]>;
  dsuGroups: Map<bigint, bigint> | null;
  debugMaps: Map<string, Map<bigint, bigint>>;
  debugVertices: Map<string, bigint | null>;
  createdNodes: bigint[];
  removedNodes: bigint[];
} {
  let edges: { from: bigint; to: bigint; kind?: "basic" | "teleport" | "vertical_passage" | "elevator" }[] = [];
  let start: bigint | null = null;
  let finish: bigint | null = null;
  let debugValues: Map<string, bigint[]> = new Map();
  let dsuGroups: Map<bigint, bigint> | null = null;
  let debugMaps: Map<string, Map<bigint, bigint>> = new Map();
  let debugVertices: Map<string, bigint | null> = new Map();
  let createdNodes: bigint[] = [];
  let removedNodes: bigint[] = [];

  for (const contribution of contributions) {
    if (contribution.removedEdges.length > 0) {
      const removedKeys = new Set(contribution.removedEdges.map((e) => `${e.from}:${e.to}`));
      edges = edges.filter((e) => !removedKeys.has(`${e.from}:${e.to}`));
    }
    edges = edges.concat(contribution.edges);
    if (contribution.start !== null) start = contribution.start;
    if (contribution.finish !== null) finish = contribution.finish;
    // debugValues/dsuGroups/debugMaps/debugVertices are generation-only (Kruskal/Wilson/
    // VertexBased/RB) — QC's own contribution never sets these, so a later (QC) contribution never
    // overwrites an earlier (generation) source's values here; whichever contribution actually
    // declares a given map wins, which today is always at most one contribution per view.
    if (contribution.debugValues.size > 0) debugValues = contribution.debugValues;
    if (contribution.dsuGroups) dsuGroups = contribution.dsuGroups;
    if (contribution.debugMaps.size > 0) debugMaps = contribution.debugMaps;
    if (contribution.debugVertices.size > 0) debugVertices = contribution.debugVertices;
    if (contribution.createdNodes.length > 0) createdNodes = createdNodes.concat(contribution.createdNodes);
    if (contribution.removedNodes.length > 0) removedNodes = removedNodes.concat(contribution.removedNodes);
  }

  return { edges, start, finish, debugValues, dsuGroups, debugMaps, debugVertices, createdNodes, removedNodes };
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

// Per-arena memo of every split-node id (GitHub issue #222, extended to QC/repair mint by #271)
// minted anywhere across the whole tape, regardless of `debugStep` — needed to tell "not yet
// created at this step" apart from "an ordinary node that was always there" when filtering
// `arena.nodes` below. Computed once per arena (replaying each vertex_based/quality_control source
// fully, at its own last step) rather than per `debugStep` call, since it never changes for a
// given arena.
const allSplitNodeIdsByArena = new WeakMap<DebugArenaHandle, ReadonlySet<bigint>>();

function allSplitNodeIdsOf(arena: DebugArenaHandle): ReadonlySet<bigint> {
  const cached = allSplitNodeIdsByArena.get(arena);
  if (cached) return cached;

  const ids = new Set<bigint>();
  for (let i = 0; i < arena.sources.length; i++) {
    const source = arena.sources[i];
    if (source.endStep === source.startStep) continue;
    // Only these two source kinds ever mint a node mid-run (`createdNodes`, GitHub issue #271) —
    // vertex_based's pattern-mode split during generation, quality_control's `PointNodesReplaced`
    // during repair. Every other adapter's `ApplyResult` has no `createdNodes` field at all.
    const startIndex = sourceContentStart(arena.tape, source.nodeIndex);
    const endIndex = i + 1 < arena.sources.length
      ? sourceContentStart(arena.tape, arena.sources[i + 1].nodeIndex)
      : arena.tape.nodeCount;
    const localStep = source.endStep - source.startStep - 1;
    const createdNodes = source.kind === "vertex_based"
      ? adapterFor("vertex_based").apply(arena.tape, localStep, undefined, startIndex, endIndex).createdNodes
      : source.kind === "quality_control"
        ? adapterFor("quality_control").apply(arena.tape, localStep, undefined, startIndex).createdNodes
        : [];
    for (const id of createdNodes) ids.add(id);
  }

  allSplitNodeIdsByArena.set(arena, ids);
  return ids;
}

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
 *  Resumes each source's own replay from the nearest intermediate snapshot checkpoint at or before
 *  its local step (GitHub issue #128, generalized past Recursive Backtracker), when one exists,
 *  instead of always replaying from the source's start — bounds the cost of scrubbing to a large
 *  `debugStep` by `CHECKPOINT_INTERVAL` mutating events rather than by `debugStep` itself. Every
 *  source's own `checkpointFroms` (`source.checkpointFroms`, see `DebugArenaHandle.sources`'s doc
 *  comment) is empty when that source is shorter than `CHECKPOINT_INTERVAL`. */
export function selectDebugMazeView(arena: DebugArenaHandle | null, debugStep: number): DebugMazeView | null {
  if (!arena) return null;
  if (lastArena === arena && lastStep === debugStep) return lastView;

  const contributions: DebugMazeViewContribution[] = [];
  for (let i = 0; i < arena.sources.length; i++) {
    const source = arena.sources[i];
    if (debugStep < source.startStep) break;
    // A source with zero mutating events (endStep === startStep, GitHub issue #173 — e.g. a
    // qc_experiment run where no repair strategy could act on an edgeless graph) has nothing to
    // replay — skip it rather than computing a negative localStep, which every applyX would
    // reject via validateStepShape.
    if (source.endStep === source.startStep) continue;
    const localStep = Math.min(debugStep, source.endStep - 1) - source.startStep;
    const startIndex = sourceContentStart(arena.tape, source.nodeIndex);
    const endIndex = i + 1 < arena.sources.length
      ? sourceContentStart(arena.tape, arena.sources[i + 1].nodeIndex)
      : arena.tape.nodeCount;
    const qualify = arena.sources.length > 1;
    contributions.push(
      source.kind === "quality_control" ? qcContribution(arena, source, startIndex, localStep)
        : source.kind === "preset_setup" ? presetSetupContribution(arena, source, startIndex, localStep)
        : generationContribution(arena, source, localStep, startIndex, endIndex, qualify),
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

  // `arena.nodes` is the run's final, static node list — a node removed/replaced before the run
  // ended (`RemoveNode`/`ReplacePointNodes`, GitHub issue #271) is already gone from it, so a step
  // before its removal has nowhere to source its coordinates/existence from. `arena.allNodes` (the
  // ledger of every node minted mid-run, including later-removed ones) fills that gap — concat the
  // two, deduped by id (`arena.nodes` wins on overlap, but the two are disjoint in practice: a
  // surviving node is never in `allNodes`, see that field's own doc comment).
  const baseNodes = arena.allNodes.length === 0
    ? arena.nodes
    : (() => {
        const seen = new Set(arena.nodes.map((n) => n.id));
        const extra = arena.allNodes.filter((n) => !seen.has(n.id));
        return extra.length === 0 ? arena.nodes : arena.nodes.concat(extra);
      })();

  // `baseNodes` already includes every split node (GitHub issue #222, extended to QC/repair mint
  // by #271) that will ever be minted, regardless of `debugStep`. A split node not yet created by
  // this step must be excluded here, or its point renders as an already-split tile with no
  // connections at all (fully closed) many steps before the split event actually happens. Only
  // filters ids present in `allSplitNodeIds` at all — an ordinary node is never in that set, so
  // this is a no-op whenever the run produced no splits.
  const allSplitNodeIds = allSplitNodeIdsOf(arena);
  const createdSoFar = new Set(merged.createdNodes);
  // A node removed by QC's `remove_split` strategy (GitHub issue #248) or replaced
  // (`ReplacePointNodes`) must stop rendering from this step onward, same "gate
  // `DebugMazeView.nodes`, not just `.edges`" rationale as `createdNodes` above — otherwise it
  // lingers as a stray, edgeless dot once its last edge is retracted.
  const removedSoFar = new Set(merged.removedNodes);
  const nodes = (allSplitNodeIds.size === 0 && removedSoFar.size === 0)
    ? baseNodes
    : baseNodes.filter((n) => {
        const id = BigInt(n.id);
        if (removedSoFar.has(id)) return false;
        return !allSplitNodeIds.has(id) || createdSoFar.has(id);
      });

  // An edge incident to a removed/replaced node (GitHub issue #271's `ReplacePointNodes`) can
  // originate from *any* earlier source's own contribution — generation's full edge list, not
  // just whatever QC itself added — so `removedEdges`'s point-in-time `(from, to)` patch alone
  // can't retract it (that patch only ever cancels an edge the accumulator itself added). Filter
  // here instead, once, against the same `removedSoFar` set that already gates `nodes` above —
  // the only place that has both the fully merged edge list and the full removal history at once.
  const filteredEdges = removedSoFar.size === 0
    ? merged.edges
    : merged.edges.filter((e) => !removedSoFar.has(e.from) && !removedSoFar.has(e.to));

  const view: DebugMazeView = {
    nodes,
    edges: filteredEdges.map((e) => ({ from: Number(e.from), to: Number(e.to), kind: e.kind ?? "basic" })),
    start: merged.start === null ? null : Number(merged.start),
    finish: merged.finish === null ? null : Number(merged.finish),
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

/** Extracts the node ids a decoded event's own narration tokens reference — `node`/`edge`/`cycle`/
 *  `region` tokens carry ids, `text`/`issue` don't (an `issue` token's structural payload, when
 *  present, is itself a `cycle`/`region` shape but represents a QC finding about existing state,
 *  not a node this *step*'s own mutation touched — excluded here on purpose). */
function tokenNodeIds(tokens: Token[]): bigint[] {
  const ids: bigint[] = [];
  for (const token of tokens) {
    switch (token.kind) {
      case "node": ids.push(token.id); break;
      case "edge": ids.push(token.from, token.to); break;
      case "cycle": for (const [f, t] of token.edges) ids.push(f, t); break;
      case "region": ids.push(...token.nodes); break;
    }
  }
  return ids;
}

// Per-arena memo of `NodeId -> level`, built once from `arena.nodes`/`arena.allNodes` (mirrors
// `allSplitNodeIdsByArena`'s own per-arena WeakMap above) — `resolveStepFloorIndex` is called on
// every `setDebugStep` (autoplay tick, next/prev, scrubber settle), so rebuilding this map from
// scratch each time would be an avoidable O(nodes) pass per step on a large maze.
const levelByIdByArena = new WeakMap<DebugArenaHandle, ReadonlyMap<bigint, number>>();

function levelByIdOf(arena: DebugArenaHandle): ReadonlyMap<bigint, number> {
  const cached = levelByIdByArena.get(arena);
  if (cached) return cached;

  const levelById = new Map<bigint, number>();
  for (const n of arena.nodes) levelById.set(BigInt(n.id), n.level ?? 0);
  for (const n of arena.allNodes) if (!levelById.has(BigInt(n.id))) levelById.set(BigInt(n.id), n.level ?? 0);

  levelByIdByArena.set(arena, levelById);
  return levelById;
}

/** Resolves which floor, if any, `debugStep`'s own mutating event touches (GitHub issue #350) —
 *  used to auto-switch the active floor as the debug tape is stepped through. `null` means "don't
 *  switch": the step touches nodes on more than one floor at once (e.g. a `VerticalPassage`/
 *  `Elevator` edge added between floors — GitHub issue #337), or there's nothing to resolve (no
 *  arena, no source declared for this step, or the step's own node carries no node-id tokens at
 *  all, e.g. a `DeadEnd`/`CandidatesComputed` trace event — `debugStep` always lands on the tape's
 *  own *mutating* events though, per `stepToNodeIndex`'s contract, so this last case shouldn't
 *  actually occur in practice).
 *
 *  Reuses the exact same per-row decode path `DebugEventTree.tsx`'s `rowTokens` uses for bubble
 *  labels (`adapterForNode` -> `decodeEvent` -> `narrationTokensFor`) rather than diffing two full
 *  `selectDebugMazeView` replays — a diff would thrash that function's single-slot memo (every
 *  call evicts the other step's cached view) and pay for a full source-list replay per step, when
 *  only one event's own payload is actually needed here. */
export function resolveStepFloorIndex(
  arena: DebugArenaHandle | null,
  floors: readonly { id: string }[],
  debugStep: number,
): number | null {
  if (!arena || floors.length <= 1) return null;
  const sourceEventKinds = arena.sources.map((s) => s.kind);
  const stepIndexSources = arena.sources.map((s) => ({ kind: s.kind, nodeIndex: s.nodeIndex }));
  const stepIndex = buildStepIndex(arena.tape, stepIndexSources);
  if (debugStep < 0 || debugStep >= stepIndex.stepToNodeIndex.length) return null;

  const nodeIndex = nodeIndexForStep(stepIndex, debugStep);
  // Cast rationale mirrors `DebugEventTree.tsx`'s `rowTokens`: `adapterForNode` returns a union
  // over six concrete adapter types, which TS can't instantiate `decodeEvent`/`narrationTokensFor`
  // from directly (unsound in general) — safe here because the decoded `event`'s concrete type
  // only ever flows from `decodeEvent` straight back into `narrationTokensFor` on this same
  // adapter instance, never constructed independently.
  const adapter = adapterForNode(arena.tape, nodeIndex, sourceEventKinds) as BaseAlgorithmAdapter<unknown>;
  const payload = nodeView(arena.tape, nodeIndex).payload();
  if (payload.kind !== "event") return null;
  const event = adapter.decodeEvent(payload.tag, payload.bytes);
  const ids = tokenNodeIds(adapter.narrationTokensFor(event));
  if (ids.length === 0) return null;

  const levelById = levelByIdOf(arena);
  const levels = ids.map((id) => levelById.get(id));
  if (levels.some((l) => l === undefined)) return null;
  const first = levels[0] as number;
  return levels.every((l) => l === first) ? first : null;
}
