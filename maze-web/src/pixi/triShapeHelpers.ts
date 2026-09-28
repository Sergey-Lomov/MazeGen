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

export function triCenterOffset(raw: [number, number][]): { ox: number; oy: number } {
  const cols = raw.map(c => c[0]);
  const rows = raw.map(c => c[1]);
  let ox = Math.round((Math.min(...cols) + Math.max(...cols)) / 2);
  let oy = Math.round((Math.min(...rows) + Math.max(...rows)) / 2);
  if ((ox + oy) % 2 !== 0) oy = Math.max(0, oy - 1);
  return { ox, oy };
}
