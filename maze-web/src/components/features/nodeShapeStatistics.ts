import { configAllCells } from "../../domain/tessellationCells";
import { floorTessellationOf } from "../../store/storeHelpers";
import { topologyKey } from "../../store/topologyWire";
import { fieldConfigToWasm } from "../../store/slices/generateConfigBuilder";
import type { MazeState } from "../../store/storeTypes";
import type { NodeShapeStatisticsRequest } from "../../wasm/types";

/** Builds the smallest wire request that reproduces the graph currently displayed in Analytics.
 * The core then uses the same `nodes_by_shape` classifier as the shape-limits QC check. */
export function nodeShapeStatisticsRequest(state: MazeState): NodeShapeStatisticsRequest | null {
  if (state.nodes.length === 0) return null;
  return {
    tessellation: fieldConfigToWasm(floorTessellationOf(state, state.activeFloorId)),
    level_fields: state.floors.map((floor) => configAllCells(floorTessellationOf(state, floor.id), state.smoothPrimitives)),
    ...topologyKey(state),
    nodes: state.nodes,
    edges: state.edges,
  };
}
