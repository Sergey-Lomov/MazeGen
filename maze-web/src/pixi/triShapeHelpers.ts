export function triTriangleRaw(n: number): [number, number][] {
  const shift = n % 2;
  const cells: [number, number][] = [];
  for (let row = 0; row < n; row++) {
    const indent = n - 1 - row + shift;
    for (let col = indent; col <= indent + 2 * row; col++)
      cells.push([col, row]);
  }
  return cells;
}

export function triHexagonRaw(r: number): [number, number][] {
  const odd_base = r % 2 === 0 ? r - 1 : r;
  const cells: [number, number][] = [];
  for (let row = 0; row < 2 * r; row++) {
    const k = Math.min(row, 2 * r - 1 - row);
    const indent = odd_base - k;
    const width = 2 * (k + r) + 1;
    for (let col = indent; col < indent + width; col++)
      cells.push([col, row]);
  }
  return cells;
}

/** Returns the triangular-grid cells whose centers lie inside a circle of the requested radius.
 * The radius uses the same unit as square/hex field radii: one unit is one TILE_SIZE in the
 * canonical projection. Keeping the distance test here gives the predefined field and the
 * matching custom-mode brush exactly the same cell set. */
export function triCircleRaw(radius: number): [number, number][] {
  const height = Math.sqrt(3) / 2;
  const centerX = 0.25;
  const centerY = -height / 3;
  const limit = Math.ceil(radius / height) + 2;
  const cells: [number, number][] = [];
  for (let row = -limit; row <= limit; row++) {
    for (let col = -2 * limit; col <= 2 * limit; col++) {
      const pointingUp = (col + row) % 2 === 0;
      const x = col / 2 + 0.25;
      const y = -(row * height + (pointingUp ? height / 3 : 2 * height / 3));
      if (Math.hypot(x - centerX, y - centerY) <= radius) cells.push([col, row]);
    }
  }
  return cells;
}

export function triCenterOffset(raw: [number, number][]): { ox: number; oy: number } {
  const cols = raw.map(c => c[0]);
  const rows = raw.map(c => c[1]);
  let ox = Math.round((Math.min(...cols) + Math.max(...cols)) / 2);
  let oy = Math.round((Math.min(...rows) + Math.max(...rows)) / 2);
  if ((ox + oy) % 2 !== 0) oy = Math.max(0, oy - 1);
  return { ox, oy };
}
