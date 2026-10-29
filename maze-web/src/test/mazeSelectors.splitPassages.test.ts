import { describe, it, expect, vi } from "vitest";
import { buildSplitPassages, maxSplitNodeCount, buildSplitJunctionPositions } from "../pixi/selectors/mazeSelectors";
import { nodeEndpoint } from "../pixi/postEditEndpoint";
import { getCellCenter, getCellVertices, getNeighborData } from "../pixi/tessellationGeometry";
import { splitSlotColor } from "../pixi/colorUtils";
import { canvas } from "../pixi/colorTokens";
import type { NodeDto, EdgeDto } from "../wasm/types";
import { fieldOf } from "./fieldConfigFixtures";
import { selectSplitCellRenderer } from "../pixi/splitCellRenderer";
import { n, e, squareCfg, cairoCfg, twoWay } from "./mazeSelectorsKit";

vi.mock("pixi.js", async () => (await import("./mazeSelectorsMocks")).pixiMock());
vi.mock("../store/mazeStore", async () => (await import("./mazeSelectorsMocks")).mazeStoreMock());
// getCellCenter (via cartesianCache's getCartesian) delegates to wasm, unavailable in this
// unit-test environment, so only the real preset/geometry entry points are kept.
vi.mock("../wasm/mazeService", async (importActual) =>
  (await import("./postEditSliceMocks")).mazeServiceMock(await importActual<typeof import("../wasm/mazeService")>()));


// --- buildSplitPassages ---

describe("buildSplitPassages", () => {
  it("uses a sharper special bridge renderer for a 4.8.8 square", () => {
    // `regular:4` also occurs in the ordinary square tessellation. Only a 4.8.8 square needs
    // this treatment: its bridge silhouette meets seams of the adjacent octagons.
    expect(selectSplitCellRenderer("square", "regular:4").bridgeTaperFrac).toBe(0.2);
    expect(selectSplitCellRenderer("square_octagon", "regular:4").bridgeTaperFrac).toBe(0.08);
    expect(selectSplitCellRenderer("square_octagon", "regular:8").bridgeTaperFrac).toBe(0.2);

    // `(1,1)` is a square in 4.8.8. Its four diagonal neighbours form two opposite pairs.
    const squareOctagonCfg = fieldOf("square_octagon", { shape: "rect", cols: 3, rows: 3 });
    const nodes = [
      n(0, 1, 1), n(1, 2, 2), n(2, 0, 0),
      n(3, 0, 2), n(4, 1, 1), n(5, 2, 0),
    ];
    const edges: EdgeDto[] = [...twoWay(0, 1), ...twoWay(0, 2), ...twoWay(4, 3), ...twoWay(4, 5)];
    const result = buildSplitPassages(nodes, edges, squareOctagonCfg);
    expect(result.specialShapes).toHaveLength(1);
    const shape = result.specialShapes[0];
    expect(shape.kind).toBe("bridge");
    if (shape.kind !== "bridge") throw new Error("unreachable");
    const midpoint = (a: { x: number; y: number }, b: { x: number; y: number }) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    const distance = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
    const taperLength = distance(midpoint(shape.edge0[0], shape.edge1[0]), midpoint(shape.edge0[1], shape.edge1[1]));
    const bridgeLength = distance(midpoint(shape.edge0[0], shape.edge1[0]), midpoint(shape.edge0[3], shape.edge1[3]));
    expect(taperLength / bridgeLength).toBeCloseTo(0.08, 5);
  });

  it("unsplit point produces no passages", () => {
    const nodes = [n(0, 0, 0), n(1, 1, 0)];
    expect(buildSplitPassages(nodes, [...twoWay(0, 1)], squareCfg).passages).toEqual([]);
  });

  it("each connected split node gets one passage entry, in a distinct color", () => {
    // Point (0,0) split into node 0 (-> node 1 east) and node 2 (-> node 3 north).
    const nodes = [n(0, 0, 0), n(1, 1, 0), n(2, 0, 0), n(3, 0, 1)];
    const edges: EdgeDto[] = [...twoWay(0, 1), ...twoWay(2, 3)];
    const { passages } = buildSplitPassages(nodes, edges, squareCfg);
    expect(passages).toHaveLength(2);
    expect(passages[0].color).not.toBe(passages[1].color);
    expect(passages[0].wallSegments).toHaveLength(1);
    expect(passages[1].wallSegments).toHaveLength(1);
  });

  it("a node with no connections produces no passage entry", () => {
    const nodes = [n(0, 0, 0), n(1, 1, 0), n(2, 0, 0)];
    const { passages } = buildSplitPassages(nodes, [], squareCfg);
    expect(passages).toEqual([]);
  });

  it("activeSplitNode picks which node of a point draws last (on top), overriding the default (first/original) node", () => {
    // Point (0,0) split into node 0 (original, slot index 0) and node 2 (slot index 1), both
    // connected east/north respectively so both produce a passage entry. `splitSlotColor` keys
    // off slot index (node 0 -> index 0, node 2 -> index 1), so the resulting color identifies
    // which node ended up in which array position regardless of active-last reordering.
    const nodes = [n(0, 0, 0), n(1, 1, 0), n(2, 0, 0), n(3, 0, 1)];
    const edges: EdgeDto[] = [...twoWay(0, 1), ...twoWay(2, 3)];
    const withoutActive = buildSplitPassages(nodes, edges, squareCfg).passages;
    // Default (no activeSplitNode entry) keeps node-index order: node 0 (slot index 0) first.
    expect(withoutActive[0].color).toBe(splitSlotColor(0, canvas.node.splitSlots));
    expect(withoutActive[1].color).toBe(splitSlotColor(1, canvas.node.splitSlots));

    const withActive = buildSplitPassages(nodes, edges, squareCfg, new Set(), { "0,0": nodeEndpoint(0) }).passages;
    // node 0 (slot index 0) is now explicitly active -- it must be sorted last instead.
    expect(withActive[0].color).toBe(splitSlotColor(1, canvas.node.splitSlots));
    expect(withActive[1].color).toBe(splitSlotColor(0, canvas.node.splitSlots));
  });

  it("several edges from one node to different nodes of the same neighboring split point collapse to one wall segment per face", () => {
    // (0,0) split into node 0/node 4; (1,0) split into node 1/node 5. Node 0 connects to both
    // node 1 and node 5 (both at the same neighboring point, the east face) -- still just one
    // wall segment for node 0, even though it has two separate edges crossing that same face.
    const nodes = [n(0, 0, 0), n(1, 1, 0), n(2, 0, 0), n(3, 0, 1), n(4, 0, 0), n(5, 1, 0)];
    const edges: EdgeDto[] = [...twoWay(0, 1), ...twoWay(0, 5)];
    const { passages } = buildSplitPassages(nodes, edges, squareCfg);
    // Node 0 -> east face (1 entry, deduped across its 2 edges to node 1 and node 5).
    // Node 1 -> west face (1 entry, its own edge back to node 0).
    // Node 5 -> west face (1 entry, its own edge back to node 0). Nodes 2/4 have no edges -> 0 entries.
    expect(passages).toHaveLength(3);
    for (const p of passages) expect(p.wallSegments).toHaveLength(1);
  });

  it("corridorConnectorWidth (GitHub issue #314 follow-up): several nodes sharing a face divide the ordinary corridor's own width, centered on the face's own midpoint, not the whole face", () => {
    // (0,0) split into node 1/node 5, both facing east toward (1,0)'s node 0 -- same fixture shape
    // as the "collapse to one wall segment per face" test above, mirrored so the *receiving* point
    // (0,0) is the one with 2 nodes sharing a face. The shared face runs from (40,-40) to (40,0) in
    // this test's cartesian mock (see `squareCfg`'s own convention elsewhere in this file); its own
    // midpoint is (40,-20).
    const nodes = [n(0, 1, 0), n(1, 0, 0), n(2, 0, 1), n(3, 1, 0), n(4, -1, 0), n(5, 0, 0)];
    const edges: EdgeDto[] = [...twoWay(0, 1), ...twoWay(0, 5)];
    const withoutWidth = buildSplitPassages(nodes, edges, squareCfg).passages.filter((p) => p.pointKey === "0,0");
    expect(withoutWidth).toHaveLength(2);
    const [a, b] = withoutWidth;
    // Default (no corridorConnectorWidth): the shared face's own full 40-length span is divided in
    // half — each share's own center sits 20 away from the face's own (40,-20) midpoint.
    expect(Math.abs(a.wallSegments[0].center.y - -20)).toBeCloseTo(10, 5);
    expect(Math.abs(b.wallSegments[0].center.y - -20)).toBeCloseTo(10, 5);

    // With corridorConnectorWidth (the ordinary corridor's own thickness): each share's own center
    // sits `width / 4` away from the face's own midpoint (half of `width / 2`), regardless of the
    // face's own (much larger) 40-length span.
    const width = 10;
    const withWidth = buildSplitPassages(nodes, edges, squareCfg, new Set(), {}, {}, undefined, width).passages.filter((p) => p.pointKey === "0,0");
    const [wa, wb] = withWidth;
    expect(Math.abs(wa.wallSegments[0].center.y - -20)).toBeCloseTo(width / 4, 5);
    expect(Math.abs(wb.wallSegments[0].center.y - -20)).toBeCloseTo(width / 4, 5);
    expect(wa.wallSegments[0].center.x).toBeCloseTo(40, 5);
  });

  it("one-way passage's connector gets a direction marker, bidirectional does not", () => {
    const nodes = [n(0, 0, 0), n(1, 1, 0), n(2, 0, 0)];
    const oneWay = buildSplitPassages(nodes, [e(2, 1)], squareCfg).passages;
    expect(oneWay[0].connectors[0].oneWayOut).toBeDefined();

    const twoWayPassages = buildSplitPassages(nodes, [...twoWay(2, 1)], squareCfg).passages;
    expect(twoWayPassages[0].connectors[0].oneWayOut).toBeUndefined();
  });

  it("a backward-only one-way passage's connector points the opposite way from a forward-only one-way", () => {
    // Node 2 (slot 0 at (0,0)) has only an incoming edge from node 1 (east neighbor) -- the
    // mirror of the existing forward-only case, exercising the other arm of the fwd/bwd ternary.
    const nodes = [n(0, 0, 0), n(1, 1, 0), n(2, 0, 0)];
    const forwardOnly = buildSplitPassages(nodes, [e(2, 1)], squareCfg).passages[0].connectors[0].oneWayOut;
    const backwardOnly = buildSplitPassages(nodes, [e(1, 2)], squareCfg).passages[0].connectors[0].oneWayOut;
    expect(forwardOnly).toBe(true);
    expect(backwardOnly).toBe(false);
  });

  it("a teleport edge between a split point's nodes is excluded from passage geometry entirely", () => {
    // Node 2 (slot 0 at (0,0)) has only a teleport edge to node 1 -- must not produce a wall
    // segment/passage at all, matching buildMazeWalls's own teleport exclusion.
    const nodes = [n(0, 0, 0), n(1, 1, 0), n(2, 0, 0)];
    const teleportOnly: EdgeDto = { from: 2, to: 1, kind: "teleport" };
    const { passages } = buildSplitPassages(nodes, [teleportOnly], squareCfg);
    expect(passages).toEqual([]);
  });

  it("a split node connected to a non-adjacent point produces no wall segment for that face", () => {
    // Node 2 (slot 0 at (0,0)) has an edge to node 1 at (2,0) -- not a geometric neighbor of
    // (0,0) in a square tessellation, so getSharedEdgeSegment returns null for that face.
    const nodes = [n(0, 0, 0), n(1, 2, 0), n(2, 0, 0)];
    const { passages } = buildSplitPassages(nodes, [...twoWay(2, 1)], squareCfg);
    expect(passages).toEqual([]);
  });

  it("a node with exactly 2 connected faces gets a single straight connector between their centers, no hub point", () => {
    // Node 2 (slot 0 at split point (0,0)) connects east to node 1 and north to node 3.
    const nodes = [n(0, 0, 0), n(1, 1, 0), n(2, 0, 0), n(3, 0, 1)];
    const edges: EdgeDto[] = [...twoWay(2, 1), ...twoWay(2, 3)];
    const { passages } = buildSplitPassages(nodes, edges, squareCfg);
    const node2Passage = passages.find(p => p.wallSegments.length === 2)!;
    expect(node2Passage.wallSegments).toHaveLength(2);
    expect(node2Passage.connectors).toHaveLength(1);
    expect(node2Passage.connectors[0].from).toEqual(node2Passage.wallSegments[0].center);
    expect(node2Passage.connectors[0].to).toEqual(node2Passage.wallSegments[1].center);
  });

  it("a node with 2 connected faces keeps its hub point when it carries a start/finish/teleport marker", () => {
    // Same setup as the straightening test above, but node 2 is now in `specialNodeIds`.
    const nodes = [n(0, 0, 0), n(1, 1, 0), n(2, 0, 0), n(3, 0, 1)];
    const edges: EdgeDto[] = [...twoWay(2, 1), ...twoWay(2, 3)];
    const { passages } = buildSplitPassages(nodes, edges, squareCfg, new Set([2]));
    const node2Passage = passages.find(p => p.wallSegments.length === 2)!;
    expect(node2Passage.connectors).toHaveLength(2);
    const center = { x: 20, y: -20 };
    for (const c of node2Passage.connectors) {
      const dist = Math.hypot(c.from.x - center.x, c.from.y - center.y);
      expect(dist).toBeCloseTo(10, 5);
    }
  });

  it("a node with exactly 1 connected face gets one hub connector from the circle point", () => {
    const nodes = [n(0, 0, 0), n(1, 1, 0), n(2, 0, 0)];
    const { passages } = buildSplitPassages(nodes, [...twoWay(2, 1)], squareCfg);
    const node2Passage = passages.find(p => p.wallSegments.length === 1)!;
    expect(node2Passage.connectors).toHaveLength(1);
    expect(node2Passage.connectors[0].to).toEqual(node2Passage.wallSegments[0].center);
    // Cell (0,0) center is (20, -20) in this test's cartesian mock — the connector's `from` must
    // sit on the circle (distance TILE_SIZE/4 = 10 from center), not at the center itself.
    const center = { x: 20, y: -20 };
    const dist = Math.hypot(node2Passage.connectors[0].from.x - center.x, node2Passage.connectors[0].from.y - center.y);
    expect(dist).toBeCloseTo(10, 5);
  });

  it("two nodes of the same split point sharing a face each get half the edge, non-overlapping", () => {
    // Point (0,0) split into node 0 (original) and node 2 (slot 0), both connected to node 1 east.
    const nodes = [n(0, 0, 0), n(1, 1, 0), n(2, 0, 0)];
    const edges: EdgeDto[] = [...twoWay(0, 1), ...twoWay(2, 1)];
    const { passages } = buildSplitPassages(nodes, edges, squareCfg);
    expect(passages).toHaveLength(2);

    const [seg0, seg1] = passages.map(p => p.wallSegments[0]);
    // Each sub-segment spans half the shared edge -- their combined length equals the full edge,
    // and they don't overlap (share exactly one boundary point, node 0's v1 == node 2's v0 or
    // vice versa depending on slot order).
    const len = (v0: { x: number; y: number }, v1: { x: number; y: number }) =>
      Math.hypot(v1.x - v0.x, v1.y - v0.y);
    const fullEdgeLen = len(seg0.v0, seg1.v1) === len(seg0.v0, seg0.v1) + len(seg1.v0, seg1.v1)
      ? len(seg0.v0, seg1.v1) : len(seg1.v0, seg0.v1);
    expect(len(seg0.v0, seg0.v1) + len(seg1.v0, seg1.v1)).toBeCloseTo(fullEdgeLen, 5);
    expect(len(seg0.v0, seg0.v1)).toBeCloseTo(len(seg1.v0, seg1.v1), 5);

    // Each sub-segment's own center differs -- not both collapsing to the full edge's midpoint.
    expect(seg0.center).not.toEqual(seg1.center);
  });

  it("recognizes a degree-4 bridge topology (each node an opposite-face pair)", () => {
    // Point (0,0) split into node 0 (slot 0: east+west) and node 4 (slot 1: north+south).
    const nodes = [
      n(0, 0, 0), n(1, 1, 0), n(2, -1, 0),
      n(3, 0, 1), n(4, 0, 0), n(5, 0, -1),
    ];
    const edges: EdgeDto[] = [...twoWay(0, 1), ...twoWay(0, 2), ...twoWay(4, 3), ...twoWay(4, 5)];
    const { specialShapes } = buildSplitPassages(nodes, edges, squareCfg);
    expect(specialShapes).toHaveLength(1);
    const shape = specialShapes[0];
    expect(shape.kind).toBe("bridge");
    expect(shape.pointKey).toBe("0,0");
    if (shape.kind !== "bridge") throw new Error("unreachable");
    // The cross corridor is north/south (the through corridor, east/west, draws nothing of its
    // own). Each edge is a 4-point polyline: full width at the cross faces (y = 0 and y = -40 in
    // this test's cartesian mock, i.e. the tile's own top/bottom edges), narrowing to 60% width at
    // the original gradual 20% taper, flat in between.
    expect(shape.edge0).toHaveLength(4);
    expect(shape.edge1).toHaveLength(4);
    const [e0start, e0taperIn, e0taperOut, e0end] = shape.edge0;
    const [e1start, e1taperIn, e1taperOut, e1end] = shape.edge1;
    // Full-width endpoints match the cross faces' own v0/v1 exactly.
    expect(e0start).toEqual(shape.crossFaces[0].v0);
    expect(e0end).toEqual(shape.crossFaces[1].v0);
    expect(e1start).toEqual(shape.crossFaces[0].v1);
    expect(e1end).toEqual(shape.crossFaces[1].v1);
    // The deck (taperIn -> taperOut) is flat: same width apart as it is at both ends of the deck.
    const width = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
    const fullWidth = width(e0start, e1start);
    const deckWidth = width(e0taperIn, e1taperIn);
    expect(width(e0taperOut, e1taperOut)).toBeCloseTo(deckWidth, 5);
    expect(deckWidth).toBeCloseTo(fullWidth * 0.6, 5);
    expect(deckWidth).toBeLessThan(fullWidth);
    const midpoint = (a: { x: number; y: number }, b: { x: number; y: number }) => ({
      x: (a.x + b.x) / 2, y: (a.y + b.y) / 2,
    });
    const taperAxialLength = width(midpoint(e0start, e1start), midpoint(e0taperIn, e1taperIn));
    const bridgeLength = width(midpoint(e0start, e1start), midpoint(e0end, e1end));
    expect(taperAxialLength / bridgeLength).toBeCloseTo(0.2, 5);

    // edge0/edge1 must run side by side, never crossing -- `nearestEndpointPairing` (mazeSelectors.ts)
    // picks which of crossFaces[1]'s two ends pairs with which of crossFaces[0]'s; picking the wrong
    // one draws a self-crossing "bowtie" bridge instead of two parallel edges. Checked by comparing
    // each edge's own x-offset from the shared corridor axis at both the start and end: same-sign
    // (never swapping sides) means non-crossing. The corridor axis here runs along y (north-south),
    // so "side" is which side of that vertical line each edge's x sits on.
    const axisX = (e0start.x + e1start.x) / 2;
    const e0StartSide = Math.sign(e0start.x - axisX);
    const e0EndSide = Math.sign(e0end.x - axisX);
    const e1StartSide = Math.sign(e1start.x - axisX);
    const e1EndSide = Math.sign(e1end.x - axisX);
    expect(e0StartSide).toBe(e0EndSide);
    expect(e1StartSide).toBe(e1EndSide);
    expect(e0StartSide).not.toBe(e1StartSide);
  });

  it("a would-be bridge with a one-way connection draws ordinary hub connectors with an arrow, not a special shape (GitHub issue #477)", () => {
    // Same fixture as the degree-4 bridge test above, but node 0's east connection is one-way
    // (node 0 -> node 1 only) instead of two-way.
    const nodes = [
      n(0, 0, 0), n(1, 1, 0), n(2, -1, 0),
      n(3, 0, 1), n(4, 0, 0), n(5, 0, -1),
    ];
    const edges: EdgeDto[] = [e(0, 1), ...twoWay(0, 2), ...twoWay(4, 3), ...twoWay(4, 5)];
    const { specialShapes, passages } = buildSplitPassages(nodes, edges, squareCfg);
    expect(specialShapes).toEqual([]);
    // Node 0 falls back to hub connectors; its one-way east face carries a direction marker.
    const node0Passage = passages.find((p) => p.wallSegments.length === 2)!;
    expect(node0Passage.connectors.some((c) => c.oneWayOut === true)).toBe(true);
  });

  it("recognizes a degree-4 diagonal-divider topology (each node an adjacent-face pair)", () => {
    // Point (0,0) split into node 0 (slot 0: east+north) and node 4 (slot 1: west+south).
    const nodes = [
      n(0, 0, 0), n(1, 1, 0), n(2, 0, 1),
      n(3, -1, 0), n(4, 0, 0), n(5, 0, -1),
    ];
    const edges: EdgeDto[] = [...twoWay(0, 1), ...twoWay(0, 2), ...twoWay(4, 3), ...twoWay(4, 5)];
    const { specialShapes } = buildSplitPassages(nodes, edges, squareCfg);
    expect(specialShapes).toHaveLength(1);
    const shape = specialShapes[0];
    expect(shape.kind).toBe("diagonal");
    if (shape.kind !== "diagonal") throw new Error("unreachable");
    // A real geometric diagonal between two opposite tile corners -- corner0 != corner1, and
    // both sit at the tile's own half-diagonal distance from center (10*sqrt(2) for a 20-wide
    // square tile in this test's cartesian mock).
    expect(shape.corner0).not.toEqual(shape.corner1);
    const center = { x: 20, y: -20 };
    const dist0 = Math.hypot(shape.corner0.x - center.x, shape.corner0.y - center.y);
    const dist1 = Math.hypot(shape.corner1.x - center.x, shape.corner1.y - center.y);
    expect(dist0).toBeCloseTo(dist1, 5);
    expect(dist0).toBeGreaterThan(10); // farther than the mid-face distance (10)

    // The diagonal must run through the corners where an east/north face (node 0) meets a
    // west/south face (node 1) -- (0,0)'s vertices are TL=(0,-40), TR=(40,-40), BR=(40,0),
    // BL=(0,0); node 0's own corner (E+N meet) is TR, node 1's own corner (W+S meet) is BL, but
    // the *dividing* diagonal must be the other pair: TL (N meets W) and BR (S meets E) -- so
    // every one of node 0's faces (E, N) ends up strictly on one side, node 1's (W, S) on the
    // other. Getting TR/BL here instead would put a face on the wrong side of the cut.
    const corners = [shape.corner0, shape.corner1];
    expect(corners).toContainEqual({ x: 0, y: -40 }); // TL
    expect(corners).toContainEqual({ x: 40, y: 0 }); // BR
  });

  it("renders the Cairo 2x2 divider as corner12 -> centre -> corner34", () => {
    const point: [number, number] = [2, 1];
    const order = [0, 1, 2, 3, 4];
    const offsets = getNeighborData(cairoCfg, ...point).offsets;
    const neighbors = offsets.map(([dx, dy], i) => n(200 + i, point[0] + dx, point[1] + dy));
    const nodes = [n(100, ...point), n(101, ...point), ...neighbors];
    const connect = (node: number, faces: number[]) => faces.flatMap((face) => [e(node, 200 + face), e(200 + face, node)]);
    const { specialShapes } = buildSplitPassages(
      nodes,
      [...connect(100, [order[2], order[3]]), ...connect(101, [order[1], order[4]])],
      cairoCfg,
    );
    expect(specialShapes).toHaveLength(1);
    const shape = specialShapes[0];
    expect(shape.kind).toBe("diagonal");
    if (shape.kind !== "diagonal") throw new Error("unreachable");
    expect(shape.wallPath).toHaveLength(3);
    expect(shape.wallPath?.[1]).toEqual(getCellCenter(...point, cairoCfg));
    expect(shape.wallPath?.[0]).not.toEqual(shape.wallPath?.[2]);
    // The canonical 2-3 connection is the visual top layer; node order must not be used as a
    // proxy because the same split can be supplied with its two nodes reversed.
    expect(shape.topNodeIndex).toBe(0);

    const reversed = buildSplitPassages(
      [n(101, ...point), n(100, ...point), ...neighbors],
      [...connect(101, [order[1], order[4]]), ...connect(100, [order[2], order[3]])],
      cairoCfg,
    ).specialShapes[0];
    expect(reversed.kind).toBe("diagonal");
    if (reversed.kind !== "diagonal") throw new Error("unreachable");
    expect(reversed.topNodeIndex).toBe(1);
  });

  it("renders the Cairo adjacent divider as side 0 plus corner23 -> side-0 midpoint", () => {
    const point: [number, number] = [2, 1];
    const order = [0, 1, 2, 3, 4];
    const offsets = getNeighborData(cairoCfg, ...point).offsets;
    const neighbors = offsets.map(([dx, dy], i) => n(300 + i, point[0] + dx, point[1] + dy));
    const nodes = [n(110, ...point), n(111, ...point), ...neighbors];
    const connect = (node: number, faces: number[]) => faces.flatMap((face) => [e(node, 300 + face), e(300 + face, node)]);
    const { specialShapes } = buildSplitPassages(
      nodes,
      [...connect(110, [order[1], order[2]]), ...connect(111, [order[3], order[4]])],
      cairoCfg,
    );
    expect(specialShapes).toHaveLength(2);
    expect(specialShapes.every((shape) => shape.kind === "diagonal" && shape.wallPath?.length === 2)).toBe(true);
    const vertices = getCellVertices(...point, cairoCfg)!;
    const edge0 = getNeighborData(cairoCfg, ...point).edgeVerts[order[0]];
    expect(specialShapes).toEqual(expect.arrayContaining([
      expect.objectContaining({ wallPath: [vertices[edge0[0]], vertices[edge0[1]]] }),
    ]));
  });

  it("renders the Cairo 2x3 bridge and preserves the fork's ordinary passages", () => {
    const point: [number, number] = [2, 1];
    const order = [0, 1, 2, 3, 4];
    const offsets = getNeighborData(cairoCfg, ...point).offsets;
    const neighbors = offsets.map(([dx, dy], i) => n(400 + i, point[0] + dx, point[1] + dy));
    const nodes = [n(120, ...point), n(121, ...point), ...neighbors];
    const connect = (node: number, faces: number[]) => faces.flatMap((face) => [e(node, 400 + face), e(400 + face, node)]);
    const { passages, specialShapes } = buildSplitPassages(
      nodes,
      [...connect(120, [order[0], order[2], order[3]]), ...connect(121, [order[1], order[4]])],
      cairoCfg,
    );
    expect(specialShapes).toHaveLength(1);
    const shape = specialShapes[0];
    expect(shape.kind).toBe("bridge");
    if (shape.kind !== "bridge") throw new Error("unreachable");
    expect(shape.throughLine).toBeUndefined();
    expect(shape.crossFaces[0]).toEqual(expect.objectContaining({ v0: expect.any(Object), v1: expect.any(Object) }));
    expect(passages.find((passage) => passage.nodeIndex === 0)?.wallSegments).toHaveLength(3);
  });

  it("a degree-4 point with 3+ nodes, or a mismatched opposite/adjacent pairing, is not recognized as a special shape", () => {
    // 3-node split point -- `detectSplitSpecialShapeKind` only ever matches exactly 2 nodes.
    const threeNodes = [n(0, 0, 0), n(1, 1, 0), n(2, 0, 1), n(3, 0, 0), n(4, -1, 0), n(5, 0, 0), n(6, 0, -1)];
    const threeEdges: EdgeDto[] = [...twoWay(0, 1), ...twoWay(3, 4), ...twoWay(5, 6)];
    expect(buildSplitPassages(threeNodes, threeEdges, squareCfg).specialShapes).toEqual([]);

    // 2 nodes, but one an opposite pair and the other adjacent -- doesn't match either shape.
    const mismatched = [n(0, 0, 0), n(1, 1, 0), n(2, -1, 0), n(3, 0, 0), n(4, 0, 1)];
    const mismatchedEdges: EdgeDto[] = [...twoWay(0, 1), ...twoWay(0, 2), ...twoWay(3, 4)];
    expect(buildSplitPassages(mismatched, mismatchedEdges, squareCfg).specialShapes).toEqual([]);
  });
});

// --- buildSplitJunctionPositions (GitHub issue #518) ---

describe("buildSplitJunctionPositions", () => {
  it("a split point with 2 connected nodes still emits only one position, deduped by pointKey", () => {
    // Point (0,0) split into node 0 (-> node 1 east) and node 2 (-> node 3 north) — 2 passages,
    // both sharing pointKey "0,0".
    const nodes = [n(0, 0, 0), n(1, 1, 0), n(2, 0, 0), n(3, 0, 1)];
    const edges: EdgeDto[] = [...twoWay(0, 1), ...twoWay(2, 3)];
    const { passages } = buildSplitPassages(nodes, edges, squareCfg);
    expect(passages).toHaveLength(2);
    expect(passages[0].pointKey).toBe(passages[1].pointKey);
    expect(buildSplitJunctionPositions(passages)).toHaveLength(1);
    expect(buildSplitJunctionPositions(passages)[0]).toEqual([passages[0].center.x, passages[0].center.y]);
  });

  it("no split passages — no positions", () => {
    expect(buildSplitJunctionPositions([])).toEqual([]);
  });
});

describe("maxSplitNodeCount", () => {
  it("returns 0 for an empty node list or a maze with no split points", () => {
    expect(maxSplitNodeCount([])).toBe(0);
    expect(maxSplitNodeCount([n(0, 0, 0), n(1, 1, 0)])).toBe(0);
  });

  it("returns the largest node count at any one split point", () => {
    const nodes = [
      n(0, 0, 0), n(1, 0, 0), // 2-node split point
      n(2, 1, 0), n(3, 1, 0), n(4, 1, 0), // 3-node split point
      n(5, 2, 0), // unsplit
    ];
    expect(maxSplitNodeCount(nodes)).toBe(3);
  });

  it("does not count the same cell on different floors as a split point (GitHub issue #294 follow-up)", () => {
    const at = (id: number, x: number, y: number, level: number): NodeDto => ({ id, x, y, i: 0, level });
    // (3,4) occupied on 5 floors, plus a genuine 2-node split on floor 0.
    const nodes = [
      at(0, 3, 4, 0), at(1, 3, 4, 1), at(2, 3, 4, 2), at(3, 3, 4, 3), at(4, 3, 4, 4),
      at(5, 7, 7, 0), at(6, 7, 7, 0),
    ];
    expect(maxSplitNodeCount(nodes)).toBe(2);
  });
});