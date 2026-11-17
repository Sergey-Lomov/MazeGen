import { describe, it, expect, vi } from "vitest";
import { buildMazeMarkers, buildHoveredEntityHighlight, getSplitAwareNodePosition, type MarkerStyle } from "../pixi/selectors/mazeSelectors";
import { type PostEditHoveredEntity } from "../pixi/postEditEndpoint";
import { getCellCenter } from "../pixi/tessellationGeometry";
import type { NodeDto, EdgeDto } from "../wasm/types";
import { n, squareCfg, twoWay, hexCfg, hexNeighborNodes } from "./mazeSelectorsKit";

vi.mock("pixi.js", async () => (await import("./mazeSelectorsMocks")).pixiMock());
vi.mock("../store/mazeStore", async () => (await import("./mazeSelectorsMocks")).mazeStoreMock());
// getCellCenter (via cartesianCache's getCartesian) delegates to wasm, unavailable in this
// unit-test environment, so only the real preset/geometry entry points are kept.
vi.mock("../wasm/mazeService", async (importActual) =>
  (await import("./postEditSliceMocks")).mazeServiceMock(await importActual<typeof import("../wasm/mazeService")>()));


// --- getSplitAwareNodePosition ---
// Direct tests (GitHub issue #318 follow-up) — buildMazeMarkers/buildTeleportEdges no longer call
// this function themselves (they build the position map once via buildNodePositions instead), so
// it needs its own coverage as a still-exported, still-used (exportWarnings.ts) function.

describe("getSplitAwareNodePosition", () => {
  it("returns null for an unknown node id", () => {
    const nodes = [n(0, 0, 0)];
    expect(getSplitAwareNodePosition(nodes, 99, squareCfg)).toBeNull();
  });

  it("an unsplit node resolves to its plain cell center", () => {
    const nodes = [n(0, 1, 1)];
    expect(getSplitAwareNodePosition(nodes, 0, squareCfg)).toEqual(getCellCenter(1, 1, squareCfg));
  });

  it("a split node without edges falls back to the generic hub position", () => {
    const nodes = [n(0, 0, 0), n(1, 0, 0)];
    const center = getCellCenter(0, 0, squareCfg);
    const dist = Math.hypot(
      getSplitAwareNodePosition(nodes, 1, squareCfg)!.x - center.x,
      getSplitAwareNodePosition(nodes, 1, squareCfg)!.y - center.y,
    );
    expect(dist).toBeCloseTo(10); // TILE_SIZE / 4
  });

  it("a node recognized as a diagonal split shape resolves to its own half-tile point, not the hub circle", () => {
    const nodes = [
      n(0, 0, 0), n(1, 0, 0),
      n(10, 1, 0), n(11, 0, 1), n(12, -1, 0), n(13, 0, -1), // E,N,W,S neighbors
    ];
    const edges: EdgeDto[] = [
      ...twoWay(0, 10), ...twoWay(0, 11), ...twoWay(1, 12), ...twoWay(1, 13),
    ];
    const pos = getSplitAwareNodePosition(nodes, 0, squareCfg, edges)!;
    const center = getCellCenter(0, 0, squareCfg);
    expect(pos.x).toBeCloseTo(center.x + 40 / 4);
    expect(pos.y).toBeCloseTo(center.y - 40 / 4);
  });
});

// --- buildMazeMarkers ---

describe("buildMazeMarkers", () => {
  it("start/finish on unsplit nodes render at the plain cell center", () => {
    const nodeById = new Map<number, NodeDto>([[0, n(0, 0, 0)], [1, n(1, 1, 1)]]);
    const markers = buildMazeMarkers(nodeById, 0, 1, squareCfg);
    expect(markers).toHaveLength(2);
    expect(markers[0].pos).toEqual([20, -20]);
  });

  it("start on a split point anchors to that node's hub point, not the tile center (GitHub issue #223)", () => {
    // Point (0,0) split into node 0 (original) and node 2 (slot 0); node 2 is start.
    const nodeById = new Map<number, NodeDto>([[0, n(0, 0, 0)], [1, n(1, 1, 1)], [2, n(2, 0, 0)]]);
    const markers = buildMazeMarkers(nodeById, 2, null, squareCfg);
    expect(markers).toHaveLength(1);
    const center = { x: 20, y: -20 };
    const dist = Math.hypot(markers[0].pos[0] - center.x, markers[0].pos[1] - center.y);
    expect(dist).toBeCloseTo(10, 5);
  });

  it("null start/finish produce no markers", () => {
    const nodeById = new Map<number, NodeDto>([[0, n(0, 0, 0)]]);
    expect(buildMazeMarkers(nodeById, null, null, squareCfg)).toEqual([]);
  });

  it("start on a node recognized as a diagonal split shape anchors to its own half-tile point, not the hub circle (GitHub issue #318)", () => {
    // Point (0,0) split into node 0 (connects E,N) and node 1 (connects W,S) — a recognized
    // "diagonal" topology. Node 0 is start.
    const nodeById = new Map<number, NodeDto>([
      [0, n(0, 0, 0)], [1, n(1, 0, 0)],
      [10, n(10, 1, 0)], [11, n(11, 0, 1)], [12, n(12, -1, 0)], [13, n(13, 0, -1)], // E,N,W,S neighbors
    ]);
    const edges: EdgeDto[] = [
      ...twoWay(0, 10), ...twoWay(0, 11), ...twoWay(1, 12), ...twoWay(1, 13),
    ];
    const markers = buildMazeMarkers(nodeById, 0, null, squareCfg, undefined, undefined, edges);
    expect(markers).toHaveLength(1);
    const center = getCellCenter(0, 0, squareCfg);
    // Diagonal offset for node0's (E,N) face pair: (TILE_SIZE/4, -TILE_SIZE/4).
    expect(markers[0].pos[0]).toBeCloseTo(center.x + 40 / 4);
    expect(markers[0].pos[1]).toBeCloseTo(center.y - 40 / 4);
    // Not on the generic hub circle (radius TILE_SIZE/4 from center).
    const hubDist = Math.hypot(markers[0].pos[0] - center.x, markers[0].pos[1] - center.y);
    expect(hubDist).not.toBeCloseTo(10);
  });

  it("start on a hex bridge uses the bridge lane anchor from buildNodePositions", () => {
    const neighbors = hexNeighborNodes(0, 0);
    const split0 = n(100, 0, 0); // through faces 0,3
    const split1 = n(101, 0, 0); // bridge faces 1,4
    const nodes = [split0, split1, ...neighbors];
    const nodeById = new Map<number, NodeDto>(nodes.map((node) => [node.id, node]));
    const edges: EdgeDto[] = [
      ...twoWay(100, 1), ...twoWay(100, 4),
      ...twoWay(101, 2), ...twoWay(101, 5),
    ];

    const markers = buildMazeMarkers(nodeById, split0.id, split1.id, hexCfg, undefined, undefined, edges);
    const center = getCellCenter(0, 0, hexCfg);
    expect(markers).toHaveLength(2);
    expect(markers[0].pos).not.toEqual([center.x, center.y]);
    expect(markers[1].pos).toEqual([center.x, center.y]);
  });

  it("without edges, a split node still falls back to the generic hub position (default edges=[])", () => {
    const nodeById = new Map<number, NodeDto>([[0, n(0, 0, 0)], [1, n(1, 0, 0)]]);
    const markers = buildMazeMarkers(nodeById, 0, null, squareCfg);
    const center = getCellCenter(0, 0, squareCfg);
    const dist = Math.hypot(markers[0].pos[0] - center.x, markers[0].pos[1] - center.y);
    expect(dist).toBeCloseTo(10);
  });

  it("a custom MarkerStyle's size/cornerStyle/gapWidth/gapColor pass through into MarkerData (GitHub issue #302 follow-up — size is the diameter, GitHub issue #681 diameter follow-up; the rest map straight across)", () => {
    const nodeById = new Map<number, NodeDto>([[0, n(0, 0, 0)], [1, n(1, 1, 1)]]);
    const startStyle: MarkerStyle = {
      shape: "star", fillColor: 0x111, borderColor: 0x222, borderWidth: 4,
      size: 20, sizeAdaptation: 0, cornerStyle: "round", gapWidth: 3, gapColor: 0x333, text: "",
    };
    const markers = buildMazeMarkers(nodeById, 0, 1, squareCfg, startStyle);
    expect(markers[0]).toMatchObject({
      shape: "star", color: 0x111, borderColor: 0x222, borderWidth: 4,
      cornerStyle: "round", gapWidth: 3, gapColor: 0x333,
    });
    expect(markers[0].radius).toBe(10);
    // finishStyle omitted — falls back to the default circle (GitHub issue #347 follow-up:
    // matches "Vector by walls"' own Shared style default), unaffected by startStyle's own
    // custom fields.
    expect(markers[1]).toMatchObject({ shape: "circle", cornerStyle: "round", gapWidth: 3 });
  });

  it("textColor falls back to gapColor when textColor is unset, and uses textColor when set (GitHub issue #697 second follow-up)", () => {
    const nodeById = new Map<number, NodeDto>([[0, n(0, 0, 0)]]);
    const noColorStyle: MarkerStyle = {
      shape: "circle", fillColor: 0x111, borderColor: 0x222, borderWidth: 0,
      size: 20, sizeAdaptation: 0, cornerStyle: "round", gapWidth: 0, gapColor: 0x333, text: "S",
    };
    const withColorStyle: MarkerStyle = { ...noColorStyle, textColor: 0x444 };
    expect(buildMazeMarkers(nodeById, 0, null, squareCfg, noColorStyle)[0].textColor).toBe(0x333);
    expect(buildMazeMarkers(nodeById, 0, null, squareCfg, withColorStyle)[0].textColor).toBe(0x444);
  });
});

// --- buildHoveredEntityHighlight ---

describe("buildHoveredEntityHighlight", () => {
  it("null entity produces no highlight", () => {
    const nodes = [n(0, 0, 0), n(1, 1, 0)];
    expect(buildHoveredEntityHighlight(null, nodes, 0, squareCfg)).toEqual({ link: [], regionGroups: [] });
  });

  it("resolves a link entity's two points to their cell centers", () => {
    const nodes = [n(0, 0, 0), n(1, 1, 2)];
    const entity: PostEditHoveredEntity = { kind: "link", from: { point: [0, 0] }, to: { point: [1, 2] } };
    const result = buildHoveredEntityHighlight(entity, nodes, 0, squareCfg);
    expect(result.link).toHaveLength(1);
    expect(result.link[0].from).not.toEqual(result.link[0].to);
    expect(result.regionGroups).toEqual([]);
  });

  it("returns no highlight when neither link point resolves on this floor", () => {
    const nodes = [n(1, 9, 9)]; // neither (0,0) nor (1,1) present at any coordinate
    const entity: PostEditHoveredEntity = { kind: "link", from: { point: [0, 0] }, to: { point: [1, 1] } };
    expect(buildHoveredEntityHighlight(entity, nodes, 0, squareCfg)).toEqual({ link: [], regionGroups: [] });
  });

  it("cross-floor link solo-highlights only the endpoint on the active floor, not the other floor's", () => {
    // (3,2) on floor 0 is the `from` endpoint, (3,2) on floor 1 is the `to` endpoint — a vertical
    // passage/elevator-style shared coordinate, differing only in level.
    const nodes = [
      { id: 0, x: 3, y: 2, i: 0 } as NodeDto,
      { id: 1, x: 3, y: 2, i: 0, level: 1 } as NodeDto,
    ];
    const entity: PostEditHoveredEntity = { kind: "link", from: { point: [3, 2] }, to: { point: [3, 2], level: 1 } };

    const onFloor0 = buildHoveredEntityHighlight(entity, nodes, 0, squareCfg);
    expect(onFloor0.link).toEqual([]);
    expect(onFloor0.regionGroups).toEqual([[nodes[0].id]]);

    const onFloor1 = buildHoveredEntityHighlight(entity, nodes, 1, squareCfg);
    expect(onFloor1.link).toEqual([]);
    expect(onFloor1.regionGroups).toEqual([[nodes[1].id]]);
  });

  it("resolves a point entity to a one-element region group", () => {
    const nodes = [n(0, 0, 0), n(1, 1, 1)];
    const entity: PostEditHoveredEntity = { kind: "point", point: [1, 1] };
    const result = buildHoveredEntityHighlight(entity, nodes, 0, squareCfg);
    expect(result.link).toEqual([]);
    expect(result.regionGroups).toEqual([[nodes[1].id]]);
  });

  it("resolves a points entity to independent cell groups, keeping split nodes together", () => {
    const nodes = [n(0, 0, 0), n(1, 1, 1), n(2, 0, 0)];
    const entity: PostEditHoveredEntity = { kind: "points", points: [{ point: [0, 0] }, { point: [1, 1] }] };
    const result = buildHoveredEntityHighlight(entity, nodes, 0, squareCfg);
    expect(result.link).toEqual([]);
    expect(result.regionGroups).toEqual([[nodes[0].id, nodes[2].id], [nodes[1].id]]);
  });

  it("returns no region group when no point in a points entity is on this floor", () => {
    const nodes = [n(0, 0, 0)];
    const entity: PostEditHoveredEntity = { kind: "points", points: [{ point: [5, 5] }] };
    expect(buildHoveredEntityHighlight(entity, nodes, 0, squareCfg)).toEqual({ link: [], regionGroups: [] });
  });

  it("elevator-style points entity (all floors share one x,y) only highlights the active floor's own node", () => {
    const nodes = [
      { id: 0, x: 2, y: 2, i: 0 } as NodeDto,
      { id: 1, x: 2, y: 2, i: 0, level: 1 } as NodeDto,
      { id: 2, x: 2, y: 2, i: 0, level: 2 } as NodeDto,
    ];
    const entity: PostEditHoveredEntity = {
      kind: "points",
      points: [{ point: [2, 2] }, { point: [2, 2], level: 1 }, { point: [2, 2], level: 2 }],
    };
    const onFloor1 = buildHoveredEntityHighlight(entity, nodes, 1, squareCfg);
    expect(onFloor1.regionGroups).toEqual([[nodes[1].id]]);
  });
});