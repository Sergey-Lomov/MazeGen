import { Container, Graphics } from "pixi.js";
import { floorIdsWithCut } from "./exportContent";
import { useMazeStore } from "../../store/mazeStore";
import { LABEL_FONT_LOADED_EVENT } from "../renderers/fontChoice";
import { CellFillRenderer } from "../renderers/CellFillRenderer";
import { WallRenderer } from "../renderers/WallRenderer";
import { WaypointsRenderer } from "../renderers/WaypointsRenderer";
import { buildMarkerScaler } from "../markerScale";
import { footprintsOfMarkers, footprintsOfTeleports, footprintsOfVertical } from "../markerFootprints";
import { TeleportRenderer } from "../renderers/TeleportRenderer";
import { GridRenderer } from "../renderers/GridRenderer";
import { SplitJunctionRenderer, collectSplitWallPaths } from "../renderers/SplitJunctionRenderer";
import { oneWayIndicatorSpan } from "../renderers/wallUtils";
import { RegionHighlightRenderer } from "../renderers/RegionHighlightRenderer";
import { VerticalConnectionRenderer } from "../renderers/VerticalConnectionRenderer";
import { buildMazeWalls, buildMazeMarkers, buildTeleportEdges, buildTeleportFloorInputs, buildClosedCells, buildSplitPassages, maxSplitNodeCount, selectFloorScopedMaze, selectNodeLevelResolver, buildVerticalConnectionMarkers, selectVerticalPassagePairSet, buildMarkerIndexLabels, markerIndexPlateFootprint, buildTeleportAvoidanceWaypoints } from "../selectors/mazeSelectors";
import type { ElevatorBadgeObstacle } from "../renderers/elevatorBadgeLayout";
import { hasAnyGlue } from "../selectors/colorFieldRegistry";
import { buildSplitHostKeys, shiftMarkerIndexLabels } from "../selectors/mazeSelectors/markerLayout";
import { MarkerIndexRenderer, type MarkerIndexRenderData } from "../renderers/MarkerIndexRenderer";
import { SeamCopyRenderer } from "../renderers/SeamCopyRenderer";
import { buildSeamCopySources } from "./seamCopySources";
import { FloorLabelRenderer, floorLabelPosition } from "../renderers/FloorLabelRenderer";
import { computeVectorByWallsWarningsAcrossFloors } from "../selectors/exportWarnings";
import { computeTopologyWarnings } from "../selectors/topologyWarnings";
import type { ExportWarning } from "../selectors/exportWarnings";
import type { NodeDto, EdgeDto } from "../../wasm/types";
import type { Viewport, WallEdge, TeleportEdge, SplitPassage, SplitSpecialShape, SplitStyleOverride, VerticalConnectionMarker, TeleportGroupOverride } from "../renderers/types";
import type { FieldConfig } from "../../fieldConfig";
import { resolveBackgroundColor, measureContentMargin, type ExportMargin } from "./exportMargins";
import type { ModeRenderer, RenderPass } from "./modeRendererFactory";
import { exactCellBounds } from "../tessellationGeometry";
import { drawTrimMask } from "./seamTrim";
import { canvas } from "../colorTokens";
import { withResolvedGroupOverrides } from "../../store/teleportGroupLinks";
import { resolveRendererGroupOverrides, getProjectTeleportGroups } from "../selectors/projectTeleportGroups";
import { buildTeleportGroups } from "../selectors/teleportGroups";
import { selectExportGlueTabs } from "./glueTabExport";
import { GlueTabRenderer } from "../renderers/GlueTabRenderer";
import { getCellHighlightInset } from "../cellHighlightGeometry";
import { POLYGON_HIGHLIGHT_RADIUS, WARNING_HIGHLIGHT_COLOR } from "../renderConstants";
import { roundedContourCorners } from "./roundedContour";
import {
  buildEffectiveSplitNodeColors, viewportWorldRect, buildWallStyle, buildOneWayStyle,
  buildTeleportLineStyle, buildVerticalConnectionStyle, buildMarkerStyle, resolveEffectiveEndpoints,
  buildMarkerIndexEndpointResolver, layoutExportMarkers,
} from "./exportStyleBuilders";


/** Warnings about a one-way passage itself: highlighted as the passage's shared boundary (walls) or
 *  its two cells (corridors) rather than as plain cell regions. */
const BOUNDARY_WARNING_IDS: ReadonlySet<string> = new Set([
  "one_way_low_contrast_corridor", "one_way_arrows_overflow_corridor", "teleport_connector_covers_one_way",
]);

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
      this.shapes.fill({ color: WARNING_HIGHLIGHT_COLOR, alpha: 0.25 });
      this.shapes.stroke({ width: 3, color: WARNING_HIGHLIGHT_COLOR, join: "round", cap: "round" });
    }
    if (!warning || (warning.nodes.length === 0 && (!warning.cells || warning.cells.length === 0))) {
      this.highlight.clear();
      return;
    }

    const isSplitWarning = warning.id.includes("split") || warning.id === "waypoint_on_split" || warning.id === "teleport_on_special_split" || warning.id === "vertical_on_special_split";

    // Several split nodes can occupy one tile. Split warnings use one region group for all their
    // affected tiles, so adjacent tiles can merge into one contour just like ordinary regions.
    const nodesByTile = new Map<string, number[]>();
    for (const id of warning.nodes) {
      const node = nodes.find((candidate) => candidate.id === id);
      if (!node) continue;
      const key = `${node.x},${node.y}`;
      const group = nodesByTile.get(key) ?? [];
      group.push(id);
      nodesByTile.set(key, group);
    }
    const tileGroups = Array.from(nodesByTile.values());
    const isBoundaryWarning = BOUNDARY_WARNING_IDS.has(warning.id);
    const renderBoundaryAsRegion = isBoundaryWarning && boundaryWarningsAsRegions;
    const boundaryRegionGroups = renderBoundaryAsRegion
      ? warning.edges.map(([from, to]) => [from, to])
      : undefined;
    this.highlight.render({
      nodes,
      regionGroups: isBoundaryWarning && !renderBoundaryAsRegion ? [] : isSplitWarning
        ? [Array.from(new Set(tileGroups.flat()))]
        : boundaryRegionGroups ?? tileGroups,
      cells: (warning.cells ?? [])
        .filter((cell) => (nodes[0]?.level ?? 0) === cell.floorIndex)
        .map((cell) => [cell.x, cell.y]),
      color: WARNING_HIGHLIGHT_COLOR,
      width: 0,
      alpha: 0,
      cfg,
      skipPerimeter: true,
      inset,
      insetMode: isSplitWarning ? "outset" : "inset",
      cornerStyle: ((settings as unknown as Record<string, unknown>).join ??
        (settings as unknown as Record<string, unknown>).wallJoin) === "round" ? "round" : "sharp",
      boundaryEdges: isBoundaryWarning && !renderBoundaryAsRegion ? warning.edges : undefined,
      boundaryWidth,
    });
  }

  /** Highlights the cells of `nodeIds` (teleport-group list hover) in the post-edit hover color
   *  (`canvas.fieldEditor.hover`). Ids absent from `nodes` (other floors) are skipped; `null`/empty clears. */
  renderNodes(
    nodeIds: number[] | null,
    nodes: NodeDto[],
    cfg: FieldConfig,
    settings: TSettings,
    inset = 2,
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
    if (tileGroups.size === 0) {
      this.highlight.clear();
      return;
    }
    this.highlight.render({
      nodes,
      regionGroups: Array.from(tileGroups.values()),
      cells: [],
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
  getTeleportConnectorPaths(): readonly { edge: import("../renderers/types").TeleportEdge; points: readonly number[] }[] {
    // The base renderer can be in a backdrop-only pass while a cut sheet is displayed. Refreshing
    // its plan here keeps the editor independent of that presentation pass.
    this.renderAll(useMazeStore.getState());
    return this.teleports.getConnectorPaths();
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
  /** Optional grid overlay inside the filled maze cells, below walls and markers. */
  private readonly innerGridContainer: Container;
  private readonly innerGrid: GridRenderer;
  private innerGridCells: readonly [number, number][] = [];

  private readonly glueTabRenderer: GlueTabRenderer;
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
  /** Own instance, per `maze-web/CLAUDE.md`'s feature-renderer ownership rule (GitHub issue #471). */
  private readonly markerIndex: MarkerIndexRenderer;
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
    this.floor = new CellFillRenderer(this.floorContainer);
    this.closedCells = new CellFillRenderer(this.closedCellsContainer);
    this.innerGrid = new GridRenderer(this.innerGridContainer, "vector export inner grid");
    this.walls = new WallRenderer(this.wallsContainer);
    this.splitJunctions = new SplitJunctionRenderer(this.splitJunctionContainer);
    this.teleports = new TeleportRenderer(this.teleportContainer);
    this.verticalConnections = new VerticalConnectionRenderer(this.verticalContainer);
    this.markers = new WaypointsRenderer(this.markersContainer);
    this.markerIndex = new MarkerIndexRenderer(this.markerIndexGapContainer, this.markerIndexBodyContainer);
    this.floorLabel = new FloorLabelRenderer(this.floorLabelContainer);
    this.warningHighlight = new ExportWarningHighlight(this.warningHighlightContainer);

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
        state.pngExportSettings.cuts !== prev.pngExportSettings.cuts;

      const settingsChanged = state.vectorByWallsSettings !== prev.vectorByWallsSettings;
      if ((dataChanged || settingsChanged) && state.openCard === "image_export") {
        this.renderAll(state);
      } else if ((state.hoveredExportWarningKey !== prev.hoveredExportWarningKey || state.hoveredTeleportNodeIds !== prev.hoveredTeleportNodeIds) && state.openCard === "image_export") {
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
        this.innerGrid.render(
          { viewport: this.viewport, color: state.vectorByWallsSettings.innerGridColor },
          state.activeFieldConfig,
          this.innerGridCells,
        );
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
      this.innerGrid.render({ viewport: this.viewport, color: state.vectorByWallsSettings.innerGridColor }, cfg, this.innerGridCells);
    }
    this.glueTabRenderer.render(selectExportGlueTabs(state, state.vectorByWallsSettings.glueTabs), state.vectorByWallsSettings.glueTabs);
    this.backgroundGrid.render(state.vectorByWallsSettings, cfg);
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
    const verticalStyle = buildVerticalConnectionStyle(state.vectorByWallsSettings, floorColor, state.vectorByWallsSettings);
    // Marker positioning layer (GitHub issue #735) — several markers on one host get distinct slots;
    // everything below draws from the laid-out copies, never the raw geometry-cache arrays.
    const layout = layoutExportMarkers({
      markers: buildMazeMarkers(
        nodeById, start, finish, cfg,
        buildMarkerStyle(startMarker, floorColor),
        buildMarkerStyle(finishMarker, floorColor),
        edges,
      ),
      teleportEdges: this.geometryCache.teleportEdges,
      verticalMarkers: this.geometryCache.verticalConnectionMarkers,
      settings: state.vectorByWallsSettings,
      verticalStyle,
      splitHostKeys: buildSplitHostKeys(nodeById, edges, cfg),
    });
    const markerData = layout.markers;
    // Also avoid vertical passage/elevator markers and one-way wall indicators (GitHub issue #518).
    const teleportWaypoints = buildTeleportAvoidanceWaypoints({
      markers: markerData,
      verticalMarkers: layout.verticalMarkers,
      oneWayWallEdges: this.geometryCache.wallEdges,
      cfg,
      splitPassages: this.geometryCache.splitPassages,
    });
    // Overrides are stored under project-wide (cross-floor merged) group keys; re-key them onto this floor's groups.
    const teleportGroupOverrides = this.resolveTeleportGroupOverrides(state, rawEndpoints, layout.teleportEdges);
    const teleportStyle = buildTeleportLineStyle(state.vectorByWallsSettings, state.vectorByWallsSettings.floorColor);
    // Marker size adaptation (GitHub issue #819): one scaler for every marker kind on this floor,
    // fitted against the laid-out positions (GitHub issue #735).
    const scaler = buildMarkerScaler(cfg, [
      ...footprintsOfMarkers(markerData),
      ...footprintsOfVertical(layout.verticalMarkers, verticalStyle),
      ...footprintsOfTeleports(layout.teleportEdges, teleportStyle),
    ]);
    this.teleports.render({
      edges: layout.teleportEdges,
      scaler,
      lineStyle: teleportStyle,
      groupCustomization: state.vectorByWallsSettings.teleportGroupCustomization,
      groupOverrides: teleportGroupOverrides,
      // Cross-floor teleport/elevator badges are always click-to-switch-floor on the export
      // canvas (GitHub issue #478) — a read-only view like `GenerationRenderer`/`AnalyticsRenderer`,
      // so no tool-driven gating applies.
      floorNavigable: true,
      cfg,
      waypoints: teleportWaypoints,
      avoidFieldExit: state.vectorByWallsSettings.teleportAvoidFieldExit,
      fieldCells: cells,
      mergeTeleports: state.vectorByWallsSettings.teleportMergeMode,
      seam: state.vectorByWallsSettings.teleportThroughSeams !== false ? { cfg } : undefined,
      manualPaths: state.vectorByWallsSettings.manualTeleportConnectorPaths,
    });

    const waypointData = { markers: markerData, scaler };
    this.markers.render(waypointData);

    let markerIndexPlates: ElevatorBadgeObstacle[] = [];
    let markerIndexData: MarkerIndexRenderData | null = null;
    if (state.vectorByWallsSettings.markerIndex.enabled) {
      const resolveEndpointVisual = buildMarkerIndexEndpointResolver({
        teleportEdges: layout.teleportEdges,
        teleportStyle,
        groupCustomization: state.vectorByWallsSettings.teleportGroupCustomization,
        mergeTeleports: state.vectorByWallsSettings.teleportMergeMode,
        groupOverrides: teleportGroupOverrides,
        verticalStyle,
      });
      const projectGroups = getProjectTeleportGroups({
        nodes: state.nodes, edges: state.edges, cfg, floors: state.floors,
        avoidFieldExit: state.vectorByWallsSettings.teleportAvoidFieldExit, start: rawEndpoints.start, finish: rawEndpoints.finish,
        mergeTeleports: state.vectorByWallsSettings.teleportMergeMode,
      });
      const indexLabels = buildMarkerIndexLabels(state.nodes, state.edges, cfg, activeFloorIndex, state.vectorByWallsSettings.markerIndex, resolveEndpointVisual, scaler, projectGroups);
      const shiftedLabels = shiftMarkerIndexLabels(indexLabels.labels, layout.shifts, layout.scales);
      markerIndexPlates = shiftedLabels.map((label) => markerIndexPlateFootprint(label, state.vectorByWallsSettings.markerIndex));
      markerIndexData = { ...indexLabels, labels: shiftedLabels, style: state.vectorByWallsSettings.markerIndex, floorColor };
      this.markerIndex.render(markerIndexData);
    } else {
      this.markerIndex.clear();
    }

    const verticalData = {
      markers: layout.verticalMarkers,
      style: verticalStyle,
      scaler,
      // Vertical-passage markers navigate to their target floor on the export canvas (GitHub
      // issue #478) — always-on, same as `GenerationRenderer`'s read-only canvas.
      interactive: true,
      // Elevator floor badges keep clear of the index plates drawn above the markers (GitHub issue #964).
      badgeObstacles: markerIndexPlates,
    };
    this.verticalConnections.render(verticalData);
    // The trim mask cuts the plates and badges at a glued face; what they lose is drawn on the other side (GitHub issue #981).
    this.seamCopies.render(
      cfg,
      this.mazeContent.mask ? buildSeamCopySources({ markerIndex: markerIndexData, vertical: verticalData, waypoints: waypointData }) : [],
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
  private renderWarningHighlight(state: ReturnType<typeof useMazeStore.getState>): void {
    const { hoveredExportWarningKey, hoveredTeleportNodeIds } = state;
    if (!hoveredExportWarningKey) {
      if (hoveredTeleportNodeIds) {
        const { nodes } = selectFloorScopedMaze(
          state.nodes, state.edges, state.floors, state.activeFloorId, null, null,
        );
        this.warningHighlight.renderNodes(
          hoveredTeleportNodeIds, nodes, state.activeFieldConfig, state.vectorByWallsSettings,
          getCellHighlightInset(state.vectorByWallsSettings.wallThickness),
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
    this.innerGrid.destroy();
    this.walls.destroy();
    this.splitJunctions.destroy();
    this.teleports.destroy();
    this.verticalConnections.destroy();
    this.markers.destroy();
    this.markerIndex.destroy();
    this.seamCopies.destroy();
    this.floorLabel.destroy();
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
