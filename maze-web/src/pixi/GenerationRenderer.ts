import { Container } from "pixi.js";
import { useMazeStore } from "../store/mazeStore";
import { CellFillRenderer } from "./renderers/CellFillRenderer";
import { WallRenderer } from "./renderers/WallRenderer";
import { WaypointsRenderer } from "./renderers/WaypointsRenderer";
import { TeleportRenderer } from "./renderers/TeleportRenderer";
import { GridRenderer } from "./renderers/GridRenderer";
import { buildMazeWalls, buildMazeMarkers, buildTeleportEdges, buildClosedCells } from "./selectors/mazeSelectors";
import { selectDebugMazeView } from "../store/debugSelectors";
import type { NodeDto, EdgeDto } from "../wasm/types";
import type { Viewport } from "./renderers/types";
import { canvas } from "./colorUtils";

export class GenerationRenderer {
  private readonly gridContainer: Container;
  private readonly floorContainer: Container;
  private readonly closedCellsContainer: Container;
  private readonly wallsContainer: Container;
  private readonly teleportContainer: Container;
  private readonly markersContainer: Container;

  private readonly grid: GridRenderer;
  private readonly floor: CellFillRenderer;
  private readonly closedCells: CellFillRenderer;
  private readonly walls: WallRenderer;
  private readonly teleports: TeleportRenderer;
  private readonly markers: WaypointsRenderer;

  private viewport: Viewport = { x: 0, y: 0, w: 0, h: 0, scale: 1 };
  private unsubscribe: (() => void) | null = null;
  private closedCellsCache: { nodes: NodeDto[]; edges: EdgeDto[]; result: [number, number][] } | null = null;

  constructor(viewport: Container) {
    this.gridContainer = new Container();
    this.floorContainer = new Container();
    this.closedCellsContainer = new Container();
    this.wallsContainer = new Container();
    this.teleportContainer = new Container();
    this.markersContainer = new Container();

    viewport.addChild(this.gridContainer);
    viewport.addChild(this.floorContainer);
    viewport.addChild(this.closedCellsContainer);
    viewport.addChild(this.wallsContainer);
    viewport.addChild(this.teleportContainer);
    viewport.addChild(this.markersContainer);

    this.grid = new GridRenderer(this.gridContainer);
    this.floor = new CellFillRenderer(this.floorContainer);
    this.closedCells = new CellFillRenderer(this.closedCellsContainer);
    this.walls = new WallRenderer(this.wallsContainer);
    this.teleports = new TeleportRenderer(this.teleportContainer);
    this.markers = new WaypointsRenderer(this.markersContainer);

    this.syncVisibility(useMazeStore.getState());
    this.renderAll(useMazeStore.getState());
    this.subscribe();
  }

  private subscribe(): void {
    let prev = useMazeStore.getState();
    this.unsubscribe = useMazeStore.subscribe((state) => {
      const visibilityChanged =
        state.openCard !== prev.openCard ||
        state.showMaze !== prev.showMaze;

      if (visibilityChanged) {
        this.syncVisibility(state);
      }

      const dataChanged =
        state.nodes !== prev.nodes ||
        state.edges !== prev.edges ||
        state.start !== prev.start ||
        state.finish !== prev.finish ||
        state.tessellationConfig !== prev.tessellationConfig ||
        state.activeTessellationConfig !== prev.activeTessellationConfig ||
        state.debugMode !== prev.debugMode ||
        state.debugArena !== prev.debugArena ||
        state.debugStep !== prev.debugStep;

      if (dataChanged) {
        this.renderAll(state);
      }

      prev = state;
    });
  }

  private syncVisibility(state: ReturnType<typeof useMazeStore.getState>): void {
    const visible = state.openCard === "generation" && state.showMaze;
    this.gridContainer.visible = visible;
    this.floorContainer.visible = visible;
    this.closedCellsContainer.visible = visible;
    this.wallsContainer.visible = visible;
    this.teleportContainer.visible = visible;
    this.markersContainer.visible = visible;
    if (visible) {
      this.renderAll(state);
    }
  }

  onViewportChanged(x: number, y: number, w: number, h: number, scale: number): void {
    this.viewport = { x, y, w, h, scale };
    const state = useMazeStore.getState();
    if (state.openCard === "generation" && state.showMaze) {
      const cfg = state.nodes.length > 0 ? state.activeTessellationConfig : state.tessellationConfig;
      this.grid.render({ viewport: this.viewport }, cfg);
    }
  }

  private debugView(state: ReturnType<typeof useMazeStore.getState>) {
    const view = state.debugMode ? selectDebugMazeView(state.debugArena, state.debugStep) : null;
    return {
      nodes: view ? view.nodes : state.nodes,
      edges: view ? view.edges : state.edges,
      start: state.start,
      finish: state.finish,
    };
  }

  private renderAll(state: ReturnType<typeof useMazeStore.getState>): void {
    const cfg = state.nodes.length > 0 ? state.activeTessellationConfig : state.tessellationConfig;
    this.grid.render({ viewport: this.viewport }, cfg);
    const view = this.debugView(state);

    const cells: [number, number][] = view.nodes.map(n => [n.x, n.y]);
    this.floor.render({ cells, color: canvas.floor.default, alpha: 1 }, cfg);

    if (!this.closedCellsCache || this.closedCellsCache.nodes !== view.nodes || this.closedCellsCache.edges !== view.edges) {
      this.closedCellsCache = { nodes: view.nodes, edges: view.edges, result: buildClosedCells(view.nodes, view.edges) };
    }
    this.closedCells.render({ cells: this.closedCellsCache.result, color: canvas.wall.default, alpha: 1 }, cfg);

    const wallEdges = buildMazeWalls(view.nodes, view.edges, cfg);
    this.walls.render({ edges: wallEdges }, cfg);

    const nodeById = new Map(view.nodes.map(n => [n.id, n]));
    const teleportEdges = buildTeleportEdges(nodeById, view.edges, cfg);
    this.teleports.render({ edges: teleportEdges });

    const markerData = buildMazeMarkers(nodeById, view.start, view.finish, cfg);
    this.markers.render({ markers: markerData });
  }

  destroy(): void {
    this.unsubscribe?.();
    this.grid.destroy();
    this.floor.destroy();
    this.closedCells.destroy();
    this.walls.destroy();
    this.teleports.destroy();
    this.markers.destroy();
    this.gridContainer.destroy();
    this.floorContainer.destroy();
    this.closedCellsContainer.destroy();
    this.wallsContainer.destroy();
    this.teleportContainer.destroy();
    this.markersContainer.destroy();
  }
}


