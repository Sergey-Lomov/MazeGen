import type { Zone, ZoneCellWire } from "../../wasm/mazeService";

/** How the zone being edited is combined with another zone (GitHub issue #1032). */
export type ZoneCombineOp = "union" | "intersection" | "subtraction";

export const ZONE_COMBINE_OPS: readonly ZoneCombineOp[] = ["union", "intersection", "subtraction"];

/** The combine tool in progress: the operation and the zone it is combined with (`null` until one is chosen). */
export interface ZoneCombine {
  op: ZoneCombineOp;
  otherId: number | null;
}

/** Cells that would be added to and removed from the zone, and the per-floor counts of both. */
export interface ZoneCombinePreview {
  added: ZoneCellWire[];
  removed: ZoneCellWire[];
  /** Ascending floor indices with at least one added or removed cell, each with its counts and the zone's cell count
   *  on that floor after the operation. */
  floors: { floor: number; added: number; removed: number; total: number }[];
}

const keyOf = ([floor, x, y]: ZoneCellWire) => `${floor},${x},${y}`;

/** Cells of `current` after combining it with `other`: union, intersection, or `current` minus `other`. Cells keep the
 *  order of `current`, and union appends the cells of `other` that are new. */
export function combineZoneCells(current: readonly ZoneCellWire[], other: readonly ZoneCellWire[], op: ZoneCombineOp): ZoneCellWire[] {
  const otherKeys = new Set(other.map(keyOf));
  switch (op) {
    case "union": {
      const own = new Set(current.map(keyOf));
      return [...current, ...other.filter((cell) => !own.has(keyOf(cell)))];
    }
    case "intersection":
      return current.filter((cell) => otherKeys.has(keyOf(cell)));
    case "subtraction":
      return current.filter((cell) => !otherKeys.has(keyOf(cell)));
  }
}

/** What combining changes: the cells gained and lost by `current`, on every floor. */
export function previewZoneCombine(current: Zone, other: Zone, op: ZoneCombineOp): ZoneCombinePreview {
  const result = combineZoneCells(current.cells, other.cells, op);
  const before = new Set(current.cells.map(keyOf));
  const after = new Set(result.map(keyOf));
  const added = result.filter((cell) => !before.has(keyOf(cell)));
  const removed = current.cells.filter((cell) => !after.has(keyOf(cell)));
  const perFloor = new Map<number, { added: number; removed: number }>();
  const entry = (floor: number) => {
    let counts = perFloor.get(floor);
    if (!counts) perFloor.set(floor, (counts = { added: 0, removed: 0 }));
    return counts;
  };
  for (const [floor] of added) entry(floor).added++;
  for (const [floor] of removed) entry(floor).removed++;
  const totals = new Map<number, number>();
  for (const [floor] of result) totals.set(floor, (totals.get(floor) ?? 0) + 1);
  const floors = [...perFloor.entries()].sort(([a], [b]) => a - b).map(([floor, counts]) => ({ floor, ...counts, total: totals.get(floor) ?? 0 }));
  return { added, removed, floors };
}
