import type { NodeDto, EdgeDto, NavNodeDto, NavEdgeDto, CheckDescriptor, StrategyDescriptor, GenerationParams, EdgeBasedParams, ElementsConfig, InitialGenerationConfig, NodeStatsDto, SpatialEdgeStatsDto, TeleportEdgeStatsDto, RouteInfoDto, GraphAnalyticsDto, NodeLockKind, IssueDto, GenerationTimingDto } from "../wasm/types";
import type { ParsedTape, ApplyFrom } from "../debug/eventTape";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";
import type { PresetConnectionEntry, PresetConnectionTool, PresetTeleportEntry } from "../pixi/fieldEditUtils";

export type PostEditEdgeKind = "wall" | "basic" | "one_way_forward" | "one_way_backward";

export type PostEditTool = "wall" | "passage" | "reset" | "one_way" | "set_start" | "set_finish" | "teleport_one_way" | "teleport_two_way";

export interface PostEditEdge {
  from: number;
  to: number;
  kind: PostEditEdgeKind;
}

export interface PostEditMeta {
  start: number | null;
  finish: number | null;
}

export type PostEditTeleportDirection = "forward" | "backward" | "two_way";

/** A post-edit teleport link, edited by node id (unlike PresetTeleportEntry, which edits by cell
 * coordinates on the pre-generation field). Converted to EdgeDto[] at the WASM-call/render
 * boundary via `postEditTeleportsToDto`. */
export interface PostEditTeleportEntry {
  id: number;
  from: number;
  to: number;
  direction: PostEditTeleportDirection;
}

/** Endpoint of a post-edit teleport, identified for hit-testing/drag by the owning entry's id and which end it is. */
export interface PostEditTeleportEndpointHit {
  id: number;
  end: "from" | "to";
}

export interface PostEditAnalytics {
  nodeStats: NodeStatsDto;
  edgeStats: SpatialEdgeStatsDto;
  teleportEdgeStats: TeleportEdgeStatsDto;
  routeInfo: RouteInfoDto | null;
  navNodes: NavNodeDto[];
  navEdges: NavEdgeDto[];
  graphAnalytics: GraphAnalyticsDto;
  issues: IssueDto[];
}

export type TessellationKind = "square" | "hex" | "triangle";
export type SquareShape = "rect" | "free";
export type HexShape = "parallelogram" | "hexagon" | "free";
export type TriangleShape = "rect" | "triangle" | "hexagon" | "free";
export type HexOrientation = "flat_top" | "pointy_top";
export type TriOrientation = "r0" | "r90" | "r180" | "r270";
export type FieldPrimitive = "point" | "square_rect" | "hex_parallelogram" | "hex_hexagon" | "tri_rect" | "tri_triangle" | "tri_hexagon";
export type FeatureId = "basic_config" | "field_setup" | "preset_connections" | "quality" | "generation" | "post_edit" | "analytics";

/** One active check, declared inline inside the `QcRuleState` it belongs to — see GitHub issue
 * #60. A check only ever exists inside exactly one rule's `checks`; there is no separate flat
 * "active checks" list. `localId` is unique only within its owning rule (not globally) — minted
 * by `nextLocalCheckId` (see `QcRuleState`), never reused even after the check is removed.
 * `typeId` is the check type's wire id (`CheckDescriptor.id`, e.g. `"min_region_count"`). `params`
 * are this instance's own param overrides — independent of any other instance of the same type. */
export interface CheckInstance {
  localId: number;
  typeId: string;
  params: Record<string, string>;
}

/** Hard cap on nested-strategy tree depth, shared by every function that recurses over
 * `NestedStrategyState`/`ProjectFileNestedStrategy`/`NestedStrategyVM` trees (project-file
 * validation, view-model construction, default-strategy auto-fill, generate-config
 * serialization, and the recursive `NestedStrategyPanel` render). Today's registry never nests
 * more than one level deep and cannot form a cycle (no nested-capable strategy accepts its own
 * `handles()` kind), but nothing in the data model itself prevents a future registry addition
 * from doing so, and a project file loaded from disk is not otherwise bounded at all — an
 * unguarded recursive walk over a maliciously or accidentally deep `nested` array would overflow
 * the call stack. 32 is far beyond any realistic use (today's deepest real tree is 1) while still
 * generous enough that legitimate deep nesting, if it's ever added, would have to be deliberately
 * pathological to hit it.
 */
export const MAX_NESTED_STRATEGY_DEPTH = 32;

/** One step of a nested-strategy address chain — `slotId` picks which slot at this level, `index`
 * picks which of possibly several entries filling that slot (`NestedSlot.max` may be `null`,
 * i.e. unbounded — see `weighted_region_merge`'s `merge_target` slot, GitHub issue #90). `index`
 * is the entry's position among sibling entries sharing this `slotId` specifically, not a
 * position in the whole (mixed-slot) list — see `entriesForSlot`. For a slot capped at 1 (the
 * overwhelming majority today), `index` is always `0`. */
export interface PathSegment {
  slotId: string;
  index: number;
}

/** One nested strategy assignment, filling one of the parent strategy's `nested_slots` (see
 * `StrategyDescriptor.nested_slots` and `Specs/repair.md`'s nested-strategy pattern). Recursive —
 * a nested strategy can itself have nested strategies. Lives per-rule (on `QcRuleState`), not in
 * the global `strategyParams` map — two rules using the same nesting-capable top-level strategy
 * (e.g. two `reduce_scc_count` rules) must be able to pick independent nested strategies/params.
 *
 * Several entries may share the same `slotId` when that slot's `max` is `null` or `> 1` (see
 * `weighted_region_merge`, GitHub issue #90) — `slotId` alone is therefore not a unique key into
 * a `NestedStrategyState[]` list; addressing a specific entry needs `(slotId, index)`, see
 * `PathSegment`/`entriesForSlot`. */
export interface NestedStrategyState {
  /** Which parent slot this fills — matches `StrategyDescriptor.nested_slots[].slot_id`. Not
   * unique within the owning list — see this interface's own doc comment. */
  slotId: string;
  strategyId: string;
  params: Record<string, string>;
  nested: NestedStrategyState[];
}

/** Every entry in `list` filling `slotId`, in list order — that order is this slot's own
 * `index` addressing (see `PathSegment`), so callers must never resort/filter this array by
 * anything other than `slotId` before indexing into it. Shared by every consumer that needs to
 * enumerate or index a slot's entries (store actions, `NestedStrategyPanel`,
 * `useQualityViewModel`'s `buildNested`, `findRawNested`) — generic over `{ slotId: string }`
 * so it works identically for the raw `NestedStrategyState[]` tree and the resolved
 * `NestedStrategyVM[]` tree (`useQualityViewModel.ts`), which share the same `slotId`-keyed
 * shape but are otherwise different types. */
export function entriesForSlot<T extends { slotId: string }>(list: T[], slotId: string): T[] {
  return list.filter((n) => n.slotId === slotId);
}

/** A user-defined rule: a group of active checks producing the same issue kind, sharing one
 * strategy. `id` is opaque (client-generated), not derived from `checks` — rule identity
 * survives adding/removing member checks. `checks` can become empty (e.g. after removing its
 * last member via the card's own X) without the rule being dropped, so the user can repopulate it. */
export interface QcRuleState {
  id: string;
  /** User-facing name, shown as the card header. Defaults to "Rule N" at creation time (see
   * `newRule` in generationSlice.ts). Editable via the card header's edit button. */
  name: string;
  /** Issue kind shared by all member checks, captured at rule-creation time. Kept on the rule
   * itself (not derived from `checks[0]`) so it survives `checks` becoming empty. */
  kind: string;
  checks: CheckInstance[];
  /** Monotonic counter minting this rule's `CheckInstance.localId`s — never reused, even after
   * a check is removed (see `CheckInstance`'s doc comment). Not serialized to project files
   * (see `projectExport`'s `serialize.ts`) — recomputed on load as `max(checks.map(localId)) + 1`. */
  nextLocalCheckId: number;
  strategyId: string | null;
  /** Strategy-only toggle — fix is skipped, but the rule's checks still run (QC still reports
   * the issue, just unfixed). Independent from `ruleDisabled` below. */
  disabled: boolean;
  /** Whole-rule toggle — when true, the rule's checks are excluded entirely from the next
   * generate() call (not sent to core at all), as if they were never selected. Distinct from
   * `disabled` (which only skips the fix, checks still run). */
  ruleDisabled: boolean;
  /** Nested strategy assignments for `strategyId`'s nested slots, keyed by slot — empty for
   * strategies without nested slots (the overwhelming majority). */
  nestedStrategies: NestedStrategyState[];
}

/** A named, ordered group of rule ids — see `Specs/repair.md`'s "Stages" section and GitHub
 * issue #65. Core dispatches repair one stage at a time, in `GenerationState.stages` array
 * order — only rules belonging to the current stage repair-dispatch until it has no more active
 * issues, then the next stage starts. Rule membership lives here (`ruleIds`), not as a field on
 * `QcRuleState` — see plan's "Stage — контейнер со списком rule id" decision. `stages` can be
 * empty — no "at least one stage" invariant (a stage is only ever created explicitly via
 * `addStage`, or implicitly by `appendRuleToStage` if a rule needs a home and none exists). */
export interface RepairStageState {
  id: string;
  /** User-facing name, shown as the section header. Defaults to "Stage N" at creation time (see
   * `newStage` in generationSlice.ts) — the very first stage instead defaults to a fixed
   * "Waypoints" name (`quality.default_stage_name`). Editable via the section header's edit button. */
  name: string;
  /** Order is significant — it's both this stage's rule dispatch grouping and its UI/
   * serialization order. Not deduplicated against other stages' `ruleIds` by this type itself —
   * the store's actions (`moveRule`, `removeRule`, etc.) are responsible for keeping each rule id
   * in exactly one stage's `ruleIds` at a time. */
  ruleIds: string[];
  /** Whole-stage toggle — when true, every member rule's checks are excluded entirely from the
   * next `generate()` call (the whole stage is omitted from `GenerateConfig.stages`, not sent
   * with an empty `rules` list), as if the stage didn't exist for this run. Independent of any
   * member rule's own `ruleDisabled`. */
  disabled: boolean;
}

export const DEFAULT_HEX_ORI: HexOrientation = "flat_top";
export const DEFAULT_TRI_ORI: TriOrientation = "r0";

export interface TessellationState {
  seed: number;
  // Confirmed tessellation — set only on confirmTessellation()
  tessellationKind: TessellationKind;
  hexOrientation: HexOrientation;
  triOrientation: TriOrientation;
  tessellationConfirmed: boolean;
  // Preview tessellation — changes with every dropdown selection, drives canvas grid
  previewKind: TessellationKind;
  previewHexOrientation: HexOrientation;
  previewTriOrientation: TriOrientation;
  previewTessellationConfig: TessellationConfig;
  // Shape / field editing (operates on confirmed tessellation kind)
  squareShape: SquareShape;
  hexShape: HexShape;
  triangleShape: TriangleShape;
  /** Saved params per predefined config type, preserved across shape/mode switches. */
  savedConfigs: Partial<Record<TessellationConfig["type"], TessellationConfig>>;
  tessellationConfig: TessellationConfig;
  activeTessellationConfig: TessellationConfig;
  /** Per-kind free-field points, preserved when switching shapes within same kind. */
  freeFieldPoints: Record<TessellationKind, Set<number>>;
  /**
   * True when the active field is custom (free-draw). Set by:
   * - shape actions (setSquareShape/setHexShape/setTriangleShape) when shape === "free"
   * - setFieldEditMode("custom") / setFieldEditMode("default") for card-based editing
   * generate() reads this directly to decide whether to use fieldPoints.
   */
  isEditingField: boolean;
  /**
   * Active custom cell set for the current tessellation kind.
   * Mirrors freeFieldPoints[tessellationKind] for predefined-shape flow;
   * set directly by setFieldEditMode for card-based custom editing.
   */
  fieldPoints: Set<number>;
  showFieldOverlay: boolean;
  fieldEditMode: "default" | "custom";
  fieldPrimitive: FieldPrimitive;
  showFieldOrigin: boolean;
  /** True after any field setup change since the last confirmTessellation. */
  fieldDirty: boolean;
}

export interface TessellationActions {
  setSeed: (seed: number) => void;
  // Preview actions — only change preview, not confirmed
  setPreviewKind: (kind: TessellationKind) => void;
  setPreviewHexOrientation: (orientation: HexOrientation) => void;
  setPreviewTriOrientation: (orientation: TriOrientation) => void;
  // Confirm — copies preview -> confirmed, triggers confirmed-dependent state
  confirmTessellation: () => void;
  syncPreviewToConfirmed: () => void;
  // Shape actions (operate on confirmed tessellation)
  setTessellationKind: (kind: TessellationKind) => void;
  setSquareShape: (shape: SquareShape) => void;
  setHexShape: (shape: HexShape) => void;
  setTriangleShape: (shape: TriangleShape) => void;
  setHexOrientation: (orientation: HexOrientation) => void;
  setTriOrientation: (orientation: TriOrientation) => void;
  setTessellationConfig: (cfg: TessellationConfig) => void;
  addFieldPoint: (x: number, y: number) => void;
  removeFieldPoint: (x: number, y: number) => void;
  addFieldPoints: (cells: [number, number][]) => void;
  removeFieldPoints: (cells: [number, number][]) => void;
  clearFieldPoints: () => void;
  setShowFieldOverlay: (show: boolean) => void;
  setFieldEditMode: (mode: "default" | "custom") => void;
  setFieldPrimitive: (p: FieldPrimitive) => void;
  setShowFieldOrigin: (show: boolean) => void;
}

export interface PresetConnectionsState {
  presetConnections: Map<string, PresetConnectionEntry>;
  presetConnectionsTool: PresetConnectionTool;
  defaultEdgeState: "undefined" | "wall" | "passage";
  presetStart: [number, number] | null;
  presetFinish: [number, number] | null;
  presetGenSource: [number, number] | null;
  highlightInvalidPresets: boolean;
  highlightIsolatedNodes: boolean;
  showPresetOrigin: boolean;
  /** Locked nodes: key = "x,y", value = lock kind */
  lockedNodes: Map<string, NodeLockKind>;
  autoLock: boolean;
  /** Auto-locked nodes (fully-defined cells): key = "x,y". Always lock_both. */
  autoLockedNodes: Set<string>;
  /** True after any preset connection change since the last confirmTessellation. */
  presetsDirty: boolean;
  presetTeleports: PresetTeleportEntry[];
  /** First-click endpoint of an in-progress teleport placement (teleport_one_way/teleport_two_way tools). */
  presetTeleportPendingFrom: [number, number] | null;
  _nextPresetTeleportId: number;
}

export interface PresetConnectionsActions {
  setPresetConnectionsTool: (tool: PresetConnectionTool) => void;
  applyPresetConnectionsTool: (key: string, from: [number, number], to: [number, number]) => void;
  applyPresetConnectionsReset: (key: string) => void;
  clearInvalidPresetConnections: () => void;
  resetPresetConnections: () => void;
  setPresetStart: (cell: [number, number] | null) => void;
  setPresetFinish: (cell: [number, number] | null) => void;
  setPresetGenSource: (cell: [number, number] | null) => void;
  setDefaultEdgeState: (s: "undefined" | "wall" | "passage") => void;
  setHighlightInvalidPresets: (highlight: boolean) => void;
  setHighlightIsolatedNodes: (highlight: boolean) => void;
  setShowPresetOrigin: (show: boolean) => void;
  setLockedNode: (x: number, y: number, kind: NodeLockKind) => void;
  removeLockedNode: (x: number, y: number) => void;
  clearLockedNodes: () => void;
  setAutoLock: (v: boolean) => void;
  setPresetTeleportPendingFrom: (cell: [number, number] | null) => void;
  addPresetTeleport: (from: [number, number], to: [number, number], direction: "forward" | "two_way") => void;
  cyclePresetTeleportDirection: (id: number) => void;
  removePresetTeleport: (id: number) => void;
  movePresetTeleportEndpoint: (id: number, end: "from" | "to", cell: [number, number]) => void;
}

/** Handle onto the last debug generation run's raw event tape (GitHub issue #124/#125) plus the
 *  static node list needed to join reconstructed `bigint` node ids against `NodeDto.id`. */
export interface DebugArenaHandle {
  tape: ParsedTape;
  nodes: NodeDto[];
  /** Total mutating-event count for this tape — a static property of the arena (computed once at
   *  generation time), not a per-step cache; lets the UI know the last valid `debugStep` without
   *  a bounded-scan trick on every render. */
  totalSteps: number;
  /** Intermediate snapshot checkpoints (GitHub issue #128), resolved once at generation time via
   *  `resolveCheckpointFroms` into `ApplyFrom`-ready values sorted by ascending `step` — lets
   *  `selectDebugMazeView` resume `applyRecursiveBacktracker` from the nearest checkpoint instead
   *  of always replaying from scratch. Empty when the run produced no checkpoints (e.g. shorter
   *  than `CHECKPOINT_INTERVAL`) or the core didn't record any (non-Recursive-Backtracker runs). */
  checkpointFroms: ApplyFrom[];
}

/** A node/edge/cycle/region reference hovered in the debug event tree narration (GitHub issue
 *  #130) — mirrors the `Token` union built from `RecursiveBacktrackerEvent` payloads in
 *  `DebugEventTree.tsx`. `cycle`/`region` don't occur during the Recursive Backtracker pilot but
 *  are modeled now so future QC/repair narration doesn't need a shape change. */
export type HoveredDebugRef =
  | { kind: "node"; id: bigint }
  | { kind: "edge"; from: bigint; to: bigint; bidirectional: boolean }
  | { kind: "cycle"; edges: [bigint, bigint][] }
  | { kind: "region"; nodes: bigint[] };

export interface GenerationState {
  nodes: NodeDto[];
  edges: EdgeDto[];
  start: number | null;
  finish: number | null;
  navNodes: NavNodeDto[];
  navEdges: NavEdgeDto[];
  graphAnalytics: GraphAnalyticsDto | null;
  showNodeIds: boolean;
  showCoords: boolean;
  showMaze: boolean;
  selectedNode: number | null;
  issues: IssueDto[];
  error: string | null;
  registryLoaded: boolean;
  availableChecks: CheckDescriptor[];
  availableStrategies: StrategyDescriptor[];
  /** One entry per rule (a group of active checks). Replaces the old per-kind
   * `selectedStrategies`/`disabledStrategies` — a kind can now have several independent rules
   * (e.g. min/max loop length each with their own strategy) instead of being forced to share one.
   * There is no separate flat "active checks" list (see `CheckInstance`'s doc comment) — wherever
   * one is needed (UI filters, analytics), it's derived as `rules.flatMap(r => r.checks)`. */
  rules: QcRuleState[];
  /** Named, ordered rule groups — see `RepairStageState`'s doc comment and GitHub issue #65.
   * Always non-empty (see `generationSlice.ts`'s initial state and `removeStage`). */
  stages: RepairStageState[];
  /** strategyParams[strategyId][paramId] = raw string value */
  strategyParams: Record<string, Record<string, string>>;
  initialConfig: InitialGenerationConfig;
  elementsConfig: ElementsConfig;
  nodeStats: NodeStatsDto | null;
  edgeStats: SpatialEdgeStatsDto | null;
  teleportEdgeStats: TeleportEdgeStatsDto | null;
  routeInfo: RouteInfoDto | null;
  /** Per-stage and per-check/per-strategy timing breakdown — only set from a generation run, no
   *  post-edit fallback (post-edit/`compute_analytics` snapshots never run the generation pipeline). */
  timing: GenerationTimingDto | null;
  // Runtime generation state
  randomSeed: boolean;
  lastUsedSeed: number | null;
  /** Persistent QC Only mode toggle — part of the serialized project file (`generation.qcExperiment`
   *  in `ProjectFile`), so loading a project restores it and the next `generate`/`regenerate` call
   *  reproduces `qc_experiment` correctly without the user re-selecting the mode. This is the
   *  forward-looking control the UI switch binds to — it can change after a run without a new
   *  generation happening, so it is NOT what a snapshot of "what actually ran" should read. */
  qcExperiment: boolean;
  /** Whether the last actual generation run (`generate`/`regenerate`/`loadProject`) used QC Only
   *  mode — lets `buildExactGenerateCallPayload` reproduce the exact config the core last
   *  received, since `qcExperiment` (the toggle) may have been flipped after that run without a
   *  new one happening yet. */
  lastUsedQcExperiment: boolean;
  generationStatus: "idle" | "done" | "error";
  // Active feature card
  openCard: FeatureId;
  // Debug state — read-only projection, does not mutate production graph
  debugMode: boolean;
  debugAutoPlayDelay: number;
  /** Raw event-tape arena from the last debug generation run (GitHub issue #124/#125) — reconstructed
   *  maze state at `debugStep` is derived on demand via `selectDebugMazeView`, never cached here. */
  debugArena: DebugArenaHandle | null;
  debugStep: number;
  debugStale: boolean;
  /** Node/edge/cycle/region ref currently hovered in the debug event tree (GitHub issue #130) —
   *  drives `DebugRefHighlightOverlay` canvas highlighting in `GenerationRenderer`. Not
   *  persisted/serialized (no `persist`/`devtools` middleware wraps this store) — `bigint` ids
   *  mirror the `NodeId` representation already used elsewhere in the debug layer
   *  (`eventTape.ts`). Reset to `null` whenever `debugMode` turns off (see `setDebugMode`), since
   *  the tree unmounts and its hover never gets a matching `onMouseLeave`. */
  hoveredDebugRef: HoveredDebugRef | null;
  /** True after the maze has been generated since the last confirmTessellation. */
  mazeDirty: boolean;
  /** Caps on the QC repair fixpoint loop (see `Specs/repair.md`'s `RepairLimits`). Both are
   * optional and independent of each other — `null` disables that particular cap. If both are
   * `null`, the loop has no hard cap at all (only convergence/no-progress stop it), which the
   * Quality feature card surfaces as a warning. */
  repairMaxIterations: number | null;
  repairTimeBudgetSecs: number | null;
}

export interface GenerationActions {
  generate: () => void;
  /** Sets the persistent QC Only mode toggle — see `GenerationState.qcExperiment`'s doc comment.
   * When on, `generate`/`regenerate` skip the generation algorithm entirely and run QC/repair
   * directly on the preset-seeded graph (preset connections applied, no algorithmic edges added). */
  setQcExperiment: (v: boolean) => void;
  reset: () => void;
  setDebugFlag: (key: "showNodeIds" | "showCoords" | "showMaze", value: boolean) => void;
  selectNode: (id: number | null) => void;
  loadRegistry: () => Promise<void>;
  /** Activates a new `CheckInstance` of type `typeId`, minting a fresh `localId` from the
   * target rule's `nextLocalCheckId`. If `ruleId` is omitted, creates a fresh singleton rule for
   * it (the top-level "+ Add check" path). If given, activates the check directly into that
   * existing rule instead of creating a new one (the per-rule "+ Add check to rule" path).
   * No-op if `typeId`'s descriptor has `allow_multiple_instances: false` (every type, currently
   * — see GitHub issue #60, retired) and it's already active in some rule.
   * `initialParams` overrides the descriptor defaults (e.g. values edited in the select dialog
   * before confirming). */
  addCheck: (typeId: string, ruleId?: string, initialParams?: Record<string, string>) => void;
  /** Creates one fresh rule with one `CheckInstance` per `typeIds` entry (and `strategyId`, if
   * given) in a single atomic step — the multiselect "Add new rule" flow (IssueSelectDialog +
   * CheckSelectDialog + StrategySelectDialog chain). Unlike calling `addCheck` once per id,
   * this never creates intermediate singleton rules for ids after the first. All ids must share
   * one issue kind (validated by the caller's candidate filtering, same as `addCheck`). Drops
   * any `typeId` whose descriptor has `allow_multiple_instances: false` and is already active
   * in some existing rule — same restriction as `addCheck`, see GitHub issue #60. `targetStageId`,
   * when given and resolving to a known stage, places the new rule there (the per-stage toolbar's
   * "+ Add rule" button — see RulesColumn); otherwise falls back to the last stage. */
  createRule: (
    typeIds: string[],
    strategyId: string | null,
    initialCheckParams?: Record<string, Record<string, string>>,
    initialStrategyParams?: Record<string, string>,
    targetStageId?: string,
  ) => void;
  removeCheck: (ruleId: string, localId: number) => void;
  setCheckParam: (ruleId: string, localId: number, paramId: string, value: string) => void;
  /** Moves the check at `(ruleId, localId)` out of its current rule, into a fresh singleton rule
   * of its own — its params move with it (no separate lookup, they're already part of the
   * `CheckInstance`). */
  removeCheckFromRule: (ruleId: string, localId: number) => void;
  setStrategy: (ruleId: string, strategyId: string) => void;
  clearStrategy: (ruleId: string) => void;
  /** Sets, replaces, or removes (`strategyId: null`) the nested strategy at `path` — a chain of
   * `(slotId, index)` steps, each resolved relative to the node selected by the previous element
   * (see `NestedStrategyState`/`PathSegment`'s doc comments). `path: [{slotId: "merge_target",
   * index: 0}]` addresses the first entry of the slot directly under the rule's own top-level
   * strategy; a longer path addresses a slot under that nested strategy, and so on. `index` must
   * already reference an existing entry (from `addNestedStrategy` or a previous `setStrategy`
   * auto-fill) — this action replaces or clears that entry in place, it never appends. */
  setNestedStrategy: (ruleId: string, path: PathSegment[], strategyId: string | null) => void;
  setNestedStrategyParam: (ruleId: string, path: PathSegment[], paramId: string, value: string) => void;
  /** Appends a new entry to the slot addressed by `path`'s last segment (whose `index` is
   * ignored — the new entry always lands after every existing sibling sharing that `slotId`),
   * defaulted to the first strategy handling `slotKind`. No-op if no compatible strategy is
   * registered. Callers are responsible for respecting the slot's own `max` (unbounded when
   * `null`) — this action does not itself enforce a cap. */
  addNestedStrategy: (ruleId: string, path: PathSegment[], slotKind: string) => void;
  /** Removes the entry at `path` entirely (not just clearing its strategy, unlike
   * `setNestedStrategy(..., null)`, which is reserved for a single-entry, `min: 0` slot use case)
   * — every sibling entry sharing this `slotId` with a higher `index` shifts down by one, since
   * `index` is a list position, not a stable id (see `PathSegment`). */
  removeNestedStrategy: (ruleId: string, path: PathSegment[]) => void;
  toggleStrategyDisabled: (ruleId: string) => void;
  toggleRuleDisabled: (ruleId: string) => void;
  renameRule: (ruleId: string, name: string) => void;
  /** Removes a rule entirely along with its member checks — the inverse of a rule existing
   * only ever meaning its checks are active. Also removes the rule's id from whichever stage's
   * `ruleIds` currently holds it. */
  removeRule: (ruleId: string) => void;
  /** Moves the rule at `(stageId, ruleId)` one step in the combined stage-then-rule order — see
   * `Specs/quality-feature.md`'s "moveRule and stages" section for the full boundary-crossing
   * algorithm. Within one stage: an adjacent swap in that stage's `ruleIds` (same as before
   * staging existed). At a stage boundary: the rule physically moves into the neighboring stage
   * (its own `ruleIds`, not just a different rendered position) — inserted at that stage's near
   * edge (front for "down", back for "up"), including into an empty neighboring stage. No-op
   * only at the global boundary (first rule of the first stage moving "up", or last rule of the
   * last stage moving "down"). This *does* affect repair dispatch now — unlike before staging
   * existed, order across a stage boundary changes which stage a rule belongs to. */
  moveRule: (ruleId: string, direction: "up" | "down") => void;
  /** Appends a new empty stage, default name `Stage N` (N = current stage count + 1 at creation
   * time, not renumbered later). */
  addStage: () => void;
  renameStage: (stageId: string, name: string) => void;
  /** Removes the stage and every rule it holds (cascading delete) — see `RepairStageState`'s
   * doc comment on the "no minimum stage count" invariant. `RulesColumn` gates this behind a
   * confirmation dialog, since it can delete member rules along with the stage. */
  removeStage: (stageId: string) => void;
  /** Swaps `stageId` with its neighbor in `stages` order ("up" = earlier, "down" = later) — an
   * adjacent swap of the whole stage, `ruleIds` untouched. No-op at either end of the list; no
   * other restriction (an empty stage, or the sole stage, is still swappable like any other —
   * the "sole stage" case is naturally a no-op anyway, since it has no neighbor). */
  moveStage: (stageId: string, direction: "up" | "down") => void;
  /** Flips the stage's `disabled` — see `RepairStageState`'s doc comment. */
  toggleStageDisabled: (stageId: string) => void;
  setStrategyParam: (strategyId: string, paramId: string, value: string) => void;
  setGenerationParam: (key: keyof GenerationParams, value: number) => void;
  setEdgeBasedParam: (key: keyof EdgeBasedParams, value: number) => void;
  setGenerationMethod: (method: string) => void;
  setElementsParam: (key: keyof ElementsConfig, value: number) => void;
  setRandomSeed: (v: boolean) => void;
  setOpenCard: (card: FeatureId) => void;
  setDebugMode: (v: boolean) => void;
  setDebugStep: (step: number) => void;
  setDebugAutoPlayDelay: (ms: number) => void;
  setHoveredDebugRef: (ref: HoveredDebugRef | null) => void;
  regenerate: () => void;
  setError: (msg: string | null) => void;
  setRepairMaxIterations: (v: number | null) => void;
  setRepairTimeBudgetSecs: (v: number | null) => void;
}

export interface AnalyticsOverlayState {
  showMazeOverlay: boolean;
  showComponentsOverlay: boolean;
  showGraphOverlay: boolean;
  showNavGraphOverlay: boolean;
  showPureCyclesOverlay: boolean;
  showRouteOverlay: boolean;
  showRegionClassesOverlay: boolean;
  /** Whether the region-class legend modal is open. */
  regionClassLegendOpen: boolean;
  /** Base-graph [from, to] edges of the issue loops currently hovered in IssuesBlock. */
  hoveredIssueLoopEdges: [number, number][] | null;
  /** Undersized SCC region(s) currently hovered in IssuesBlock, each as its own list of maze
   * node ids — kept as separate groups (not one flat list) so adjacent-in-id-space but disjoint
   * regions don't merge into one shared outline. The renderer derives each region's perimeter
   * client-side from its node set. */
  hoveredIssueRegionGroups: number[][] | null;
  /** Expanded/collapsed state per AnalyticsFeature section, keyed by AnalyticsSectionId. */
  analyticsSectionsExpanded: Record<string, boolean>;
}

export interface AnalyticsOverlayActions {
  setShowMazeOverlay: (v: boolean) => void;
  setShowComponentsOverlay: (v: boolean) => void;
  setShowGraphOverlay: (v: boolean) => void;
  setShowNavGraphOverlay: (v: boolean) => void;
  setShowPureCyclesOverlay: (v: boolean) => void;
  setShowRouteOverlay: (v: boolean) => void;
  setShowRegionClassesOverlay: (v: boolean) => void;
  setRegionClassLegendOpen: (v: boolean) => void;
  setHoveredIssueLoopEdges: (edges: [number, number][] | null) => void;
  setHoveredIssueRegionGroups: (groups: number[][] | null) => void;
  setAnalyticsSectionExpanded: (id: string, expanded: boolean) => void;
}

export interface PostEditState {
  postEditAutoConfirm: boolean;
  postEditTool: PostEditTool;
  /** Working copy — updated on every tool click. Read by PostEditRenderer. */
  postEditDraftEdges: Record<string, PostEditEdge> | null;
  /** Teleport links, edited by node id. Kept separate from `postEditDraftEdges` (a `Record`
   * keyed by `from-to` — one slot per directed pair) since a Teleport and a Basic edge can
   * coexist in the same direction between the same pair (see `Graph::add_edge`'s kind-aware
   * dedup) and would otherwise collide in that Record. Converted to `EdgeDto[]` at the
   * WASM-call/render boundary via `postEditTeleportsToDto`. */
  postEditDraftTeleports: PostEditTeleportEntry[];
  /** Node id of the pending teleport's fixed origin during two-click placement, or null. */
  postEditTeleportPendingFrom: number | null;
  /** Monotonic id source for postEditDraftTeleports entries. */
  _nextPostEditTeleportId: number;
  /** Working copy — updated on endpoint changes. Read by PostEditRenderer. */
  postEditDraftMeta: PostEditMeta | null;
  /** Confirmed snapshot of postEditDraftEdges. Read by AnalyticsRenderer. */
  postEditEdges: Record<string, PostEditEdge> | null;
  /** Confirmed snapshot of postEditDraftTeleportEdges. Read by AnalyticsRenderer. */
  postEditTeleportEdges: EdgeDto[];
  /** Confirmed snapshot of postEditDraftMeta. Read by AnalyticsRenderer. */
  postEditMeta: PostEditMeta | null;
  /** Analytics over confirmed graph. null until first confirmPostEdit completes. */
  postEditAnalytics: PostEditAnalytics | null;
  /** Incremented on each confirmPostEdit call; stale async results are discarded. */
  _postEditRequestId: number;
  /** start/finish as generated — restored on resetPostEdit. */
  _generatedStart: number | null;
  _generatedFinish: number | null;
  /** True after any manual post-edit change since the last generate/reset. */
  postEditDirty: boolean;
}

export interface PostEditActions {
  setPostEditAutoConfirm: (v: boolean) => void;
  setPostEditTool: (tool: PostEditTool) => void;
  applyPostEditTool: (edgeKey: string, from: number, to: number) => void;
  setPostEditEndpoint: (kind: "start" | "finish", nodeId: number) => void;
  clearPostEditEndpoint: (kind: "start" | "finish") => void;
  setPostEditTeleportPendingFrom: (nodeId: number | null) => void;
  addPostEditTeleport: (from: number, to: number, direction: PostEditTeleportDirection) => void;
  cyclePostEditTeleportDirection: (id: number) => void;
  removePostEditTeleport: (id: number) => void;
  movePostEditTeleportEndpoint: (id: number, end: "from" | "to", nodeId: number) => void;
  confirmPostEdit: () => Promise<void>;
  resetPostEdit: () => void;
}

export interface RootActions {
  loadProject: (file: import("./projectExport").ProjectFile) => void;
}

export type MazeState = TessellationState & PresetConnectionsState & GenerationState & AnalyticsOverlayState & PostEditState;
export type MazeActions = RootActions & TessellationActions & PresetConnectionsActions & GenerationActions & AnalyticsOverlayActions & PostEditActions;
export type MazeStore = MazeState & MazeActions;
