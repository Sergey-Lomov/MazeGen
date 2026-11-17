import { Container } from "pixi.js";
import { CellFillRenderer } from "./renderers/CellFillRenderer";
import { WallRenderer } from "./renderers/WallRenderer";
import { WaypointsRenderer } from "./renderers/WaypointsRenderer";
import { TeleportRenderer } from "./renderers/TeleportRenderer";
import { SplitJunctionRenderer, collectSplitWallPaths } from "./renderers/SplitJunctionRenderer";
import { layoutEditorMarkers } from "./editorMarkerLayout";
import { buildMazeWalls, buildMazeMarkers, buildTeleportEdges, buildClosedCells, buildSplitPassages, buildTeleportAvoidanceWaypoints, type TeleportFloorContext, type TeleportBadgeSpreadOptions } from "./selectors/mazeSelectors";
import type { NodeDto, EdgeDto } from "../wasm/types";
import type { FieldConfig } from "../fieldConfig";
import { canvas } from "./colorTokens";

export interface MazeOverlayData {
  nodes: NodeDto[];
  edges: EdgeDto[];
  start: number | null;
  finish: number | null;
  cfg: FieldConfig;
  /** Cross-floor teleport badge resolution (GitHub issue #337) — omitted by a caller with no
   *  unscoped node/edge list in hand, same as `buildTeleportEdges`'s own optional param. */
  teleportFloorContext?: TeleportFloorContext;
  /** Wires click-to-switch-floor on cross-floor teleport badges (see `TeleportRenderer.render`'s
   *  own `floorNavigable` doc comment). Defaults to `false`. */
  teleportFloorNavigable?: boolean;
  /** Unscoped edge list (GitHub issue #359 follow-up), passed through to `buildClosedCells` —
   *  needed so a cell whose only connection is a vertical passage/elevator arrival/departure end
   *  isn't mistaken for having no connection at all: that edge kind is absent from the floor-scoped
   *  `edges` above by construction (see `selectFloorScopedMaze`'s own doc comment), so without this
   *  the cell would be wrongly rendered as a closed wall. Omitted by a caller with no unscoped list
   *  in hand, same fallback `buildClosedCells`'s own optional param already has. */
  allEdges?: EdgeDto[];
  /** Cross-floor teleport badge collision-relocation inputs (GitHub issue #480) — forwarded to
   *  `buildTeleportEdges`. Omitted → badges only avoid each other, not maze markers. */
  teleportBadgeSpread?: TeleportBadgeSpreadOptions;
}

export interface MazeOverlayContainers {
  floor: Container;
  closedCells: Container;
  walls: Container;
  splitJunctions: Container;
  teleports: Container;
  markers: Container;
}

export class MazeOverlayRenderer {
  private readonly floor: CellFillRenderer;
  private readonly closedCells: CellFillRenderer;
  private readonly walls: WallRenderer;
  private readonly splitJunctions: SplitJunctionRenderer;
  private readonly teleports: TeleportRenderer;
  private readonly markers: WaypointsRenderer;

  constructor(containers: MazeOverlayContainers) {
    this.floor = new CellFillRenderer(containers.floor);
    this.closedCells = new CellFillRenderer(containers.closedCells);
    this.walls = new WallRenderer(containers.walls);
    this.splitJunctions = new SplitJunctionRenderer(containers.splitJunctions);
    this.teleports = new TeleportRenderer(containers.teleports);
    this.markers = new WaypointsRenderer(containers.markers);
  }

  render(data: MazeOverlayData): void {
    const { nodes, edges, start, finish, cfg, teleportFloorContext, teleportFloorNavigable, allEdges, teleportBadgeSpread } = data;

    const cells: [number, number][] = nodes.map(n => [n.x, n.y]);
    this.floor.render({ cells, color: canvas.floor.default, alpha: 1 }, cfg);

    const closed = buildClosedCells(nodes, edges, allEdges);
    this.closedCells.render({ cells: closed, color: canvas.wall.default, alpha: 1 }, cfg);

    // A split node carrying a start/finish marker or a teleport endpoint always keeps its hub
    // point (see buildSplitPassages's straightening exception) — see PostEditRenderer's identical
    // specialNodeIds construction.
    const specialNodeIds = new Set<number>();
    if (start !== null) specialNodeIds.add(start);
    if (finish !== null) specialNodeIds.add(finish);
    for (const e of edges) {
      if (e.kind === "teleport") { specialNodeIds.add(e.from); specialNodeIds.add(e.to); }
    }
    const { passages: splitPassages, wallFaces, specialShapes } = buildSplitPassages(nodes, edges, cfg, specialNodeIds);

    const wallEdges = buildMazeWalls(nodes, edges, cfg);
    const { paths: extraWalls, noCapPoints } = collectSplitWallPaths(wallFaces, specialShapes);
    this.walls.render({ edges: wallEdges }, cfg, undefined, undefined, extraWalls, noCapPoints);

    this.splitJunctions.render({ passages: splitPassages, wallFaces, specialShapes });

    const nodeById = new Map(nodes.map(n => [n.id, n]));
    const layout = layoutEditorMarkers({
      markers: buildMazeMarkers(nodeById, start, finish, cfg, undefined, undefined, edges),
      teleportEdges: buildTeleportEdges(nodeById, edges, cfg, teleportFloorContext, teleportBadgeSpread),
      nodeById, edges, cfg,
    });
    const teleportEdges = layout.teleportEdges;
    const markerData = layout.markers;
    // Keep orthogonal teleport connectors from cutting through start/finish markers (GitHub issue
    // #300), same as the image-export renderers — regressed on this live canvas (GitHub issue #516).
    // Also avoid one-way wall indicators (GitHub issue #518) — this overlay has no vertical
    // passage/elevator marker concept of its own.
    const teleportWaypoints = buildTeleportAvoidanceWaypoints({
      markers: markerData,
      oneWayWallEdges: wallEdges,
      cfg,
      splitPassages,
    });
    this.teleports.render({ edges: teleportEdges, cfg, floorNavigable: teleportFloorNavigable ?? false, waypoints: teleportWaypoints });

    this.markers.render({ markers: markerData });
  }

  destroy(): void {
    this.floor.destroy();
    this.closedCells.destroy();
    this.walls.destroy();
    this.splitJunctions.destroy();
    this.teleports.destroy();
    this.markers.destroy();
  }
}
