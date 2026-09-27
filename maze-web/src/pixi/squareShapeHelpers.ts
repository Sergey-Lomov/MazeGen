export function squareCircleRaw(radius: number): [number, number][] {
  const cells: [number, number][] = [];
  for (let x = -radius; x <= radius; x++) {
    for (let y = -radius; y <= radius; y++) {
      if (x * x + y * y < radius * radius) cells.push([x, y]);
    }
  }
  return cells;
}

export function squareTriangleRaw(side: number): [number, number][] {
  const ox = Math.floor(side / 2);
  const oy = Math.floor(side / 2);
  const cells: [number, number][] = [];
  for (let y = 0; y < side; y++) {
    for (let x = 0; x <= y; x++) cells.push([x - ox, y - oy]);
  }
  return cells;
}
