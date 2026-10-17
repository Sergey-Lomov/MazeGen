import { describe, it, expect, vi } from "vitest";

vi.mock("../wasm/mazeService", async (importActual) => ({
  getFieldPreset: (await importActual<typeof import("../wasm/mazeService")>()).getFieldPreset,
  getGeometrySnapshot: (await importActual<typeof import("../wasm/mazeService")>()).getGeometrySnapshot,
  getCellAt: (await importActual<typeof import("../wasm/mazeService")>()).getCellAt,
  getCellsInRegion: (await importActual<typeof import("../wasm/mazeService")>()).getCellsInRegion,
}));

import { buildMarkerIndexLabels } from "../pixi/selectors/mazeSelectors";
import type { ResolveMarkerEndpointVisual } from "../pixi/selectors/mazeSelectors/markerIndex";
import { formatIndexLabel } from "../pixi/renderers/indexLabel";
import { DEFAULT_MARKER_INDEX_SETTINGS } from "../store/slices/imageExportDefaults";
import type { MarkerIndexSettings } from "../store/imageExportTypes";
import type { NodeDto, EdgeDto } from "../wasm/types";
import type { FieldConfig } from "../fieldConfig";
import { fieldOf } from "./fieldConfigFixtures";

const cfg: FieldConfig = fieldOf("square", { shape: "rect", cols: 8, rows: 8 });
const n = (id: number, x: number, y: number, level: number): NodeDto => ({ id, x, y, i: 0, level });
const style = (patch: Partial<MarkerIndexSettings> = {}): MarkerIndexSettings => ({
  ...DEFAULT_MARKER_INDEX_SETTINGS,
  enabled: true,
  ...patch,
});

// Stub endpoint visual — fixed radius + a color derived from the node id so per-endpoint
// resolution can still be asserted where a test cares.
const resolveVisual: ResolveMarkerEndpointVisual = (nodeId) => ({ outerRadius: 10, borderWidth: 3, borderMatchColor: 0x100 + nodeId });
const build = (
  nodes: Parameters<typeof buildMarkerIndexLabels>[0],
  edges: Parameters<typeof buildMarkerIndexLabels>[1],
  c: Parameters<typeof buildMarkerIndexLabels>[2],
  floor: number,
  s: Parameters<typeof buildMarkerIndexLabels>[4],
) => buildMarkerIndexLabels(nodes, edges, c, floor, s, resolveVisual);

const shuffle = <T,>(a: T[], seed: number): T[] => {
  const r = [...a];
  let s = seed;
  for (let i = r.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const j = s % (i + 1);
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
};

describe("buildMarkerIndexLabels — determinism", () => {
  const nodes = [n(0, 0, 0, 0), n(1, 0, 0, 1), n(2, 3, 3, 0), n(3, 3, 3, 1), n(4, 5, 5, 0), n(5, 5, 5, 1)];
  const edges: EdgeDto[] = [
    { from: 0, to: 1, kind: "teleport" },
    { from: 1, to: 0, kind: "teleport" },
    { from: 2, to: 3, kind: "vertical_passage" },
    { from: 4, to: 5, kind: "elevator" },
    { from: 5, to: 4, kind: "elevator" },
  ];

  it("is stable under node/edge reordering and reversed directed edges", () => {
    const base = build(nodes, edges, cfg, 0, style());
    for (let seed = 1; seed <= 5; seed++) {
      const got = build(shuffle(nodes, seed), shuffle(edges, seed * 7), cfg, 0, style());
      expect(got.allLabelStrings).toEqual(base.allLabelStrings);
      expect([...got.labels].map((l) => l.label).sort()).toEqual([...base.labels].map((l) => l.label).sort());
    }
  });

  it("numbers links 1..N: teleport, then vertical, then elevator", () => {
    const set = build(nodes, edges, cfg, 0, style({ labelStyle: "arabic" }));
    expect(set.allLabelStrings).toEqual(["1", "2", "3"]);
  });
});

describe("buildMarkerIndexLabels — pairing", () => {
  it("gives both endpoints of a teleport the same label", () => {
    const nodes = [n(0, 1, 1, 0), n(1, 1, 1, 1)];
    const edges: EdgeDto[] = [{ from: 0, to: 1, kind: "teleport" }];
    const floor0 = build(nodes, edges, cfg, 0, style({ labelStyle: "arabic" }));
    const floor1 = build(nodes, edges, cfg, 1, style({ labelStyle: "arabic" }));
    expect(floor0.labels.map((l) => l.label)).toEqual(["1"]);
    expect(floor1.labels.map((l) => l.label)).toEqual(["1"]);
  });

  it("collapses one-way vertical passage + reverse directed edge into one link", () => {
    const nodes = [n(0, 2, 2, 0), n(1, 2, 2, 1)];
    const oneWay: EdgeDto[] = [{ from: 0, to: 1, kind: "vertical_passage" }];
    const both: EdgeDto[] = [
      { from: 0, to: 1, kind: "vertical_passage" },
      { from: 1, to: 0, kind: "vertical_passage" },
    ];
    expect(build(nodes, oneWay, cfg, 0, style()).allLabelStrings).toEqual(
      build(nodes, both, cfg, 0, style()).allLabelStrings,
    );
    expect(build(nodes, both, cfg, 0, style()).allLabelStrings).toHaveLength(1);
  });
});

describe("buildMarkerIndexLabels — elevator fan", () => {
  it("gives a 3-floor fan one index and dedups nodes sharing a cell on the drawn floor", () => {
    const nodes = [n(0, 0, 0, 0), n(1, 1, 1, 1), n(2, 2, 2, 2), n(3, 1, 1, 1)];
    const edges: EdgeDto[] = [
      { from: 0, to: 1, kind: "elevator" },
      { from: 0, to: 2, kind: "elevator" },
      { from: 0, to: 3, kind: "elevator" },
    ];
    const set = build(nodes, edges, cfg, 1, style({ labelStyle: "arabic" }));
    expect(set.allLabelStrings).toEqual(["1"]);
    // nodes 1 and 3 both at cell (1,1) on floor 1 -> one plate
    expect(set.labels).toHaveLength(1);
    expect(set.labels[0].label).toBe("1");
  });

  it("numbers two separate elevators distinctly", () => {
    const nodes = [n(0, 0, 0, 0), n(1, 0, 0, 1), n(2, 4, 4, 0), n(3, 4, 4, 1)];
    const edges: EdgeDto[] = [
      { from: 0, to: 1, kind: "elevator" },
      { from: 2, to: 3, kind: "elevator" },
    ];
    const set = build(nodes, edges, cfg, 0, style({ labelStyle: "arabic" }));
    expect(set.allLabelStrings).toEqual(["1", "2"]);
    expect(set.labels.map((l) => l.label).sort()).toEqual(["1", "2"]);
  });
});

describe("buildMarkerIndexLabels — labelStyle", () => {
  const nodes = Array.from({ length: 8 }, (_, k) => n(k, k, 0, k % 2));
  const edges: EdgeDto[] = [
    { from: 0, to: 1, kind: "vertical_passage" },
    { from: 2, to: 3, kind: "vertical_passage" },
    { from: 4, to: 5, kind: "vertical_passage" },
    { from: 6, to: 7, kind: "vertical_passage" },
  ];

  it("formats all N labels with the chosen style", () => {
    for (const s of ["arabic", "roman", "letters"] as const) {
      const set = build(nodes, edges, cfg, 0, style({ labelStyle: s }));
      expect(set.allLabelStrings).toEqual([0, 1, 2, 3].map((i) => formatIndexLabel(i, s)));
    }
  });
});

describe("buildMarkerIndexLabels — collision policy", () => {
  it("stacks distinct links sharing a cell without crashing", () => {
    const nodes = [n(0, 2, 2, 0), n(1, 2, 2, 1), n(2, 2, 2, 0), n(3, 2, 2, 1)];
    const edges: EdgeDto[] = [
      { from: 0, to: 1, kind: "teleport" },
      { from: 2, to: 3, kind: "vertical_passage" },
    ];
    const set = build(nodes, edges, cfg, 0, style());
    expect(set.labels).toHaveLength(2);
    expect(set.labels[0].pos).toEqual(set.labels[1].pos);
  });
});

describe("buildMarkerIndexLabels — endpoint visual", () => {
  it("stamps each active-floor label with the resolver's radius and border-match color", () => {
    const nodes = [n(0, 1, 1, 0), n(1, 1, 1, 1)];
    const edges: EdgeDto[] = [{ from: 0, to: 1, kind: "teleport" }];
    const set = buildMarkerIndexLabels(nodes, edges, cfg, 0, style(), (id) => ({
      outerRadius: 7 + id,
      borderWidth: 4,
      borderMatchColor: 0xabc00 + id,
    }));
    expect(set.labels).toHaveLength(1);
    expect(set.labels[0].markerOuterRadius).toBe(7);
    expect(set.labels[0].borderMatchColor).toBe(0xabc00);
  });

  it("passes one-way status to the endpoint resolver for vertical passages", () => {
    const nodes = [n(0, 1, 1, 0), n(1, 1, 1, 1)];
    const edges: EdgeDto[] = [{ from: 0, to: 1, kind: "vertical_passage" }];
    const calls: Array<[number, string, boolean | undefined]> = [];
    buildMarkerIndexLabels(nodes, edges, cfg, 0, style(), (id, kind, oneWay) => {
      calls.push([id, kind, oneWay]);
      return { outerRadius: 7, borderWidth: 2, borderMatchColor: 0xabc00 };
    });
    expect(calls).toEqual([[0, "vertical", true]]);
  });
});

describe("buildMarkerIndexLabels — coverage", () => {
  const cover = (patch: Partial<MarkerIndexSettings["coverage"]>): Partial<MarkerIndexSettings> => ({
    coverage: { singleFloorTeleport: true, crossFloorTeleport: true, verticalPassage: true, elevator: true, ...patch },
  });
  const nodes = [
    n(0, 0, 0, 0), n(1, 1, 0, 0), // single-floor teleport pair
    n(2, 2, 0, 0), n(3, 2, 0, 1), // cross-floor teleport pair
    n(4, 3, 0, 0), n(5, 3, 0, 1), // vertical passage
    n(6, 4, 0, 0), n(7, 4, 0, 1), // elevator
  ];
  const edges: EdgeDto[] = [
    { from: 0, to: 1, kind: "teleport" },
    { from: 2, to: 3, kind: "teleport" },
    { from: 4, to: 5, kind: "vertical_passage" },
    { from: 6, to: 7, kind: "elevator" },
  ];

  it("includes all four kinds when every toggle is on", () => {
    expect(build(nodes, edges, cfg, 0, style(cover({}))).allLabelStrings).toHaveLength(4);
  });

  it("drops single-floor teleports when their toggle is off", () => {
    const set = build(nodes, edges, cfg, 0, style(cover({ singleFloorTeleport: false })));
    expect(set.allLabelStrings).toHaveLength(3);
  });

  it("classifies a teleport as cross-floor by endpoint level", () => {
    // only cross-floor teleports on → the same-level pair (0,1) drops, the (2,3) pair stays
    const set = build(nodes, edges, cfg, 0, style(cover({
      singleFloorTeleport: false, crossFloorTeleport: true, verticalPassage: false, elevator: false,
    })));
    expect(set.allLabelStrings).toHaveLength(1);
  });

  it("drops vertical passages and elevators when their toggles are off", () => {
    expect(build(nodes, edges, cfg, 0, style(cover({ verticalPassage: false }))).allLabelStrings).toHaveLength(3);
    expect(build(nodes, edges, cfg, 0, style(cover({ elevator: false }))).allLabelStrings).toHaveLength(3);
  });

  it("renumbers over what remains (no gaps)", () => {
    const set = build(nodes, edges, cfg, 0, style({
      labelStyle: "arabic",
      ...cover({ singleFloorTeleport: false, crossFloorTeleport: false }),
    }));
    expect(set.allLabelStrings).toEqual(["1", "2"]);
  });
});
