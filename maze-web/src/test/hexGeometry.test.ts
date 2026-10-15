import { describe, it, expect, vi } from "vitest";
import { TILE_SIZE } from "../pixi/constants";
import { fieldOf } from "./fieldConfigFixtures";

// getCartesian (cartesianCache.ts) delegates to wasm, unavailable in this unit-test environment.
// Mock it with the same canonical (unit-tile-scale, flat_top/r0-equivalent) formulas
// `maze-core::space`'s Tessellation impls use, so these tests stay pure formula checks -- see
// `maze-core/src/space/{square,hex,triangle}.rs` for the source of truth these must match.
vi.mock("../pixi/cartesianCache", () => ({
  getCartesian: (x: number, y: number, cfg: { tessellation: { kind: string } }): [number, number] => {
    if (cfg.tessellation.kind === "square") return [x, y];
    if (cfg.tessellation.kind === "hex") {
      const inradius = Math.sqrt(3) / 2;
      return [x * 1.5, -(y * inradius * 2 + x * inradius)];
    }
    // triangle: core's canonical S=2 projection
    const s = 2, h = (s * Math.sqrt(3)) / 2;
    const pointingUp = (x + y) % 2 === 0;
    const cx = (x * s) / 2 + s / 4;
    const cy = pointingUp ? -(y * h + h / 3) : -(y * h + (2 * h) / 3);
    return [cx, cy];
  },
}));

const { hexCenter, cellCenter, hexVertices, mazeBounds, INRADIUS } = await import("../pixi/hexGeometry");
const { squareCenter } = await import("../pixi/squareGeometry");

describe("squareCenter", () => {
  it("square_cell_center_origin", () => {
    const { x, y } = squareCenter(0, 0);
    expect(x).toBeCloseTo(TILE_SIZE / 2);
    expect(y).toBeCloseTo(-TILE_SIZE / 2);
  });

  it("square_cell_center_1_1", () => {
    const { x, y } = squareCenter(1, 1);
    expect(x).toBeCloseTo(TILE_SIZE * 1.5);
    expect(y).toBeCloseTo(-TILE_SIZE * 1.5);
  });
});

describe("hexCenter flat_top", () => {
  it("flat_top_cell_center_origin", () => {
    const { x, y } = hexCenter(0, 0, "flat_top");
    expect(x).toBeCloseTo(0);
    expect(y).toBeCloseTo(0);
  });

  it("flat_top_cell_center_q1_r0", () => {
    // q=1, r=0: cx = 1.5*T, cy = -(0 + 1*INRADIUS) = -INRADIUS
    const { x, y } = hexCenter(1, 0, "flat_top");
    expect(x).toBeCloseTo(TILE_SIZE * 1.5);
    expect(y).toBeCloseTo(-INRADIUS);
  });

  it("flat_top_cell_center_q0_r1", () => {
    // q=0, r=1: cx = 0, cy = -(1*2*INRADIUS + 0) = -2*INRADIUS
    const { x, y } = hexCenter(0, 1, "flat_top");
    expect(x).toBeCloseTo(0);
    expect(y).toBeCloseTo(-2 * INRADIUS);
  });

  it("flat_top_cell_center_q1_r1", () => {
    // q=1, r=1: cx = 1.5*T, cy = -(1*2*INRADIUS + 1*INRADIUS) = -3*INRADIUS
    const { x, y } = hexCenter(1, 1, "flat_top");
    expect(x).toBeCloseTo(TILE_SIZE * 1.5);
    expect(y).toBeCloseTo(-3 * INRADIUS);
  });

  it("flat_top_negative_coords", () => {
    // q=-1, r=0: cx = -1.5*T, cy = INRADIUS
    const { x, y } = hexCenter(-1, 0, "flat_top");
    expect(x).toBeCloseTo(-TILE_SIZE * 1.5);
    expect(y).toBeCloseTo(INRADIUS);
  });
});

describe("hexCenter pointy_top", () => {
  it("pointy_top_cell_center_origin", () => {
    const { x, y } = hexCenter(0, 0, "pointy_top");
    expect(x).toBeCloseTo(0);
    expect(y).toBeCloseTo(0);
  });

  it("pointy_top_cell_center_q0_r1", () => {
    // q=0, r=1: cx = 0 + 1*INRADIUS = INRADIUS, cy = -(1*1.5*T) = -1.5*T
    const { x, y } = hexCenter(0, 1, "pointy_top");
    expect(x).toBeCloseTo(INRADIUS);
    expect(y).toBeCloseTo(-TILE_SIZE * 1.5);
  });

  it("pointy_top_cell_center_q1_r0", () => {
    // q=1, r=0: cx = 1*2*INRADIUS + 0 = 2*INRADIUS, cy = 0
    const { x, y } = hexCenter(1, 0, "pointy_top");
    expect(x).toBeCloseTo(2 * INRADIUS);
    expect(y).toBeCloseTo(0);
  });

  it("pointy_top_cell_center_q1_r1", () => {
    // q=1, r=1: cx = 2*INRADIUS + 1*INRADIUS = 3*INRADIUS, cy = -1.5*T
    const { x, y } = hexCenter(1, 1, "pointy_top");
    expect(x).toBeCloseTo(3 * INRADIUS);
    expect(y).toBeCloseTo(-TILE_SIZE * 1.5);
  });
});

describe("hexVertices", () => {
  it("hex_vertices_count flat_top", () => {
    expect(hexVertices(0, 0, "flat_top")).toHaveLength(6);
  });

  it("hex_vertices_count pointy_top", () => {
    expect(hexVertices(0, 0, "pointy_top")).toHaveLength(6);
  });

  it("flat_top_first_vertex_at_right", () => {
    const cx = 100, cy = 50;
    const verts = hexVertices(cx, cy, "flat_top");
    // First vertex at angle 0 from center: x = cx + TILE_SIZE, y = cy
    expect(verts[0].x).toBeCloseTo(cx + TILE_SIZE);
    expect(verts[0].y).toBeCloseTo(cy);
  });

  it("pointy_top_first_vertex_at_top", () => {
    const cx = 100, cy = 50;
    const verts = hexVertices(cx, cy, "pointy_top");
    // First vertex at angle 90° (top in screen = -y direction): x = cx, y = cy - TILE_SIZE
    expect(verts[0].x).toBeCloseTo(cx);
    expect(verts[0].y).toBeCloseTo(cy - TILE_SIZE);
  });

  it("all_vertices_at_circumradius flat_top", () => {
    const cx = 50, cy = -30;
    const verts = hexVertices(cx, cy, "flat_top");
    for (const v of verts) {
      const dist = Math.sqrt((v.x - cx) ** 2 + (v.y - cy) ** 2);
      expect(dist).toBeCloseTo(TILE_SIZE);
    }
  });

  it("all_vertices_at_circumradius pointy_top", () => {
    const cx = 50, cy = -30;
    const verts = hexVertices(cx, cy, "pointy_top");
    for (const v of verts) {
      const dist = Math.sqrt((v.x - cx) ** 2 + (v.y - cy) ** 2);
      expect(dist).toBeCloseTo(TILE_SIZE);
    }
  });

  it("flat_top_opposite_vertices_symmetric", () => {
    const cx = 0, cy = 0;
    const verts = hexVertices(cx, cy, "flat_top");
    for (let i = 0; i < 3; i++) {
      expect(verts[i].x + verts[i + 3].x).toBeCloseTo(0);
      expect(verts[i].y + verts[i + 3].y).toBeCloseTo(0);
    }
  });
});

describe("cellCenter", () => {
  it("square_dispatches_to_squareCenter", () => {
    const node = { id: 0, x: 2, y: 3 };
    const { x, y } = cellCenter(node, fieldOf("square", { shape: "rect", cols: 10, rows: 10 }));
    expect(x).toBeCloseTo(squareCenter(2, 3).x);
    expect(y).toBeCloseTo(squareCenter(2, 3).y);
  });

  it("hex_parallelogram_dispatches_to_hexCenter", () => {
    const node = { id: 0, x: 1, y: 2 };
    const { x, y } = cellCenter(node, fieldOf("hex", { shape: "parallelogram", cols: 5, rows: 5 }, "flat_top"));
    expect(x).toBeCloseTo(hexCenter(1, 2, "flat_top").x);
    expect(y).toBeCloseTo(hexCenter(1, 2, "flat_top").y);
  });

  it("hex_hexagon_dispatches_to_hexCenter", () => {
    const node = { id: 0, x: -1, y: 1 };
    const { x, y } = cellCenter(node, fieldOf("hex", { shape: "hexagon", radius: 3 }, "pointy_top"));
    expect(x).toBeCloseTo(hexCenter(-1, 1, "pointy_top").x);
    expect(y).toBeCloseTo(hexCenter(-1, 1, "pointy_top").y);
  });

  it("hex_parallelogram_default_orientation_is_flat_top", () => {
    const node = { id: 0, x: 1, y: 0 };
    const { x, y } = cellCenter(node, fieldOf("hex", { shape: "parallelogram", cols: 5, rows: 5 }));
    expect(x).toBeCloseTo(hexCenter(1, 0, "flat_top").x);
    expect(y).toBeCloseTo(hexCenter(1, 0, "flat_top").y);
  });
});

describe("mazeBounds", () => {
  it("maze_bounds_single_node", () => {
    const cx = 10, cy = -5, half = 20;
    const bounds = mazeBounds([{ x: cx, y: cy }], half);
    expect(bounds.minX).toBeCloseTo(cx - half);
    expect(bounds.minY).toBeCloseTo(cy - half);
    expect(bounds.maxX).toBeCloseTo(cx + half);
    expect(bounds.maxY).toBeCloseTo(cy + half);
  });

  it("maze_bounds_multiple_nodes", () => {
    const centers = [{ x: 0, y: 0 }, { x: 10, y: -20 }, { x: -5, y: 15 }];
    const half = 5;
    const bounds = mazeBounds(centers, half);
    expect(bounds.minX).toBeCloseTo(-5 - half);
    expect(bounds.minY).toBeCloseTo(-20 - half);
    expect(bounds.maxX).toBeCloseTo(10 + half);
    expect(bounds.maxY).toBeCloseTo(15 + half);
  });

  it("maze_bounds_padding_symmetric", () => {
    const centers = [{ x: 0, y: 0 }];
    const half = 7;
    const bounds = mazeBounds(centers, half);
    expect(bounds.maxX - bounds.minX).toBeCloseTo(2 * half);
    expect(bounds.maxY - bounds.minY).toBeCloseTo(2 * half);
  });
});
