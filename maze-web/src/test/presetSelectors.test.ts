import { describe, it, expect, vi } from "vitest";
import { presetEdgeKey } from "../pixi/fieldEditUtils";
import type { PresetConnectionEntry } from "../pixi/fieldEditUtils";
import { presetEndpoint } from "../pixi/presetEndpoint";
import type { FieldConfig } from "../fieldConfig";
import { TILE_SIZE } from "../pixi/constants";
import { canvas } from "../pixi/colorTokens";
import { fieldOf } from "./fieldConfigFixtures";

// getCellCenter (via cartesianCache's getCartesian) delegates to wasm, unavailable in this
// unit-test environment -- mock it with the canonical square formula (see
// `maze-core/src/space/square.rs`'s `cartesian`: `(x, y)`, no offset/flip -- those are applied
// by `cartesianCache.ts` itself, not this mock).
vi.mock("../wasm/mazeService", async (importActual) => ({
  getFieldPreset: (await importActual<typeof import("../wasm/mazeService")>()).getFieldPreset,
  getFieldCapabilities: (await importActual<typeof import("../wasm/mazeService")>()).getFieldCapabilities,
  translateFieldCells: (await importActual<typeof import("../wasm/mazeService")>()).translateFieldCells,
  reflectFieldCells: (await importActual<typeof import("../wasm/mazeService")>()).reflectFieldCells,
  getGeometrySnapshot: (await importActual<typeof import("../wasm/mazeService")>()).getGeometrySnapshot,
  getCellAt: (await importActual<typeof import("../wasm/mazeService")>()).getCellAt,
  getCellsInRegion: (await importActual<typeof import("../wasm/mazeService")>()).getCellsInRegion,
}));

const { buildPresetWallGroups, buildPresetSplitPassages, buildPresetMarkers, buildLinkHoverHighlight, buildLocks, computeIsolatedNodeKeys, buildIsolatedCellHighlights, buildPresetNodePositions, buildPresetSplitHostKeys } = await import("../pixi/selectors/presetSelectors");
const { getCellCenter } = await import("../pixi/tessellationGeometry");

// width=2, height=1 centers cells at x=-1 and x=0 (see configAllCells offset math)
const cfg: FieldConfig = fieldOf("square", { shape: "rect", cols: 2, rows: 1 });
const cells: [number, number][] = [[-1, 0], [0, 0]];

function connEntry(
  from: [number, number],
  to: [number, number],
  state: PresetConnectionEntry["state"],
): PresetConnectionEntry {
  return { from: presetEndpoint(from), to: presetEndpoint(to), state, source: "user" };
}

describe("buildPresetMarkers", () => {
  it("uses shared default styles and keeps ordinary endpoints at their tile centers (GitHub issue #448)", () => {
    const markers = buildPresetMarkers(presetEndpoint([-1, 0]), presetEndpoint([0, 0]), cfg);
    const startCenter = getCellCenter(-1, 0, cfg);
    const finishCenter = getCellCenter(0, 0, cfg);

    expect(markers).toEqual([
      {
        pos: [startCenter.x, startCenter.y], radius: 8.5,
        shape: "circle", color: canvas.node.start, borderColor: canvas.node.start,
        borderWidth: 3, cornerStyle: "round", gapWidth: 3, gapColor: canvas.floor.default,
        text: "", textColor: canvas.floor.default, sizeAdaptation: 0,
      },
      {
        pos: [finishCenter.x, finishCenter.y], radius: 8.5,
        shape: "circle", color: canvas.node.finish, borderColor: canvas.node.finish,
        borderWidth: 3, cornerStyle: "round", gapWidth: 3, gapColor: canvas.floor.default,
        text: "", textColor: canvas.floor.default, sizeAdaptation: 0,
      },
    ]);
  });

  it("uses the special split-shape anchor for a preset endpoint slot (GitHub issue #447)", () => {
    const splitCfg: FieldConfig = fieldOf("square", { shape: "rect", cols: 3, rows: 3 });
    const connections = new Map<string, PresetConnectionEntry>();
    const add = (key: string, from: ReturnType<typeof presetEndpoint>, to: ReturnType<typeof presetEndpoint>) =>
      connections.set(key, { from, to, state: "passage", source: "user" });
    const original = presetEndpoint([0, 0]);
    const slot = presetEndpoint([0, 0], 0);
    add("left", original, presetEndpoint([-1, 0]));
    add("right", original, presetEndpoint([1, 0]));
    add("up", slot, presetEndpoint([0, -1]));
    add("down", slot, presetEndpoint([0, 1]));

    const marker = buildPresetMarkers(original, null, splitCfg, { "0,0": [0] }, connections)[0];
    const center = getCellCenter(0, 0, splitCfg);
    expect(marker.pos[0]).toBeCloseTo(center.x + TILE_SIZE * 0.25);
    expect(marker.pos[1]).toBeCloseTo(center.y);
  });

  it("falls back to the tile center when the endpoint still carries a `level` `buildPresetNodePositions` doesn't key on (GitHub issue #589)", () => {
    // `buildPresetNodePositions` keys split-point nodes without a `level` suffix -- a caller on a
    // floor above 0 MUST strip `level` (via `withoutLevel`) before resolving through this selector,
    // or the lookup misses and silently falls back to the plain tile center instead of the
    // shape-aware anchor. This pins that documented fallback so a future caller forgetting
    // `withoutLevel` (the exact regression in GitHub issue #589's `PresetConnectionsRenderer`) is
    // caught by a visibly wrong position rather than a subtle one.
    const splitCfg: FieldConfig = fieldOf("square", { shape: "rect", cols: 3, rows: 3 });
    const connections = new Map<string, PresetConnectionEntry>();
    const add = (key: string, from: ReturnType<typeof presetEndpoint>, to: ReturnType<typeof presetEndpoint>) =>
      connections.set(key, { from, to, state: "passage", source: "user" });
    const original = presetEndpoint([0, 0]);
    const slot = presetEndpoint([0, 0], 0);
    add("left", original, presetEndpoint([-1, 0]));
    add("right", original, presetEndpoint([1, 0]));
    add("up", slot, presetEndpoint([0, -1]));
    add("down", slot, presetEndpoint([0, 1]));

    // Same shape as the renderer's own floor-1 pipeline: `presetSplitPoints`/`connections` are
    // already level-stripped (as if filtered via `recordOnLevel`/`presetConnectionsOnLevel`), but
    // this endpoint still carries `level: 1` -- simulating a caller that forgot `withoutLevel`.
    const notStripped = presetEndpoint([0, 0], undefined, 1);
    const marker = buildPresetMarkers(notStripped, null, splitCfg, { "0,0": [0] }, connections)[0];
    const center = getCellCenter(0, 0, splitCfg);
    expect(marker.pos).toEqual([center.x, center.y]);
  });
});

describe("withoutLevel", () => {
  it("strips `level` while keeping `point`/`slotId`, matching what buildPresetNodePositions keys split nodes on (GitHub issue #589)", async () => {
    const { withoutLevel } = await import("../pixi/presetEndpoint");
    expect(withoutLevel(presetEndpoint([3, 5], 2, 1))).toEqual({ point: [3, 5], slotId: 2 });
    expect(withoutLevel(presetEndpoint([3, 5]))).toEqual({ point: [3, 5], slotId: undefined });
  });
});

describe("buildLocks", () => {
  it("uses a split node's anchor, scale, and node color", () => {
    const locks = buildLocks(
      new Map([["0,0:4", "both"]]), new Set(),
      new Map([["0,0:4", { x: 123, y: 456 }]]), { "0,0": [4] },
    );
    expect(locks).toEqual([expect.objectContaining({
      x: 0, y: 0, type: "both", position: { x: 123, y: 456 }, scale: 0.75,
      color: canvas.node.splitSlots[1],
    })]);
    expect(Number.isNaN(locks[0].x)).toBe(false);
    expect(Number.isNaN(locks[0].y)).toBe(false);
  });

  it("checks isolation against the exact split node, not only the point", () => {
    const original = presetEndpoint([0, 0]);
    const connections = new Map<string, PresetConnectionEntry>([
      [presetEdgeKey(original, presetEndpoint([1, 0])), {
        from: original, to: presetEndpoint([1, 0]), state: "passage", source: "user",
      }],
    ]);
    expect(buildIsolatedCellHighlights(new Map([["0,0:1", "both"]]), new Set(), connections)).toEqual([[0, 0]]);
  });

  it("does not report an auto-locked split node when its passage is connected to that slot", () => {
    const split = presetEndpoint([0, 0], 1);
    const connections = new Map<string, PresetConnectionEntry>([
      [presetEdgeKey(split, presetEndpoint([1, 0])), {
        from: split, to: presetEndpoint([1, 0]), state: "passage", source: "user",
      }],
    ]);
    expect(computeIsolatedNodeKeys(new Map(), new Set(["0,0:1"]), connections)).toEqual([]);
  });
});

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

  it("keeps a split-point cell's field-boundary sides as solid walls (GitHub issue #572)", () => {
    const splitPoints = { "-1,0": [0] };
    const { preset } = buildPresetWallGroups(cells, new Map(), cfg, splitPoints);
    // "-1,0" has 3 boundary sides (4 neighbor offsets - 1 shared interior edge with "0,0")
    const boundaryWalls = preset.filter(e => e.kind === "none" && e.a[0] === -1 && e.a[1] === 0);
    expect(boundaryWalls).toHaveLength(3);
    for (const wall of boundaryWalls) expect(wall.style).toBe("solid");
  });
});

// --- buildPresetSplitPassages ---

describe("buildPresetSplitPassages", () => {
  it("a point with no declared split produces no passages", () => {
    const connections = new Map([["-1,0-0,0", connEntry([-1, 0], [0, 0], "passage")]]);
    expect(buildPresetSplitPassages({}, connections, cfg).passages).toEqual([]);
  });

  it("a point with a declared but empty slot list produces no passages", () => {
    expect(buildPresetSplitPassages({ "-1,0": [] }, new Map(), cfg).passages).toEqual([]);
  });

  it("a declared split node's undecided face still draws a default-optional passage once its in-field geometric neighbor is passed via `cells`, with no connection entry at all", () => {
    const { passages } = buildPresetSplitPassages({ "-1,0": [0] }, new Map(), cfg, {}, cells);
    expect(passages).toHaveLength(2); // original node + slot 0, both facing the undecided east face
    for (const p of passages) {
      expect(p.wallSegments).toHaveLength(1);
      expect(p.wallSegments[0].isUndefined).toBe(true);
      expect(p.connectors[0].isUndefined).toBe(true);
    }
  });

  it("when both points on a shared face are split, each node's connection is checked against its real partner, not the neighbor's first node", () => {
    // Point (-1,0) split into original + slot 0; point (0,0) split into original + slot 0.
    // Only slot0-to-slot0 has an explicit passage — the two originals have no connection between
    // them and must stay optional/undefined, not inherit slot 0's decided state (regression: the
    // old lookup resolved "the" neighbor as the neighbor point's first node regardless of which
    // node the connection actually named).
    const connections = new Map([
      ["-1,0:0-0,0:0", { from: presetEndpoint([-1, 0], 0), to: presetEndpoint([0, 0], 0), state: "passage" as const, source: "user" as const }],
    ]);
    const { passages } = buildPresetSplitPassages({ "-1,0": [0], "0,0": [0] }, connections, cfg, {}, cells);
    const originalA = passages.find(p => p.wallSegments[0]?.isUndefined === true);
    const slot0A = passages.find(p => p.connectors.some(c => c.oneWayOut === undefined && !c.isUndefined));
    expect(originalA).toBeDefined();
    expect(slot0A).toBeDefined();
  });

  it("the original node and one slot each get their own passage when both connect east", () => {
    // Point (-1,0) split into original + slot 0, both wired as a passage to (0,0).
    const connections = new Map([
      ["-1,0-0,0", { from: presetEndpoint([-1, 0]), to: presetEndpoint([0, 0]), state: "passage" as const, source: "user" as const }],
      ["-1,0:0-0,0", { from: presetEndpoint([-1, 0], 0), to: presetEndpoint([0, 0]), state: "passage" as const, source: "user" as const }],
    ]);
    const { passages } = buildPresetSplitPassages({ "-1,0": [0] }, connections, cfg);
    expect(passages).toHaveLength(2);
    expect(passages[0].color).not.toBe(passages[1].color);
    for (const p of passages) expect(p.wallSegments).toHaveLength(1);
  });

  it("a real passage to one neighbor node wins over an explicit wall to another neighbor node on the same face, regardless of map iteration order (GitHub issue #243 follow-up)", () => {
    // Point (-1,0) has only its original node connecting east. Point (0,0) is split: its original
    // has an explicit wall to (-1,0)'s original, but its slot 0 has the real passage. The wall
    // entry must not shadow the passage just because it happens to be checked first.
    const connections = new Map([
      ["-1,0-0,0", { from: presetEndpoint([-1, 0]), to: presetEndpoint([0, 0]), state: "wall" as const, source: "user" as const }],
      ["-1,0-0,0:0", { from: presetEndpoint([-1, 0]), to: presetEndpoint([0, 0], 0), state: "passage" as const, source: "user" as const }],
    ]);
    const { passages } = buildPresetSplitPassages({ "0,0": [0] }, connections, cfg, {}, cells);
    const original = passages.find((p) => p.wallSegments.length === 1)!;
    expect(original).toBeDefined();
    expect(original.wallSegments[0].isUndefined).toBe(false);
    expect(original.connectors[0].isUndefined).toBe(false);
  });

  it("a slot with no referencing preset produces no passage entry", () => {
    const { passages } = buildPresetSplitPassages({ "-1,0": [0] }, new Map(), cfg);
    expect(passages).toEqual([]);
  });

  it("an explicit wall on a split endpoint's face draws no segment for that node, unlike its sibling's default-optional face", () => {
    // Slot 0 explicitly walls off the east face -- gets no passage entry of its own. The point's
    // other (original, undeclared) node still gets a default-optional ("undefined") passage on
    // that same face, now that the neighbor (0,0) is known (referenced by the wall entry).
    const connections = new Map([
      ["-1,0:0-0,0", { from: presetEndpoint([-1, 0], 0), to: presetEndpoint([0, 0]), state: "wall" as const, source: "user" as const }],
    ]);
    const { passages } = buildPresetSplitPassages({ "-1,0": [0] }, connections, cfg);
    expect(passages).toHaveLength(1);
    expect(passages[0].wallSegments[0].isUndefined).toBe(true);
  });

  it("an explicit 'undefined' state connection entry (not just an absent one) still reads as default-optional, never a decided kind", () => {
    // `state: "undefined"` can be a real map entry (e.g. after `setPresetConnectionUndefined` /
    // the reset tool touching one of a split point's faces), not just an absence — must produce
    // the same default-optional reading as no entry at all, never leak into a decided kind.
    const connections = new Map([
      ["-1,0:0-0,0", { from: presetEndpoint([-1, 0], 0), to: presetEndpoint([0, 0]), state: "undefined" as const, source: "user" as const }],
    ]);
    const { passages } = buildPresetSplitPassages({ "-1,0": [0] }, connections, cfg, {}, cells);
    const slot0 = passages.find(p => p.wallSegments.length === 1)!;
    expect(slot0).toBeDefined();
    expect(slot0.wallSegments[0].isUndefined).toBe(true);
    expect(slot0.connectors[0].oneWayOut).toBeUndefined();
  });

  it("one-way preset connections produce a directed connector", () => {
    const connections = new Map([
      ["-1,0:0-0,0", { from: presetEndpoint([-1, 0], 0), to: presetEndpoint([0, 0]), state: "one_way_forward" as const, source: "user" as const }],
    ]);
    const { passages } = buildPresetSplitPassages({ "-1,0": [0] }, connections, cfg);
    const slot0 = passages.find(p => p.connectors[0].oneWayOut !== undefined)!;
    expect(slot0.connectors[0].oneWayOut).toBeDefined();
  });

  it("one_way_backward connects the split slot from the plain neighbor's side, not the slot's own from/to", () => {
    // entry.from is the plain neighbor (0,0), entry.to is the split slot -- a backward preset
    // means the passage actually runs to -> from, i.e. (0,0) -> the slot, so the slot only shows
    // up as a passage recipient (addPair(entry.to, entry.from) in buildPresetSplitPassages).
    const connections = new Map([
      ["-1,0:0-0,0", { from: presetEndpoint([0, 0]), to: presetEndpoint([-1, 0], 0), state: "one_way_backward" as const, source: "user" as const }],
    ]);
    const { passages } = buildPresetSplitPassages({ "-1,0": [0] }, connections, cfg);
    const slot0 = passages.find(p => p.connectors[0].oneWayOut !== undefined)!;
    expect(slot0.connectors[0].oneWayOut).toBeDefined();
  });

  it("a point split into two slots (no original-node reference) still gives every one of the point's nodes a passage once the neighbor is known", () => {
    // Point (-1,0) split into original + slot 0 + slot 1, only slot 1 is wired as a passage -- once
    // that reference makes neighbor (0,0) known to the point, slot 0 and the original node both
    // get a default-optional ("undefined") passage on the same face too, instead of none at all.
    const connections = new Map([
      ["-1,0:1-0,0", { from: presetEndpoint([-1, 0], 1), to: presetEndpoint([0, 0]), state: "passage" as const, source: "user" as const }],
    ]);
    const { passages } = buildPresetSplitPassages({ "-1,0": [0, 1] }, connections, cfg);
    expect(passages).toHaveLength(3);
  });
});

describe("buildLinkHoverHighlight", () => {
  it("null link produces no highlight", () => {
    expect(buildLinkHoverHighlight(null, cfg)).toEqual([]);
  });

  it("resolves both endpoints to their own cell centers", () => {
    const link = { from: presetEndpoint([-1, 0]), to: presetEndpoint([0, 0]) };
    const result = buildLinkHoverHighlight(link, cfg);
    expect(result).toHaveLength(1);
    expect(result[0].from).not.toEqual(result[0].to);
  });

  it("a split-slot endpoint resolves to the same cell center as its point (no hub-point offset)", () => {
    // GitHub issue #237: this highlight deliberately uses the plain cell center for a split
    // endpoint too, not the hub-aware position — kept simple, same as buildHoverEdgeHighlight.
    const original = buildLinkHoverHighlight({ from: presetEndpoint([-1, 0]), to: presetEndpoint([0, 0]) }, cfg);
    const slotted = buildLinkHoverHighlight({ from: presetEndpoint([-1, 0], 0), to: presetEndpoint([0, 0]) }, cfg);
    expect(slotted[0].from).toEqual(original[0].from);
  });
});

describe("buildPresetSplitHostKeys", () => {
  it("is empty without split points", () => {
    expect(buildPresetSplitHostKeys({}, buildPresetNodePositions(cfg, {})).size).toBe(0);
    expect(buildPresetSplitHostKeys({ "0,0": [] }, buildPresetNodePositions(cfg, {})).size).toBe(0);
  });

  it("contains the hub and every slot position of a split point, but not plain cells", () => {
    const split = { "0,0": [1, 2] };
    const positions = buildPresetNodePositions(cfg, split);
    const keys = buildPresetSplitHostKeys(split, positions);
    expect(keys.size).toBeGreaterThanOrEqual(1);
    for (const key of keys) expect(key).toMatch(/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/);
    const plain = getCellCenter(-1, 0, cfg);
    expect(keys.has(`${plain.x.toFixed(2)},${plain.y.toFixed(2)}`)).toBe(false);
  });
});
