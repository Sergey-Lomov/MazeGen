import { describe, it, expect, vi } from "vitest";
import { postEditEdgesToDto, buildClosedCells, buildTeleportEdges } from "../pixi/selectors/mazeSelectors";
import type { NodeDto, EdgeDto } from "../wasm/types";
import type { PostEditEdge } from "../store/mazeStore";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";

vi.mock("pixi.js", () => ({
  Container: vi.fn(() => ({ addChild: vi.fn(), destroy: vi.fn() })),
  Graphics: vi.fn(() => ({ rect: vi.fn(), fill: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), poly: vi.fn() })),
}));

vi.mock("../store/mazeStore", () => ({
  useMazeStore: { getState: vi.fn(() => ({})), subscribe: vi.fn(() => () => {}) },
}));

// getCellCenter (via squareGeometry's getCartesian) delegates to wasm, unavailable in this
// unit-test environment -- mock with the canonical square formula (see
// `maze-core/src/space/square.rs`'s `cartesian`: `(x, y)`, no offset/flip applied here).
vi.mock("../wasm/mazeService", () => ({
  getCartesianCoords: (cfg: { points: [number, number][] }) => cfg.points.map(([x, y]) => [x, y]),
}));

// --- postEditEdgesToDto ---

const pe = (from: number, to: number, kind: PostEditEdge["kind"]): PostEditEdge => ({ from, to, kind });

describe("postEditEdgesToDto", () => {
  it("null input returns empty array", () => {
    expect(postEditEdgesToDto(null)).toEqual([]);
  });

  it("filters out wall edges", () => {
    const input = {
      "0-1": pe(0, 1, "wall"),
      "1-2": pe(1, 2, "basic"),
    };
    const result = postEditEdgesToDto(input);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ from: 1, to: 2, kind: "basic" });
  });

  it("includes basic and one_way edges", () => {
    const input = {
      "0-1": pe(0, 1, "basic"),
      "1-0": pe(1, 0, "basic"),
      "2-3": pe(2, 3, "one_way_forward"),
      "3-4": pe(3, 4, "one_way_backward"),
    };
    const result = postEditEdgesToDto(input);
    expect(result).toHaveLength(4);
  });

  it("returns from/to plus a basic kind, dropping the post-edit tool kind", () => {
    const input = { "5-6": pe(5, 6, "basic") };
    const result = postEditEdgesToDto(input);
    expect(result[0]).toEqual({ from: 5, to: 6, kind: "basic" });
    expect(Object.keys(result[0]).sort()).toEqual(["from", "kind", "to"]);
  });

  it("empty record returns empty array", () => {
    expect(postEditEdgesToDto({})).toEqual([]);
  });

  it("all walls returns empty array", () => {
    const input = {
      "0-1": pe(0, 1, "wall"),
      "1-2": pe(1, 2, "wall"),
    };
    expect(postEditEdgesToDto(input)).toEqual([]);
  });
});

// --- buildClosedCells ---

const n = (id: number, x: number, y: number): NodeDto => ({ id, x, y });
const e = (from: number, to: number): EdgeDto => ({ from, to, kind: "basic" });

describe("buildClosedCells", () => {
  it("no edges — all nodes are closed", () => {
    const nodes = [n(0, 0, 0), n(1, 1, 0)];
    const result = buildClosedCells(nodes, []);
    expect(result).toHaveLength(2);
    expect(result).toContainEqual([0, 0]);
    expect(result).toContainEqual([1, 0]);
  });

  it("connected node not in result", () => {
    const nodes = [n(0, 0, 0), n(1, 1, 0), n(2, 2, 0)];
    const result = buildClosedCells(nodes, [e(0, 1)]);
    expect(result).not.toContainEqual([0, 0]);
    expect(result).not.toContainEqual([1, 0]);
    expect(result).toContainEqual([2, 0]);
  });

  it("all connected — empty result", () => {
    const nodes = [n(0, 0, 0), n(1, 1, 0)];
    const result = buildClosedCells(nodes, [e(0, 1), e(1, 0)]);
    expect(result).toEqual([]);
  });

  it("empty nodes returns empty", () => {
    expect(buildClosedCells([], [])).toEqual([]);
  });

  it("single node with no edges is closed", () => {
    const result = buildClosedCells([n(0, 3, 5)], []);
    expect(result).toEqual([[3, 5]]);
  });

  it("edge referencing unknown node id still marks known node as connected", () => {
    const nodes = [n(0, 0, 0)];
    const result = buildClosedCells(nodes, [e(0, 99)]);
    expect(result).toEqual([]);
  });

  it("teleport-only edge counts as a connection — cell is not closed even with no geometric passage", () => {
    const nodes = [n(0, 0, 0), n(1, 1, 0)];
    const teleportEdge: EdgeDto = { from: 0, to: 1, kind: "teleport" };
    const result = buildClosedCells(nodes, [teleportEdge]);
    expect(result).not.toContainEqual([0, 0]);
    expect(result).not.toContainEqual([1, 0]);
  });
});

// --- buildTeleportEdges ---

const squareCfg: TessellationConfig = { type: "square", width: 4, height: 4 };
const teleport = (from: number, to: number): EdgeDto => ({ from, to, kind: "teleport" });

describe("buildTeleportEdges", () => {
  it("one-way teleport: single directed edge produces one entity with oneWay=true", () => {
    const nodeById = new Map<number, NodeDto>([[0, n(0, 0, 0)], [1, n(1, 3, 3)]]);
    const result = buildTeleportEdges(nodeById, [teleport(0, 1)], squareCfg);
    expect(result).toHaveLength(1);
    expect(result[0].oneWay).toBe(true);
  });

  it("two-way teleport: both directions present collapse into one entity with oneWay=false", () => {
    const nodeById = new Map<number, NodeDto>([[0, n(0, 0, 0)], [1, n(1, 3, 3)]]);
    const result = buildTeleportEdges(nodeById, [teleport(0, 1), teleport(1, 0)], squareCfg);
    expect(result).toHaveLength(1);
    expect(result[0].oneWay).toBe(false);
  });

  it("non-teleport edges are ignored", () => {
    const nodeById = new Map<number, NodeDto>([[0, n(0, 0, 0)], [1, n(1, 3, 3)]]);
    const result = buildTeleportEdges(nodeById, [e(0, 1)], squareCfg);
    expect(result).toEqual([]);
  });

  it("multiple independent teleport pairs each produce their own entity", () => {
    const nodeById = new Map<number, NodeDto>([
      [0, n(0, 0, 0)], [1, n(1, 1, 0)], [2, n(2, 2, 0)], [3, n(3, 3, 0)],
    ]);
    const result = buildTeleportEdges(nodeById, [teleport(0, 1), teleport(2, 3)], squareCfg);
    expect(result).toHaveLength(2);
  });

  it("skips a teleport edge whose endpoint is missing from nodeById", () => {
    const nodeById = new Map<number, NodeDto>([[0, n(0, 0, 0)]]); // node 1 missing
    const result = buildTeleportEdges(nodeById, [teleport(0, 1)], squareCfg);
    expect(result).toEqual([]);
  });

  it("empty edges returns empty array", () => {
    const nodeById = new Map<number, NodeDto>([[0, n(0, 0, 0)]]);
    expect(buildTeleportEdges(nodeById, [], squareCfg)).toEqual([]);
  });

  it("resolves from/to to actual cell-center positions", () => {
    const nodeById = new Map<number, NodeDto>([[0, n(0, 0, 0)], [1, n(1, 2, 0)]]);
    const result = buildTeleportEdges(nodeById, [teleport(0, 1)], squareCfg);
    expect(result[0].from).not.toEqual(result[0].to);
  });
});
