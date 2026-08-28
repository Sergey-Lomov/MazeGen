import type { NodeLockKind } from "../wasm/types";
import type { PresetConnectionEntry, PresetConnectionTool, PresetTeleportEntry, PresetVerticalPassageEntry, PresetElevatorEntry } from "../pixi/fieldEditUtils";
import type { PresetEndpoint } from "../pixi/presetEndpoint";
import type { SplitNodeBlueprint } from "../pixi/splitBlueprints";

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
  highlightInvalidPresets: boolean;
  highlightIsolatedNodes: boolean;
  /** Whether the "N split node(s) unused" warning bubble is currently hovered (GitHub issue #420) —
   *  mirrors `highlightIsolatedNodes` above, driving the same kind of canvas highlight for orphan
   *  split nodes instead. */
  highlightOrphanSplitNodes: boolean;
  showPresetOrigin: boolean;
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
  presetHoveredLink: { from: PresetEndpoint; to: PresetEndpoint } | null;
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
          | { tool: "vertical_passage_one_way" | "vertical_passage_two_way" }
          | { tool: "elevator" }
          | { tool: "teleport_one_way" | "teleport_two_way" };
      }
    | null;
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
  setHighlightOrphanSplitNodes: (highlight: boolean) => void;
  setShowPresetOrigin: (show: boolean) => void;
  setLockedNode: (x: number, y: number, kind: NodeLockKind) => void;
  removeLockedNode: (x: number, y: number) => void;
  clearLockedNodes: () => void;
  setAutoLock: (v: boolean) => void;
  setPresetTeleportPendingFrom: (endpoint: PresetEndpoint | null) => void;
  addPresetTeleport: (from: PresetEndpoint, to: PresetEndpoint, direction: "forward" | "two_way") => void;
  cyclePresetTeleportDirection: (id: number) => void;
  removePresetTeleport: (id: number) => void;
  movePresetTeleportEndpoint: (id: number, end: "from" | "to", cell: [number, number]) => void;
  /** Click on a cell with `vertical_passage_one_way`/`vertical_passage_two_way` active — resolves
   * available directions itself (via `cellExistsAt`) and either creates the entry immediately (one
   * direction available) or opens `presetVerticalPassagePending` for `PresetVerticalDirectionDialog`
   * (both available). A no-op if neither direction has a cell (shouldn't happen — the tools are
   * hidden below 2 floors — but guarded defensively). */
  startPresetVerticalPassagePlacement: (origin: PresetEndpoint, tool: "vertical_passage_one_way" | "vertical_passage_two_way") => void;
  /** Resolves a pending vertical-passage placement with the chosen direction, creating the entry.
   * No-op if nothing is pending. */
  choosePresetVerticalPassageDirection: (direction: "up" | "down") => void;
  cancelPresetVerticalPassagePlacement: () => void;
  cyclePresetVerticalPassageDirection: (id: number) => void;
  removePresetVerticalPassage: (id: number) => void;
  movePresetVerticalPassageEndpoint: (id: number, end: "from" | "to", endpoint: PresetEndpoint) => void;
  /** Starts a pending elevator placement at `origin` (the first click) — the active floor is
   * always included in `floors` from the start and can't be removed. If `origin`'s point already
   * has an elevator on the active floor, edits that entry instead (`floors` seeds from its current
   * floors, `editingId` set) — see `presetElevatorPending`'s own doc comment. */
  startPresetElevatorPlacement: (origin: PresetEndpoint) => void;
  /** Toggles whether `floorIndex` is included in the in-progress elevator placement — a no-op if
   * `floorIndex` is the origin's own floor (can't be unchecked) or no placement is pending. */
  togglePresetElevatorFloor: (floorIndex: number) => void;
  /** Commits the pending elevator placement (2+ floors selected) as a new `PresetElevatorEntry` and
   * clears the pending state; a no-op (does not clear pending) if fewer than 2 floors are selected. */
  confirmPresetElevatorPlacement: () => void;
  cancelPresetElevatorPlacement: () => void;
  removePresetElevator: (id: number) => void;
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
}
