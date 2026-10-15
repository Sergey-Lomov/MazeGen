import type { NodeDto, EdgeDto } from "../wasm/types";
import type { PostEditEndpoint, PostEditHoveredEntity } from "../pixi/postEditEndpoint";
import type { SplitNodeBlueprint } from "../pixi/splitBlueprints";
import type { PostEditCommand } from "./postEditCommandTypes";
import type { PostEditResetLifelineDescriptor } from "../pixi/postEditResetLifelines";
import type { PostEditBaseline, PostEditDerivedState } from "../pixi/postEditReplay";
import type { PostEditPointEntityDescriptor } from "../pixi/postEditPointEntities";
import type { EntityToolPurpose } from "../pixi/entityToolKinds";
import type {
  PostEditTool,
  PostEditEdgeToolMode,
  PostEditEdge,
  PostEditMeta,
  PostEditTeleportDirection,
  PostEditVerticalPassageDirection,
  PostEditTeleportEntry,
  PostEditVerticalPassageEntry,
  PostEditElevatorEntry,
  PostEditAnalytics,
  PostEditVerticalDragFailure,
} from "./postEditTypes";

/** One hovered issue's base-graph edge, plus how it should be drawn (GitHub issue #377). Loop/
 *  teleport-group/split-route edges (`asWall: false`) form a connected path or group and stay
 *  drawn as a straight line between node centers — breaking one into a wall segment would read as
 *  disconnected stubs instead of a path. A single-edge issue like `invalid_one_way` (`asWall:
 *  true`) has no such path to preserve, and its two endpoint cells are always tessellation
 *  neighbors, so it draws as the shared wall between them instead — clearer than a line since a
 *  one-way problem *is* about that wall/passage, not about traversing between the cells. */
export interface IssueHighlightEdge {
  from: number;
  to: number;
  asWall: boolean;
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
  /** Base-graph edges of the issue currently hovered in IssuesBlock, each carrying its own
   *  line-vs-wall draw mode — see `IssueHighlightEdge`. */
  hoveredIssueLoopEdges: IssueHighlightEdge[] | null;
  /** Undersized SCC region(s) currently hovered in IssuesBlock, each as its own list of maze
   * node ids — kept as separate groups (not one flat list) so adjacent-in-id-space but disjoint
   * regions don't merge into one shared outline. The renderer derives each region's perimeter
   * client-side from its node set. `isSplit` (GitHub issue #619) picks the outward "split" inset
   * instead of the normal inward one — set explicitly by `IssuesBlock.tsx` from the payload kind
   * that produced the group, never guessed from the group's own geometry (a multi-cell split tile
   * has no duplicate node/cell to detect that way). */
  hoveredIssueRegionGroups: { nodes: number[]; isSplit: boolean }[] | null;
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
  setHoveredIssueLoopEdges: (edges: IssueHighlightEdge[] | null) => void;
  setHoveredIssueRegionGroups: (groups: { nodes: number[]; isSplit: boolean }[] | null) => void;
  setAnalyticsSectionExpanded: (id: string, expanded: boolean) => void;
  setShowFullyPresetLockedIssues: (v: boolean) => void;
}

export interface PostEditState {
  postEditAutoConfirm: boolean;
  /** When true, `compactPostEditLog` (GitHub issue #548) runs automatically after every command/
   * batch appended to `postEditCommands` — same "opt-in convenience toggle next to a manual
   * button" shape as `postEditAutoConfirm`. `false` by default: compaction rewrites/drops log
   * entries, which a user reviewing the Changes panel may not want happening behind their back
   * unless they've asked for it. */
  postEditAutoCompact: boolean;
  postEditTool: PostEditTool;
  /** Ordered, replayable command log (GitHub issue #543) — the single source of truth for every
   * manual post-edit change. `postEditDraft*` fields below are derived from this log +
   * `postEditBaseline` by `applyPostEditCommand`/`replayPostEditCommands` (`pixi/postEditReplay.ts`)
   * and re-mirrored into those fields on every log mutation (`appendPostEditCommand`/
   * `replacePostEditCommands`, `postEditSliceHelpers.ts`) — kept as plain state fields (not lazy
   * getters) since most of the ~40 read sites across the codebase subscribe to them individually via
   * zustand selectors. Treat `postEditDraft*` as read-only outside `postEditSlice.ts`/
   * `postEditSliceHelpers.ts` — the log is what gets mutated. */
  postEditCommands: PostEditCommand[];
  /** Generation-time snapshot (`context`) + revision + pristine (empty-log) derived state — see
   * `PostEditBaseline`'s own doc comment. `derived` here is NEVER overwritten after construction
   * (`replayPostEditCommands`/`replayPostEditCommandsFailClosed` always fold starting from it) —
   * the *current* derived state (log applied) lives in `postEditDerived` below, a separate field.
   * `null` before the first generation. */
  postEditBaseline: PostEditBaseline | null;
  /** Current derived state — `postEditBaseline.derived` (pristine) with `postEditCommands`
   * replayed on top. Cache kept in sync by `appendPostEditCommand`/`replacePostEditCommands`
   * (`postEditSliceHelpers.ts`), the sole log-mutation points; `postEditDraft*`/
   * `postEditSuppressed*` fields are mirrored from this on every mutation. `null` before the first
   * generation (mirrors `postEditBaseline`). */
  postEditDerived: PostEditDerivedState | null;
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
  /** Monotonic id source for one-way edges (GitHub issue #564) — see `PostEditEdge`'s
   * discriminated union. Seeded from `max(baseline one-way ids) + 1` on generate. A fresh one-way
   * created via wall/passage → one-way mints from here; flipping direction on the same face reuses
   * the existing side's id (same entity); returning to wall/passage and back to one-way mints a new
   * id (a new entity on the same face). */
  /** Working copy — updated on endpoint changes. Read by PostEditRenderer. */
  postEditDraftMeta: PostEditMeta | null;
  /** slotIds of a split point's extra nodes (beyond the point's original node), keyed by "x,y".
   * Absent/empty for an unsplit point (GitHub issue #221). Each slotId is unique only within its
   * own point (not globally — `PostEditEndpoint`'s `split` variant already addresses point+slotId
   * together, so per-point uniqueness is enough). Minted from `_nextSplitSlotId[key]` (a high-water
   * mark per point, GitHub issue #543 plan section 7) rather than `max(existing)+1` — a point-reset
   * can prune a high-id slot out of the log while the mark stays put, so a later `addSplitNode` at
   * the same point never reissues an id that outstanding references (e.g. in the confirmed graph
   * or export) might still resolve to. Never reused while a slot still exists — same stable-identity
   * principle already used for `PostEditTeleportEntry.id`, just with its own per-point counter
   * instead of a global one. Re-applied via `Maze::add_node_at` (one call per slotId, in a deterministic order)
   * on every confirmPostEdit. */
  postEditDraftSplitPoints: Record<string, number[]>;
  /** Stable id of each split point (the whole point, not a slot — GitHub issue #564), keyed the
   * same way as `postEditDraftSplitPoints` (`"x,y"`/`"x,y@level"`). Present only for points that
   * currently have at least one extra slot (mirrors `postEditDraftSplitPoints`' own absent-key
   * convention). Minted from `_nextPostEditSplitPointId` on first split; a baseline (generation-time)
   * split point instead carries its id from `postEditBaseline.derived.splitPointIds`. A string
   * (`"s{n}"`, GitHub issue #564 second follow-up — see `postEditIdFormat.ts`). */
  postEditDraftSplitPointIds: Record<string, string>;
  /** High-water mark for `postEditDraftSplitPoints`' per-point slotId minting — see that field's
   * doc comment. Keyed the same way (`"x,y"`/`"x,y@level"`). Persisted separately from the command
   * log (plan section 7) so a point-reset that prunes high-id slot commands out of the log can't
   * cause a later `addSplitNode` at that point to reissue a pruned id. */
  _nextSplitSlotId: Record<string, number>;
  /** Monotonic id source for split points as a whole (GitHub issue #564) — see
   * `postEditDraftSplitPointIds`. Seeded from `max(baseline split point ids) + 1` on generate. */
  _nextPostEditSplitPointId: number;
  /** Which of a point's nodes is currently "active" for edge-tool clicks on its faces, keyed by
   * "x,y". No entry means the point's original node. */
  postEditActiveSplitNode: Record<string, PostEditEndpoint>;
  /** The point currently selected for the "Manage split nodes" dialog — the single source of
   * truth for which point is being managed. Set by a right-click on any cell while an edge tool is
   * active, cleared by an ordinary click elsewhere, closing the dialog, or leaving the post-edit
   * card. Not hover — doesn't change on mere cursor movement. */
  postEditFocusedPoint: [number, number] | null;
  /** True while the "Manage split nodes" dialog (`postEditFocusedPoint` non-null) is covered by
   * another `SidePanel` stacked on top of it (GitHub issue #629 follow-up) — the dialog itself is
   * still open (`postEditFocusedPoint` unchanged), just not the visible panel. Driven by
   * `ManageSplitNodesDialog`'s `SidePanel.onTopChange`. `PostEditRenderer`'s on-canvas cell outline
   * for the point being edited reads this alongside `postEditFocusedPoint` — the outline would
   * otherwise keep highlighting a cell for a dialog the user can no longer see or act on. */
  postEditFocusedPointCovered: boolean;
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
  /** nodes/edges as generated — the Generation feature's own frozen snapshot, restored on
   * resetPostEdit. Unlike `state.nodes`/`state.edges` (which confirmPostEdit overwrites with the
   * current, possibly manually-edited graph so PostEditController/PostEditRenderer/
   * ManageSplitNodesDialog/AnalyticsRenderer keep seeing confirmed post-edit state, including
   * confirmed auto-split nodes), these two are never touched by confirmPostEdit — only by
   * generate() and resetPostEdit — so GenerationRenderer can read them and always show the
   * generation result regardless of what post-edit has done since. */
  _generatedNodes: NodeDto[];
  _generatedEdges: EdgeDto[];
  /** True after any manual post-edit change since the last generate/reset. */
  postEditDirty: boolean;
  /** The entity currently hovered in the "Manage split nodes" panel's link bubbles (GitHub issue
   *  #237) or the "Changes" panel's entity bubbles (GitHub issue #546) — `null` when nothing is
   *  hovered. Drives a canvas highlight the same way `EdgeHighlightRenderer`'s pointermove-driven
   *  hover does, but sourced from a panel instead of the cursor. Supersedes the old
   *  `postEditHoveredLink` (a `from`/`to` pair only) — see `PostEditHoveredEntity`'s doc comment
   *  for why a "Changes" row needs the wider point/link/points union. */
  postEditHoveredEntity: PostEditHoveredEntity | null;
  /** User-editable vertical passages (GitHub issue #341) — mirrors `presetVerticalPassages`, own
   * flat collection since `PostEditVerticalPassageEntry`'s endpoints live on different floors, not
   * folded into `postEditDraftEdges`. */
  postEditDraftVerticalPassages: PostEditVerticalPassageEntry[];
  /** In-progress vertical-passage placement — mirrors `presetVerticalPassagePending`, addressed by
   * `PostEditEndpoint` (the clicked node) instead of `PresetEndpoint`. */
  postEditVerticalPassagePending: { origin: PostEditEndpoint; tool: "vertical_passage_one_way" | "vertical_passage_two_way"; availableDirections: ("up" | "down")[] } | null;
  _nextPostEditVerticalPassageId: number;
  /** User-editable elevators (GitHub issue #341) — mirrors `presetElevators`. */
  postEditDraftElevators: PostEditElevatorEntry[];
  /** In-progress elevator placement — mirrors `presetElevatorPending`. `editingId` is set when
   * editing an existing draft entry (generation-baked or user-created — both are full draft
   * entries with a stable id since GitHub issue #564) and unset when placing a fresh one. */
  postEditElevatorPending: { origin: PostEditEndpoint; floors: Set<number>; editingId?: string } | null;
  _nextPostEditElevatorId: number;
  /** In-progress "which split node?" prompt (GitHub issue #474) — set whenever a vertex tool
   * (`set_start`/`set_finish`, a vertical-passage tool, `elevator`, a teleport tool) is used on a
   * split point. The active-node concept must not leak into connection placement, so instead of
   * silently attaching to the active/original node the placement is deferred until the user picks
   * one of the point's nodes via `applyPostEditSplitTargetPick`. `nodeIds` are the point's
   * confirmed nodes in snapshot order (index 0 = the point's original node — see
   * `PostEditController.buildNodeMap`); an unconfirmed split slot has no real id yet and is not
   * offered, same as the pre-#474 no-op on an unconfirmed active split node. `null` when no
   * prompt is open. Never persisted (ephemeral placement state).
   *
   * `queue`/`picks` extend the original single-point prompt for GitHub issue #567: dragging an
   * existing teleport/vertical-passage/elevator endpoint onto a split tile needs the same "which
   * node?" prompt, but so does placing a brand-NEW vertical passage/elevator whose target floor
   * happens to already be split (issue #567 second follow-up — `resolveActiveNodeIdAt`'s
   * active/first-node default silently picked a node there too, same class of bug as the drag
   * case). Either way, more than one split point can be touched at once — a vertical passage's
   * OTHER end (GitHub issue #566 moves both ends together) can independently land on a split tile
   * too, and an elevator's drag or fresh placement can touch a split tile on several floors
   * simultaneously. Rather than one dialog with several independent pickers, every affected split
   * point is resolved by its own `PostEditSplitTargetDialog` in sequence: `picks` is a fixed-length
   * array (one slot per target the deferred action needs, in that action's own order — see each
   * `move_*`/`place_*` variant's doc comment for what "target" means for it), pre-seeded with
   * `nodeEndpoint(...)` for every target that ISN'T split (resolved for free, no prompt needed) and
   * left `undefined` for every target that IS. `queue` holds one entry per still-`undefined` slot,
   * `targetIndex` naming which one, in ascending order — `queue[0]` is always the point CURRENTLY
   * on screen, mirrored into the top-level `point`/`level`/`nodeIds` fields for the dialog to read
   * directly (both are kept in sync, `queue` is never pre-shifted past the current entry). Picking
   * a node writes the resolved endpoint into `picks[queue[0].targetIndex]`, drops `queue[0]`, and —
   * if any entries remain — shifts the new `queue[0]` into `point`/`level`/`nodeIds` too (dialog
   * stays open, re-rendered for the new point); once `queue` is empty every slot in `picks` is
   * filled and the deferred action dispatches. Absent/empty for every plain-placement action
   * (set_start/set_finish/teleport placement, and the "no split target" fast path of vertical-
   * passage/elevator placement), which only ever touch one point and need no `picks` array — those
   * read `nodeIds`/the picked id directly, unchanged since GitHub issue #474. */
  postEditSplitTargetPrompt:
    | {
        point: [number, number];
        level?: number;
        nodeIds: number[];
        action:
          | { tool: "set_start" | "set_finish" }
          | { tool: "vertical_passage_one_way" | "vertical_passage_two_way" }
          | { tool: "elevator" }
          | { tool: "teleport_one_way" | "teleport_two_way" }
          /** Deferred commit of a teleport-endpoint drag (GitHub issue #567) — `id`/`end` identify
           * the dragged endpoint, mirroring `PostEditDragOverride`'s `teleportEndpoint` variant.
           * `picks` has exactly one slot: the dragged endpoint's own new target. */
          | { tool: "move_teleport_endpoint"; id: string; end: "from" | "to" }
          /** Deferred commit of a vertical-passage-endpoint drag (GitHub issue #567/#566) — `id`/
           * `end` identify the dragged endpoint. `picks` has two slots: `[0]` the dragged end's own
           * new target (the point the drag actually landed on), `[1]` the OTHER end's own new
           * target on its own floor (GitHub issue #566 moves both ends to the same (x, y)) —
           * resolved from this instead of `resolveVerticalPassageMove`'s plain `findNodeAt`, which
           * would otherwise silently take that floor's first (original) node regardless of split. */
          | { tool: "move_vertical_passage_endpoint"; id: string; end: "from" | "to" }
          /** Deferred commit of an elevator-endpoint drag (GitHub issue #567/#566) — `id` identifies
           * the dragged entry, `levels` is every floor the drag re-targets (dragged floor first,
           * then every OTHER floor ascending — mirrors `resolveElevatorMove`'s own ordering).
           * `picks[i]` is `levels[i]`'s own new target. */
          | { tool: "move_elevator_endpoint"; id: string; levels: number[] }
          /** Deferred commit of a FRESH vertical-passage placement (GitHub issue #567 second
           * follow-up) — `origin`/`tool`/`direction` are exactly `commitPostEditVerticalPassage`'s
           * own params; only the `to` end (the target floor's own point, which can independently be
           * split) needed resolving, so `picks` has exactly one slot. Distinct from
           * `move_vertical_passage_endpoint`: this is a brand-new entity, not an existing one being
           * dragged — `origin` was already resolved (possibly through this very dialog, if the
           * origin point was itself split) before this action was built, never re-resolved here. */
          | { tool: "place_vertical_passage"; origin: PostEditEndpoint; passageTool: "vertical_passage_one_way" | "vertical_passage_two_way"; direction: "up" | "down" }
          /** Deferred commit of a FRESH elevator placement (GitHub issue #567 second follow-up) —
           * `origin`/`levels`/`editingId` are exactly `confirmPostEditElevatorPlacement`'s own
           * params (`levels` ascending, matching `pending.floors`' own sort order). Any subset of
           * `levels` can independently be split, so — like `move_elevator_endpoint` — every split
           * floor gets its own queued dialog; `picks[i]` is `levels[i]`'s own resolved target. */
          | { tool: "place_elevator"; origin: PostEditEndpoint; levels: number[]; editingId?: string };
        queue?: { targetIndex: number; point: [number, number]; level?: number; nodeIds: number[] }[];
        picks?: (PostEditEndpoint | undefined)[];
        /** A node the picker leaves out: the other endpoint of a teleport whose endpoint is being
         *  moved onto this tile (GitHub issue #748). */
        excludedNodeId?: number;
      }
    | null;
  /** In-progress entity-delete prompt (GitHub issue #550, mirroring the preset-side dialog from
   *  #540) — set when the `delete` tool targets a point carrying more than one removable entity.
   *  `requestPostEditEntityDelete` is the sole entry point: it counts the live descriptors for
   *  `point`/`level` and only opens this prompt when the count is >1 (0 is a no-op, 1 calls
   *  `removePostEditPointEntity` directly, no dialog). The dialog rebuilds its row list from this
   *  `point`/`level` on every render (`buildPostEditPointEntities`), never caching descriptors. */
  postEditEntityDeletePrompt: { point: [number, number]; level?: number } | null;
  /** In-progress multi-command reset prompt (GitHub issue #549, mirroring the delete tool's own
   *  picker) — set when the `reset` tool's cell branch targets a point carrying more than one
   *  still-relevant command (per compaction; one dialog row per distinct command, not per
   *  lifeline — see `PostEditResetLifelineDescriptor`'s own doc comment for why). `requestPostEditReset`
   *  is the sole entry point: it counts `buildPostEditResetLifelinesAt`'s rows for `point`/`level`
   *  and only opens this prompt when the count is >1 (0 is a no-op, 1 resets that command directly,
   *  no dialog). The dialog snapshots the row list when it opens and only removes rows explicitly
   *  reset from that snapshot; it does not promote older commands while remaining open. */
  postEditResetPrompt: { point: [number, number]; level?: number; lifelines: PostEditResetLifelineDescriptor[] } | null;
  /** Whether the "Changes" panel (GitHub issue #545) — the post-edit command log listing — is
   *  open. Own toggle-driven `SidePanel`, independent of `postEditFocusedPoint`'s "Manage split
   *  nodes" panel — both may be open at once; `SidePanel`'s own mount-order stack (GitHub issue
   *  #629) decides which one is actually shown, since both dock to the same slot. */
  postEditChangesOpen: boolean;
  /** Entity id the "Changes" panel's log is narrowed to (GitHub issue #574), or `null` for no
   *  filter (every row shown). Matches a command's own `entityIdOf` result exactly (`"o5"`, `"t3"`,
   *  ... — `postEditCommandLabels.ts`), never a text search over a row's rendered label; a command
   *  kind with no id of its own (`setEdge`/`setEdgePair` on a wall/basic face, `setMeta`,
   *  `rotateSplitPoint`) never matches any filter value. Ephemeral UI state, not persisted; reset to
   *  `null` on generate/reset so a stale filter doesn't silently hide an unrelated new log. */
  postEditChangesEntityFilter: string | null;
  /** Live drag preview for the start/finish marker, a teleport endpoint, or a vertical-passage
   *  endpoint (GitHub issue #545) — set by `PostEditController` on every pointermove while a drag
   *  is armed, cleared on pointerup. Purely visual: `PostEditRenderer` overlays it on top of
   *  `postEditDraftMeta`/`postEditDraftTeleports`/`postEditDraftVerticalPassages` when building the
   *  scene, but nothing here ever touches `postEditCommands`/`postEditDerived` — the command log
   *  only gets a single command on release (if the drag actually moved to a different node), not
   *  one per pointermove. Not persisted. */
  postEditDragOverride: PostEditDragOverride | null;
  /** Set when a vertical-passage/elevator drag is released over a point with no resolvable node on
   *  one of the entity's OTHER floors (GitHub issue #566) — the whole drag is reverted (see
   *  `movePostEditVerticalPassageEndpoint`/`movePostEditElevatorEndpoint`'s own doc comments) and
   *  this is populated so the `AlertModal` rendered in `PostEditFeature` can tell the user which
   *  floor/point rejected the move. Cleared by `dismissPostEditDragFailureMessage` (the dialog's
   *  own OK button). */
  postEditDragFailureMessage: (PostEditVerticalDragFailure & { entityKind: "vertical_passage" | "elevator" }) | null;
  /** Point whose elements the move or settings tool must disambiguate (GitHub issue #748) — set by
   *  `requestPostEditEntityPick` when the cell carries more than one element relevant to `purpose`.
   *  `PostEditEntityPickDialog` lists every node's elements of a split tile at once. */
  postEditEntityPickPrompt: { point: [number, number]; level?: number; purpose: EntityToolPurpose } | null;
  /** Element chosen for the move tool from `postEditEntityPickPrompt`. `PostEditController` takes it
   *  on the next pointer event and starts carrying it (click-to-drop). */
  postEditMoveRequest: PostEditPointEntityDescriptor | null;
  /** Teleport or vertical passage whose type/direction the settings dialog edits (GitHub issue #748). */
  postEditConnectionSettingsPrompt: { kind: "teleport" | "vertical_passage"; id: string } | null;
}

/** See `PostEditState.postEditDragOverride`. Each variant names the entity being dragged and its
 *  current (possibly still-unconfirmed) target endpoint — `PostEditRenderer` substitutes this for
 *  the entity's real endpoint while the drag is live. */
export type PostEditDragOverride =
  | { kind: "marker"; marker: "start" | "finish"; endpoint: PostEditEndpoint }
  | { kind: "teleportEndpoint"; id: string; end: "from" | "to"; endpoint: PostEditEndpoint }
  | { kind: "verticalPassageEndpoint"; id: string; end: "from" | "to"; endpoint: PostEditEndpoint }
  | { kind: "elevatorEndpoint"; id: string; level: number; endpoint: PostEditEndpoint };

export interface PostEditActions {
  setPostEditAutoConfirm: (v: boolean) => void;
  setPostEditAutoCompact: (v: boolean) => void;
  setPostEditTool: (tool: PostEditTool) => void;
  applyPostEditTool: (edgeKey: string, from: PostEditEndpoint, to: PostEditEndpoint) => void;
  /** Same as `applyPostEditTool`, but takes `tool` explicitly instead of reading
   * `state.postEditTool` — used by the "Manage split nodes" dialog's own kind switcher (GitHub
   * issue #234), which must not disturb the canvas's globally active edge tool. */
  applyPostEditToolAt: (tool: PostEditEdgeToolMode, edgeKey: string, from: PostEditEndpoint, to: PostEditEndpoint) => void;
  setPostEditEndpoint: (kind: "start" | "finish", endpoint: PostEditEndpoint) => void;
  clearPostEditEndpoint: (kind: "start" | "finish") => void;
  setPostEditTeleportPendingFrom: (nodeId: number | null) => void;
  addPostEditTeleport: (from: PostEditEndpoint, to: PostEditEndpoint, direction: PostEditTeleportDirection) => void;
  /** Sets a teleport's type/direction outright (settings dialog, GitHub issue #748) — appends an
   *  `absolute` `setTeleportDirection` command; a no-op when nothing changes. */
  setPostEditTeleportDirection: (id: string, direction: PostEditTeleportDirection) => void;
  removePostEditTeleport: (id: string) => void;
  movePostEditTeleportEndpoint: (id: string, end: "from" | "to", endpoint: PostEditEndpoint) => void;
  confirmPostEdit: () => Promise<void>;
  resetPostEdit: () => void;
  /** Cell branch of the unified Reset tool (GitHub issue #327) — resets one point's
   * edges/teleports/split-slots/start-finish back to generation-time state. See
   * `resetPostEditPoint` (postEditUtils.ts). Called for the "Reset all" dialog button and the
   * Shift-bypass bulk path (GitHub issue #549) — the ordinary click path goes through
   * `requestPostEditReset` instead, which opens a picker dialog when the point carries more than
   * one still-relevant command (one row per distinct command, not per lifeline). */
  resetPostEditPoint: (point: [number, number]) => void;
  /** Entry point from `PostEditController` for the `reset` tool's cell branch (GitHub issue #549,
   *  mirroring `requestPostEditEntityDelete` from #550/#540). Counts
   *  `buildPostEditResetLifelinesAt`'s rows for `point`/`level`: 0 is a no-op, exactly 1 calls
   *  `resetPostEditPointLifeline` on its own `commandIndex` directly (no dialog), more than 1 opens
   *  `postEditResetPrompt`. `bulk` (held Shift) bypasses the picker dialog entirely and resets every
   *  lifeline at once via `resetPostEditPoint`. */
  requestPostEditReset: (point: [number, number], level: number | undefined, bulk?: boolean) => void;
  cancelPostEditReset: () => void;
  /** Resets exactly one row's own lifeline down to before its LATEST command (GitHub issue #549
   *  follow-up) — thin wrapper over `deletePostEditCommand(commandIndex)` (GitHub issue #547's
   *  existing per-row Delete action), `commandIndex` being that row's own
   *  `PostEditResetLifelineDescriptor.commandIndex`. Dialog rows additionally pass their
   *  snapshotted command so index shifts cannot target a different command. The single code path both a reset-dialog row
   *  click and `requestPostEditReset`'s count===1 shortcut go through. Closes the prompt if, after
   *  the reset, the prompt's own point has no affected lifelines left. */
  resetPostEditPointLifeline: (commandIndex: number, command?: PostEditCommand, lifelineKeys?: string[]) => void;
  /** "Reset all" — resets every lifeline currently affecting `postEditResetPrompt`'s point (via
   *  `resetPostEditPoint`, the whole-point fixed-point lifeline cascade) and closes the prompt. */
  resetAllPostEditPointLifelines: () => void;
  /** Delete tool (GitHub issue #386, extended by #550) — removes every generation-placed non-edge
   * piece of content touching `point`'s nodes: start/finish marker, teleport links, vertical
   * passages, elevators, split slots. Basic edges are untouched (see `wall`/`reset`). This is the
   * "remove everything at once" primitive `requestPostEditEntityDelete`'s bulk (shift-held) path
   * and "Delete all" both call — the ordinary click path goes through `requestPostEditEntityDelete`
   * instead, which opens a picker dialog when the point carries more than one entity. See
   * `deletePostEditPoint`'s own doc comment in `postEditSlice.ts` for details. */
  deletePostEditPoint: (point: [number, number]) => void;
  /** Entry point from `PostEditController` for the `delete` tool (GitHub issue #550, mirroring
   *  the preset-side `requestPresetEntityDelete` from #540). Counts the live descriptors
   *  `buildPostEditPointEntities` returns for `point`/`level`: 0 is a no-op, exactly 1 calls
   *  `removePostEditPointEntity` on it directly (no dialog), more than 1 opens
   *  `postEditEntityDeletePrompt`. `bulk` (held Shift) bypasses the picker dialog entirely and
   *  removes every entity at once via `deletePostEditPoint` (which un-splits the point as a whole,
   *  same as the dialog's own `split_point` row). */
  requestPostEditEntityDelete: (point: [number, number], level: number | undefined, bulk?: boolean) => void;
  cancelPostEditEntityDelete: () => void;
  /** Removes exactly one entity by its descriptor (`kind`+`id`) — the single code path both a
   *  dialog row click and `requestPostEditEntityDelete`'s count===1 shortcut go through. A
   *  `split_point` descriptor un-splits the WHOLE tile at once (GitHub issue #550 follow-up) via
   *  `removePostEditSplitSlots`, never a single slot — per-slot removal stays "Manage split nodes"'
   *  own job. Closes the prompt if, after removal, the prompt's own point has no descriptors left. */
  removePostEditPointEntity: (descriptor: PostEditPointEntityDescriptor) => void;
  /** "Delete all" — removes every descriptor currently at `postEditEntityDeletePrompt`'s point and
   *  closes the prompt. Equivalent to `deletePostEditPoint`. */
  removeAllPostEditPointEntities: () => void;
  /** "Reset" action on one Changes-panel row (GitHub issue #547) — truncates `postEditCommands` to
   * end right after `commandIndex` (the log's own oldest-to-newest index, not the panel's reversed
   * display order), discarding every later command regardless of lifeline. See
   * `resetCommandsAt` (`pixi/postEditReplay.ts`). */
  resetPostEditCommand: (commandIndex: number) => void;
  /** "Delete" action on one Changes-panel row (GitHub issue #547) — removes exactly the command at
   * `commandIndex` and resolves what that leaves behind: cascades the whole lifeline for a command
   * that mints a fresh entity, or collapses a single entry (re-resolving later commands' own
   * denormalized fields) for any other kind. See `deleteCommandAt` (`pixi/postEditReplay.ts`). */
  deletePostEditCommand: (commandIndex: number) => void;
  /** Manual "Compact" action (GitHub issue #548) — drops every command in `postEditCommands` whose
   * effect is no longer observable in the log's own final state (superseded by a later command of
   * the same entity/face/point), then renormalizes every survivor's own denormalized fields. See
   * `compactPostEditCommands` (`pixi/postEditCompaction.ts`). */
  compactPostEditLog: () => void;
  addSplitNode: (point: [number, number]) => void;
  removeSplitNode: (point: [number, number], slotId: number) => void;
  cycleActiveSplitNode: (point: [number, number]) => void;
  setActiveSplitNode: (point: [number, number], endpoint: PostEditEndpoint) => void;
  setPostEditFocusedPoint: (point: [number, number] | null) => void;
  setPostEditFocusedPointCovered: (covered: boolean) => void;
  setPostEditHoveredEntity: (entity: PostEditHoveredEntity | null) => void;
  /** Rotates every geometric-face connection of `point`'s nodes (original + every declared slot)
   * by one offset index — see `rotateSplitPointNodes` (postEditUtils.ts). No-op if it would
   * push any connection outside the field. */
  rotateSplitPoint: (point: [number, number], direction: 1 | -1) => void;
  /** Applies a built-in split-node blueprint (GitHub issue #235) to `point` — a full replace:
   * every existing slot at the point (and every edge/teleport/start/finish reference to it) is
   * dropped first, then one fresh slot per blueprint node is minted and its required faces get a
   * `passage`. See `splitBlueprints.ts`. */
  applySplitBlueprint: (point: [number, number], blueprint: SplitNodeBlueprint) => void;
  /** Click on a node with `vertical_passage_one_way`/`vertical_passage_two_way` active — mirrors
   * `startPresetVerticalPassagePlacement`, resolving available directions itself and either creating
   * the entry immediately (one direction available) or opening `postEditVerticalPassagePending`. */
  startPostEditVerticalPassagePlacement: (origin: PostEditEndpoint, tool: "vertical_passage_one_way" | "vertical_passage_two_way") => void;
  choosePostEditVerticalPassageDirection: (direction: "up" | "down") => void;
  cancelPostEditVerticalPassagePlacement: () => void;
  /** Vertical-passage counterpart of `setPostEditTeleportDirection` (GitHub issue #748). */
  setPostEditVerticalPassageDirection: (id: string, direction: PostEditVerticalPassageDirection) => void;
  removePostEditVerticalPassage: (id: string) => void;
  /** Moves BOTH ends of the passage so the dragged end lands on `endpoint` (GitHub issue #566) —
   *  see `movePostEditVerticalPassageEndpoint` (postEditVerticalUtils.ts)'s own doc comment. Sets
   *  `postEditDragFailureMessage` and leaves `postEditDraftVerticalPassages` unchanged when the
   *  other end's floor has no node at the dragged endpoint's new `(x, y)`. `otherEndpoint` (GitHub
   *  issue #567) is the user's own `PostEditSplitTargetDialog` pick for the OTHER end's own landing
   *  point when that point is ALSO split — omitted when it isn't, falling back to the plain
   *  `findNodeAt` resolution `resolveVerticalPassageMove` always used before this issue. */
  movePostEditVerticalPassageEndpoint: (id: string, end: "from" | "to", endpoint: PostEditEndpoint, otherEndpoint?: PostEditEndpoint) => void;
  startPostEditElevatorPlacement: (origin: PostEditEndpoint) => void;
  /** Opens the floor dialog for the existing elevator `id`, seeded with its current floors. */
  editPostEditElevator: (id: string, origin: PostEditEndpoint) => void;
  /** Entry point of the move and settings tools (GitHub issue #748) for one cell: lists the cell's
   *  elements relevant to `purpose` across every node of a split tile. 0 is a no-op, exactly 1 is
   *  acted on directly, more than 1 opens `postEditEntityPickPrompt`. */
  requestPostEditEntityPick: (point: [number, number], level: number | undefined, purpose: EntityToolPurpose) => void;
  /** Acts on the element picked in `PostEditEntityPickDialog` and closes the prompt. */
  choosePostEditEntityPick: (descriptor: PostEditPointEntityDescriptor) => void;
  cancelPostEditEntityPick: () => void;
  /** Returns and clears `postEditMoveRequest`. */
  takePostEditMoveRequest: () => PostEditPointEntityDescriptor | null;
  /** Opens the settings surface of one element: the connection dialog, the elevator floor dialog,
   *  or the split-node panel. Other kinds have no settings and are ignored. */
  openPostEditEntitySettings: (descriptor: PostEditPointEntityDescriptor) => void;
  cancelPostEditConnectionSettings: () => void;
  togglePostEditElevatorFloor: (floorIndex: number) => void;
  confirmPostEditElevatorPlacement: () => void;
  cancelPostEditElevatorPlacement: () => void;
  removePostEditElevator: (id: string) => void;
  /** Moves EVERY floor endpoint of the elevator so the dragged floor's endpoint lands on `endpoint`
   *  (GitHub issue #566) — see `movePostEditElevatorEndpoint` (postEditVerticalUtils.ts)'s own doc
   *  comment. `level` is the dragged marker's own floor. Sets `postEditDragFailureMessage` and
   *  leaves `postEditDraftElevators` unchanged when one of the OTHER floors has no node there.
   *  `otherEndpoints` (GitHub issue #567) are the user's own `PostEditSplitTargetDialog` picks for
   *  whichever OTHER floors ALSO turned out split, one `{ level, endpoint }` per such floor —
   *  omitted (or a floor left out of it) falls back to the plain `findNodeAt` resolution
   *  `resolveElevatorMove` always used before this issue. */
  movePostEditElevatorEndpoint: (id: string, level: number, endpoint: PostEditEndpoint, otherEndpoints?: { level: number; endpoint: PostEditEndpoint }[]) => void;
  /** Closes the drag-failure `AlertModal` rendered in `PostEditFeature` (its own OK button). */
  dismissPostEditDragFailureMessage: () => void;
  /** Opens the "which split node?" prompt (GitHub issue #474). Called by `PostEditController` when
   * a vertex tool is used on a split point instead of dispatching the tool directly. */
  requestPostEditSplitTarget: (prompt: NonNullable<PostEditState["postEditSplitTargetPrompt"]>) => void;
  /** Resolves an open `postEditSplitTargetPrompt` against the picked node id. For a plain
   * placement action (start/finish, vertical passage, elevator, teleport) dispatches the deferred
   * tool to that node directly, same as before GitHub issue #567. For a `move_*` action (a drag
   * landing on a split tile), appends the resolved endpoint to `picks`; if `queue` still has more
   * points to ask about, shifts the next one in and re-opens the dialog for it (the prompt stays
   * open, `PostEditSplitTargetDialog` just re-renders for the new point) — once `queue` is empty,
   * dispatches the deferred move (`movePostEditTeleportEndpoint`/`movePostEditVerticalPassageEndpoint`/
   * `movePostEditElevatorEndpoint`) with every picked endpoint and clears the prompt. No-op if no
   * prompt is open. */
  applyPostEditSplitTargetPick: (nodeId: number) => void;
  /** Dismisses an open `postEditSplitTargetPrompt` without placing anything. */
  cancelPostEditSplitTarget: () => void;
  /** Opens/closes the "Changes" panel (GitHub issue #545). Independent of `postEditFocusedPoint`'s
   *  "Manage split nodes" panel — see `postEditChangesOpen`'s doc comment. */
  setPostEditChangesOpen: (open: boolean) => void;
  /** Sets/clears the "Changes" panel's entity-id filter (GitHub issue #574). `null` clears it back
   *  to the full log — same effect as the panel's own clear (×) button. */
  setPostEditChangesEntityFilter: (id: string | null) => void;
  /** Sets/clears the live drag preview (GitHub issue #545) — see `postEditDragOverride`'s doc
   *  comment. Pure visual state, never touches the command log. */
  setPostEditDragOverride: (override: PostEditDragOverride | null) => void;
}
