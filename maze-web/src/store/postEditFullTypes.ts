import type { NodeDto, EdgeDto } from "../wasm/types";
import type { PostEditEndpoint, PostEditHoveredEntity } from "../pixi/postEditEndpoint";
import type { SplitNodeBlueprint } from "../pixi/splitBlueprints";
import type { PostEditCommand } from "./postEditCommandTypes";
import type { PostEditBaseline, PostEditDerivedState } from "../pixi/postEditReplay";
import type {
  PostEditTool,
  PostEditEdge,
  PostEditMeta,
  PostEditTeleportDirection,
  PostEditTeleportEntry,
  PostEditVerticalPassageEntry,
  PostEditElevatorEntry,
  PostEditAnalytics,
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
  setHoveredIssueLoopEdges: (edges: IssueHighlightEdge[] | null) => void;
  setHoveredIssueRegionGroups: (groups: number[][] | null) => void;
  setAnalyticsSectionExpanded: (id: string, expanded: boolean) => void;
  setShowFullyPresetLockedIssues: (v: boolean) => void;
}

export interface PostEditState {
  postEditAutoConfirm: boolean;
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
  _nextPostEditOneWayId: number;
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
   * prompt is open. Never persisted (ephemeral placement state). */
  postEditSplitTargetPrompt:
    | {
        point: [number, number];
        level?: number;
        nodeIds: number[];
        action:
          | { tool: "set_start" | "set_finish" }
          | { tool: "vertical_passage_one_way" | "vertical_passage_two_way" }
          | { tool: "elevator" }
          | { tool: "teleport_one_way" | "teleport_two_way" };
      }
    | null;
  /** Whether the "Changes" panel (GitHub issue #545) — the post-edit command log listing — is
   *  open. Own toggle-driven `SidePanel`, independent of `postEditFocusedPoint`'s "Manage split
   *  nodes" panel (the two never open at once — `setPostEditChangesOpen(true)` closes the split-
   *  node panel and vice versa, since both dock to the same `SidePanel` slot). Not persisted. */
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
}

/** See `PostEditState.postEditDragOverride`. Each variant names the entity being dragged and its
 *  current (possibly still-unconfirmed) target endpoint — `PostEditRenderer` substitutes this for
 *  the entity's real endpoint while the drag is live. */
export type PostEditDragOverride =
  | { kind: "marker"; marker: "start" | "finish"; endpoint: PostEditEndpoint }
  | { kind: "teleportEndpoint"; id: string; end: "from" | "to"; endpoint: PostEditEndpoint }
  | { kind: "verticalPassageEndpoint"; id: string; end: "from" | "to"; endpoint: PostEditEndpoint };

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
  cyclePostEditTeleportDirection: (id: string) => void;
  removePostEditTeleport: (id: string) => void;
  movePostEditTeleportEndpoint: (id: string, end: "from" | "to", endpoint: PostEditEndpoint) => void;
  confirmPostEdit: () => Promise<void>;
  resetPostEdit: () => void;
  /** Cell branch of the unified Reset tool (GitHub issue #327) — resets one point's
   * edges/teleports/split-slots/start-finish back to generation-time state. See
   * `resetPostEditPoint` (postEditUtils.ts). */
  resetPostEditPoint: (point: [number, number]) => void;
  /** Delete tool (GitHub issue #386) — removes every generation-placed non-edge piece of content
   * touching `point`'s nodes: start/finish marker, teleport links, vertical passages, elevators.
   * Basic edges are untouched (see `wall`/`reset`). See `deletePostEditPoint`'s own doc comment in
   * `postEditSlice.ts` for details. */
  deletePostEditPoint: (point: [number, number]) => void;
  addSplitNode: (point: [number, number]) => void;
  removeSplitNode: (point: [number, number], slotId: number) => void;
  cycleActiveSplitNode: (point: [number, number]) => void;
  setActiveSplitNode: (point: [number, number], endpoint: PostEditEndpoint) => void;
  setPostEditFocusedPoint: (point: [number, number] | null) => void;
  setPostEditHoveredEntity: (entity: PostEditHoveredEntity | null) => void;
  /** Rotates every geometric-face connection of `point`'s nodes (original + every declared slot)
   * by one offset index — see `rotateSplitPointMoves` (postEditUtils.ts). No-op if it would
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
  cyclePostEditVerticalPassageDirection: (id: string) => void;
  removePostEditVerticalPassage: (id: string) => void;
  movePostEditVerticalPassageEndpoint: (id: string, end: "from" | "to", endpoint: PostEditEndpoint) => void;
  startPostEditElevatorPlacement: (origin: PostEditEndpoint) => void;
  togglePostEditElevatorFloor: (floorIndex: number) => void;
  confirmPostEditElevatorPlacement: () => void;
  cancelPostEditElevatorPlacement: () => void;
  removePostEditElevator: (id: string) => void;
  /** Opens the "which split node?" prompt (GitHub issue #474). Called by `PostEditController` when
   * a vertex tool is used on a split point instead of dispatching the tool directly. */
  requestPostEditSplitTarget: (prompt: NonNullable<PostEditState["postEditSplitTargetPrompt"]>) => void;
  /** Resolves an open `postEditSplitTargetPrompt` against the picked node id, dispatching the
   * deferred vertex tool (start/finish, vertical passage, elevator, teleport) to that node.
   * No-op if no prompt is open. */
  applyPostEditSplitTargetPick: (nodeId: number) => void;
  /** Dismisses an open `postEditSplitTargetPrompt` without placing anything. */
  cancelPostEditSplitTarget: () => void;
  /** Opens/closes the "Changes" panel (GitHub issue #545). Opening it closes the "Manage split
   *  nodes" panel (`postEditFocusedPoint`), since both dock to the same `SidePanel` slot. */
  setPostEditChangesOpen: (open: boolean) => void;
  /** Sets/clears the "Changes" panel's entity-id filter (GitHub issue #574). `null` clears it back
   *  to the full log — same effect as the panel's own clear (×) button. */
  setPostEditChangesEntityFilter: (id: string | null) => void;
  /** Sets/clears the live drag preview (GitHub issue #545) — see `postEditDragOverride`'s doc
   *  comment. Pure visual state, never touches the command log. */
  setPostEditDragOverride: (override: PostEditDragOverride | null) => void;
}
