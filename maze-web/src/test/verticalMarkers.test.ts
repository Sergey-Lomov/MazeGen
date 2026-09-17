import { describe, it, expect, vi } from "vitest";
import { buildVerticalConnectionMarkers, selectVerticalPassagePairSet, selectNodeLevelResolver } from "../pixi/selectors/mazeSelectors";
import { buildNodePositions } from "../pixi/tessellationGeometry";
import type { NodeDto, EdgeDto } from "../wasm/types";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";

vi.mock("../wasm/mazeService", () => ({
  getCartesianCoords: (cfg: { points: [number, number][] }) => cfg.points.map(([x, y]) => [x, y]),
}));

const squareCfg: TessellationConfig = { type: "square", width: 6, height: 6 };
const n = (id: number, x: number, y: number, level?: number): NodeDto => ({ id, x, y, i: 0, level });

describe("buildVerticalConnectionMarkers — targetFloorIndices (GitHub issue #430)", () => {
  it("uses shape-aware split-node anchors for vertical markers on a bridge (GitHub issue #555)", () => {
    const nodes = [
      n(0, 0, 0, 0), n(1, 0, 0, 0),
      n(2, 1, 0, 0), n(3, -1, 0, 0), n(4, 0, 1, 0), n(5, 0, -1, 0),
      n(6, 1, 1, 1), n(7, -1, -1, 1),
    ];
    const nodeById = new Map(nodes.map((x) => [x.id, x]));
    const bridgeEdges: EdgeDto[] = [
      { from: 0, to: 2, kind: "basic" }, { from: 2, to: 0, kind: "basic" },
      { from: 0, to: 3, kind: "basic" }, { from: 3, to: 0, kind: "basic" },
      { from: 1, to: 4, kind: "basic" }, { from: 4, to: 1, kind: "basic" },
      { from: 1, to: 5, kind: "basic" }, { from: 5, to: 1, kind: "basic" },
      { from: 0, to: 6, kind: "vertical_passage" },
      { from: 1, to: 7, kind: "vertical_passage" },
    ];
    const resolveNodeLevel = selectNodeLevelResolver(nodes);
    const pairs = selectVerticalPassagePairSet(bridgeEdges);
    const markers = buildVerticalConnectionMarkers(nodeById, bridgeEdges, squareCfg, resolveNodeLevel, 0, pairs, bridgeEdges);
    const expected = buildNodePositions(nodes, squareCfg, bridgeEdges.map(({ from, to }) => ({ from, to })));

    expect(markers.map((marker) => marker.pos)).toEqual([
      [expected.get(0)!.x, expected.get(0)!.y],
      [expected.get(1)!.x, expected.get(1)!.y],
    ]);
    expect(markers[0].pos).not.toEqual(markers[1].pos);
  });

  it("can render a two-floor elevator as a two-way passage marker", () => {
    const nodes = [n(0, 0, 0, 0), n(1, 1, 1, 1)];
    const nodeById = new Map(nodes.map((x) => [x.id, x]));
    const edges: EdgeDto[] = [{ from: 0, to: 1, kind: "elevator" }];
    const resolveNodeLevel = selectNodeLevelResolver(nodes);
    const pairs = selectVerticalPassagePairSet(edges);
    const markers = buildVerticalConnectionMarkers(nodeById, edges, squareCfg, resolveNodeLevel, 0, pairs, edges, true);

    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ kind: "vertical_passage", filled: true, targetFloorIndex: 1 });
    expect(markers[0].targetFloorIndices).toBeUndefined();
  });

  it("is undefined for a vertical_passage marker", () => {
    const nodes = [n(0, 0, 0, 0), n(1, 1, 1, 1)];
    const nodeById = new Map(nodes.map((x) => [x.id, x]));
    const edges: EdgeDto[] = [{ from: 0, to: 1, kind: "vertical_passage" }];
    const resolveNodeLevel = selectNodeLevelResolver(nodes);
    const pairs = selectVerticalPassagePairSet(edges);
    const markers = buildVerticalConnectionMarkers(nodeById, edges, squareCfg, resolveNodeLevel, 0, pairs, edges);
    const marker = markers.find((m) => m.kind === "vertical_passage");
    expect(marker?.targetFloorIndices).toBeUndefined();
  });

  it("collects every reachable floor for an elevator's fan, deduplicated and sorted ascending", () => {
    const nodes = [
      n(0, 0, 0, 0), // elevator source, floor 0
      n(1, 1, 1, 2), // target on floor 2
      n(2, 2, 2, 1), // target on floor 1
      n(3, 3, 3, 2), // another target on floor 2 (duplicate floor)
    ];
    const nodeById = new Map(nodes.map((x) => [x.id, x]));
    const edges: EdgeDto[] = [
      { from: 0, to: 1, kind: "elevator" },
      { from: 0, to: 2, kind: "elevator" },
      { from: 0, to: 3, kind: "elevator" },
    ];
    const resolveNodeLevel = selectNodeLevelResolver(nodes);
    const pairs = selectVerticalPassagePairSet(edges);
    const markers = buildVerticalConnectionMarkers(nodeById, edges, squareCfg, resolveNodeLevel, 0, pairs, edges);
    const marker = markers.find((m) => m.kind === "elevator");
    expect(marker?.targetFloorIndices).toEqual([1, 2]);
  });

  it("keeps an elevator marker for elevators reaching multiple floors", () => {
    const nodes = [n(0, 0, 0, 0), n(1, 1, 1, 1), n(2, 2, 2, 2)];
    const nodeById = new Map(nodes.map((x) => [x.id, x]));
    const edges: EdgeDto[] = [
      { from: 0, to: 1, kind: "elevator" },
      { from: 0, to: 2, kind: "elevator" },
    ];
    const resolveNodeLevel = selectNodeLevelResolver(nodes);
    const pairs = selectVerticalPassagePairSet(edges);
    const markers = buildVerticalConnectionMarkers(nodeById, edges, squareCfg, resolveNodeLevel, 0, pairs, edges, true);

    expect(markers[0]).toMatchObject({ kind: "elevator", targetFloorIndices: [1, 2] });
  });

  it("is undefined when none of the fan's targets resolve to a floor", () => {
    const nodes = [n(0, 0, 0, 0), n(1, 1, 1, undefined)];
    const nodeById = new Map(nodes.map((x) => [x.id, x]));
    // node 1 not in `nodes` passed to the resolver -> level unresolved
    const edges: EdgeDto[] = [{ from: 0, to: 1, kind: "elevator" }];
    const resolveNodeLevel = selectNodeLevelResolver([nodes[0]]);
    const pairs = selectVerticalPassagePairSet(edges);
    const markers = buildVerticalConnectionMarkers(nodeById, edges, squareCfg, resolveNodeLevel, 0, pairs, edges);
    const marker = markers.find((m) => m.kind === "elevator");
    expect(marker?.targetFloorIndices).toEqual([]);
  });
});
