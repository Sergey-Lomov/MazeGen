import { describe, it, expect } from "vitest";
import type { FieldConfig } from "../fieldConfig";
import { TILE_SIZE, VIEWPORT_FIT_PADDING } from "../pixi/constants";
import { fieldOf } from "./fieldConfigFixtures";


const { fitMazeViewport, fitBoundsViewport } = await import("../pixi/viewportFit");
const { fitFieldViewport } = await import("../pixi/FieldEditorOverlay");

const small: FieldConfig = fieldOf("square", { shape: "rect", cols: 2, rows: 2 });
const big: FieldConfig = fieldOf("square", { shape: "rect", cols: 6, rows: 2 });

describe("fitMazeViewport", () => {
  it("scales by the largest floor's own width/height, even when it's a different floor than the active one", () => {
    const nodes = [
      // level 0 (active): a small 2x2 patch
      { id: 0, x: 0, y: 0, level: 0 },
      { id: 1, x: 1, y: 1, level: 0 },
      // level 1: a wide 6-cell row — its width should drive the scale, not level 0's
      { id: 2, x: 0, y: 0, level: 1 },
      { id: 3, x: 5, y: 0, level: 1 },
    ];
    const withMax = fitMazeViewport([small, big], nodes, 0, 1000, 1000);
    const activeOnly = fitMazeViewport([small, small], nodes.filter(n => n.level === 0), 0, 1000, 1000);
    expect(withMax.scale).toBeLessThan(activeOnly.scale);
  });

  it("centers on the active floor's own bbox, not the union of all floors", () => {
    const nodes = [
      { id: 0, x: 10, y: 10, level: 0 },
      { id: 1, x: -10, y: -10, level: 1 },
    ];
    const result = fitMazeViewport([small, small], nodes, 0, 1000, 1000);
    // Active floor (level 0) has a single node whose world center is (10+0.5)*TILE_SIZE on X
    // (squareCenter's own half-tile offset) — screen center maps back to that, not the midpoint
    // with level 1's node.
    const worldX = (500 - result.x) / result.scale;
    const worldY = (500 - result.y) / result.scale;
    expect(worldX).toBeCloseTo(10.5 * TILE_SIZE, 0);
    expect(worldY).toBeCloseTo(-10.5 * TILE_SIZE, 0);
  });

  it("treats a node with no `level` field as level 0 (single-floor maze, GitHub issue #337)", () => {
    const nodes = [
      { id: 0, x: 0, y: 0 },
      { id: 1, x: 1, y: 1 },
    ];
    const withLevel = fitMazeViewport([small], [{ ...nodes[0], level: 0 }, { ...nodes[1], level: 0 }], 0, 1000, 1000);
    const withoutLevel = fitMazeViewport([small], nodes, 0, 1000, 1000);
    expect(withoutLevel).toEqual(withLevel);
  });

  it("falls back to scale 1, screen center for an empty node list", () => {
    const result = fitMazeViewport([small], [], 0, 800, 600);
    expect(result).toEqual({ x: 400, y: 300, scale: 1 });
  });

  it("still applies the other floors' max scale when the active floor itself has no nodes", () => {
    const nodes = [{ id: 0, x: 5, y: 0, level: 1 }];
    const result = fitMazeViewport([small, big], nodes, 0, 1000, 1000);
    expect(result.scale).toBeGreaterThan(0);
    expect(result.scale).not.toBe(1);
  });

  it("respects VIEWPORT_FIT_PADDING as the screen-fill ratio on the limiting axis", () => {
    const nodes = [
      { id: 0, x: 0, y: 0, level: 0 },
      { id: 1, x: 1, y: 1, level: 0 },
    ];
    const screenW = 1000, screenH = 1000;
    const result = fitMazeViewport([small], nodes, 0, screenW, screenH);
    const expectedScale = Math.min(
      VIEWPORT_FIT_PADDING * screenW / (TILE_SIZE * 3),
      VIEWPORT_FIT_PADDING * screenH / (TILE_SIZE * 3),
    );
    expect(result.scale).toBeCloseTo(expectedScale);
  });
});

describe("fitFieldViewport", () => {
  it("scales by the largest floor's own field size, even when it's a different floor than the active one", () => {
    const withMax = fitFieldViewport(small, [small, big], 1000, 1000);
    const activeOnly = fitFieldViewport(small, [small], 1000, 1000);
    expect(withMax.scale).toBeLessThan(activeOnly.scale);
  });

  it("centers on the active config's own bbox regardless of other floors' sizes", () => {
    const centered = fitFieldViewport(small, [small], 1000, 1000);
    const withBigSibling = fitFieldViewport(small, [small, big], 1000, 1000);
    // Both center on `small`'s own bbox center — only scale should differ.
    const worldXCentered = (500 - centered.x) / centered.scale;
    const worldXWithSibling = (500 - withBigSibling.x) / withBigSibling.scale;
    expect(worldXCentered).toBeCloseTo(worldXWithSibling, 5);
  });
});

describe("fitBoundsViewport", () => {
  it("centers the box on the screen and leaves the fit padding around it", () => {
    const box = { minX: 100, minY: 40, maxX: 300, maxY: 140 };
    const { x, y, scale } = fitBoundsViewport(box, 1000, 500);
    expect(scale).toBeCloseTo(Math.min(VIEWPORT_FIT_PADDING * 1000 / 200, VIEWPORT_FIT_PADDING * 500 / 100), 9);
    expect(x + scale * 200).toBeCloseTo(500, 9);
    expect(y + scale * 90).toBeCloseTo(250, 9);
  });

  it("falls back to the screen centre for an empty box", () => {
    expect(fitBoundsViewport({ minX: 0, minY: 0, maxX: 0, maxY: 0 }, 800, 600)).toEqual({ x: 400, y: 300, scale: 1 });
  });
});
