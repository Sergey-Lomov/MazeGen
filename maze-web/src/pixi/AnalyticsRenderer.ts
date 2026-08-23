import { Container } from "pixi.js";
import { useMazeStore } from "../store/mazeStore";
import { RegionsRenderer } from "./RegionsRenderer";
import { RegionClassesRenderer } from "./RegionClassesRenderer";
import { MazeOverlayRenderer } from "./MazeOverlayRenderer";
import { GridRenderer } from "./renderers/GridRenderer";
import { MazeGraphRenderer } from "./MazeGraphRenderer";
import { NavGraphRenderer } from "./NavGraphRenderer";
import { RouteOverlay } from "./RouteOverlay";
import { PureCyclesOverlay } from "./PureCyclesOverlay";
import { IssueHighlightOverlay } from "./IssueHighlightOverlay";
import { VerticalConnectionRenderer, type VerticalConnectionStyle } from "./renderers/VerticalConnectionRenderer";
import { postEditEdgesToDto, selectFloorScopedMaze, selectNodeLevelResolver, selectVerticalPassagePairSet, buildVerticalConnectionMarkers, buildTeleportEdges, type TeleportFloorContext } from "./selectors/mazeSelectors";
import { type PostEditEndpoint, resolveEndpoint, buildSplitNodeResolver, floorScopedEndpoint } from "./postEditEndpoint";
import { recordOnLevel } from "./fieldEditUtils";
import { activeFloorLevel } from "../store/storeHelpers";
import type { Viewport } from "./renderers/types";
import type { PostEditEdge } from "../store/mazeStore";
import { canvas } from "./colorTokens";

/** Dark accent for a one-way passage marker's entry border / exit fill (GitHub issue #347 fourth
 *  follow-up) — mirrors `DEFAULT_VERTICAL_SETTINGS`'s own `ONE_WAY_ACCENT_DARK` (`imageExportDefaults.ts`),
 *  kept as a separate copy per `maze-web/CLAUDE.md`'s feature-renderer ownership rule. */
const ONE_WAY_ACCENT_DARK = 0x196c64;

/** Fixed style for `VerticalConnectionRenderer` — Analytics has no settings panel of its own for
 *  this, so it always uses this one look, mirroring `PostEditRenderer`'s own `DEFAULT_VERTICAL_STYLE`
 *  — kept as a separate copy per `maze-web/CLAUDE.md`'s feature-renderer ownership rule (no shared
 *  renderer instances/constants across features). */
const DEFAULT_VERTICAL_STYLE: VerticalConnectionStyle = {
  style: "abstract",
  twoWayPassageMarker: {
    shape: "circle",
    cornerStyle: "round",
    fillColor: canvas.vertical.default,
    borderColor: canvas.vertical.default,
    borderWidth: 3,
    gapWidth: 3,
    gapColor: canvas.floor.default,
    size: 0.22,
  },
  oneWayPassageMarker: {
    shape: "circle",
    cornerStyle: "round",
    fillColor: canvas.vertical.default,
    borderColor: canvas.vertical.default,
    borderWidth: 3,
    gapWidth: 3,
    gapColor: canvas.floor.default,
    size: 0.22,
  },
  elevatorMarker: {
    shape: "diamond",
    cornerStyle: "round",
    fillColor: canvas.vertical.default,
    borderColor: canvas.vertical.default,
    borderWidth: 3,
    gapWidth: 3,
    gapColor: canvas.floor.default,
    size: 0.22,
  },
  twoWayArrowColor: canvas.floor.default,
  twoWayArrowSize: 0.75,
  twoWayArrowStyle: "triangle",
  twoWayArrowCornerStyle: "round",
  oneWayArrowColor: canvas.floor.default,
  oneWayArrowSize: 0.75,
  oneWayArrowStyle: "triangle",
  oneWayArrowCornerStyle: "round",
  oneWayAccentColor: ONE_WAY_ACCENT_DARK,
  elevatorArrowColor: canvas.floor.default,
  elevatorArrowSize: 0.75,
  elevatorArrowStyle: "triangle",
  elevatorArrowCornerStyle: "round",
  // `style: "abstract"` above means these decorative fields (GitHub issue #428) are never actually
  // read — filled in only to satisfy `VerticalConnectionStyle`'s type.
  decorativeStairsTwoWay: { lineColor: canvas.vertical.default, lineWidth: 3, size: 0.22 },
  decorativeStairsOneWay: { lineColor: canvas.vertical.default, lineWidth: 3, size: 0.22 },
  decorativeElevator: { lineColor: canvas.vertical.default, lineWidth: 3, size: 0.22 },
  decorativeStairsArrowColor: canvas.floor.default,
  decorativeStairsArrowSize: 0.75,
  decorativeStairsAccentColor: ONE_WAY_ACCENT_DARK,
};

export class AnalyticsRenderer {
  private readonly gridContainer: Container;
  private readonly floorContainer: Container;
  private readonly closedCellsContainer: Container;
  private readonly regionsContainer: Container;
  private readonly regionClassesContainer: Container;
  private readonly wallsContainer: Container;
  private readonly splitJunctionContainer: Container;
  private readonly teleportContainer: Container;
  private readonly verticalContainer: Container;
  private readonly markersContainer: Container;
  /** Region/region-class cross-floor badges (GitHub issue #345) — sit above `teleportContainer`/
   *  `verticalContainer`/`markersContainer` so a region's own badge isn't occluded by a vertical
   *  passage/elevator/teleport marker drawn at the same cell. Still owned by `RegionsRenderer`/
   *  `RegionClassesRenderer` respectively (feature-renderer ownership rule) — these are only z-order
   *  slots in `AnalyticsRenderer`'s own container tree, wired into the constructor alongside
   *  `regionsContainer`/`regionClassesContainer`. Kept as two separate containers (not shared)
   *  since the two overlays' own `showRegions`/`showRegionClasses` flags aren't mutually exclusive
   *  by construction — sharing one would let one overlay's `render()` destroy the other's badges. */
  private readonly regionBadgesContainer: Container;
  private readonly regionClassBadgesContainer: Container;
  private readonly graphContainer: Container;
  private readonly navGraphContainer: Container;
  private readonly pureCyclesContainer: Container;
  private readonly routeContainer: Container;
  private readonly issueHighlightContainer: Container;

  private readonly grid: GridRenderer;
  private readonly mazeOverlay: MazeOverlayRenderer;
  private readonly regionsRenderer: RegionsRenderer;
  private readonly regionClassesRenderer: RegionClassesRenderer;
  private readonly verticalConnections: VerticalConnectionRenderer;
  private readonly graphRenderer: MazeGraphRenderer;
  private readonly navGraphRenderer: NavGraphRenderer;
  private readonly pureCyclesRenderer: PureCyclesOverlay;
  private readonly routeRenderer: RouteOverlay;
  private readonly issueHighlightRenderer: IssueHighlightOverlay;

  private viewport: Viewport = { x: 0, y: 0, w: 0, h: 0, scale: 1 };
  private unsubscribe: (() => void) | null = null;

  constructor(container: Container) {
    this.gridContainer        = new Container();
    this.floorContainer       = new Container();
    this.closedCellsContainer = new Container();
    this.regionsContainer     = new Container();
    this.regionClassesContainer = new Container();
    this.wallsContainer       = new Container();
    this.splitJunctionContainer = new Container();
    this.teleportContainer    = new Container();
    this.verticalContainer    = new Container();
    this.markersContainer     = new Container();
    this.regionBadgesContainer = new Container();
    this.regionClassBadgesContainer = new Container();
    this.graphContainer       = new Container();
    this.navGraphContainer    = new Container();
    this.pureCyclesContainer  = new Container();
    this.routeContainer       = new Container();
    this.issueHighlightContainer = new Container();

    container.addChild(this.gridContainer);
    container.addChild(this.floorContainer);
    container.addChild(this.closedCellsContainer);
    container.addChild(this.regionsContainer);
    container.addChild(this.regionClassesContainer);
    container.addChild(this.wallsContainer);
    container.addChild(this.splitJunctionContainer);
    container.addChild(this.teleportContainer);
    container.addChild(this.verticalContainer);
    container.addChild(this.markersContainer);
    container.addChild(this.regionBadgesContainer);
    container.addChild(this.regionClassBadgesContainer);
    container.addChild(this.graphContainer);
    container.addChild(this.navGraphContainer);
    container.addChild(this.pureCyclesContainer);
    container.addChild(this.routeContainer);
    container.addChild(this.issueHighlightContainer);

    this.grid = new GridRenderer(this.gridContainer);
    this.mazeOverlay = new MazeOverlayRenderer({
      floor: this.floorContainer,
      closedCells: this.closedCellsContainer,
      walls: this.wallsContainer,
      splitJunctions: this.splitJunctionContainer,
      teleports: this.teleportContainer,
      markers: this.markersContainer,
    });
    this.regionsRenderer = new RegionsRenderer(this.regionsContainer, this.regionBadgesContainer);
    this.regionClassesRenderer = new RegionClassesRenderer(this.regionClassesContainer, this.regionClassBadgesContainer);
    this.verticalConnections = new VerticalConnectionRenderer(this.verticalContainer);
    this.graphRenderer = new MazeGraphRenderer(this.graphContainer);
    this.navGraphRenderer = new NavGraphRenderer(this.navGraphContainer);
    this.pureCyclesRenderer = new PureCyclesOverlay(this.pureCyclesContainer);
    this.routeRenderer = new RouteOverlay(this.routeContainer);
    this.issueHighlightRenderer = new IssueHighlightOverlay(this.issueHighlightContainer);

    this.syncAll(useMazeStore.getState());
    this.subscribe();
  }

  private subscribe(): void {
    let prev = useMazeStore.getState();
    this.unsubscribe = useMazeStore.subscribe((state) => {
      const visibilityChanged =
        state.openCard !== prev.openCard ||
        state.showMazeOverlay !== prev.showMazeOverlay ||
        state.showComponentsOverlay !== prev.showComponentsOverlay ||
        state.showGraphOverlay !== prev.showGraphOverlay ||
        state.showNavGraphOverlay !== prev.showNavGraphOverlay ||
        state.showPureCyclesOverlay !== prev.showPureCyclesOverlay ||
        state.showRouteOverlay !== prev.showRouteOverlay ||
        state.showRegionClassesOverlay !== prev.showRegionClassesOverlay ||
        state.hoveredIssueLoopEdges !== prev.hoveredIssueLoopEdges ||
        state.hoveredIssueRegionGroups !== prev.hoveredIssueRegionGroups;

      const dataChanged =
        state.nodes !== prev.nodes ||
        state.edges !== prev.edges ||
        state.statistics !== prev.statistics ||
        state.navNodes !== prev.navNodes ||
        state.navEdges !== prev.navEdges ||
        state.routeInfo !== prev.routeInfo ||
        state.start !== prev.start ||
        state.finish !== prev.finish ||
        state.activeTessellationConfig !== prev.activeTessellationConfig ||
        state.postEditAnalytics !== prev.postEditAnalytics ||
        state.postEditEdges !== prev.postEditEdges ||
        state.postEditTeleportEdges !== prev.postEditTeleportEdges ||
        state.postEditMeta !== prev.postEditMeta ||
        state.postEditDraftSplitPoints !== prev.postEditDraftSplitPoints ||
        state.activeFloorId !== prev.activeFloorId ||
        state.floors !== prev.floors;

      if (visibilityChanged || dataChanged) {
        this.syncAll(state);
      }

      prev = state;
    });
  }

  private syncAll(state: ReturnType<typeof useMazeStore.getState>): void {
    const analyticsOpen = state.openCard === "analytics";
    const { activeTessellationConfig: cfg,
      showMazeOverlay, showComponentsOverlay, showGraphOverlay, showNavGraphOverlay,
      showPureCyclesOverlay, showRouteOverlay, showRegionClassesOverlay, postEditAnalytics, hoveredIssueLoopEdges, hoveredIssueRegionGroups } = state;

    // Floor-scoped (GitHub issue #358) — `state.nodes` can span every floor (post-edit's confirm
    // no longer restricts to floor 0), so a same-(x,y) node on another floor must not be drawn on
    // top of the active floor's own.
    const level = activeFloorLevel(state);
    const { nodes, edges: floorScopedStateEdges } = selectFloorScopedMaze(state.nodes, state.edges, state.floors, state.activeFloorId);
    const activeFloorIndex = state.floors.findIndex((f) => f.id === state.activeFloorId);

    const resolveNodeLevel = selectNodeLevelResolver(state.nodes);
    const unscopedNodeById = new Map(state.nodes.map((n) => [n.id, n]));
    const resolveNodeCell = (id: number): [number, number] | undefined => {
      const n = unscopedNodeById.get(id);
      return n ? [n.x, n.y] : undefined;
    };
    const resolvedActiveFloorIndex = Math.max(activeFloorIndex, 0);

    const graphAnalytics = (postEditAnalytics?.statistics ?? state.statistics)?.graph_stats;
    const navNodes   = postEditAnalytics?.navNodes   ?? state.navNodes;
    const navEdges   = postEditAnalytics?.navEdges   ?? state.navEdges;
    const routeInfo  = postEditAnalytics != null ? postEditAnalytics.routeInfo : state.routeInfo;
    // Resolves `split` endpoints from the *confirmed* node snapshot (`state.nodes`) — this
    // renderer only ever shows confirmed post-edit state, never the draft, so a resolver built
    // once per sync is enough (no need to track draft-vs-confirmed split points separately here).
    const pointNodeMap = new Map<string, number[]>();
    for (const nd of nodes) {
      const k = `${nd.x},${nd.y}`;
      const list = pointNodeMap.get(k);
      if (list) list.push(nd.id); else pointNodeMap.set(k, [nd.id]);
    }
    const resolveSplit = buildSplitNodeResolver(pointNodeMap, recordOnLevel(state.postEditDraftSplitPoints, level));

    // `resolveSplit` above is built from `nodes`/`postEditDraftSplitPoints` already scoped to the
    // active floor (bare `"x,y"` keys) — a `split` endpoint still carrying its original non-zero
    // `level` would make `resolveSplit` look for a `"x,y@level"` key that no longer exists in that
    // scoped map, silently failing to resolve every split reference on any floor above the first
    // (GitHub issue #425). `floorScopedEndpoint` mirrors `PostEditRenderer.floorScoped`'s identical
    // fix — an endpoint not on this floor is dropped rather than resolved against the wrong floor's
    // nodes.
    const floorNodeIds = new Set(nodes.map((n) => n.id));
    const onLevel = (ep: PostEditEndpoint) => floorScopedEndpoint(ep, level, floorNodeIds);
    const postEditEdges: Record<string, PostEditEdge> | null = state.postEditEdges === null ? null : Object.fromEntries(
      Object.entries(state.postEditEdges)
        .map(([k, e]) => {
          const from = onLevel(e.from);
          const to = onLevel(e.to);
          return from !== undefined && to !== undefined ? [k, { ...e, from, to }] as const : null;
        })
        .filter((entry): entry is readonly [string, PostEditEdge] => entry !== null),
    );

    const edges  = [...postEditEdgesToDto(postEditEdges, resolveSplit), ...state.postEditTeleportEdges];
    const startEp  = state.postEditMeta != null ? state.postEditMeta.start : (state.start !== null ? { kind: "node" as const, id: state.start } : null);
    const finishEp = state.postEditMeta != null ? state.postEditMeta.finish : (state.finish !== null ? { kind: "node" as const, id: state.finish } : null);
    const startOnLevel = startEp !== null ? onLevel(startEp) : undefined;
    const finishOnLevel = finishEp !== null ? onLevel(finishEp) : undefined;
    const start  = startOnLevel !== undefined ? resolveEndpoint(startOnLevel, resolveSplit) ?? null : null;
    const finish = finishOnLevel !== undefined ? resolveEndpoint(finishOnLevel, resolveSplit) ?? null : null;

    // Grid — background context, independent of showMazeOverlay
    const showGrid = analyticsOpen && nodes.length > 0;
    this.gridContainer.visible = showGrid;
    if (showGrid) {
      this.grid.render({ viewport: this.viewport }, cfg);
    }

    // Shared by the maze overlay's own teleport connectors/badges and the regions overlay's
    // teleport-anchored cross-floor region badges (GitHub issue #345) — both must resolve the
    // exact same snapped-midpoint badge position for a cross-floor teleport, so both read it from
    // the same `buildTeleportEdges` call rather than each re-deriving it independently.
    const teleportFloorContext: TeleportFloorContext = {
      resolveNodeLevel,
      unscopedNodeById,
      unscopedEdges: edges,
      activeFloorIndex: resolvedActiveFloorIndex,
    };
    const nodeById = new Map(nodes.map((n) => [n.id, n]));

    // Maze overlay (floor + walls + markers)
    const showMaze = analyticsOpen && showMazeOverlay && nodes.length > 0;
    this.floorContainer.visible       = showMaze;
    this.closedCellsContainer.visible = showMaze;
    this.wallsContainer.visible       = showMaze;
    this.splitJunctionContainer.visible = showMaze;
    this.teleportContainer.visible    = showMaze;
    this.markersContainer.visible     = showMaze;

    // Components list shared by both Regions and Region classes overlays — built from
    // node_component map once regardless of which overlay (if any) is active.
    const componentCount = graphAnalytics?.component_count ?? 0;
    const showRegions = analyticsOpen && showComponentsOverlay && componentCount > 0;
    const regionClasses = graphAnalytics?.region_classes ?? {};
    const showRegionClasses = analyticsOpen && showRegionClassesOverlay && componentCount > 0 && Object.keys(regionClasses).length > 0;

    // Built once, only when something will actually consume it — the maze overlay's own teleport
    // connectors/badges, and/or the regions overlays' teleport-anchored cross-floor badges (#345).
    const teleportEdges = (showMaze || showRegions || showRegionClasses)
      ? buildTeleportEdges(nodeById, edges, cfg, teleportFloorContext)
      : undefined;

    if (showMaze) {
      this.mazeOverlay.render({ nodes, edges, start, finish, cfg, teleportFloorContext, teleportFloorNavigable: true, allEdges: state.edges });
    }

    // Vertical passage/elevator markers — read from the confirmed `state.nodes`/`state.edges`
    // graph (survives post-edit confirm, see `floors.md`'s "VerticalPassage/Elevator edges survive
    // a post-edit confirm"), not from `edges` above (post-edit's own draft basic/teleport edges) —
    // mirrors `PostEditRenderer`'s identical split between `activeEdges` and `state.edges` for this.
    const showVertical = showMaze;
    this.verticalContainer.visible = showVertical;
    if (showVertical) {
      const verticalConnectionMarkers = buildVerticalConnectionMarkers(
        nodeById, floorScopedStateEdges, cfg, resolveNodeLevel, resolvedActiveFloorIndex,
        selectVerticalPassagePairSet(state.edges), state.edges,
      );
      this.verticalConnections.render({ markers: verticalConnectionMarkers, style: DEFAULT_VERTICAL_STYLE, interactive: true });
    }

    // Components list shared by both Regions and Region classes overlays — built from
    // node_component map once regardless of which overlay (if any) is active.
    const components: number[][] = Array.from({ length: componentCount }, () => []);
    const rawNc = graphAnalytics?.node_component;
    if (rawNc != null) {
      for (const [nodeId, compId] of Object.entries(rawNc)) {
        if (compId < componentCount) components[compId].push(Number(nodeId));
      }
    }

    // Regions overlay
    this.regionsContainer.visible = showRegions;
    this.regionBadgesContainer.visible = showRegions;
    if (showRegions) {
      this.regionsRenderer.render({ nodes, components, cfg, allEdges: state.edges, resolveNodeLevel, activeFloorIndex: resolvedActiveFloorIndex, teleportEdges });
    }

    // Region classes overlay — region_classes is empty whenever start/finish aren't both set
    // (see GraphStatsDto.region_classes); gate on that too, not just componentCount, so a
    // stale showRegionClassesOverlay=true (e.g. loaded from an older project file before
    // start/finish were assigned) can't paint every region gray via the renderer's fallback.
    this.regionClassesContainer.visible = showRegionClasses;
    this.regionClassBadgesContainer.visible = showRegionClasses;
    if (showRegionClasses) {
      this.regionClassesRenderer.render({ nodes, components, regionClasses, cfg, allEdges: state.edges, resolveNodeLevel, activeFloorIndex: resolvedActiveFloorIndex, teleportEdges });
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
        resolveNodeLevel, resolveNodeCell, activeFloorIndex: resolvedActiveFloorIndex,
      });
    }

    // Nav graph overlay
    const showNavGraph = analyticsOpen && showNavGraphOverlay && navNodes.length > 0;
    this.navGraphContainer.visible = showNavGraph;
    if (showNavGraph) {
      this.navGraphRenderer.render({ nodes, navNodes, navEdges, edges, start, finish, cfg, resolveNodeLevel, resolveNodeCell, activeFloorIndex: resolvedActiveFloorIndex });
    }

    // Pure cycles overlay
    const pureCycleNodeIds = new Set<number>(graphAnalytics?.pure_cycle_node_ids ?? []);
    const pureCycleEdgeKeys = new Set<string>(
      (graphAnalytics?.pure_cycle_edge_pairs ?? []).map(([f, t]) => `${f},${t}`)
    );
    const showPureCycles = analyticsOpen && showPureCyclesOverlay && navNodes.length > 0;
    this.pureCyclesContainer.visible = showPureCycles;
    if (showPureCycles) {
      this.pureCyclesRenderer.render({ nodes, navEdges, edges, pureCycleNodeIds, pureCycleEdgeKeys, cfg, resolveNodeLevel, resolveNodeCell, activeFloorIndex: resolvedActiveFloorIndex });
    } else {
      this.pureCyclesRenderer.clear();
    }

    // Route overlay
    const showRoute = analyticsOpen && showRouteOverlay && routeInfo != null;
    this.routeContainer.visible = showRoute;
    if (showRoute) {
      this.routeRenderer.render({ routeInfo, nodes, edges, cfg, resolveNodeLevel, resolveNodeCell, activeFloorIndex: resolvedActiveFloorIndex });
    } else {
      this.routeRenderer.clear();
    }

    // Issue highlight overlay — hovered issue's loop edges or undersized region perimeter/fill
    const hasLoopEdges = hoveredIssueLoopEdges != null && hoveredIssueLoopEdges.length > 0;
    const hasRegionGroups = hoveredIssueRegionGroups != null && hoveredIssueRegionGroups.length > 0;
    const showIssueHighlight = analyticsOpen && (hasLoopEdges || hasRegionGroups);
    this.issueHighlightContainer.visible = showIssueHighlight;
    if (showIssueHighlight) {
      this.issueHighlightRenderer.render({ nodes, edges: hoveredIssueLoopEdges, allEdges: edges, regionGroups: hoveredIssueRegionGroups, cfg, resolveNodeLevel, resolveNodeCell, activeFloorIndex: resolvedActiveFloorIndex });
    } else {
      this.issueHighlightRenderer.clear();
    }
  }

  onViewportChanged(x: number, y: number, w: number, h: number, scale: number): void {
    this.viewport = { x, y, w, h, scale };
    const state = useMazeStore.getState();
    if (state.openCard === "analytics" && state.nodes.length > 0) {
      this.grid.render({ viewport: this.viewport }, state.activeTessellationConfig);
    }
  }

  destroy(): void {
    this.unsubscribe?.();
    this.grid.destroy();
    this.mazeOverlay.destroy();
    this.regionsRenderer.destroy();
    this.regionClassesRenderer.destroy();
    this.verticalConnections.destroy();
    this.graphRenderer.destroy();
    this.navGraphRenderer.destroy();
    this.pureCyclesRenderer.destroy();
    this.routeRenderer.destroy();
    this.issueHighlightRenderer.destroy();
    this.gridContainer.destroy();
    this.floorContainer.destroy();
    this.regionsContainer.destroy();
    this.regionClassesContainer.destroy();
    this.wallsContainer.destroy();
    this.splitJunctionContainer.destroy();
    this.teleportContainer.destroy();
    this.verticalContainer.destroy();
    this.markersContainer.destroy();
    this.regionBadgesContainer.destroy();
    this.regionClassBadgesContainer.destroy();
    this.graphContainer.destroy();
    this.navGraphContainer.destroy();
    this.pureCyclesContainer.destroy();
    this.routeContainer.destroy();
    this.issueHighlightContainer.destroy();
  }
}
