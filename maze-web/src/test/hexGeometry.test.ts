import { describe, it, expect } from "vitest";
import { squareCenter, hexCenter, hexVertices, mazeBounds, INRADIUS } from "../pixi/hexGeometry";
import { TILE_SIZE } from "../pixi/constants";

const EPS = 1e-9;
function near(a: number, b: number) { return Math.abs(a - b) < EPS; }

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

  it("flat_top_cell_center_q1", () => {
    // q=1, r=0: cx = 1.5*T, cy = -(0 + 1*INRADIUS) = -INRADIUS
    const { x, y } = hexCenter(1, 0, "flat_top");
    expect(x).toBeCloseTo(TILE_SIZE * 1.5);
    expect(y).toBeCloseTo(-INRADIUS);
  });
});

describe("hexCenter pointy_top", () => {
  it("pointy_top_cell_center_r1", () => {
    // q=0, r=1: cx = 0 + 1*INRADIUS = INRADIUS, cy = -(1*1.5*T) = -1.5*T
    const { x, y } = hexCenter(0, 1, "pointy_top");
    expect(x).toBeCloseTo(INRADIUS);
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

describe("mazeBounds", () => {
  it("maze_bounds_single_node", () => {
    const cx = 10, cy = -5, half = 20;
    const bounds = mazeBounds([{ x: cx, y: cy }], half);
    expect(bounds.minX).toBeCloseTo(cx - half);
    expect(bounds.minY).toBeCloseTo(cy - half);
    expect(bounds.maxX).toBeCloseTo(cx + half);
    expect(bounds.maxY).toBeCloseTo(cy + half);
  });
});
