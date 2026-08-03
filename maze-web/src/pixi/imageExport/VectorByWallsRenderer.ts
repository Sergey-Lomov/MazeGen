import { Container, Graphics } from "pixi.js";
import { useMazeStore } from "../../store/mazeStore";
import { CellFillRenderer } from "../renderers/CellFillRenderer";
import { WallRenderer } from "../renderers/WallRenderer";
import { WaypointsRenderer } from "../renderers/WaypointsRenderer";
import { TeleportRenderer } from "../renderers/TeleportRenderer";
import { GridRenderer } from "../renderers/GridRenderer";
import { SplitJunctionRenderer } from "../renderers/SplitJunctionRenderer";
import { buildMazeWalls, buildMazeMarkers, buildTeleportEdges, buildClosedCells, buildSplitPassages } from "../selectors/mazeSelectors";
import type { NodeDto, EdgeDto } from "../../wasm/types";
import type { Viewport, WallEdge, TeleportEdge, SplitPassage, WallStyleOverride, OneWayStyleOverride } from "../renderers/types";
import type { FieldConfig as TessellationConfig } from "../../fieldConfig";
import { TILE_SIZE } from "../constants";

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
 *  function for the same testability reason as `buildWallStyle`. The border color always mirrors
 *  `floorColor` (not independently settable — GitHub issue #292) and `size` is scaled from the
 *  settings' tile-fraction into world-space via `TILE_SIZE`. */
export function buildOneWayStyle(settings: ReturnType<typeof useMazeStore.getState>["vectorByWallsSettings"]): OneWayStyleOverride {
  return {
    pattern: settings.oneWayPattern,
    color: settings.oneWayColor,
    borderColor: settings.floorColor,
    borderWidth: settings.oneWayBorderWidth,
    size: TILE_SIZE * settings.oneWaySize,
    thickness: settings.oneWayThickness,
    join: settings.oneWayJoin,
    cap: settings.oneWayJoin === "miter" ? "square" : "round",
  };
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
    closedCells: [number, number][];
    wallEdges: WallEdge[];
    teleportEdges: TeleportEdge[];
    splitPassages: SplitPassage[];
    splitWallFaces: { v0: { x: number; y: number }; v1: { x: number; y: number } }[];
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

      if ((dataChanged || settingsChanged) && state.openCard === "image_export") {
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

    if (
      !this.geometryCache ||
      this.geometryCache.nodes !== nodes ||
      this.geometryCache.edges !== edges ||
      this.geometryCache.cfg !== cfg ||
      this.geometryCache.start !== start ||
      this.geometryCache.finish !== finish
    ) {
      const specialNodeIds = new Set<number>();
      if (start !== null) specialNodeIds.add(start);
      if (finish !== null) specialNodeIds.add(finish);
      for (const e of edges) {
        if (e.kind === "teleport") { specialNodeIds.add(e.from); specialNodeIds.add(e.to); }
      }

      const { passages: splitPassages, wallFaces: splitWallFaces } = buildSplitPassages(nodes, edges, cfg, specialNodeIds);
      this.geometryCache = {
        nodes,
        edges,
        cfg,
        start,
        finish,
        closedCells: buildClosedCells(nodes, edges),
        wallEdges: buildMazeWalls(nodes, edges, cfg),
        teleportEdges: buildTeleportEdges(nodeById, edges, cfg),
        splitPassages,
        splitWallFaces,
      };
    }
    const wallStyle = buildWallStyle(state.vectorByWallsSettings);
    const oneWayStyle = buildOneWayStyle(state.vectorByWallsSettings);
    this.closedCells.render({ cells: this.geometryCache.closedCells, color: state.vectorByWallsSettings.wallColor, alpha: 1 }, cfg);
    this.walls.render({ edges: this.geometryCache.wallEdges }, cfg, wallStyle, oneWayStyle);
    this.splitJunctions.render({ passages: this.geometryCache.splitPassages, wallFaces: this.geometryCache.splitWallFaces }, wallStyle);
    this.teleports.render({ edges: this.geometryCache.teleportEdges });

    const { startMarker, finishMarker } = state.vectorByWallsSettings;
    const markerData = buildMazeMarkers(nodeById, start, finish, cfg, startMarker, finishMarker);
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
