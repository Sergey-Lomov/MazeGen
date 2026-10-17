import { describe, it, expect, vi } from "vitest";
import { presetEndpoint } from "../pixi/presetEndpoint";
import { makeProjection } from "../pixi/tessellationProjection";
import type { PresetTeleportEntry, PresetVerticalPassageEntry, PresetElevatorEntry } from "../pixi/fieldEditUtils";
import type { FieldConfig } from "../fieldConfig";
import { fieldOf } from "./fieldConfigFixtures";

vi.mock("pixi.js", () => ({
  Container: vi.fn(() => ({ addChild: vi.fn(), destroy: vi.fn() })),
  Graphics: vi.fn(() => ({ rect: vi.fn(), fill: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), poly: vi.fn() })),
}));

vi.mock("../store/mazeStore", () => ({
  useMazeStore: { getState: vi.fn(() => ({})), subscribe: vi.fn(() => () => {}) },
}));

// getCellCenter (via cartesianCache's getCartesian) delegates to wasm, unavailable in this
// unit-test environment -- mock with the canonical square formula (see
// `maze-core/src/space/square.rs`'s `cartesian`: `(x, y)`, no offset/flip applied here).
vi.mock("../wasm/mazeService", async (importActual) => ({
  getFieldPreset: (await importActual<typeof import("../wasm/mazeService")>()).getFieldPreset,
  getGeometrySnapshot: (await importActual<typeof import("../wasm/mazeService")>()).getGeometrySnapshot,
  getCellAt: (await importActual<typeof import("../wasm/mazeService")>()).getCellAt,
  getCellsInRegion: (await importActual<typeof import("../wasm/mazeService")>()).getCellsInRegion,
}));

const { buildPresetTeleportEdges, buildPresetVerticalMarkers, buildPresetTeleportBadgeBlockedCells } = await import("../pixi/PresetConnectionsRenderer");

const cfg: FieldConfig = fieldOf("square", { shape: "rect", cols: 4, rows: 4 });
const proj = makeProjection(cfg);
const posOf = (x: number, y: number) => {
  const { x: px, y: py } = proj.gridToScreen(x, y);
  return [px, py] as [number, number];
};

describe("buildPresetTeleportEdges", () => {
  it("same-floor two_way teleport draws from -> to with no floor badge", () => {
    const teleports: PresetTeleportEntry[] = [
      { id: 1, from: presetEndpoint([0, 0]), to: presetEndpoint([1, 1]), direction: "two_way" },
    ];
    const result = buildPresetTeleportEdges(teleports, cfg, undefined);
    expect(result).toHaveLength(1);
    expect(result[0].from).toEqual(posOf(0, 0));
    expect(result[0].to).toEqual(posOf(1, 1));
    expect(result[0].oneWay).toBe(false);
    expect(result[0].toFloor).toBeUndefined();
    expect(result[0].fromFloor).toBeUndefined();
  });

  it("same-floor backward one-way teleport swaps from/to so from is the departure end", () => {
    const teleports: PresetTeleportEntry[] = [
      { id: 1, from: presetEndpoint([0, 0]), to: presetEndpoint([1, 1]), direction: "backward" },
    ];
    const result = buildPresetTeleportEdges(teleports, cfg, undefined);
    // "backward" means the passage actually runs to -> from, so the departure end (`from` of the
    // returned edge) must be the click-order `to`, not the click-order `from`.
    expect(result[0].from).toEqual(posOf(1, 1));
    expect(result[0].to).toEqual(posOf(0, 0));
    expect(result[0].oneWay).toBe(true);
  });

  it("cross-floor one-way teleport: on-floor departure end draws as `from`, badge as `to` with toFloor set", () => {
    const teleports: PresetTeleportEntry[] = [
      { id: 1, from: presetEndpoint([0, 0]), to: presetEndpoint([4, 4], undefined, 1), direction: "forward" },
    ];
    // Active floor 0: `from` (departure) is on-floor, `to` (arrival) is on floor 1.
    const result = buildPresetTeleportEdges(teleports, cfg, undefined);
    expect(result).toHaveLength(1);
    expect(result[0].from).toEqual(posOf(0, 0));
    expect(result[0].toFloor).toBe(1);
    expect(result[0].fromFloor).toBeUndefined();
    // The badge (`to`) must not collapse onto the real on-floor point.
    expect(result[0].to).not.toEqual(result[0].from);
  });

  it("cross-floor one-way teleport: on-floor arrival end draws as `to`, badge as `from` with fromFloor set", () => {
    const teleports: PresetTeleportEntry[] = [
      { id: 1, from: presetEndpoint([0, 0]), to: presetEndpoint([4, 4], undefined, 1), direction: "forward" },
    ];
    // Active floor 1: `to` (arrival) is on-floor, `from` (departure) is on floor 0 — the real
    // on-floor marker must be the arrival end (`to`), matching the arrow's from->to = departure->
    // arrival convention, with the departure's badge occupying `from`.
    const result = buildPresetTeleportEdges(teleports, cfg, 1);
    expect(result).toHaveLength(1);
    expect(result[0].to).toEqual(posOf(4, 4));
    expect(result[0].fromFloor).toBe(0);
    expect(result[0].toFloor).toBeUndefined();
    expect(result[0].from).not.toEqual(result[0].to);
  });

  it("cross-floor badge is relocated off a start marker and lands in the same cell whichever floor is rendered (GitHub issue #480)", () => {
    // Teleport 0@(0,0)L0 <-> 0@(0,2)L1: badge midpoint snaps to (0,1). A start marker sits on (0,1)
    // on floor 0 -> the badge must move, and to the same cell seen from floor 0 and from floor 1.
    const teleports: PresetTeleportEntry[] = [
      { id: 7, from: presetEndpoint([0, 0]), to: presetEndpoint([0, 2], undefined, 1), direction: "two_way" },
    ];
    const blocked = new Map<number, [number, number][]>([[0, [[0, 1]]]]);
    const spread = { allTeleports: teleports, blockedCellsByFloor: blocked, allowOutOfField: true };
    const f0 = buildPresetTeleportEdges(teleports, cfg, 0, new Map(), spread);
    const f1 = buildPresetTeleportEdges(teleports, cfg, 1, new Map(), spread);
    const badge0 = f0[0].toFloor !== undefined ? f0[0].to : f0[0].from;
    const badge1 = f1[0].fromFloor !== undefined ? f1[0].from : f1[0].to;
    expect(badge0).not.toEqual(posOf(0, 1)); // moved off the start cell
    expect(badge0).toEqual(badge1);          // same cell whichever floor
  });

  it("a same-floor teleport mixed into the spread's allTeleports list is ignored (no pair, no shift)", () => {
    const teleports: PresetTeleportEntry[] = [
      { id: 3, from: presetEndpoint([0, 0]), to: presetEndpoint([2, 2]), direction: "two_way" }, // same-floor
      { id: 7, from: presetEndpoint([0, 0]), to: presetEndpoint([0, 2], undefined, 1), direction: "two_way" }, // cross-floor
    ];
    const spread = { allTeleports: teleports, blockedCellsByFloor: new Map<number, [number, number][]>(), allowOutOfField: true };
    const result = buildPresetTeleportEdges(teleports, cfg, 0, new Map(), spread);
    // Same-floor entry untouched (both endpoints at their real cells, no badge).
    expect(result[0].from).toEqual(posOf(0, 0));
    expect(result[0].to).toEqual(posOf(2, 2));
    expect(result[0].toFloor).toBeUndefined();
    // Cross-floor entry still got its badge (snapped midpoint of (0,0)/(0,2) = (0,1)).
    expect(result[1].toFloor).toBe(1);
    expect(result[1].to).toEqual(posOf(0, 1));
  });

  it("split-node endpoint draws at its supplied node-anchor position, not the tile center (GitHub issue #474)", () => {
    const teleports: PresetTeleportEntry[] = [
      { id: 1, from: presetEndpoint([1, 1], 0), to: presetEndpoint([3, 3]), direction: "two_way" },
    ];
    // A caller-supplied anchor for the split endpoint — offset from the tile center on purpose.
    const anchor = { x: proj.gridToScreen(1, 1).x + 7, y: proj.gridToScreen(1, 1).y - 3 };
    const nodePositions = new Map([["1,1:0", anchor]]);
    const result = buildPresetTeleportEdges(teleports, cfg, undefined, nodePositions);
    expect(result[0].from).toEqual([anchor.x, anchor.y]);
    expect(result[0].from).not.toEqual(posOf(1, 1));
    expect(result[0].to).toEqual(posOf(3, 3));
  });
});

describe("buildPresetVerticalMarkers", () => {
  it("two-way vertical passage draws a filled marker on the active floor's own endpoint", () => {
    const passages: PresetVerticalPassageEntry[] = [
      { id: 1, from: presetEndpoint([0, 0]), to: presetEndpoint([0, 0], undefined, 1), direction: "two_way" },
    ];
    const result = buildPresetVerticalMarkers(passages, [], cfg, undefined);
    expect(result).toHaveLength(1);
    expect(result[0].filled).toBe(true);
    expect(result[0].arrowFilled).toBe(true);
    expect(result[0].direction).toBe("up");
    expect(result[0].targetFloorIndex).toBe(1);
  });

  it("one-way forward vertical passage: departure floor (from) draws empty marker with solid arrow", () => {
    const passages: PresetVerticalPassageEntry[] = [
      { id: 1, from: presetEndpoint([0, 0]), to: presetEndpoint([0, 0], undefined, 1), direction: "forward" },
    ];
    const result = buildPresetVerticalMarkers(passages, [], cfg, undefined);
    expect(result).toHaveLength(1);
    expect(result[0].filled).toBe(false);
    expect(result[0].arrowFilled).toBe(true);
  });

  it("one-way forward vertical passage: arrival floor (to) draws empty marker with outline arrow", () => {
    const passages: PresetVerticalPassageEntry[] = [
      { id: 1, from: presetEndpoint([0, 0]), to: presetEndpoint([0, 0], undefined, 1), direction: "forward" },
    ];
    const result = buildPresetVerticalMarkers(passages, [], cfg, 1);
    expect(result).toHaveLength(1);
    expect(result[0].filled).toBe(false);
    expect(result[0].arrowFilled).toBe(false);
    expect(result[0].direction).toBe("down");
  });

  it("elevator reaching floors both above and below the active floor gets direction 'both'", () => {
    const elevators: PresetElevatorEntry[] = [
      {
        id: 1,
        floors: [presetEndpoint([0, 0], undefined, 1), presetEndpoint([0, 0]), presetEndpoint([0, 0], undefined, 2)],
      },
    ];
    const result = buildPresetVerticalMarkers([], elevators, cfg, 1);
    expect(result).toHaveLength(1);
    expect(result[0].direction).toBe("both");
    expect(result[0].filled).toBe(true);
  });

  it("elevator not reaching the active floor at all produces no marker", () => {
    const elevators: PresetElevatorEntry[] = [
      { id: 1, floors: [presetEndpoint([0, 0]), presetEndpoint([0, 0], undefined, 1)] },
    ];
    const result = buildPresetVerticalMarkers([], elevators, cfg, 2);
    expect(result).toHaveLength(0);
  });

  it("split-node endpoint draws at its supplied node-anchor position, not the tile center (GitHub issue #474)", () => {
    const anchor = { x: proj.gridToScreen(0, 0).x + 5, y: proj.gridToScreen(0, 0).y - 8 };
    const nodePositions = new Map([["0,0:0", anchor]]);

    const passages: PresetVerticalPassageEntry[] = [
      { id: 1, from: presetEndpoint([0, 0], 0), to: presetEndpoint([0, 0], undefined, 1), direction: "two_way" },
    ];
    const passageResult = buildPresetVerticalMarkers(passages, [], cfg, undefined, nodePositions);
    expect(passageResult[0].pos).toEqual([anchor.x, anchor.y]);
    expect(passageResult[0].pos).not.toEqual(posOf(0, 0));

    const elevators: PresetElevatorEntry[] = [
      { id: 1, floors: [presetEndpoint([0, 0], 0), presetEndpoint([0, 0], undefined, 1)] },
    ];
    const elevatorResult = buildPresetVerticalMarkers([], elevators, cfg, undefined, nodePositions);
    expect(elevatorResult[0].pos).toEqual([anchor.x, anchor.y]);
  });
});

describe("buildPresetTeleportBadgeBlockedCells (GitHub issue #480)", () => {
  const cells = (m: Map<number, [number, number][]>, level: number) =>
    (m.get(level) ?? []).map(([x, y]) => `${x},${y}`).sort();

  it("collects start/finish, split points, vertical passages, elevators and teleport endpoints, keyed per floor", () => {
    const start = presetEndpoint([0, 0]); // level 0
    const finish = presetEndpoint([9, 9], undefined, 1); // level 1
    const splitByLevel = new Map<number, [number, number][]>([
      [0, [[1, 1]]],
      [2, [[3, 3]]],
    ]);
    const verticalPassages: PresetVerticalPassageEntry[] = [
      { id: 1, from: presetEndpoint([4, 4]), to: presetEndpoint([4, 4], undefined, 1), direction: "two_way" },
    ];
    const elevators: PresetElevatorEntry[] = [
      { id: 1, floors: [presetEndpoint([5, 5]), presetEndpoint([5, 5], undefined, 1), presetEndpoint([5, 5], undefined, 2)] },
    ];
    const teleports: PresetTeleportEntry[] = [
      { id: 1, from: presetEndpoint([6, 6]), to: presetEndpoint([7, 7], undefined, 1), direction: "two_way" },
    ];

    const m = buildPresetTeleportBadgeBlockedCells(start, finish, splitByLevel, verticalPassages, elevators, teleports);

    expect(cells(m, 0)).toEqual(["0,0", "1,1", "4,4", "5,5", "6,6"].sort());
    expect(cells(m, 1)).toEqual(["4,4", "5,5", "7,7", "9,9"].sort());
    expect(cells(m, 2)).toEqual(["3,3", "5,5"].sort());
  });

  it("null start/finish contribute nothing", () => {
    const m = buildPresetTeleportBadgeBlockedCells(null, null, new Map(), [], [], []);
    expect(m.size).toBe(0);
  });
});
