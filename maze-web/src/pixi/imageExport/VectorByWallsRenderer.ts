import { Container, Graphics } from "pixi.js";
import { useMazeStore } from "../../store/mazeStore";
import { CellFillRenderer } from "../renderers/CellFillRenderer";
import { WallRenderer } from "../renderers/WallRenderer";
import { WaypointsRenderer } from "../renderers/WaypointsRenderer";
import { TeleportRenderer } from "../renderers/TeleportRenderer";
import { GridRenderer } from "../renderers/GridRenderer";
import { SplitJunctionRenderer } from "../renderers/SplitJunctionRenderer";
import { buildMazeWalls, buildMazeMarkers, buildTeleportEdges, buildClosedCells, buildSplitPassages, maxSplitNodeCount } from "../selectors/mazeSelectors";
import type { NodeDto, EdgeDto } from "../../wasm/types";
import type { Viewport, WallEdge, TeleportEdge, SplitPassage, SplitSpecialShape, SplitStyleOverride, WallStyleOverride, OneWayStyleOverride, TeleportLineStyle } from "../renderers/types";
import type { MarkerSettings } from "../../store/storeTypes";
import type { MarkerStyle } from "../selectors/mazeSelectors";
import type { FieldConfig as TessellationConfig } from "../../fieldConfig";
import { TILE_SIZE } from "../constants";
import { canvas } from "../colorTokens";
import { splitSlotColor } from "../colorUtils";

/** Fills in `splitNodeColors`' missing slots with `splitSlotColor`'s own default palette (GitHub
 *  issue #294 follow-up) — `splitNodeColors` only holds entries for slots the user has actually
 *  edited (starts `[]`), so passing it straight through to `buildSplitPassages` would make
 *  `splitSlotColor` treat every slot as "past the fixed set" (empty `fixedSlots`), landing on
 *  `buildPalette`'s rotating-hue colors instead of `canvas.node.splitSlots` — visibly different
 *  from what the settings panel itself shows for an untouched slot, until the user edits every
 *  slot at least once. Exported as a pure function for unit-testability, same rationale as
 *  `viewportWorldRect`/`buildWallStyle`. */
export function buildEffectiveSplitNodeColors(splitNodeColors: readonly number[], maxSplit: number): number[] {
  return Array.from(
    { length: Math.max(splitNodeColors.length, maxSplit) },
    (_, i) => splitNodeColors[i] ?? splitSlotColor(i, canvas.node.splitSlots),
  );
}

/** World-space rect covering the whole visible viewport — the inverse of the pan/zoom transform
 *  applied to the scene container (`x`/`y` are the container's own screen-space offset, so the
 *  world-space origin sits at `-x/scale, -y/scale`). Exported as a pure function (not inlined in
 *  `renderBackground`) so the viewport→world formula itself is unit-testable — see GitHub issue
 *  #289, where an earlier version of this formula used the raw screen-space `x`/`y` directly and
 *  drew the background rect in the wrong place. */
export function viewportWorldRect(viewport: Viewport): { x: number; y: number; w: number; h: number } {
  const { x, y, w, h, scale } = viewport;
  return { x: -x / scale, y: -y / scale, w: w / scale, h: h / scale };
}

/** Builds `WallRenderer`'s `WallStyleOverride` from `VectorByWallsSettings` — exported as a pure
 *  function (not inlined in `renderAll`) so the join→cap derivation is unit-testable on its own,
 *  same rationale as `viewportWorldRect`. */
export function buildWallStyle(settings: ReturnType<typeof useMazeStore.getState>["vectorByWallsSettings"]): WallStyleOverride {
  return {
    color: settings.wallColor,
    width: settings.wallThickness,
    join: settings.wallJoin,
    cap: settings.wallJoin === "miter" ? "square" : "round",
  };
}

/** Builds `WallRenderer`'s `OneWayStyleOverride` from `VectorByWallsSettings` — exported as a pure
 *  function for the same testability reason as `buildWallStyle`. The gap color always mirrors
 *  `floorColor` (not independently settable — GitHub issue #292) and `size` is scaled from the
 *  settings' tile-fraction into world-space via `TILE_SIZE`. */
export function buildOneWayStyle(settings: ReturnType<typeof useMazeStore.getState>["vectorByWallsSettings"]): OneWayStyleOverride {
  return {
    pattern: settings.oneWayPattern,
    color: settings.oneWayColor,
    gapColor: settings.floorColor,
    gapWidth: settings.oneWayGapWidth,
    size: TILE_SIZE * settings.oneWaySize,
    thickness: settings.oneWayThickness,
    join: settings.oneWayJoin,
    cap: settings.oneWayJoin === "miter" ? "square" : "round",
  };
}

/** Builds `TeleportRenderer`'s style from `VectorByWallsSettings` — exported for the same
 *  testability reason as `buildWallStyle`/`buildOneWayStyle` (GitHub issue #293). */
export function buildTeleportLineStyle(settings: ReturnType<typeof useMazeStore.getState>["vectorByWallsSettings"]): TeleportLineStyle {
  return {
    shape: settings.teleportLineShape,
    cornerStyle: settings.teleportLineCornerStyle,
    size: settings.teleportLineSize,
    edgeColor: settings.teleportEdgeColor,
    edgeBorderColor: settings.teleportEdgeBorderColor,
    borderWidth: settings.teleportEdgeBorderWidth,
    edgeGapWidth: settings.teleportEdgeGapWidth,
    connectorColor: settings.teleportConnectorColor,
    connectorWidth: settings.teleportConnectorWidth,
    connectorStyle: settings.teleportConnectorStyle,
    arrowMode: settings.teleportArrowMode,
    arrowPeriod: settings.teleportArrowPeriod,
    arrowSize: settings.teleportArrowSize,
    connectorGapWidth: settings.teleportConnectorGapWidth,
    floorColor: settings.floorColor,
  };
}

/** Builds `buildMazeMarkers`'s `MarkerStyle` from a `MarkerSettings` (start or finish) plus the
 *  panel's own floor color — `gapColor` always mirrors `floorColor` (GitHub issue #302 follow-up,
 *  not independently settable, same convention as the one-way indicator's own border color). */
export function buildMarkerStyle(settings: MarkerSettings, floorColor: number): MarkerStyle {
  return { ...settings, gapColor: floorColor };
}

/** The "Vector by walls" image-export rendering mode (GitHub issue #287) — renders the maze
 * identically to the main generation/post-edit view (same walls, same colors), built from the
 * same low-level render primitives (`GridRenderer`, `CellFillRenderer`, `WallRenderer`, etc.) as
 * `GenerationRenderer`. Per `maze-web/CLAUDE.md`'s feature-renderer ownership rule this is its
 * own renderer with its own primitive instances — it must not share instances with
 * `GenerationRenderer` or any other feature-renderer, even though the visual output matches. */
export class VectorByWallsRenderer {
  private readonly backgroundContainer: Container;
  private readonly gridContainer: Container;
  private readonly floorContainer: Container;
  private readonly closedCellsContainer: Container;
  private readonly wallsContainer: Container;
  private readonly splitJunctionContainer: Container;
  private readonly teleportContainer: Container;
  private readonly markersContainer: Container;

  private readonly background: Graphics;
  private readonly grid: GridRenderer;
  private readonly floor: CellFillRenderer;
  private readonly closedCells: CellFillRenderer;
  private readonly walls: WallRenderer;
  private readonly splitJunctions: SplitJunctionRenderer;
  private readonly teleports: TeleportRenderer;
  private readonly markers: WaypointsRenderer;

  private viewport: Viewport = { x: 0, y: 0, w: 0, h: 0, scale: 1 };
  private unsubscribe: (() => void) | null = null;

  private geometryCache: {
    nodes: NodeDto[];
    edges: EdgeDto[];
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
  } | null = null;

  constructor(container: Container) {
    this.backgroundContainer = new Container();
    this.gridContainer = new Container();
    this.floorContainer = new Container();
    this.closedCellsContainer = new Container();
    this.wallsContainer = new Container();
    this.splitJunctionContainer = new Container();
    this.teleportContainer = new Container();
    this.markersContainer = new Container();

    container.addChild(this.backgroundContainer);
    container.addChild(this.gridContainer);
    container.addChild(this.floorContainer);
    container.addChild(this.closedCellsContainer);
    container.addChild(this.wallsContainer);
    container.addChild(this.splitJunctionContainer);
    container.addChild(this.teleportContainer);
    container.addChild(this.markersContainer);

    this.background = new Graphics();
    this.backgroundContainer.addChild(this.background);

    this.grid = new GridRenderer(this.gridContainer);
    this.floor = new CellFillRenderer(this.floorContainer);
    this.closedCells = new CellFillRenderer(this.closedCellsContainer);
    this.walls = new WallRenderer(this.wallsContainer);
    this.splitJunctions = new SplitJunctionRenderer(this.splitJunctionContainer);
    this.teleports = new TeleportRenderer(this.teleportContainer);
    this.markers = new WaypointsRenderer(this.markersContainer);

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
        state.activeTessellationConfig !== prev.activeTessellationConfig;

      const settingsChanged = state.vectorByWallsSettings !== prev.vectorByWallsSettings;
      // Teleports section's own expand/collapse flips `interactive` on group customization's
      // canvas hover wiring (GitHub issue #293) — a plain `sectionsExpanded` change wouldn't
      // otherwise trigger `renderAll` since it isn't part of `vectorByWallsSettings`.
      const teleportsSectionChanged =
        (state.vectorByWallsSectionsExpanded["teleports"] ?? false) !== (prev.vectorByWallsSectionsExpanded["teleports"] ?? false);

      if ((dataChanged || settingsChanged || teleportsSectionChanged) && state.openCard === "image_export") {
        this.renderAll(state);
      }

      prev = state;
    });
  }

  private syncVisibility(state: ReturnType<typeof useMazeStore.getState>): void {
    const visible = state.openCard === "image_export";
    this.backgroundContainer.visible = visible;
    this.gridContainer.visible = visible;
    this.floorContainer.visible = visible;
    this.closedCellsContainer.visible = visible;
    this.wallsContainer.visible = visible;
    this.splitJunctionContainer.visible = visible;
    this.teleportContainer.visible = visible;
    this.markersContainer.visible = visible;
    if (visible) this.renderAll(state);
  }

  private renderBackground(settings: ReturnType<typeof useMazeStore.getState>["vectorByWallsSettings"]): void {
    const { x, y, w, h } = viewportWorldRect(this.viewport);
    this.background.clear();
    this.background.rect(x, y, w, h).fill({ color: settings.background });
  }

  onViewportChanged(x: number, y: number, w: number, h: number, scale: number): void {
    this.viewport = { x, y, w, h, scale };
    const state = useMazeStore.getState();
    if (state.openCard === "image_export") {
      this.renderBackground(state.vectorByWallsSettings);
      this.gridContainer.visible = state.vectorByWallsSettings.showGrid;
      if (state.vectorByWallsSettings.showGrid) {
        this.grid.render({ viewport: this.viewport, color: state.vectorByWallsSettings.gridColor }, state.activeTessellationConfig);
      }
    }
  }

  private renderAll(state: ReturnType<typeof useMazeStore.getState>): void {
    const cfg = state.activeTessellationConfig;
    this.renderBackground(state.vectorByWallsSettings);
    this.gridContainer.visible = state.vectorByWallsSettings.showGrid;
    if (state.vectorByWallsSettings.showGrid) {
      this.grid.render({ viewport: this.viewport, color: state.vectorByWallsSettings.gridColor }, cfg);
    }

    const { nodes, edges, start, finish } = state;
    const cells: [number, number][] = nodes.map(n => [n.x, n.y]);
    this.floor.render({ cells, color: state.vectorByWallsSettings.floorColor, alpha: 1 }, cfg);

    const nodeById = new Map(nodes.map(n => [n.id, n]));

    const splitNodeColors = state.vectorByWallsSettings.splitNodeColors;
    if (
      !this.geometryCache ||
      this.geometryCache.nodes !== nodes ||
      this.geometryCache.edges !== edges ||
      this.geometryCache.cfg !== cfg ||
      this.geometryCache.start !== start ||
      this.geometryCache.finish !== finish ||
      this.geometryCache.splitNodeColors !== splitNodeColors
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
        nodes,
        edges,
        cfg,
        start,
        finish,
        splitNodeColors,
        closedCells: buildClosedCells(nodes, edges),
        wallEdges: buildMazeWalls(nodes, edges, cfg),
        teleportEdges: buildTeleportEdges(nodeById, edges, cfg),
        splitPassages,
        splitWallFaces,
        splitSpecialShapes,
      };
    }
    const wallStyle = buildWallStyle(state.vectorByWallsSettings);
    const oneWayStyle = buildOneWayStyle(state.vectorByWallsSettings);
    const splitStyle: SplitStyleOverride = { specialShapes: state.vectorByWallsSettings.splitSpecialShapes };
    this.closedCells.render({ cells: this.geometryCache.closedCells, color: state.vectorByWallsSettings.wallColor, alpha: 1 }, cfg);
    this.walls.render({ edges: this.geometryCache.wallEdges }, cfg, wallStyle, oneWayStyle);
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
    );
    this.teleports.render({
      edges: this.geometryCache.teleportEdges,
      lineStyle: buildTeleportLineStyle(state.vectorByWallsSettings),
      groupCustomization: state.vectorByWallsSettings.teleportGroupCustomization,
      groupOverrides: state.vectorByWallsSettings.teleportGroupOverrides,
      interactive: state.vectorByWallsSectionsExpanded["teleports"] ?? false,
      cfg,
      waypoints: markerData.map((m) => m.pos),
      avoidFieldExit: state.vectorByWallsSettings.teleportAvoidFieldExit,
      fieldCells: cells,
    });

    this.markers.render({ markers: markerData });
  }

  destroy(): void {
    this.unsubscribe?.();
    this.background.destroy();
    this.grid.destroy();
    this.floor.destroy();
    this.closedCells.destroy();
    this.walls.destroy();
    this.splitJunctions.destroy();
    this.teleports.destroy();
    this.markers.destroy();
    this.gridContainer.destroy();
    this.floorContainer.destroy();
    this.closedCellsContainer.destroy();
    this.wallsContainer.destroy();
    this.splitJunctionContainer.destroy();
    this.teleportContainer.destroy();
    this.markersContainer.destroy();
    this.backgroundContainer.destroy();
  }
}
