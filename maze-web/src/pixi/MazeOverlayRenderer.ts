import { Container } from "pixi.js";
import { CellFillRenderer } from "./renderers/CellFillRenderer";
import { WallRenderer } from "./renderers/WallRenderer";
import { WaypointsRenderer } from "./renderers/WaypointsRenderer";
import { TeleportRenderer } from "./renderers/TeleportRenderer";
import { buildMazeWalls, buildMazeMarkers, buildTeleportEdges, buildClosedCells } from "./selectors/mazeSelectors";
import type { NodeDto, EdgeDto } from "../wasm/types";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";
import { canvas } from "./colorUtils";

export interface MazeOverlayData {
  nodes: NodeDto[];
  edges: EdgeDto[];
  start: number | null;
  finish: number | null;
  cfg: TessellationConfig;
}

export interface MazeOverlayContainers {
  floor: Container;
  closedCells: Container;
  walls: Container;
  teleports: Container;
  markers: Container;
}

export class MazeOverlayRenderer {
  private readonly floor: CellFillRenderer;
  private readonly closedCells: CellFillRenderer;
  private readonly walls: WallRenderer;
  private readonly teleports: TeleportRenderer;
  private readonly markers: WaypointsRenderer;

  constructor(containers: MazeOverlayContainers) {
    this.floor = new CellFillRenderer(containers.floor);
    this.closedCells = new CellFillRenderer(containers.closedCells);
    this.walls = new WallRenderer(containers.walls);
    this.teleports = new TeleportRenderer(containers.teleports);
    this.markers = new WaypointsRenderer(containers.markers);
  }

  render(data: MazeOverlayData): void {
    const { nodes, edges, start, finish, cfg } = data;

    const cells: [number, number][] = nodes.map(n => [n.x, n.y]);
    this.floor.render({ cells, color: canvas.floor.default, alpha: 1 }, cfg);

    const closed = buildClosedCells(nodes, edges);
    this.closedCells.render({ cells: closed, color: canvas.wall.default, alpha: 1 }, cfg);

    const wallEdges = buildMazeWalls(nodes, edges, cfg);
    this.walls.render({ edges: wallEdges }, cfg);

    const nodeById = new Map(nodes.map(n => [n.id, n]));
    const teleportEdges = buildTeleportEdges(nodeById, edges, cfg);
    this.teleports.render({ edges: teleportEdges });

    const markerData = buildMazeMarkers(nodeById, start, finish, cfg);
    this.markers.render({ markers: markerData });
  }

  destroy(): void {
    this.floor.destroy();
    this.closedCells.destroy();
    this.walls.destroy();
    this.teleports.destroy();
    this.markers.destroy();
  }
}
