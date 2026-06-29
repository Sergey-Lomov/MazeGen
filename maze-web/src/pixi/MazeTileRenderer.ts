import { Container } from "pixi.js";
import type { NodeDto, EdgeDto } from "../wasm/types";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";
import { CellFillRenderer } from "./renderers/CellFillRenderer";
import { WallRenderer } from "./renderers/WallRenderer";
import { WaypointsRenderer } from "./renderers/WaypointsRenderer";
import { buildMazeWalls, buildMazeMarkers } from "./selectors/mazeSelectors";
import { canvas, DEBUG_ACTIVE_ALPHA } from "./colorUtils";

export interface MazeTileData {
  nodes: NodeDto[];
  edges: EdgeDto[];
  start: number | null;
  finish: number | null;
  cfg: TessellationConfig;
  debugVisible: boolean;
  activeNodes: number[];
  currentSrc: number | null;
}

export class MazeTileRenderer {
  private readonly floorContainer: Container;
  private readonly wallsContainer: Container;
  private readonly markersContainer: Container;
  private readonly debugActiveContainer: Container;
  private readonly debugSrcContainer: Container;

  private readonly floor: CellFillRenderer;
  private readonly walls: WallRenderer;
  private readonly markers: WaypointsRenderer;
  private readonly debugActive: CellFillRenderer;
  private readonly debugSrc: CellFillRenderer;

  constructor(viewport: Container) {
    this.floorContainer = new Container();
    this.wallsContainer = new Container();
    this.markersContainer = new Container();
    this.debugActiveContainer = new Container();
    this.debugSrcContainer = new Container();

    viewport.addChild(this.floorContainer);
    viewport.addChild(this.wallsContainer);
    viewport.addChild(this.markersContainer);
    viewport.addChild(this.debugActiveContainer);
    viewport.addChild(this.debugSrcContainer);

    this.floor = new CellFillRenderer(this.floorContainer);
    this.walls = new WallRenderer(this.wallsContainer);
    this.markers = new WaypointsRenderer(this.markersContainer);
    this.debugActive = new CellFillRenderer(this.debugActiveContainer);
    this.debugSrc = new CellFillRenderer(this.debugSrcContainer);
  }

  render(data: MazeTileData): void {
    const { nodes, edges, start, finish, cfg, debugVisible, activeNodes, currentSrc } = data;

    const cells: [number, number][] = nodes.map(n => [n.x, n.y]);
    this.floor.render({ cells, color: canvas.floor.default, alpha: 1 }, cfg);

    const wallEdges = buildMazeWalls(nodes, edges, cfg);
    this.walls.render({ edges: wallEdges }, cfg);

    const nodeById = new Map(nodes.map(n => [n.id, n]));
    const markerData = buildMazeMarkers(nodeById, start, finish, cfg);
    this.markers.render({ markers: markerData });

    if (!debugVisible || nodes.length === 0) {
      this.debugActive.render({ cells: [], color: canvas.debug.active, alpha: DEBUG_ACTIVE_ALPHA }, cfg);
      this.debugSrc.render({ cells: [], color: canvas.debug.currentSrc, alpha: 0.8 }, cfg);
      return;
    }

    const activeCells: [number, number][] = [];
    for (const nodeId of activeNodes) {
      const node = nodeById.get(nodeId);
      if (node) activeCells.push([node.x, node.y]);
    }
    this.debugActive.render({ cells: activeCells, color: canvas.debug.active, alpha: DEBUG_ACTIVE_ALPHA }, cfg);

    const srcCells: [number, number][] = [];
    if (currentSrc !== null) {
      const srcNode = nodeById.get(currentSrc);
      if (srcNode) srcCells.push([srcNode.x, srcNode.y]);
    }
    this.debugSrc.render({ cells: srcCells, color: canvas.debug.currentSrc, alpha: 0.8 }, cfg);
  }

  destroy(): void {
    this.floor.destroy();
    this.walls.destroy();
    this.markers.destroy();
    this.debugActive.destroy();
    this.debugSrc.destroy();
    this.floorContainer.destroy();
    this.wallsContainer.destroy();
    this.markersContainer.destroy();
    this.debugActiveContainer.destroy();
    this.debugSrcContainer.destroy();
  }
}

