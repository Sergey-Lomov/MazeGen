import { generateMaze } from "../../wasm/mazeService";
import type { GenerateConfig, WasmTessellationConfig, StrategyConfig } from "../../wasm/types";
import type { FieldConfig as TessellationConfig } from "../../fieldConfig";
import { computeInvalidKeys, computeInvalidTeleportIds, computeInvalidMarkers, presetTeleportEntryToState } from "../../pixi/fieldEditUtils";
import { configAllCells } from "../../pixi/tessellationCells";
import { buildPostEditDraftEdgesFromGenerated, extractPostEditTeleports, postEditTeleportsToDto } from "../../pixi/postEditUtils";
import { MAX_NESTED_STRATEGY_DEPTH } from "../storeTypes";
import type { MazeStore, PostEditTool, QcRuleState, NestedStrategyState, DebugArenaHandle } from "../storeTypes";
import { activeTessellationOf } from "../storeHelpers";
import { warmCartesianCache } from "../../pixi/cartesianCache";
import { parseTape, topLevelSourceScopes, sourceContentStart } from "../../debug/eventTape";
import { adapterForKind } from "../../debug/algorithmRegistry";

export type StoreSet = (partial: Partial<MazeStore> | ((s: MazeStore) => Partial<MazeStore>)) => void;
export type StoreGet = () => MazeStore;

export function fieldConfigToWasm(cfg: TessellationConfig): WasmTessellationConfig {
  const t = cfg.type;
  const tessellation_type = t.startsWith("hex") ? "hex" as const
    : (t.startsWith("tri") || t.startsWith("triangle")) ? "tri" as const
    : "square" as const;
  const points = configAllCells(cfg);
  return { tessellation_type, points };
}

// Recursively builds one nested `StrategyConfig` from a `NestedStrategyState` — mirrors
// `ruleToConfig`'s param-filtering (only descriptor-known param ids are forwarded), plus its own
// `slot_id` and recursively-built `nested` list. Unlike top-level strategies, nested params are
// per-node (`n.params`), not looked up in the global `strategyParams` map — see
// `NestedStrategyState`'s doc comment for why (two rules must be able to configure the same
// nested strategy independently). `depth` guards against a pathologically deep tree (e.g. loaded
// from a project file) blowing the call stack on every `generate()` call — see
// `MAX_NESTED_STRATEGY_DEPTH`'s doc comment.
//
// `NESTED_STRATEGY_WEIGHT_PARAM_ID` is forwarded unconditionally, alongside whatever the
// descriptor declares — a dispatcher like `weighted_region_merge` reads a nested entry's weight
// straight out of its own `param_overrides["weight"]` (`Specs/repair.md`'s "WeightedRegionMerge-
// Strategy" section), deliberately NOT as a declared `StrategyParam` of the nested strategy
// itself (weight is the *dispatcher's* convention, not the nested strategy's own knob) — so the
// normal "only descriptor-known ids" filter would silently drop it.
export const NESTED_STRATEGY_WEIGHT_PARAM_ID = "weight";

function nestedToConfig(state: MazeStore, n: NestedStrategyState, depth = 0): StrategyConfig {
  const descriptor = state.availableStrategies.find((s) => s.id === n.strategyId);
  const params: Record<string, string> = {};
  if (descriptor) {
    for (const p of descriptor.params) {
      if (n.params[p.id] !== undefined) params[p.id] = n.params[p.id];
    }
  }
  if (n.params[NESTED_STRATEGY_WEIGHT_PARAM_ID] !== undefined) {
    params[NESTED_STRATEGY_WEIGHT_PARAM_ID] = n.params[NESTED_STRATEGY_WEIGHT_PARAM_ID];
  }
  return {
    id: n.strategyId,
    params,
    slot_id: n.slotId,
    nested: depth >= MAX_NESTED_STRATEGY_DEPTH ? [] : n.nested.map((child) => nestedToConfig(state, child, depth + 1)),
  };
}

// Builds one `QcRuleConfig` from a `QcRuleState` — `ruleDisabled` filtering happens in
// `buildGenerateConfig` before this is called (per-stage, per rule), not here.
function ruleToConfig(state: MazeStore, g: QcRuleState): { id: string; checks: { local_id: string; type_id: string; params: Record<string, string> }[]; strategy: StrategyConfig | null } {
  let strategy: StrategyConfig | null = null;
  if (g.strategyId && !g.disabled) {
    const descriptor = state.availableStrategies.find((s) => s.id === g.strategyId);
    const paramOverrides = state.strategyParams[g.strategyId] ?? {};
    const params: Record<string, string> = {};
    if (descriptor) {
      for (const p of descriptor.params) {
        if (paramOverrides[p.id] !== undefined) params[p.id] = paramOverrides[p.id];
      }
    }
    const nested = g.nestedStrategies.map((n) => nestedToConfig(state, n));
    strategy = { id: g.strategyId, params, ...(nested.length > 0 ? { nested } : {}) };
  }
  // Order preserved from `QcRuleState.checks` — no resorting, so serialization/test
  // determinism doesn't depend on Map/object iteration order at this layer.
  const checks = g.checks.map((c) => ({ local_id: c.localId.toString(), type_id: c.typeId, params: c.params }));
  return { id: g.id, checks, strategy };
}

export function buildGenerateConfig(state: MazeStore): GenerateConfig | null {
  if (state.isEditingField && state.fieldPoints.size < 2) return null;
  const ruleById = new Map(state.rules.map((g) => [g.id, g]));
  // A `disabled` stage is omitted entirely — as if it didn't exist for this run, same as a
  // `ruleDisabled` rule being omitted from its stage's `rules` below (not sent with an empty
  // `rules: []`, which would still be a real, dispatchable-if-non-empty stage entry).
  // `ruleDisabled` filtering happens here, per stage, before any config crosses the wasm
  // boundary — a disabled rule is simply absent from `stage.rules`, not sent as `strategy: null`
  // (that shape is reserved for a rule that legitimately has no strategy assigned). Every
  // remaining rule is sent, including ones with no strategy — `strategy: null` for those, not an
  // omitted entry. The wasm layer still needs the rule's check composition to merge/attribute
  // issues correctly even when nothing repairs them (see Specs/repair.md). An empty stage after
  // this filtering is sent as-is (`rules: []`) — core handles a stage with no dispatchable rules
  // as a trivial degenerate case (see Specs/repair.md's "Stages" section).
  const stages = state.stages
    .filter((s) => !s.disabled)
    .map((s) => ({
      id: s.id,
      name: s.name,
      rules: s.ruleIds
        .map((id) => ruleById.get(id))
        .filter((g): g is QcRuleState => g !== undefined && !g.ruleDisabled)
        .map((g) => ruleToConfig(state, g)),
    }));
  const activeTessellation = activeTessellationOf(state);
  const customPts = state.isEditingField ? state.fieldPoints : undefined;
  const invalidKeys = computeInvalidKeys(state.presetConnections, activeTessellation, customPts);
  const validPresets = Array.from(state.presetConnections.values())
    .filter(e => e.state !== "undefined" && !invalidKeys.has(`${e.from[0]},${e.from[1]}-${e.to[0]},${e.to[1]}`))
    .map(e => ({ from: e.from, to: e.to, state: e.state as import("../../wasm/types").PresetConnectionState }));
  const invalidTeleportIds = computeInvalidTeleportIds(state.presetTeleports, activeTessellation, customPts);
  const validTeleportPresets = state.presetTeleports
    .filter(t => !invalidTeleportIds.has(t.id))
    .map(t => ({ from: t.from, to: t.to, state: presetTeleportEntryToState(t.direction) }));
  const lockedEntries = new Map(state.lockedNodes);
  for (const key of state.autoLockedNodes) {
    if (!lockedEntries.has(key)) lockedEntries.set(key, "both");
  }
  const locked_nodes = Array.from(lockedEntries.entries()).map(([key, kind]) => {
    const [x, y] = key.split(",").map(Number);
    return { point: [x, y] as [number, number], kind };
  });
  const invalidMarkers = computeInvalidMarkers(state.presetStart, state.presetFinish, activeTessellation, customPts);
  return {
    tessellation: fieldConfigToWasm(activeTessellation),
    stages,
    ...(state.repairMaxIterations != null ? { repair_max_iterations: state.repairMaxIterations } : {}),
    ...(state.repairTimeBudgetSecs != null ? { repair_time_budget_secs: state.repairTimeBudgetSecs } : {}),
    initial: state.initialConfig,
    elements: state.elementsConfig,
    preset_connections: [...validPresets, ...validTeleportPresets],
    locked_nodes,
    ...(state.presetStart && !invalidMarkers.start ? { preset_start: state.presetStart } : {}),
    ...(state.presetGenSource ? { preset_gen_source: state.presetGenSource } : {}),
    ...(state.presetFinish && !invalidMarkers.finish ? { preset_finish: state.presetFinish } : {}),
  };
}

/** Applies QC experiment mode's config overrides in place — no preset protection at all
 *  (including locked nodes, manual or auto-computed): the whole point is letting QC/repair
 *  freely rework a hand-crafted preset setup. Shared by `generateWithSeed` (the real call) and
 *  `buildExactGenerateCallPayload` (the debug-export call), so both stay in sync. */
function applyQcExperimentOverrides(config: GenerateConfig): void {
  config.qc_experiment = true;
  config.locked_nodes = [];
}

export function generateWithSeed(seed: number, get: StoreGet, set: StoreSet, qcExperiment = false): void {
  const state = get();
  if (state.isEditingField && state.fieldPoints.size < 2) {
    set({ error: "Free field requires at least 2 cells", generationStatus: "error" });
    return;
  }
  const activeTessellation = activeTessellationOf(state);
  const debugMode = state.debugMode;
  const config = buildGenerateConfig(state);
  if (!config) return;
  if (qcExperiment) {
    applyQcExperimentOverrides(config);
    if (debugMode) config.debug_events = true;
  } else if (debugMode) {
    config.debug_events = true;
  }
  try {
    const { snapshot, debugTape } = generateMaze(seed, config);
    warmCartesianCache(activeTessellation);
    let debugArena: DebugArenaHandle | null = null;
    let lastStep = 0;
    if (debugMode && debugTape) {
      const tape = parseTape(debugTape.nodeTable, debugTape.payload);
      // One entry per top-level source scope (GitHub issue #147/#169) — generation always first,
      // QC (when present) always after, per Contract A (`Specs/event_log.md`'s #147 section).
      // Checkpoints (GitHub issue #128, generalized past Recursive Backtracker) are computed on
      // the web side (`resolveDebugArenaMetadata`) per source — each source's own opaque
      // `checkpointFroms` lives on its own `sources[]` entry (see `DebugArenaHandle.sources`'s doc
      // comment), since every adapter's snapshot shape differs.
      const topLevelScopes = topLevelSourceScopes(tape);
      let runningStep = 0;
      const sources: DebugArenaHandle["sources"] = [];
      for (let i = 0; i < topLevelScopes.length; i++) {
        const scope = topLevelScopes[i];
        const kind = debugTape.sourceEventKinds[i];
        // See `sourceContentStart`'s doc comment (GitHub issue #147) for why this isn't just
        // `scope.nodeIndex`/`topLevelScopes[i + 1].nodeIndex`.
        const startIndex = sourceContentStart(tape, scope.nodeIndex);
        const endIndex = i + 1 < topLevelScopes.length
          ? sourceContentStart(tape, topLevelScopes[i + 1].nodeIndex)
          : tape.nodeCount;
        const metadata = adapterForKind(kind).resolveMetadata(tape, startIndex, endIndex);
        const startStep = runningStep;
        runningStep += metadata.totalSteps;
        sources.push({ scopeName: scope.scopeName, kind, nodeIndex: scope.nodeIndex, startStep, endStep: runningStep, checkpointFroms: metadata.checkpointFroms });
      }
      const totalSteps = runningStep;
      // `sources.length > 0` (not `totalSteps > 0`, GitHub issue #173) — a qc_experiment run with
      // zero repair mutations (e.g. an empty field, no preset connections, no strategy able to
      // act) still has a "quality_control" scope to show, just with nothing to scrub through: the
      // debug panel should render a single static frame (the graph as-is) rather than not appear
      // at all. `lastStep` stays 0 in that case (nothing to advance to).
      if (sources.length > 0) {
        // debugValueNames (GitHub issue #131) comes from the WASM response's static declaration
        // (GenerateResult::debug_value_names()), not from scanning the tape — see
        // resolveDebugArenaMetadata's doc comment for why.
        debugArena = {
          tape, algorithmKind: sources[0].kind, sources, nodes: snapshot.nodes, totalSteps,
          debugValueNames: debugTape.debugValueNames,
        };
        lastStep = Math.max(0, totalSteps - 1);
      }
    }
    const { teleports: generatedTeleports, nextId: nextTeleportId } = extractPostEditTeleports(snapshot.edges);
    const draftEdges = buildPostEditDraftEdgesFromGenerated(snapshot.edges);
    const draftMeta = { start: snapshot.start, finish: snapshot.finish };
    set({
      nodes: snapshot.nodes,
      edges: snapshot.edges,
      start: snapshot.start,
      finish: snapshot.finish,
      navNodes: snapshot.nav_nodes,
      navEdges: snapshot.nav_edges,
      graphAnalytics: snapshot.graph_analytics,
      selectedNode: null,
      issues: snapshot.issues,
      error: null,
      activeTessellationConfig: activeTessellation,
      nodeStats: snapshot.node_stats,
      edgeStats: snapshot.edge_stats,
      teleportEdgeStats: snapshot.teleport_edge_stats,
      routeInfo: snapshot.route_info,
      timing: snapshot.timing,
      generationStatus: "done",
      debugArena,
      debugStep: lastStep,
      debugStale: false,
      debugValueToggles: new Set(),
      showKruskalDsuGroups: false,
      postEditDraftEdges: draftEdges,
      postEditDraftTeleports: generatedTeleports,
      _nextPostEditTeleportId: nextTeleportId,
      postEditTeleportPendingFrom: null,
      // Filled directly from the just-computed `snapshot` (same graph, same analytics) instead
      // of re-running `confirmPostEdit`'s own `computeAnalytics` wasm call, which would recompute
      // an identical result from scratch (see GitHub issue #138 profiling).
      postEditEdges: draftEdges,
      postEditTeleportEdges: postEditTeleportsToDto(generatedTeleports),
      postEditMeta: draftMeta,
      postEditAnalytics: {
        nodeStats: snapshot.node_stats,
        edgeStats: snapshot.edge_stats,
        teleportEdgeStats: snapshot.teleport_edge_stats,
        routeInfo: snapshot.route_info,
        navNodes: snapshot.nav_nodes,
        navEdges: snapshot.nav_edges,
        graphAnalytics: snapshot.graph_analytics,
        issues: snapshot.issues,
      },
      postEditDraftMeta: draftMeta,
      postEditTool: "wall" as PostEditTool,
      postEditDirty: false,
      mazeDirty: true,
      _generatedStart: snapshot.start,
      _generatedFinish: snapshot.finish,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    set({ error: msg, generationStatus: "error" });
  }
}

/**
 * Builds the exact `{ seed, config }` payload that the last actual `generateWithSeed` call sent
 * into `generateMaze` -- same `buildGenerateConfig(state)` call, same seed resolution (the last
 * seed actually used, falling back to the configured one), and `lastUsedQcExperiment` (not the
 * live `qcExperiment` toggle, which may have been flipped since without a new run happening) --
 * but instead of calling the wasm core, returns it for download. Lets a bug report attach the
 * literal input the core received, without anyone hand-reconstructing the JS->wasm config-building
 * logic (tessellation point centering/ordering, rule composition, etc.) by hand and risking drift
 * from the real code path. Returns `null` under the same precondition `generateWithSeed` bails out on.
 */
export function buildExactGenerateCallPayload(get: StoreGet): { seed: number; config: GenerateConfig } | null {
  const state = get();
  if (state.isEditingField && state.fieldPoints.size < 2) return null;
  const seed = state.lastUsedSeed ?? state.seed;
  const config = buildGenerateConfig(state);
  if (!config) return null;
  if (state.lastUsedQcExperiment) {
    applyQcExperimentOverrides(config);
  }
  return { seed, config };
}
