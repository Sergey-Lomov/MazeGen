import { describe, it, expect, vi } from "vitest";
import { fakeCellCenter } from "./cellCentersFake";

// getCartesian (cartesianCache.ts) delegates to wasm, unavailable in this unit-test environment.
// Mock it with the world-unit centers `maze-core::space::triangle` produces (`cellCentersFake.ts`),
// so these tests stay pure formula checks.
vi.mock("../pixi/cartesianCache", () => ({
  getCartesian: (col: number, row: number): [number, number] => fakeCellCenter(col, row, "tri"),
}));

const { triCenter, triVertices, TRI_TILE_SIZE } = await import("../pixi/triGeometry");

const S = TRI_TILE_SIZE;
const H = S * Math.sqrt(3) / 2;

// Tessellation adjacency (corrected):
// up(col,row): Left=(col-1,row), Right=(col+1,row), Base=(col,row-1)  [base is below in screen = row-1]
// down(col,row): Left=(col-1,row), Right=(col+1,row), Base=(col,row+1) [base is above in screen = row+1]

describe("triCenter r0", () => {
  it("triangle_center_origin", () => {
    // col=0, row=0: pointing-up (parity=0)
    // cx = S/4,  cy = -(0*H + H/3) = -H/3
    const { x, y } = triCenter(0, 0, "r0");
    expect(x).toBeCloseTo(S / 4);
    expect(y).toBeCloseTo(-H / 3);
  });

  it("pointing_down_center", () => {
    // col=1, row=0: pointing-down (parity=1)
    // cx = 3*S/4,  cy = -(0*H + 2*H/3) = -2*H/3
    const { x, y } = triCenter(1, 0, "r0");
    expect(x).toBeCloseTo(3 * S / 4);
    expect(y).toBeCloseTo(-2 * H / 3);
  });

  it("pointing_down_next_row", () => {
    // col=0, row=1: pointing-down (parity=1)
    // cx = S/4,  cy = -(1*H + 2*H/3) = -5*H/3
    const { x, y } = triCenter(0, 1, "r0");
    expect(x).toBeCloseTo(S / 4);
    expect(y).toBeCloseTo(-(H + 2 * H / 3));
  });
});

describe("triCenter r90", () => {
  it("r90_origin_rotated", () => {
    // r0(0,0) = (S/4, -H/3) → r90: x = H/3, y = -S/4
    const { x, y } = triCenter(0, 0, "r90");
    expect(x).toBeCloseTo(H / 3);
    expect(y).toBeCloseTo(-S / 4);
  });
});

describe("triVertices r0", () => {
  it("r0_up_vertices_count", () => {
    // col=0, row=0: pointing-up (parity=0)
    expect(triVertices(0, 0, "r0")).toHaveLength(3);
  });

  it("r0_down_vertices_count", () => {
    // col=1, row=0: pointing-down (parity=1)
    expect(triVertices(1, 0, "r0")).toHaveLength(3);
  });

  it("r0_up_centroid_is_center", () => {
    // col=0, row=0: center=(S/4, -H/3)
    const verts = triVertices(0, 0, "r0");
    const avgX = (verts[0].x + verts[1].x + verts[2].x) / 3;
    const avgY = (verts[0].y + verts[1].y + verts[2].y) / 3;
    expect(avgX).toBeCloseTo(S / 4);
    expect(avgY).toBeCloseTo(-H / 3);
  });

  it("r0_down_centroid_is_center", () => {
    // col=1, row=0: center=(3S/4, -2H/3)
    const verts = triVertices(1, 0, "r0");
    const avgX = (verts[0].x + verts[1].x + verts[2].x) / 3;
    const avgY = (verts[0].y + verts[1].y + verts[2].y) / 3;
    expect(avgX).toBeCloseTo(3 * S / 4);
    expect(avgY).toBeCloseTo(-2 * H / 3);
  });

  it("r0_up_all_vertices_at_circumradius", () => {
    // col=0, row=0: center=(S/4, -H/3). Circumradius = S / sqrt(3)
    const { x: cx, y: cy } = triCenter(0, 0, "r0");
    const verts = triVertices(0, 0, "r0");
    const circumradius = S / Math.sqrt(3);
    for (const v of verts) {
      const dist = Math.sqrt((v.x - cx) ** 2 + (v.y - cy) ** 2);
      expect(dist).toBeCloseTo(circumradius);
    }
  });
});

describe("triVertices r90", () => {
  it("r90_up_vertices_count", () => {
    expect(triVertices(0, 0, "r90")).toHaveLength(3);
  });

  it("r90_up_centroid_is_center", () => {
    const { x: cx, y: cy } = triCenter(0, 0, "r90");
    const verts = triVertices(0, 0, "r90");
    const avgX = (verts[0].x + verts[1].x + verts[2].x) / 3;
    const avgY = (verts[0].y + verts[1].y + verts[2].y) / 3;
    expect(avgX).toBeCloseTo(cx);
    expect(avgY).toBeCloseTo(cy);
  });

  it("r90_up_all_vertices_at_circumradius", () => {
    const { x: cx, y: cy } = triCenter(0, 0, "r90");
    const verts = triVertices(0, 0, "r90");
    const circumradius = S / Math.sqrt(3);
    for (const v of verts) {
      const dist = Math.sqrt((v.x - cx) ** 2 + (v.y - cy) ** 2);
      expect(dist).toBeCloseTo(circumradius);
    }
  });
});

describe("triVertices r180", () => {
  it("r180_up_vertices_count", () => {
    expect(triVertices(0, 0, "r180")).toHaveLength(3);
  });

  it("r180_up_centroid_is_center", () => {
    const { x: cx, y: cy } = triCenter(0, 0, "r180");
    const verts = triVertices(0, 0, "r180");
    const avgX = (verts[0].x + verts[1].x + verts[2].x) / 3;
    const avgY = (verts[0].y + verts[1].y + verts[2].y) / 3;
    expect(avgX).toBeCloseTo(cx);
    expect(avgY).toBeCloseTo(cy);
  });

  it("r180_up_all_vertices_at_circumradius", () => {
    const { x: cx, y: cy } = triCenter(0, 0, "r180");
    const verts = triVertices(0, 0, "r180");
    const circumradius = S / Math.sqrt(3);
    for (const v of verts) {
      const dist = Math.sqrt((v.x - cx) ** 2 + (v.y - cy) ** 2);
      expect(dist).toBeCloseTo(circumradius);
    }
  });

  it("r180_down_centroid_is_center", () => {
    const { x: cx, y: cy } = triCenter(1, 0, "r180");
    const verts = triVertices(1, 0, "r180");
    const avgX = (verts[0].x + verts[1].x + verts[2].x) / 3;
    const avgY = (verts[0].y + verts[1].y + verts[2].y) / 3;
    expect(avgX).toBeCloseTo(cx);
    expect(avgY).toBeCloseTo(cy);
  });
});

describe("triVertices r270", () => {
  it("r270_up_vertices_count", () => {
    expect(triVertices(0, 0, "r270")).toHaveLength(3);
  });

  it("r270_up_centroid_is_center", () => {
    const { x: cx, y: cy } = triCenter(0, 0, "r270");
    const verts = triVertices(0, 0, "r270");
    const avgX = (verts[0].x + verts[1].x + verts[2].x) / 3;
    const avgY = (verts[0].y + verts[1].y + verts[2].y) / 3;
    expect(avgX).toBeCloseTo(cx);
    expect(avgY).toBeCloseTo(cy);
  });

  it("r270_up_all_vertices_at_circumradius", () => {
    const { x: cx, y: cy } = triCenter(0, 0, "r270");
    const verts = triVertices(0, 0, "r270");
    const circumradius = S / Math.sqrt(3);
    for (const v of verts) {
      const dist = Math.sqrt((v.x - cx) ** 2 + (v.y - cy) ** 2);
      expect(dist).toBeCloseTo(circumradius);
    }
  });

  it("r270_down_centroid_is_center", () => {
    const { x: cx, y: cy } = triCenter(1, 0, "r270");
    const verts = triVertices(1, 0, "r270");
    const avgX = (verts[0].x + verts[1].x + verts[2].x) / 3;
    const avgY = (verts[0].y + verts[1].y + verts[2].y) / 3;
    expect(avgX).toBeCloseTo(cx);
    expect(avgY).toBeCloseTo(cy);
  });
});

describe("adjacent triangles share edges", () => {
  it("adjacent_left_right_triangles_share_edge", () => {
    // up(0,0) Right neighbor = down(1,0)
    // Shared edge: up v[0]↔v[1] = down v[0]↔v[2]
    const upVerts = triVertices(0, 0, "r0");
    const downVerts = triVertices(1, 0, "r0");
    // up v[0] == down v[0]
    expect(upVerts[0].x).toBeCloseTo(downVerts[0].x);
    expect(upVerts[0].y).toBeCloseTo(downVerts[0].y);
    // up v[1] == down v[2]
    expect(upVerts[1].x).toBeCloseTo(downVerts[2].x);
    expect(upVerts[1].y).toBeCloseTo(downVerts[2].y);
  });

  it("adjacent_base_triangles_share_edge", () => {
    // Base(up(0,2)) = down(0,1)  [up.Base = row-1]
    // Shared edge: up v[1]↔v[2] = down v[0]↔v[1]
    const upVerts = triVertices(0, 2, "r0");
    const downVerts = triVertices(0, 1, "r0");
    // up v[1] == down v[1]
    expect(upVerts[1].x).toBeCloseTo(downVerts[1].x);
    expect(upVerts[1].y).toBeCloseTo(downVerts[1].y);
    // up v[2] == down v[0]
    expect(upVerts[2].x).toBeCloseTo(downVerts[0].x);
    expect(upVerts[2].y).toBeCloseTo(downVerts[0].y);
  });
});
