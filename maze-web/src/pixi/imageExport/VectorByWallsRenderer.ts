import { CoordinateWarningHighlight } from "../CoordinateWarningHighlight";
import { Container, Graphics } from "pixi.js";
import { floorIdsWithCut } from "./exportContent";
import { useMazeStore } from "../../store/mazeStore";
import { LABEL_FONT_LOADED_EVENT } from "../../domain/renderers/fontChoice";
import { CellFillRenderer } from "../renderers/CellFillRenderer";
import { WallRenderer } from "../renderers/WallRenderer";
import { WaypointsRenderer } from "../renderers/WaypointsRenderer";
import { WaypointOpeningRenderer } from "../renderers/WaypointOpeningRenderer";
import { resolveIndicatorMetrics } from "../../store/imageExportTypes";
import { openingCutsWall, openingShowsPointer } from "../../domain/waypointOpeningMode";
import { DEFAULT_MAZE_RENDER_STYLE } from "../../domain/defaultMazeRenderStyle";
import { buildMarkerScaler } from "../../domain/markerScale";
import { footprintsOfMarkers, footprintsOfTeleports, footprintsOfVertical } from "../markerFootprints";
import { TeleportRenderer } from "../renderers/TeleportRenderer";
import { GridRenderer } from "../renderers/GridRenderer";
import { SplitJunctionRenderer, collectSplitWallPaths } from "../renderers/SplitJunctionRenderer";
import { oneWayIndicatorSpan } from "../renderers/wallUtils";
import { RegionHighlightRenderer } from "../renderers/RegionHighlightRenderer";
import { VerticalConnectionRenderer, type VerticalConnectionRenderData } from "../renderers/VerticalConnectionRenderer";
import { buildMazeWalls, buildMazeMarkers, buildTeleportEdges, buildTeleportFloorInputs, buildClosedCells, buildSplitPassages, maxSplitNodeCount, selectFloorScopedMaze, selectNodeLevelResolver, buildVerticalConnectionMarkers, selectVerticalPassagePairSet, buildMarkerIndexLabels, markerIndexPlateFootprint, buildTeleportAvoidanceWaypoints, buildWaypointOpenings, isOpeningWall, openingGapReach } from "../../domain/selectors/mazeSelectors";
import type { ElevatorBadgeObstacle } from "../renderers/elevatorBadgeLayout";
import { hasAnyGlue } from "../selectors/colorFieldRegistry";
import { buildSplitHostKeys, shiftMarkerIndexLabels } from "../../domain/selectors/mazeSelectors/markerLayout";
import { MarkerIndexRenderer, type MarkerIndexRenderData } from "../renderers/MarkerIndexRenderer";
import { SeamCopyRenderer } from "../renderers/SeamCopyRenderer";
import { buildSeamCopySources } from "./seamCopySources";
import { FloorLabelRenderer, floorLabelPosition } from "../renderers/FloorLabelRenderer";
import { computeVectorByWallsWarningsAcrossFloors, BOUNDARY_WARNING_IDS } from "../selectors/exportWarnings";
import { computeTopologyWarnings } from "../selectors/topologyWarnings";
import type { ExportWarning } from "../selectors/exportWarnings";
import type { NodeDto, EdgeDto } from "../../wasm/types";
import type { Viewport, WallEdge, TeleportEdge, SplitPassage, SplitSpecialShape, SplitStyleOverride, VerticalConnectionMarker, TeleportGroupOverride } from "../../domain/renderers/types";
import { buildExportZoneValues } from "../../store/exportZoneOverrides";
import { VariantPool, ZoneVariants } from "./zoneVariants";
import type { FieldConfig } from "../../fieldConfig";
import { resolveBackgroundColor, measureContentMargin, type ExportMargin } from "../../domain/imageExport/exportMargins";
import type { ModeRenderer, RenderPass } from "./modeRendererFactory";
import { exactCellBounds } from "../../domain/tessellationGeometry";
import { drawTrimMask } from "./seamTrim";
import { canvas } from "../../domain/colorTokens";
import { withResolvedGroupOverrides } from "../../store/teleportGroupLinks";
import { resolveRendererGroupOverrides, getProjectTeleportGroups } from "../selectors/projectTeleportGroups";
import { buildTeleportGroups } from "../../domain/selectors/teleportGroups";
import { selectExportGlueTabs } from "./glueTabExport";
import { GlueTabRenderer } from "../renderers/GlueTabRenderer";
import { getCellHighlightInset } from "../cellHighlightGeometry";
import { POLYGON_HIGHLIGHT_RADIUS, WALL_THICKNESS } from "../../domain/renderConstants";
import { roundedContourCorners } from "./roundedContour";
import {
  buildEffectiveSplitNodeColors, viewportWorldRect, buildWallStyle, buildOneWayStyle,
  buildTeleportLineStyle, buildVerticalConnectionStyle, buildMarkerStyle, resolveEffectiveEndpoints,
  buildMarkerIndexEndpointResolver, layoutExportMarkers,
} from "./exportStyleBuilders";



export { trimMaskPolygons } from "./seamTrim";

/** Adds `polygon` to `g` as a closed contour with softened corners (see `roundedContourCorners`). */
function roundedContour(g: Graphics, polygon: readonly [number, number][], radius: number): void {
  const corners = roundedContourCorners(polygon, radius);
  corners.forEach(({ entry, corner, exit }, i) => {
    if (i === 0) g.moveTo(entry[0], entry[1]); else g.lineTo(entry[0], entry[1]);
    g.quadraticCurveTo(corner[0], corner[1], exit[0], exit[1]);
  });
  if (corners.length) g.closePath();
}

/** Owns the hover-highlight overlay for one mode renderer's export warnings — factored out (GitHub
 *  issue #313 follow-up) after `VectorByCorridorsRenderer` needed the exact same draw-a-cell-fill
 *  logic `VectorByWallsRenderer` already had, down to the `RegionHighlightRenderer.render` call.
 *  It draws the warnings it is given and computes none: the renderers take them from the cached
 *  `compute*WarningsAcrossFloors` (GitHub issue #928), the same cache the settings panel reads.
 *  Generic over `TSettings` so each mode passes its own settings shape. Still one instance per mode
 *  renderer, each owning its own `RegionHighlightRenderer`/`Container` — per `maze-web/CLAUDE.md`'s
 *  feature-renderer ownership rule, never a shared instance between the two mode renderers. */
export class ExportWarningHighlight<TSettings> {
  private readonly highlight: RegionHighlightRenderer;
  /** Shapes of a warning that marks parts of the drawn connectors rather than cells (`ExportWarning.floorPolygons`). */
  private readonly shapes = new Graphics();

  constructor(container: Container) {
    this.highlight = new RegionHighlightRenderer(container);
    container.addChild(this.shapes);
  }

  /** Draws the warning of `warnings` keyed `hoveredKey` (`null` or an unknown key clears). */
  render(
    hoveredKey: string | null,
    warnings: ExportWarning[],
    nodes: NodeDto[],
    cfg: FieldConfig,
    settings: TSettings,
    inset = 2,
    boundaryWidth?: number,
    /** Vector-by-corridors draws one-way warning endpoints as inset regions instead of a shared
     * boundary; vector-by-walls keeps the boundary treatment. */
    boundaryWarningsAsRegions = false,
  ): void {
    this.shapes.clear();
    if (!hoveredKey) {
      this.highlight.clear();
      return;
    }
    const warning = warnings.find((w) => w.key === hoveredKey);
    if (warning?.floorPolygons?.length) {
      // Like the topology highlight: a translucent fill plus an opaque outline, a closed contour with rounded corners.
      const floorIndex = nodes[0]?.level ?? 0;
      for (const { floorIndex: shapeFloor, polygon } of warning.floorPolygons) {
        if (shapeFloor === floorIndex) roundedContour(this.shapes, polygon, POLYGON_HIGHLIGHT_RADIUS);
      }
      this.shapes.fill({ color: canvas.coordinateWarning.warning, alpha: 0.25 });
      this.shapes.stroke({ width: 3, color: canvas.coordinateWarning.warning, join: "round", cap: "round" });
    }
    // Flagged nodes and cells are drawn by the shared coordinate warning layer (`ExportWarningBubble`
    // sets `hoveredCoordinateWarning`); only the shared boundary of a one-way passage stays here.
    const isBoundaryWarning = warning != null && BOUNDARY_WARNING_IDS.has(warning.id);
    if (!warning || !isBoundaryWarning || warning.edges.length === 0) {
      this.highlight.clear();
      return;
    }

    const renderBoundaryAsRegion = boundaryWarningsAsRegions;
    const boundaryRegionGroups = renderBoundaryAsRegion
      ? warning.edges.map(([from, to]) => [from, to])
      : undefined;
    this.highlight.render({
      nodes,
      regionGroups: boundaryRegionGroups ?? [],
      cells: [],
      color: canvas.coordinateWarning.warning,
      width: 0,
      alpha: 0,
      cfg,
      skipPerimeter: true,
      inset,
      insetMode: "inset",
      cornerStyle: ((settings as unknown as Record<string, unknown>).join ??
        (settings as unknown as Record<string, unknown>).wallJoin) === "round" ? "round" : "sharp",
      boundaryEdges: !renderBoundaryAsRegion ? warning.edges : undefined,
      boundaryWidth,
    });
  }

  /** Highlights the cells of `nodeIds` (teleport-group list hover) in the post-edit hover color
   *  (`canvas.fieldEditor.hover`). Ids absent from `nodes` (other floors) are skipped; `null`/empty clears.
   *  `cells` are extra plain cells of the drawn floor (a floor badge, GitHub issue #989). */
  renderNodes(
    nodeIds: number[] | null,
    nodes: NodeDto[],
    cfg: FieldConfig,
    settings: TSettings,
    inset = 2,
    cells: [number, number][] = [],
  ): void {
    const wanted = new Set(nodeIds ?? []);
    const tileGroups = new Map<string, number[]>();
    for (const node of nodes) {
      if (!wanted.has(node.id)) continue;
      const key = `${node.x},${node.y}`;
      const group = tileGroups.get(key) ?? [];
      group.push(node.id);
      tileGroups.set(key, group);
    }
    if (tileGroups.size === 0 && cells.length === 0) {
      this.highlight.clear();
      return;
    }
    this.highlight.render({
      nodes,
      regionGroups: Array.from(tileGroups.values()),
      cells,
      color: canvas.fieldEditor.hover,
      width: 0,
      alpha: 0,
      cfg,
      skipPerimeter: true,
      inset,
      insetMode: "inset",
      cornerStyle: ((settings as unknown as Record<string, unknown>).join ??
        (settings as unknown as Record<string, unknown>).wallJoin) === "round" ? "round" : "sharp",
    });
  }

  destroy(): void {
    this.highlight.destroy();
    this.shapes.destroy();
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
  /** Glue tabs' layer (GitHub issue #901): above the grid, below the content, so walls and corridors draw over them.
   *  Part of the backdrop: shown with it, drawn once over the whole frame. */
  readonly glueTabs: Container;

  private viewport: Viewport = { x: 0, y: 0, w: 0, h: 0, scale: 1 };
  private shown = true;
  private showGrid = false;
  private pass: RenderPass = "full";
  /** Everything the mode draws above the backdrop. A cut sheet (GitHub issue #859) draws the backdrop once, over the
   *  whole frame, and the content once per copy, clipped to the sheet's region, below the `overlay` of every copy. */
  readonly content: Container;
  /** Everything that must stay above the content of every cut copy (the `"overlay"` pass), so a later copy's
   *  corridors never cover an earlier copy's top-layer shapes. Stacked directly above `content`. */
  readonly overlay: Container;
  /** The export warning hover highlight, above the overlay of every cut copy so a later copy never
   *  covers or crops an earlier copy's highlight. Shown in the `"full"` and `"foreground"` passes only. */
  readonly highlight: Container;

  constructor(container: Container) {
    this.backgroundContainer = new Container();
    container.addChild(this.backgroundContainer);
    this.background = new Graphics();
    this.backgroundContainer.addChild(this.background);

    this.gridContainer = new Container();
    container.addChild(this.gridContainer);
    this.grid = new GridRenderer(this.gridContainer, "vector export grid");

    this.glueTabs = new Container();
    container.addChild(this.glueTabs);

    this.content = new Container();
    container.addChild(this.content);

    this.overlay = new Container();
    container.addChild(this.overlay);

    this.highlight = new Container();
    container.addChild(this.highlight);
  }

  setVisible(visible: boolean): void {
    this.shown = visible;
    this.applyVisibility();
  }

  setPass(pass: RenderPass): void {
    this.pass = pass;
    this.applyVisibility();
  }

  private applyVisibility(): void {
    this.content.visible = this.pass === "full" || this.pass === "content" || this.pass === "foreground";
    this.overlay.visible = this.pass === "full" || this.pass === "overlay" || this.pass === "foreground";
    this.highlight.visible = this.pass === "full" || this.pass === "foreground";
    const visible = this.shown && (this.pass === "full" || this.pass === "backdrop");
    this.backgroundContainer.visible = visible;
    this.gridContainer.visible = visible && this.showGrid;
    this.glueTabs.visible = visible;
  }

  /** Redraws the background rect + (if `showGrid`) the grid against the current viewport — call on
   *  both a settings/data change (`renderAll`) and a pan/zoom-only change (`onViewportChanged`),
   *  same dual-trigger convention `VectorByWallsRenderer` originally had inlined. */
  render(settings: TSettings, cfg: FieldConfig): void {
    this.showGrid = settings.showGrid;
    // A copy of a cut sheet never shows the backdrop, so drawing it would be wasted work on every pan and zoom.
    if (this.pass !== "full" && this.pass !== "backdrop") return;
    const { x, y, w, h } = viewportWorldRect(this.viewport);
    this.background.clear();
    this.background.rect(x, y, w, h).fill({ color: settings.background });

    this.applyVisibility();
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
    this.glueTabs.destroy();
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
  getTeleportConnectorPaths(): readonly import("../renderers/teleportConnectorRouting").ConnectorEditPath[] {
    // The base renderer can be in a backdrop-only pass while a cut sheet is displayed. Refreshing
    // its plan here keeps the editor independent of that presentation pass.
    this.renderAll(useMazeStore.getState());
    return this.teleports.renderers.flatMap((renderer) => renderer.getConnectorPaths());
  }
  private readonly mazeContent: Container;
  private readonly trimMask = new Graphics();
  private trimMaskInputs: { nodes: NodeDto[]; floorId: string; cfg: FieldConfig; topology: unknown } | null = null;
  private readonly floorContainer: Container;
  private readonly closedCellsContainer: Container;
  private readonly wallsContainer: Container;
  private readonly splitJunctionContainer: Container;
  private readonly teleportContainer: Container;
  private readonly verticalContainer: Container;
  private readonly markersContainer: Container;
  /** Two layers for the marker-index plates: the gap-ring pass sits *below* the connection markers
   *  (so a plate's gap never occludes its marker), the body pass *above* them (GitHub issue #471). */
  private readonly markerIndexGapContainer: Container;
  private readonly markerIndexBodyContainer: Container;
  private readonly floorLabelContainer: Container;
  private readonly warningHighlightContainer: Container;
  private readonly coordinateWarning: CoordinateWarningHighlight;
  /** Optional grid overlay inside the filled maze cells, below walls and markers. */
  private readonly innerGridContainer: Container;
  /** One grid per settings variant (GitHub issue #1040): a zone can give its cells another inner grid colour. */
  private readonly innerGrids: VariantPool<GridRenderer>;
  private innerGridCells: readonly [number, number][] = [];
  private innerGridLayers: { color: number; cells: [number, number][] }[] = [];

  private readonly glueTabRenderer: GlueTabRenderer;
  private readonly backgroundGrid: BackgroundGridLayer<ReturnType<typeof useMazeStore.getState>["vectorByWallsSettings"]>;
  // The layers below draw once per settings variant (GitHub issue #1040), each over the elements its variant owns.
  private readonly floor: VariantPool<CellFillRenderer>;
  private readonly closedCells: VariantPool<CellFillRenderer>;
  private readonly walls: VariantPool<WallRenderer>;
  /** Arrows of the start/finish openings (GitHub issue #330), drawn over the walls in the walls container. */
  private readonly openings: WaypointOpeningRenderer;
  private readonly splitJunctions: VariantPool<SplitJunctionRenderer>;
  private readonly teleports: VariantPool<TeleportRenderer>;
  /** Own instance, per `maze-web/CLAUDE.md`'s feature-renderer ownership rule (GitHub issue #347)
   *  — never shared with a future floor-aware `GenerationRenderer`'s own instance. */
  private readonly verticalConnections: VariantPool<VerticalConnectionRenderer>;
  private readonly markers: WaypointsRenderer;
  /** Own instance, per `maze-web/CLAUDE.md`'s feature-renderer ownership rule (GitHub issue #471). */
  private readonly markerIndex: VariantPool<MarkerIndexRenderer>;
  /** Marker index plates and elevator badges carried over a glued face (GitHub issue #981). */
  private readonly seamCopies: SeamCopyRenderer;
  private readonly floorLabel: FloorLabelRenderer;
  /** Own instance, not shared with `AnalyticsRenderer`'s issue-highlight overlay or
   *  `VectorByCorridorsRenderer`'s own — per `maze-web/CLAUDE.md`'s feature-renderer ownership
   *  rule. Highlights the currently hovered export warning's cells (GitHub issue #298 follow-up —
   *  cell fill reads much more clearly than a small marker circle), see
   *  `computeVectorByWallsWarningsAcrossFloors`. */
  private readonly warningHighlight: ExportWarningHighlight<ReturnType<typeof useMazeStore.getState>["vectorByWallsSettings"]>;

  private renderPass: RenderPass = "full";
  private viewport: Viewport = { x: 0, y: 0, w: 0, h: 0, scale: 1 };
  private unsubscribe: (() => void) | null = null;
  private readonly rerenderLoadedFont = () => {
    const state = useMazeStore.getState();
    if (state.openCard === "image_export") this.renderAll(state);
  };

  private geometryCache: {
    // Tracks the *unscoped* `state.nodes`/`state.edges`/`activeFloorId` identities (GitHub issue
    // #347), not the freshly-filtered floor-scoped arrays `selectFloorScopedMaze` returns each
    // call — a `.filter()` result is a new array reference every time even when nothing changed,
    // which would defeat this cache entirely if compared directly.
    rawNodes: NodeDto[];
    rawEdges: EdgeDto[];
    activeFloorId: string;
    cfg: FieldConfig;
    start: number | null;
    finish: number | null;
    splitNodeColors: readonly number[];
    teleportAvoidFieldExit: boolean;
    closedCells: [number, number][];
    wallEdges: WallEdge[];
    teleportEdges: TeleportEdge[];
    splitPassages: SplitPassage[];
    splitWallFaces: { v0: { x: number; y: number }; v1: { x: number; y: number } }[];
    splitSpecialShapes: SplitSpecialShape[];
    replaceTwoFloorElevatorsWithStairs: boolean;
    verticalConnectionMarkers: VerticalConnectionMarker[];
  } | null = null;

  constructor(root: Container) {
    window.addEventListener(LABEL_FONT_LOADED_EVENT, this.rerenderLoadedFont);
    this.backgroundGrid = new BackgroundGridLayer(root);
    const container = this.backgroundGrid.content;
    this.mazeContent = new Container();
    container.addChild(this.mazeContent);
    container.addChild(this.trimMask);

    this.floorContainer = new Container();
    this.closedCellsContainer = new Container();
    this.innerGridContainer = new Container();
    this.wallsContainer = new Container();
    this.splitJunctionContainer = new Container();
    this.teleportContainer = new Container();
    this.verticalContainer = new Container();
    this.markersContainer = new Container();
    this.markerIndexGapContainer = new Container();
    this.markerIndexBodyContainer = new Container();
    this.floorLabelContainer = new Container();

    this.mazeContent.addChild(this.floorContainer);
    this.mazeContent.addChild(this.closedCellsContainer);
    this.mazeContent.addChild(this.innerGridContainer);
    this.mazeContent.addChild(this.wallsContainer);
    this.mazeContent.addChild(this.splitJunctionContainer);
    this.mazeContent.addChild(this.markerIndexGapContainer);
    this.mazeContent.addChild(this.teleportContainer);
    this.mazeContent.addChild(this.verticalContainer);
    this.mazeContent.addChild(this.markersContainer);
    this.mazeContent.addChild(this.markerIndexBodyContainer);
    this.seamCopies = new SeamCopyRenderer(this.mazeContent);
    this.mazeContent.addChild(this.floorLabelContainer);
    this.warningHighlightContainer = new Container();
    this.backgroundGrid.highlight.addChild(this.warningHighlightContainer);

    this.glueTabRenderer = new GlueTabRenderer(this.backgroundGrid.glueTabs);
    this.floor = new VariantPool(() => new CellFillRenderer(this.floorContainer));
    this.closedCells = new VariantPool(() => new CellFillRenderer(this.closedCellsContainer));
    this.innerGrids = new VariantPool(() => new GridRenderer(this.innerGridContainer, "vector export inner grid"));
    this.walls = new VariantPool(() => new WallRenderer(this.wallsContainer));
    this.openings = new WaypointOpeningRenderer(this.wallsContainer);
    this.splitJunctions = new VariantPool(() => new SplitJunctionRenderer(this.splitJunctionContainer));
    this.teleports = new VariantPool(() => new TeleportRenderer(this.teleportContainer));
    this.verticalConnections = new VariantPool(() => new VerticalConnectionRenderer(this.verticalContainer));
    this.markers = new WaypointsRenderer(this.markersContainer);
    this.markerIndex = new VariantPool(() => new MarkerIndexRenderer(this.markerIndexGapContainer, this.markerIndexBodyContainer));
    this.floorLabel = new FloorLabelRenderer(this.floorLabelContainer);
    this.warningHighlight = new ExportWarningHighlight(this.warningHighlightContainer);
    // Inside the warning highlight container (shown with the renderer): above the boundary highlight, below the connector shapes.
    const coordinateWarningContainer = new Container();
    this.warningHighlightContainer.addChildAt(coordinateWarningContainer, 1);
    this.coordinateWarning = new CoordinateWarningHighlight(coordinateWarningContainer, (state) => state.openCard === "image_export");

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
        state.activeFieldConfig !== prev.activeFieldConfig ||
        state.activeFloorId !== prev.activeFloorId ||
        state.floors !== prev.floors ||
        state.floorTopology !== prev.floorTopology ||
        state.pngExportSettings.cuts !== prev.pngExportSettings.cuts ||
        state.exportZoneOverrides !== prev.exportZoneOverrides ||
        state.zones !== prev.zones ||
        state.zoneGroups !== prev.zoneGroups;

      const settingsChanged = state.vectorByWallsSettings !== prev.vectorByWallsSettings;
      if ((dataChanged || settingsChanged) && state.openCard === "image_export") {
        this.renderAll(state);
      } else if ((state.hoveredExportWarningKey !== prev.hoveredExportWarningKey || state.hoveredTeleportNodeIds !== prev.hoveredTeleportNodeIds || state.hoveredTeleportCells !== prev.hoveredTeleportCells) && state.openCard === "image_export") {
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
    this.innerGridContainer.visible = visible && state.vectorByWallsSettings.showInnerGrid;
    this.wallsContainer.visible = visible;
    this.splitJunctionContainer.visible = visible;
    this.teleportContainer.visible = visible;
    this.verticalContainer.visible = visible;
    this.markersContainer.visible = visible;
    this.markerIndexGapContainer.visible = visible;
    this.markerIndexBodyContainer.visible = visible;
    this.seamCopies.container.visible = visible;
    this.floorLabelContainer.visible = visible;
    this.warningHighlightContainer.visible = visible;
    if (visible) this.renderAll(state);
  }

  onViewportChanged(x: number, y: number, w: number, h: number, scale: number): void {
    this.viewport = { x, y, w, h, scale };
    this.backgroundGrid.onViewportChanged(this.viewport);
    const state = useMazeStore.getState();
    if (state.openCard === "image_export") {
      this.backgroundGrid.render(state.vectorByWallsSettings, state.activeFieldConfig);
      this.innerGridContainer.visible = state.vectorByWallsSettings.showInnerGrid;
      // Hidden content (the backdrop pass of a cut sheet) needs no grid of its own.
      if (state.vectorByWallsSettings.showInnerGrid && this.renderPass !== "backdrop" && this.renderPass !== "overlay") {
        this.drawInnerGrid(state.activeFieldConfig);
      }
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
    const cellBounds = exactCellBounds(floorNodes, state.activeFieldConfig);
    return measureContentMargin(
      [this.floorContainer, this.closedCellsContainer, this.wallsContainer, this.splitJunctionContainer, this.teleportContainer, this.verticalContainer, this.markersContainer, this.markerIndexGapContainer, this.markerIndexBodyContainer, this.floorLabelContainer],
      cellBounds,
    );
  }

  /** Everything is content; the overlay stays empty. */
  readonly hasOverlay = false;

  get layers(): ModeRenderer["layers"] {
    return this.backgroundGrid;
  }

  setRenderPass(pass: RenderPass): void {
    this.renderPass = pass;
    this.backgroundGrid.setPass(pass);
  }

  getBackgroundColor(): number {
    const state = useMazeStore.getState();
    return resolveBackgroundColor("vector_by_walls", { vectorByWallsSettings: state.vectorByWallsSettings, vectorByCorridorsSettings: state.vectorByCorridorsSettings });
  }

  private resolveTeleportGroupOverrides(
    state: ReturnType<typeof useMazeStore.getState>,
    rawEndpoints: { start: number | null; finish: number | null },
    teleportEdges: TeleportEdge[],
  ): Record<string, TeleportGroupOverride> {
    const settings = withResolvedGroupOverrides(state.vectorByWallsSettings);
    if (!settings.teleportGroupCustomization) return settings.teleportGroupOverrides;
    return resolveRendererGroupOverrides(buildTeleportGroups(teleportEdges, settings.teleportMergeMode), settings.teleportGroupOverrides, {
      nodes: state.nodes, edges: state.edges, cfg: state.activeFieldConfig, floors: state.floors,
      avoidFieldExit: settings.teleportAvoidFieldExit, start: rawEndpoints.start, finish: rawEndpoints.finish,
      mergeTeleports: settings.teleportMergeMode,
    });
  }

  private renderAll(state: ReturnType<typeof useMazeStore.getState>): void {
    const cfg = state.activeFieldConfig;

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
    const activeFloorIndex = Math.max(state.floors.findIndex((f) => f.id === state.activeFloorId), 0);
    const nodeById = new Map(nodes.map(n => [n.id, n]));
    // Zone overrides of the export parameters (GitHub issue #1040): an element draws with the settings of the cell that owns it.
    const zoneValues = buildExportZoneValues(state.exportZoneOverrides, "walls", state.zones, state.zoneGroups, state.vectorByWallsSettings);
    const variants = new ZoneVariants(state.vectorByWallsSettings, (cells) => zoneValues.settingsAt(activeFloorIndex, cells));
    const cellOfNode = (id: number | null | undefined): [number, number][] => { const node = id == null ? undefined : nodeById.get(id); return node ? [[node.x, node.y]] : []; };
    const cellOfPoint = (key: string): [number, number][] => { const [x, y] = key.split(",").map(Number); return Number.isFinite(x) && Number.isFinite(y) ? [[x, y]] : []; };
    this.innerGridCells = nodes.map((node): [number, number] => [node.x, node.y]);
    if (state.vectorByWallsSettings.trimWallsAtFaceBoundaries !== false) {
      const maskInputs = { nodes: state.nodes, floorId: state.activeFloorId, cfg, topology: state.floorTopology?.[state.activeFloorId] };
      if (
        !this.trimMaskInputs || this.trimMaskInputs.nodes !== maskInputs.nodes || this.trimMaskInputs.floorId !== maskInputs.floorId ||
        this.trimMaskInputs.cfg !== maskInputs.cfg || this.trimMaskInputs.topology !== maskInputs.topology
      ) {
        const bounds = exactCellBounds(nodes, cfg);
        const fieldSpan = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY, 1);
        drawTrimMask(this.trimMask, this.innerGridCells, cfg, fieldSpan + 512);
        this.trimMaskInputs = maskInputs;
      }
      this.mazeContent.mask = this.trimMask;
    } else {
      this.mazeContent.mask = null;
      this.trimMask.clear();
      this.trimMaskInputs = null;
    }
    this.innerGridContainer.visible = state.vectorByWallsSettings.showInnerGrid;
    if (state.vectorByWallsSettings.showInnerGrid) {
      const parts = variants.partition(this.innerGridCells, (cell) => [cell]);
      this.innerGridLayers = parts.map((cells, variant) => ({ color: variants.list[variant].innerGridColor, cells }));
      this.drawInnerGrid(cfg);
    }
    this.glueTabRenderer.render(selectExportGlueTabs(state, state.vectorByWallsSettings.glueTabs), state.vectorByWallsSettings.glueTabs);
    this.backgroundGrid.render(state.vectorByWallsSettings, cfg);
    // Resolves a `vertical_passage`/`elevator` edge's `to` node's own floor (GitHub issue #347) —
    // built from the *unscoped* node list, since `to` never survives the floor-scoping above.
    const resolveNodeLevel = selectNodeLevelResolver(state.nodes);
    const verticalPairs = selectVerticalPassagePairSet(state.edges);
    const cells: [number, number][] = nodes.map(n => [n.x, n.y]);
    const floorParts = variants.partition(cells, (cell) => [cell]);
    this.floor.drawAll(Math.max(floorParts.length, 1), (renderer, variant) => renderer.render({ cells: variant === null ? [] : floorParts[variant] ?? [], color: variants.list[variant ?? 0].floorColor, alpha: 1 }, cfg));

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
      this.geometryCache.replaceTwoFloorElevatorsWithStairs !== state.vectorByWallsSettings.replaceTwoFloorElevatorsWithStairs ||
      this.geometryCache.teleportAvoidFieldExit !== state.vectorByWallsSettings.teleportAvoidFieldExit
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
      const wallEdges = buildMazeWalls(nodes, edges, cfg);
      this.geometryCache = {
        rawNodes: state.nodes,
        rawEdges: state.edges,
        activeFloorId: state.activeFloorId,
        cfg,
        start,
        finish,
        splitNodeColors,
        teleportAvoidFieldExit: state.vectorByWallsSettings.teleportAvoidFieldExit,
        closedCells: buildClosedCells(nodes, edges, state.edges),
        wallEdges,
        teleportEdges: (() => {
          const { floorContext, spread } = buildTeleportFloorInputs({
            unscopedNodes: state.nodes,
            unscopedEdges: state.edges,
            floors: state.floors,
            activeFloorId: state.activeFloorId,
            start: rawEndpoints.start,
            finish: rawEndpoints.finish,
            allowOutOfField: !state.vectorByWallsSettings.teleportAvoidFieldExit,
            fieldCells: state.nodes.map((n): [number, number] => [n.x, n.y]),
          });
          return buildTeleportEdges(nodeById, edges, cfg, floorContext, spread);
        })(),
        splitPassages,
        splitWallFaces,
        splitSpecialShapes,
        replaceTwoFloorElevatorsWithStairs: state.vectorByWallsSettings.replaceTwoFloorElevatorsWithStairs,
        verticalConnectionMarkers: buildVerticalConnectionMarkers(nodeById, edges, cfg, resolveNodeLevel, activeFloorIndex, verticalPairs, state.edges, state.vectorByWallsSettings.replaceTwoFloorElevatorsWithStairs),
      };
    }
    const global = state.vectorByWallsSettings;
    const cache = this.geometryCache;
    const closedParts = variants.partition(cache.closedCells, (cell) => [cell]);
    this.closedCells.drawAll(closedParts.length, (renderer, variant) => renderer.render({ cells: variant === null ? [] : closedParts[variant] ?? [], color: variants.list[variant ?? 0].wallColor, alpha: 1 }, cfg));
    const { paths: extraWalls, noCapPoints } = collectSplitWallPaths(cache.splitWallFaces, cache.splitSpecialShapes, global.splitSpecialShapes);
    // Start/finish external passages (GitHub issue #330): per mode, the chosen outer wall segment is left out and/or a pointer is drawn on it.
    // Each endpoint takes the settings of the zone holding its cell (GitHub issue #1040), so a regeneration that moves it follows that zone.
    const startVariant = variants.list[variants.of(cellOfNode(start))];
    const finishVariant = variants.list[variants.of(cellOfNode(finish))];
    const openings = buildWaypointOpenings({ startOpening: startVariant.startOpening, finishOpening: finishVariant.finishOpening }, nodeById, start, finish, cells, cfg);
    const cutOpenings = openings.filter((o) => openingCutsWall(o.mode));
    // A wall belongs to the cells on both its sides; a one-way wall to the cell it leads out of.
    const wallOwner = (edge: WallEdge): [number, number][] => (edge.oneWayDir ? [edge.kind === "forward" ? edge.a : edge.b] : [edge.a, edge.b]);
    const wallParts = variants.partition(
      cutOpenings.length === 0 ? cache.wallEdges : cache.wallEdges.filter((e) => !cutOpenings.some((o) => isOpeningWall(e, o.cell, o.outer))),
      wallOwner,
    );
    this.walls.drawAll(Math.max(wallParts.length, 1), (renderer, variant) => {
      const settings = variants.list[variant ?? 0];
      renderer.render(
        { edges: variant === null ? [] : wallParts[variant] ?? [] },
        cfg, buildWallStyle(settings), buildOneWayStyle(settings),
        // The split points' own wall shapes are drawn once, with the global style.
        variant === 0 ? extraWalls : undefined, variant === 0 ? noCapPoints : undefined,
        settings.randomWallColorMode,
        { floorColor: settings.floorColor, backgroundColor: global.background },
      );
    });
    this.openings.render(openings.filter((o) => openingShowsPointer(o.mode)).map(({ kind, mode, outer, x, y, dx, dy }) => {
      const settings = kind === "start" ? startVariant : finishVariant;
      const { pattern, color, geometry, gapWidth, join } = kind === "start" ? settings.startOpening : settings.finishOpening;
      return {
        x, y, dx, dy,
        style: { ...buildOneWayStyle(settings), pattern, color, ...resolveIndicatorMetrics(pattern, geometry, DEFAULT_MAZE_RENDER_STYLE.oneWay), gapWidth, join, cap: join === "miter" ? "square" : "round" },
        // The gap stops at the floor's edge (the wall's centre line); under a wall that stays it goes on to the wall's outer edge.
        clip: { nx: outer.outward.x, ny: outer.outward.y, side: outer.polyline, reach: openingGapReach(mode, buildWallStyle(settings).width ?? WALL_THICKNESS) },
      };
    }));
    const passageParts = variants.partition(cache.splitPassages, (passage) => cellOfPoint(passage.pointKey));
    const splitStyle: SplitStyleOverride = { specialShapes: global.splitSpecialShapes };
    this.splitJunctions.drawAll(Math.max(passageParts.length, 1), (renderer, variant) => {
      renderer.render(
        { passages: variant === null ? [] : passageParts[variant] ?? [], wallFaces: variant === 0 ? cache.splitWallFaces : [], specialShapes: variant === 0 ? cache.splitSpecialShapes : [] },
        buildWallStyle(variants.list[variant ?? 0]),
        splitStyle,
      );
    });
    const { floorColor } = global;
    const verticalStyle = buildVerticalConnectionStyle(global, floorColor, global);
    // Marker positioning layer (GitHub issue #735) � several markers on one host get distinct slots;
    // everything below draws from the laid-out copies, never the raw geometry-cache arrays. The layout is global: a
    // zone changes how an element looks, not where it sits.
    const layoutWith = (verticalMarkers: VerticalConnectionMarker[]) => layoutExportMarkers({
      markers: buildMazeMarkers(
        nodeById, start, finish, cfg,
        buildMarkerStyle(startVariant.startMarker, startVariant.floorColor),
        buildMarkerStyle(finishVariant.finishMarker, finishVariant.floorColor),
        edges,
      ),
      teleportEdges: cache.teleportEdges,
      verticalMarkers,
      settings: global,
      verticalStyle,
      splitHostKeys: buildSplitHostKeys(nodeById, edges, cfg),
    });
    const layout = layoutWith(cache.verticalConnectionMarkers);
    // "Replace two-floor elevators with stairs" can differ per zone: the markers are built (and laid out) once per value in use.
    const layoutByStairs = new Map<boolean, ReturnType<typeof layoutWith>>([[global.replaceTwoFloorElevatorsWithStairs, layout]]);
    const layoutFor = (replaceWithStairs: boolean) => {
      let found = layoutByStairs.get(replaceWithStairs);
      if (!found) {
        found = layoutWith(buildVerticalConnectionMarkers(nodeById, edges, cfg, resolveNodeLevel, activeFloorIndex, verticalPairs, state.edges, replaceWithStairs));
        layoutByStairs.set(replaceWithStairs, found);
      }
      return found;
    };
    const markerData = layout.markers;
    // Also avoid vertical passage/elevator markers and one-way wall indicators (GitHub issue #518).
    const teleportWaypoints = buildTeleportAvoidanceWaypoints({
      markers: markerData,
      verticalMarkers: layout.verticalMarkers,
      oneWayWallEdges: cache.wallEdges,
      cfg,
      splitPassages: cache.splitPassages,
    });
    // Overrides are stored under project-wide (cross-floor merged) group keys; re-key them onto this floor's groups.
    const teleportGroupOverrides = this.resolveTeleportGroupOverrides(state, rawEndpoints, layout.teleportEdges);
    const teleportStyle = buildTeleportLineStyle(global, floorColor);
    // Marker size adaptation (GitHub issue #819): one scaler for every marker kind on this floor,
    // fitted against the laid-out positions (GitHub issue #735).
    const scaler = buildMarkerScaler(cfg, [
      ...footprintsOfMarkers(markerData),
      ...footprintsOfVertical(layout.verticalMarkers, verticalStyle),
      ...footprintsOfTeleports(layout.teleportEdges, teleportStyle),
    ]);
    // A teleport connector belongs to the cell it starts in.
    const teleportParts = variants.partition(layout.teleportEdges, (edge) => cellOfNode(edge.fromNode));
    this.teleports.drawAll(Math.max(teleportParts.length, 1), (renderer, variant) => {
      const settings = variants.list[variant ?? 0];
      renderer.render({
        edges: variant === null ? [] : teleportParts[variant] ?? [],
        scaler,
        lineStyle: buildTeleportLineStyle(settings, settings.floorColor),
        groupCustomization: global.teleportGroupCustomization,
        groupOverrides: teleportGroupOverrides,
        // Cross-floor teleport/elevator badges are always click-to-switch-floor on the export
        // canvas (GitHub issue #478) � a read-only view like `GenerationRenderer`/`AnalyticsRenderer`,
        // so no tool-driven gating applies.
        floorNavigable: true,
        cfg,
        waypoints: teleportWaypoints,
        avoidFieldExit: global.teleportAvoidFieldExit,
        fieldCells: cells,
        mergeTeleports: global.teleportMergeMode,
        seam: global.teleportThroughSeams !== false ? { cfg } : undefined,
        manualPaths: global.manualTeleportConnectorPaths,
      });
    });

    const waypointData = { markers: markerData, scaler };
    this.markers.render(waypointData);

    let markerIndexPlates: ElevatorBadgeObstacle[] = [];
    const markerIndexData: MarkerIndexRenderData[] = [];
    // A zone can switch the plates on for its own cells (GitHub issue #1040), so the labels are also built when one sets that.
    const zoneEnablesIndex = zoneValues.any && state.exportZoneOverrides.some((o) => o.mode === "walls" && "markerIndex.enabled" in o.params);
    if (global.markerIndex.enabled || zoneEnablesIndex) {
      const resolveEndpointVisual = buildMarkerIndexEndpointResolver({
        teleportEdges: layout.teleportEdges,
        teleportStyle,
        groupCustomization: global.teleportGroupCustomization,
        mergeTeleports: global.teleportMergeMode,
        groupOverrides: teleportGroupOverrides,
        verticalStyle,
      });
      const projectGroups = getProjectTeleportGroups({
        nodes: state.nodes, edges: state.edges, cfg, floors: state.floors,
        avoidFieldExit: global.teleportAvoidFieldExit, start: rawEndpoints.start, finish: rawEndpoints.finish,
        mergeTeleports: global.teleportMergeMode,
      });
      const indexLabels = buildMarkerIndexLabels(state.nodes, state.edges, cfg, activeFloorIndex, global.markerIndex, resolveEndpointVisual, scaler, projectGroups);
      const shiftedLabels = shiftMarkerIndexLabels(indexLabels.labels, layout.shifts, layout.scales);
      // A plate belongs to the cell of the node it is anchored on.
      const labelParts = variants.partition(shiftedLabels, (label) => cellOfNode(label.nodeId));
      markerIndexPlates = labelParts.flatMap((labels, variant) => (variants.list[variant].markerIndex.enabled ? labels.map((label) => markerIndexPlateFootprint(label, variants.list[variant].markerIndex)) : []));
      for (let variant = 0; variant < variants.list.length; variant++) {
        const settings = variants.list[variant];
        markerIndexData.push({ ...indexLabels, labels: settings.markerIndex.enabled ? labelParts[variant] ?? [] : [], style: settings.markerIndex, floorColor: settings.floorColor });
      }
    }
    this.markerIndex.drawAll(markerIndexData.length, (renderer, variant) => (variant === null ? renderer.clear() : renderer.render(markerIndexData[variant])));

    // A vertical connection belongs to the cell of its node.
    variants.partition(layout.verticalMarkers, (marker) => cellOfNode(marker.fromNode));
    const verticalData: VerticalConnectionRenderData[] = [];
    for (let variant = 0; variant < variants.list.length; variant++) {
      const settings = variants.list[variant];
      verticalData.push({
        markers: layoutFor(settings.replaceTwoFloorElevatorsWithStairs).verticalMarkers.filter((marker) => variants.of(cellOfNode(marker.fromNode)) === variant),
        style: buildVerticalConnectionStyle(settings, settings.floorColor, settings),
        scaler,
        // Vertical-passage markers navigate to their target floor on the export canvas (GitHub
        // issue #478) � always-on, same as `GenerationRenderer`'s read-only canvas.
        interactive: true,
        // Elevator floor badges keep clear of the index plates drawn above the markers (GitHub issue #964).
        badgeObstacles: markerIndexPlates,
      });
    }
    this.verticalConnections.drawAll(verticalData.length, (renderer, variant) => renderer.render(variant === null ? { ...verticalData[0], markers: [] } : verticalData[variant]));
    // The trim mask cuts the plates and badges at a glued face; what they lose is drawn on the other side (GitHub issue #981).
    this.seamCopies.render(
      cfg,
      this.mazeContent.mask
        ? verticalData.flatMap((vertical, variant) => buildSeamCopySources({ markerIndex: markerIndexData[variant] ?? null, vertical, waypoints: variant === 0 ? waypointData : null }))
        : [],
    );

    this.floorLabel.render(
      state.vectorByWallsSettings.floorLabel,
      floorLabelPosition(state.vectorByWallsSettings.floorLabel, state.activeFloorId, exactCellBounds(nodes, cfg), cfg),
      activeFloorIndex,
      state.floors.length,
      floorColor,
      state.floors[activeFloorIndex]?.title,
    );

    this.renderWarningHighlight(state);
  }

  /** Highlights the currently hovered export warning's flagged cell(s) (GitHub issue #298
   *  follow-up — a small marker-circle highlight read too weakly, cell fill is much clearer) — see
   *  `ExportWarningHighlight`'s own doc comment for the draw mechanics, shared with
   *  `VectorByCorridorsRenderer`'s own copy of this method. */
  /** Draws the inner grid, one grid per settings variant, over the viewport. */
  private drawInnerGrid(cfg: FieldConfig): void {
    const layers = this.innerGridLayers;
    this.innerGrids.drawAll(layers.length, (grid, variant) => {
      const layer = variant === null ? undefined : layers[variant];
      grid.render({ viewport: this.viewport, color: layer?.color }, cfg, layer?.cells ?? []);
    });
  }

  private renderWarningHighlight(state: ReturnType<typeof useMazeStore.getState>): void {
    const { hoveredExportWarningKey, hoveredTeleportNodeIds, hoveredTeleportCells } = state;
    if (!hoveredExportWarningKey) {
      if (hoveredTeleportNodeIds || hoveredTeleportCells) {
        const activeFloorIndex = Math.max(state.floors.findIndex((f) => f.id === state.activeFloorId), 0);
        const { nodes } = selectFloorScopedMaze(
          state.nodes, state.edges, state.floors, state.activeFloorId, null, null,
        );
        this.warningHighlight.renderNodes(
          hoveredTeleportNodeIds, nodes, state.activeFieldConfig, state.vectorByWallsSettings,
          getCellHighlightInset(state.vectorByWallsSettings.wallThickness),
          (hoveredTeleportCells ?? []).filter((cell) => cell.floorIndex === activeFloorIndex).map((cell): [number, number] => [cell.x, cell.y]),
        );
      } else {
        this.warningHighlight.render(null, [], [], state.activeFieldConfig, state.vectorByWallsSettings);
      }
      return;
    }
    const rawEndpoints = resolveEffectiveEndpoints(state);
    // Same floor-scoping as `renderAll` (GitHub issue #347) — the warning computation must see
    // exactly the drawn floor's own nodes/edges, or a hovered warning's `nodes`/`edges` could
    // reference an id that isn't actually rendered.
    const { nodes } = selectFloorScopedMaze(
      state.nodes, state.edges, state.floors, state.activeFloorId, rawEndpoints.start, rawEndpoints.finish,
    );
    const warnings = [...computeVectorByWallsWarningsAcrossFloors(
      state.nodes, state.edges, state.floors, state.activeFieldConfig, state.vectorByWallsSettings,
      rawEndpoints.start, rawEndpoints.finish, floorIdsWithCut(state.floors, state.activeFieldConfig, state.floorTopology, state.pngExportSettings.cuts),
      hasAnyGlue(state.floorTopology),
    ), ...computeTopologyWarnings(state, state.vectorByWallsSettings, rawEndpoints)];
    const wallInset = getCellHighlightInset(state.vectorByWallsSettings.wallThickness);
    this.warningHighlight.render(hoveredExportWarningKey, warnings, nodes, state.activeFieldConfig, state.vectorByWallsSettings, wallInset,
      // Boundary band as wide as the live one-way indicator, like the analytics highlight; without it the band spans the whole distance between the two cell centers.
      oneWayIndicatorSpan(buildOneWayStyle(state.vectorByWallsSettings)));
  }

  destroy(): void {
    window.removeEventListener(LABEL_FONT_LOADED_EVENT, this.rerenderLoadedFont);
    this.unsubscribe?.();
    this.glueTabRenderer.destroy();
    this.backgroundGrid.destroy();
    this.floor.destroy();
    this.closedCells.destroy();
    this.innerGrids.destroy();
    this.walls.destroy();
    this.openings.destroy();
    this.splitJunctions.destroy();
    this.teleports.destroy();
    this.verticalConnections.destroy();
    this.markers.destroy();
    this.markerIndex.destroy();
    this.seamCopies.destroy();
    this.floorLabel.destroy();
    this.coordinateWarning.destroy();
    this.warningHighlight.destroy();
    this.trimMask.destroy();
    this.mazeContent.destroy();
    this.floorContainer.destroy();
    this.closedCellsContainer.destroy();
    this.innerGridContainer.destroy();
    this.wallsContainer.destroy();
    this.splitJunctionContainer.destroy();
    this.teleportContainer.destroy();
    this.verticalContainer.destroy();
    this.markersContainer.destroy();
    this.markerIndexGapContainer.destroy();
    this.markerIndexBodyContainer.destroy();
    this.floorLabelContainer.destroy();
    this.warningHighlightContainer.destroy();
  }
}

export {
  buildEffectiveSplitNodeColors, viewportWorldRect, buildWallStyle, buildOneWayStyle,
  buildTeleportLineStyle, buildVerticalConnectionStyle, buildMarkerStyle, resolveEffectiveEndpoints,
  buildMarkerIndexEndpointResolver, layoutExportMarkers,
} from "./exportStyleBuilders";
