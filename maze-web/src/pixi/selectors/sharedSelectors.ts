export function buildCellSet(cells: [number, number][]): Set<string> {
  return new Set(cells.map(([x, y]) => `${x},${y}`));
}
