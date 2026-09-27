export type HexShapeOrientation = "flat_top" | "pointy_top";

const SQRT_3 = Math.sqrt(3);

function rotate(x: number, y: number, degrees: number): [number, number] {
  const angle = degrees * Math.PI / 180;
  return [x * Math.cos(angle) - y * Math.sin(angle), x * Math.sin(angle) + y * Math.cos(angle)];
}

function hexCenter(q: number, r: number, orientation: HexShapeOrientation): [number, number] {
  const x = 1.5 * q;
  const y = -(SQRT_3 * r + SQRT_3 / 2 * q);
  return orientation === "pointy_top" ? rotate(x, y, 30) : [x, y];
}

export function hexCircleRaw(radius: number, orientation: HexShapeOrientation = "flat_top"): [number, number][] {
  const cells: [number, number][] = [];
  const centerRadius = radius * 1.5;
  const limit = Math.ceil(radius * 2) + 1;
  for (let q = -limit; q <= limit; q++) {
    for (let r = -limit; r <= limit; r++) {
      const [x, y] = hexCenter(q, r, orientation);
      if (x * x + y * y <= centerRadius * centerRadius) cells.push([q, r]);
    }
  }
  return cells;
}

/** Returns hexagons whose complete footprint fits inside a centered rectangle.
 * `cols` and `rows` describe the rectangle in the tessellation's natural cell units. */
export function hexRectangleRaw(cols: number, rows: number, orientation: HexShapeOrientation = "flat_top"): [number, number][] {
  const halfWidth = (cols + 1) * 0.75;
  const halfHeight = (rows + 1) * SQRT_3 / 2;
  const cellHalfWidth = orientation === "pointy_top" ? SQRT_3 / 2 : 1;
  const cellHalfHeight = orientation === "pointy_top" ? 1 : SQRT_3 / 2;
  const cells: [number, number][] = [];
  const limit = Math.max(cols, rows) * 2 + 2;
  for (let q = -limit; q <= limit; q++) {
    for (let r = -limit; r <= limit; r++) {
      const [x, y] = hexCenter(q, r, orientation);
      if (Math.abs(x) + cellHalfWidth <= halfWidth && Math.abs(y) + cellHalfHeight <= halfHeight) {
        cells.push([q, r]);
      }
    }
  }
  return cells;
}
