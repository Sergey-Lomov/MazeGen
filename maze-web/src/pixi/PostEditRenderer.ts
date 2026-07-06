import { Container } from "pixi.js";
import { useMazeStore } from "../store/mazeStore";

import type { FieldEdge } from "./fieldEditUtils";
import { CellFillRenderer } from "./renderers/CellFillRenderer";
import { WallRenderer } from "./renderers/WallRenderer";
import { WaypointsRenderer } from "./renderers/WaypointsRenderer";
import { TeleportRenderer } from "./renderers/TeleportRenderer";
import { GridRenderer } from "./renderers/GridRenderer";
import { EdgeHighlightRenderer } from "./renderers/EdgeHighlightRenderer";
import { buildMazeWalls, buildMazeMarkers, buildTeleportEdges, postEditEdgesToDto, buildClosedCells } from "./selectors/mazeSelectors";
import { buildHoverEdgeHighlight } from "./selectors/presetSelectors";
import { canvas } from "./colorUtils";
import type { NodeDto } from "../wasm/types";
import { BaseFieldRenderer } from "./BaseFieldRenderer";

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

  private readonly grid: GridRenderer;
  private readonly floor: CellFillRenderer;
  private readonly closedCells: CellFillRenderer;
  private readonly walls: WallRenderer;
  private readonly teleports: TeleportRenderer;
  private readonly markers: WaypointsRenderer;
  private readonly hover: EdgeHighlightRenderer;

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
    this.root.addChild(this.teleportContainer);
    this.root.addChild(this.markersContainer);
    this.root.addChild(this.hoverContainer);

    this.grid        = new GridRenderer(this.gridContainer);
    this.floor       = new CellFillRenderer(this.floorContainer);
    this.closedCells = new CellFillRenderer(this.closedCellsContainer);
    this.walls       = new WallRenderer(this.wallsContainer);
    this.teleports   = new TeleportRenderer(this.teleportContainer);
    this.markers     = new WaypointsRenderer(this.markersContainer);
    this.hover       = new EdgeHighlightRenderer(this.hoverContainer);

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

  protected onStoreChange(state: MazeState, prev: MazeState): void {
    if (
      state.postEditDraftEdges !== prev.postEditDraftEdges ||
      state.postEditDraftTeleportEdges !== prev.postEditDraftTeleportEdges ||
      state.nodes !== prev.nodes ||
      state.postEditDraftMeta !== prev.postEditDraftMeta
    ) {
      this.redrawAll(state);
    }
  }

  protected redrawAll(state: MazeState): void {
    if (!this.cfg) return;
    const cfg = this.cfg;

    this.grid.render({ viewport: this.viewport }, cfg);

    const { nodes, postEditDraftEdges, postEditDraftTeleportEdges, postEditDraftMeta } = state;
    const start = postEditDraftMeta?.start ?? null;
    const finish = postEditDraftMeta?.finish ?? null;
    const activeEdges = [...postEditEdgesToDto(postEditDraftEdges), ...postEditDraftTeleportEdges];

    const cells: [number, number][] = nodes.map(n => [n.x, n.y]);
    this.floor.render({ cells, color: canvas.floor.default, alpha: 1 }, cfg);

    const closed = buildClosedCells(nodes, activeEdges);
    this.closedCells.render({ cells: closed, color: canvas.wall.default, alpha: 1 }, cfg);

    const wallEdges = buildMazeWalls(nodes, activeEdges, cfg);
    this.walls.render({ edges: wallEdges }, cfg);

    const nodeById = new Map<number, NodeDto>(nodes.map(n => [n.id, n]));
    const teleportEdges = buildTeleportEdges(nodeById, activeEdges, cfg);
    this.teleports.render({ edges: teleportEdges });

    const markerData = buildMazeMarkers(nodeById, start, finish, cfg);
    this.markers.render({ markers: markerData });

    this.hover.render({ highlights: [] });
  }

  protected clearAll(): void {
    if (!this.cfg) return;
    const cfg = this.cfg;
    this.grid.render({ viewport: { x: 0, y: 0, w: 0, h: 0, scale: 1 } }, cfg);
    this.floor.render({ cells: [], color: canvas.floor.default, alpha: 1 }, cfg);
    this.closedCells.render({ cells: [], color: canvas.wall.default, alpha: 1 }, cfg);
    this.walls.render({ edges: [] }, cfg);
    this.teleports.render({ edges: [] });
    this.markers.render({ markers: [] });
    this.hover.render({ highlights: [] });
  }

  protected destroyChildren(): void {
    this.grid.destroy();
    this.floor.destroy();
    this.closedCells.destroy();
    this.walls.destroy();
    this.teleports.destroy();
    this.markers.destroy();
    this.hover.destroy();
    this.gridContainer.destroy();
    this.floorContainer.destroy();
    this.closedCellsContainer.destroy();
    this.wallsContainer.destroy();
    this.teleportContainer.destroy();
    this.markersContainer.destroy();
    this.hoverContainer.destroy();
  }
}
