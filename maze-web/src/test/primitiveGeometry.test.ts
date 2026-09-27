import { describe, expect, it } from "vitest";
import { primitiveCells } from "../pixi/primitiveGeometry";
import { configAllCells } from "../pixi/tessellationCells";

describe("field shape primitives", () => {
  const gesture = {
    startGrid: { x: 0, y: 0 },
    endGrid: { x: 3, y: 2 },
    gridRadius: 2,
    kind: "square" as const,
  };

  it("draws a square circle as a disk", () => {
    const cells = primitiveCells("square_circle", gesture);
    expect(cells).toHaveLength(9);
    expect(cells).toContainEqual([0, 0]);
    expect(cells).not.toContainEqual([2, 2]);
  });

  it("draws hex rectangle and circle primitives", () => {
    expect(primitiveCells("hex_rectangle", gesture)).toHaveLength(11);
    expect(primitiveCells("hex_circle", gesture)).toHaveLength(13);
  });

  it("draws a triangular circle around the gesture origin", () => {
    const cells = primitiveCells("tri_circle", { ...gesture, kind: "triangle" });
    expect(cells.length).toBeGreaterThan(1);
    expect(cells).toContainEqual([0, 0]);
  });

  it("keeps predefined circle and rectangle shapes geometrically distinct", () => {
    const squareCircle = configAllCells({ type: "square_circle", radius: 5 });
    const hexCircle = configAllCells({ type: "hex_circle", radius: 2 });
    const hexagon = configAllCells({ type: "hex_hexagon", radius: 2 });
    const hexRectangle = configAllCells({ type: "hex_rectangle", cols: 4, rows: 4 });
    const parallelogram = configAllCells({ type: "hex_parallelogram", cols: 4, rows: 4 });

    expect(squareCircle).not.toContainEqual([5, 0]);
    expect(hexCircle.length).toBeLessThan(hexagon.length);
    expect(hexRectangle.length).toBeLessThan(parallelogram.length);
  });
});
