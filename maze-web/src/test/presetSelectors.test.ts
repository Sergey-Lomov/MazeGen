import { describe, it, expect, vi } from "vitest";
import type { PresetConnectionEntry } from "../pixi/fieldEditUtils";
import { presetEndpoint } from "../pixi/presetEndpoint";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";

// getCellCenter (via squareGeometry's getCartesian) delegates to wasm, unavailable in this
// unit-test environment -- mock it with the canonical square formula (see
// `maze-core/src/space/square.rs`'s `cartesian`: `(x, y)`, no offset/flip -- those are applied
// by `squareGeometry.ts` itself, not this mock).
vi.mock("../wasm/mazeService", () => ({
  getCartesianCoords: (cfg: { points: [number, number][] }) => cfg.points.map(([x, y]) => [x, y]),
}));

const { buildPresetWallGroups, buildPresetSplitPassages } = await import("../pixi/selectors/presetSelectors");

// width=2, height=1 centers cells at x=-1 and x=0 (see configAllCells offset math)
const cfg: TessellationConfig = { type: "square", width: 2, height: 1 };
const cells: [number, number][] = [[-1, 0], [0, 0]];

function connEntry(
  from: [number, number],
  to: [number, number],
  state: PresetConnectionEntry["state"],
): PresetConnectionEntry {
  return { from: presetEndpoint(from), to: presetEndpoint(to), state, source: "user" };
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

  it("excludes a declared split point's own faces from the ordinary wall/undecided reading (GitHub issue #231)", () => {
    const connections = new Map([["-1,0-0,0", connEntry([-1, 0], [0, 0], "wall")]]);
    const splitPoints = { "-1,0": [0] };
    const { undecided, preset } = buildPresetWallGroups(cells, connections, cfg, splitPoints);
    expect(undecided).toHaveLength(0);
    expect(preset.some(e => (e.a[0] === -1 && e.b[0] === 0) || (e.a[0] === 0 && e.b[0] === -1))).toBe(false);
  });

  it("an empty split-point slot list does not exclude the point's faces", () => {
    const { undecided } = buildPresetWallGroups(cells, new Map(), cfg, { "-1,0": [] });
    expect(undecided).toHaveLength(1);
  });
});

// --- buildPresetSplitPassages ---

describe("buildPresetSplitPassages", () => {
  it("a point with no declared split produces no passages", () => {
    const connections = new Map([["-1,0-0,0", connEntry([-1, 0], [0, 0], "passage")]]);
    expect(buildPresetSplitPassages({}, connections, cfg)).toEqual([]);
  });

  it("a point with a declared but empty slot list produces no passages", () => {
    expect(buildPresetSplitPassages({ "-1,0": [] }, new Map(), cfg)).toEqual([]);
  });

  it("the original node and one slot each get their own passage when both connect east", () => {
    // Point (-1,0) split into original + slot 0, both wired as a passage to (0,0).
    const connections = new Map([
      ["-1,0-0,0", { from: presetEndpoint([-1, 0]), to: presetEndpoint([0, 0]), state: "passage" as const, source: "user" as const }],
      ["-1,0:0-0,0", { from: presetEndpoint([-1, 0], 0), to: presetEndpoint([0, 0]), state: "passage" as const, source: "user" as const }],
    ]);
    const passages = buildPresetSplitPassages({ "-1,0": [0] }, connections, cfg);
    expect(passages).toHaveLength(2);
    expect(passages[0].color).not.toBe(passages[1].color);
    for (const p of passages) expect(p.wallSegments).toHaveLength(1);
  });

  it("a slot with no referencing preset produces no passage entry", () => {
    const passages = buildPresetSplitPassages({ "-1,0": [0] }, new Map(), cfg);
    expect(passages).toEqual([]);
  });

  it("wall/undefined preset states on a split endpoint don't count as a connection", () => {
    const connections = new Map([
      ["-1,0:0-0,0", { from: presetEndpoint([-1, 0], 0), to: presetEndpoint([0, 0]), state: "wall" as const, source: "user" as const }],
    ]);
    const passages = buildPresetSplitPassages({ "-1,0": [0] }, connections, cfg);
    expect(passages).toEqual([]);
  });

  it("one-way preset connections produce a directed wall segment", () => {
    const connections = new Map([
      ["-1,0:0-0,0", { from: presetEndpoint([-1, 0], 0), to: presetEndpoint([0, 0]), state: "one_way_forward" as const, source: "user" as const }],
    ]);
    const passages = buildPresetSplitPassages({ "-1,0": [0] }, connections, cfg);
    expect(passages).toHaveLength(1);
    expect(passages[0].wallSegments[0].oneWayDir).toBeDefined();
  });

  it("one_way_backward connects the split slot from the plain neighbor's side, not the slot's own from/to", () => {
    // entry.from is the plain neighbor (0,0), entry.to is the split slot -- a backward preset
    // means the passage actually runs to -> from, i.e. (0,0) -> the slot, so the slot only shows
    // up as a passage recipient (addPair(entry.to, entry.from) in buildPresetSplitPassages).
    const connections = new Map([
      ["-1,0:0-0,0", { from: presetEndpoint([0, 0]), to: presetEndpoint([-1, 0], 0), state: "one_way_backward" as const, source: "user" as const }],
    ]);
    const passages = buildPresetSplitPassages({ "-1,0": [0] }, connections, cfg);
    expect(passages).toHaveLength(1);
    expect(passages[0].wallSegments[0].oneWayDir).toBeDefined();
  });

  it("a point split into two slots (no original-node reference) still produces one passage per referenced slot", () => {
    // Point (-1,0) split into slot 0 and slot 1, only slot 1 is wired -- slot 0 gets no passage,
    // the original node (never referenced by any connection) gets no passage either.
    const connections = new Map([
      ["-1,0:1-0,0", { from: presetEndpoint([-1, 0], 1), to: presetEndpoint([0, 0]), state: "passage" as const, source: "user" as const }],
    ]);
    const passages = buildPresetSplitPassages({ "-1,0": [0, 1] }, connections, cfg);
    expect(passages).toHaveLength(1);
  });
});
