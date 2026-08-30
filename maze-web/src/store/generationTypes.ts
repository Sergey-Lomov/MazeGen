import type { NodeDto, EdgeDto, NavNodeDto, NavEdgeDto, CheckDescriptor, StrategyDescriptor, RuleParamDescriptor, GenerationParams, ElementsConfig, InitialGenerationConfig, RouteInfoDto, MazeStatisticsDto, IssueDto, GenerationTimingDto, SplitPattern } from "../wasm/types";
import type { FeatureId } from "./tessellationTypes";
import type { QcRuleState, RepairStageState, PathSegment } from "./qcRuleTypes";
import type { DebugArenaHandle, HoveredDebugRef } from "./debugArenaTypes";

export interface GenerationState {
  nodes: NodeDto[];
  edges: EdgeDto[];
  start: number | null;
  finish: number | null;
  navNodes: NavNodeDto[];
  navEdges: NavEdgeDto[];
  statistics: MazeStatisticsDto | null;
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
  /** Whether the CustomVertexBased settings side panel (`VertexBasedSettingsPanel`, GitHub issue
   *  #351) is open — part of the serialized project file (`generation.vertexSettingsPanelOpen` in
   *  `ProjectFile`) so loading a project restores the panel to the state it was saved in. */
  vertexSettingsPanelOpen: boolean;
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
  /** Bumped every time a focus request is issued for the debug event tree — a step-label click
   *  (`focusDebugStep`, `debugFocusNodeIndex === null` = focus the current `debugStep`'s row) or
   *  a search-match jump (`focusDebugNode`, `debugFocusNodeIndex` set to a specific arena node).
   *  Lets `DebugEventTree` expand collapsed ancestors and re-scroll even when `debugStep` itself
   *  hasn't changed (a scope/trace match has no step of its own; the user may also have scrolled
   *  the tree away manually). A plain counter rather than a boolean so two requests in a row still
   *  produce distinct values the tree's effect can react to. */
  debugFocusToken: number;
  /** Target arena node index for the pending `debugFocusToken` focus request, or `null` to mean
   *  "focus the current `debugStep`'s row". Set by `focusDebugNode` (search-match jump), cleared
   *  to `null` by `focusDebugStep` and on debug-tape lifecycle resets. */
  debugFocusNodeIndex: number | null;
  /** Whether stepping through the debug tape (autoplay, next/prev, scrubber settle, tree row
   *  click) auto-switches the active floor to match the step being shown (GitHub issue #350's
   *  follow-up) — on by default, matching the feature's original always-on behavior; the toggle
   *  lets a user opt out when they want to keep manually driving the active floor while stepping.
   *  Independent of a debug-tree bubble's own click-to-switch (`onClickFloor` in
   *  `DebugEventTree.tsx`), which always switches regardless of this toggle — a bubble click is an
   *  explicit "go to this floor" action, not an auto-switch. Never gates a scrubber drag's own
   *  in-flight ticks either way — those already skip the switch unconditionally (`switchFloor:
   *  false`) to avoid flicker; this toggle only affects the settle call and every other trigger.
   *  Not reset by `setDebugMode`/a fresh `generate()` — a user's preference here should persist
   *  across debug sessions within the same app session. */
  debugAutoSwitchFloor: boolean;
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
  /** Substring the user typed into the debug event tree's search field (GitHub issue #482) — raw
   *  (not trimmed/lowercased; that normalization happens at the point of use). Drives per-row
   *  match dots + the match counter + prev/next navigation in `DebugEventTree`. Reset to `""`
   *  whenever `debugArena` changes or `debugMode` turns off. Not persisted/serialized. */
  debugSearchQuery: string;
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
  /** Sets whether the CustomVertexBased settings side panel is open — see
   * `GenerationState.vertexSettingsPanelOpen`'s doc comment. */
  setVertexSettingsPanelOpen: (v: boolean) => void;
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
  /** Flips the rule card's `collapsed` — UI-only, does not mark the config stale. */
  toggleRuleCollapsed: (ruleId: string) => void;
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
  /** Flips the stage section's `collapsed` — UI-only, does not mark the config stale. */
  toggleStageCollapsed: (stageId: string) => void;
  setStrategyParam: (strategyId: string, paramId: string, value: string) => void;
  /** Sets one rule-level parameter (e.g. `protect_route`) on `ruleId`'s own `params` — see
   * GitHub issue #253. Unlike `setStrategyParam`, scoped to a single rule, not shared globally
   * by strategy id. */
  setRuleParam: (ruleId: string, paramId: string, value: string) => void;
  setGenerationParam: (key: keyof GenerationParams, value: number) => void;
  setGenerationMethod: (method: string) => void;
  setElementsParam: (key: keyof ElementsConfig, value: number) => void;
  /** Boolean-valued `ElementsConfig` fields (currently only `allow_non_consecutive_elevator_floors`,
   * GitHub issue #337) — kept separate from `setElementsParam` since that one is typed to `number`. */
  setElementsBoolParam: (key: "allow_non_consecutive_elevator_floors", value: boolean) => void;
  setRandomSeed: (v: boolean) => void;
  setOpenCard: (card: FeatureId) => void;
  setDebugMode: (v: boolean) => void;
  /** `switchFloor` (default `true`, GitHub issue #350) gates the auto floor-switch — pass `false`
   *  while a scrubber drag is still in flight (`StepSlider`'s intermediate ticks) so the active
   *  floor doesn't flicker across every floor the drag passes over; the final settle call (drag
   *  release) passes `true`/omits it to apply the real switch once. */
  setDebugStep: (step: number, switchFloor?: boolean) => void;
  /** Flips `debugAutoSwitchFloor`. */
  toggleDebugAutoSwitchFloor: () => void;
  /** Requests a focus-scroll to the current `debugStep`'s row (bumps `debugFocusToken`, clears
   *  `debugFocusNodeIndex` to `null`) — see `debugFocusToken`'s doc comment. */
  focusDebugStep: () => void;
  /** Requests a focus-scroll to a specific arena node's row (bumps `debugFocusToken`, sets
   *  `debugFocusNodeIndex`) — used by the debug event tree's search-match navigation to jump to a
   *  matched row, including a scope/trace row that has no `debugStep` of its own. */
  focusDebugNode: (nodeIndex: number) => void;
  setDebugAutoPlayDelay: (ms: number) => void;
  setHoveredDebugRef: (ref: HoveredDebugRef | null) => void;
  /** Flips `name`'s membership in `debugValueToggles`. */
  toggleDebugValue: (name: string) => void;
  /** Flips `showKruskalDsuGroups`. */
  toggleKruskalDsuGroups: () => void;
  /** Sets `debugSearchQuery` (raw substring typed into the debug event tree's search field). */
  setDebugSearchQuery: (query: string) => void;
  setError: (msg: string | null) => void;
  setRepairMaxIterations: (v: number | null) => void;
  setRepairTimeBudgetSecs: (v: number | null) => void;
  setSplitPatternMode: (v: boolean) => void;
  setSplitMaxNodes: (v: number) => void;
  setSplitPatterns: (patterns: SplitPattern[]) => void;
}
