import { describe, it, expect } from "vitest";
import { buildCellInspection } from "../pixi/selectors/mazeSelectors";
import type { NodeDto, EdgeDto } from "../wasm/types";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";

const node = (id: number, x: number, y: number, extra: Partial<NodeDto> = {}): NodeDto =>
  ({ id, x, y, i: 0, level: 0, ...extra });

describe("buildCellInspection", () => {
  it("plain cell with no node at all -> bare coordinates", () => {
    const result = buildCellInspection(new Map(), [], 3, 5, 0, null, null);
    expect(result).toBe("x:3, y:5");
  });

  it("node with no markers -> bare coordinates (no trailing separator)", () => {
    const nodeById = new Map([[1, node(1, 3, 5)]]);
    const result = buildCellInspection(nodeById, [], 3, 5, 0, null, null);
    expect(result).toBe("x:3, y:5");
  });

  it("start marker", () => {
    const nodeById = new Map([[1, node(1, 3, 5)]]);
    const result = buildCellInspection(nodeById, [], 3, 5, 0, 1, null);
    expect(result).toBe("x:3, y:5 | Start");
  });

  it("finish marker", () => {
    const nodeById = new Map([[1, node(1, 3, 5)]]);
    const result = buildCellInspection(nodeById, [], 3, 5, 0, null, 1);
    expect(result).toBe("x:3, y:5 | Finish");
  });

  it("same-floor two-way teleport", () => {
    const nodeById = new Map([[1, node(1, 3, 5)], [2, node(2, 7, 2)]]);
    const edges: EdgeDto[] = [
      { from: 1, to: 2, kind: "teleport" },
      { from: 2, to: 1, kind: "teleport" },
    ];
    const result = buildCellInspection(nodeById, edges, 3, 5, 0, null, null);
    expect(result).toBe("x:3, y:5 | Teleport <-> (7,2)");
  });

  it("same-floor one-way teleport, departure end", () => {
    const nodeById = new Map([[1, node(1, 3, 5)], [2, node(2, 7, 2)]]);
    const edges: EdgeDto[] = [{ from: 1, to: 2, kind: "teleport" }];
    const result = buildCellInspection(nodeById, edges, 3, 5, 0, null, null);
    expect(result).toBe("x:3, y:5 | Teleport -> (7,2)");
  });

  it("same-floor one-way teleport, arrival end", () => {
    const nodeById = new Map([[1, node(1, 3, 5)], [2, node(2, 7, 2)]]);
    const edges: EdgeDto[] = [{ from: 1, to: 2, kind: "teleport" }];
    const result = buildCellInspection(nodeById, edges, 7, 2, 0, null, null);
    expect(result).toBe("x:7, y:2 | Teleport <- (3,5)");
  });

  it("cross-floor teleport shows floor label instead of coordinates", () => {
    const nodeById = new Map([[1, node(1, 3, 5, { level: 0 })], [2, node(2, 7, 2, { level: 2 })]]);
    const edges: EdgeDto[] = [{ from: 1, to: 2, kind: "teleport" }];
    const result = buildCellInspection(nodeById, edges, 3, 5, 0, null, null);
    expect(result).toBe("x:3, y:5 | Teleport -> (L3)");
  });

  it("bidirectional vertical passage", () => {
    const nodeById = new Map([[1, node(1, 3, 5, { level: 0 })], [2, node(2, 3, 5, { level: 1 })]]);
    const edges: EdgeDto[] = [
      { from: 1, to: 2, kind: "vertical_passage" },
      { from: 2, to: 1, kind: "vertical_passage" },
    ];
    const result = buildCellInspection(nodeById, edges, 3, 5, 0, null, null);
    expect(result).toBe("x:3, y:5 | Vertical passage <-> (L2)");
  });

  it("one-way vertical passage, departure end", () => {
    const nodeById = new Map([[1, node(1, 3, 5, { level: 0 })], [2, node(2, 3, 5, { level: 1 })]]);
    const edges: EdgeDto[] = [{ from: 1, to: 2, kind: "vertical_passage" }];
    const result = buildCellInspection(nodeById, edges, 3, 5, 0, null, null);
    expect(result).toBe("x:3, y:5 | Vertical passage -> (L2)");
  });

  it("one-way vertical passage, arrival end", () => {
    const nodeById = new Map([[1, node(1, 3, 5, { level: 0 })], [2, node(2, 3, 5, { level: 1 })]]);
    const edges: EdgeDto[] = [{ from: 1, to: 2, kind: "vertical_passage" }];
    const result = buildCellInspection(nodeById, edges, 3, 5, 1, null, null);
    expect(result).toBe("x:3, y:5 | Vertical passage <- (L1)");
  });

  it("elevator to several floors, no arrow, sorted/deduped floor list", () => {
    const nodeById = new Map([
      [1, node(1, 3, 5, { level: 0 })],
      [2, node(2, 3, 5, { level: 3 })],
      [3, node(3, 3, 5, { level: 1 })],
    ]);
    const edges: EdgeDto[] = [
      { from: 1, to: 2, kind: "elevator" },
      { from: 1, to: 3, kind: "elevator" },
    ];
    const result = buildCellInspection(nodeById, edges, 3, 5, 0, null, null);
    expect(result).toBe("x:3, y:5 | Elevator (L2, L4)");
  });

  it("split cell: one empty node, one node with markers, joined with ' | ' at the outer level and '; ' inside a node", () => {
    const nodeById = new Map([
      [1, node(1, 3, 5, { i: 0, level: 0 })],
      [2, node(2, 3, 5, { i: 1, level: 0 })],
      [3, node(3, 7, 2, { level: 0 })],
    ]);
    const edges: EdgeDto[] = [{ from: 2, to: 3, kind: "teleport" }];
    const result = buildCellInspection(nodeById, edges, 3, 5, 0, 2, null);
    expect(result).toBe("x:3, y:5 | [Node 1: empty] | [Node 2: Start; Teleport -> (7,2)]");
  });

  it("split node ordering follows NodeDto.i, not map insertion order", () => {
    const nodeById = new Map([
      [2, node(2, 3, 5, { i: 1, level: 0 })],
      [1, node(1, 3, 5, { i: 0, level: 0 })],
    ]);
    const result = buildCellInspection(nodeById, [], 3, 5, 0, null, null);
    expect(result).toBe("x:3, y:5 | [Node 1: empty] | [Node 2: empty]");
  });

  // GitHub issue #487 — a split point whose faces match a recognized special-split topology
  // (degree-4 "bridge") titles each block with the semantic node name instead of "Node N".
  it("bridge split cell: blocks titled 'Corridor' / 'Bridge' when cfg recognizes the topology", () => {
    const cfg: TessellationConfig = { type: "square", width: 3, height: 3 };
    // Square neighbor offsets are [+x, +y, -x, -y]; the through node (i:0) owns the +x/-x pair,
    // the crossing node (i:1) owns the +y/-y pair — each an opposite-face pair => "bridge".
    const nodeById = new Map<number, NodeDto>([
      [10, node(10, 1, 1, { i: 0 })],
      [11, node(11, 1, 1, { i: 1 })],
      [20, node(20, 2, 1)], [21, node(21, 0, 1)], // through neighbors
      [30, node(30, 1, 2)], [31, node(31, 1, 0)], // crossing neighbors
    ]);
    const twoWay = (a: number, b: number): EdgeDto[] => [
      { from: a, to: b, kind: "basic" }, { from: b, to: a, kind: "basic" },
    ];
    const edges: EdgeDto[] = [
      ...twoWay(10, 20), ...twoWay(10, 21),
      ...twoWay(11, 30), ...twoWay(11, 31),
    ];
    const result = buildCellInspection(nodeById, edges, 1, 1, 0, 10, null, cfg);
    expect(result).toBe("x:1, y:1 | [Corridor: Start] | [Bridge: empty]");
  });

  it("without cfg the same bridge cell still falls back to 'Node N'", () => {
    const nodeById = new Map<number, NodeDto>([
      [10, node(10, 1, 1, { i: 0 })],
      [11, node(11, 1, 1, { i: 1 })],
    ]);
    const result = buildCellInspection(nodeById, [], 1, 1, 0, null, null);
    expect(result).toBe("x:1, y:1 | [Node 1: empty] | [Node 2: empty]");
  });

  it("nodes on a different floor at the same (x,y) are not treated as a split point", () => {
    const nodeById = new Map([
      [1, node(1, 3, 5, { level: 0 })],
      [2, node(2, 3, 5, { level: 1 })],
    ]);
    const resultFloor0 = buildCellInspection(nodeById, [], 3, 5, 0, null, null);
    const resultFloor1 = buildCellInspection(nodeById, [], 3, 5, 1, null, null);
    expect(resultFloor0).toBe("x:3, y:5");
    expect(resultFloor1).toBe("x:3, y:5");
  });
});
