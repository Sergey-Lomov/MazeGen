import { Container, Graphics } from "pixi.js";
import { useMazeStore } from "../store/mazeStore";

import type { FieldEdge } from "./fieldEditUtils";
import { CellFillRenderer } from "./renderers/CellFillRenderer";
import { WallRenderer } from "./renderers/WallRenderer";
import { WaypointsRenderer } from "./renderers/WaypointsRenderer";
import { TeleportRenderer, clipDistance } from "./renderers/TeleportRenderer";
import { GridRenderer } from "./renderers/GridRenderer";
import { EdgeHighlightRenderer } from "./renderers/EdgeHighlightRenderer";
import { SplitJunctionRenderer } from "./renderers/SplitJunctionRenderer";
import { buildMazeWalls, buildMazeMarkers, buildTeleportEdges, postEditEdgesToDto, buildClosedCells, buildSplitPassages } from "./selectors/mazeSelectors";
import { postEditTeleportsToDto } from "./postEditUtils";
import { buildHoverEdgeHighlight } from "./selectors/presetSelectors";
import { canvas } from "./colorTokens";
import type { NodeDto } from "../wasm/types";
import { BaseFieldRenderer } from "./BaseFieldRenderer";
import { resolveEndpoint, buildSplitNodeResolver } from "./postEditEndpoint";

type MazeState = ReturnType<typeof useMazeStore.getState>;

export class PostEditRenderer extends BaseFieldRenderer {
  private readonly root: Container;

  private readonly gridContainer: Container;
  private readonly floorContainer: Container;
  private readonly closedCellsContainer: Container;
  private readonly wallsContainer: Container;
  private readonly teleportContainer: Container;
  private readonly markersContainer: Container;
  private readonly hoverContainer: Container;
  private readonly cellHoverContainer: Container;
  private readonly teleportPreviewContainer: Container;
  private readonly splitJunctionContainer: Container;

  private readonly grid: GridRenderer;
  private readonly floor: CellFillRenderer;
  private readonly closedCells: CellFillRenderer;
  private readonly walls: WallRenderer;
  private readonly teleports: TeleportRenderer;
  private readonly markers: WaypointsRenderer;
  private readonly hover: EdgeHighlightRenderer;
  private readonly cellHover: CellFillRenderer;
  private readonly teleportPreview: Graphics;
  private readonly splitJunctions: SplitJunctionRenderer;

  constructor(container: Container) {
    super();
    this.root = container;

    this.gridContainer        = new Container();
    this.floorContainer       = new Container();
    this.closedCellsContainer = new Container();
    this.wallsContainer       = new Container();
    this.teleportContainer    = new Container();
    this.markersContainer     = new Container();
    this.hoverContainer       = new Container();

    this.root.addChild(this.gridContainer);
    this.root.addChild(this.floorContainer);
    this.root.addChild(this.closedCellsContainer);
    this.root.addChild(this.wallsContainer);
    this.splitJunctionContainer = new Container();
    this.root.addChild(this.splitJunctionContainer);
    this.root.addChild(this.teleportContainer);
    this.root.addChild(this.markersContainer);
    this.root.addChild(this.hoverContainer);
    this.cellHoverContainer = new Container();
    this.root.addChild(this.cellHoverContainer);
    this.teleportPreviewContainer = new Container();
    this.root.addChild(this.teleportPreviewContainer);

    this.grid        = new GridRenderer(this.gridContainer);
    this.floor       = new CellFillRenderer(this.floorContainer);
    this.closedCells = new CellFillRenderer(this.closedCellsContainer);
    this.walls       = new WallRenderer(this.wallsContainer);
    this.splitJunctions = new SplitJunctionRenderer(this.splitJunctionContainer);
    this.teleports   = new TeleportRenderer(this.teleportContainer);
    this.markers     = new WaypointsRenderer(this.markersContainer);
    this.hover       = new EdgeHighlightRenderer(this.hoverContainer);
    this.cellHover   = new CellFillRenderer(this.cellHoverContainer);
    this.teleportPreview = new Graphics();
    this.teleportPreviewContainer.addChild(this.teleportPreview);

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

  updateHover(edge: FieldEdge | null): void {
    if (!this.cfg) return;
    const highlights = buildHoverEdgeHighlight(edge, this.cfg);
    this.hover.render({ highlights });
  }

  /** Highlights a single cell (not a wall/edge) — used while the `manage_split_nodes` tool is
   * active, since that tool targets a whole point rather than one of its faces (GitHub issue
   * #221's follow-up: highlighting a wall there was misleading about what a click would do). */
  updateCellHover(cell: [number, number] | null): void {
    if (!this.cfg) return;
    this.cellHover.render({ cells: cell ? [cell] : [], color: canvas.fieldEditor.hover, alpha: 0.35 }, this.cfg);
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
      state.postEditDraftMeta !== prev.postEditDraftMeta ||
      state.postEditDraftSplitPoints !== prev.postEditDraftSplitPoints ||
      state.postEditActiveSplitNode !== prev.postEditActiveSplitNode
    ) {
      this.redrawAll(state);
    }

    if (state.postEditTool !== prev.postEditTool || state.postEditTeleportPendingFrom !== prev.postEditTeleportPendingFrom) {
      if (state.postEditTeleportPendingFrom === null) this.teleportPreview.clear();
    }
  }

  protected redrawAll(state: MazeState): void {
    if (!this.cfg) return;
    const cfg = this.cfg;

    this.grid.render({ viewport: this.viewport }, cfg);

    const { nodes, postEditDraftEdges, postEditDraftTeleports, postEditDraftMeta, postEditDraftSplitPoints } = state;

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

    const { passages: splitPassages, wallFaces } = buildSplitPassages(nodes, activeEdges, cfg, specialNodeIds, state.postEditActiveSplitNode, postEditDraftSplitPoints);
    this.splitJunctions.render({ passages: splitPassages, wallFaces });

    const nodeById = new Map<number, NodeDto>(nodes.map(n => [n.id, n]));
    const teleportEdges = buildTeleportEdges(nodeById, activeEdges, cfg);
    this.teleports.render({ edges: teleportEdges });

    const markerData = buildMazeMarkers(nodeById, start, finish, cfg);
    this.markers.render({ markers: markerData });

    this.hover.render({ highlights: [] });
    this.cellHover.render({ cells: [], color: canvas.fieldEditor.hover, alpha: 0.35 }, cfg);
  }

  protected clearAll(): void {
    if (!this.cfg) return;
    const cfg = this.cfg;
    this.grid.render({ viewport: { x: 0, y: 0, w: 0, h: 0, scale: 1 } }, cfg);
    this.floor.render({ cells: [], color: canvas.floor.default, alpha: 1 }, cfg);
    this.closedCells.render({ cells: [], color: canvas.wall.default, alpha: 1 }, cfg);
    this.walls.render({ edges: [] }, cfg);
    this.splitJunctions.render({ passages: [], wallFaces: [] });
    this.teleports.render({ edges: [] });
    this.markers.render({ markers: [] });
    this.hover.render({ highlights: [] });
    this.cellHover.render({ cells: [], color: canvas.fieldEditor.hover, alpha: 0.35 }, cfg);
    this.teleportPreview.clear();
  }

  protected destroyChildren(): void {
    this.grid.destroy();
    this.floor.destroy();
    this.closedCells.destroy();
    this.walls.destroy();
    this.splitJunctions.destroy();
    this.teleports.destroy();
    this.markers.destroy();
    this.hover.destroy();
    this.cellHover.destroy();
    this.teleportPreview.destroy();
    this.gridContainer.destroy();
    this.floorContainer.destroy();
    this.closedCellsContainer.destroy();
    this.wallsContainer.destroy();
    this.splitJunctionContainer.destroy();
    this.teleportContainer.destroy();
    this.markersContainer.destroy();
    this.hoverContainer.destroy();
    this.cellHoverContainer.destroy();
    this.teleportPreviewContainer.destroy();
  }
}
