import { Container } from "pixi.js";
import { useMazeStore } from "../store/mazeStore";
import { CellFillRenderer } from "./renderers/CellFillRenderer";
import { WallRenderer } from "./renderers/WallRenderer";
import { WaypointsRenderer } from "./renderers/WaypointsRenderer";
import { TeleportRenderer } from "./renderers/TeleportRenderer";
import { GridRenderer } from "./renderers/GridRenderer";
import { SplitJunctionRenderer, collectSplitWallPaths } from "./renderers/SplitJunctionRenderer";
import { layoutEditorMarkers } from "./editorMarkerLayout";
import { VerticalConnectionRenderer, DEFAULT_VERTICAL_STYLE } from "./renderers/VerticalConnectionRenderer";
import { DebugRefHighlightOverlay } from "./DebugRefHighlightOverlay";
import { DebugValueHighlightOverlay } from "./DebugValueHighlightOverlay";
import { KruskalDsuHighlightOverlay } from "./KruskalDsuHighlightOverlay";
import { buildMazeWalls, buildMazeMarkers, buildTeleportEdges, buildTeleportFloorInputs, buildClosedCells, buildSplitPassages, selectFloorScopedMaze, selectNodeLevelResolver, buildVerticalConnectionMarkers, selectVerticalPassagePairSet, buildTeleportAvoidanceWaypoints } from "./selectors/mazeSelectors";
import { selectDebugMazeView } from "../store/debugSelectors";
import type { DebugMazeView } from "../store/debugSelectors";
import type { NodeDto, EdgeDto } from "../wasm/types";
import type { Viewport, WallEdge, TeleportEdge, SplitPassage, SplitSpecialShape, VerticalConnectionMarker } from "./renderers/types";
import type { FieldConfig } from "../fieldConfig";
import type { DebugValueDescriptor, DebugValueKind } from "../debug/eventTape";
import { canvas } from "./colorTokens";
import { resolveDebugValueColor } from "./debugValueColors";
import { DEFAULT_MAZE_RENDER_STYLE } from "./defaultMazeRenderStyle";
import { oneWayIndicatorSpan } from "./renderers/wallUtils";


export class GenerationRenderer {
  private readonly gridContainer: Container;
  private readonly floorContainer: Container;
  private readonly closedCellsContainer: Container;
  private readonly wallsContainer: Container;
  private readonly splitJunctionContainer: Container;
  private readonly teleportContainer: Container;
  private readonly verticalContainer: Container;
  private readonly markersContainer: Container;
  private readonly debugRefHighlightContainer: Container;
  private readonly debugValueHighlightContainer: Container;
  private readonly kruskalDsuHighlightContainer: Container;

  private readonly grid: GridRenderer;
  private readonly floor: CellFillRenderer;
  private readonly closedCells: CellFillRenderer;
  private readonly walls: WallRenderer;
  private readonly splitJunctions: SplitJunctionRenderer;
  private readonly teleports: TeleportRenderer;
  private readonly verticalConnections: VerticalConnectionRenderer;
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
    cfg: FieldConfig;
    start: number | null;
    finish: number | null;
    closedCells: [number, number][];
    wallEdges: WallEdge[];
    teleportEdges: TeleportEdge[];
    splitPassages: SplitPassage[];
    splitWallFaces: { v0: { x: number; y: number }; v1: { x: number; y: number } }[];
    splitSpecialShapes: SplitSpecialShape[];
    verticalConnectionMarkers: VerticalConnectionMarker[];
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
    this.splitJunctionContainer = new Container();
    this.teleportContainer = new Container();
    this.verticalContainer = new Container();
    this.markersContainer = new Container();
    this.debugRefHighlightContainer = new Container();
    this.debugValueHighlightContainer = new Container();
    this.kruskalDsuHighlightContainer = new Container();

    viewport.addChild(this.gridContainer);
    viewport.addChild(this.floorContainer);
    viewport.addChild(this.closedCellsContainer);
    viewport.addChild(this.wallsContainer);
    viewport.addChild(this.splitJunctionContainer);
    viewport.addChild(this.teleportContainer);
    viewport.addChild(this.verticalContainer);
    viewport.addChild(this.markersContainer);
    viewport.addChild(this.debugValueHighlightContainer);
    // Hovered debug refs (including cell/region highlights) must stay above persistent debug-value
    // layers so the active event remains readable while frontier/reserve/visited are toggled on.
    viewport.addChild(this.debugRefHighlightContainer);
    viewport.addChild(this.kruskalDsuHighlightContainer);

    this.grid = new GridRenderer(this.gridContainer);
    this.floor = new CellFillRenderer(this.floorContainer);
    this.closedCells = new CellFillRenderer(this.closedCellsContainer);
    this.walls = new WallRenderer(this.wallsContainer);
    this.splitJunctions = new SplitJunctionRenderer(this.splitJunctionContainer);
    this.teleports = new TeleportRenderer(this.teleportContainer);
    this.verticalConnections = new VerticalConnectionRenderer(this.verticalContainer);
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
        state._generatedNodes !== prev._generatedNodes ||
        state._generatedEdges !== prev._generatedEdges ||
        state.start !== prev.start ||
        state.finish !== prev.finish ||
        state.activeFloorId !== prev.activeFloorId ||
        state.floors !== prev.floors ||
        state.floorFields[state.activeFloorId].fieldConfig !== prev.floorFields[prev.activeFloorId]?.fieldConfig ||
        state.activeFieldConfig !== prev.activeFieldConfig ||
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
    this.splitJunctionContainer.visible = visible;
    this.teleportContainer.visible = visible;
    this.verticalContainer.visible = visible;
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
      const cfg = state._generatedNodes.length > 0 ? state.activeFieldConfig : state.floorFields[state.activeFloorId].fieldConfig;
      this.grid.render({ viewport: this.viewport }, cfg);
    }
  }

  // Reads `_generatedNodes`/`_generatedEdges`, not `state.nodes`/`state.edges` — the latter are
  // overwritten by every confirmPostEdit with the current (possibly manually-edited) graph so
  // other consumers (PostEditController/PostEditRenderer/ManageSplitNodesDialog/AnalyticsRenderer)
  // keep seeing confirmed post-edit state. The Generation feature must always show the generation
  // result itself, unaffected by post-edit, so it needs its own frozen snapshot (GitHub issue #323).
  //
  // GitHub issue #337: `_generatedNodes`/`_generatedEdges` (and, during a debug replay,
  // `debugMazeView.nodes`/`.edges` — its underlying node ledger now resolves `level` too, see
  // `runner.rs`'s `debug_all_nodes` comment) can span every floor — generation is the one path
  // that's multi-level-aware (see `MultiLevelField::single_level_id`'s doc comment) — so they're
  // filtered down to `activeFloorId` here, the only place that needs to know about floors at all.
  // Everything downstream (walls/teleports/split-passages/markers) just sees a normal single-floor
  // node/edge set — without this, nodes from different floors sharing the same (x, y) would get
  // mistaken for a split point by `buildSplitPassages`'s per-point grouping.
  private debugView(state: ReturnType<typeof useMazeStore.getState>, debugMazeView: DebugMazeView | null) {
    if (debugMazeView) {
      return selectFloorScopedMaze(
        debugMazeView.nodes, debugMazeView.edges, state.floors, state.activeFloorId,
        debugMazeView.start, debugMazeView.finish,
      );
    }
    return selectFloorScopedMaze(
      state._generatedNodes, state._generatedEdges, state.floors, state.activeFloorId,
      state.start, state.finish,
    );
  }

  private renderAll(state: ReturnType<typeof useMazeStore.getState>): void {
    const cfg = state._generatedNodes.length > 0 ? state.activeFieldConfig : state.floorFields[state.activeFloorId].fieldConfig;
    this.grid.render({ viewport: this.viewport }, cfg);
    // Single call, reused below for both highlight overlays — selectDebugMazeView is itself
    // memoized per (arena, debugStep), but calling it three times per render still meant three
    // redundant lookups/comparisons for no benefit now that the result is just a local variable.
    const debugMazeView = state.debugMode ? selectDebugMazeView(state.debugArena, state.debugStep) : null;
    const view = this.debugView(state, debugMazeView);
    const unscopedNodes = debugMazeView ? debugMazeView.nodes : state._generatedNodes;
    const unscopedEdges = debugMazeView ? debugMazeView.edges : state._generatedEdges;
    const activeFloorIndex = state.floors.findIndex(f => f.id === state.activeFloorId);

    const cells: [number, number][] = view.nodes.map(n => [n.x, n.y]);
    this.floor.render({ cells, color: canvas.floor.default, alpha: 1 }, cfg);

    const nodeById = new Map(view.nodes.map(n => [n.id, n]));
    const unscopedNodeById = new Map(unscopedNodes.map(n => [n.id, n]));

    if (
      !this.geometryCache ||
      this.geometryCache.nodes !== view.nodes ||
      this.geometryCache.edges !== view.edges ||
      this.geometryCache.cfg !== cfg ||
      this.geometryCache.start !== view.start ||
      this.geometryCache.finish !== view.finish
    ) {
      // A split node carrying a start/finish marker or a teleport endpoint always keeps its hub
      // point (see buildSplitPassages's straightening exception) — see PostEditRenderer's
      // identical specialNodeIds construction.
      const specialNodeIds = new Set<number>();
      if (view.start !== null) specialNodeIds.add(view.start);
      if (view.finish !== null) specialNodeIds.add(view.finish);
      for (const e of view.edges) {
        if (e.kind === "teleport") { specialNodeIds.add(e.from); specialNodeIds.add(e.to); }
      }

      const { passages: splitPassages, wallFaces: splitWallFaces, specialShapes: splitSpecialShapes } =
        buildSplitPassages(view.nodes, view.edges, cfg, specialNodeIds);
      const resolveNodeLevel = selectNodeLevelResolver(unscopedNodes);
      this.geometryCache = {
        nodes: view.nodes,
        edges: view.edges,
        cfg,
        start: view.start,
        finish: view.finish,
        closedCells: buildClosedCells(view.nodes, view.edges, unscopedEdges),
        wallEdges: buildMazeWalls(view.nodes, view.edges, cfg),
        teleportEdges: (() => {
          const { floorContext, spread } = buildTeleportFloorInputs({
            unscopedNodes,
            unscopedEdges,
            floors: state.floors,
            activeFloorId: state.activeFloorId,
            start: view.start,
            finish: view.finish,
            allowOutOfField: true,
          });
          return buildTeleportEdges(nodeById, view.edges, cfg, floorContext, spread);
        })(),
        splitPassages,
        splitWallFaces,
        splitSpecialShapes,
        verticalConnectionMarkers: buildVerticalConnectionMarkers(
          nodeById, view.edges, cfg, resolveNodeLevel, activeFloorIndex,
          selectVerticalPassagePairSet(unscopedEdges), unscopedEdges,
        ),
      };
    }
    this.closedCells.render({ cells: this.geometryCache.closedCells, color: canvas.wall.default, alpha: 1 }, cfg);
    const { paths: extraWalls, noCapPoints } = collectSplitWallPaths(
      this.geometryCache.splitWallFaces,
      this.geometryCache.splitSpecialShapes,
    );
    this.walls.render({ edges: this.geometryCache.wallEdges }, cfg, undefined, undefined, extraWalls, noCapPoints);
    this.splitJunctions.render({
      passages: this.geometryCache.splitPassages,
      wallFaces: this.geometryCache.splitWallFaces,
      specialShapes: this.geometryCache.splitSpecialShapes,
    });
    const layout = layoutEditorMarkers({
      markers: buildMazeMarkers(nodeById, view.start, view.finish, cfg, undefined, undefined, view.edges),
      teleportEdges: this.geometryCache.teleportEdges,
      verticalMarkers: this.geometryCache.verticalConnectionMarkers,
      nodeById, edges: view.edges, cfg,
    });
    const markerData = layout.markers;
    // Keep orthogonal teleport connectors from cutting through start/finish markers (GitHub issue
    // #300), same as the image-export renderers — regressed on this live canvas (GitHub issue #516).
    // Also avoid vertical passage/elevator markers and one-way wall indicators (GitHub issue #518).
    const teleportWaypoints = buildTeleportAvoidanceWaypoints({
      markers: markerData,
      verticalMarkers: layout.verticalMarkers,
      oneWayWallEdges: this.geometryCache.wallEdges,
      cfg,
      splitPassages: this.geometryCache.splitPassages,
    });
    this.teleports.render({ edges: layout.teleportEdges, cfg, floorNavigable: true, waypoints: teleportWaypoints });
    this.verticalConnections.render({ markers: layout.verticalMarkers, style: DEFAULT_VERTICAL_STYLE, interactive: true });

    this.markers.render({ markers: markerData });

    // Debug-tree ref highlighting (GitHub issue #130) — only meaningful while the debug panel is
    // open; `hoveredDebugRef` is itself reset to `null` on `setDebugMode(false)` (see
    // `generationSlice.ts`), so this gate and that reset both independently prevent a stale
    // highlight from surviving debug mode being closed.
    if (state.debugMode) {
      this.debugRefHighlight.render({
        nodes: view.nodes,
        allNodes: state.debugArena?.allNodes ?? [],
        edges: view.edges,
        ref: state.hoveredDebugRef,
        cfg,
        resolveNodeLevel: selectNodeLevelResolver(unscopedNodes),
        resolveNodeCell: (id) => {
          const node = unscopedNodeById.get(id);
          return node ? [node.x, node.y] : undefined;
        },
        activeFloorIndex: Math.max(activeFloorIndex, 0),
        oneWayBoundaryWidth: oneWayIndicatorSpan(DEFAULT_MAZE_RENDER_STYLE.oneWay),
      });
    } else {
      this.debugRefHighlight.clear();
    }

    // Persistent debug-value toggle highlighting (GitHub issue #131) — same debugMode gate as
    // debugRefHighlight above, but driven by debugValueToggles instead of a hover ref.
    if (state.debugMode && state.debugValueToggles.size > 0) {
      const descriptors = state.debugArena?.debugValueNames ?? [];
      if (!this.debugValuePaletteCache || this.debugValuePaletteCache.descriptors !== descriptors) {
        const scope = state.debugArena?.algorithmKind ?? "";
        this.debugValuePaletteCache = {
          descriptors,
          colorByName: new Map(
            descriptors.map(({ name }, i) => [name, resolveDebugValueColor(scope, name, i)]),
          ),
          kindByName: new Map(descriptors.map(({ name, kind }) => [name, kind])),
        };
      }
      const { colorByName, kindByName } = this.debugValuePaletteCache;
      // Debug values are qualified when the arena contains several sources (for example
      // `generation:frontier`). Match the semantic name after the scope prefix so the custom
      // vertex-based algorithm keeps frontier/reserve as independent cells in both layouts.
      const singleCellRegionNames = state.debugArena?.algorithmKind === "vertex_based"
        ? new Set(
          descriptors
            .map(({ name }) => name)
            .filter((name) => {
              const baseName = name.slice(name.lastIndexOf(":") + 1);
              return baseName === "frontier" || baseName === "reserve";
            }),
        )
        : undefined;
      this.debugValueHighlight.render({
        nodes: view.nodes,
        debugValues: debugMazeView?.debugValues ?? new Map(),
        debugMaps: debugMazeView?.debugMaps ?? new Map(),
        debugVertices: debugMazeView?.debugVertices ?? new Map(),
        toggles: state.debugValueToggles,
        kindFor: (name) => kindByName.get(name) ?? "region",
        colorFor: (name) => colorByName.get(name) ?? canvas.debug.refHighlight,
        singleCellRegionNames,
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
    this.splitJunctions.destroy();
    this.teleports.destroy();
    this.verticalConnections.destroy();
    this.markers.destroy();
    this.debugRefHighlight.destroy();
    this.debugValueHighlight.destroy();
    this.kruskalDsuHighlight.destroy();
    this.gridContainer.destroy();
    this.floorContainer.destroy();
    this.closedCellsContainer.destroy();
    this.wallsContainer.destroy();
    this.splitJunctionContainer.destroy();
    this.teleportContainer.destroy();
    this.verticalContainer.destroy();
    this.markersContainer.destroy();
    this.debugRefHighlightContainer.destroy();
    this.debugValueHighlightContainer.destroy();
    this.kruskalDsuHighlightContainer.destroy();
  }
}


