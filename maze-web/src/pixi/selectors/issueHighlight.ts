import type { FieldConfig } from "../../fieldConfig";
import type { MazeState } from "../../store/storeTypes";
import type { NodeDto } from "../../wasm/types";
import { DEFAULT_MAZE_RENDER_STYLE } from "../defaultMazeRenderStyle";
import type { IssueHighlightData } from "../IssueHighlightOverlay";
import { oneWayIndicatorSpan } from "../renderers/wallUtils";
import { selectNodeLevelResolver } from "./mazeSelectors";
import { selectSeamHopContext } from "./seamHop";

/// Everything `IssueHighlightOverlay` needs for the hovered issue (loop edges, undersized region groups): the
/// resolvers read the *unscoped* node and edge lists, the scene (floor-scoped `nodes` and `edges`) comes from the caller.
/// Shared by the analytics and post-edit renderers so a new field reaches both.
export function selectIssueHighlightData(
  state: MazeState,
  scene: { nodes: NodeDto[]; edges: IssueHighlightData["allEdges"] },
  cfg: FieldConfig,
): IssueHighlightData {
  const unscopedNodeById = new Map(state.nodes.map((n) => [n.id, n]));
  return {
    nodes: scene.nodes,
    edges: state.hoveredIssueLoopEdges,
    allEdges: scene.edges,
    regionGroups: state.hoveredIssueRegionGroups,
    cfg,
    resolveNodeLevel: selectNodeLevelResolver(state.nodes),
    resolveNodeCell: (id) => {
      const n = unscopedNodeById.get(id);
      return n ? [n.x, n.y] : undefined;
    },
    activeFloorIndex: Math.max(state.floors.findIndex((f) => f.id === state.activeFloorId), 0),
    // Built from the unscoped `state.edges`: a two-way connection's reverse edge lives on the other floor
    // (GitHub issue #337/#347). Uncommitted post-edit draft changes to a cross-floor connection aren't reflected,
    // the hovered-issue highlight is a read-only locator.
    crossFloorEdgeKeys: new Set(state.edges.filter((e) => e.kind !== "basic").map((e) => `${e.from}->${e.to}`)),
    oneWayBoundaryWidth: oneWayIndicatorSpan(DEFAULT_MAZE_RENDER_STYLE.oneWay),
    seam: selectSeamHopContext(state, scene.nodes),
  };
}
