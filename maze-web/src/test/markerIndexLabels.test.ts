import { describe, it, expect, vi } from "vitest";

vi.mock("../wasm/mazeService", async (importActual) => ({
  getFieldPreset: (await importActual<typeof import("../wasm/mazeService")>()).getFieldPreset,
  getFieldCapabilities: (await importActual<typeof import("../wasm/mazeService")>()).getFieldCapabilities,
  translateFieldCells: (await importActual<typeof import("../wasm/mazeService")>()).translateFieldCells,
  reflectFieldCells: (await importActual<typeof import("../wasm/mazeService")>()).reflectFieldCells,
  getGeometrySnapshot: (await importActual<typeof import("../wasm/mazeService")>()).getGeometrySnapshot,
  getCellAt: (await importActual<typeof import("../wasm/mazeService")>()).getCellAt,
  getCellsInRegion: (await importActual<typeof import("../wasm/mazeService")>()).getCellsInRegion,
}));

import { buildMarkerIndexLabels } from "../pixi/selectors/mazeSelectors";
import type { ResolveMarkerEndpointVisual } from "../pixi/selectors/mazeSelectors/markerIndex";
import { getCellCenter, buildNodePositions } from "../pixi/tessellationGeometry";
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
const resolveVisual: ResolveMarkerEndpointVisual = (nodeId) => ({ outerRadius: 10, fillRadius: 7, sizeAdaptation: 0, borderWidth: 3, borderMatchColor: 0x100 + nodeId });
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

const cellCenterOf = (x: number, y: number): [number, number] => {
  const c = getCellCenter(x, y, cfg);
  return [c.x, c.y];
};

describe("buildMarkerIndexLabels — split-tile anchor (#896)", () => {
  it("anchors split-tile labels on the node hub point, not the cell center", () => {
    const nodes = [n(0, 2, 2, 0), n(1, 2, 2, 0), n(2, 5, 5, 0), n(3, 5, 5, 1)];
    const edges: EdgeDto[] = [
      { from: 0, to: 3, kind: "teleport" },
      { from: 1, to: 3, kind: "teleport" },
      { from: 2, to: 3, kind: "vertical_passage" },
    ];
    const { labels } = build(nodes, edges, cfg, 0, style());
    const hubA = labels.find((l) => l.nodeId === 0)!;
    const hubB = labels.find((l) => l.nodeId === 1)!;
    const hubs = buildNodePositions(nodes.filter((nd) => nd.level === 0), cfg, edges.map(({ from, to }) => ({ from, to })));
    expect(hubA.pos).toEqual([hubs.get(0)!.x, hubs.get(0)!.y]);
    expect(hubB.pos).toEqual([hubs.get(1)!.x, hubs.get(1)!.y]);
    expect(hubA.pos).not.toEqual(cellCenterOf(2, 2));
    expect(hubA.pos).not.toEqual(hubB.pos);
    const plain = labels.find((l) => l.nodeId === 2)!;
    expect(plain.pos).toEqual(cellCenterOf(5, 5));
  });
});

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

  it("tags each label with its node and the link's other endpoint", () => {
    const nodes = [n(0, 1, 1, 0), n(1, 1, 1, 1)];
    const edges: EdgeDto[] = [{ from: 0, to: 1, kind: "teleport" }];
    expect(build(nodes, edges, cfg, 0, style()).labels.map((l) => [l.nodeId, l.partnerId])).toEqual([[0, 1]]);
    expect(build(nodes, edges, cfg, 1, style()).labels.map((l) => [l.nodeId, l.partnerId])).toEqual([[1, 0]]);
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
  it("distinct links on split-tile siblings get separate hub anchors", () => {
    const nodes = [n(0, 2, 2, 0), n(1, 2, 2, 1), n(2, 2, 2, 0), n(3, 2, 2, 1)];
    const edges: EdgeDto[] = [
      { from: 0, to: 1, kind: "teleport" },
      { from: 2, to: 3, kind: "vertical_passage" },
    ];
    const set = build(nodes, edges, cfg, 0, style());
    expect(set.labels).toHaveLength(2);
    expect(set.labels[0].pos).not.toEqual(set.labels[1].pos);
  });
});

describe("buildMarkerIndexLabels — endpoint visual", () => {
  it("stamps each active-floor label with the resolver's radius and border-match color", () => {
    const nodes = [n(0, 1, 1, 0), n(1, 1, 1, 1)];
    const edges: EdgeDto[] = [{ from: 0, to: 1, kind: "teleport" }];
    const set = buildMarkerIndexLabels(nodes, edges, cfg, 0, style(), (id) => ({
      outerRadius: 7 + id, fillRadius: 5, sizeAdaptation: 0,
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
      return { outerRadius: 7, fillRadius: 5, sizeAdaptation: 0, borderWidth: 2, borderMatchColor: 0xabc00 };
    });
    expect(calls).toEqual([[0, "vertical", true]]);
  });
});

describe("buildMarkerIndexLabels — size adaptation (GitHub issue #819)", () => {
  const edges: EdgeDto[] = [{ from: 0, to: 1, kind: "teleport" }];
  const nodes = [n(0, 1, 1, 0), n(1, 1, 1, 1)];
  const scaler = { factorAt: () => 2, maxFactor: 2 };

  it("grows only the fill part of the outer radius for an ordinary marker", () => {
    const set = buildMarkerIndexLabels(nodes, edges, cfg, 0, style(), () => ({ outerRadius: 10, fillRadius: 7, sizeAdaptation: 1, borderWidth: 3, borderMatchColor: 0 }), scaler);
    expect(set.labels[0].markerOuterRadius).toBe(17);
    expect(set.labels[0].markerBorderWidth).toBe(3);
  });

  it("scales radius and border together for a marker that scales as a whole", () => {
    const set = buildMarkerIndexLabels(nodes, edges, cfg, 0, style(), () => ({ outerRadius: 10, fillRadius: 7, scalesAsWhole: true, sizeAdaptation: 1, borderWidth: 3, borderMatchColor: 0 }), scaler);
    expect(set.labels[0].markerOuterRadius).toBe(20);
    expect(set.labels[0].markerBorderWidth).toBe(6);
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

describe("buildMarkerIndexLabels — teleport groups (GitHub issue #871)", () => {
  // Teleports 0-1 and 2-3 share the cell (1,1) on floor 0; 4-5 is unrelated.
  const nodes = [n(0, 1, 1, 0), n(1, 3, 3, 1), n(2, 1, 1, 0), n(3, 5, 5, 1), n(4, 6, 6, 0), n(5, 6, 6, 1)];
  const edges: EdgeDto[] = [
    { from: 0, to: 1, kind: "teleport" },
    { from: 2, to: 3, kind: "teleport" },
    { from: 4, to: 5, kind: "teleport" },
  ];
  const group = (edgeKeys: string[]) => ({ key: edgeKeys.join("|"), edgeKeys, points: [] as [number, number][], links: [] });
  const groups = [group(["0-1", "2-3"]), group(["4-5"])];
  const withGroups = (floor: number, s = style({ labelStyle: "arabic" }), g = groups) =>
    buildMarkerIndexLabels(nodes, edges, cfg, floor, s, resolveVisual, undefined, g);

  it("gives every teleport of one group the same index and numbers per group", () => {
    const set = withGroups(1);
    expect(set.allLabelStrings).toEqual(["1", "2"]);
    expect(set.labels.map((l) => l.label)).toEqual(["1", "1", "2"]);
  });

  it("draws one plate per cell for a group whose teleports share an endpoint cell", () => {
    expect(withGroups(0).labels.map((l) => l.label)).toEqual(["1", "2"]);
  });

  it("numbers every pair separately when no groups are given", () => {
    const set = build(nodes, edges, cfg, 1, style({ labelStyle: "arabic" }));
    expect(set.allLabelStrings).toEqual(["1", "2", "3"]);
  });

  it("keeps merge-off teleports on their own indices (one group per pair)", () => {
    const set = withGroups(1, undefined, [group(["0-1"]), group(["2-3"]), group(["4-5"])]);
    expect(set.allLabelStrings).toEqual(["1", "2", "3"]);
  });

  it("numbers groups before vertical passages and elevators", () => {
    const n2 = [...nodes, n(6, 0, 0, 0), n(7, 0, 0, 1), n(8, 7, 7, 0), n(9, 7, 7, 1)];
    const e2: EdgeDto[] = [...edges, { from: 6, to: 7, kind: "vertical_passage" }, { from: 8, to: 9, kind: "elevator" }];
    const set = buildMarkerIndexLabels(n2, e2, cfg, 1, style({ labelStyle: "arabic" }), resolveVisual, undefined, groups);
    expect(set.allLabelStrings).toEqual(["1", "2", "3", "4"]);
    expect(set.labels.map((l) => [l.kind, l.label])).toEqual([["teleport", "1"], ["teleport", "1"], ["teleport", "2"], ["vertical", "3"], ["elevator", "4"]]);
  });

  it("drops a group from the numbering when coverage filters all its teleports out", () => {
    const set = withGroups(1, style({ labelStyle: "arabic", coverage: { ...DEFAULT_MARKER_INDEX_SETTINGS.coverage, crossFloorTeleport: false } }));
    expect(set.allLabelStrings).toEqual([]);
  });
});
