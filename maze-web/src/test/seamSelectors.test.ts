import { describe, expect, it } from "vitest";
import { warmCartesianCache } from "../pixi/cartesianCache";
import { configAllCells } from "../pixi/tessellationCells";
import { buildPairedRenderEdges } from "../pixi/BaseGraphRenderer";
import { seamCellSlots, seamStubHighlights } from "../pixi/graphSeams";
import { tuckEnds } from "../pixi/renderers/SeamArrowRenderer";
import { getCellCenter } from "../pixi/tessellationGeometry";
import { buildLinkHoverHighlight } from "../pixi/selectors/presetSelectors";
import { selectIssueHighlightData } from "../pixi/selectors/issueHighlight";
import { selectSeamHopContext, selectSeamPairs } from "../pixi/selectors/seamHop";
import type { MazeState } from "../store/storeTypes";
import type { WireTopology } from "../wasm/types";
import { fieldOf } from "./fieldConfigFixtures";
import { oneGlue } from "./seamFixtures";

// The glued pairs a renderer reads from the store (GitHub issue #841), on a 6x5 cylinder.
const COLUMNS = 6;
const ROWS = 5;
const points: [number, number][] = [];
for (let x = 0; x < COLUMNS; x++) for (let y = 0; y < ROWS; y++) points.push([x, y]);
const field = fieldOf("square", { shape: "custom", points });
const folds = Array.from({ length: ROWS }, (_, y) => ({ a: { cell: [COLUMNS - 1, y] as [number, number], face_idx: 0 }, b: { cell: [0, y] as [number, number], face_idx: 2 }, twist: false, group: 0 }));
const cylinder = oneGlue("square{}", folds);
const nodes = configAllCells(field).map(([x, y], id) => ({ id, x, y, i: 0 }));

const stateOf = (topology: WireTopology | null, extra: Partial<MazeState> = {}): MazeState => ({
  activeFloorId: "f0",
  floors: [{ id: "f0" }],
  floorFields: { f0: { fieldConfig: field } },
  floorTopology: { f0: topology },
  nodes,
  edges: [],
  hoveredIssueLoopEdges: null,
  hoveredIssueRegionGroups: null,
  ...extra,
} as unknown as MazeState);

describe("seam selectors", () => {
  it("have no pairs and no hop context on a floor without glues", () => {
    warmCartesianCache(field, null);
    expect(selectSeamPairs(stateOf(null))).toBeUndefined();
    expect(selectSeamHopContext(stateOf(null), nodes)).toBeUndefined();
  });

  it("have no pairs when the floor has no field", () => {
    expect(selectSeamPairs(stateOf(cylinder, { floorFields: {} } as Partial<MazeState>))).toBeUndefined();
  });

  it("read the glued pairs of the active floor and the cell of each node", () => {
    warmCartesianCache(field, cylinder);
    const state = stateOf(cylinder);
    expect(selectSeamPairs(state)!.pairs.size).toBe(ROWS);
    const context = selectSeamHopContext(state, nodes)!;
    expect(context.cellOf(7)).toEqual([nodes[7].x, nodes[7].y]);
    // The same node list gives the same context while the arrows stay.
    expect(selectSeamHopContext(state, nodes)).toBe(context);
  });

  it("collect what the issue highlight needs from the unscoped lists", () => {
    warmCartesianCache(field, cylinder);
    const edges = [{ from: 0, to: 1, kind: "basic" }, { from: 1, to: 2, kind: "elevator" }];
    const data = selectIssueHighlightData(stateOf(cylinder, { edges } as Partial<MazeState>), { nodes, edges: [] }, field);
    expect([...data.crossFloorEdgeKeys!]).toEqual(["1->2"]);
    expect(data.resolveNodeCell!(3)).toEqual([nodes[3].x, nodes[3].y]);
    expect(data.activeFloorIndex).toBe(0);
    expect(data.seam).toBeDefined();
  });
});

describe("hops across a glue as stubs", () => {
  const link = { from: { point: [COLUMNS - 1, 2] as [number, number] }, to: { point: [0, 2] as [number, number] } };
  const near = { from: { point: [1, 2] as [number, number] }, to: { point: [2, 2] as [number, number] } };

  it("break the highlighted link of a preset at the glue, and leave an ordinary one whole", () => {
    warmCartesianCache(field, cylinder);
    const seam = selectSeamPairs(stateOf(cylinder));
    const glued = buildLinkHoverHighlight(link as never, field, seam);
    expect(glued).toHaveLength(2);
    expect(glued[0].toMarker).toBe(false);
    expect(glued[1].fromMarker).toBe(false);
    expect(buildLinkHoverHighlight(near as never, field, seam)).toHaveLength(1);
    expect(buildLinkHoverHighlight(link as never, field)).toHaveLength(1);
  });

  it("give slots only to cells on the two sides of a glue", () => {
    warmCartesianCache(field, cylinder);
    const seam = selectSeamPairs(stateOf(cylinder))!;
    expect(seamCellSlots([COLUMNS - 1, 2], [0, 2], seam)).not.toBeNull();
    expect(seamCellSlots([1, 2], [2, 2], seam)).toBeNull();
    expect(seamCellSlots([COLUMNS - 1, 2], [1, 2], seam)).toBeNull();
  });
});

describe("hops in the graph and bodies at an angle", () => {
  const idOf = (x: number, y: number): number => nodes.find((node) => node.x === x && node.y === y)!.id;
  const nodePos = new Map(nodes.map((node) => [node.id, getCellCenter(node.x, node.y, field)]));

  it("draws a graph edge across a glue as two stubs, except a teleport", () => {
    warmCartesianCache(field, cylinder);
    const seam = selectSeamHopContext(stateOf(cylinder), nodes);
    const from = idOf(COLUMNS - 1, 2);
    const to = idOf(0, 2);
    const stubs = buildPairedRenderEdges([{ from, to }], nodePos, seam);
    expect(stubs).toHaveLength(2);
    expect(stubs[0].trimEnd).toBe(false);
    expect(stubs[1].trimStart).toBe(false);
    expect(buildPairedRenderEdges([{ from, to, kind: "teleport" }], nodePos, seam)).toHaveLength(1);
    expect(buildPairedRenderEdges([{ from: idOf(1, 2), to: idOf(2, 2) }], nodePos, seam)).toHaveLength(1);
  });

  it("keeps a highlighted line whole for an ordinary hop", () => {
    const line = { from: { x: 0, y: 0 }, to: { x: 1, y: 1 } };
    expect(seamStubHighlights(line, null)).toEqual([line]);
  });

  it("draws the body of an arrow leaving its wall at an angle clear of the head's base", () => {
    // Base along the x axis, body at 45 degrees: the square end of a width 2 stroke would stick out past the base.
    const head: [number, number][] = [[10, 10], [-3, 0], [3, 0]];
    const [start] = tuckEnds([[0, 0], [10, 10]], head, [[10, 10], [3, 3], [3, 3]], 2);
    expect(start[0]).toBeCloseTo(Math.SQRT1_2, 6);
    expect(start[1]).toBeCloseTo(Math.SQRT1_2, 6);
    // A body along the head's own axis is not moved.
    expect(tuckEnds([[0, 0], [0, 10]], [[0, 10], [-3, 0], [3, 0]], [[0, 10], [-3, 0], [3, 0]], 2)[0]).toEqual([0, 0]);
  });
});
