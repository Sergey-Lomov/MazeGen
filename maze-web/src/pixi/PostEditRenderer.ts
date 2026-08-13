import { Container, Graphics } from "pixi.js";
import { useMazeStore } from "../store/mazeStore";

import type { FieldEdge } from "./fieldEditUtils";
import { CellFillRenderer } from "./renderers/CellFillRenderer";
import { WallRenderer } from "./renderers/WallRenderer";
import { WaypointsRenderer } from "./renderers/WaypointsRenderer";
import { TeleportRenderer, clipDistance } from "./renderers/TeleportRenderer";
import { GridRenderer } from "./renderers/GridRenderer";
import { EdgeHighlightRenderer } from "./renderers/EdgeHighlightRenderer";
import { NodeEdgeHighlightRenderer } from "./renderers/NodeEdgeHighlightRenderer";
import { SplitJunctionRenderer } from "./renderers/SplitJunctionRenderer";
import { VerticalConnectionRenderer, type VerticalConnectionStyle } from "./renderers/VerticalConnectionRenderer";
import { IssueHighlightOverlay } from "./IssueHighlightOverlay";
import { buildMazeWalls, buildMazeMarkers, buildTeleportEdges, postEditEdgesToDto, buildClosedCells, buildSplitPassages, buildLinkHoverHighlight, selectFloorScopedMaze, selectNodeLevelResolver, selectVerticalPassagePairSet, buildVerticalConnectionMarkers } from "./selectors/mazeSelectors";
import { postEditTeleportsToDto } from "./postEditUtils";
import { buildHoverEdgeHighlight } from "./selectors/presetSelectors";
import { canvas } from "./colorTokens";
import type { NodeDto } from "../wasm/types";
import type { PostEditEdge, PostEditTeleportEntry } from "../store/mazeStore";
import { BaseFieldRenderer } from "./BaseFieldRenderer";
import { type PostEditEndpoint, resolveEndpoint, buildSplitNodeResolver, endpointOnLevel } from "./postEditEndpoint";
import { recordOnLevel } from "./fieldEditUtils";
import { activeFloorLevel } from "../store/storeHelpers";

type MazeState = ReturnType<typeof useMazeStore.getState>;

/** Fixed style for `VerticalConnectionRenderer` (GitHub issue #359 follow-up to #337/#347) — post-
 *  edit has no settings panel of its own for this, so it always uses this one look, mirroring
 *  `GenerationRenderer`'s own `DEFAULT_VERTICAL_STYLE` — kept as a separate copy per
 *  `maze-web/CLAUDE.md`'s feature-renderer ownership rule (no shared renderer instances/constants
 *  across features). */
const DEFAULT_VERTICAL_STYLE: VerticalConnectionStyle = {
  displayStyle: "marker",
  verticalPassageMarker: {
    shape: "circle",
    cornerStyle: "round",
    fillColor: canvas.vertical.default,
    borderColor: canvas.vertical.default,
    borderWidth: 2,
    gapWidth: 3,
    gapColor: canvas.floor.default,
    size: 0.22,
  },
  elevatorMarker: {
    shape: "diamond",
    cornerStyle: "round",
    fillColor: canvas.vertical.default,
    borderColor: canvas.vertical.default,
    borderWidth: 2,
    gapWidth: 3,
    gapColor: canvas.floor.default,
    size: 0.22,
  },
  arrowColor: canvas.vertical.default,
};

export class PostEditRenderer extends BaseFieldRenderer {
  private readonly root: Container;

  private readonly gridContainer: Container;
  private readonly floorContainer: Container;
  private readonly closedCellsContainer: Container;
  private readonly wallsContainer: Container;
  private readonly teleportContainer: Container;
  private readonly verticalContainer: Container;
  private readonly markersContainer: Container;
  private readonly hoverContainer: Container;
  private readonly cellHoverContainer: Container;
  private readonly teleportPreviewContainer: Container;
  private readonly splitJunctionContainer: Container;
  private readonly linkHoverContainer: Container;
  private readonly issueHighlightContainer: Container;

  private readonly grid: GridRenderer;
  private readonly floor: CellFillRenderer;
  private readonly closedCells: CellFillRenderer;
  private readonly walls: WallRenderer;
  private readonly teleports: TeleportRenderer;
  private readonly verticalConnections: VerticalConnectionRenderer;
  private readonly markers: WaypointsRenderer;
  private readonly hover: EdgeHighlightRenderer;
  private readonly cellHover: CellFillRenderer;
  private readonly teleportPreview: Graphics;
  private readonly splitJunctions: SplitJunctionRenderer;
  /** Highlights the link a "Manage split nodes" panel bubble is currently hovered (GitHub issue
   *  #237) — driven by `postEditHoveredLink`, a separate layer/container from `hover` (that one
   *  is driven by canvas pointermove instead, via `updateHover`) so the two never fight over the
   *  same `Graphics` object. Same `NodeEdgeHighlightRenderer` primitive `DebugRefHighlightOverlay`
   *  uses for its edge-ref highlight — a straight line + circle markers on each end, node center
   *  to node center, not the shared geometric wall segment (a link bubble names a specific pair of
   *  *nodes*, and a teleport link has no shared face at all to draw on). */
  private readonly linkHover: NodeEdgeHighlightRenderer;
  /** Highlights a hovered `IssueBubble`'s flagged cells/edges/regions in the post-edit canvas —
   *  own instance, not shared with `AnalyticsRenderer`'s (feature-renderer ownership rule,
   *  `maze-web/CLAUDE.md`). `IssuesBlock`/`IssueBubble` drive both from the same store fields
   *  (`hoveredIssueLoopEdges`/`hoveredIssueRegionGroups`), so no post-edit-specific wiring needed
   *  beyond owning this instance and re-rendering it on the same triggers as everything else. */
  private readonly issueHighlight: IssueHighlightOverlay;

  constructor(container: Container) {
    super();
    this.root = container;

    this.gridContainer        = new Container();
    this.floorContainer       = new Container();
    this.closedCellsContainer = new Container();
    this.wallsContainer       = new Container();
    this.teleportContainer    = new Container();
    this.verticalContainer    = new Container();
    this.markersContainer     = new Container();
    this.hoverContainer       = new Container();

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
    this.teleportPreviewContainer = new Container();
    this.root.addChild(this.teleportPreviewContainer);
    this.linkHoverContainer = new Container();
    this.root.addChild(this.linkHoverContainer);
    this.issueHighlightContainer = new Container();
    this.root.addChild(this.issueHighlightContainer);

    this.grid        = new GridRenderer(this.gridContainer);
    this.floor       = new CellFillRenderer(this.floorContainer);
    this.closedCells = new CellFillRenderer(this.closedCellsContainer);
    this.walls       = new WallRenderer(this.wallsContainer);
    this.splitJunctions = new SplitJunctionRenderer(this.splitJunctionContainer);
    this.teleports   = new TeleportRenderer(this.teleportContainer);
    this.verticalConnections = new VerticalConnectionRenderer(this.verticalContainer);
    this.markers     = new WaypointsRenderer(this.markersContainer);
    this.hover       = new EdgeHighlightRenderer(this.hoverContainer);
    this.cellHover   = new CellFillRenderer(this.cellHoverContainer);
    this.teleportPreview = new Graphics();
    this.teleportPreviewContainer.addChild(this.teleportPreview);
    this.linkHover   = new NodeEdgeHighlightRenderer(this.linkHoverContainer);
    this.issueHighlight = new IssueHighlightOverlay(this.issueHighlightContainer);

    this.root.visible = false;

    this.subscribeToStore();
  }

  protected isCardOpen(state: MazeState): boolean {
    return state.openCard === "post_edit";
  }

  protected getActiveConfig(state: MazeState) {
    return state.activeTessellationConfig;
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
    if (!this.cfg) return;
    const highlights = buildHoverEdgeHighlight(edge, this.cfg, danger ? canvas.fieldEditor.danger : undefined);
    this.hover.render({ highlights });
  }

  /** Highlights a single cell (not a wall/edge) — used while the `manage_split_nodes` tool is
   * active, since that tool targets a whole point rather than one of its faces (GitHub issue
   * #221's follow-up: highlighting a wall there was misleading about what a click would do).
   * `danger` — see `updateHover`'s doc comment. */
  updateCellHover(cell: [number, number] | null, danger = false): void {
    if (!this.cfg) return;
    this.cellHover.render({ cells: cell ? [cell] : [], color: danger ? canvas.fieldEditor.danger : canvas.fieldEditor.hover, alpha: 0.35 }, this.cfg);
  }

  /** Renders the pending teleport's origin (semi-transparent marker) and a line stretching to the
   * cursor, so the two-click placement gesture reads as "one end is already fixed, aim the other".
   * `pendingFrom` is already in viewport coordinates (the caller resolves node → screen). */
  updateTeleportPreview(pendingFrom: { x: number; y: number } | null, cursorViewportX: number, cursorViewportY: number): void {
    this.teleportPreview.clear();
    if (!pendingFrom) return;

    const { x: px, y: py } = pendingFrom;
    const markerSize = 16;
    const strokeWidth = 3;
    const dx = cursorViewportX - px;
    const dy = cursorViewportY - py;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len > 0) {
      const ux = dx / len;
      const uy = dy / len;
      const clip = clipDistance(ux, uy, markerSize / 2, strokeWidth);
      if (len > clip) {
        this.teleportPreview
          .moveTo(px + ux * clip, py + uy * clip)
          .lineTo(cursorViewportX, cursorViewportY)
          .stroke({ width: strokeWidth, color: canvas.teleport.default, alpha: 0.5, cap: "round" });
      }
    }

    this.teleportPreview
      .roundRect(px - markerSize / 2, py - markerSize / 2, markerSize, markerSize, markerSize * 0.25)
      .fill({ color: canvas.teleport.default, alpha: 0.5 });
  }

  protected onStoreChange(state: MazeState, prev: MazeState): void {
    if (
      state.postEditDraftEdges !== prev.postEditDraftEdges ||
      state.postEditDraftTeleports !== prev.postEditDraftTeleports ||
      state.nodes !== prev.nodes ||
      state.edges !== prev.edges ||
      state.postEditDraftMeta !== prev.postEditDraftMeta ||
      state.postEditDraftSplitPoints !== prev.postEditDraftSplitPoints ||
      state.postEditActiveSplitNode !== prev.postEditActiveSplitNode ||
      state.activeFloorId !== prev.activeFloorId
    ) {
      this.redrawAll(state);
    } else if (state.postEditHoveredLink !== prev.postEditHoveredLink) {
      this.redrawLinkHover(state);
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
  private floorScoped(state: MazeState) {
    const level = activeFloorLevel(state);
    const { nodes, edges, start, finish } = selectFloorScopedMaze(state.nodes, state.edges, state.floors, state.activeFloorId, state.start, state.finish);
    const floorNodeIds = new Set(nodes.map((n) => n.id));
    const onLevel = (ep: PostEditEndpoint) => endpointOnLevel(ep, level, floorNodeIds);
    const postEditDraftEdges: Record<string, PostEditEdge> | null = state.postEditDraftEdges === null ? null : Object.fromEntries(
      Object.entries(state.postEditDraftEdges).filter(([, e]) => onLevel(e.from) && onLevel(e.to)),
    );
    const postEditDraftTeleports: PostEditTeleportEntry[] = state.postEditDraftTeleports.filter((t) => onLevel(t.from) && onLevel(t.to));
    const postEditDraftSplitPoints = recordOnLevel(state.postEditDraftSplitPoints, level);
    const postEditActiveSplitNode = recordOnLevel(state.postEditActiveSplitNode, level);
    const postEditDraftMeta = state.postEditDraftMeta === null ? null : {
      start: state.postEditDraftMeta.start !== null && onLevel(state.postEditDraftMeta.start) ? state.postEditDraftMeta.start : null,
      finish: state.postEditDraftMeta.finish !== null && onLevel(state.postEditDraftMeta.finish) ? state.postEditDraftMeta.finish : null,
    };
    return { nodes, edges, start, finish, postEditDraftEdges, postEditDraftTeleports, postEditDraftSplitPoints, postEditActiveSplitNode, postEditDraftMeta };
  }

  private redrawIssueHighlight(state: MazeState): void {
    if (!this.cfg) return;
    const { nodes, edges } = this.floorScoped(state);
    this.issueHighlight.render({
      nodes,
      edges: state.hoveredIssueLoopEdges,
      allEdges: edges,
      regionGroups: state.hoveredIssueRegionGroups,
      cfg: this.cfg,
    });
  }

  private redrawLinkHover(state: MazeState): void {
    if (!this.cfg) return;
    const { nodes, postEditDraftSplitPoints } = this.floorScoped(state);
    const pointNodeMap = new Map<string, number[]>();
    for (const nd of nodes) {
      const k = `${nd.x},${nd.y}`;
      const list = pointNodeMap.get(k);
      if (list) list.push(nd.id); else pointNodeMap.set(k, [nd.id]);
    }
    const resolveSplit = buildSplitNodeResolver(pointNodeMap, postEditDraftSplitPoints);
    const highlights = buildLinkHoverHighlight(state.postEditHoveredLink, nodes, resolveSplit, this.cfg);
    this.linkHover.render(highlights);
  }

  protected redrawAll(state: MazeState): void {
    if (!this.cfg) return;
    const cfg = this.cfg;

    this.grid.render({ viewport: this.viewport }, cfg);

    const { nodes, edges, postEditDraftEdges, postEditDraftTeleports, postEditDraftMeta, postEditDraftSplitPoints, postEditActiveSplitNode } = this.floorScoped(state);

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
    const activeEdges = [
      ...postEditEdgesToDto(postEditDraftEdges, resolveSplit),
      ...postEditTeleportsToDto(postEditDraftTeleports, resolveSplit),
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

    // Split points (GitHub issue #223) render every node's passages at once, as colored lines
    // from a small per-node point to each face it connects across — see `buildSplitPassages`.
    // `postEditActiveSplitNode` still governs which endpoint edge-tool clicks target, but no
    // longer what's drawn; ordinary `buildMazeWalls` skips a split point's own geometric edges
    // entirely, since those are rendered here instead.
    const closed = buildClosedCells(nodes, activeEdges);
    this.closedCells.render({ cells: closed, color: canvas.wall.default, alpha: 1 }, cfg);

    const wallEdges = buildMazeWalls(nodes, activeEdges, cfg);
    this.walls.render({ edges: wallEdges }, cfg);

    const { passages: splitPassages, wallFaces, specialShapes } = buildSplitPassages(nodes, activeEdges, cfg, specialNodeIds, postEditActiveSplitNode, postEditDraftSplitPoints);
    this.splitJunctions.render({ passages: splitPassages, wallFaces, specialShapes });

    const nodeById = new Map<number, NodeDto>(nodes.map(n => [n.id, n]));
    const teleportEdges = buildTeleportEdges(nodeById, activeEdges, cfg);
    this.teleports.render({ edges: teleportEdges, cfg });

    // Vertical passages/elevators (GitHub issue #359 follow-up to #337/#347) — these edge kinds
    // are never post-edit-editable (only generation/vertical-connection tools create them), so
    // they're read from the confirmed `state.nodes`/`state.edges` graph directly, not from
    // `activeEdges` (post-edit's own draft edges/teleports). `edges`/`nodeById` here are already
    // floor-scoped (`floorScoped`'s `selectFloorScopedMaze`, which keeps a vertical/elevator edge
    // whenever its `from` is on the active floor); `resolveNodeLevel`/`verticalPairs` must come
    // from the *unscoped* `state.nodes`/`state.edges` instead, same reason
    // `selectVerticalPassagePairSet`'s own doc comment gives (a floor-scoped edge list is missing
    // the reverse-direction edge of a bidirectional passage, whose own `from` lives on the other
    // floor).
    const activeFloorIndex = state.floors.findIndex((f) => f.id === state.activeFloorId);
    const verticalConnectionMarkers = buildVerticalConnectionMarkers(
      nodeById, edges, cfg, selectNodeLevelResolver(state.nodes), Math.max(activeFloorIndex, 0),
      selectVerticalPassagePairSet(state.edges), state.edges,
    );
    this.verticalConnections.render({ markers: verticalConnectionMarkers, style: DEFAULT_VERTICAL_STYLE });

    const markerData = buildMazeMarkers(nodeById, start, finish, cfg, undefined, undefined, activeEdges);
    this.markers.render({ markers: markerData });

    this.hover.render({ highlights: [] });
    this.cellHover.render({ cells: [], color: canvas.fieldEditor.hover, alpha: 0.35 }, cfg);
    this.redrawLinkHover(state);
    this.redrawIssueHighlight(state);
  }

  protected clearAll(): void {
    if (!this.cfg) return;
    const cfg = this.cfg;
    this.grid.render({ viewport: { x: 0, y: 0, w: 0, h: 0, scale: 1 } }, cfg);
    this.floor.render({ cells: [], color: canvas.floor.default, alpha: 1 }, cfg);
    this.closedCells.render({ cells: [], color: canvas.wall.default, alpha: 1 }, cfg);
    this.walls.render({ edges: [] }, cfg);
    this.splitJunctions.render({ passages: [], wallFaces: [] });
    this.teleports.render({ edges: [], cfg });
    this.verticalConnections.render({ markers: [], style: DEFAULT_VERTICAL_STYLE });
    this.markers.render({ markers: [] });
    this.hover.render({ highlights: [] });
    this.cellHover.render({ cells: [], color: canvas.fieldEditor.hover, alpha: 0.35 }, cfg);
    this.linkHover.clear();
    this.issueHighlight.clear();
    this.teleportPreview.clear();
  }

  protected destroyChildren(): void {
    this.grid.destroy();
    this.floor.destroy();
    this.closedCells.destroy();
    this.walls.destroy();
    this.splitJunctions.destroy();
    this.teleports.destroy();
    this.verticalConnections.destroy();
    this.markers.destroy();
    this.hover.destroy();
    this.cellHover.destroy();
    this.linkHover.destroy();
    this.issueHighlight.destroy();
    this.teleportPreview.destroy();
    this.gridContainer.destroy();
    this.floorContainer.destroy();
    this.closedCellsContainer.destroy();
    this.wallsContainer.destroy();
    this.splitJunctionContainer.destroy();
    this.teleportContainer.destroy();
    this.verticalContainer.destroy();
    this.markersContainer.destroy();
    this.hoverContainer.destroy();
    this.cellHoverContainer.destroy();
    this.teleportPreviewContainer.destroy();
    this.linkHoverContainer.destroy();
    this.issueHighlightContainer.destroy();
  }
}
