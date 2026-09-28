import { describe, it, expect } from "vitest";
import { Container, Graphics } from "pixi.js";
import { fitTileToWorld, clipToTile, expandConvexPolygon } from "../pixi/tilePreviewFit";
import { WALL_THICKNESS } from "../pixi/renderConstants";

describe("fitTileToWorld", () => {
  it("scales a square tile's vertex bbox to fill the canvas", () => {
    const world = new Container();
    // 40x40 square tile centered at origin, plus its center (no extra margin beyond `pad`).
    const verts = [{ x: -20, y: -20 }, { x: 20, y: -20 }, { x: 20, y: 20 }, { x: -20, y: 20 }];
    const center = { x: 0, y: 0 };
    const scale = fitTileToWorld(world, verts, center, 100, 0);

    // bbox is 40x40, canvas is 100x100 -> scale 2.5.
    expect(scale).toBeCloseTo(2.5);
    expect(world.scale.x).toBeCloseTo(2.5);
    expect(world.scale.y).toBeCloseTo(2.5);
    // Tile's own center (0,0) must land at the canvas center (50,50).
    expect(world.position.x).toBeCloseTo(50);
    expect(world.position.y).toBeCloseTo(50);
  });

  it("shrinks scale to fit the larger bbox dimension when the tile isn't square", () => {
    const world = new Container();
    // 40 wide x 20 tall bbox — the wider dimension must drive the scale, or the tile would
    // overflow the canvas horizontally.
    const verts = [{ x: -20, y: -10 }, { x: 20, y: -10 }, { x: 20, y: 10 }, { x: -20, y: 10 }];
    const center = { x: 0, y: 0 };
    const scale = fitTileToWorld(world, verts, center, 100, 0);

    expect(scale).toBeCloseTo(2.5);
  });

  it("accounts for `pad` when computing the fit scale", () => {
    const world = new Container();
    const verts = [{ x: -10, y: -10 }, { x: 10, y: -10 }, { x: 10, y: 10 }, { x: -10, y: 10 }];
    const center = { x: 0, y: 0 };
    // bbox is 20x20; +5 pad on each side -> 30x30 effective size -> scale 100/30.
    const scale = fitTileToWorld(world, verts, center, 100, 5);

    expect(scale).toBeCloseTo(100 / 30);
  });

  it("includes `center` in the bbox, so an off-center hub point still fits", () => {
    const world = new Container();
    // Vertices alone would give a tiny bbox; `center` far outside them must still be included.
    const verts = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
    const center = { x: 50, y: 50 };
    const scale = fitTileToWorld(world, verts, center, 100, 0);

    // bbox becomes 50x50 (0..50 on both axes) -> scale 2.
    expect(scale).toBeCloseTo(2);
  });
});

describe("expandConvexPolygon", () => {
  it("expands an axis-aligned (counter-clockwise) square's corners by exactly half a wall stroke (GitHub issue #632)", () => {
    const verts = [{ x: -10, y: -10 }, { x: 10, y: -10 }, { x: 10, y: 10 }, { x: -10, y: 10 }];
    const expanded = expandConvexPolygon(verts, WALL_THICKNESS / 2);

    const expected = 10 + WALL_THICKNESS / 2;
    for (const v of expanded) {
      expect(Math.abs(v.x)).toBeCloseTo(expected);
      expect(Math.abs(v.y)).toBeCloseTo(expected);
    }
  });

  it("expands outward for a clockwise-wound polygon too (GitHub issue #632 follow-up — hex winds opposite to square/tri)", () => {
    // Same square as above but vertices listed in reverse (clockwise) order — must still expand
    // OUTWARD, not inward, regardless of winding direction.
    const verts = [{ x: -10, y: -10 }, { x: -10, y: 10 }, { x: 10, y: 10 }, { x: 10, y: -10 }];
    const expanded = expandConvexPolygon(verts, WALL_THICKNESS / 2);

    const expected = 10 + WALL_THICKNESS / 2;
    for (const v of expanded) {
      expect(Math.abs(v.x)).toBeCloseTo(expected);
      expect(Math.abs(v.y)).toBeCloseTo(expected);
    }
  });

  it("expands a regular hexagon's edges outward by exactly `dist` (non-right-angle vertices exercise the cosHalf scale correction)", () => {
    // Regular hexagon, circumradius 10, centered at origin — every interior angle is 120°, so the
    // averaged-normal length at each vertex is cos(30°), a non-trivial scale-correction case that
    // an axis-aligned square (90° angles) never exercises.
    const R = 10;
    const dist = WALL_THICKNESS / 2;
    const verts = Array.from({ length: 6 }, (_, i) => {
      const a = (Math.PI / 3) * i;
      return { x: R * Math.cos(a), y: R * Math.sin(a) };
    });
    const expanded = expandConvexPolygon(verts, dist);

    // Each expanded vertex must sit at distance R / cos(30°) + ... from center — i.e. the
    // polygon's *edges* (apothem), not just its vertices, shift outward by exactly `dist`.
    const expectedDist = R + dist / Math.cos(Math.PI / 6);
    for (const v of expanded) {
      expect(Math.hypot(v.x, v.y)).toBeCloseTo(expectedDist, 4);
    }
  });
});

describe("clipToTile", () => {
  it("masks `content` to a Graphics shape when verts is non-empty", () => {
    const content = new Container();
    const verts = [{ x: -10, y: -10 }, { x: 10, y: -10 }, { x: 10, y: 10 }, { x: -10, y: 10 }];
    clipToTile(content, verts);

    expect(content.mask).toBeInstanceOf(Graphics);
    // The mask graphic is added as a child so it participates in the scene's own transform.
    expect(content.children).toContain(content.mask);
  });

  it("is a no-op when verts is empty", () => {
    const content = new Container();
    clipToTile(content, []);

    expect(content.mask).toBeUndefined();
    expect(content.children).toHaveLength(0);
  });
});
