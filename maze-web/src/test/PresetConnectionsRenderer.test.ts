import { describe, it, expect, vi } from "vitest";
import { presetEndpoint } from "../pixi/presetEndpoint";
import { makeProjection } from "../pixi/tessellationProjection";
import type { PresetTeleportEntry, PresetVerticalPassageEntry, PresetElevatorEntry } from "../pixi/fieldEditUtils";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";

vi.mock("pixi.js", () => ({
  Container: vi.fn(() => ({ addChild: vi.fn(), destroy: vi.fn() })),
  Graphics: vi.fn(() => ({ rect: vi.fn(), fill: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), poly: vi.fn() })),
}));

vi.mock("../store/mazeStore", () => ({
  useMazeStore: { getState: vi.fn(() => ({})), subscribe: vi.fn(() => () => {}) },
}));

// getCellCenter (via squareGeometry's getCartesian) delegates to wasm, unavailable in this
// unit-test environment -- mock with the canonical square formula (see
// `maze-core/src/space/square.rs`'s `cartesian`: `(x, y)`, no offset/flip applied here).
vi.mock("../wasm/mazeService", () => ({
  getCartesianCoords: (cfg: { points: [number, number][] }) => cfg.points.map(([x, y]) => [x, y]),
}));

const { buildPresetTeleportEdges, buildPresetVerticalMarkers } = await import("../pixi/PresetConnectionsRenderer");

const cfg: TessellationConfig = { type: "square", width: 4, height: 4 };
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
});
