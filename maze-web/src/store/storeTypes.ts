import type { NodeDto, EdgeDto, NavNodeDto, NavEdgeDto, CheckDescriptor, StrategyDescriptor, RuleParamDescriptor, GenerationParams, EdgeBasedParams, ElementsConfig, InitialGenerationConfig, NodeStatsDto, SpatialEdgeStatsDto, TeleportEdgeStatsDto, RouteInfoDto, GraphAnalyticsDto, SplitAnalyticsDto, NodeLockKind, IssueDto, GenerationTimingDto, SplitPattern } from "../wasm/types";
import type { ParsedTape, Snapshot, DebugValueDescriptor } from "../debug/eventTape";
import type { EventedEventKind } from "../wasm/mazeService";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";
import type { PresetConnectionEntry, PresetConnectionTool, PresetTeleportEntry } from "../pixi/fieldEditUtils";
import type { PostEditEndpoint } from "../pixi/postEditEndpoint";
import type { PresetEndpoint } from "../pixi/presetEndpoint";
import type { SplitNodeBlueprint } from "../pixi/splitBlueprints";
import type { MarkerShape, OneWayPattern, TeleportGroupOverride, TeleportCornerStyle, TeleportConnectorStyle, TeleportArrowMode } from "../pixi/renderers/types";

export type PostEditEdgeKind = "wall" | "basic" | "one_way_forward" | "one_way_backward";

export type PostEditTool = "wall" | "passage" | "reset" | "one_way" | "set_start" | "set_finish" | "teleport_one_way" | "teleport_two_way" | "manage_split_nodes";

export interface PostEditEdge {
  from: PostEditEndpoint;
  to: PostEditEndpoint;
  kind: PostEditEdgeKind;
}

/** `start`/`finish` are `PostEditEndpoint`, not a bare `number` — see `postEditEndpoint.ts`'s doc
 * comment for why a split node's raw `NodeId` isn't safe to keep across confirms. */
export interface PostEditMeta {
  start: PostEditEndpoint | null;
  finish: PostEditEndpoint | null;
}

export type PostEditTeleportDirection = "forward" | "backward" | "two_way";

/** A post-edit teleport link, edited by node/split endpoint (unlike PresetTeleportEntry, which
 * edits by cell coordinates on the pre-generation field). Converted to EdgeDto[] at the
 * WASM-call/render boundary via `postEditTeleportsToDto`. */
export interface PostEditTeleportEntry {
  id: number;
  from: PostEditEndpoint;
  to: PostEditEndpoint;
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
  splitAnalytics: SplitAnalyticsDto;
  issues: IssueDto[];
}

export type TessellationKind = "square" | "hex" | "triangle";
export type SquareShape = "rect" | "free";
export type HexShape = "parallelogram" | "hexagon" | "free";
export type TriangleShape = "rect" | "triangle" | "hexagon" | "free";
export type HexOrientation = "flat_top" | "pointy_top";
export type TriOrientation = "r0" | "r90" | "r180" | "r270";
export type FieldPrimitive = "point" | "square_rect" | "hex_parallelogram" | "hex_hexagon" | "tri_rect" | "tri_triangle" | "tri_hexagon";
export type FeatureId = "basic_config" | "field_setup" | "preset_connections" | "quality" | "generation" | "post_edit" | "analytics" | "image_export";

/** Registry id of a maze image-export rendering mode (see `Specs/image-export.md` and
 * `imageExportRegistry.ts`) — one entry per switcher item in the Image Export feature card. */
export type RenderModeId = "vector_by_walls" | "vector_by_corridors";

/** Registry id of a maze image-export output format (see `exportFormatRegistry.ts`) — one entry
 * per row in the Image Export feature card's format list, below the render-mode switcher. */
export type ExportFormatId = "png";

export type PngExportOutputMode = "digital" | "print";
export type PngCanvasMode = "edge_to_edge" | "margin_px" | "margin_cells" | "fixed_size";
export type PrintDensity = "screen_96" | "draft_150" | "print_300" | "high_600";
export type PaperSize = "a4" | "a3" | "a5" | "a2" | "a1" | "a0" | "letter" | "legal" | "tabloid" | "custom";
export type PaperOrientation = "portrait" | "landscape";
export type PrintAnchor = "top_left" | "top_center" | "top_right"
  | "center_left" | "center" | "center_right"
  | "bottom_left" | "bottom_center" | "bottom_right"
  | "custom";

export interface DigitalExportSettings {
  /** Multiplier of `TILE_SIZE` — same world-space unit as `PrintExportSettings.scale`. Kept as a
   * separate field (not shared) because the two output modes' scale are independent: switching
   * modes must not silently carry one over into the other. */
  scale: number;
  canvasMode: PngCanvasMode;
  /** Px (canvasMode=margin_px) or cells (canvasMode=margin_cells) — same field reused for both,
   * since only one of the two modes is ever active at a time. */
  marginValue: number;
  fixedWidth: number;
  fixedHeight: number;
}

export interface PrintExportSettings {
  density: PrintDensity;
  paperSize: PaperSize;
  /** Used only when paperSize === "custom" — otherwise the standard size overrides it. */
  customWidthMm: number;
  customHeightMm: number;
  orientation: PaperOrientation;
  marginHMm: number;
  marginVMm: number;
  /** Same world-space unit as `DigitalExportSettings.scale` — see its doc-comment. Ignored (kept
   * up to date but not user-editable) while `scaleAutoFit` is on. */
  scale: number;
  /** While on, `scale` is recomputed automatically (`computeAutoFitPrintScale`) on every change
   * that could affect the fit — sheet size/orientation/DPI, margins, or the maze itself — instead
   * of the user setting it by hand. The scale input is disabled in this state. */
  scaleAutoFit: boolean;
  anchor: PrintAnchor;
  /** Content offset in mm from the margin-inset area's top-left corner — only meaningful (and only
   * ever written) when `anchor === "custom"`, set automatically when the user pans/zooms the maze
   * under the on-canvas print frame (see `ExportFrameOverlay`) instead of picking one of the 9
   * fixed anchor positions. Ignored by `computePrintExportFit` for every other anchor value. */
  offsetXMm: number;
  offsetYMm: number;
}

/** PNG export settings — two independent output-mode branches (`digital`/`print`), only one
 * active at a time per `outputMode`, but both persisted so switching modes doesn't lose the
 * other's configuration. */
export interface PngExportSettings {
  outputMode: PngExportOutputMode;
  digital: DigitalExportSettings;
  print: PrintExportSettings;
}

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
  /** Per-check toggle — when true, this check is excluded entirely from the next `generate()`
   * call (not sent to core at all), as if it were never selected, mirroring `QcRuleState.ruleDisabled`
   * at check granularity. A disabled check still counts toward `isTypeAlreadyActive`'s single-instance
   * gating, so a user can't stack duplicate instances of a type limited to one active instance by
   * disabling the existing one first — re-enabling it is a toggle away instead of an add. */
  disabled: boolean;
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
  /** Rule-level parameters (e.g. `protect_route`) — shared by every check/strategy in this rule
   * that has been migrated to consume it instead of its own per-instance override (GitHub issue
   * #253). Keyed by `ParamDescriptor.id`, same shape as `CheckInstance.params`. */
  params: Record<string, string>;
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
  presetStart: PresetEndpoint | null;
  presetFinish: PresetEndpoint | null;
  presetGenSource: PresetEndpoint | null;
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
  /** slotIds of each split point's extra nodes declared on the preset stage, keyed by "x,y"
   * (GitHub issue #231) — mirrors post-edit's `postEditDraftSplitPoints`. */
  presetSplitPoints: Record<string, number[]>;
  /** Which of a split point's nodes preset edge-tool clicks currently target, keyed by "x,y". No
   * entry means the point's original node. Mirrors post-edit's `postEditActiveSplitNode`. */
  presetActiveSplitNode: Record<string, PresetEndpoint>;
  /** The point currently selected for the "Manage split nodes" dialog on the preset stage. */
  presetFocusedPoint: [number, number] | null;
  /** The link (edge/teleport) currently hovered in the preset "Manage split nodes" panel's link
   *  bubbles (GitHub issue #237) — `null` when nothing is hovered. Drives a canvas highlight the
   *  same way `EdgeHighlightRenderer`'s pointermove-driven hover does, but sourced from the panel
   *  instead of the cursor. */
  presetHoveredLink: { from: PresetEndpoint; to: PresetEndpoint } | null;
}

export interface PresetConnectionsActions {
  setPresetConnectionsTool: (tool: PresetConnectionTool) => void;
  applyPresetConnectionsTool: (key: string, from: [number, number], to: [number, number]) => void;
  /** Same as `applyPresetConnectionsTool`, but takes `tool` explicitly instead of reading
   * `state.presetConnectionsTool` — used by the "Manage split nodes" dialog's own kind switcher
   * (GitHub issue #234), which must not disturb the canvas's globally active edge tool. */
  applyPresetConnectionsToolAt: (tool: PresetConnectionTool, key: string, from: [number, number], to: [number, number]) => void;
  /** Sets an edge to the client-only `"undefined"` state (explicit "preset allows but doesn't
   * force" — GitHub issue #234's "preset optional connection"). No `PresetConnectionTool` produces
   * this state (see `Specs/preset-connections.md`'s "Entry source" — `reset` never pins `undefined`
   * when a default is active); the "Manage split nodes" dialog is the only UI path to set it
   * explicitly, so it bypasses `applyTool` and writes the entry directly. */
  setPresetConnectionUndefined: (key: string, from: PresetEndpoint, to: PresetEndpoint) => void;
  applyPresetConnectionsReset: (key: string) => void;
  clearInvalidPresetConnections: () => void;
  resetPresetConnections: () => void;
  setPresetStart: (cell: [number, number] | null) => void;
  setPresetFinish: (cell: [number, number] | null) => void;
  setPresetGenSource: (cell: [number, number] | null) => void;
  /** Same as `setPresetStart`/`setPresetFinish`, but take a `PresetEndpoint` directly instead of
   * resolving via `state.presetActiveSplitNode` — used by the "Manage split nodes" dialog (GitHub
   * issue #234) to assign start/finish to a *specific* node of a split point, independent of
   * which node happens to be globally active for canvas clicks. */
  setPresetStartEndpoint: (endpoint: PresetEndpoint | null) => void;
  setPresetFinishEndpoint: (endpoint: PresetEndpoint | null) => void;
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
  addPresetSplitNode: (point: [number, number]) => void;
  removePresetSplitNode: (point: [number, number], slotId: number) => void;
  cyclePresetActiveSplitNode: (point: [number, number]) => void;
  setPresetActiveSplitNode: (point: [number, number], endpoint: PresetEndpoint) => void;
  setPresetFocusedPoint: (point: [number, number] | null) => void;
  setPresetHoveredLink: (link: { from: PresetEndpoint; to: PresetEndpoint } | null) => void;
  /** Rotates every geometric-face connection of `point`'s nodes (original + every declared slot)
   * by one offset index — see `rotatePresetSplitPoint` (fieldEditUtils.ts). No-op if it would push
   * any connection outside the field. */
  rotatePresetSplitPoint: (point: [number, number], direction: 1 | -1) => void;
  /** Applies a built-in split-node blueprint (GitHub issue #235) to `point` — a full replace:
   * every existing slot at the point (and every connection/teleport/start/finish/gen-source
   * reference to it) is dropped first, then one fresh slot per blueprint node is minted and its
   * required faces get a `passage`. See `splitBlueprints.ts`. */
  applyPresetSplitBlueprint: (point: [number, number], blueprint: SplitNodeBlueprint) => void;
}

/** Handle onto the last debug generation run's raw event tape (GitHub issue #124/#125) plus the
 *  static node list needed to join reconstructed `bigint` node ids against `NodeDto.id`. */
export interface DebugArenaHandle {
  tape: ParsedTape;
  /** Which concrete event enum `tape`'s generation source was encoded from — the generation
   *  source's own kind, *not* necessarily `sources[0]` (GitHub issue #225's "preset setup" source,
   *  when present, is always merged before generation — Contract A, `Specs/event_log.md`'s #147
   *  section). Falls back to `sources[sources.length - 1].kind` (always "quality_control", per
   *  Contract A's fixed source order) only for `qc_experiment` runs (GitHub issue #173), which
   *  have no generation source at all — a preset setup source can still precede it there. Kept
   *  only for the handful of call sites that are
   *  inherently generation-specific (e.g. `GenerationRenderer.ts`'s Kruskal DSU-groups toggle,
   *  `DebugPanel.tsx`'s Kruskal-only UI) — anything that needs to dispatch per-node across a
   *  possibly-multi-source tape must use `sources`/`adapterForNode` instead, never this field. */
  algorithmKind: EventedEventKind;
  /** One entry per top-level source scope in `tape`, in the same order as `topLevelSourceScopes`
   *  (GitHub issue #147/#169) — `algorithmKind` above is derived from whichever entry here is the
   *  generation source (see that field's doc comment), not simply `sources[0]`, kept as a
   *  separate field for the generation-specific call sites described in that field's doc comment.
   *  `startStep`/`endStep` are 0-based, half-open `[startStep, endStep)` ranges into the same
   *  global `debugStep` numbering `debugStep`/`totalSteps` already use (Contract A) — e.g. with a
   *  200-step generation source followed by a 12-step QC source, `sources` is
   *  `[{ startStep: 0, endStep: 200, ... }, { startStep: 200, endStep: 212, ... }]`.
   *
   *  `checkpointFroms` (GitHub issue #128, generalized past Recursive Backtracker) is this
   *  source's own intermediate snapshot cache, resolved once at generation time via
   *  `resolveDebugArenaMetadata` — opaque `Snapshot<unknown>[]` here since each source's adapter
   *  produces a structurally different result type (`ApplyResult`/`KruskalApplyResult`/
   *  `QcApplyResult`/etc); only the adapter that produced a given source's snapshots knows how to
   *  consume them (`selectDebugMazeView` always calls `adapterForKind(source.kind)`, so the cast
   *  back to that adapter's own `TResult` is sound at every real call site). Empty when the source
   *  is shorter than `CHECKPOINT_INTERVAL`. */
  sources: {
    scopeName: string;
    kind: EventedEventKind;
    nodeIndex: number;
    startStep: number;
    endStep: number;
    checkpointFroms: Snapshot<unknown>[];
  }[];
  nodes: NodeDto[];
  /** Nodes minted mid-run (preset split, pattern-mode split, QC/repair mint) — including ones
   *  later removed or replaced (`MutationCommand::RemoveNode`/`ReplacePointNodes`) — GitHub issue
   *  #271. Sourced from the WASM response's `debugAllNodes()`. Deliberately *not* a full union of
   *  every node that ever existed: the field's original base nodes are never removed, so they're
   *  always already present in `nodes` below — see `DebugGenerationState`'s doc comment.
   *  Consumers that need the true "every node that ever existed" union (`NodeId -> (x, y)` lookups
   *  in debug-tape narration, `buildNodeCoordIndex`) must concatenate this with `nodes` themselves.
   *  Separate from `nodes` (final survivors only, used for canvas rendering via
   *  `selectDebugMazeView`) — never used for rendering directly, since it can include nodes that
   *  don't exist at the current `debugStep`. */
  allNodes: NodeDto[];
  /** Total mutating-event count across every source in `tape` — a static property of the arena
   *  (computed once at generation time), not a per-step cache; lets the UI know the last valid
   *  `debugStep` without a bounded-scan trick on every render. */
  totalSteps: number;
  /** Every debug value (GitHub issue #131, e.g. `"recursion_stack"`) the instrumented algorithm
   *  declares, name plus rendering `kind` — sourced from the WASM response's static
   *  `debugValueNames` (`GenerateResult::debugValueNames()`/`debugValueKinds()`, mirroring the
   *  algorithm's own declaration in Rust), *not* derived from scanning this tape's actual emitted
   *  deltas — a trivial run that never triggers a delta would otherwise silently omit a name the
   *  algorithm still supports. The debug panel derives its per-value toggle list from this, per
   *  the issue's "declared, not hardcoded, on the web side" requirement. Empty for algorithms not
   *  instrumented for debug values yet. */
  debugValueNames: DebugValueDescriptor[];
}

/** A node/edge/cycle/region reference hovered in the debug event tree narration (GitHub issue
 *  #130) — mirrors the `Token` union built from `RecursiveBacktrackerEvent` payloads in
 *  `DebugEventTree.tsx`. `cycle`/`region` don't occur for Recursive Backtracker's own events but
 *  were modeled up front so QC/repair narration didn't need a shape change later. `issue` (GitHub
 *  issue #171) mirrors `Token`'s own `issue` variant one-to-one — its `target`, when non-null, is
 *  rendered exactly like a standalone `cycle`/`region` ref (see `DebugRefHighlightOverlay`);
 *  `reasons` (one already-resolved display string per contributing check) is only read by
 *  `DebugRefBubble`'s own click-to-modal handling, never by the hover-highlight overlay. */
export type HoveredDebugRef =
  | { kind: "node"; id: bigint }
  | { kind: "edge"; from: bigint; to: bigint; bidirectional: boolean }
  | { kind: "cycle"; edges: [bigint, bigint][] }
  | { kind: "region"; nodes: bigint[] }
  | {
      kind: "issue"; issueKind: string;
      target: { kind: "cycle"; edges: [bigint, bigint][] } | { kind: "region"; nodes: bigint[] } | null;
      reasons: string[];
    };

export interface GenerationState {
  nodes: NodeDto[];
  edges: EdgeDto[];
  start: number | null;
  finish: number | null;
  navNodes: NavNodeDto[];
  navEdges: NavEdgeDto[];
  graphAnalytics: GraphAnalyticsDto | null;
  splitAnalytics: SplitAnalyticsDto | null;
  showNodeIds: boolean;
  showCoords: boolean;
  showMaze: boolean;
  selectedNode: number | null;
  issues: IssueDto[];
  error: string | null;
  registryLoaded: boolean;
  availableChecks: CheckDescriptor[];
  availableStrategies: StrategyDescriptor[];
  /** Rule-level parameter catalog (e.g. `protect_route`) — see GitHub issue #253. Unlike
   * `availableChecks`/`availableStrategies`, not indexed by an owning check/strategy id: these
   * params live directly on `QcRuleState.params`, one value per rule. Each entry's `applies_to`
   * restricts which rules show it — see `RuleParamsSection`. */
  availableRuleParams: RuleParamDescriptor[];
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
  /** Stack of seeds used by past `generate()` calls, oldest first, capped at 20 (oldest dropped).
   *  Persisted in the project file. Navigation (`seedHistoryBack/Forward/Jump`) only updates
   *  `seed`, it never triggers generation. See `Specs/`-adjacent doc in `store.md`. */
  seedHistory: number[];
  /** Index into `seedHistory` of the seed currently shown in the seed field — meaningful only
   *  when `seedHistory.length > 0`; always `0 <= seedHistoryIndex <= seedHistory.length - 1` in
   *  that case. Undefined/unused while `seedHistory` is empty. */
  seedHistoryIndex: number;
  /** True right after seed-history navigation (Back/Forward/Jump); false after the seed field was
   *  edited by hand (`setSeed`). Distinguishes "repeat generate on the exact seed just navigated
   *  to" (history untouched) from "generate with a new/edited seed" (history truncated from
   *  `seedHistoryIndex` and the new seed appended) — see `generate()`. Does not affect where the
   *  truncation point is; that is always `seedHistoryIndex`. */
  seedAttachedToHistory: boolean;
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
  /** Names of debug values (GitHub issue #131, e.g. `"recursion_stack"`) currently toggled on in the
   *  debug panel — several may be on at once (a `Set`, not a single active value). Drives
   *  persistent canvas highlighting of each toggled set's node membership at the current
   *  `debugStep`, distinct from `hoveredDebugRef`'s hover-only highlighting (#130). Reset to
   *  empty whenever `debugArena` changes (a fresh run may not expose the same names) or
   *  `debugMode` turns off. Not persisted/serialized, same as `hoveredDebugRef`. */
  debugValueToggles: Set<string>;
  /** Whether Kruskal's union-find groups (GitHub issue #146's DSU-groups extension) are
   *  highlighted on canvas — a single on/off toggle, not a `debugValueToggles`-style named set:
   *  DSU groups are the algorithm's core state (not a named, user-selectable value like
   *  `"recursion_stack"`), so there's exactly one toggle rather than one per group. Only
   *  meaningful while `debugArena.algorithmKind === "kruskal"`; ignored otherwise. Reset to `false`
   *  whenever `debugArena` changes or `debugMode` turns off, mirroring `debugValueToggles`. Not
   *  persisted/serialized. */
  showKruskalDsuGroups: boolean;
  /** True after the maze has been generated since the last confirmTessellation. */
  mazeDirty: boolean;
  /** Caps on the QC repair fixpoint loop (see `Specs/repair.md`'s `RepairLimits`). Both are
   * optional and independent of each other — `null` disables that particular cap. If both are
   * `null`, the loop has no hard cap at all (only convergence/no-progress stop it), which the
   * Quality feature card surfaces as a warning. */
  repairMaxIterations: number | null;
  repairTimeBudgetSecs: number | null;
  /** CustomVertexBased-only automatic split-point assignment settings (GitHub issue #222).
   * `splitPatterns` is scoped to the currently active tessellation — reset (like other
   * tessellation-specific settings) whenever the tessellation changes. */
  splitPatternMode: boolean;
  splitMaxNodes: number;
  splitPatterns: SplitPattern[];
}

export interface GenerationActions {
  generate: () => void;
  /** Moves `seedHistoryIndex` one step back and copies that seed into `seed` — does not trigger
   *  generation. No-op at the start of history. Also turns `randomSeed` off (a navigated-to seed
   *  would otherwise be discarded by the next `generate()`). */
  seedHistoryBack: () => void;
  /** Same as `seedHistoryBack` but one step forward. No-op at the end of history. */
  seedHistoryForward: () => void;
  /** Jumps `seedHistoryIndex` directly to `index` and copies that seed into `seed` — does not
   *  trigger generation. No-op if `index` is out of range. Also turns `randomSeed` off, same as
   *  `seedHistoryBack`/`seedHistoryForward`. */
  seedHistoryJump: (index: number) => void;
  /** Sets the persistent QC Only mode toggle — see `GenerationState.qcExperiment`'s doc comment.
   * When on, `generate` skips the generation algorithm entirely and runs QC/repair
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
  /** Flips the check's `disabled` (see `CheckInstance`'s doc comment) — the check is excluded
   * entirely from generation while disabled, still counts toward single-instance-type gating. */
  toggleCheckDisabled: (ruleId: string, localId: number) => void;
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
  /** Swaps the entry at `path` with its immediate sibling in `direction` — siblings share
   * `path`'s last segment's `slotId`, addressed by list position (`index`), same addressing
   * `PathSegment` uses everywhere else. Only meaningful for a `Priority`-dispatch slot (order IS
   * the priority rank there), but not restricted to one — a no-op if there's no sibling in that
   * direction (already first/last). */
  moveNestedStrategy: (ruleId: string, path: PathSegment[], direction: "up" | "down") => void;
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
  /** Sets one rule-level parameter (e.g. `protect_route`) on `ruleId`'s own `params` — see
   * GitHub issue #253. Unlike `setStrategyParam`, scoped to a single rule, not shared globally
   * by strategy id. */
  setRuleParam: (ruleId: string, paramId: string, value: string) => void;
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
  /** Flips `name`'s membership in `debugValueToggles`. */
  toggleDebugValue: (name: string) => void;
  /** Flips `showKruskalDsuGroups`. */
  toggleKruskalDsuGroups: () => void;
  setError: (msg: string | null) => void;
  setRepairMaxIterations: (v: number | null) => void;
  setRepairTimeBudgetSecs: (v: number | null) => void;
  setSplitPatternMode: (v: boolean) => void;
  setSplitMaxNodes: (v: number) => void;
  setSplitPatterns: (patterns: SplitPattern[]) => void;
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
  /** Whether to show issue bubbles whose every flagged element is preset-locked (GitHub issue
   *  #245) — an issue that's technically correct but entirely unfixable by repair because every
   *  contributing edge is a user-placed preset connection. Default `true` (show) — nothing hides
   *  without an explicit toggle. A bubble with at least one non-locked element is unaffected by
   *  this flag regardless of its value (see `IssueBubble` in `IssuesBlock.tsx`). */
  showFullyPresetLockedIssues: boolean;
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
  setShowFullyPresetLockedIssues: (v: boolean) => void;
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
  /** slotIds of a split point's extra nodes (beyond the point's original node), keyed by "x,y".
   * Absent/empty for an unsplit point (GitHub issue #221). Each slotId is unique only within its
   * own point (not globally — `PostEditEndpoint`'s `split` variant already addresses point+slotId
   * together, so per-point uniqueness is enough, see `addSplitNode` in postEditSlice.ts, which
   * mints the next slotId as the max of the point's existing slotIds + 1 rather than keeping a
   * separate counter) and is never reused while it still exists — same stable-identity principle
   * already used for `PostEditTeleportEntry.id`, just with its own per-point counter instead of a
   * global one. Re-applied via `Maze::add_node_at` (one call per slotId, in a deterministic order)
   * on every confirmPostEdit. */
  postEditDraftSplitPoints: Record<string, number[]>;
  /** Which of a point's nodes is currently "active" for edge-tool clicks on its faces, keyed by
   * "x,y". No entry means the point's original node. */
  postEditActiveSplitNode: Record<string, PostEditEndpoint>;
  /** The point currently selected for the "Manage split nodes" dialog — the single source of
   * truth for which point is being managed. Set by a right-click on any cell while an edge tool is
   * active, cleared by an ordinary click elsewhere, closing the dialog, or leaving the post-edit
   * card. Not hover — doesn't change on mere cursor movement. */
  postEditFocusedPoint: [number, number] | null;
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
  /** The link (edge/teleport) currently hovered in the "Manage split nodes" panel's link bubbles
   *  (GitHub issue #237) — `null` when nothing is hovered. Drives a canvas highlight the same way
   *  `EdgeHighlightRenderer`'s pointermove-driven hover does, but sourced from the panel instead of
   *  the cursor. */
  postEditHoveredLink: { from: PostEditEndpoint; to: PostEditEndpoint } | null;
}

export interface PostEditActions {
  setPostEditAutoConfirm: (v: boolean) => void;
  setPostEditTool: (tool: PostEditTool) => void;
  applyPostEditTool: (edgeKey: string, from: PostEditEndpoint, to: PostEditEndpoint) => void;
  /** Same as `applyPostEditTool`, but takes `tool` explicitly instead of reading
   * `state.postEditTool` — used by the "Manage split nodes" dialog's own kind switcher (GitHub
   * issue #234), which must not disturb the canvas's globally active edge tool. */
  applyPostEditToolAt: (tool: PostEditTool, edgeKey: string, from: PostEditEndpoint, to: PostEditEndpoint) => void;
  setPostEditEndpoint: (kind: "start" | "finish", endpoint: PostEditEndpoint) => void;
  clearPostEditEndpoint: (kind: "start" | "finish") => void;
  setPostEditTeleportPendingFrom: (nodeId: number | null) => void;
  addPostEditTeleport: (from: PostEditEndpoint, to: PostEditEndpoint, direction: PostEditTeleportDirection) => void;
  cyclePostEditTeleportDirection: (id: number) => void;
  removePostEditTeleport: (id: number) => void;
  movePostEditTeleportEndpoint: (id: number, end: "from" | "to", endpoint: PostEditEndpoint) => void;
  confirmPostEdit: () => Promise<void>;
  resetPostEdit: () => void;
  addSplitNode: (point: [number, number]) => void;
  removeSplitNode: (point: [number, number], slotId: number) => void;
  cycleActiveSplitNode: (point: [number, number]) => void;
  setActiveSplitNode: (point: [number, number], endpoint: PostEditEndpoint) => void;
  setPostEditFocusedPoint: (point: [number, number] | null) => void;
  setPostEditHoveredLink: (link: { from: PostEditEndpoint; to: PostEditEndpoint } | null) => void;
  /** Rotates every geometric-face connection of `point`'s nodes (original + every declared slot)
   * by one offset index — see `rotatePostEditSplitPoint` (postEditUtils.ts). No-op if it would
   * push any connection outside the field. */
  rotateSplitPoint: (point: [number, number], direction: 1 | -1) => void;
  /** Applies a built-in split-node blueprint (GitHub issue #235) to `point` — a full replace:
   * every existing slot at the point (and every edge/teleport/start/finish reference to it) is
   * dropped first, then one fresh slot per blueprint node is minted and its required faces get a
   * `passage`. See `splitBlueprints.ts`. */
  applySplitBlueprint: (point: [number, number], blueprint: SplitNodeBlueprint) => void;
}

/** One start/finish marker's appearance (GitHub issue #296) — `borderWidth: 0` (the default) draws
 *  no border, so there is no separate show-border toggle. */
export interface MarkerSettings {
  shape: MarkerShape;
  /** Sharp vs. round corners (GitHub issue #302 follow-up) — only affects the four
   *  regular-polygon `MarkerShape`s, same convention as `teleportLineCornerStyle`. */
  cornerStyle: TeleportCornerStyle;
  fillColor: number;
  borderColor: number;
  borderWidth: number;
  /** Floor-colored gap drawn around the border (GitHub issue #302 follow-up) — `0` (the default)
   *  draws no gap, same convention as `teleportConnectorGapWidth`. Color always mirrors
   *  `VectorByWallsSettings.floorColor`, not independently settable. */
  gapWidth: number;
  /** Marker radius, as a fraction of the tile size (0-1) — same convention as
   *  `VectorByWallsSettings.teleportLineSize`. */
  size: number;
}

/** "Vector by walls" mode's own settings (GitHub issue #289, floor color added in #290) —
 * background appearance and floor appearance ("general settings" and "floor" sections of #288's
 * panel). Defaults match the editor's normal grid/floor appearance (`canvas.stage.background`,
 * `canvas.grid.line`, `canvas.floor.default`) so the exported image looks identical to the editor
 * view until the user changes something. Kept as its own type (not folded into a shared per-mode
 * settings shape) since each render mode's settings are expected to differ entirely — a future
 * mode adds its own sibling `xxxSettings` field, not a new case of this type. */
export interface VectorByWallsSettings {
  background: number;
  showGrid: boolean;
  gridColor: number;
  floorColor: number;
  /** Applied to every "wall"-colored stroke (solid walls, split-junction wall faces, closed-cells
   *  fill) via `WallStyleOverride` — never the `faint`/`background` `WallStyle` variants or a split
   *  passage's own node-identity color. See GitHub issue #291. */
  wallColor: number;
  /** Drives both the pixi stroke `join` and the derived `cap` together (`round`->`round` cap,
   *  `miter`->`square` cap) when built into a `WallStyleOverride` in `VectorByWallsRenderer`. */
  wallJoin: "round" | "miter";
  wallThickness: number;
  /** One-way indicator drawn on a directed passage's wall segment — shape/color/gap/size/
   *  join/cap, applied via `OneWayStyleOverride` (`pixi/renderers/types.ts`) to `WallRenderer`'s
   *  plain wall one-ways only, never a split passage's connector arrow. Always has its own color
   *  (no fallback to `wallColor` — GitHub issue #292). */
  oneWayPattern: OneWayPattern;
  oneWayColor: number;
  /** Floor-colored gap around the indicator (GitHub issue #302 follow-up renamed from
   *  `oneWayBorderWidth` — not a real border, same convention as the marker/connector gap) —
   *  color always mirrors `floorColor`, not independently settable. */
  oneWayGapWidth: number;
  oneWaySize: number;
  /** Chevron/arrow's own line thickness — independent of `oneWaySize` (geometric scale). No
   *  effect on the `triangle` pattern. */
  oneWayThickness: number;
  /** Drives both the pixi stroke `join` and the derived `cap` together, same convention as
   *  `wallJoin`/`wallCap` — applied to the indicator's own strokes (chevron/arrow lines, or a
   *  filled triangle's border stroke), independent of the Tiles section's wall join/cap. */
  oneWayJoin: "round" | "miter";
  startMarker: MarkerSettings;
  finishMarker: MarkerSettings;
  /** Teleports section (GitHub issue #293, restructured in a follow-up that removed the standalone
   *  `"line"`/`"grouped"` pattern switch) — `teleportLine*`/`teleportConnector*`/`teleportEdge*`
   *  ("Edges"/"Connector" subsections) are always the base look; `teleportConnectorStyle: "none"`
   *  draws no connector line at all. `teleportGroupCustomization` (its own subsection, off by
   *  default) layers a per-group shape/fill-color/border-color override on top wherever an endpoint
   *  coordinate coincides (see `buildTeleportGroups`) — combined with `connectorStyle: "none"` this
   *  reproduces the old standalone `"grouped"` pattern's look. `teleportGroupOverrides` holds those
   *  overrides, keyed by `TeleportGroup.key` (stable across renders, not across a maze
   *  regenerate/reload — entries for groups no longer present are simply never looked up again, not
   *  pruned). */
  teleportLineCornerStyle: TeleportCornerStyle;
  teleportLineShape: MarkerShape;
  /** Marker radius, as a fraction of the tile size (0-1, GitHub issue #293 follow-up — matches
   *  `OneWayStyleOverride.size`'s convention, not a fixed pixel radius). */
  teleportLineSize: number;
  teleportEdgeColor: number;
  teleportEdgeBorderColor: number;
  teleportEdgeBorderWidth: number;
  /** Floor-colored gap ring drawn around the edge marker's border (GitHub issue #302), same
   *  convention as the waypoint marker's own `MarkerSettings.gapWidth` — `0` (the default) draws no
   *  gap. Color always mirrors `floorColor`, not independently settable. See
   *  `TeleportLineStyle.edgeGapWidth`'s own doc comment (`pixi/renderers/types.ts`) for the per-group
   *  draw-order rule this relies on. */
  teleportEdgeGapWidth: number;
  /** The connector line's own color/width — GitHub issue #293 follow-up renamed from
   *  `teleportConnection*` ("connector" is the settings panel's own term for it). */
  teleportConnectorColor: number;
  teleportConnectorWidth: number;
  /** `"none"` (no connector), `"straight"` (direct center-to-center) or `"orthogonal"`
   *  (single-bend, axis-aligned, with a local collision offset — see `teleportConnectorRouting.ts`). */
  teleportConnectorStyle: TeleportConnectorStyle;
  /** "Avoid field exit" toggle (GitHub issue #300, `"orthogonal"` connectors only) — off by default.
   *  When on, a candidate leaving the maze field's own cell footprint gets a top-priority penalty
   *  outranking every other routing weight (see `FIELD_EXIT_WEIGHT` in `teleportConnectorRouter.ts`),
   *  so a connector prefers any in-field detour over stepping outside the field. */
  teleportAvoidFieldExit: boolean;
  /** How a one-way connector draws its direction arrow(s) — see `TeleportArrowMode`. */
  teleportArrowMode: TeleportArrowMode;
  /** Tile-width period between arrows in `"periodic"` mode — unused (and hidden in the settings
   *  panel) otherwise. */
  teleportArrowPeriod: number;
  teleportArrowSize: number;
  /** Floor-colored gap drawn around the whole connector line (GitHub issue #302 follow-up rename
   *  from `teleportConnectorBorderWidth` — not a border around the connector's own fill, it's a
   *  visual separation gap from anything the connector crosses). `0` (the default) draws no gap,
   *  replacing a separate on/off toggle (GitHub issue #293 follow-up: "if it's not needed, just set
   *  it to zero"). */
  teleportConnectorGapWidth: number;
  /** Off by default — see this interface's own Teleports-section doc comment above. */
  teleportGroupCustomization: boolean;
  teleportGroupOverrides: Record<string, TeleportGroupOverride>;
  /** Splits section (GitHub issue #294) — per-split-node-slot identity colors, indexed by slot
   *  (0 = original node, 1 = first extra node, ...), overriding `splitSlotColor`'s default palette
   *  one-to-one; a point with more nodes than this array's length falls back to the default
   *  palette for the overflow slots. The settings panel sizes this array to the maximum split-node
   *  count actually present in the current maze (0 nodes when there's no maze/no split points),
   *  defaulting each slot's initial value to `splitSlotColor`'s own default so the exported image
   *  matches the editor's look until changed. */
  splitNodeColors: number[];
  /** On by default (mirrors `SplitJunctionRenderer.render`'s own default for every other
   *  split-drawing feature). When on, recognized degree-4 split topologies ("bridge": two nodes
   *  each a straight-through opposite-face pair; "diagonal divider": two nodes each an
   *  adjacent-face pair) draw as a dedicated shape (see `SplitSpecialShapeKind`) instead of the
   *  generic per-node segment/connector reading. */
  splitSpecialShapes: boolean;
}

/** "Vector by corridors" mode's own settings (GitHub issue #310) — the corridor stroke's color,
 * width and corner/end style. Kept as its own type (not folded into `VectorByWallsSettings`), same
 * per-mode-settings convention as every other `RenderModeId`. Every basic passage (both
 * bidirectional and one-way alike — direction isn't distinguished yet, a follow-up sub-issue's
 * concern) draws as a stroked line between the two cells' centers; split points and teleport edges
 * are skipped entirely for now (their own follow-up sub-issues), same "empty until its own
 * sub-issue" convention `splitSpecialShapes` etc. followed in `VectorByWallsSettings`. */
export interface VectorByCorridorsSettings {
  color: number;
  thickness: number;
  /** Drives both the pixi stroke `join` and the derived `cap` together, same convention as
   *  `VectorByWallsSettings.wallJoin`/`wallCap`. */
  join: "round" | "miter";
  /** Start/finish marker appearance (GitHub issue #311) — same `MarkerSettings` shape and
   *  "Waypoints" section convention `VectorByWallsSettings` uses, reusing its settings-panel
   *  sub-component rather than duplicating it. */
  startMarker: MarkerSettings;
  finishMarker: MarkerSettings;
  /** Extra radius (px, world-space) added on top of a marker's own visible footprint when widening
   *  the corridor stroke under it (GitHub issue #311's `drawMarkerWidenPatches`) — without this, a
   *  marker with no border/gap has a widen patch exactly the same radius as its own fill, so the
   *  marker completely covers the patch and no widened corridor is visible around it. `0` draws no
   *  extra padding (patch radius = footprint exactly, marker still fully covers it). */
  markerWidenPadding: number;
}

export interface ImageExportState {
  /** Currently active rendering mode in the Image Export feature card's switcher, or `null` if
   * the user hasn't picked one yet — a radio group with no default selection, not independent
   * toggles. */
  activeRenderMode: RenderModeId | null;
  /** Which mode's settings panel is open as a `SidePanel` beside the canvas, or `null` if none —
   * set by clicking the active switcher item (clicking an inactive item switches the active mode
   * instead, per the issue's interaction spec). Independent of `openCard`: closing the Image
   * Export card does not by itself clear this, but the panel only renders while the card is open
   * (see `ImageExportFeature.tsx`). */
  openRenderModeSettings: RenderModeId | null;
  /** Expanded/collapsed state per "Vector by walls" settings section, keyed by section id —
   * mirrors `AnalyticsOverlayState.analyticsSectionsExpanded`. */
  vectorByWallsSectionsExpanded: Record<string, boolean>;
  vectorByWallsSettings: VectorByWallsSettings;
  /** Expanded/collapsed state per "Vector by corridors" settings section, keyed by section id —
   * mirrors `vectorByWallsSectionsExpanded`. */
  vectorByCorridorsSectionsExpanded: Record<string, boolean>;
  vectorByCorridorsSettings: VectorByCorridorsSettings;
  /** Currently *selected* (clicked, not hovered — GitHub issue #293 follow-up) teleport connection
   *  group, by `TeleportGroup.key` — set either by clicking a row in the Teleports section's group
   *  list or by clicking that group's own marker(s) on the canvas (two-way selection sync). `Escape`
   *  or clicking empty canvas clears it. `null` when nothing is selected, meaning every group draws
   *  normally. */
  selectedTeleportGroupKey: string | null;
  /** Currently hovered export-warning list entry, by `ExportWarning.key` (GitHub issue #298) — set
   *  by hovering a warning row in the settings panel, drives `VectorByWallsRenderer`'s own warning
   *  highlight overlay. `null` when nothing is hovered. Mirrors `hoveredIssueLoopEdges`'s role for
   *  the Analytics feature's issue list, but keyed by warning identity rather than carrying raw
   *  edges/nodes directly, since the highlighted geometry is recomputed from
   *  `computeVectorByWallsWarnings`'s own result rather than duplicated into the store. */
  hoveredExportWarningKey: string | null;
  /** Which export format's settings panel is open as a `SidePanel`, or `null` if none — mirrors
   * `openRenderModeSettings`'s role for the render-mode switcher, but for the format list below
   * it. Independent state: opening one closes the other, since both share the same `SidePanel`
   * portal slot (`ImageExportFeature.tsx`). */
  openExportFormatSettings: ExportFormatId | null;
  pngExportSettings: PngExportSettings;
}

export interface ImageExportActions {
  setActiveRenderMode: (mode: RenderModeId) => void;
  setOpenRenderModeSettings: (mode: RenderModeId | null) => void;
  setOpenExportFormatSettings: (format: ExportFormatId | null) => void;
  setPngOutputMode: (mode: PngExportOutputMode) => void;
  setDigitalScale: (scale: number) => void;
  setDigitalCanvasMode: (mode: PngCanvasMode) => void;
  setDigitalMarginValue: (v: number) => void;
  setDigitalFixedSize: (width: number, height: number) => void;
  setPrintDensity: (density: PrintDensity) => void;
  setPrintPaperSize: (size: PaperSize) => void;
  setPrintCustomSize: (widthMm: number, heightMm: number) => void;
  setPrintOrientation: (orientation: PaperOrientation) => void;
  setPrintMargins: (marginHMm: number, marginVMm: number) => void;
  setPrintScale: (scale: number) => void;
  setPrintScaleAutoFit: (autoFit: boolean) => void;
  setPrintAnchor: (anchor: PrintAnchor) => void;
  /** Sets scale + offset together and switches `anchor` to `"custom"` in one update — used when
   * the user pans/zooms the maze under the on-canvas print frame (`ExportFrameOverlay`), where all
   * three values change together on every viewport move and must land in a single render, not
   * three separate ones. */
  setPrintCustomPlacement: (scale: number, offsetXMm: number, offsetYMm: number) => void;
  setVectorByWallsSectionExpanded: (id: string, expanded: boolean) => void;
  setVectorByCorridorsSectionExpanded: (id: string, expanded: boolean) => void;
  setVectorByCorridorsColor: (color: number) => void;
  setVectorByCorridorsThickness: (v: number) => void;
  setVectorByCorridorsJoin: (join: "round" | "miter") => void;
  setVectorByCorridorsStartMarkerShape: (shape: MarkerShape) => void;
  setVectorByCorridorsStartMarkerCornerStyle: (style: TeleportCornerStyle) => void;
  setVectorByCorridorsStartMarkerFillColor: (color: number) => void;
  setVectorByCorridorsStartMarkerBorderColor: (color: number) => void;
  setVectorByCorridorsStartMarkerBorderWidth: (v: number) => void;
  setVectorByCorridorsStartMarkerGapWidth: (v: number) => void;
  setVectorByCorridorsStartMarkerSize: (v: number) => void;
  setVectorByCorridorsFinishMarkerShape: (shape: MarkerShape) => void;
  setVectorByCorridorsFinishMarkerCornerStyle: (style: TeleportCornerStyle) => void;
  setVectorByCorridorsFinishMarkerFillColor: (color: number) => void;
  setVectorByCorridorsFinishMarkerBorderColor: (color: number) => void;
  setVectorByCorridorsFinishMarkerBorderWidth: (v: number) => void;
  setVectorByCorridorsFinishMarkerGapWidth: (v: number) => void;
  setVectorByCorridorsFinishMarkerSize: (v: number) => void;
  setVectorByCorridorsMarkerWidenPadding: (v: number) => void;
  setVectorByWallsBackground: (color: number) => void;
  setVectorByWallsShowGrid: (v: boolean) => void;
  setVectorByWallsGridColor: (color: number) => void;
  setVectorByWallsFloorColor: (color: number) => void;
  setVectorByWallsWallColor: (color: number) => void;
  setVectorByWallsWallJoin: (join: "round" | "miter") => void;
  setVectorByWallsWallThickness: (v: number) => void;
  setVectorByWallsOneWayPattern: (pattern: OneWayPattern) => void;
  setVectorByWallsOneWayColor: (color: number) => void;
  setVectorByWallsOneWayGapWidth: (v: number) => void;
  setVectorByWallsOneWaySize: (v: number) => void;
  setVectorByWallsOneWayThickness: (v: number) => void;
  setVectorByWallsOneWayJoin: (join: "round" | "miter") => void;
  setVectorByWallsStartMarkerShape: (shape: MarkerShape) => void;
  setVectorByWallsStartMarkerCornerStyle: (style: TeleportCornerStyle) => void;
  setVectorByWallsStartMarkerFillColor: (color: number) => void;
  setVectorByWallsStartMarkerBorderColor: (color: number) => void;
  setVectorByWallsStartMarkerBorderWidth: (v: number) => void;
  setVectorByWallsStartMarkerGapWidth: (v: number) => void;
  setVectorByWallsStartMarkerSize: (v: number) => void;
  setVectorByWallsFinishMarkerShape: (shape: MarkerShape) => void;
  setVectorByWallsFinishMarkerCornerStyle: (style: TeleportCornerStyle) => void;
  setVectorByWallsFinishMarkerFillColor: (color: number) => void;
  setVectorByWallsFinishMarkerBorderColor: (color: number) => void;
  setVectorByWallsFinishMarkerBorderWidth: (v: number) => void;
  setVectorByWallsFinishMarkerGapWidth: (v: number) => void;
  setVectorByWallsFinishMarkerSize: (v: number) => void;
  setVectorByWallsTeleportLineCornerStyle: (style: TeleportCornerStyle) => void;
  setVectorByWallsTeleportLineShape: (shape: MarkerShape) => void;
  setVectorByWallsTeleportLineSize: (v: number) => void;
  setVectorByWallsTeleportEdgeColor: (color: number) => void;
  setVectorByWallsTeleportEdgeBorderColor: (color: number) => void;
  setVectorByWallsTeleportEdgeBorderWidth: (v: number) => void;
  setVectorByWallsTeleportEdgeGapWidth: (v: number) => void;
  setVectorByWallsTeleportConnectorColor: (color: number) => void;
  setVectorByWallsTeleportConnectorWidth: (v: number) => void;
  setVectorByWallsTeleportConnectorStyle: (style: TeleportConnectorStyle) => void;
  setVectorByWallsTeleportAvoidFieldExit: (v: boolean) => void;
  setVectorByWallsTeleportArrowMode: (mode: TeleportArrowMode) => void;
  setVectorByWallsTeleportArrowPeriod: (v: number) => void;
  setVectorByWallsTeleportArrowSize: (v: number) => void;
  setVectorByWallsTeleportConnectorGapWidth: (v: number) => void;
  setVectorByWallsTeleportGroupCustomization: (v: boolean) => void;
  setVectorByWallsTeleportGroupOverride: (groupKey: string, patch: TeleportGroupOverride | null) => void;
  setSelectedTeleportGroupKey: (key: string | null) => void;
  /** Sets slot `index`'s color, growing `splitNodeColors` (filling any new intermediate slots with
   *  `splitSlotColor`'s own default) if `index` is past the array's current end — see GitHub issue
   *  #294. */
  setVectorByWallsSplitNodeColor: (index: number, color: number) => void;
  setVectorByWallsSplitSpecialShapes: (v: boolean) => void;
  setHoveredExportWarningKey: (key: string | null) => void;
}

export interface RootActions {
  loadProject: (file: import("./projectExport").ProjectFile) => void;
}

export type MazeState = TessellationState & PresetConnectionsState & GenerationState & AnalyticsOverlayState & PostEditState & ImageExportState;
export type MazeActions = RootActions & TessellationActions & PresetConnectionsActions & GenerationActions & AnalyticsOverlayActions & PostEditActions & ImageExportActions;
export type MazeStore = MazeState & MazeActions;
