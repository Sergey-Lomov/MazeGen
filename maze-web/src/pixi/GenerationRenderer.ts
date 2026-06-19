import { Container } from "pixi.js";
import { useMazeStore } from "../store/mazeStore";
import { CellFillRenderer } from "./renderers/CellFillRenderer";
import { WallRenderer } from "./renderers/WallRenderer";
import { WaypointsRenderer } from "./renderers/WaypointsRenderer";
import { GridRenderer } from "./renderers/GridRenderer";
import { buildMazeWalls, buildMazeMarkers, buildClosedCells } from "./selectors/mazeSelectors";
import type { NodeDto, EdgeDto } from "../wasm/types";
import type { Viewport } from "./renderers/types";
import {
  FLOOR_COLOR, WALL_COLOR,
  DEBUG_ACTIVE_COLOR, DEBUG_CURRENT_SRC_COLOR,
  DEBUG_ACTIVE_ALPHA,
} from "./colorUtils";

export class GenerationRenderer {
  private readonly gridContainer: Container;
  private readonly floorContainer: Container;
  private readonly closedCellsContainer: Container;
  private readonly wallsContainer: Container;
  private readonly markersContainer: Container;
  private readonly debugActiveContainer: Container;
  private readonly debugSrcContainer: Container;

  private readonly grid: GridRenderer;
  private readonly floor: CellFillRenderer;
  private readonly closedCells: CellFillRenderer;
  private readonly walls: WallRenderer;
  private readonly markers: WaypointsRenderer;
  private readonly debugActive: CellFillRenderer;
  private readonly debugSrc: CellFillRenderer;

  private viewport: Viewport = { x: 0, y: 0, w: 0, h: 0, scale: 1 };
  private unsubscribe: (() => void) | null = null;
  private closedCellsCache: { nodes: NodeDto[]; edges: EdgeDto[]; result: [number, number][] } | null = null;

  constructor(viewport: Container) {
    this.gridContainer = new Container();
    this.floorContainer = new Container();
    this.closedCellsContainer = new Container();
    this.wallsContainer = new Container();
    this.markersContainer = new Container();
    this.debugActiveContainer = new Container();
    this.debugSrcContainer = new Container();

    viewport.addChild(this.gridContainer);
    viewport.addChild(this.floorContainer);
    viewport.addChild(this.closedCellsContainer);
    viewport.addChild(this.wallsContainer);
    viewport.addChild(this.markersContainer);
    viewport.addChild(this.debugActiveContainer);
    viewport.addChild(this.debugSrcContainer);

    this.grid = new GridRenderer(this.gridContainer);
    this.floor = new CellFillRenderer(this.floorContainer);
    this.closedCells = new CellFillRenderer(this.closedCellsContainer);
    this.walls = new WallRenderer(this.wallsContainer);
    this.markers = new WaypointsRenderer(this.markersContainer);
    this.debugActive = new CellFillRenderer(this.debugActiveContainer);
    this.debugSrc = new CellFillRenderer(this.debugSrcContainer);

    this.syncVisibility(useMazeStore.getState());
    this.renderAll(useMazeStore.getState());
    this.subscribe();
  }

  private subscribe(): void {
    let prev = useMazeStore.getState();
    this.unsubscribe = useMazeStore.subscribe((state) => {
      const visibilityChanged =
        state.generationOpen !== prev.generationOpen ||
        state.showMaze !== prev.showMaze ||
        state.showDebugFrontier !== prev.showDebugFrontier;

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
        state.debugSnapshot !== prev.debugSnapshot ||
        state.debugStep !== prev.debugStep;

      if (dataChanged) {
        this.renderAll(state);
      }

      prev = state;
    });
  }

  private syncVisibility(state: ReturnType<typeof useMazeStore.getState>): void {
    const visible = state.generationOpen && state.showMaze;
    this.gridContainer.visible = visible;
    this.floorContainer.visible = visible;
    this.closedCellsContainer.visible = visible;
    this.wallsContainer.visible = visible;
    this.markersContainer.visible = visible;
    this.debugActiveContainer.visible = visible && state.showDebugFrontier;
    this.debugSrcContainer.visible = visible && state.showDebugFrontier;
    if (visible) {
      this.renderAll(state);
    }
  }

  onViewportChanged(x: number, y: number, w: number, h: number, scale: number): void {
    this.viewport = { x, y, w, h, scale };
    const state = useMazeStore.getState();
    if (state.generationOpen && state.showMaze) {
      const cfg = state.nodes.length > 0 ? state.activeTessellationConfig : state.tessellationConfig;
      this.grid.render({ viewport: this.viewport }, cfg);
    }
  }

  private debugView(state: ReturnType<typeof useMazeStore.getState>) {
    const snap = state.debugMode && state.debugSnapshot ? state.debugSnapshot : null;
    const nodes = snap ? snap.nodes : state.nodes;
    const edges = snap ? (snap.steps[state.debugStep]?.edges ?? []) : state.edges;
    const isLastStep = snap ? state.debugStep === snap.steps.length - 1 : true;
    const start  = (snap && !isLastStep) ? null : state.start;
    const finish = (snap && !isLastStep) ? null : state.finish;
    const currentStep = snap ? snap.steps[state.debugStep] : null;
    return { nodes, edges, start, finish, currentStep };
  }

  private renderAll(state: ReturnType<typeof useMazeStore.getState>): void {
    const cfg = state.nodes.length > 0 ? state.activeTessellationConfig : state.tessellationConfig;
    this.grid.render({ viewport: this.viewport }, cfg);
    const view = this.debugView(state);

    const cells: [number, number][] = view.nodes.map(n => [n.x, n.y]);
    this.floor.render({ cells, color: FLOOR_COLOR, alpha: 1 }, cfg);

    if (!this.closedCellsCache || this.closedCellsCache.nodes !== view.nodes || this.closedCellsCache.edges !== view.edges) {
      this.closedCellsCache = { nodes: view.nodes, edges: view.edges, result: buildClosedCells(view.nodes, view.edges) };
    }
    this.closedCells.render({ cells: this.closedCellsCache.result, color: WALL_COLOR, alpha: 1 }, cfg);

    const wallEdges = buildMazeWalls(view.nodes, view.edges, cfg);
    this.walls.render({ edges: wallEdges }, cfg);

    const nodeById = new Map(view.nodes.map(n => [n.id, n]));
    const markerData = buildMazeMarkers(nodeById, view.start, view.finish, cfg);
    this.markers.render({ markers: markerData });

    if (!state.showDebugFrontier) return;

    const debugVisible = state.debugMode && !!view.currentStep;
    if (!debugVisible || view.nodes.length === 0) {
      this.debugActive.render({ cells: [], color: DEBUG_ACTIVE_COLOR, alpha: DEBUG_ACTIVE_ALPHA }, cfg);
      this.debugSrc.render({ cells: [], color: DEBUG_CURRENT_SRC_COLOR, alpha: 0.8 }, cfg);
      return;
    }

    const activeCells: [number, number][] = [];
    for (const nodeId of view.currentStep!.active_nodes) {
      const node = nodeById.get(nodeId);
      if (node) activeCells.push([node.x, node.y]);
    }
    this.debugActive.render({ cells: activeCells, color: DEBUG_ACTIVE_COLOR, alpha: DEBUG_ACTIVE_ALPHA }, cfg);

    const srcCells: [number, number][] = [];
    if (view.currentStep!.current_src !== null) {
      const srcNode = nodeById.get(view.currentStep!.current_src);
      if (srcNode) srcCells.push([srcNode.x, srcNode.y]);
    }
    this.debugSrc.render({ cells: srcCells, color: DEBUG_CURRENT_SRC_COLOR, alpha: 0.8 }, cfg);
  }

  destroy(): void {
    this.unsubscribe?.();
    this.grid.destroy();
    this.floor.destroy();
    this.closedCells.destroy();
    this.walls.destroy();
    this.markers.destroy();
    this.debugActive.destroy();
    this.debugSrc.destroy();
    this.gridContainer.destroy();
    this.floorContainer.destroy();
    this.closedCellsContainer.destroy();
    this.wallsContainer.destroy();
    this.markersContainer.destroy();
    this.debugActiveContainer.destroy();
    this.debugSrcContainer.destroy();
  }
}


