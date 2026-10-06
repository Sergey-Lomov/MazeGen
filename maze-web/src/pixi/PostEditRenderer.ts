import { Container, Graphics } from "pixi.js";
import { useMazeStore } from "../store/mazeStore";

import type { FieldEdge } from "./fieldEditUtils";
import { CellFillRenderer } from "./renderers/CellFillRenderer";
import { WallRenderer } from "./renderers/WallRenderer";
import { WaypointsRenderer } from "./renderers/WaypointsRenderer";
import { TeleportRenderer } from "./renderers/TeleportRenderer";
import { drawTeleportPreview } from "./renderers/teleportPreviewGlyph";
import { GridRenderer } from "./renderers/GridRenderer";
import { EdgeHighlightRenderer } from "./renderers/EdgeHighlightRenderer";
import { NodeEdgeHighlightRenderer } from "./renderers/NodeEdgeHighlightRenderer";
import { RegionHighlightRenderer } from "./renderers/RegionHighlightRenderer";
import { SplitJunctionRenderer, collectSplitWallPaths } from "./renderers/SplitJunctionRenderer";
import { VerticalConnectionRenderer, DEFAULT_VERTICAL_STYLE } from "./renderers/VerticalConnectionRenderer";
import { IssueHighlightOverlay } from "./IssueHighlightOverlay";
import { buildMazeWalls, buildMazeMarkers, buildTeleportEdges, buildTeleportFloorInputs, postEditEdgesToDto, buildClosedCells, buildSplitPassages, buildHoveredEntityHighlight, selectFloorScopedMaze, selectNodeLevelResolver, selectVerticalPassagePairSet, buildVerticalConnectionMarkers, buildTeleportAvoidanceWaypoints } from "./selectors/mazeSelectors";
import { postEditTeleportsToDto, floorScopedTeleportEdges, postEditVerticalToDto, pruneRemovedSplitNodes } from "./postEditUtils";
import { buildHoverEdgeHighlight } from "./selectors/presetSelectors";
import { canvas } from "./colorTokens";
import { WALL_THICKNESS } from "./renderConstants";
import type { NodeDto } from "../wasm/types";
import type { PostEditEdge, PostEditMeta, PostEditTeleportEntry, PostEditVerticalPassageEntry, PostEditElevatorEntry } from "../store/mazeStore";
import { BaseFieldRenderer } from "./BaseFieldRenderer";
import { BackgroundImageHost, backgroundImageChanged } from "./BackgroundImageLayer";
import { type PostEditEndpoint, resolveEndpoint, buildSplitNodeResolver, floorScopedEndpoint } from "./postEditEndpoint";
import { recordOnLevel } from "./fieldEditUtils";
import { activeFloorLevel } from "../store/storeHelpers";
import { DEFAULT_MAZE_RENDER_STYLE } from "./defaultMazeRenderStyle";
import { drawCellBoundaryHighlight, oneWayIndicatorSpan, WALL_HIGHLIGHT_SPAN } from "./renderers/wallUtils";
import { getCellHighlightInset } from "./cellHighlightGeometry";
import { emptyPostEditHoverState, shouldClearPostEditHover, type PostEditHoverState } from "./postEditHoverState";

type MazeState = ReturnType<typeof useMazeStore.getState>;

export class PostEditRenderer extends BaseFieldRenderer {
  private readonly root: Container;

  private readonly gridContainer: Container;
  private readonly floorContainer: Container;
  private readonly backgroundImageContainer: Container;
  private readonly closedCellsContainer: Container;
  private readonly wallsContainer: Container;
  private readonly teleportContainer: Container;
  private readonly verticalContainer: Container;
  private readonly markersContainer: Container;
  private readonly hoverContainer: Container;
  private readonly cellHoverContainer: Container;
  private readonly splitPanelTargetContainer: Container;
  private readonly teleportPreviewContainer: Container;
  private readonly splitJunctionContainer: Container;
  private readonly linkHoverContainer: Container;
  private readonly entityHighlightContainer: Container;
  private readonly issueHighlightContainer: Container;

  private readonly grid: GridRenderer;
  private readonly floor: CellFillRenderer;
  private readonly backgroundImage: BackgroundImageHost;
  private readonly closedCells: CellFillRenderer;
  private readonly walls: WallRenderer;
  private readonly teleports: TeleportRenderer;
  private readonly verticalConnections: VerticalConnectionRenderer;
  private readonly markers: WaypointsRenderer;
  private readonly hover: EdgeHighlightRenderer;
  private readonly cellHover: CellFillRenderer;
  private readonly splitPanelTarget: CellFillRenderer;
  private readonly teleportPreview: Graphics;
  private readonly splitJunctions: SplitJunctionRenderer;
  /** Highlights the entity a "Manage split nodes" or "Changes" panel bubble is currently hovered
   *  (GitHub issues #237/#546) — driven by `postEditHoveredEntity`, a separate layer/container
   *  from `hover` (that one is driven by canvas pointermove instead, via `updateHover`) so the two
   *  never fight over the same `Graphics` object. `linkHover` draws a `link`-kind entity (straight
   *  line + circle markers on each end, node center to node center — same `NodeEdgeHighlightRenderer`
   *  primitive `DebugRefHighlightOverlay` uses for its edge-ref highlight, since a teleport link has
   *  no shared face at all to draw on); `entityHighlight` draws a `point`/`points`-kind entity as a
   *  cell fill (`RegionHighlightRenderer`, same primitive `DebugRefHighlightOverlay` uses for a
   *  `node` ref, treating a single point as a one-element region). Exactly one of the two ever has
   *  content at a time. */
  private readonly linkHover: NodeEdgeHighlightRenderer;
  private readonly boundaryHover: Graphics;
  private readonly entityHighlight: RegionHighlightRenderer;
  /** Highlights a hovered `IssueBubble`'s flagged cells/edges/regions in the post-edit canvas —
   *  own instance, not shared with `AnalyticsRenderer`'s (feature-renderer ownership rule,
   *  `maze-web/CLAUDE.md`). `IssuesBlock`/`IssueBubble` drive both from the same store fields
   *  (`hoveredIssueLoopEdges`/`hoveredIssueRegionGroups`), so no post-edit-specific wiring needed
   *  beyond owning this instance and re-rendering it on the same triggers as everything else. */
  private readonly issueHighlight: IssueHighlightOverlay;

  // Store the pointer hover independently from the PIXI display objects. `redrawAll` rebuilds
  // those objects after every post-edit command; retaining the input lets the same hover survive
  // a Reset/Delete click without requiring another pointermove (GitHub issue #592).
  private hoverState: PostEditHoverState = emptyPostEditHoverState();

  constructor(container: Container) {
    super();
    this.root = container;

    this.gridContainer        = new Container();
    this.floorContainer       = new Container();
    this.backgroundImageContainer = new Container();
    this.closedCellsContainer = new Container();
    this.wallsContainer       = new Container();
    this.teleportContainer    = new Container();
    this.verticalContainer    = new Container();
    this.markersContainer     = new Container();
    this.hoverContainer       = new Container();
    this.splitPanelTargetContainer = new Container();

    this.root.addChild(this.backgroundImageContainer);
    this.root.addChild(this.gridContainer);
    this.root.addChild(this.floorContainer);
    this.root.addChild(this.closedCellsContainer);
    this.root.addChild(this.wallsContainer);
    this.splitJunctionContainer = new Container();
    this.root.addChild(this.splitJunctionContainer);
    this.root.addChild(this.teleportContainer);
    this.root.addChild(this.verticalContainer);
    this.root.addChild(this.markersContainer);
    this.root.addChild(this.hoverContainer);
    this.cellHoverContainer = new Container();
    this.root.addChild(this.cellHoverContainer);
    this.root.addChild(this.splitPanelTargetContainer);
    this.teleportPreviewContainer = new Container();
    this.root.addChild(this.teleportPreviewContainer);
    this.linkHoverContainer = new Container();
    this.root.addChild(this.linkHoverContainer);
    this.entityHighlightContainer = new Container();
    this.root.addChild(this.entityHighlightContainer);
    this.issueHighlightContainer = new Container();
    this.root.addChild(this.issueHighlightContainer);

    this.grid        = new GridRenderer(this.gridContainer);
    this.floor       = new CellFillRenderer(this.floorContainer);
    this.backgroundImage = new BackgroundImageHost({
      image: this.backgroundImageContainer,
      floor: this.floorContainer,
      grid: this.gridContainer,
      layerAnchor: this.closedCellsContainer,
    });
    this.closedCells = new CellFillRenderer(this.closedCellsContainer);
    this.walls       = new WallRenderer(this.wallsContainer);
    this.splitJunctions = new SplitJunctionRenderer(this.splitJunctionContainer);
    this.teleports   = new TeleportRenderer(this.teleportContainer);
    this.verticalConnections = new VerticalConnectionRenderer(this.verticalContainer);
    this.markers     = new WaypointsRenderer(this.markersContainer);
    this.hover       = new EdgeHighlightRenderer(this.hoverContainer);
    this.cellHover   = new CellFillRenderer(this.cellHoverContainer);
    this.splitPanelTarget = new CellFillRenderer(this.splitPanelTargetContainer);
    this.teleportPreview = new Graphics();
    this.teleportPreviewContainer.addChild(this.teleportPreview);
    this.linkHover   = new NodeEdgeHighlightRenderer(this.linkHoverContainer);
    this.boundaryHover = new Graphics();
    this.linkHoverContainer.addChild(this.boundaryHover);
    this.entityHighlight = new RegionHighlightRenderer(this.entityHighlightContainer);
    this.issueHighlight = new IssueHighlightOverlay(this.issueHighlightContainer);

    this.root.visible = false;

    this.subscribeToStore();
  }

  protected isCardOpen(state: MazeState): boolean {
    return state.openCard === "post_edit";
  }

  protected getActiveConfig(state: MazeState) {
    return state.floorFields[state.activeFloorId].tessellationConfig;
  }

  protected setRootVisible(visible: boolean): void {
    this.root.visible = visible;
  }

  onViewportChanged(x: number, y: number, w: number, h: number, scale: number): void {
    this.updateViewport(x, y, w, h, scale);
    if (useMazeStore.getState().openCard === "post_edit" && this.cfg) {
      this.grid.render({ viewport: this.viewport }, this.cfg);
    }
  }

  /** `danger` (GitHub issue #327's unified Reset tool) swaps the highlight to
   * `canvas.fieldEditor.danger` (red) instead of the ordinary hover color — signals a destructive
   * tool the same way the Management section's red Reset button does. */
  updateHover(edge: FieldEdge | null, danger = false): void {
    this.hoverState.edge = edge;
    this.hoverState.edgeDanger = danger;
    if (!this.cfg) return;
    const highlights = buildHoverEdgeHighlight(edge, this.cfg, danger ? canvas.fieldEditor.danger : undefined);
    this.hover.render({ highlights });
  }

  /** Highlights a single cell (not a wall/edge) — used while the `manage_split_nodes` tool is
   * active, since that tool targets a whole point rather than one of its faces (GitHub issue
   * #221's follow-up: highlighting a wall there was misleading about what a click would do).
   * `danger` — see `updateHover`'s doc comment. */
  updateCellHover(cell: [number, number] | null, danger = false): void {
    this.hoverState.cell = cell;
    this.hoverState.cellDanger = danger;
    if (!this.cfg) return;
    this.cellHover.render({ cells: cell ? [cell] : [], color: danger ? canvas.fieldEditor.danger : canvas.fieldEditor.hover, alpha: 0.35 }, this.cfg);
  }

  /** Renders the pending teleport's fixed endpoint marker + a connector line to the cursor, so the
   * two-click placement gesture reads as "one end is already fixed, aim the other". `pendingFrom` is
   * already in viewport coordinates (the caller resolves node → screen). Shared look with the preset
   * card via `drawTeleportPreview`. */
  updateTeleportPreview(pendingFrom: { x: number; y: number } | null, cursorViewportX: number, cursorViewportY: number): void {
    this.teleportPreview.clear();
    if (!pendingFrom) return;

    drawTeleportPreview(this.teleportPreview, pendingFrom.x, pendingFrom.y, cursorViewportX, cursorViewportY);
  }

  protected onStoreChange(state: MazeState, prev: MazeState): void {
    if (backgroundImageChanged(state, prev)) {
      this.backgroundImage.render(state);
    }

    if (
      state.postEditDraftEdges !== prev.postEditDraftEdges ||
      state.postEditDraftTeleports !== prev.postEditDraftTeleports ||
      state.postEditDraftVerticalPassages !== prev.postEditDraftVerticalPassages ||
      state.postEditDraftElevators !== prev.postEditDraftElevators ||
      state.postEditDragOverride !== prev.postEditDragOverride ||
      state.nodes !== prev.nodes ||
      state.edges !== prev.edges ||
      state.postEditDraftMeta !== prev.postEditDraftMeta ||
      state.postEditDraftSplitPoints !== prev.postEditDraftSplitPoints ||
      state.postEditActiveSplitNode !== prev.postEditActiveSplitNode ||
      state.postEditFocusedPoint !== prev.postEditFocusedPoint ||
      state.postEditFocusedPointCovered !== prev.postEditFocusedPointCovered ||
      state.activeFloorId !== prev.activeFloorId ||
      state.postEditTool !== prev.postEditTool
    ) {
      const clearsHover = shouldClearPostEditHover(state, prev);
      // A changed tool or floor invalidates the old hit target. Draft edits redraw the derived
      // graph under the cursor, so keep the hover for issue #592.
      if (clearsHover) this.hoverState = emptyPostEditHoverState();
      this.redrawAll(state);
    } else if (state.postEditHoveredEntity !== prev.postEditHoveredEntity) {
      this.redrawHoveredEntity(state);
    }

    if (
      state.hoveredIssueLoopEdges !== prev.hoveredIssueLoopEdges ||
      state.hoveredIssueRegionGroups !== prev.hoveredIssueRegionGroups ||
      state.nodes !== prev.nodes ||
      state.activeFloorId !== prev.activeFloorId
    ) {
      this.redrawIssueHighlight(state);
    }

    if (state.postEditTool !== prev.postEditTool || state.postEditTeleportPendingFrom !== prev.postEditTeleportPendingFrom) {
      if (state.postEditTeleportPendingFrom === null) this.teleportPreview.clear();
    }
  }

  /** Floor-scopes every post-edit piece of state (GitHub issue #358) — `state.nodes`/`state.edges`
   * and `postEditDraftEdges`/`postEditDraftTeleports`/`postEditDraftSplitPoints`/
   * `postEditActiveSplitNode` are all one flat, maze-wide collection now (mirroring preset
   * connections, GitHub issue #340), but every selector below (`buildMazeWalls`,
   * `buildSplitPassages`, etc.) is still level-agnostic and expects single-floor-shaped data — a
   * same-(x,y) node/split point on another floor would otherwise be drawn on top of the active
   * floor's own. */
  /** Substitutes `state.postEditDragOverride`'s live drag target into whichever one of
   *  `postEditDraftMeta`/`postEditDraftTeleports`/`postEditDraftVerticalPassages` it names (GitHub
   *  issue #545) — the other two pass through unchanged. Purely a rendering-time overlay: the
   *  underlying store fields (and the command log behind them) are untouched, so every other
   *  reader of `state` still sees the pre-drag values. Called once per `redrawAll`, its result fed
   *  wherever those three fields would otherwise be read from `state` directly. */
  private dragOverrideFields(state: MazeState): {
    postEditDraftMeta: PostEditMeta | null;
    postEditDraftTeleports: PostEditTeleportEntry[];
    postEditDraftVerticalPassages: PostEditVerticalPassageEntry[];
    postEditDraftElevators: PostEditElevatorEntry[];
  } {
    const override = state.postEditDragOverride;
    if (override === null) {
      return {
        postEditDraftMeta: state.postEditDraftMeta,
        postEditDraftTeleports: state.postEditDraftTeleports,
        postEditDraftVerticalPassages: state.postEditDraftVerticalPassages,
        postEditDraftElevators: state.postEditDraftElevators,
      };
    }
    if (override.kind === "marker") {
      return {
        postEditDraftMeta: { ...(state.postEditDraftMeta ?? { start: null, finish: null }), [override.marker]: override.endpoint },
        postEditDraftTeleports: state.postEditDraftTeleports,
        postEditDraftVerticalPassages: state.postEditDraftVerticalPassages,
        postEditDraftElevators: state.postEditDraftElevators,
      };
    }
    if (override.kind === "teleportEndpoint") {
      return {
        postEditDraftMeta: state.postEditDraftMeta,
        postEditDraftTeleports: state.postEditDraftTeleports.map((t) =>
          t.id === override.id ? { ...t, [override.end]: override.endpoint } : t),
        postEditDraftVerticalPassages: state.postEditDraftVerticalPassages,
        postEditDraftElevators: state.postEditDraftElevators,
      };
    }
    if (override.kind === "verticalPassageEndpoint") {
      return {
        postEditDraftMeta: state.postEditDraftMeta,
        postEditDraftTeleports: state.postEditDraftTeleports,
        postEditDraftVerticalPassages: state.postEditDraftVerticalPassages.map((p) =>
          p.id === override.id ? { ...p, [override.end]: override.endpoint } : p),
        postEditDraftElevators: state.postEditDraftElevators,
      };
    }
    return {
      postEditDraftMeta: state.postEditDraftMeta,
      postEditDraftTeleports: state.postEditDraftTeleports,
      postEditDraftVerticalPassages: state.postEditDraftVerticalPassages,
      postEditDraftElevators: state.postEditDraftElevators.map((e) => {
        if (e.id !== override.id) return e;
        const resolveNodeLevel = selectNodeLevelResolver(state.nodes);
        return {
          ...e,
          floors: e.floors.map((f) => (f.kind === "node" && (resolveNodeLevel(f.id) ?? 0) === override.level ? override.endpoint : f)),
        };
      }),
    };
  }

  private floorScoped(state: MazeState) {
    const level = activeFloorLevel(state);
    const { postEditDraftMeta: overrideMeta, postEditDraftTeleports: overrideTeleports } = this.dragOverrideFields(state);
    const { nodes: floorNodes, edges, start, finish } = selectFloorScopedMaze(state.nodes, state.edges, state.floors, state.activeFloorId, state.start, state.finish);
    const postEditDraftSplitPoints = recordOnLevel(state.postEditDraftSplitPoints, level);
    const nodes = pruneRemovedSplitNodes(floorNodes, postEditDraftSplitPoints);
    const floorNodeIds = new Set(nodes.map((n) => n.id));
    // `floorScopedEndpoint` (checks on-level, then strips `level`) — `postEditDraftSplitPoints`/
    // `postEditActiveSplitNode` above are already `recordOnLevel`'d down to bare `"x,y"` keys, so
    // an endpoint resolved through them must not still carry its original non-zero `level` (that
    // would send `resolveSplit` looking for a `"x,y@level"` key that no longer exists in the
    // scoped map, silently failing to resolve every split reference on any floor above the first —
    // GitHub issue #425).
    const onLevel = (ep: PostEditEndpoint) => floorScopedEndpoint(ep, level, floorNodeIds);
    const postEditDraftEdges: Record<string, PostEditEdge> | null = state.postEditDraftEdges === null ? null : Object.fromEntries(
      Object.entries(state.postEditDraftEdges)
        .map(([k, e]) => {
          const from = onLevel(e.from);
          const to = onLevel(e.to);
          return from !== undefined && to !== undefined ? [k, { ...e, from, to }] as const : null;
        })
        .filter((entry): entry is readonly [string, PostEditEdge] => entry !== null),
    );
    // Kept whenever *either* endpoint is on the active floor (mirrors `selectFloorScopedMaze`'s own
    // "keeps an edge whenever `from` is on the active floor" convention for cross-floor kinds) — a
    // cross-floor teleport must stay visible/editable from both of its ends, not just the one that
    // happened to be `from` at creation time. Requiring *both* ends on-level (the pre-fix behavior)
    // made a cross-floor teleport vanish from every floor's own draft entirely. Only the on-level
    // endpoint is stripped of its `level` (see above) — an off-floor endpoint is left untouched, so
    // it still fails the scoped resolver and is silently dropped, same as before this fix.
    const postEditDraftTeleports: PostEditTeleportEntry[] = overrideTeleports
      .map((t) => {
        const from = onLevel(t.from);
        const to = onLevel(t.to);
        return from !== undefined || to !== undefined ? { ...t, from: from ?? t.from, to: to ?? t.to } : null;
      })
      .filter((t): t is PostEditTeleportEntry => t !== null);
    const postEditActiveSplitNode = recordOnLevel(state.postEditActiveSplitNode, level);
    const postEditDraftMeta = overrideMeta === null ? null : {
      start: overrideMeta.start !== null ? onLevel(overrideMeta.start) ?? null : null,
      finish: overrideMeta.finish !== null ? onLevel(overrideMeta.finish) ?? null : null,
    };
    return { nodes, edges, start, finish, postEditDraftEdges, postEditDraftTeleports, postEditDraftSplitPoints, postEditActiveSplitNode, postEditDraftMeta };
  }

  private redrawIssueHighlight(state: MazeState): void {
    if (!this.cfg) return;
    const { nodes, edges } = this.floorScoped(state);
    const resolveNodeLevel = selectNodeLevelResolver(state.nodes);
    const unscopedNodeById = new Map(state.nodes.map((n) => [n.id, n]));
    const resolveNodeCell = (id: number): [number, number] | undefined => {
      const n = unscopedNodeById.get(id);
      return n ? [n.x, n.y] : undefined;
    };
    const activeFloorIndex = Math.max(state.floors.findIndex((f) => f.id === state.activeFloorId), 0);
    // Same one-way detection the Analytics overlay uses — built from the *unscoped* confirmed
    // `state.edges` (a two-way connection's reverse edge lives on the other floor, GitHub issue
    // #337/#347). Uncommitted post-edit draft changes to a cross-floor connection aren't reflected
    // here; the hovered-issue highlight is a read-only locator, not a live edit preview.
    const crossFloorEdgeKeys = new Set(
      state.edges.filter((e) => e.kind !== "basic").map((e) => `${e.from}->${e.to}`),
    );
    this.issueHighlight.render({
      nodes,
      edges: state.hoveredIssueLoopEdges,
      allEdges: edges,
      regionGroups: state.hoveredIssueRegionGroups,
      cfg: this.cfg,
      resolveNodeLevel,
      resolveNodeCell,
      activeFloorIndex,
      crossFloorEdgeKeys,
      oneWayBoundaryWidth: oneWayIndicatorSpan(DEFAULT_MAZE_RENDER_STYLE.oneWay),
    });
  }

  /** Matches against the *unscoped* `state.nodes`, not `floorScoped(state).nodes` — a cross-floor
   *  link/points entity (a vertical passage/elevator/teleport, GitHub issue #546 follow-up) has
   *  endpoints on different floors, and a floor-scoped list only ever contains the active floor's
   *  own nodes, so the other endpoint could never be found there regardless of the fallback
   *  `buildLinkHoverHighlight`/`resolvePointGroups` provide for "this endpoint isn't on this floor".
   *  Safe to match unscoped: `pointMatchesNode` already checks each point's own `level` against the
   *  candidate node's `level` explicitly, so a match is never on the wrong floor even though the
   *  candidate list itself now spans every floor. `activeFloorLevel(state) ?? 0` (0-based, matching
   *  `NodeDto.level`'s own "undefined = floor 0" convention) then gates what actually draws: without
   *  it, a vertical passage/elevator (whose endpoints share one `(x, y)`, differing only in level)
   *  would resolve on every one of its floors at once and draw on top of each other regardless of
   *  which floor is active (GitHub issue #546 follow-up: "не подсвечиваем пустое место"). */
  private redrawHoveredEntity(state: MazeState): void {
    if (!this.cfg) return;
    const activeLevel = activeFloorLevel(state) ?? 0;
    const { link, regionGroups, boundaryLinks } = buildHoveredEntityHighlight(state.postEditHoveredEntity, state.nodes, activeLevel, this.cfg);
    this.linkHover.render(link);
    this.boundaryHover.clear();
    for (const boundary of boundaryLinks ?? []) {
      const color = state.postEditHoveredEntity?.danger
        ? canvas.fieldEditor.danger
        : boundary.style === "one_way" ? canvas.debug.refHighlight : canvas.fieldEditor.hover;
      const span = boundary.style === "one_way"
        ? oneWayIndicatorSpan(DEFAULT_MAZE_RENDER_STYLE.oneWay)
        : WALL_HIGHLIGHT_SPAN;
      drawCellBoundaryHighlight(this.boundaryHover, boundary.from.point, boundary.to.point, this.cfg, color, 0.25, WALL_THICKNESS, span, getCellHighlightInset());
    }
    this.entityHighlight.render({
      nodes: state.nodes, regionGroups, color: state.postEditHoveredEntity?.danger ? canvas.fieldEditor.danger : canvas.fieldEditor.hover, width: WALL_THICKNESS * 2, alpha: 1.0, cfg: this.cfg, skipPerimeter: true,
      insetMode: state.postEditHoveredEntity?.highlightMode ?? "inset",
    });
  }

  protected redrawAll(state: MazeState): void {
    if (!this.cfg) return;
    const cfg = this.cfg;

    this.grid.render({ viewport: this.viewport }, cfg);

    const { nodes, postEditDraftEdges, postEditDraftMeta, postEditDraftSplitPoints, postEditActiveSplitNode } = this.floorScoped(state);
    const { postEditDraftTeleports: overrideTeleportsUnscoped, postEditDraftVerticalPassages: overrideVerticalPassages, postEditDraftElevators: overrideElevators } = this.dragOverrideFields(state);

    // Resolves `split` endpoints from the latest confirmed node snapshot — a draft reference to
    // a split node not yet confirmed simply doesn't resolve, and is dropped from what's drawn
    // (see postEditEndpoint.ts's doc comment on the unresolved-endpoint contract).
    const pointNodeMap = new Map<string, number[]>();
    for (const nd of nodes) {
      const k = `${nd.x},${nd.y}`;
      const list = pointNodeMap.get(k);
      if (list) list.push(nd.id); else pointNodeMap.set(k, [nd.id]);
    }
    const resolveSplit = buildSplitNodeResolver(pointNodeMap, postEditDraftSplitPoints);

    const start = postEditDraftMeta?.start != null ? resolveEndpoint(postEditDraftMeta.start, resolveSplit) ?? null : null;
    const finish = postEditDraftMeta?.finish != null ? resolveEndpoint(postEditDraftMeta.finish, resolveSplit) ?? null : null;
    // Teleports resolve against the *unscoped* (all-floor) split map, then keep only the entries
    // whose `from` lands on this floor — mirroring `draftVerticalEdges`/`floorScopedVerticalEdges`
    // below. Resolving `postEditDraftTeleports` (floor-scoped, `resolveSplit`) directly would drop
    // a cross-floor teleport's departure-side edge entirely whenever its `to` end is itself an
    // ADDITIONAL split slot on the other floor (so it never resolves against this floor's bare
    // `pointNodeMap`), even though the departure end resolves fine — `postEditTeleportsToDto` drops
    // a whole entry (both directions of a two-way one) once either endpoint fails to resolve. That
    // silently left only the arrival-only cross-floor pass below to draw *both* ends of the pair as
    // an "exit" badge with an arrow, instead of one real departure marker plus one arrival badge.
    const unscopedResolveSplit = buildSplitNodeResolver(buildMultiFloorPointNodeMap(state.nodes), state.postEditDraftSplitPoints);
    const floorNodeIds = new Set(nodes.map((n) => n.id));
    const unscopedTeleportEdges = postEditTeleportsToDto(overrideTeleportsUnscoped, unscopedResolveSplit);
    const activeEdges = [
      ...postEditEdgesToDto(postEditDraftEdges, resolveSplit),
      ...floorScopedTeleportEdges(unscopedTeleportEdges, floorNodeIds),
    ];

    // A split node carrying a start/finish marker or a teleport endpoint always keeps its hub
    // point (see buildSplitPassages's straightening exception) so the marker/teleport line has a
    // single unambiguous point to sit on, rather than an arbitrary spot on a straightened line.
    const specialNodeIds = new Set<number>();
    if (start !== null) specialNodeIds.add(start);
    if (finish !== null) specialNodeIds.add(finish);
    for (const e of activeEdges) {
      if (e.kind === "teleport") { specialNodeIds.add(e.from); specialNodeIds.add(e.to); }
    }

    const cells: [number, number][] = nodes.map(n => [n.x, n.y]);
    this.floor.render({ cells, color: canvas.floor.default, alpha: 1 }, cfg);
    this.backgroundImage.render(state);

    // Split points (GitHub issue #223) render every node's passages at once, as colored lines
    // from a small per-node point to each face it connects across — see `buildSplitPassages`.
    // `postEditActiveSplitNode` still governs which endpoint edge-tool clicks target, but no
    // longer what's drawn; ordinary `buildMazeWalls` skips a split point's own geometric edges
    // entirely, since those are rendered here instead.
    // `allEdges` (GitHub issue #359 follow-up) is required so a cell whose only connection is a
    // vertical passage/elevator (never part of `activeEdges` — see below, these kinds aren't
    // post-edit-editable) isn't mistaken for having no connection at all and rendered as a wall;
    // must be the *unscoped* `state.edges`, not the floor-scoped `edges` above, for the same reason
    // `buildVerticalConnectionMarkers`'s own call below needs `state.edges` — an arrival-only edge's
    // `from` lives on another floor and is missing from any floor-scoped list.
    const closed = buildClosedCells(nodes, activeEdges, state.edges);
    this.closedCells.render({ cells: closed, color: canvas.wall.default, alpha: 1 }, cfg);

    const { passages: splitPassages, wallFaces, specialShapes } = buildSplitPassages(nodes, activeEdges, cfg, specialNodeIds, postEditActiveSplitNode, postEditDraftSplitPoints);

    const wallEdges = buildMazeWalls(nodes, activeEdges, cfg);
    const { paths: extraWalls, noCapPoints } = collectSplitWallPaths(wallFaces, specialShapes);
    this.walls.render({ edges: wallEdges }, cfg, undefined, undefined, extraWalls, noCapPoints);

    this.splitJunctions.render({ passages: splitPassages, wallFaces, specialShapes });

    const nodeById = new Map<number, NodeDto>(nodes.map(n => [n.id, n]));
    // Cross-floor teleports (badge rendering, mirrors `GenerationRenderer`) — `unscopedActiveEdges`
    // resolves post-edit's own *draft* teleports (not `state.edges`, which may be stale/pre-confirm)
    // without the active-floor filter `postEditDraftTeleports` above applies, so the reverse-
    // direction edge of a bidirectional cross-floor pair (its own `from` on the other floor) is
    // available for `byPair`'s bidirectional check the same way `TeleportFloorContext`'s own doc
    // comment requires. Must read `overrideTeleportsUnscoped` (the drag-overridden field), not raw
    // `state.postEditDraftTeleports` — a same-floor drag's in-progress override is already applied
    // by the time it reaches `floorScoped`'s own `postEditDraftTeleports`, so this stale-vs-live
    // mismatch never showed there, but a CROSS-floor drag's badge/blocked-cells context kept reading
    // the pre-drag position from here while `activeEdges` below already drew the live dragged one,
    // rendering both a stale and a live copy for the whole duration of every drag (not just the
    // first one, unlike the vertical-passage confirmed-mirror bug this resembles — there's no
    // confirmed-graph fallback for teleports, this was purely two different reads of the draft
    // disagreeing on which one was current).
    const unscopedActiveEdges = [
      ...postEditEdgesToDto(state.postEditDraftEdges ?? {}, unscopedResolveSplit),
      ...unscopedTeleportEdges,
    ];
    const activeFloorIndex = state.floors.findIndex((f) => f.id === state.activeFloorId);
    const resolveNodeLevel = selectNodeLevelResolver(state.nodes);
    // `unscopedEdges` resolves cross-floor pairs against post-edit's own draft edges; the badge
    // blocked-cells map reads `state.edges` ∪ draft. Draft start/finish (resolved to node ids
    // above), not `state.start`/`.finish` which point at the pre-edit endpoints until confirm.
    const { floorContext: teleportFloorContext, spread: teleportBadgeSpread } = buildTeleportFloorInputs({
      unscopedNodes: state.nodes,
      unscopedEdges: unscopedActiveEdges,
      floors: state.floors,
      activeFloorId: state.activeFloorId,
      start,
      finish,
      blockedCellsEdges: [...state.edges, ...unscopedActiveEdges],
      allowOutOfField: true,
    });
    const teleportEdges = buildTeleportEdges(nodeById, activeEdges, cfg, teleportFloorContext, teleportBadgeSpread);
    const markerData = buildMazeMarkers(nodeById, start, finish, cfg, undefined, undefined, activeEdges);

    // Vertical passages/elevators — generation-time and user-placed ones are both full baseline
    // draft entries now (GitHub issue #564), so `postEditDraftVerticalPassages`/
    // `postEditDraftElevators` is the single source of truth; `state.edges`'s own
    // `vertical_passage`/`elevator` entries are stale mirrors and excluded entirely (no suppression
    // bookkeeping needed — a draft entity always wins). `resolveNodeLevel`/`verticalPairs` still
    // need the *unscoped* node/edge set, same reason `selectVerticalPassagePairSet`'s own doc
    // comment gives (a floor-scoped edge list is missing the reverse-direction edge of a
    // bidirectional passage, whose own `from` lives on the other floor). Must resolve against
    // `unscopedResolveSplit`, not the floor-scoped `resolveSplit` above — a vertical passage/
    // elevator endpoint CAN be `split`-kind now (GitHub issue #567) and, being inherently
    // cross-floor, its `to`/other-floor endpoints routinely address a split point on a DIFFERENT
    // floor than the active one; `resolveSplit`'s `pointNodeMap` only covers the active floor's own
    // nodes, so any such endpoint silently failed to resolve (`resolveEndpoint` → `undefined`),
    // dropping the WHOLE edge out of `draftVerticalEdges` — no marker on either floor, even though
    // the entity round-trips fine through the "Changes"/link-bubble UI (which already reads through
    // an unscoped resolver).
    const draftVerticalEdges = postEditVerticalToDto(overrideVerticalPassages, overrideElevators, unscopedResolveSplit);
    const allVerticalEdges = draftVerticalEdges;
    // Positioning split-node vertical markers also needs the ordinary directed graph edges so
    // bridge/diagonal special shapes can be recognized. Keep the vertical subset above separate
    // for pair/arrival semantics, while feeding the full confirmed + draft graph to the selector.
    const allMarkerEdges = [...allVerticalEdges, ...unscopedActiveEdges];
    const floorScopedVerticalEdges = draftVerticalEdges.filter((e) => {
      const fromNode = nodeById.get(e.from);
      return fromNode !== undefined;
    });
    const verticalConnectionMarkers = buildVerticalConnectionMarkers(
      nodeById, floorScopedVerticalEdges, cfg, resolveNodeLevel, Math.max(activeFloorIndex, 0),
      selectVerticalPassagePairSet(allVerticalEdges), allMarkerEdges,
    );

    // Keep orthogonal teleport connectors from cutting through start/finish markers (GitHub issue
    // #300), same as the image-export renderers — regressed on this canvas (GitHub issue #516).
    // Also avoid vertical passage/elevator markers and one-way wall indicators (GitHub issue #518).
    const teleportWaypoints = buildTeleportAvoidanceWaypoints({
      markers: markerData,
      verticalMarkers: verticalConnectionMarkers,
      oneWayWallEdges: wallEdges,
      cfg,
      splitPassages,
    });
    this.teleports.render({ edges: teleportEdges, cfg, floorNavigable: state.postEditTool !== "reset", waypoints: teleportWaypoints });

    // Click-to-switch-floor (GitHub issue #341 follow-up): withheld while the reset tool is
    // active (its own click means "delete this connection", not "navigate") and, for a one-way
    // passage marker specifically (`filled === false`), while the one-way passage tool is active
    // too (that tool's own click on the marker cycles its direction instead).
    this.verticalConnections.render({
      markers: verticalConnectionMarkers,
      style: DEFAULT_VERTICAL_STYLE,
      interactive: (marker) =>
        state.postEditTool !== "reset" &&
        !(marker.filled === false && state.postEditTool === "vertical_passage_one_way"),
    });

    this.markers.render({ markers: markerData });

    this.hover.render({
      highlights: buildHoverEdgeHighlight(
        this.hoverState.edge,
        cfg,
        this.hoverState.edgeDanger ? canvas.fieldEditor.danger : undefined,
      ),
    });
    this.cellHover.render({
      cells: this.hoverState.cell ? [this.hoverState.cell] : [],
      color: this.hoverState.cellDanger ? canvas.fieldEditor.danger : canvas.fieldEditor.hover,
      alpha: 0.35,
    }, cfg);
    this.splitPanelTarget.render({
      // Hidden while another `SidePanel` covers the "Manage split nodes" dialog (GitHub issue #629
      // follow-up) — the outline would otherwise keep highlighting a cell for a dialog the user can
      // no longer see or act on.
      cells: state.postEditFocusedPoint && !state.postEditFocusedPointCovered ? [state.postEditFocusedPoint] : [],
      color: canvas.fieldEditor.panelTarget,
      alpha: 0,
      inset: 0,
      borderWidth: 3,
    }, cfg);
    this.redrawHoveredEntity(state);
    this.redrawIssueHighlight(state);
  }

  protected clearAll(): void {
    if (!this.cfg) return;
    const cfg = this.cfg;
    this.hoverState = emptyPostEditHoverState();
    this.grid.render({ viewport: { x: 0, y: 0, w: 0, h: 0, scale: 1 } }, cfg);
    this.floor.render({ cells: [], color: canvas.floor.default, alpha: 1 }, cfg);
    this.closedCells.render({ cells: [], color: canvas.wall.default, alpha: 1 }, cfg);
    this.walls.render({ edges: [] }, cfg);
    this.splitJunctions.render({ passages: [], wallFaces: [] });
    this.teleports.render({ edges: [], cfg, waypoints: [] });
    this.verticalConnections.render({ markers: [], style: DEFAULT_VERTICAL_STYLE });
    this.markers.render({ markers: [] });
    this.hover.render({ highlights: [] });
    this.cellHover.render({ cells: [], color: canvas.fieldEditor.hover, alpha: 0.35 }, cfg);
    this.splitPanelTarget.render({ cells: [], color: canvas.fieldEditor.panelTarget, alpha: 0, inset: 0, borderWidth: 3 }, cfg);
    this.linkHover.clear();
    this.entityHighlight.clear();
    this.issueHighlight.clear();
    this.teleportPreview.clear();
  }

  protected destroyChildren(): void {
    this.grid.destroy();
    this.backgroundImage.destroy();
    this.floor.destroy();
    this.closedCells.destroy();
    this.walls.destroy();
    this.splitJunctions.destroy();
    this.teleports.destroy();
    this.verticalConnections.destroy();
    this.markers.destroy();
    this.hover.destroy();
    this.cellHover.destroy();
    this.splitPanelTarget.destroy();
    this.linkHover.destroy();
    this.boundaryHover.destroy();
    this.entityHighlight.destroy();
    this.issueHighlight.destroy();
    this.teleportPreview.destroy();
    this.gridContainer.destroy();
    this.backgroundImageContainer.destroy();
    this.floorContainer.destroy();
    this.closedCellsContainer.destroy();
    this.wallsContainer.destroy();
    this.splitJunctionContainer.destroy();
    this.teleportContainer.destroy();
    this.verticalContainer.destroy();
    this.markersContainer.destroy();
    this.hoverContainer.destroy();
    this.cellHoverContainer.destroy();
    this.splitPanelTargetContainer.destroy();
    this.teleportPreviewContainer.destroy();
    this.linkHoverContainer.destroy();
    this.entityHighlightContainer.destroy();
    this.issueHighlightContainer.destroy();
  }
}

/** Same `(x,y) -> NodeId[]` map as `PostEditController`'s own `buildNodeMap`, but spanning every
 *  floor at once (GitHub issue #358) — keyed `"x,y"` for floor 0, `"x,y@level"` otherwise, matching
 *  `postEditDraftSplitPoints`'s own key convention (mirrors `buildMultiFloorPointNodeMap` in
 *  `postEditSlice.ts`, kept as its own copy here since that one isn't exported). */
function buildMultiFloorPointNodeMap(nodes: NodeDto[]): Map<string, number[]> {
  const m = new Map<string, number[]>();
  for (const n of nodes) {
    const level = n.level ?? 0;
    const key = level === 0 ? `${n.x},${n.y}` : `${n.x},${n.y}@${level}`;
    const list = m.get(key);
    if (list) list.push(n.id);
    else m.set(key, [n.id]);
  }
  return m;
}
