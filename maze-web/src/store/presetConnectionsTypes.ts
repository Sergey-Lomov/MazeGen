import type { NodeLockKind } from "../wasm/types";
import type { PresetConnectionEntry, PresetConnectionTool, PresetTeleportEntry, PresetVerticalPassageEntry, PresetElevatorEntry } from "../pixi/fieldEditUtils";
import type { PresetEndpoint } from "../pixi/presetEndpoint";
import type { SplitNodeBlueprint } from "../pixi/splitBlueprints";
import type { PresetPointEntityDescriptor, PresetPointEntityScope } from "../pixi/pointEntities";

export function isPresetLockTool(tool: PresetConnectionTool): boolean {
  return tool === "lock_in" || tool === "lock_out" || tool === "full_lock";
}

export type PresetEntityHighlightMode = "inset" | "outset";

export interface PresetHoveredLink {
  from: PresetEndpoint;
  to: PresetEndpoint;
  highlightStyle?: "line" | "one_way" | "boundary";
}

export interface PresetConnectionsState {
  /** Every preset connection across every floor, in one flat map (GitHub issue #340) — an entry's
   * floor lives in its own `from.level`/`to.level` (`PresetEndpoint.level`, undefined = floor 0),
   * not in which bucket it's stored under. `presetEdgeKey` folds `level` into the key alongside
   * point/slot, so entries on different floors never collide. Flat (not per-floor buckets) so a
   * future cross-floor edge (vertical passage/elevator) has one natural home instead of an
   * ownership question about whose bucket it lives in. */
  presetConnections: Map<string, PresetConnectionEntry>;
  presetConnectionsTool: PresetConnectionTool;
  defaultEdgeState: "undefined" | "wall" | "passage";
  presetStart: PresetEndpoint | null;
  presetFinish: PresetEndpoint | null;
  presetGenSource: PresetEndpoint | null;
  /** Geometric fallback mode for the generation start point when `presetGenSource` is unset
   * (GitHub issue #640) — persisted per project. `"default"` is the long-standing centroid-nearest
   * behavior; `"random"` seeds from a uniformly random field point, deterministic per generation
   * seed. Has no effect once `presetGenSource` is set — the pin always wins regardless of mode. */
  generationSourceMode: "default" | "random";
  highlightInvalidPresets: boolean;
  highlightIsolatedNodes: boolean;
  /** Whether the "N split node(s) unused" warning bubble is currently hovered (GitHub issue #420) —
   *  mirrors `highlightIsolatedNodes` above, driving the same kind of canvas highlight for orphan
   *  split nodes instead. */
  highlightOrphanSplitNodes: boolean;
  showPresetOrigin: boolean;
  /** Whether preset lock/blocker markers are rendered on the canvas. */
  showPresetLocks: boolean;
  /** Temporarily remembers the lock visibility setting while a lock tool forces it on. */
  showPresetLocksBeforeLockTool: boolean | null;
  /** Locked nodes: key = "x,y[:level]", value = lock kind */
  lockedNodes: Map<string, NodeLockKind>;
  autoLock: boolean;
  /** Auto-locked nodes (fully-defined cells): key = "x,y[:level]". Always lock_both. */
  autoLockedNodes: Set<string>;
  /** True after any preset connection change since the last confirmTessellation. */
  presetsDirty: boolean;
  /** Every preset teleport across every floor, flat (GitHub issue #340) — same rationale as
   * `presetConnections` above; a teleport's `from`/`to` can already carry independent `level`s. */
  presetTeleports: PresetTeleportEntry[];
  /** First-click endpoint of an in-progress teleport placement (teleport_one_way/teleport_two_way
   * tools) — carries its own `level` (GitHub issue #340's cross-floor teleport support), so a
   * placement started on one floor and completed after switching to another produces a genuine
   * cross-floor teleport instead of both ends silently collapsing onto whichever floor happens to
   * be active when the second click lands. */
  presetTeleportPendingFrom: PresetEndpoint | null;
  _nextPresetTeleportId: number;
  /** Every preset `VerticalPassage` across every floor, flat (GitHub issue #357) — same rationale
   * as `presetTeleports`; a passage's `from`/`to` live on adjacent floors by construction. */
  presetVerticalPassages: PresetVerticalPassageEntry[];
  /** In-progress vertical-passage placement (GitHub issue #357 follow-up: single-click placement) —
   * the click's own endpoint plus which of the two directions ("up"/"down", relative to the
   * clicked floor) are actually available (a floor with no neighbor above/below only has one). When
   * exactly one direction is available, the entry is created immediately and this is never set; when
   * both are available, this stays set until `choosePresetVerticalPassageDirection` (driven by
   * `PresetVerticalDirectionDialog`) or `cancelPresetVerticalPassagePlacement` resolves it. `null`
   * when no placement is pending. */
  presetVerticalPassagePending: { origin: PresetEndpoint; tool: "vertical_passage_one_way" | "vertical_passage_two_way"; availableDirections: ("up" | "down")[] } | null;
  _nextPresetVerticalPassageId: number;
  /** Every preset `Elevator` across every floor, flat (GitHub issue #357). */
  presetElevators: PresetElevatorEntry[];
  /** In-progress elevator placement: the first click's endpoint plus which floors (by 0-based
   * index) have been picked so far in the floor-picker dialog, always including the active floor
   * (the first click's own floor) which can't be unchecked. `null` when no elevator placement is
   * pending. */
  /** `editingId` (GitHub issue #341 follow-up) is set when this pending placement was opened by
   * clicking an *existing* elevator marker — `floors` seeds from that entry's own current floors
   * (not just the origin's) so the dialog reflects real state, and `confirmPresetElevatorPlacement`
   * updates that entry in place instead of pushing a new one. `undefined` for a placement started
   * on an empty point (ordinary create flow). */
  presetElevatorPending: { origin: PresetEndpoint; floors: Set<number>; editingId?: number } | null;
  _nextPresetElevatorId: number;
  /** slotIds of each split point's extra nodes declared on the preset stage, keyed by "x,y[:level]"
   * (GitHub issue #231) — mirrors post-edit's `postEditDraftSplitPoints`. */
  presetSplitPoints: Record<string, number[]>;
  /** Stable post-edit-style ids for whole split tiles (`s1`, `s2`, ...). */
  presetSplitPointIds: Record<string, string>;
  _nextPresetSplitPointId: number;
  /** Creation order of user-authored preset entities, stored by list cell key. */
  presetEntityOrder: string[];
  /** Which of a split point's nodes preset edge-tool clicks currently target, keyed by
   * "x,y[:level]". No entry means the point's original node. Mirrors post-edit's
   * `postEditActiveSplitNode`. */
  presetActiveSplitNode: Record<string, PresetEndpoint>;
  /** The point currently selected for the "Manage split nodes" dialog on the preset stage. */
  presetFocusedPoint: [number, number] | null;
  /** The link (edge/teleport) currently hovered in the preset "Manage split nodes" panel's link
   *  bubbles (GitHub issue #237) — `null` when nothing is hovered. Drives a canvas highlight the
   *  same way `EdgeHighlightRenderer`'s pointermove-driven hover does, but sourced from the panel
   *  instead of the cursor. */
  presetHoveredLink: PresetHoveredLink | null;
  /** Coordinate cells currently hovered in an Elements row. */
  presetHoveredEntity: PresetEndpoint[] | null;
  presetHoveredEntityMode: PresetEntityHighlightMode;
  /** Expanded/collapsed state per Preset Connections card section, keyed by section id — mirrors
   *  `AnalyticsOverlayState.analyticsSectionsExpanded` (GitHub issue #340's UI follow-up). Only the
   *  "Problems" section (isolated-nodes/orphan-split warnings) is collapsible, via the same shared
   *  `SectionHeader` Analytics/Image Export already use, no count in the label — every other
   *  section on this card (Edges Tools, Vertex Tools, Control, etc.) is a plain, always-expanded
   *  group, not tracked here. */
  presetSectionsExpanded: Record<string, boolean>;
  /** Deferred vertex-tool placement waiting on a split-node pick (GitHub issue #474, extended to
   *  presets). Set when a left click with a vertex tool lands on a split point (>0 declared
   *  slots) — `PresetSplitTargetDialog` shows, and picking a node calls
   *  `applyPresetSplitTargetPick`, which dispatches the deferred tool to that specific node. The
   *  active-node concept (`presetActiveSplitNode`) must not decide which node a placement
   *  attaches to. `null` when no pick is pending. `slotIds` are the point's declared slots in
   *  ascending order; the picker also always offers the original node (slot `undefined`). */
  presetSplitTargetPrompt:
    | {
        point: [number, number];
        level?: number;
        slotIds: number[];
        action:
          | { tool: "set_start" | "set_finish" }
          | { tool: "lock_in" | "lock_out" | "full_lock" }
          | { tool: "gen_source" }
          | { tool: "vertical_passage_one_way" | "vertical_passage_two_way" }
          | { tool: "elevator" }
          | { tool: "teleport_one_way" | "teleport_two_way" }
          /** Deferred commit of a FRESH vertical-passage placement whose TARGET floor turned out to
           *  be split (GitHub issue #594, parity with post-edit's `place_vertical_passage` from
           *  GitHub issue #567) — `origin`/`passageTool`/`direction` are exactly
           *  `commitPresetVerticalPassage`'s own params; only the `to` end (the target floor's own
           *  point) needed resolving, so `picks` has exactly one slot. `origin` was already resolved
           *  (possibly through this very dialog, if the origin point was itself split) before this
           *  action was built, never re-resolved here. */
          | { tool: "place_vertical_passage_target"; origin: PresetEndpoint; passageTool: "vertical_passage_one_way" | "vertical_passage_two_way"; direction: "up" | "down" }
          /** Deferred commit of a FRESH elevator placement whose OTHER floors can independently be
           *  split (GitHub issue #594, parity with post-edit's `place_elevator` from GitHub issue
           *  #567) — `origin`/`levels`/`editingId` are exactly `confirmPresetElevatorPlacement`'s own
           *  params (`levels` ascending, matching `pending.floors`' own sort order, origin's own level
           *  included). Any subset of `levels` can independently be split, so every split floor gets
           *  its own queued dialog; `picks[i]` is `levels[i]`'s own resolved target. */
          | { tool: "place_elevator_target"; origin: PresetEndpoint; levels: number[]; editingId?: number }
          /** Deferred commit of a vertical-passage-endpoint drag (GitHub issue #594, parity with
           *  post-edit's `move_vertical_passage_endpoint` from GitHub issue #567) — `id`/`end`
           *  identify the dragged endpoint. `picks` has two slots: `[0]` the dragged end's own new
           *  target, `[1]` the OTHER end's own new target on its own floor (GitHub issue #566 moves
           *  both ends to the same (x, y)). */
          | { tool: "move_vertical_passage_endpoint"; id: number; end: "from" | "to" }
          /** Deferred commit of an elevator-endpoint drag (GitHub issue #594, parity with post-edit's
           *  `move_elevator_endpoint` from GitHub issue #567) — `id` identifies the dragged entry,
           *  `levels` is every floor the drag re-targets (dragged floor first, then every OTHER floor
           *  ascending). `picks[i]` is `levels[i]`'s own new target. */
          | { tool: "move_elevator_endpoint"; id: number; levels: number[] };
        /** Present only for the deferred drag/placement actions above — see `resolvePresetSplitTargets`
         *  (`fieldEditUtils.ts`) and `applyPresetSplitTargetPick`'s own doc comment. */
        queue?: { targetIndex: number; point: [number, number]; level?: number; slotIds: number[] }[];
        picks?: (PresetEndpoint | undefined)[];
      }
    | null;
  /** In-progress entity-delete prompt (GitHub issue #540) — set whenever a `clear` cell click, or a
   *  RMB vertex-tool click with more than one matching marker, targets a point carrying more than
   *  one removable entity. `requestPresetEntityDelete` is the sole entry point: it counts the live
   *  descriptors for `scope` and only opens this prompt when the count is >1 (0 is a no-op, 1 calls
   *  `removePresetPointEntity` directly, no dialog). The dialog rebuilds its row list from this
   *  `scope` on every render (`buildPresetPointEntities`), never caching descriptors — see
   *  `Specs/preset-connections.md`'s "Entity delete/reset dialog" section. Mutually exclusive with
   *  `presetSplitTargetPrompt` — opening one closes the other. */
  presetEntityDeletePrompt:
    | { point: [number, number]; level?: number; scope: PresetPointEntityScope }
    | null;
  /** Live drag preview for a preset vertical-passage/elevator endpoint (GitHub issue #566) or a
   *  start/finish marker (GitHub issue #613) — set by `PresetConnectionsController` on every
   *  pointermove while such a drag is armed, cleared on pointerup. Purely visual, mirrors
   *  post-edit's own `postEditDragOverride`: nothing here is committed to
   *  `presetVerticalPassages`/`presetElevators`/`presetStart`/`presetFinish` until release, so an
   *  intermediate cell the cursor passes over never gets written even transiently. Not persisted. */
  presetDragOverride: PresetDragOverride | null;
  /** Set when a vertical-passage/elevator drag is released over a point that doesn't exist on one
   *  of the entity's OTHER floors (GitHub issue #566) — the whole drag is reverted (see
   *  `movePresetVerticalPassageEndpoint`/`movePresetElevatorEndpoint`'s own doc comments) and this
   *  is populated so the `AlertModal` rendered in `PresetConnectionsFeature` can tell the user which
   *  floor/point rejected the move. Cleared by `dismissPresetDragFailureMessage` (the dialog's own
   *  OK button). */
  presetDragFailureMessage: PresetDragFailure | null;
}

/** See `PresetConnectionsState.presetDragOverride`. */
export type PresetDragOverride =
  | { kind: "verticalPassageEndpoint"; id: number; end: "from" | "to"; point: [number, number] }
  | { kind: "elevatorEndpoint"; id: number; level: number; point: [number, number] }
  /** Live preview for a start/finish marker drag (GitHub issue #613) — mirrors post-edit's own
   *  `postEditDragOverride`'s `marker` variant: nothing is written to `presetStart`/`presetFinish`
   *  until pointerup, so a fast drag no longer forces a full store update (and canvas redraw) on
   *  every pointermove. */
  | { kind: "marker"; marker: "start" | "finish"; point: [number, number] };

/** See `PresetConnectionsState.presetDragFailureMessage`. `entityKind` picks the message wording
 *  ("passage" vs. "stop") — `level` is 0-based, `PresetConnectionsFeature` formats it 1-based
 *  (`level + 1`) when building the message. */
export interface PresetDragFailure {
  entityKind: "vertical_passage" | "elevator";
  level: number;
  point: [number, number];
}

export interface PresetConnectionsActions {
  setPresetConnectionsTool: (tool: PresetConnectionTool) => void;
  applyPresetConnectionsTool: (key: string, from: [number, number], to: [number, number]) => void;
  /** Same as `applyPresetConnectionsTool`, but takes `tool` explicitly instead of reading
   * `state.presetConnectionsTool` — used by the "Manage split nodes" dialog's own kind switcher
   * (GitHub issue #234), which must not disturb the canvas's globally active edge tool. */
  applyPresetConnectionsToolAt: (tool: PresetConnectionTool, key: string, from: [number, number], to: [number, number]) => void;
  /** Cycles a user-defined one-way edge between its forward and backward directions. */
  cyclePresetConnectionDirection: (key: string) => void;
  /** Sets an edge to the client-only `"undefined"` state (explicit "preset allows but doesn't
   * force" — GitHub issue #234's "preset optional connection"). No `PresetConnectionTool` produces
   * this state; the "Manage split nodes" dialog also writes it directly for face editing. */
  setPresetConnectionUndefined: (key: string, from: PresetEndpoint, to: PresetEndpoint) => void;
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
  /** Same as `setPresetGenSource`, but takes a `PresetEndpoint` directly instead of resolving via
   * `state.presetActiveSplitNode` — used by `applyPresetSplitTargetPick` (GitHub issue #494) to
   * assign the generation source to a *specific* node of a split point picked in
   * `PresetSplitTargetDialog`, independent of which node happens to be globally active. */
  setPresetGenSourceEndpoint: (endpoint: PresetEndpoint | null) => void;
  setGenerationSourceMode: (mode: "default" | "random") => void;
  setDefaultEdgeState: (s: "undefined" | "wall" | "passage") => void;
  setHighlightInvalidPresets: (highlight: boolean) => void;
  setHighlightIsolatedNodes: (highlight: boolean) => void;
  setHighlightOrphanSplitNodes: (highlight: boolean) => void;
  setShowPresetOrigin: (show: boolean) => void;
  setShowPresetLocks: (show: boolean) => void;
  setLockedNode: (x: number, y: number, kind: NodeLockKind, slotId?: number) => void;
  removeLockedNode: (x: number, y: number, slotId?: number) => void;
  clearLockedNodes: () => void;
  setAutoLock: (v: boolean) => void;
  setPresetTeleportPendingFrom: (endpoint: PresetEndpoint | null) => void;
  addPresetTeleport: (from: PresetEndpoint, to: PresetEndpoint, direction: "forward" | "two_way") => void;
  cyclePresetTeleportDirection: (id: number) => void;
  removePresetTeleport: (id: number) => void;
  movePresetTeleportEndpoint: (id: number, end: "from" | "to", cell: [number, number], level: number) => void;
  /** Click on a cell with `vertical_passage_one_way`/`vertical_passage_two_way` active — resolves
   * available directions itself (via `cellExistsAt`) and either creates the entry immediately (one
   * direction available) or opens `presetVerticalPassagePending` for `PresetVerticalDirectionDialog`
   * (both available). A no-op if neither direction has a cell (shouldn't happen — the tools are
   * hidden below 2 floors — but guarded defensively). Either way, when the resolved TARGET floor's
   * own point turns out to be declared split (GitHub issue #594), the actual entry creation is
   * deferred through `presetSplitTargetPrompt` (`place_vertical_passage_target`) instead of
   * `commitPresetVerticalPassage`'s previous silent `slotId: undefined` default. */
  startPresetVerticalPassagePlacement: (origin: PresetEndpoint, tool: "vertical_passage_one_way" | "vertical_passage_two_way") => void;
  /** Resolves a pending vertical-passage placement with the chosen direction, creating the entry —
   * same target-floor split-tile detour as `startPresetVerticalPassagePlacement` above (GitHub issue
   * #594). No-op if nothing is pending. */
  choosePresetVerticalPassageDirection: (direction: "up" | "down") => void;
  cancelPresetVerticalPassagePlacement: () => void;
  cyclePresetVerticalPassageDirection: (id: number) => void;
  removePresetVerticalPassage: (id: number) => void;
  /** Moves BOTH ends of the passage to `point` (GitHub issue #566) — see
   *  `moveVerticalPassageEndpoint` (fieldValidity.ts)'s own doc comment. Sets
   *  `presetDragFailureMessage` and leaves `presetVerticalPassages` unchanged when `point` doesn't
   *  resolve on the other end's own floor. When either end's landing point turns out to be split
   *  (GitHub issue #594), defers the commit through `presetSplitTargetPrompt`
   *  (`move_vertical_passage_endpoint`) instead of silently attaching both ends to their original
   *  node — same split-tile check `tryCommitPresetVerticalPassage` runs for a fresh placement. */
  movePresetVerticalPassageEndpoint: (id: number, end: "from" | "to", point: [number, number]) => void;
  /** Starts a pending elevator placement at `origin` (the first click) — the active floor is
   * always included in `floors` from the start and can't be removed. If `origin`'s point already
   * has an elevator on the active floor, edits that entry instead (`floors` seeds from its current
   * floors, `editingId` set) — see `presetElevatorPending`'s own doc comment. */
  startPresetElevatorPlacement: (origin: PresetEndpoint) => void;
  /** Toggles whether `floorIndex` is included in the in-progress elevator placement — a no-op if
   * `floorIndex` is the origin's own floor (can't be unchecked) or no placement is pending. */
  togglePresetElevatorFloor: (floorIndex: number) => void;
  /** Commits the pending elevator placement (2+ floors selected) as a new `PresetElevatorEntry` and
   * clears the pending state; a no-op (does not clear pending) if fewer than 2 floors are selected.
   * When any selected floor's own point turns out to be declared split (GitHub issue #594), the
   * actual commit is deferred through `presetSplitTargetPrompt` (`place_elevator_target`) instead of
   * silently attaching that floor to its original node. */
  confirmPresetElevatorPlacement: () => void;
  cancelPresetElevatorPlacement: () => void;
  removePresetElevator: (id: number) => void;
  /** Moves EVERY floor endpoint of the elevator to `point` (GitHub issue #566) — see
   *  `moveElevatorEndpoint` (fieldValidity.ts)'s own doc comment. `level` is the dragged marker's
   *  own floor (the drag's "own end"). Sets `presetDragFailureMessage` and leaves `presetElevators`
   *  unchanged when `point` doesn't resolve on one of the OTHER floors. When any floor's landing
   *  point turns out to be split (GitHub issue #594), defers the commit through
   *  `presetSplitTargetPrompt` (`move_elevator_endpoint`) instead of silently attaching every floor
   *  to its original node. */
  movePresetElevatorEndpoint: (id: number, level: number, point: [number, number]) => void;
  /** Live drag preview setter (GitHub issue #566) — mirrors post-edit's own
   *  `setPostEditDragOverride`. */
  setPresetDragOverride: (override: PresetDragOverride | null) => void;
  /** Closes the drag-failure `AlertModal` rendered in `PresetConnectionsFeature` (its own OK button). */
  dismissPresetDragFailureMessage: () => void;
  addPresetSplitNode: (point: [number, number]) => void;
  removePresetSplitNode: (point: [number, number], slotId: number) => void;
  /** Removes an entire split point (every declared slot at once) and migrates every entity
   *  anchored on a removed node onto the original node instead of deleting it (GitHub issue #540's
   *  entity-delete dialog "split segment" row) — see `removePresetSplitAll`'s own doc comment. */
  removePresetSplitAll: (point: [number, number], level?: number) => void;
  cyclePresetActiveSplitNode: (point: [number, number]) => void;
  setPresetActiveSplitNode: (point: [number, number], endpoint: PresetEndpoint) => void;
  setPresetFocusedPoint: (point: [number, number] | null) => void;
  setPresetHoveredLink: (link: PresetHoveredLink | null) => void;
  setPresetHoveredEntity: (endpoints: PresetEndpoint[] | null, mode?: PresetEntityHighlightMode) => void;
  /** Rotates every geometric-face connection of `point`'s nodes (original + every declared slot)
   * by one offset index — see `rotatePresetSplitPoint` (fieldEditUtils.ts). No-op if it would push
   * any connection outside the field. */
  rotatePresetSplitPoint: (point: [number, number], direction: 1 | -1) => void;
  /** Applies a built-in split-node blueprint (GitHub issue #235) to `point` — a full replace:
   * every existing slot at the point (and every connection/teleport/start/finish/gen-source
   * reference to it) is dropped first, then one fresh slot per blueprint node is minted and its
   * required faces get a `passage`. See `splitBlueprints.ts`. */
  applyPresetSplitBlueprint: (point: [number, number], blueprint: SplitNodeBlueprint) => void;
  setPresetSectionExpanded: (id: string, expanded: boolean) => void;
  /** Removes every preset touching `point` on the active floor: every `presetConnections` entry
   *  with an endpoint there (original node or any declared slot), every `presetTeleports` entry
   *  with an endpoint there, the point's own declared split slots (and their active-node
   *  selection), its own `lockedNodes` entry, and `presetStart`/`presetFinish`/`presetGenSource`
   *  if any of them addresses this point. Mirrors post-edit's `resetPostEditPoint` cell-click
   *  behavior (GitHub issue #340's "clear" tool follow-up) — but presets have no prior generation
   *  to roll back to, so this deletes outright rather than restoring a generated snapshot. */
  resetPresetPoint: (point: [number, number]) => void;
  /** Opens `presetSplitTargetPrompt` — called by `PresetConnectionsController` when a vertex-tool
   *  left click lands on a split point. */
  requestPresetSplitTarget: (prompt: NonNullable<PresetConnectionsState["presetSplitTargetPrompt"]>) => void;
  /** Resolves the pending prompt: dispatches the deferred vertex tool to the picked node.
   *  `slotId: undefined` = the point's original node. No-op if nothing is pending. */
  applyPresetSplitTargetPick: (slotId: number | undefined) => void;
  cancelPresetSplitTarget: () => void;
  /** Entry point from `PresetConnectionsController` for both the `clear` cell tool (`scope:
   *  "point_all"`) and RMB vertex-tools (`scope: "vertex_markers"`, GitHub issue #540). Counts the
   *  live descriptors `buildPresetPointEntities` returns for `scope`: 0 is a no-op, exactly 1 calls
   *  `removePresetPointEntity` on it directly (no dialog, matches the pre-#540 single-entity
   *  behavior), more than 1 opens `presetEntityDeletePrompt`. Closes `presetSplitTargetPrompt` if it
   *  happens to be open (the two prompts are mutually exclusive). */
  requestPresetEntityDelete: (point: [number, number], level: number | undefined, scope: PresetPointEntityScope, bulk?: boolean) => void;
  cancelPresetEntityDelete: () => void;
  /** Removes exactly one entity by its descriptor (`kind`+`id`) — the single code path both a
   *  dialog row click and `requestPresetEntityDelete`'s count===1 shortcut go through. Dispatches
   *  to the matching existing per-entity remover based on `descriptor.kind`. Closes the prompt if,
   *  after removal, the prompt's own scope has no descriptors left. */
  removePresetPointEntity: (descriptor: PresetPointEntityDescriptor) => void;
  /** "Delete all" — removes every descriptor currently in `presetEntityDeletePrompt`'s scope (not
   *  necessarily the whole point — a `vertex_markers` scope only removes its own 1-5 markers) and
   *  closes the prompt. For `scope: "point_all"` this is equivalent to the old `resetPresetPoint`. */
  removeAllPresetPointEntities: () => void;
}
