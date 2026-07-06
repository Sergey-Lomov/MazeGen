import { describe, it, expect, vi } from "vitest";
import type { PresetConnectionEntry } from "../pixi/fieldEditUtils";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";

// getCellCenter (via squareGeometry's getCartesian) delegates to wasm, unavailable in this
// unit-test environment -- mock it with the canonical square formula (see
// `maze-core/src/space/square.rs`'s `cartesian`: `(x, y)`, no offset/flip -- those are applied
// by `squareGeometry.ts` itself, not this mock).
vi.mock("../wasm/mazeService", () => ({
  getCartesianCoords: (cfg: { points: [number, number][] }) => cfg.points.map(([x, y]) => [x, y]),
}));

const { buildPresetWallGroups } = await import("../pixi/selectors/presetSelectors");

// width=2, height=1 centers cells at x=-1 and x=0 (see configAllCells offset math)
const cfg: TessellationConfig = { type: "square", width: 2, height: 1 };
const cells: [number, number][] = [[-1, 0], [0, 0]];

function connEntry(
  from: [number, number],
  to: [number, number],
  state: PresetConnectionEntry["state"],
): PresetConnectionEntry {
  return { from, to, state, source: "user" };
}

describe("buildPresetWallGroups", () => {
  it("renders an interior edge with no entry as undecided exactly once (not once per side)", () => {
    const { undecided, preset } = buildPresetWallGroups(cells, new Map(), cfg);
    expect(undecided).toHaveLength(1);
    expect(undecided[0].style).toBe("faint");
    expect(preset.some(e => e.kind !== "none")).toBe(false);
  });

  it("renders an interior wall entry as a solid preset wall", () => {
    const connections = new Map([["-1,0-0,0", connEntry([-1, 0], [0, 0], "wall")]]);
    const { preset, undecided } = buildPresetWallGroups(cells, connections, cfg);
    expect(undecided).toHaveLength(0);
    const interiorEdge = preset.find(e => e.a[0] === -1 && e.b[0] === 0);
    expect(interiorEdge).toMatchObject({ a: [-1, 0], b: [0, 0], style: "solid", kind: "none" });
  });

  it("renders an interior passage entry as no wall at all", () => {
    const connections = new Map([["-1,0-0,0", connEntry([-1, 0], [0, 0], "passage")]]);
    const { preset, undecided, invalidPassages } = buildPresetWallGroups(cells, connections, cfg);
    expect(preset.some(e => e.a[0] === -1 && e.b[0] === 0)).toBe(false);
    expect(undecided).toHaveLength(0);
    expect(invalidPassages).toHaveLength(0);
  });

  it("renders a one-way entry with a direction vector pointing toward the target cell", () => {
    const connections = new Map([["-1,0-0,0", connEntry([-1, 0], [0, 0], "one_way_forward")]]);
    const { preset } = buildPresetWallGroups(cells, connections, cfg);
    const interiorEdge = preset.find(e => e.kind !== "none");
    expect(interiorEdge).toBeDefined();
    expect(interiorEdge!.kind).toBe("forward");
    expect(interiorEdge!.oneWayDir).toBeDefined();
    expect(interiorEdge!.oneWayDir!.dx).toBeGreaterThan(0); // -1,0 -> 0,0 points in +x
  });

  it("keeps the field boundary as a solid wall regardless of presets", () => {
    const { preset } = buildPresetWallGroups(cells, new Map(), cfg);
    // each of the 2 cells has 3 boundary edges (4 neighbor offsets - 1 shared interior edge)
    const boundaryWalls = preset.filter(e => e.kind === "none");
    expect(boundaryWalls).toHaveLength(6);
    for (const wall of boundaryWalls) expect(wall.style).toBe("solid");
  });

  it("flags a boundary edge with a wall entry as invalid (one endpoint outside field)", () => {
    const connections = new Map([["0,0-1,0", connEntry([0, 0], [1, 0], "wall")]]);
    const { invalidKeys } = buildPresetWallGroups(cells, connections, cfg);
    expect(invalidKeys.has("0,0-1,0")).toBe(true);
  });

  it("renders an invalid passage entry (endpoint outside field) on a separate background-styled list, not as a wall", () => {
    const connections = new Map([["0,0-1,0", connEntry([0, 0], [1, 0], "passage")]]);
    const { invalidPassages, invalidKeys } = buildPresetWallGroups(cells, connections, cfg);
    expect(invalidKeys.has("0,0-1,0")).toBe(true);
    expect(invalidPassages).toHaveLength(1);
    expect(invalidPassages[0]).toMatchObject({ a: [0, 0], b: [1, 0], style: "background" });
  });

  it("does not render a separate background entry for an undefined-state edge even if out of field", () => {
    const connections = new Map([["0,0-1,0", connEntry([0, 0], [1, 0], "undefined")]]);
    const { invalidPassages } = buildPresetWallGroups(cells, connections, cfg);
    expect(invalidPassages).toHaveLength(0);
  });

  it("renders a wholly out-of-field edge (both endpoints outside) only via the second pass", () => {
    // neither [1,0] nor [2,0] is in the field — the cell loop never visits this edge at all
    const connections = new Map([["1,0-2,0", connEntry([1, 0], [2, 0], "wall")]]);
    const { preset, invalidKeys } = buildPresetWallGroups(cells, connections, cfg);
    expect(invalidKeys.has("1,0-2,0")).toBe(true);
    const matches = preset.filter(e => e.a[0] === 1 && e.b[0] === 2);
    expect(matches).toHaveLength(1);
    expect(matches[0].style).toBe("solid");
  });
});
