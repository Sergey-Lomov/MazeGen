import { Container } from "pixi.js";
import { useMazeStore } from "../store/mazeStore";
import { RegionsRenderer } from "./RegionsRenderer";
import { MazeOverlayRenderer } from "./MazeOverlayRenderer";
import { GridRenderer } from "./renderers/GridRenderer";
import { MazeGraphRenderer } from "./MazeRenderer";
import { NavGraphRenderer } from "./MazeRenderer";
import { RouteOverlay } from "./RouteOverlay";
import type { Viewport } from "./renderers/types";

export class AnalyticsRenderer {
  private readonly gridContainer: Container;
  private readonly floorContainer: Container;
  private readonly regionsContainer: Container;
  private readonly wallsContainer: Container;
  private readonly markersContainer: Container;
  private readonly graphContainer: Container;
  private readonly navGraphContainer: Container;
  private readonly routeContainer: Container;

  private readonly grid: GridRenderer;
  private readonly mazeOverlay: MazeOverlayRenderer;
  private readonly regionsRenderer: RegionsRenderer;
  private readonly graphRenderer: MazeGraphRenderer;
  private readonly navGraphRenderer: NavGraphRenderer;
  private readonly routeRenderer: RouteOverlay;

  private viewport: Viewport = { x: 0, y: 0, w: 0, h: 0, scale: 1 };
  private unsubscribe: (() => void) | null = null;

  constructor(container: Container) {
    this.gridContainer = new Container();
    this.floorContainer = new Container();
    this.regionsContainer = new Container();
    this.wallsContainer = new Container();
    this.markersContainer = new Container();
    this.graphContainer = new Container();
    this.navGraphContainer = new Container();
    this.routeContainer = new Container();

    container.addChild(this.gridContainer);
    container.addChild(this.floorContainer);
    container.addChild(this.regionsContainer);
    container.addChild(this.wallsContainer);
    container.addChild(this.markersContainer);
    container.addChild(this.graphContainer);
    container.addChild(this.navGraphContainer);
    container.addChild(this.routeContainer);

    this.grid = new GridRenderer(this.gridContainer);
    this.mazeOverlay = new MazeOverlayRenderer({
      floor: this.floorContainer,
      walls: this.wallsContainer,
      markers: this.markersContainer,
    });
    this.regionsRenderer = new RegionsRenderer(this.regionsContainer);
    this.graphRenderer = new MazeGraphRenderer(this.graphContainer);
    this.navGraphRenderer = new NavGraphRenderer(this.navGraphContainer);
    this.routeRenderer = new RouteOverlay(this.routeContainer);

    this.syncAll(useMazeStore.getState());
    this.subscribe();
  }

  private subscribe(): void {
    let prev = useMazeStore.getState();
    this.unsubscribe = useMazeStore.subscribe((state) => {
      const visibilityChanged =
        state.analyticsOpen !== prev.analyticsOpen ||
        state.showMazeOverlay !== prev.showMazeOverlay ||
        state.showComponentsOverlay !== prev.showComponentsOverlay ||
        state.showGraphOverlay !== prev.showGraphOverlay ||
        state.showNavGraphOverlay !== prev.showNavGraphOverlay ||
        state.showRouteOverlay !== prev.showRouteOverlay;

      const dataChanged =
        state.nodes !== prev.nodes ||
        state.edges !== prev.edges ||
        state.components !== prev.components ||
        state.navNodes !== prev.navNodes ||
        state.navEdges !== prev.navEdges ||
        state.routeInfo !== prev.routeInfo ||
        state.start !== prev.start ||
        state.finish !== prev.finish ||
        state.activeTessellationConfig !== prev.activeTessellationConfig;

      if (visibilityChanged || dataChanged) {
        this.syncAll(state);
      }

      prev = state;
    });
  }

  private syncAll(state: ReturnType<typeof useMazeStore.getState>): void {
    const { analyticsOpen, nodes, edges, components, navNodes, navEdges, routeInfo,
      start, finish, activeTessellationConfig: cfg,
      showMazeOverlay, showComponentsOverlay, showGraphOverlay, showNavGraphOverlay, showRouteOverlay } = state;

    // Maze overlay (grid + floor + walls + markers)
    const showMaze = analyticsOpen && showMazeOverlay && nodes.length > 0;
    this.gridContainer.visible = showMaze;
    this.floorContainer.visible = showMaze;
    this.wallsContainer.visible = showMaze;
    this.markersContainer.visible = showMaze;
    if (showMaze) {
      this.grid.render({ viewport: this.viewport }, cfg);
      this.mazeOverlay.render({ nodes, edges, start, finish, cfg });
    }

    // Regions overlay
    const showRegions = analyticsOpen && showComponentsOverlay && components.length > 0;
    this.regionsContainer.visible = showRegions;
    if (showRegions) {
      this.regionsRenderer.render({ nodes, components, cfg });
    }

    // Graph overlay
    const showGraph = analyticsOpen && showGraphOverlay && nodes.length > 0;
    this.graphContainer.visible = showGraph;
    if (showGraph) {
      this.graphRenderer.render({
        nodes, edges,
        showNodeIds: false,
        showCoords: false,
        selectedNode: null,
        start, finish, cfg,
        interactive: false,
      });
    }

    // Nav graph overlay
    const showNavGraph = analyticsOpen && showNavGraphOverlay && navNodes.length > 0;
    this.navGraphContainer.visible = showNavGraph;
    if (showNavGraph) {
      this.navGraphRenderer.render({ nodes, navNodes, navEdges, start, finish, cfg });
    }

    // Route overlay
    const showRoute = analyticsOpen && showRouteOverlay && routeInfo != null;
    this.routeContainer.visible = showRoute;
    if (showRoute) {
      this.routeRenderer.render({ routeInfo, nodes, cfg });
    } else {
      this.routeRenderer.clear();
    }
  }

  onViewportChanged(x: number, y: number, w: number, h: number, scale: number): void {
    this.viewport = { x, y, w, h, scale };
    const state = useMazeStore.getState();
    if (state.analyticsOpen && state.showMazeOverlay && state.nodes.length > 0) {
      this.grid.render({ viewport: this.viewport }, state.activeTessellationConfig);
    }
  }

  destroy(): void {
    this.unsubscribe?.();
    this.grid.destroy();
    this.mazeOverlay.destroy();
    this.regionsRenderer.destroy();
    this.graphRenderer.destroy();
    this.navGraphRenderer.destroy();
    this.routeRenderer.destroy();
    this.gridContainer.destroy();
    this.floorContainer.destroy();
    this.regionsContainer.destroy();
    this.wallsContainer.destroy();
    this.markersContainer.destroy();
    this.graphContainer.destroy();
    this.navGraphContainer.destroy();
    this.routeContainer.destroy();
  }
}
