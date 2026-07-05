import { describe, it, expect, vi } from "vitest";
import { buildMazeWalls } from "../pixi/selectors/mazeSelectors";
import type { NodeDto, EdgeDto } from "../wasm/types";

vi.mock("pixi.js", () => ({
  Container: vi.fn(() => ({ addChild: vi.fn(), destroy: vi.fn() })),
  Graphics: vi.fn(() => ({ rect: vi.fn(), fill: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), poly: vi.fn() })),
}));

vi.mock("../store/mazeStore", () => ({
  useMazeStore: { getState: vi.fn(() => ({ nodes: [], edges: [], start: null, finish: null })), subscribe: vi.fn(() => () => {}) },
}));

// getCellCenter (via squareGeometry's getCartesian) delegates to wasm, unavailable in this
// unit-test environment -- mock with the canonical square formula (see
// `maze-core/src/space/square.rs`'s `cartesian`: `(x, y)`, no offset/flip applied here).
vi.mock("../wasm/mazeService", () => ({
  getCartesianCoords: (cfg: { points: [number, number][] }) => cfg.points.map(([x, y]) => [x, y]),
}));

const squareCfg = { type: "square" as const, width: 11, height: 11 };
const n = (id: number, x: number, y: number): NodeDto => ({ id, x, y });
const e = (from: number, to: number): EdgeDto => ({ from, to, kind: "basic" });
const tp = (from: number, to: number): EdgeDto => ({ from, to, kind: "teleport" });

function kindOf(walls: ReturnType<typeof buildMazeWalls>, ax: number, ay: number, bx: number, by: number) {
  const key = `${Math.min(ax, bx)},${Math.min(ay, by)}:${Math.max(ax, bx)},${Math.max(ay, by)}`;
  const wall = walls.find(w => {
    const wKey = `${Math.min(w.a[0], w.b[0])},${Math.min(w.a[1], w.b[1])}:${Math.max(w.a[0], w.b[0])},${Math.max(w.a[1], w.b[1])}`;
    return wKey === key;
  });
  return wall?.kind ?? null;
}

describe("buildMazeWalls passage kinds", () => {
  it("no edges => all none", () => {
    const nodes = [n(0, 0, 0), n(1, 1, 0), n(2, 0, 1), n(3, 1, 1)];
    const walls = buildMazeWalls(nodes, [], squareCfg);
    expect(kindOf(walls, 0, 0, 1, 0)).toBe("none");
    expect(kindOf(walls, 0, 0, 0, 1)).toBe("none");
    expect(kindOf(walls, 1, 0, 2, 0)).toBe("none"); // (2,0) not in nodes => boundary wall
    expect(kindOf(walls, 1, 0, 1, 1)).toBe("none");
  });

  it("bidirectional edge => skipped (both = open passage, no wall)", () => {
    const nodes = [n(0, 0, 0), n(1, 1, 0)];
    const walls = buildMazeWalls(nodes, [e(0, 1), e(1, 0)], squareCfg);
    // "both" passages have no wall entry
    expect(kindOf(walls, 0, 0, 1, 0)).toBe(null);
  });

  it("forward-only east edge", () => {
    const nodes = [n(0, 0, 0), n(1, 1, 0)];
    const walls = buildMazeWalls(nodes, [e(0, 1)], squareCfg);
    expect(kindOf(walls, 0, 0, 1, 0)).toBe("forward");
  });

  it("backward-only east edge", () => {
    const nodes = [n(0, 0, 0), n(1, 1, 0)];
    const walls = buildMazeWalls(nodes, [e(1, 0)], squareCfg);
    expect(kindOf(walls, 0, 0, 1, 0)).toBe("backward");
  });

  it("forward-only north edge", () => {
    const nodes = [n(0, 0, 0), n(1, 0, 1)];
    const walls = buildMazeWalls(nodes, [e(0, 1)], squareCfg);
    expect(kindOf(walls, 0, 0, 0, 1)).toBe("forward");
  });

  it("backward-only north edge", () => {
    const nodes = [n(0, 0, 0), n(1, 0, 1)];
    const walls = buildMazeWalls(nodes, [e(1, 0)], squareCfg);
    expect(kindOf(walls, 0, 0, 0, 1)).toBe("backward");
  });

  it("bidirectional north edge => skipped", () => {
    const nodes = [n(0, 0, 0), n(1, 0, 1)];
    const walls = buildMazeWalls(nodes, [e(0, 1), e(1, 0)], squareCfg);
    expect(kindOf(walls, 0, 0, 0, 1)).toBe(null);
  });

  it("edge to non-existent node is ignored", () => {
    const nodes = [n(0, 0, 0)];
    const walls = buildMazeWalls(nodes, [e(0, 99)], squareCfg);
    // boundary wall toward (1,0) still exists
    expect(kindOf(walls, 0, 0, 1, 0)).toBe("none");
  });

  it("empty nodes returns empty array", () => {
    const walls = buildMazeWalls([], [], squareCfg);
    expect(walls.length).toBe(0);
  });

  it("2x2 grid all passages open both directions => no interior walls", () => {
    const nodes = [n(0, 0, 0), n(1, 1, 0), n(2, 0, 1), n(3, 1, 1)];
    const edges = [
      e(0, 1), e(1, 0),
      e(0, 2), e(2, 0),
      e(1, 3), e(3, 1),
      e(2, 3), e(3, 2),
    ];
    const walls = buildMazeWalls(nodes, edges, squareCfg);
    // All interior edges "both" → no wall entries for them
    expect(kindOf(walls, 0, 0, 1, 0)).toBe(null);
    expect(kindOf(walls, 0, 0, 0, 1)).toBe(null);
    expect(kindOf(walls, 1, 0, 1, 1)).toBe(null);
    expect(kindOf(walls, 0, 1, 1, 1)).toBe(null);
  });

  it("duplicate edge directions still forward", () => {
    const nodes = [n(0, 0, 0), n(1, 1, 0)];
    const walls = buildMazeWalls(nodes, [e(0, 1), e(0, 1), e(0, 1)], squareCfg);
    expect(kindOf(walls, 0, 0, 1, 0)).toBe("forward");
  });

  it("teleport-only edge between geometric neighbors still renders a wall (not an open passage)", () => {
    const nodes = [n(0, 0, 0), n(1, 1, 0)];
    const walls = buildMazeWalls(nodes, [tp(0, 1), tp(1, 0)], squareCfg);
    expect(kindOf(walls, 0, 0, 1, 0)).toBe("none");
  });

  it("teleport edge does not turn a one-way basic passage into a bidirectional opening", () => {
    const nodes = [n(0, 0, 0), n(1, 1, 0)];
    const walls = buildMazeWalls(nodes, [e(0, 1), tp(1, 0)], squareCfg);
    expect(kindOf(walls, 0, 0, 1, 0)).toBe("forward");
  });
});
