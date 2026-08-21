import { generateMaze } from "../../wasm/mazeService";
import type { GenerateConfig, WasmTessellationConfig, StrategyConfig } from "../../wasm/types";
import type { FieldConfig as TessellationConfig } from "../../fieldConfig";
import { computeInvalidKeys, computeInvalidTeleportIds, computeInvalidMarkers, computeInvalidSplitPoints, computeInvalidVerticalPassageIds, computeInvalidElevatorIds, presetTeleportEntryToState, presetVerticalPassageDirectionToDto } from "../../pixi/fieldEditUtils";
import { presetEndpoint, presetEndpointToDto } from "../../pixi/presetEndpoint";
import { configAllCells } from "../../pixi/tessellationCells";
import { postEditTeleportsToDto } from "../../pixi/postEditUtils";
import { buildMultiFloorPostEditDraft } from "./postEditSliceHelpers";
import { MAX_NESTED_STRATEGY_DEPTH } from "../storeTypes";
import type { MazeStore, PostEditTool, QcRuleState, NestedStrategyState, DebugArenaHandle } from "../storeTypes";
import { activeFloorTessellationOf, activeFloorField, floorTessellationOf, resolveFieldAtOf, relevantRuleParams } from "../storeHelpers";
import { warmCartesianCache } from "../../pixi/cartesianCache";
import { parseTape, topLevelSourceScopes, sourceContentStart } from "../../debug/eventTape";
import { adapterForKind } from "../../debug/algorithmRegistry";
import { splitPatternsToCore } from "../../pixi/tessellationGeometry";

export type StoreSet = (partial: Partial<MazeStore> | ((s: MazeStore) => Partial<MazeStore>)) => void;
export type StoreGet = () => MazeStore;

/** Picks `DebugArenaHandle.algorithmKind` out of a resolved `sources` list — the generation
 *  source's own kind, *not* necessarily `sources[0]` (GitHub issue #225's "preset setup" source,
 *  when present, is always merged before generation — Contract A, `Specs/event_log.md`'s #147
 *  section). Falls back to `sources[sources.length - 1].kind` (always "quality_control", per
 *  Contract A's fixed source order) only for `qc_experiment` runs (GitHub issue #173), which have
 *  no generation source at all — a preset setup source can still precede it there (it's
 *  independent of `qc_experiment`, see `runner.rs`'s `preset_setup_log` doc comment). Requires
 *  `sources` non-empty (call sites only reach this once `sources.length > 0` is already known). */
export function resolveAlgorithmKind(sources: DebugArenaHandle["sources"]): DebugArenaHandle["algorithmKind"] {
  const generationSource = sources.find((s) => s.kind !== "preset_setup" && s.kind !== "quality_control");
  return generationSource?.kind ?? sources[sources.length - 1].kind;
}

export function fieldConfigToWasm(cfg: TessellationConfig): WasmTessellationConfig {
  const t = cfg.type;
  const tessellation_type = t.startsWith("hex") ? "hex" as const
    : (t.startsWith("tri") || t.startsWith("triangle")) ? "tri" as const
    : "square" as const;
  return { tessellation_type };
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
function ruleToConfig(state: MazeStore, g: QcRuleState): { id: string; checks: { local_id: string; type_id: string; params: Record<string, string> }[]; strategy: StrategyConfig | null; params: Record<string, string> } {
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
  // determinism doesn't depend on Map/object iteration order at this layer. A `disabled` check
  // (see `CheckInstance.disabled`'s doc comment) is omitted entirely, as if never selected.
  const checks = g.checks.filter((c) => !c.disabled).map((c) => ({ local_id: c.localId.toString(), type_id: c.typeId, params: c.params }));
  // Rule-level parameters (e.g. `protect_route`, GitHub issue #253) — only descriptor-known ids
  // relevant to this rule's own composition are forwarded, same relevance rule `RuleParamsSection`
  // uses for display (`relevantRuleParams`), same "only descriptor-known ids" spirit
  // `nestedToConfig`/the strategy branch above use.
  const activeCheckTypeIds = g.checks.filter((c) => !c.disabled).map((c) => c.typeId);
  const ruleParams: Record<string, string> = {};
  for (const p of relevantRuleParams(state.availableRuleParams, activeCheckTypeIds, g.disabled ? null : g.strategyId)) {
    if (g.params[p.id] !== undefined) ruleParams[p.id] = g.params[p.id];
  }
  return { id: g.id, checks, strategy, params: ruleParams };
}

/** The project's currently-valid preset connections (regular + teleport), converted to wire DTOs
 *  — shared by `buildGenerateConfig` (generation, every floor at once — GitHub issue #340) and
 *  `confirmPostEdit` (GitHub issue #245's `ComputeAnalyticsConfig.preset_connections`, which only
 *  ever resolves against floor 0 — `Specs/floors.md`'s "Non-goals" — hence `floorZeroOnly`). An
 *  "undefined"-state or geometrically-invalid entry (removed cell, shrunk tessellation, on any
 *  floor) is excluded, same as `buildGenerateConfig` already excluded them before this was
 *  extracted. */
export function buildValidPresetConnections(state: MazeStore, floorZeroOnly = false): import("../../wasm/types").PresetConnection[] {
  const resolveFieldAt = resolveFieldAtOf(state);
  const invalidKeys = computeInvalidKeys(state.presetConnections, resolveFieldAt);
  const onFloorZero = (level: number | undefined) => !floorZeroOnly || (level ?? 0) === 0;
  const validPresets = Array.from(state.presetConnections.entries())
    .filter(([key, e]) => e.state !== "undefined" && !invalidKeys.has(key) && onFloorZero(e.from.level) && onFloorZero(e.to.level))
    .map(([, e]) => ({
      from: presetEndpointToDto(e.from), to: presetEndpointToDto(e.to),
      state: e.state as import("../../wasm/types").PresetConnectionState,
    }));
  const invalidTeleportIds = computeInvalidTeleportIds(state.presetTeleports, resolveFieldAt);
  const validTeleportPresets = state.presetTeleports
    .filter(t => !invalidTeleportIds.has(t.id) && onFloorZero(t.from.level) && onFloorZero(t.to.level))
    .map(t => ({ from: presetEndpointToDto(t.from), to: presetEndpointToDto(t.to), state: presetTeleportEntryToState(t.direction) }));
  return [...validPresets, ...validTeleportPresets];
}

/** The project's currently-valid preset `VerticalPassage` links, converted to wire DTOs (GitHub
 *  issue #357) — kept as their own top-level `GenerateConfig.preset_vertical_passages` field (not
 *  folded into `preset_connections`), mirroring `PresetVerticalPassage`'s own Rust-side rationale. */
export function buildValidPresetVerticalPassages(state: MazeStore): import("../../wasm/types").PresetVerticalPassageDto[] {
  const resolveFieldAt = resolveFieldAtOf(state);
  const invalidIds = computeInvalidVerticalPassageIds(state.presetVerticalPassages, resolveFieldAt);
  return state.presetVerticalPassages
    .filter((p) => !invalidIds.has(p.id))
    .map((p) => ({
      from: presetEndpointToDto(p.from), to: presetEndpointToDto(p.to),
      one_way: presetVerticalPassageDirectionToDto(p.direction),
    }));
}

/** The project's currently-valid preset `Elevator` links, converted to wire DTOs (GitHub issue #357). */
export function buildValidPresetElevators(state: MazeStore): import("../../wasm/types").PresetElevatorDto[] {
  const resolveFieldAt = resolveFieldAtOf(state);
  const invalidIds = computeInvalidElevatorIds(state.presetElevators, resolveFieldAt);
  return state.presetElevators
    .filter((e) => !invalidIds.has(e.id))
    .map((e) => ({ floors: e.floors.map(presetEndpointToDto) }));
}

export function buildGenerateConfig(state: MazeStore): GenerateConfig | null {
  const activeField = activeFloorField(state);
  if (activeField.isEditingField && activeField.fieldPoints.size < 2) return null;
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
        // A rule with zero *effective* checks (every member disabled, or the rule left with no
        // members at all — see `QcRuleState.checks`'s "can become empty" doc comment) is omitted
        // the same way a `ruleDisabled` rule is: core's `build_qc_and_repair` rejects an empty
        // `checks` array outright ("rule <id> has no checks"), so it must never cross the wasm
        // boundary with one.
        .filter((g): g is QcRuleState => g !== undefined && !g.ruleDisabled && g.checks.some((c) => !c.disabled))
        .map((g) => ruleToConfig(state, g)),
    }));
  const activeTessellation = activeFloorTessellationOf(state);
  const resolveFieldAt = resolveFieldAtOf(state);
  const lockedEntries = new Map(state.lockedNodes);
  for (const key of state.autoLockedNodes) {
    if (!lockedEntries.has(key)) lockedEntries.set(key, "both");
  }
  // Key is "x,y" (floor 0) or "x,y@level" (GitHub issue #340) — parsed back into (point, level)
  // for the wire DTO, same convention `presetEndpointKey`/`splitPointsCore.ts`'s `pointKey` use.
  const locked_nodes = Array.from(lockedEntries.entries()).map(([key, kind]) => {
    const [pointPart, levelPart] = key.split("@");
    const [x, y] = pointPart.split(",").map(Number) as [number, number];
    const level = levelPart === undefined ? undefined : Number(levelPart);
    return { point: presetEndpointToDto(presetEndpoint([x, y], undefined, level)), kind };
  });
  const invalidMarkers = computeInvalidMarkers(state.presetStart, state.presetFinish, resolveFieldAt);
  const invalidSplitKeys = computeInvalidSplitPoints(state.presetSplitPoints, resolveFieldAt);
  const split_points: [[number, number], number, number][] = Object.entries(state.presetSplitPoints)
    .filter(([key]) => !invalidSplitKeys.has(key))
    .flatMap(([key, slots]) => {
      const [pointPart, levelPart] = key.split("@");
      const [x, y] = pointPart.split(",").map(Number) as [number, number];
      const level = levelPart === undefined ? 0 : Number(levelPart);
      return slots.map((slotId): [[number, number], number, number] => [[x, y], slotId, level]);
    });
  const level_fields = state.floors.map((floor) => configAllCells(floorTessellationOf(state, floor.id)));
  return {
    tessellation: fieldConfigToWasm(activeTessellation),
    level_fields,
    stages,
    ...(state.repairMaxIterations != null ? { repair_max_iterations: state.repairMaxIterations } : {}),
    ...(state.repairTimeBudgetSecs != null ? { repair_time_budget_secs: state.repairTimeBudgetSecs } : {}),
    initial: state.initialConfig,
    elements: state.elementsConfig,
    preset_connections: buildValidPresetConnections(state),
    preset_vertical_passages: buildValidPresetVerticalPassages(state),
    preset_elevators: buildValidPresetElevators(state),
    locked_nodes,
    split_points,
    split_generation: {
      pattern_mode: state.splitPatternMode,
      max_split_nodes: state.splitMaxNodes,
      patterns: splitPatternsToCore(state.splitPatterns, activeTessellation),
    },
    ...(state.presetStart && !invalidMarkers.start ? { preset_start: presetEndpointToDto(state.presetStart) } : {}),
    ...(state.presetGenSource ? { preset_gen_source: presetEndpointToDto(state.presetGenSource) } : {}),
    ...(state.presetFinish && !invalidMarkers.finish ? { preset_finish: presetEndpointToDto(state.presetFinish) } : {}),
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
  const activeField = activeFloorField(state);
  if (activeField.isEditingField && activeField.fieldPoints.size < 2) {
    set({ error: "Free field requires at least 2 cells", generationStatus: "error" });
    return;
  }
  const activeTessellation = activeFloorTessellationOf(state);
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
      // One entry per top-level source scope (GitHub issue #147/#169/#225) — preset setup (when
      // present) always first, then generation, then QC, per Contract A (`Specs/event_log.md`'s
      // #147 section). Checkpoints (GitHub issue #128, generalized past Recursive Backtracker) are computed on
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
          tape, algorithmKind: resolveAlgorithmKind(sources), sources, nodes: snapshot.nodes, totalSteps,
          debugValueNames: debugTape.debugValueNames, allNodes: debugTape.allNodes,
        };
        lastStep = Math.max(0, totalSteps - 1);
      }
    }
    // GitHub issue #222: the generator can now mint extra nodes at a point during its own run
    // (automatic split), with no corresponding slot ever registered on the web side — derive one
    // fresh from the snapshot itself so `ManageSplitNodesDialog`/`postEditActiveSplitNode`-based
    // resolution (and rendering) see every resulting node, not just the point's original one.
    // `buildMultiFloorPostEditDraft` is shared with `resetPostEdit`'s identical rebuild in
    // `postEditSlice.ts` (GitHub issue #425 — the two used to duplicate this per-level logic, and
    // this path's own copy used a single global, level-unaware node/point grouping across every
    // floor combined, silently breaking every split point on any floor above the first).
    const {
      draftEdges, draftTeleports: generatedTeleports, splitPoints: generatedSplitPoints, endpointFor: endpointForGeneratedId,
    } = buildMultiFloorPostEditDraft(snapshot.nodes, snapshot.edges);
    const nextTeleportId = generatedTeleports.length + 1;
    const draftMeta = {
      start: snapshot.start !== null ? endpointForGeneratedId(snapshot.start) : null,
      finish: snapshot.finish !== null ? endpointForGeneratedId(snapshot.finish) : null,
    };
    set({
      nodes: snapshot.nodes,
      edges: snapshot.edges,
      start: snapshot.start,
      finish: snapshot.finish,
      navNodes: snapshot.nav_nodes,
      navEdges: snapshot.nav_edges,
      statistics: snapshot.statistics,
      selectedNode: null,
      issues: snapshot.issues,
      error: null,
      activeTessellationConfig: activeTessellation,
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
      postEditDraftSplitPoints: generatedSplitPoints,
      postEditActiveSplitNode: {},
      _nextPostEditTeleportId: nextTeleportId,
      postEditTeleportPendingFrom: null,
      // Filled directly from the just-computed `snapshot` (same graph, same analytics) instead
      // of re-running `confirmPostEdit`'s own `computeAnalytics` wasm call, which would recompute
      // an identical result from scratch (see GitHub issue #138 profiling).
      postEditEdges: draftEdges,
      // Every teleport endpoint here is already a real, resolved `NodeId` (wasm reports one
      // regardless of which of a point's nodes it is) — a plain node endpoint, not a `split` one,
      // so `resolveSplit` is never actually invoked even though `generatedSplitPoints` may be
      // non-empty.
      postEditTeleportEdges: postEditTeleportsToDto(generatedTeleports, () => undefined),
      postEditMeta: draftMeta,
      postEditAnalytics: {
        statistics: snapshot.statistics,
        routeInfo: snapshot.route_info,
        navNodes: snapshot.nav_nodes,
        navEdges: snapshot.nav_edges,
        issues: snapshot.issues,
      },
      postEditDraftMeta: draftMeta,
      postEditTool: "wall" as PostEditTool,
      postEditDirty: false,
      mazeDirty: true,
      _generatedStart: snapshot.start,
      _generatedFinish: snapshot.finish,
      _generatedNodes: snapshot.nodes,
      _generatedEdges: snapshot.edges,
      // User-placed vertical passages/elevators (GitHub issue #341) have no generation-time
      // counterpart to seed from — a fresh generate() clears any leftover draft from the previous
      // maze, same as it clears every other post-edit draft collection above.
      postEditDraftVerticalPassages: [],
      postEditVerticalPassagePending: null,
      _nextPostEditVerticalPassageId: 1,
      postEditDraftElevators: [],
      postEditElevatorPending: null,
      _nextPostEditElevatorId: 1,
      postEditSuppressedElevatorPairs: new Set<string>(),
      postEditSuppressedVerticalPassagePairs: new Set<string>(),
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
  const field = activeFloorField(state);
  if (field.isEditingField && field.fieldPoints.size < 2) return null;
  const seed = state.lastUsedSeed ?? state.seed;
  const config = buildGenerateConfig(state);
  if (!config) return null;
  if (state.lastUsedQcExperiment) {
    applyQcExperimentOverrides(config);
  }
  return { seed, config };
}
