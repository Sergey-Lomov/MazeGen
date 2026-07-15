import { Container } from "pixi.js";
import { useMazeStore } from "../store/mazeStore";
import { CellFillRenderer } from "./renderers/CellFillRenderer";
import { WallRenderer } from "./renderers/WallRenderer";
import { WaypointsRenderer } from "./renderers/WaypointsRenderer";
import { TeleportRenderer } from "./renderers/TeleportRenderer";
import { GridRenderer } from "./renderers/GridRenderer";
import { DebugRefHighlightOverlay } from "./DebugRefHighlightOverlay";
import { DebugValueHighlightOverlay } from "./DebugValueHighlightOverlay";
import { KruskalDsuHighlightOverlay } from "./KruskalDsuHighlightOverlay";
import { buildMazeWalls, buildMazeMarkers, buildTeleportEdges, buildClosedCells } from "./selectors/mazeSelectors";
import { selectDebugMazeView } from "../store/debugSelectors";
import type { DebugMazeView } from "../store/debugSelectors";
import type { NodeDto, EdgeDto } from "../wasm/types";
import type { Viewport, WallEdge, TeleportEdge } from "./renderers/types";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";
import type { DebugValueDescriptor, DebugValueKind } from "../debug/eventTape";
import { canvas, buildDebugValuePalette } from "./colorUtils";

export class GenerationRenderer {
  private readonly gridContainer: Container;
  private readonly floorContainer: Container;
  private readonly closedCellsContainer: Container;
  private readonly wallsContainer: Container;
  private readonly teleportContainer: Container;
  private readonly markersContainer: Container;
  private readonly debugRefHighlightContainer: Container;
  private readonly debugValueHighlightContainer: Container;
  private readonly kruskalDsuHighlightContainer: Container;

  private readonly grid: GridRenderer;
  private readonly floor: CellFillRenderer;
  private readonly closedCells: CellFillRenderer;
  private readonly walls: WallRenderer;
  private readonly teleports: TeleportRenderer;
  private readonly markers: WaypointsRenderer;
  private readonly debugRefHighlight: DebugRefHighlightOverlay;
  private readonly debugValueHighlight: DebugValueHighlightOverlay;
  private readonly kruskalDsuHighlight: KruskalDsuHighlightOverlay;

  private viewport: Viewport = { x: 0, y: 0, w: 0, h: 0, scale: 1 };
  private unsubscribe: (() => void) | null = null;

  // Keyed on the view's nodes/edges array identity (stable across debug steps that don't change
  // the reconstructed edge set) plus the tessellation config, since buildMazeWalls/buildMazeMarkers
  // depend on cell geometry too. Avoids rebuilding these O(nodes + edges) structures on every
  // debug-slider tick when the underlying view hasn't actually changed.
  private geometryCache: {
    nodes: NodeDto[];
    edges: EdgeDto[];
    cfg: TessellationConfig;
    closedCells: [number, number][];
    wallEdges: WallEdge[];
    teleportEdges: TeleportEdge[];
  } | null = null;

  // Keyed on `debugArena.debugValueNames` array identity, which is stable for a whole debug
  // session (only changes on a fresh `generate()`) — avoids rebuilding the palette and
  // name→color/kind lookup maps on every debug-step tick during scrubbing/autoplay.
  private debugValuePaletteCache: {
    descriptors: DebugValueDescriptor[];
    colorByName: Map<string, number>;
    kindByName: Map<string, DebugValueKind>;
  } | null = null;

  constructor(viewport: Container) {
    this.gridContainer = new Container();
    this.floorContainer = new Container();
    this.closedCellsContainer = new Container();
    this.wallsContainer = new Container();
    this.teleportContainer = new Container();
    this.markersContainer = new Container();
    this.debugRefHighlightContainer = new Container();
    this.debugValueHighlightContainer = new Container();
    this.kruskalDsuHighlightContainer = new Container();

    viewport.addChild(this.gridContainer);
    viewport.addChild(this.floorContainer);
    viewport.addChild(this.closedCellsContainer);
    viewport.addChild(this.wallsContainer);
    viewport.addChild(this.teleportContainer);
    viewport.addChild(this.markersContainer);
    viewport.addChild(this.debugRefHighlightContainer);
    viewport.addChild(this.debugValueHighlightContainer);
    viewport.addChild(this.kruskalDsuHighlightContainer);

    this.grid = new GridRenderer(this.gridContainer);
    this.floor = new CellFillRenderer(this.floorContainer);
    this.closedCells = new CellFillRenderer(this.closedCellsContainer);
    this.walls = new WallRenderer(this.wallsContainer);
    this.teleports = new TeleportRenderer(this.teleportContainer);
    this.markers = new WaypointsRenderer(this.markersContainer);
    this.debugRefHighlight = new DebugRefHighlightOverlay(this.debugRefHighlightContainer);
    this.debugValueHighlight = new DebugValueHighlightOverlay(this.debugValueHighlightContainer);
    this.kruskalDsuHighlight = new KruskalDsuHighlightOverlay(this.kruskalDsuHighlightContainer);

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
        state.debugStep !== prev.debugStep ||
        state.hoveredDebugRef !== prev.hoveredDebugRef ||
        state.debugValueToggles !== prev.debugValueToggles ||
        state.showKruskalDsuGroups !== prev.showKruskalDsuGroups;

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
    this.debugRefHighlightContainer.visible = visible;
    this.debugValueHighlightContainer.visible = visible;
    this.kruskalDsuHighlightContainer.visible = visible;
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

  private debugView(state: ReturnType<typeof useMazeStore.getState>, debugMazeView: DebugMazeView | null) {
    return {
      nodes: debugMazeView ? debugMazeView.nodes : state.nodes,
      edges: debugMazeView ? debugMazeView.edges : state.edges,
      // Debug replay doesn't reconstruct start/finish yet — RB doesn't emit events for them
      // (see Specs/event_log.md), so they must stay hidden rather than showing the final
      // post-generation values from the very first step.
      start: state.debugMode ? null : state.start,
      finish: state.debugMode ? null : state.finish,
    };
  }

  private renderAll(state: ReturnType<typeof useMazeStore.getState>): void {
    const cfg = state.nodes.length > 0 ? state.activeTessellationConfig : state.tessellationConfig;
    this.grid.render({ viewport: this.viewport }, cfg);
    // Single call, reused below for both highlight overlays — selectDebugMazeView is itself
    // memoized per (arena, debugStep), but calling it three times per render still meant three
    // redundant lookups/comparisons for no benefit now that the result is just a local variable.
    const debugMazeView = state.debugMode ? selectDebugMazeView(state.debugArena, state.debugStep) : null;
    const view = this.debugView(state, debugMazeView);

    const cells: [number, number][] = view.nodes.map(n => [n.x, n.y]);
    this.floor.render({ cells, color: canvas.floor.default, alpha: 1 }, cfg);

    const nodeById = new Map(view.nodes.map(n => [n.id, n]));

    if (!this.geometryCache || this.geometryCache.nodes !== view.nodes || this.geometryCache.edges !== view.edges || this.geometryCache.cfg !== cfg) {
      this.geometryCache = {
        nodes: view.nodes,
        edges: view.edges,
        cfg,
        closedCells: buildClosedCells(view.nodes, view.edges),
        wallEdges: buildMazeWalls(view.nodes, view.edges, cfg),
        teleportEdges: buildTeleportEdges(nodeById, view.edges, cfg),
      };
    }
    this.closedCells.render({ cells: this.geometryCache.closedCells, color: canvas.wall.default, alpha: 1 }, cfg);
    this.walls.render({ edges: this.geometryCache.wallEdges }, cfg);
    this.teleports.render({ edges: this.geometryCache.teleportEdges });

    const markerData = buildMazeMarkers(nodeById, view.start, view.finish, cfg);
    this.markers.render({ markers: markerData });

    // Debug-tree ref highlighting (GitHub issue #130) — only meaningful while the debug panel is
    // open; `hoveredDebugRef` is itself reset to `null` on `setDebugMode(false)` (see
    // `generationSlice.ts`), so this gate and that reset both independently prevent a stale
    // highlight from surviving debug mode being closed.
    if (state.debugMode) {
      this.debugRefHighlight.render({ nodes: view.nodes, ref: state.hoveredDebugRef, cfg });
    } else {
      this.debugRefHighlight.clear();
    }

    // Persistent debug-value toggle highlighting (GitHub issue #131) — same debugMode gate as
    // debugRefHighlight above, but driven by debugValueToggles instead of a hover ref.
    if (state.debugMode && state.debugValueToggles.size > 0) {
      const descriptors = state.debugArena?.debugValueNames ?? [];
      if (!this.debugValuePaletteCache || this.debugValuePaletteCache.descriptors !== descriptors) {
        const palette = buildDebugValuePalette(descriptors.length);
        this.debugValuePaletteCache = {
          descriptors,
          colorByName: new Map(descriptors.map(({ name }, i) => [name, palette[i]])),
          kindByName: new Map(descriptors.map(({ name, kind }) => [name, kind])),
        };
      }
      const { colorByName, kindByName } = this.debugValuePaletteCache;
      this.debugValueHighlight.render({
        nodes: view.nodes,
        debugValues: debugMazeView?.debugValues ?? new Map(),
        debugMaps: debugMazeView?.debugMaps ?? new Map(),
        debugVertices: debugMazeView?.debugVertices ?? new Map(),
        toggles: state.debugValueToggles,
        kindFor: (name) => kindByName.get(name) ?? "region",
        colorFor: (name) => colorByName.get(name) ?? canvas.debug.refHighlight,
        cfg,
      });
    } else {
      this.debugValueHighlight.clear();
    }

    // Kruskal DSU-groups highlighting (GitHub issue #146) — one on/off toggle (`showKruskalDsuGroups`),
    // not a `debugValueToggles`-style named set: DSU groups are the algorithm's core state (not a
    // named, user-selectable value), so there's a single switch rather than one per group.
    if (state.debugMode && state.debugArena?.algorithmKind === "kruskal" && state.showKruskalDsuGroups) {
      this.kruskalDsuHighlight.render({ nodes: view.nodes, dsuGroups: debugMazeView?.dsuGroups ?? null, cfg });
    } else {
      this.kruskalDsuHighlight.clear();
    }
  }

  destroy(): void {
    this.unsubscribe?.();
    this.grid.destroy();
    this.floor.destroy();
    this.closedCells.destroy();
    this.walls.destroy();
    this.teleports.destroy();
    this.markers.destroy();
    this.debugRefHighlight.destroy();
    this.debugValueHighlight.destroy();
    this.kruskalDsuHighlight.destroy();
    this.gridContainer.destroy();
    this.floorContainer.destroy();
    this.closedCellsContainer.destroy();
    this.wallsContainer.destroy();
    this.teleportContainer.destroy();
    this.markersContainer.destroy();
    this.debugRefHighlightContainer.destroy();
    this.debugValueHighlightContainer.destroy();
    this.kruskalDsuHighlightContainer.destroy();
  }
}


