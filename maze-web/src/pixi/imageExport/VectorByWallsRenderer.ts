import { Container, Graphics } from "pixi.js";
import { useMazeStore } from "../../store/mazeStore";
import { CellFillRenderer } from "../renderers/CellFillRenderer";
import { WallRenderer } from "../renderers/WallRenderer";
import { WaypointsRenderer } from "../renderers/WaypointsRenderer";
import { TeleportRenderer } from "../renderers/TeleportRenderer";
import { GridRenderer } from "../renderers/GridRenderer";
import { SplitJunctionRenderer, collectSplitWallPaths } from "../renderers/SplitJunctionRenderer";
import { RegionHighlightRenderer } from "../renderers/RegionHighlightRenderer";
import { VerticalConnectionRenderer } from "../renderers/VerticalConnectionRenderer";
import { buildMazeWalls, buildMazeMarkers, buildTeleportEdges, buildTeleportBadgeBlockedCells, buildClosedCells, buildSplitPassages, maxSplitNodeCount, selectFloorScopedMaze, selectNodeLevelResolver, buildVerticalConnectionMarkers, selectVerticalPassagePairSet } from "../selectors/mazeSelectors";
import { computeVectorByWallsWarnings } from "../selectors/exportWarnings";
import type { ExportWarning } from "../selectors/exportWarnings";
import type { NodeDto, EdgeDto } from "../../wasm/types";
import type { Viewport, WallEdge, TeleportEdge, SplitPassage, SplitSpecialShape, SplitStyleOverride, VerticalConnectionMarker } from "../renderers/types";
import type { FieldConfig as TessellationConfig } from "../../fieldConfig";
import { resolveBackgroundColor, measureContentMargin, type ExportMargin } from "./exportMargins";
import { exactCellBounds } from "../tessellationGeometry";
import {
  buildEffectiveSplitNodeColors, viewportWorldRect, buildWallStyle, buildOneWayStyle,
  buildTeleportLineStyle, buildVerticalConnectionStyle, buildMarkerStyle, resolveEffectiveEndpoints,
} from "./exportStyleBuilders";

/** Cell-fill highlight color for a hovered export warning (GitHub issue #298 follow-up) — same
 *  yellow as `styles/palette.ts`'s `warning` token, duplicated here since the pixi render layer
 *  must not import the web-styling layer. */
export const WARNING_HIGHLIGHT_COLOR = 0xffaa44;

/** Owns the hover-highlight overlay for one mode renderer's export warnings — factored out (GitHub
 *  issue #313 follow-up) after `VectorByCorridorsRenderer` needed the exact same
 *  memoize-by-reference-equality-then-draw-a-cell-fill logic `VectorByWallsRenderer` already had,
 *  down to the cache shape and the `RegionHighlightRenderer.render` call. Generic over `TSettings`
 *  and the compute function so each mode still calls its own `compute*Warnings` with its own
 *  settings shape — the two modes' warning sets differ (see `exportWarnings.ts`), only the
 *  memoize+highlight *mechanics* are shared. Still one instance per mode renderer, each owning its
 *  own `RegionHighlightRenderer`/`Container` — per `maze-web/CLAUDE.md`'s feature-renderer
 *  ownership rule, never a shared instance between the two mode renderers. */
export class ExportWarningHighlight<TSettings> {
  private readonly highlight: RegionHighlightRenderer;
  private readonly computeWarnings: (
    nodes: NodeDto[],
    edges: EdgeDto[],
    cfg: TessellationConfig,
    settings: TSettings,
    start: number | null,
    finish: number | null,
    unscopedNodes?: NodeDto[],
  ) => ExportWarning[];

  private cache: {
    nodes: NodeDto[];
    edges: EdgeDto[];
    cfg: TessellationConfig;
    settings: TSettings;
    start: number | null;
    finish: number | null;
    unscopedNodes: NodeDto[];
    warnings: ExportWarning[];
  } | null = null;

  constructor(
    container: Container,
    computeWarnings: (
      nodes: NodeDto[],
      edges: EdgeDto[],
      cfg: TessellationConfig,
      settings: TSettings,
      start: number | null,
      finish: number | null,
      unscopedNodes?: NodeDto[],
    ) => ExportWarning[],
  ) {
    this.highlight = new RegionHighlightRenderer(container);
    this.computeWarnings = computeWarnings;
  }

  render(
    hoveredKey: string | null,
    nodes: NodeDto[],
    edges: EdgeDto[],
    cfg: TessellationConfig,
    settings: TSettings,
    start: number | null,
    finish: number | null,
    unscopedNodes: NodeDto[] = nodes,
  ): void {
    if (!hoveredKey) {
      this.highlight.clear();
      return;
    }
    let warnings: ExportWarning[];
    if (
      this.cache &&
      this.cache.nodes === nodes &&
      this.cache.edges === edges &&
      this.cache.cfg === cfg &&
      this.cache.settings === settings &&
      this.cache.start === start &&
      this.cache.finish === finish &&
      this.cache.unscopedNodes === unscopedNodes
    ) {
      warnings = this.cache.warnings;
    } else {
      warnings = this.computeWarnings(nodes, edges, cfg, settings, start, finish, unscopedNodes);
      this.cache = { nodes, edges, cfg, settings, start, finish, unscopedNodes, warnings };
    }
    const warning = warnings.find((w) => w.key === hoveredKey);
    if (!warning || warning.nodes.length === 0) {
      this.highlight.clear();
      return;
    }

    this.highlight.render({
      nodes,
      regionGroups: warning.nodes.map((id) => [id]),
      color: WARNING_HIGHLIGHT_COLOR,
      width: 0,
      alpha: 0,
      cfg,
      skipPerimeter: true,
    });
  }

  destroy(): void {
    this.highlight.destroy();
  }
}

/** Owns one mode's background-fill + grid overlay pair (GitHub issue #309 follow-up) — factored
 *  out after `VectorByCorridorsRenderer` needed the exact same background-rect-fill/grid-toggle
 *  logic `VectorByWallsRenderer` already had, same "generic over `TSettings`, still one instance
 *  per mode renderer" extraction rationale as `ExportWarningHighlight` above. Requires `TSettings`
 *  to carry `background`/`showGrid`/`gridColor` — every render mode with this section uses that
 *  exact field-name convention (`VectorByWallsSettings`, `VectorByCorridorsSettings`). Per
 *  `maze-web/CLAUDE.md`'s feature-renderer ownership rule: its own `Container`s/`Graphics`/
 *  `GridRenderer`, never shared between mode renderers. */
export class BackgroundGridLayer<TSettings extends { background: number; showGrid: boolean; gridColor: number }> {
  private readonly backgroundContainer: Container;
  private readonly background: Graphics;
  private readonly gridContainer: Container;
  private readonly grid: GridRenderer;

  private viewport: Viewport = { x: 0, y: 0, w: 0, h: 0, scale: 1 };

  constructor(container: Container) {
    this.backgroundContainer = new Container();
    container.addChild(this.backgroundContainer);
    this.background = new Graphics();
    this.backgroundContainer.addChild(this.background);

    this.gridContainer = new Container();
    container.addChild(this.gridContainer);
    this.grid = new GridRenderer(this.gridContainer);
  }

  setVisible(visible: boolean): void {
    this.backgroundContainer.visible = visible;
    this.gridContainer.visible = visible;
  }

  /** Redraws the background rect + (if `showGrid`) the grid against the current viewport — call on
   *  both a settings/data change (`renderAll`) and a pan/zoom-only change (`onViewportChanged`),
   *  same dual-trigger convention `VectorByWallsRenderer` originally had inlined. */
  render(settings: TSettings, cfg: TessellationConfig): void {
    const { x, y, w, h } = viewportWorldRect(this.viewport);
    this.background.clear();
    this.background.rect(x, y, w, h).fill({ color: settings.background });

    this.gridContainer.visible = settings.showGrid;
    if (settings.showGrid) this.grid.render({ viewport: this.viewport, color: settings.gridColor }, cfg);
  }

  onViewportChanged(viewport: Viewport): void {
    this.viewport = viewport;
  }

  destroy(): void {
    this.background.destroy();
    this.backgroundContainer.destroy();
    this.grid.destroy();
    this.gridContainer.destroy();
  }
}

/** Fills in `splitNodeColors`' missing slots with `splitSlotColor`'s own default palette (GitHub
 *  issue #294 follow-up) — `splitNodeColors` only holds entries for slots the user has actually
 *  edited (starts `[]`), so passing it straight through to `buildSplitPassages` would make
 *  `splitSlotColor` treat every slot as "past the fixed set" (empty `fixedSlots`), landing on
 *  `buildPalette`'s rotating-hue colors instead of `canvas.node.splitSlots` — visibly different
 *  from what the settings panel itself shows for an untouched slot, until the user edits every
 *  slot at least once. Exported as a pure function for unit-testability, same rationale as
 *  `viewportWorldRect`/`buildWallStyle`. */
/** The "Vector by walls" image-export rendering mode (GitHub issue #287) — renders the maze
 * identically to the main generation/post-edit view (same walls, same colors), built from the
 * same low-level render primitives (`GridRenderer`, `CellFillRenderer`, `WallRenderer`, etc.) as
 * `GenerationRenderer`. Per `maze-web/CLAUDE.md`'s feature-renderer ownership rule this is its
 * own renderer with its own primitive instances — it must not share instances with
 * `GenerationRenderer` or any other feature-renderer, even though the visual output matches. */
export class VectorByWallsRenderer {
  private readonly floorContainer: Container;
  private readonly closedCellsContainer: Container;
  private readonly wallsContainer: Container;
  private readonly splitJunctionContainer: Container;
  private readonly teleportContainer: Container;
  private readonly verticalContainer: Container;
  private readonly markersContainer: Container;
  private readonly warningHighlightContainer: Container;

  private readonly backgroundGrid: BackgroundGridLayer<ReturnType<typeof useMazeStore.getState>["vectorByWallsSettings"]>;
  private readonly floor: CellFillRenderer;
  private readonly closedCells: CellFillRenderer;
  private readonly walls: WallRenderer;
  private readonly splitJunctions: SplitJunctionRenderer;
  private readonly teleports: TeleportRenderer;
  /** Own instance, per `maze-web/CLAUDE.md`'s feature-renderer ownership rule (GitHub issue #347)
   *  — never shared with a future floor-aware `GenerationRenderer`'s own instance. */
  private readonly verticalConnections: VerticalConnectionRenderer;
  private readonly markers: WaypointsRenderer;
  /** Own instance, not shared with `AnalyticsRenderer`'s issue-highlight overlay or
   *  `VectorByCorridorsRenderer`'s own — per `maze-web/CLAUDE.md`'s feature-renderer ownership
   *  rule. Highlights the currently hovered export warning's cells (GitHub issue #298 follow-up —
   *  cell fill reads much more clearly than a small marker circle), see
   *  `computeVectorByWallsWarnings`. */
  private readonly warningHighlight: ExportWarningHighlight<ReturnType<typeof useMazeStore.getState>["vectorByWallsSettings"]>;

  private viewport: Viewport = { x: 0, y: 0, w: 0, h: 0, scale: 1 };
  private unsubscribe: (() => void) | null = null;

  private geometryCache: {
    // Tracks the *unscoped* `state.nodes`/`state.edges`/`activeFloorId` identities (GitHub issue
    // #347), not the freshly-filtered floor-scoped arrays `selectFloorScopedMaze` returns each
    // call — a `.filter()` result is a new array reference every time even when nothing changed,
    // which would defeat this cache entirely if compared directly.
    rawNodes: NodeDto[];
    rawEdges: EdgeDto[];
    activeFloorId: string;
    cfg: TessellationConfig;
    start: number | null;
    finish: number | null;
    splitNodeColors: readonly number[];
    closedCells: [number, number][];
    wallEdges: WallEdge[];
    teleportEdges: TeleportEdge[];
    splitPassages: SplitPassage[];
    splitWallFaces: { v0: { x: number; y: number }; v1: { x: number; y: number } }[];
    splitSpecialShapes: SplitSpecialShape[];
    replaceTwoFloorElevatorsWithStairs: boolean;
    verticalConnectionMarkers: VerticalConnectionMarker[];
  } | null = null;

  constructor(container: Container) {
    this.backgroundGrid = new BackgroundGridLayer(container);

    this.floorContainer = new Container();
    this.closedCellsContainer = new Container();
    this.wallsContainer = new Container();
    this.splitJunctionContainer = new Container();
    this.teleportContainer = new Container();
    this.verticalContainer = new Container();
    this.markersContainer = new Container();

    container.addChild(this.floorContainer);
    container.addChild(this.closedCellsContainer);
    container.addChild(this.wallsContainer);
    container.addChild(this.splitJunctionContainer);
    container.addChild(this.teleportContainer);
    container.addChild(this.verticalContainer);
    container.addChild(this.markersContainer);
    this.warningHighlightContainer = new Container();
    container.addChild(this.warningHighlightContainer);

    this.floor = new CellFillRenderer(this.floorContainer);
    this.closedCells = new CellFillRenderer(this.closedCellsContainer);
    this.walls = new WallRenderer(this.wallsContainer);
    this.splitJunctions = new SplitJunctionRenderer(this.splitJunctionContainer);
    this.teleports = new TeleportRenderer(this.teleportContainer);
    this.verticalConnections = new VerticalConnectionRenderer(this.verticalContainer);
    this.markers = new WaypointsRenderer(this.markersContainer);
    this.warningHighlight = new ExportWarningHighlight(this.warningHighlightContainer, computeVectorByWallsWarnings);

    this.syncVisibility(useMazeStore.getState());
    this.subscribe();
  }

  private subscribe(): void {
    let prev = useMazeStore.getState();
    this.unsubscribe = useMazeStore.subscribe((state) => {
      const visibilityChanged = state.openCard !== prev.openCard;
      if (visibilityChanged) this.syncVisibility(state);

      const dataChanged =
        state.nodes !== prev.nodes ||
        state.edges !== prev.edges ||
        state.start !== prev.start ||
        state.finish !== prev.finish ||
        state.postEditMeta !== prev.postEditMeta ||
        state.postEditDraftSplitPoints !== prev.postEditDraftSplitPoints ||
        state.activeTessellationConfig !== prev.activeTessellationConfig ||
        state.activeFloorId !== prev.activeFloorId ||
        state.floors !== prev.floors;

      const settingsChanged = state.vectorByWallsSettings !== prev.vectorByWallsSettings;
      // Teleports section's own expand/collapse flips `interactive` on group customization's
      // canvas hover wiring (GitHub issue #293) — a plain `sectionsExpanded` change wouldn't
      // otherwise trigger `renderAll` since it isn't part of `vectorByWallsSettings`.
      const teleportsSectionChanged =
        (state.vectorByWallsSectionsExpanded["teleports"] ?? false) !== (prev.vectorByWallsSectionsExpanded["teleports"] ?? false);

      if ((dataChanged || settingsChanged || teleportsSectionChanged) && state.openCard === "image_export") {
        this.renderAll(state);
      } else if (state.hoveredExportWarningKey !== prev.hoveredExportWarningKey && state.openCard === "image_export") {
        this.renderWarningHighlight(state);
      }

      prev = state;
    });
  }

  private syncVisibility(state: ReturnType<typeof useMazeStore.getState>): void {
    const visible = state.openCard === "image_export";
    this.backgroundGrid.setVisible(visible);
    this.floorContainer.visible = visible;
    this.closedCellsContainer.visible = visible;
    this.wallsContainer.visible = visible;
    this.splitJunctionContainer.visible = visible;
    this.teleportContainer.visible = visible;
    this.verticalContainer.visible = visible;
    this.markersContainer.visible = visible;
    this.warningHighlightContainer.visible = visible;
    if (visible) this.renderAll(state);
  }

  onViewportChanged(x: number, y: number, w: number, h: number, scale: number): void {
    this.viewport = { x, y, w, h, scale };
    this.backgroundGrid.onViewportChanged(this.viewport);
    const state = useMazeStore.getState();
    if (state.openCard === "image_export") {
      this.backgroundGrid.render(state.vectorByWallsSettings, state.activeTessellationConfig);
    }
  }

  /** Pixel-accurate export margin (GitHub issue #324 follow-up) — reads the actual drawn content's
   *  own world-space bounds (`Container.getLocalBounds()`, exact per pixi's own stroke/join/cap/
   *  shape math) instead of a settings-derived approximation of it. `renderAll` runs unconditionally
   *  first (not gated on `openCard === "image_export"` the way the store-subscription path is) —
   *  that gate exists purely as a perf optimization for the *on-screen* instance (skip re-rendering
   *  geometry nobody can see while its own card is closed), but a caller reading this margin needs
   *  correct bounds regardless of whether the card happens to be open: `PngExportSettingsPanel`'s
   *  own throwaway measurement-only instance, or any renderer queried before its card was ever
   *  opened, would otherwise measure stale/empty containers and silently return a garbage margin.
   *  Cheap to always do — pure geometry recording, no GPU/canvas work happens until an actual
   *  `renderer.render()` call, which this never triggers. `backgroundGrid`/`warningHighlightContainer`
   *  are excluded from the bounds union — not maze content. `floorContainer` is included even though
   *  a plain (non-closed) cell's floor fill reaches exactly the cell's own polygon boundary — same
   *  "basis: cell" extent `exactCellBounds` used to approximate — so this naturally still returns ~0
   *  margin past `exactCellBounds` wherever no marker/indicator pokes further, without needing a
   *  separate "wall-only" concept at all: unlike "Vector by corridors" (whose content stops well
   *  short of the cell boundary, hence needed its own `cellCenterBounds` basis), every render mode
   *  here converges on the exact same idea — "how far past the cell's own raw boundary does this
   *  maze's actual drawn content go" — once the bounds themselves are pixel-measured instead of
   *  estimated, so one method now serves every canvas-fit mode (`edge_to_edge`, `margin_px`/
   *  `margin_cells`, `fixed_size`, print) with no separate "settings-only worst case" variant
   *  needed anywhere. */
  getRequiredExportMargin(): ExportMargin {
    const state = useMazeStore.getState();
    if (state.nodes.length === 0) return { left: 0, right: 0, top: 0, bottom: 0 };
    this.renderAll(state);

    // Floor-scoped (GitHub issue #347), same reason `renderAll` scopes its own `nodes` — the
    // *drawn* content is only ever one floor's worth, so the bounds basis must match.
    const floorNodes = selectFloorScopedMaze(state.nodes, state.edges, state.floors, state.activeFloorId).nodes;
    const cellBounds = exactCellBounds(floorNodes, state.activeTessellationConfig);
    return measureContentMargin(
      [this.floorContainer, this.closedCellsContainer, this.wallsContainer, this.splitJunctionContainer, this.teleportContainer, this.verticalContainer, this.markersContainer],
      cellBounds,
    );
  }

  getBackgroundColor(): number {
    const state = useMazeStore.getState();
    return resolveBackgroundColor("vector_by_walls", { vectorByWallsSettings: state.vectorByWallsSettings, vectorByCorridorsSettings: state.vectorByCorridorsSettings });
  }

  private renderAll(state: ReturnType<typeof useMazeStore.getState>): void {
    const cfg = state.activeTessellationConfig;
    this.backgroundGrid.render(state.vectorByWallsSettings, cfg);

    // Scoped to `activeFloorId` (GitHub issue #347) — `state.nodes`/`state.edges` can span every
    // floor once generation is multi-level-aware (GitHub issue #337); every selector below assumes
    // a single floor's worth of cells (two same-(x,y) nodes on different floors would otherwise be
    // mistaken for a split point). `resolveEffectiveEndpoints` still reads the *unscoped* `state`
    // (it resolves post-edit endpoints, which aren't floor-scoped themselves), so its result is
    // re-scoped here too via `selectFloorScopedMaze`'s own start/finish narrowing.
    const rawEndpoints = resolveEffectiveEndpoints(state);
    const { nodes, edges, start, finish } = selectFloorScopedMaze(
      state.nodes, state.edges, state.floors, state.activeFloorId, rawEndpoints.start, rawEndpoints.finish,
    );
    // Resolves a `vertical_passage`/`elevator` edge's `to` node's own floor (GitHub issue #347) —
    // built from the *unscoped* node list, since `to` never survives the floor-scoping above.
    const resolveNodeLevel = selectNodeLevelResolver(state.nodes);
    const verticalPairs = selectVerticalPassagePairSet(state.edges);
    const activeFloorIndex = Math.max(state.floors.findIndex((f) => f.id === state.activeFloorId), 0);
    const cells: [number, number][] = nodes.map(n => [n.x, n.y]);
    this.floor.render({ cells, color: state.vectorByWallsSettings.floorColor, alpha: 1 }, cfg);

    const nodeById = new Map(nodes.map(n => [n.id, n]));

    const splitNodeColors = state.vectorByWallsSettings.splitNodeColors;
    if (
      !this.geometryCache ||
      this.geometryCache.rawNodes !== state.nodes ||
      this.geometryCache.rawEdges !== state.edges ||
      this.geometryCache.activeFloorId !== state.activeFloorId ||
      this.geometryCache.cfg !== cfg ||
      this.geometryCache.start !== start ||
      this.geometryCache.finish !== finish ||
      this.geometryCache.splitNodeColors !== splitNodeColors ||
      this.geometryCache.replaceTwoFloorElevatorsWithStairs !== state.vectorByWallsSettings.replaceTwoFloorElevatorsWithStairs
    ) {
      const specialNodeIds = new Set<number>();
      if (start !== null) specialNodeIds.add(start);
      if (finish !== null) specialNodeIds.add(finish);
      for (const e of edges) {
        if (e.kind === "teleport") { specialNodeIds.add(e.from); specialNodeIds.add(e.to); }
      }

      const effectiveNodeColors = buildEffectiveSplitNodeColors(splitNodeColors, maxSplitNodeCount(nodes));
      const { passages: splitPassages, wallFaces: splitWallFaces, specialShapes: splitSpecialShapes } =
        buildSplitPassages(nodes, edges, cfg, specialNodeIds, {}, {}, effectiveNodeColors);
      this.geometryCache = {
        rawNodes: state.nodes,
        rawEdges: state.edges,
        activeFloorId: state.activeFloorId,
        cfg,
        start,
        finish,
        splitNodeColors,
        closedCells: buildClosedCells(nodes, edges, state.edges),
        wallEdges: buildMazeWalls(nodes, edges, cfg),
        teleportEdges: buildTeleportEdges(nodeById, edges, cfg, {
          resolveNodeLevel,
          unscopedNodeById: new Map(state.nodes.map((n) => [n.id, n])),
          unscopedEdges: state.edges,
          activeFloorIndex,
        }, {
          blockedCellsByFloor: buildTeleportBadgeBlockedCells(
            state.nodes, state.edges, resolveNodeLevel, rawEndpoints.start, rawEndpoints.finish,
          ),
          allowOutOfField: !state.vectorByWallsSettings.teleportAvoidFieldExit,
          fieldCells: state.nodes.map((n): [number, number] => [n.x, n.y]),
        }),
        splitPassages,
        splitWallFaces,
        splitSpecialShapes,
        replaceTwoFloorElevatorsWithStairs: state.vectorByWallsSettings.replaceTwoFloorElevatorsWithStairs,
        verticalConnectionMarkers: buildVerticalConnectionMarkers(nodeById, edges, cfg, resolveNodeLevel, activeFloorIndex, verticalPairs, state.edges, state.vectorByWallsSettings.replaceTwoFloorElevatorsWithStairs),
      };
    }
    const wallStyle = buildWallStyle(state.vectorByWallsSettings);
    const oneWayStyle = buildOneWayStyle(state.vectorByWallsSettings);
    const splitStyle: SplitStyleOverride = { specialShapes: state.vectorByWallsSettings.splitSpecialShapes };
    this.closedCells.render({ cells: this.geometryCache.closedCells, color: state.vectorByWallsSettings.wallColor, alpha: 1 }, cfg);
    const { paths: extraWalls, noCapPoints } = collectSplitWallPaths(
      this.geometryCache.splitWallFaces,
      this.geometryCache.splitSpecialShapes,
      state.vectorByWallsSettings.splitSpecialShapes,
    );
    this.walls.render(
      { edges: this.geometryCache.wallEdges }, cfg, wallStyle, oneWayStyle, extraWalls, noCapPoints,
      state.vectorByWallsSettings.randomWallColorMode,
      { floorColor: state.vectorByWallsSettings.floorColor, backgroundColor: state.vectorByWallsSettings.background },
    );
    this.splitJunctions.render(
      { passages: this.geometryCache.splitPassages, wallFaces: this.geometryCache.splitWallFaces, specialShapes: this.geometryCache.splitSpecialShapes },
      wallStyle,
      splitStyle,
    );
    const { startMarker, finishMarker, floorColor } = state.vectorByWallsSettings;
    const markerData = buildMazeMarkers(
      nodeById, start, finish, cfg,
      buildMarkerStyle(startMarker, floorColor),
      buildMarkerStyle(finishMarker, floorColor),
      edges,
    );
    this.teleports.render({
      edges: this.geometryCache.teleportEdges,
      lineStyle: buildTeleportLineStyle(state.vectorByWallsSettings, state.vectorByWallsSettings.floorColor),
      groupCustomization: state.vectorByWallsSettings.teleportGroupCustomization,
      groupOverrides: state.vectorByWallsSettings.teleportGroupOverrides,
      interactive: state.vectorByWallsSectionsExpanded["teleports"] ?? false,
      // Cross-floor teleport/elevator badges are always click-to-switch-floor on the export
      // canvas (GitHub issue #478) — a read-only view like `GenerationRenderer`/`AnalyticsRenderer`,
      // so no tool-driven gating applies.
      floorNavigable: true,
      cfg,
      waypoints: markerData.map((m) => m.pos),
      avoidFieldExit: state.vectorByWallsSettings.teleportAvoidFieldExit,
      fieldCells: cells,
    });

    this.markers.render({ markers: markerData });

    this.verticalConnections.render({
      markers: this.geometryCache.verticalConnectionMarkers,
      style: buildVerticalConnectionStyle(state.vectorByWallsSettings, floorColor, state.vectorByWallsSettings),
      // Vertical-passage markers navigate to their target floor on the export canvas (GitHub
      // issue #478) — always-on, same as `GenerationRenderer`'s read-only canvas.
      interactive: true,
    });

    this.renderWarningHighlight(state);
  }

  /** Highlights the currently hovered export warning's flagged cell(s) (GitHub issue #298
   *  follow-up — a small marker-circle highlight read too weakly, cell fill is much clearer) — see
   *  `ExportWarningHighlight`'s own doc comment for the memoize-then-draw mechanics, shared with
   *  `VectorByCorridorsRenderer`'s own copy of this method. */
  private renderWarningHighlight(state: ReturnType<typeof useMazeStore.getState>): void {
    const { hoveredExportWarningKey } = state;
    const rawEndpoints = resolveEffectiveEndpoints(state);
    // Same floor-scoping as `renderAll` (GitHub issue #347) — the warning computation must see
    // exactly the drawn floor's own nodes/edges, or a hovered warning's `nodes`/`edges` could
    // reference an id that isn't actually rendered.
    const { nodes, edges, start, finish } = selectFloorScopedMaze(
      state.nodes, state.edges, state.floors, state.activeFloorId, rawEndpoints.start, rawEndpoints.finish,
    );
    this.warningHighlight.render(hoveredExportWarningKey, nodes, edges, state.activeTessellationConfig, state.vectorByWallsSettings, start, finish, state.nodes);
  }

  destroy(): void {
    this.unsubscribe?.();
    this.backgroundGrid.destroy();
    this.floor.destroy();
    this.closedCells.destroy();
    this.walls.destroy();
    this.splitJunctions.destroy();
    this.teleports.destroy();
    this.verticalConnections.destroy();
    this.markers.destroy();
    this.warningHighlight.destroy();
    this.floorContainer.destroy();
    this.closedCellsContainer.destroy();
    this.wallsContainer.destroy();
    this.splitJunctionContainer.destroy();
    this.teleportContainer.destroy();
    this.verticalContainer.destroy();
    this.markersContainer.destroy();
    this.warningHighlightContainer.destroy();
  }
}

export {
  buildEffectiveSplitNodeColors, viewportWorldRect, buildWallStyle, buildOneWayStyle,
  buildTeleportLineStyle, buildVerticalConnectionStyle, buildMarkerStyle, resolveEffectiveEndpoints,
} from "./exportStyleBuilders";
