import { describe, it, expect, vi } from "vitest";
import { postEditEdgesToDto, buildClosedCells } from "../pixi/selectors/mazeSelectors";
import type { NodeDto, EdgeDto } from "../wasm/types";
import type { PostEditEdge } from "../store/mazeStore";

vi.mock("pixi.js", () => ({
  Container: vi.fn(() => ({ addChild: vi.fn(), destroy: vi.fn() })),
  Graphics: vi.fn(() => ({ rect: vi.fn(), fill: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), poly: vi.fn() })),
}));

vi.mock("../store/mazeStore", () => ({
  useMazeStore: { getState: vi.fn(() => ({})), subscribe: vi.fn(() => () => {}) },
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
    expect(result[0]).toEqual({ from: 1, to: 2 });
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

  it("returns only from/to fields", () => {
    const input = { "5-6": pe(5, 6, "basic") };
    const result = postEditEdgesToDto(input);
    expect(result[0]).toEqual({ from: 5, to: 6 });
    expect(Object.keys(result[0])).toEqual(["from", "to"]);
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
const e = (from: number, to: number): EdgeDto => ({ from, to });

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
});
