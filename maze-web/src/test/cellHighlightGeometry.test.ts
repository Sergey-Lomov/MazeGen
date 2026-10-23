import { describe, expect, it, vi } from "vitest";
import type { Graphics } from "pixi.js";
import { drawCellHighlight, insetPolygon } from "../pixi/cellHighlightGeometry";

function fakeGraphics() {
  const fill = vi.fn();
  const stroke = vi.fn();
  const poly = vi.fn(() => ({ fill, stroke }));
  return { graphics: { poly } as unknown as Graphics, fill, stroke, poly };
}

describe("drawCellHighlight", () => {
  it("draws a border for a full-cell highlight without adding a fill", () => {
    const { graphics, fill, stroke } = fakeGraphics();

    drawCellHighlight(graphics, [
      { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 },
    ], 0xffaa44, 0, 0, "round", 3);

    expect(fill).toHaveBeenCalledWith({ color: 0xffaa44, alpha: 0 });
    expect(stroke).toHaveBeenCalledWith({ color: 0xffaa44, alpha: 1, width: 3 });
  });
});

describe("insetPolygon", () => {
  const square = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];

  it("moves every corner of a square inward by the inset", () => {
    expect(insetPolygon(square, 1)).toEqual([{ x: 1, y: 1 }, { x: 9, y: 1 }, { x: 9, y: 9 }, { x: 1, y: 9 }]);
  });

  it("insets a corner repeated in the vertex list like a single corner", () => {
    const repeated = [square[0], square[0], square[1], square[2], square[3]];
    expect(insetPolygon(repeated, 1)).toEqual(insetPolygon(square, 1));
  });
});
