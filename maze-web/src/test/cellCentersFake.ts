import type { TessellationKind } from "../store/tessellationTypes";

/** Stand-in for `getCellCenters` (wasm `cell_centers`) in suites that mock `mazeService`: the
 *  same world-unit centers `maze-core`'s built-in tessellations produce (area-1 cells, math Y-up),
 *  so pixel-position assertions stay meaningful. The real wasm answer is covered by `maze-core`'s
 *  geometry tests. Cairo is drawn from its own TS geometry (not from these centers), so any
 *  deterministic value serves there. */
export function fakeCellCenter(x: number, y: number, kind: TessellationKind | string): [number, number] {
  if (kind === "square") return [x + 0.5, y + 0.5];
  if (kind === "hex") {
    const side = Math.sqrt(2 / (3 * Math.sqrt(3)));
    return [x * 1.5 * side, -(y * Math.sqrt(3) + x * Math.sqrt(3) / 2) * side];
  }
  if (kind === "tri") {
    const s = 2 / Math.sqrt(Math.sqrt(3));
    const h = (s * Math.sqrt(3)) / 2;
    const pointingUp = (((x + y) % 2) + 2) % 2 === 0;
    return [(x * s) / 2 + s / 4, pointingUp ? -(y * h + h / 3) : -(y * h + (2 * h) / 3)];
  }
  return [x, y];
}

export function fakeCellCenters(config: { tessellation: { kind: string }; points: [number, number][] }): [number, number][] {
  return config.points.map(([x, y]) => fakeCellCenter(x, y, config.tessellation.kind));
}
