import { Container } from "pixi.js";
import { useMazeStore } from "../store/mazeStore";
import { MazeTileRenderer } from "./MazeTileRenderer";
import { ComponentRenderer } from "./ComponentRenderer";
import { MazeGraphRenderer, NavGraphRenderer } from "./MazeRenderer";
import { RouteOverlay } from "./RouteOverlay";

export class GenerationRenderer {
  private readonly viewport: Container;
  private readonly componentOverlay: Container;
  private readonly graphOverlay: Container;
  private readonly navOverlay: Container;
  private readonly routeOverlayContainer: Container;

  private readonly tileRenderer: MazeTileRenderer;
  private readonly componentRenderer: ComponentRenderer;
  private readonly graphRenderer: MazeGraphRenderer;
  private readonly navRenderer: NavGraphRenderer;
  private readonly routeOverlay: RouteOverlay;

  private unsubscribe: (() => void) | null = null;

  constructor(
    viewport: Container,
    componentOverlay: Container,
    graphOverlay: Container,
    navOverlay: Container,
    routeOverlayContainer: Container,
  ) {
    this.viewport = viewport;
    this.componentOverlay = componentOverlay;
    this.graphOverlay = graphOverlay;
    this.navOverlay = navOverlay;
    this.routeOverlayContainer = routeOverlayContainer;

    this.tileRenderer = new MazeTileRenderer(this.viewport);
    this.componentRenderer = new ComponentRenderer(this.componentOverlay);

    this.graphRenderer = new MazeGraphRenderer(this.graphOverlay);
    this.navRenderer = new NavGraphRenderer(this.navOverlay);

    this.routeOverlay = new RouteOverlay(this.routeOverlayContainer);

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
        state.showComponents !== prev.showComponents ||
        state.showGraphOverlay !== prev.showGraphOverlay ||
        state.showNavOverlay !== prev.showNavOverlay ||
        state.showRoute !== prev.showRoute;

      if (visibilityChanged) {
        this.syncVisibility(state);
      }

      const dataChanged =
        state.nodes !== prev.nodes ||
        state.edges !== prev.edges ||
        state.start !== prev.start ||
        state.finish !== prev.finish ||
        state.navNodes !== prev.navNodes ||
        state.navEdges !== prev.navEdges ||
        state.components !== prev.components ||
        state.routeInfo !== prev.routeInfo ||
        state.activeTessellationConfig !== prev.activeTessellationConfig ||
        state.debugMode !== prev.debugMode ||
        state.debugSnapshot !== prev.debugSnapshot ||
        state.debugStep !== prev.debugStep;

      const graphDisplayChanged =
        state.showNodeIds !== prev.showNodeIds ||
        state.showCoords !== prev.showCoords ||
        state.selectedNode !== prev.selectedNode;

      if (dataChanged) {
        this.renderAll(state);
      } else if (graphDisplayChanged) {
        this.renderGraph(state);
      }

      prev = state;
    });
  }

  private syncVisibility(state: ReturnType<typeof useMazeStore.getState>): void {
    const open = state.generationOpen;
    this.viewport.visible              = open && state.showMaze;
    this.componentOverlay.visible      = open && state.showComponents;
    this.graphOverlay.visible          = open && state.showGraphOverlay;
    this.navOverlay.visible            = open && state.showNavOverlay;
    this.routeOverlayContainer.visible = open && state.showRoute;
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
    const cfg = state.activeTessellationConfig;
    const view = this.debugView(state);

    this.tileRenderer.render({
      nodes: view.nodes,
      edges: view.edges,
      start: view.start,
      finish: view.finish,
      cfg,
      debugVisible: state.debugMode && !!view.currentStep,
      activeNodes: view.currentStep?.active_nodes ?? [],
      currentSrc: view.currentStep?.current_src ?? null,
    });

    this.componentRenderer.render({
      nodes: state.nodes,
      components: state.components,
      cfg,
    });

    this.renderGraph(state, view);

    this.navRenderer.render({
      nodes: state.nodes,
      navNodes: state.navNodes,
      navEdges: state.navEdges,
      start: state.start,
      finish: state.finish,
      cfg,
    });

    this.routeOverlay.render({
      routeInfo: state.routeInfo,
      nodes: state.nodes,
      cfg,
    });
  }

  private renderGraph(
    state: ReturnType<typeof useMazeStore.getState>,
    view = this.debugView(state),
  ): void {
    const cfg = state.activeTessellationConfig;

    this.graphRenderer.render({
      nodes: view.nodes,
      edges: view.edges,
      showNodeIds: state.showNodeIds,
      showCoords: state.showCoords,
      selectedNode: state.selectedNode,
      start: view.start,
      finish: view.finish,
      cfg,
    });
  }

  destroy(): void {
    this.unsubscribe?.();
    this.tileRenderer.destroy();
    this.componentRenderer.destroy();
    this.graphRenderer.destroy();
    this.navRenderer.destroy();
    this.routeOverlay.destroy();
  }
}
