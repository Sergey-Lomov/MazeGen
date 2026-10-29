import { describe, it, expect, vi } from "vitest";
import { buildSplitPassages } from "../pixi/selectors/mazeSelectors";
import { getCellVertices } from "../pixi/tessellationGeometry";
import type { EdgeDto } from "../wasm/types";
import { n, e, twoWay, hexCfg, hexNeighborNodes } from "./mazeSelectorsKit";

vi.mock("pixi.js", async () => (await import("./mazeSelectorsMocks")).pixiMock());
vi.mock("../store/mazeStore", async () => (await import("./mazeSelectorsMocks")).mazeStoreMock());
// getCellCenter (via cartesianCache's getCartesian) delegates to wasm, unavailable in this
// unit-test environment, so only the real preset/geometry entry points are kept.
vi.mock("../wasm/mazeService", async (importActual) =>
  (await import("./postEditSliceMocks")).mazeServiceMock(await importActual<typeof import("../wasm/mazeService")>()));


// --- hex special shapes (GitHub issue #319) ---

// flat_top hex, offsets (HEX_NEIGHBOR_OFFSETS_FLAT): 0=(1,0) 1=(0,1) 2=(-1,1) 3=(-1,0) 4=(0,-1) 5=(1,-1)
// Opposite pairs: (0,3) (1,4) (2,5). Adjacent pairs: (i,i+1). Skip pairs: (i,i+2).
// Neighbor node ids are always 1..6 (one per face index); split-point node ids start at 100 to
// avoid colliding with them.
describe("hex special shapes", () => {
  it("recognizes a hex_bridge topology (2 opposite-face pairs)", () => {
    // Point (0,0) split into node 100 (faces 0,3 -- opposite) and node 101 (faces 1,4 -- opposite).
    const neighbors = hexNeighborNodes(0, 0);
    const nodes = [n(100, 0, 0), n(101, 0, 0), ...neighbors];
    const edges: EdgeDto[] = [
      ...twoWay(100, 1), ...twoWay(100, 4),
      ...twoWay(101, 2), ...twoWay(101, 5),
    ];
    const { specialShapes } = buildSplitPassages(nodes, edges, hexCfg);
    expect(specialShapes).toHaveLength(1);
    const shape = specialShapes[0];
    expect(shape.kind).toBe("bridge");
    expect(shape.pointKey).toBe("0,0");
    if (shape.kind !== "bridge") throw new Error("unreachable");
    const midpoint = (a: { x: number; y: number }, b: { x: number; y: number }) => ({
      x: (a.x + b.x) / 2, y: (a.y + b.y) / 2,
    });
    const distance = (a: { x: number; y: number }, b: { x: number; y: number }) =>
      Math.hypot(a.x - b.x, a.y - b.y);
    const taperLength = distance(midpoint(shape.edge0[0], shape.edge1[0]), midpoint(shape.edge0[1], shape.edge1[1]));
    const bridgeLength = distance(midpoint(shape.edge0[0], shape.edge1[0]), midpoint(shape.edge0[3], shape.edge1[3]));
    expect(taperLength / bridgeLength).toBeCloseTo(0.08 * (1 - 0.6) / (1 - 0.4), 5);
  });

  it("recognizes a hex_triple_bridge topology (3 opposite-face pairs, node0 < node1 < node2 layering)", () => {
    // Point (0,0) split into node 100 (faces 0,3), node 101 (faces 1,4), node 102 (faces 2,5).
    const neighbors = hexNeighborNodes(0, 0);
    const nodes = [n(100, 0, 0), n(101, 0, 0), n(102, 0, 0), ...neighbors];
    const edges: EdgeDto[] = [
      ...twoWay(100, 1), ...twoWay(100, 4),
      ...twoWay(101, 2), ...twoWay(101, 5),
      ...twoWay(102, 3), ...twoWay(102, 6),
    ];
    const { specialShapes } = buildSplitPassages(nodes, edges, hexCfg);
    // node0 (through corridor) draws nothing of its own; node1 and node2 each cross it once.
    expect(specialShapes).toHaveLength(2);
    for (const shape of specialShapes) {
      expect(shape.kind).toBe("bridge");
      expect(shape.pointKey).toBe("0,0");
    }
  });

  it("recognizes a hex_diagonal topology, 2-shared-corner sub-case (adjacent pairs)", () => {
    // Point (0,0) split into node 100 (faces 0,1 -- adjacent) and node 101 (faces 3,4 -- adjacent).
    const neighbors = hexNeighborNodes(0, 0);
    const nodes = [n(100, 0, 0), n(101, 0, 0), ...neighbors];
    const edges: EdgeDto[] = [
      ...twoWay(100, 1), ...twoWay(100, 2),
      ...twoWay(101, 4), ...twoWay(101, 5),
    ];
    const { specialShapes } = buildSplitPassages(nodes, edges, hexCfg);
    expect(specialShapes).toHaveLength(1);
    const shape = specialShapes[0];
    expect(shape.kind).toBe("diagonal");
    if (shape.kind !== "diagonal") throw new Error("unreachable");
    expect(shape.corner0).not.toEqual(shape.corner1);
    expect(shape.throughLine).toBeUndefined();
  });

  it("recognizes a hex_diagonal topology, 1-shared-corner sub-case (skip pair + adjacent pair)", () => {
    // Point (0,0) split into node 100 (faces 0,2 -- skip) and node 101 (faces 4,5 -- adjacent).
    // Faces 2 and 4 share one real corner; face 0 and face 5 leave a gap (no shared corner).
    const neighbors = hexNeighborNodes(0, 0);
    const nodes = [n(100, 0, 0), n(101, 0, 0), ...neighbors];
    const edges: EdgeDto[] = [
      ...twoWay(100, 1), ...twoWay(100, 3),
      ...twoWay(101, 5), ...twoWay(101, 6),
    ];
    const { specialShapes } = buildSplitPassages(nodes, edges, hexCfg);
    expect(specialShapes).toHaveLength(1);
    const shape = specialShapes[0];
    expect(shape.kind).toBe("diagonal");
    if (shape.kind !== "diagonal") throw new Error("unreachable");
    expect(shape.corner0).not.toEqual(shape.corner1);
  });

  it("renders a hex diagonal divider with the exact same wall line as 0-2 / 3-5", () => {
    const neighbors = hexNeighborNodes(0, 0);
    const nodes = [n(100, 0, 0), n(101, 0, 0), ...neighbors];
    const edgesFor = (faces: number[][]): EdgeDto[] => faces.flatMap((nodeFaces, nodeIndex) =>
      nodeFaces.flatMap((face) => [e(100 + nodeIndex, face + 1), e(face + 1, 100 + nodeIndex)]),
    );
    const divider = buildSplitPassages(nodes, edgesFor([[0, 1, 2], [3, 4, 5]]), hexCfg).specialShapes;
    const doublePassage = buildSplitPassages(nodes, edgesFor([[0, 2], [3, 5]]), hexCfg).specialShapes;
    expect(divider).toHaveLength(1);
    expect(doublePassage).toHaveLength(1);
    if (divider[0].kind !== "diagonal" || doublePassage[0].kind !== "diagonal") throw new Error("unreachable");
    // Same wall line; endpoint order follows face order and is not part of the contract.
    expect([divider[0].corner0, divider[0].corner1]).toEqual(
      expect.arrayContaining([doublePassage[0].corner0, doublePassage[0].corner1]),
    );
    expect(divider[0].dividerJunctions).toHaveLength(2);
    expect(divider[0].dividerJunctions?.[0]).not.toEqual(divider[0].dividerJunctions?.[1]);
  });

  it("recognizes a hex_triple_corridor topology (1 opposite + 2 adjacent pairs)", () => {
    // Point (0,0) split into node 100 (faces 0,3 -- opposite/through), node 101 (faces 1,2 -- adjacent),
    // node 102 (faces 4,5 -- adjacent).
    const neighbors = hexNeighborNodes(0, 0);
    const nodes = [n(100, 0, 0), n(101, 0, 0), n(102, 0, 0), ...neighbors];
    const edges: EdgeDto[] = [
      ...twoWay(100, 1), ...twoWay(100, 4),
      ...twoWay(101, 2), ...twoWay(101, 3),
      ...twoWay(102, 5), ...twoWay(102, 6),
    ];
    const { specialShapes } = buildSplitPassages(nodes, edges, hexCfg);
    expect(specialShapes).toHaveLength(2);
    for (const shape of specialShapes) {
      expect(shape.kind).toBe("diagonal");
      expect(shape.pointKey).toBe("0,0");
    }
    const diagonalShapes = specialShapes.filter((shape) => shape.kind === "diagonal");
    const verts = getCellVertices(0, 0, hexCfg)!;
    const endpointPairs = diagonalShapes.map((shape) => [shape.corner0, shape.corner1]);
    expect(endpointPairs).toEqual(expect.arrayContaining([
      expect.arrayContaining([verts[0], verts[4]]),
      expect.arrayContaining([verts[1], verts[3]]),
    ]));
    expect(diagonalShapes.every((shape) => shape.wallPath?.length === 3)).toBe(true);
    const bends = diagonalShapes.map((shape) => shape.wallPath![1]);
    const diameter = Math.hypot(verts[0].x - verts[3].x, verts[0].y - verts[3].y);
    expect(Math.hypot(bends[0].x - bends[1].x, bends[0].y - bends[1].y)).toBeCloseTo(diameter / 3, 5);
    // Exactly one of the two entries carries the shared through-line.
    const withThroughLine = specialShapes.filter((s) => s.kind === "diagonal" && s.throughLine);
    expect(withThroughLine).toHaveLength(1);
  });
});