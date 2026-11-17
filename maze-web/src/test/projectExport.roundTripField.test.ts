import { describe, it, expect } from "vitest";
import { parseAndValidate, serializeProject } from "../store/projectExport";
import { fieldOf } from "./fieldConfigFixtures";
import { makeState, reparse, toJson } from "./projectExportKit";

describe("serializeProject / parseAndValidate round-trip: tessellation and field", () => {
  it("round-trips a default state", () => {
    const state = makeState();
    const serialized = serializeProject(state);
    const reparsed = parseAndValidate(JSON.parse(JSON.stringify(serialized)));
    expect(reparsed).toEqual(serialized);
  });

  it("rejects an unknown tessellation kind", () => {
    const raw = toJson(makeState());
    raw.tessellation.kind = "octagonal";

    expect(() => parseAndValidate(raw)).toThrow("Invalid tessellation kind at tessellation.kind: octagonal");
  });

  it("rejects a missing tessellation kind", () => {
    const raw = toJson(makeState());
    delete raw.tessellation.kind;

    expect(() => parseAndValidate(raw)).toThrow("Expected string at tessellation.kind, got undefined");
  });

  it("rejects a non-string tessellation kind", () => {
    const raw = toJson(makeState());
    raw.tessellation.kind = 42;

    expect(() => parseAndValidate(raw)).toThrow("Expected string at tessellation.kind, got number");
  });

  it.each([
    "cairo", "square_octagon", "brick", "trihexagonal", "snub_hexagonal", "rhombitrihexagonal",
    "truncated_trihexagonal", "snub_square", "curved_quadrilateral",
  ] as const)("round-trips the %s kind and its negative custom coordinates", (kind) => {
    const points: [number, number][] = [[-3, 2], [2, 1], [-1, -1]];
    const keys = new Set(points.map(([x, y]) => (x << 16) | (y & 0xffff)));
    const state = makeState();
    state.tessellationKind = kind;
    state.floorFields.floor_1 = {
      ...state.floorFields.floor_1,
      selectedShape: "rect",
      fieldConfig: fieldOf(kind, { shape: "custom", points }),
      freeFieldPoints: { ...state.floorFields.floor_1.freeFieldPoints, [kind]: keys },
      isEditingField: true,
      fieldPoints: new Set(keys),
      fieldEditMode: "custom",
    };
    const serialized = serializeProject(state);
    const reparsed = reparse(state);
    expect(reparsed.tessellation.kind).toBe(kind);
    expect(reparsed.floorFields.floor_1).toEqual(serialized.floorFields.floor_1);
  });

  it("round-trips the radial kind with its size param", () => {
    const state = makeState();
    state.tessellationKind = "radial";
    state.tessellationParams = { first_ring_cells: 12, ring_layout: "smooth", max_cells: 3000 };
    state.floorFields.floor_1 = {
      ...state.floorFields.floor_1,
      selectedShape: "circle",
      fieldConfig: { tessellation: { kind: "radial", params: state.tessellationParams }, shape: { shape: "circle", radius: 4 } },
    };
    const serialized = serializeProject(state);
    const reparsed = parseAndValidate(JSON.parse(JSON.stringify(serialized)));
    expect(reparsed.tessellation.params).toEqual(state.tessellationParams);
    expect(reparsed).toEqual(serialized);
  });

  it("rejects radial params that are missing, fractional or out of range", () => {
    const raw = () => {
      const state = makeState();
      state.tessellationKind = "radial";
      state.tessellationParams = { first_ring_cells: 9, ring_layout: "classic", max_cells: 3000 };
      state.floorFields.floor_1 = {
        ...state.floorFields.floor_1,
        selectedShape: "circle",
        fieldConfig: { tessellation: { kind: "radial", params: state.tessellationParams }, shape: { shape: "circle", radius: 4 } },
      };
      return toJson(state);
    };
    for (const [patch, message] of [
      [{ first_ring_cells: 5 }, /params\.first_ring_cells/],
      [{ first_ring_cells: 25 }, /params\.first_ring_cells/],
      [{ first_ring_cells: 7.5 }, /params\.first_ring_cells/],
      [{ first_ring_cells: undefined }, /params\.first_ring_cells/],
      [{ ring_layout: "spiral" }, /params\.ring_layout/],
      [{ ring_layout: undefined }, /params\.ring_layout/],
      [{ max_cells: 99 }, /params\.max_cells/],
      [{ max_cells: 10001 }, /params\.max_cells/],
      [{ max_cells: undefined }, /params\.max_cells/],
      [{ growth_factor: 2 }, /does not accept param "growth_factor"/],
      [{ extra: 1 }, /does not accept param "extra"/],
    ] as const) {
      const data = raw();
      data.tessellation.params = { ...data.tessellation.params, ...patch };
      expect(() => parseAndValidate(data)).toThrow(message);
    }
  });

  it("loads legacy floor fields that do not have Cairo free points", () => {
    const raw = toJson(makeState());
    delete raw.floorFields.floor_1.freeFieldPoints.cairo;
    const reparsed = parseAndValidate(raw);
    expect(reparsed.floorFields.floor_1.freeFieldPoints.cairo).toEqual([]);
  });
});
