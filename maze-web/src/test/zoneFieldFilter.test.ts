import { describe, it, expect } from "vitest";

import { filterZonesToField } from "../pixi/fieldValidity";
import type { ResolveFieldAt } from "../pixi/fieldEditUtils";
import type { Zone } from "../wasm/mazeService";
import { fieldOf } from "./fieldConfigFixtures";

// 3x3 square grid: cells (-1,-1)..(1,1); floors 0 and 1 exist.
const squareCfg = fieldOf("square", { shape: "rect", cols: 3, rows: 3 });
const resolveTwoFloors: ResolveFieldAt = (level) => ((level ?? 0) === 0 || level === 1 ? { cfg: squareCfg } : undefined);

const zone = (id: number, cells: Zone["cells"]): Zone => ({ id, name: `z${id}`, kind: "manual", cells });

describe("filterZonesToField", () => {
  it("keeps in-field cells and drops cells outside the field or on a missing floor", () => {
    const [filtered] = filterZonesToField(
      [zone(1, [[0, 0, 0], [0, 5, 5], [1, 1, 1], [2, 0, 0]])],
      resolveTwoFloors,
    );
    expect(filtered.cells).toEqual([[0, 0, 0], [1, 1, 1]]);
  });

  it("keeps ids, names, kinds and order, and keeps a zone left with no cells", () => {
    const zones = [zone(7, [[0, 9, 9]]), { ...zone(3, [[0, 0, 0]]), kind: "auto" as const }];
    const filtered = filterZonesToField(zones, resolveTwoFloors);
    expect(filtered.map((z) => [z.id, z.name, z.kind, z.cells.length])).toEqual([
      [7, "z7", "manual", 0],
      [3, "z3", "auto", 1],
    ]);
  });

  it("does not mutate its input", () => {
    const input = [zone(1, [[0, 9, 9], [0, 0, 0]])];
    filterZonesToField(input, resolveTwoFloors);
    expect(input[0].cells).toHaveLength(2);
  });
});
