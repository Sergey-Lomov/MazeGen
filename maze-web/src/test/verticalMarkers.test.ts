import { describe, it, expect, vi } from "vitest";
import { buildVerticalConnectionMarkers, selectVerticalPassagePairSet, selectNodeLevelResolver } from "../pixi/selectors/mazeSelectors";
import type { NodeDto, EdgeDto } from "../wasm/types";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";

vi.mock("../wasm/mazeService", () => ({
  getCartesianCoords: (cfg: { points: [number, number][] }) => cfg.points.map(([x, y]) => [x, y]),
}));

const squareCfg: TessellationConfig = { type: "square", width: 6, height: 6 };
const n = (id: number, x: number, y: number, level?: number): NodeDto => ({ id, x, y, i: 0, level });

describe("buildVerticalConnectionMarkers — targetFloorIndices (GitHub issue #430)", () => {
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
