import type { NodeDto, EdgeDto, NavNodeDto, NavEdgeDto, CheckDescriptor, StrategyDescriptor, GenerationParams, EdgeBasedParams, ElementsConfig, InitialGenerationConfig, NodeStatsDto, SpatialEdgeStatsDto, RouteInfoDto, GraphAnalyticsDto, GenerationStepsSnapshot, NodeLockKind, IssueDto, GenerationTimingDto } from "../wasm/types";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";
import type { PresetConnectionEntry, PresetConnectionTool } from "../pixi/presetConnectionsUtils";

export type PostEditEdgeKind = "wall" | "basic" | "one_way_forward" | "one_way_backward";

export type PostEditTool = "wall" | "passage" | "reset" | "one_way" | "set_start" | "set_finish";

export interface PostEditEdge {
  from: number;
  to: number;
  kind: PostEditEdgeKind;
}

export interface PostEditMeta {
  start: number | null;
  finish: number | null;
}

export interface PostEditAnalytics {
  nodeStats: NodeStatsDto;
  edgeStats: SpatialEdgeStatsDto;
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
}

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
  /** strategyParams[strategyId][paramId] = raw string value */
  strategyParams: Record<string, Record<string, string>>;
  initialConfig: InitialGenerationConfig;
  elementsConfig: ElementsConfig;
  nodeStats: NodeStatsDto | null;
  edgeStats: SpatialEdgeStatsDto | null;
  routeInfo: RouteInfoDto | null;
  /** Per-stage and per-check/per-strategy timing breakdown — only set from a generation run, no
   *  post-edit fallback (post-edit/`compute_analytics` snapshots never run the generation pipeline). */
  timing: GenerationTimingDto | null;
  // Runtime generation state
  randomSeed: boolean;
  lastUsedSeed: number | null;
  generationStatus: "idle" | "done" | "error";
  // Active feature card
  openCard: FeatureId;
  // Debug state — read-only projection, does not mutate production graph
  debugMode: boolean;
  debugAutoPlayDelay: number;
  debugSnapshot: GenerationStepsSnapshot | null;
  debugStep: number;
  debugStale: boolean;
  showDebugFrontier: boolean;
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
  reset: () => void;
  setDebugFlag: (key: "showNodeIds" | "showCoords" | "showMaze", value: boolean) => void;
  selectNode: (id: number | null) => void;
  loadRegistry: () => Promise<void>;
  /** Activates a new `CheckInstance` of type `typeId`, minting a fresh `localId` from the
   * target rule's `nextLocalCheckId`. If `ruleId` is omitted, creates a fresh singleton rule for
   * it (the top-level "+ Add check" path). If given, activates the check directly into that
   * existing rule instead of creating a new one (the per-rule "+ Add check to rule" path).
   * No-op if `typeId`'s descriptor has `allow_multiple_instances: false` (every type except
   * `min_region_count`) and it's already active in some rule — see GitHub issue #60.
   * `initialParams` overrides the descriptor defaults (e.g. values edited in the select dialog
   * before confirming). */
  addCheck: (typeId: string, ruleId?: string, initialParams?: Record<string, string>) => void;
  /** Creates one fresh rule with one `CheckInstance` per `typeIds` entry (and `strategyId`, if
   * given) in a single atomic step — the multiselect "Add new rule" flow (IssueSelectDialog +
   * CheckSelectDialog + StrategySelectDialog chain). Unlike calling `addCheck` once per id,
   * this never creates intermediate singleton rules for ids after the first. All ids must share
   * one issue kind (validated by the caller's candidate filtering, same as `addCheck`). Drops
   * any `typeId` whose descriptor has `allow_multiple_instances: false` and is already active
   * in some existing rule — same restriction as `addCheck`, see GitHub issue #60. */
  createRule: (
    typeIds: string[],
    strategyId: string | null,
    initialCheckParams?: Record<string, Record<string, string>>,
    initialStrategyParams?: Record<string, string>,
  ) => void;
  removeCheck: (ruleId: string, localId: number) => void;
  setCheckParam: (ruleId: string, localId: number, paramId: string, value: string) => void;
  /** Moves the check at `(ruleId, localId)` out of its current rule, into a fresh singleton rule
   * of its own — its params move with it (no separate lookup, they're already part of the
   * `CheckInstance`). */
  removeCheckFromRule: (ruleId: string, localId: number) => void;
  setStrategy: (ruleId: string, strategyId: string) => void;
  clearStrategy: (ruleId: string) => void;
  toggleStrategyDisabled: (ruleId: string) => void;
  toggleRuleDisabled: (ruleId: string) => void;
  renameRule: (ruleId: string, name: string) => void;
  /** Removes a rule entirely along with its member checks — the inverse of a rule existing
   * only ever meaning its checks are active. */
  removeRule: (ruleId: string) => void;
  /** Swaps `ruleId` with its neighbor in `rules` order ("up" = earlier, "down" = later). Purely
   * organizational — core's repair dispatch is order-agnostic (see `repair.md`), so this only
   * affects how rules are listed in the UI and serialized in `check_rules`, not repair behavior.
   * No-op at either end of the list. */
  moveRule: (ruleId: string, direction: "up" | "down") => void;
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
  setShowDebugFrontier: (v: boolean) => void;
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
  /** Working copy — updated on endpoint changes. Read by PostEditRenderer. */
  postEditDraftMeta: PostEditMeta | null;
  /** Confirmed snapshot of postEditDraftEdges. Read by AnalyticsRenderer. */
  postEditEdges: Record<string, PostEditEdge> | null;
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
  confirmPostEdit: () => Promise<void>;
  resetPostEdit: () => void;
}

export interface RootActions {
  loadProject: (file: import("./projectExport").ProjectFile) => void;
}

export type MazeState = TessellationState & PresetConnectionsState & GenerationState & AnalyticsOverlayState & PostEditState;
export type MazeActions = RootActions & TessellationActions & PresetConnectionsActions & GenerationActions & AnalyticsOverlayActions & PostEditActions;
export type MazeStore = MazeState & MazeActions;
