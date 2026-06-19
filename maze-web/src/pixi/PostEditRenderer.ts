import { Container } from "pixi.js";
import { useMazeStore } from "../store/mazeStore";

import { resolveCells } from "./presetConnectionsUtils";
import type { FieldEdge } from "./presetConnectionsUtils";
import { encodePoint } from "./tessellationProjection";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";
import { CellFillRenderer } from "./renderers/CellFillRenderer";
import { WallRenderer } from "./renderers/WallRenderer";
import { WaypointsRenderer } from "./renderers/WaypointsRenderer";
import { GridRenderer } from "./renderers/GridRenderer";
import { EdgeHighlightRenderer } from "./renderers/EdgeHighlightRenderer";
import { buildMazeWalls, buildMazeMarkers, postEditEdgesToDto, buildClosedCells } from "./selectors/mazeSelectors";
import { buildHoverEdgeHighlight } from "./selectors/presetSelectors";
import { FLOOR_COLOR, WALL_COLOR } from "./colorUtils";
import type { Viewport } from "./renderers/types";
import type { NodeDto } from "../wasm/types";

export class PostEditRenderer {
  private readonly root: Container;

  private readonly gridContainer: Container;
  private readonly floorContainer: Container;
  private readonly closedCellsContainer: Container;
  private readonly wallsContainer: Container;
  private readonly markersContainer: Container;
  private readonly hoverContainer: Container;

  private readonly grid: GridRenderer;
  private readonly floor: CellFillRenderer;
  private readonly closedCells: CellFillRenderer;
  private readonly walls: WallRenderer;
  private readonly markers: WaypointsRenderer;
  private readonly hover: EdgeHighlightRenderer;

  private viewport: Viewport = { x: 0, y: 0, w: 0, h: 0, scale: 1 };
  private cfg: TessellationConfig | null = null;
  private cachedCells: [number, number][] = [];
  private cachedCellSet: Set<number> = new Set();

  private unsubscribe: (() => void) | null = null;

  constructor(container: Container) {
    this.root = container;

    this.gridContainer        = new Container();
    this.floorContainer       = new Container();
    this.closedCellsContainer = new Container();
    this.wallsContainer       = new Container();
    this.markersContainer     = new Container();
    this.hoverContainer       = new Container();

    this.root.addChild(this.gridContainer);
    this.root.addChild(this.floorContainer);
    this.root.addChild(this.closedCellsContainer);
    this.root.addChild(this.wallsContainer);
    this.root.addChild(this.markersContainer);
    this.root.addChild(this.hoverContainer);

    this.grid        = new GridRenderer(this.gridContainer);
    this.floor       = new CellFillRenderer(this.floorContainer);
    this.closedCells = new CellFillRenderer(this.closedCellsContainer);
    this.walls       = new WallRenderer(this.wallsContainer);
    this.markers     = new WaypointsRenderer(this.markersContainer);
    this.hover       = new EdgeHighlightRenderer(this.hoverContainer);

    this.root.visible = false;

    this.unsubscribe = useMazeStore.subscribe((state, prev) => {
      const isOpen = state.openCard === "post_edit";
      const openChanged = state.openCard !== prev.openCard
        && (isOpen || prev.openCard === "post_edit");

      if (openChanged) {
        this.root.visible = isOpen;
        if (isOpen) {
          this.cfg = state.activeTessellationConfig;
          this.rebuildCellCache(state);
          this.redrawAll(state);
        } else {
          this.clearAll();
        }
      }

      if (!isOpen) return;

      if (state.activeTessellationConfig !== prev.activeTessellationConfig) {
        this.cfg = state.activeTessellationConfig;
        this.rebuildCellCache(state);
        this.redrawAll(state);
        return;
      }

      if (
        state.postEditDraftEdges !== prev.postEditDraftEdges ||
        state.nodes !== prev.nodes ||
        state.postEditDraftMeta !== prev.postEditDraftMeta
      ) {
        this.redrawAll(state);
      }
    });
  }

  getCachedCells(): [number, number][] {
    return this.cachedCells;
  }

  getCachedCellSet(): Set<number> {
    return this.cachedCellSet;
  }

  onViewportChanged(x: number, y: number, w: number, h: number, scale: number): void {
    this.viewport = { x, y, w, h, scale };
    if (useMazeStore.getState().openCard === "post_edit" && this.cfg) {
      this.grid.render({ viewport: this.viewport }, this.cfg);
    }
  }

  updateHover(edge: FieldEdge | null): void {
    if (!this.cfg) return;
    const highlights = buildHoverEdgeHighlight(edge, this.cfg);
    this.hover.render({ highlights });
  }

  private rebuildCellCache(state: ReturnType<typeof useMazeStore.getState>): void {
    if (!this.cfg) return;
    const customPts = state.fieldEditMode === "custom" && state.fieldPoints.size > 0
      ? state.fieldPoints : undefined;
    this.cachedCells = resolveCells(this.cfg, customPts);
    this.cachedCellSet = new Set(this.cachedCells.map(([x, y]) => encodePoint(x, y)));
  }

  private redrawAll(state: ReturnType<typeof useMazeStore.getState>): void {
    if (!this.cfg) return;
    const cfg = this.cfg;

    this.grid.render({ viewport: this.viewport }, cfg);

    const { nodes, postEditDraftEdges, postEditDraftMeta } = state;
    const start = postEditDraftMeta?.start ?? null;
    const finish = postEditDraftMeta?.finish ?? null;
    const activeEdges = postEditEdgesToDto(postEditDraftEdges);

    const cells: [number, number][] = nodes.map(n => [n.x, n.y]);
    this.floor.render({ cells, color: FLOOR_COLOR, alpha: 1 }, cfg);

    const closed = buildClosedCells(nodes, activeEdges);
    this.closedCells.render({ cells: closed, color: WALL_COLOR, alpha: 1 }, cfg);

    const wallEdges = buildMazeWalls(nodes, activeEdges, cfg);
    this.walls.render({ edges: wallEdges }, cfg);

    const nodeById = new Map<number, NodeDto>(nodes.map(n => [n.id, n]));
    const markerData = buildMazeMarkers(nodeById, start, finish, cfg);
    this.markers.render({ markers: markerData });

    this.hover.render({ highlights: [] });
  }

  private clearAll(): void {
    if (!this.cfg) return;
    const cfg = this.cfg;
    this.grid.render({ viewport: { x: 0, y: 0, w: 0, h: 0, scale: 1 } }, cfg);
    this.floor.render({ cells: [], color: FLOOR_COLOR, alpha: 1 }, cfg);
    this.closedCells.render({ cells: [], color: WALL_COLOR, alpha: 1 }, cfg);
    this.walls.render({ edges: [] }, cfg);
    this.markers.render({ markers: [] });
    this.hover.render({ highlights: [] });
  }

  destroy(): void {
    this.unsubscribe?.();
    this.grid.destroy();
    this.floor.destroy();
    this.closedCells.destroy();
    this.walls.destroy();
    this.markers.destroy();
    this.hover.destroy();
    this.gridContainer.destroy();
    this.floorContainer.destroy();
    this.closedCellsContainer.destroy();
    this.wallsContainer.destroy();
    this.markersContainer.destroy();
    this.hoverContainer.destroy();
  }
}

