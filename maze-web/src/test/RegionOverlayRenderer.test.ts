import { describe, it, expect, vi } from "vitest";

vi.mock("../pixi/tessellationGeometry", () => ({
  getCellCenter: (x: number, y: number) => ({ x: x * 10, y: y * 10 }),
}));

const { buildRegionRingMarkers, buildRegionTeleportMarkers } = await import("../pixi/renderers/RegionOverlayRenderer");
import type { NodeDto } from "../wasm/generated/dto";
import type { EdgeDto } from "../wasm/generated/dto";
import type { TeleportEdge } from "../pixi/renderers/types";

function node(id: number, x: number, y: number): NodeDto {
  return { id, x, y, i: 0, level: 0 } as NodeDto;
}

describe("buildRegionRingMarkers", () => {
  const components = [[1, 2], [3]];
  const componentColors = [0xff0000, 0x00ff00];
  const unscopedNodeById = new Map<number, NodeDto>([
    [1, node(1, 0, 0)],
    [2, node(2, 5, 5)],
  ]);

  it("collects a badge when a same-component vertical_passage edge leaves the active floor", () => {
    const resolveNodeLevel = (id: number) => (id === 1 ? 0 : 1);
    const edges: EdgeDto[] = [{ from: 1, to: 2, kind: "vertical_passage" }];
    const markers = buildRegionRingMarkers(components, edges, resolveNodeLevel, 0, unscopedNodeById, componentColors);
    expect(markers).toEqual([{ cell: [0, 0], color: 0xff0000, targets: [1] }]);
  });

  it("skips edges whose endpoints land in different components", () => {
    const resolveNodeLevel = (id: number) => (id === 1 ? 0 : 1);
    const edges: EdgeDto[] = [{ from: 1, to: 3, kind: "elevator" }];
    const nodeById = new Map<number, NodeDto>([[1, node(1, 0, 0)], [3, node(3, 5, 5)]]);
    const markers = buildRegionRingMarkers(components, edges, resolveNodeLevel, 0, nodeById, componentColors);
    expect(markers).toEqual([]);
  });

  it("skips edges of an unrelated kind (basic/teleport)", () => {
    const resolveNodeLevel = (id: number) => (id === 1 ? 0 : 1);
    const edges: EdgeDto[] = [{ from: 1, to: 2, kind: "basic" }];
    const markers = buildRegionRingMarkers(components, edges, resolveNodeLevel, 0, unscopedNodeById, componentColors);
    expect(markers).toEqual([]);
  });

  it("skips edges that don't leave the active floor", () => {
    const resolveNodeLevel = () => 0;
    const edges: EdgeDto[] = [{ from: 1, to: 2, kind: "elevator" }];
    const markers = buildRegionRingMarkers(components, edges, resolveNodeLevel, 0, unscopedNodeById, componentColors);
    expect(markers).toEqual([]);
  });

  it("merges distinct target floors reached from the same cell into one marker", () => {
    const nodeById = new Map<number, NodeDto>([
      [1, node(1, 0, 0)],
      [2, node(2, 5, 5)],
      [4, node(4, 6, 6)],
    ]);
    const comps = [[1, 2, 4]];
    const colors = [0x123456];
    const resolveNodeLevel = (id: number) => (id === 1 ? 0 : id === 2 ? 1 : 2);
    const edges: EdgeDto[] = [
      { from: 1, to: 2, kind: "elevator" },
      { from: 1, to: 4, kind: "elevator" },
    ];
    const markers = buildRegionRingMarkers(comps, edges, resolveNodeLevel, 0, nodeById, colors);
    expect(markers).toEqual([{ cell: [0, 0], color: 0x123456, targets: [1, 2] }]);
  });
});

describe("buildRegionTeleportMarkers", () => {
  const components = [[1, 2]];
  const componentColors = [0xabcdef];
  const unscopedNodeById = new Map<number, NodeDto>([[1, node(1, 3, 4)]]);
  const cfg = {} as never;

  it("builds a marker anchored to the teleport's own badge position for a toFloor edge", () => {
    const edges: TeleportEdge[] = [{ from: [30, 40], to: [99, 88], oneWay: false, fromNode: 1, toNode: 2, toFloor: 2 }];
    const markers = buildRegionTeleportMarkers(components, edges, unscopedNodeById, cfg, componentColors);
    expect(markers).toEqual([{ pos: [99, 88], stubFrom: [30, 40], color: 0xabcdef, targetFloorIndex: 2 }]);
  });

  it("builds a marker anchored to `from` for a fromFloor edge", () => {
    const edges: TeleportEdge[] = [{ from: [11, 22], to: [30, 40], oneWay: false, fromNode: 2, toNode: 1, fromFloor: 3 }];
    const markers = buildRegionTeleportMarkers(components, edges, unscopedNodeById, cfg, componentColors);
    expect(markers).toEqual([{ pos: [11, 22], stubFrom: [30, 40], color: 0xabcdef, targetFloorIndex: 3 }]);
  });

  it("skips edges with neither toFloor nor fromFloor set", () => {
    const edges: TeleportEdge[] = [{ from: [11, 22], to: [30, 40], oneWay: false, fromNode: 1, toNode: 2 }];
    const markers = buildRegionTeleportMarkers(components, edges, unscopedNodeById, cfg, componentColors);
    expect(markers).toEqual([]);
  });

  it("skips edges whose on-floor and off-floor node land in different components", () => {
    const nodeById = new Map<number, NodeDto>([[1, node(1, 3, 4)]]);
    const comps = [[1], [2]];
    const edges: TeleportEdge[] = [{ from: [30, 40], to: [99, 88], oneWay: false, fromNode: 1, toNode: 2, toFloor: 2 }];
    const markers = buildRegionTeleportMarkers(comps, edges, nodeById, cfg, componentColors);
    expect(markers).toEqual([]);
  });
});
