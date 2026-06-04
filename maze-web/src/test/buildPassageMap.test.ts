import { describe, it, expect, vi } from "vitest";
import { buildPassageMap } from "../pixi/MazeTileRenderer";
import type { NodeDto, EdgeDto } from "../wasm/types";

vi.mock("pixi.js", () => ({
  Container: vi.fn(() => ({ addChild: vi.fn(), destroy: vi.fn() })),
  Graphics: vi.fn(() => ({ rect: vi.fn(), fill: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), poly: vi.fn() })),
}));

vi.mock("../store/mazeStore", () => ({
  useMazeStore: { getState: vi.fn(() => ({ nodes: [], edges: [], start: null, finish: null })), subscribe: vi.fn(() => () => {}) },
}));

const n = (id: number, x: number, y: number): NodeDto => ({ id, x, y });
const e = (from: number, to: number): EdgeDto => ({ from, to });

describe("buildPassageMap", () => {
  it("no edges => all none", () => {
    const nodes = [n(0, 0, 0), n(1, 1, 0), n(2, 0, 1), n(3, 1, 1)];
    const map = buildPassageMap(nodes, []);
    expect(map.get("0,0:1,0")).toBe("none");
    expect(map.get("0,0:0,1")).toBe("none");
    expect(map.get("1,0:2,0")).toBe("none");
    expect(map.get("1,0:1,1")).toBe("none");
  });

  it("bidirectional edge => both", () => {
    const nodes = [n(0, 0, 0), n(1, 1, 0)];
    const edges = [e(0, 1), e(1, 0)];
    const map = buildPassageMap(nodes, edges);
    expect(map.get("0,0:1,0")).toBe("both");
  });

  it("forward-only east edge", () => {
    const nodes = [n(0, 0, 0), n(1, 1, 0)];
    const map = buildPassageMap(nodes, [e(0, 1)]);
    expect(map.get("0,0:1,0")).toBe("forward");
  });

  it("backward-only east edge", () => {
    const nodes = [n(0, 0, 0), n(1, 1, 0)];
    const map = buildPassageMap(nodes, [e(1, 0)]);
    expect(map.get("0,0:1,0")).toBe("backward");
  });

  it("forward-only north edge", () => {
    const nodes = [n(0, 0, 0), n(1, 0, 1)];
    const map = buildPassageMap(nodes, [e(0, 1)]);
    expect(map.get("0,0:0,1")).toBe("forward");
  });

  it("backward-only north edge", () => {
    const nodes = [n(0, 0, 0), n(1, 0, 1)];
    const map = buildPassageMap(nodes, [e(1, 0)]);
    expect(map.get("0,0:0,1")).toBe("backward");
  });

  it("bidirectional north edge => both", () => {
    const nodes = [n(0, 0, 0), n(1, 0, 1)];
    const map = buildPassageMap(nodes, [e(0, 1), e(1, 0)]);
    expect(map.get("0,0:0,1")).toBe("both");
  });

  it("edge to non-existent node is ignored", () => {
    const nodes = [n(0, 0, 0)];
    const map = buildPassageMap(nodes, [e(0, 99)]);
    expect(map.get("0,0:1,0")).toBe("none");
  });

  it("empty nodes returns empty map", () => {
    const map = buildPassageMap([], []);
    expect(map.size).toBe(0);
  });

  it("2x2 grid all passages open both directions", () => {
    const nodes = [n(0, 0, 0), n(1, 1, 0), n(2, 0, 1), n(3, 1, 1)];
    const edges = [
      e(0, 1), e(1, 0),
      e(0, 2), e(2, 0),
      e(1, 3), e(3, 1),
      e(2, 3), e(3, 2),
    ];
    const map = buildPassageMap(nodes, edges);
    expect(map.get("0,0:1,0")).toBe("both");
    expect(map.get("0,0:0,1")).toBe("both");
    expect(map.get("1,0:1,1")).toBe("both");
    expect(map.get("0,1:1,1")).toBe("both");
  });

  it("pair key written once even with duplicate edge directions", () => {
    const nodes = [n(0, 0, 0), n(1, 1, 0)];
    const edges = [e(0, 1), e(0, 1), e(0, 1)];
    const map = buildPassageMap(nodes, edges);
    expect(map.get("0,0:1,0")).toBe("forward");
  });
});
