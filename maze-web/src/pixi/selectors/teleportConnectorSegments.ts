import type { NodeDto, EdgeDto } from "../../wasm/types";
import type { FieldConfig } from "../../fieldConfig";
import { buildTeleportEdges, buildTeleportFloorInputs, selectFloorScopedMaze } from "./mazeSelectors";
import { teleportConnectorKey } from "../renderers/teleportConnectorManual";
import { nearestCellCoord } from "../tessellationGeometry";

/** What the teleport connector editor's list needs to know about one drawn connector piece
 *  (GitHub issue #989): the cells it joins on its own floor and its direction. A same-floor
 *  connector joins its two teleport nodes; a cross-floor piece joins the teleport node on that floor
 *  and the floor badge, which stands in for the far end. */
export type TeleportConnectorSegment = {
  floorIndex: number;
  /** The connector's `from` end. A teleport node, or the floor badge (`{ badge: [x, y] }`). */
  from: { node: number } | { badge: [number, number] };
  to: { node: number } | { badge: [number, number] };
  oneWay: boolean;
};

/** Every connector piece of the project by `teleportConnectorKey`, built the way the vector export
 *  renderers build each floor's teleport edges (same badge placement and `avoidFieldExit` rule). */
export function buildTeleportConnectorSegments(args: {
  nodes: NodeDto[];
  edges: EdgeDto[];
  cfg: FieldConfig;
  floors: { id: string }[];
  avoidFieldExit: boolean;
  start: number | null;
  finish: number | null;
}): Map<string, TeleportConnectorSegment> {
  const { nodes, edges, cfg, floors, avoidFieldExit, start, finish } = args;
  const floorList = floors.length > 0 ? floors : [{ id: "" }];
  const { floorContext, spread } = buildTeleportFloorInputs({
    unscopedNodes: nodes,
    unscopedEdges: edges,
    floors: floorList,
    activeFloorId: floorList[0].id,
    start,
    finish,
    allowOutOfField: !avoidFieldExit,
    fieldCells: nodes.map((n): [number, number] => [n.x, n.y]),
  });
  const result = new Map<string, TeleportConnectorSegment>();
  floorList.forEach((floor, floorIndex) => {
    const scoped = selectFloorScopedMaze(nodes, edges, floors, floor.id, start, finish);
    const nodeById = new Map(scoped.nodes.map((n) => [n.id, n]));
    for (const edge of buildTeleportEdges(nodeById, scoped.edges, cfg, { ...floorContext, activeFloorIndex: floorIndex }, spread)) {
      const key = teleportConnectorKey(edge);
      if (key === null || edge.fromNode === undefined || edge.toNode === undefined) continue;
      result.set(key, {
        floorIndex,
        from: edge.fromFloor !== undefined ? { badge: nearestCellCoord(edge.from[0], edge.from[1], cfg) } : { node: edge.fromNode },
        to: edge.toFloor !== undefined ? { badge: nearestCellCoord(edge.to[0], edge.to[1], cfg) } : { node: edge.toNode },
        oneWay: edge.oneWay,
      });
    }
  });
  return result;
}
