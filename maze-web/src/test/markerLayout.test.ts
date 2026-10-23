import { describe, it, expect, vi } from "vitest";
import {
  computeLayoutOffsets, resolveLayoutMode, applyMarkerLayout, buildGroupBridgeMarkers, shiftMarkerIndexLabels,
  HOST_EXTENT_SPLIT_NODE, hostKey, markerFootprint, buildSplitHostKeys, shiftKey,
} from "../pixi/selectors/mazeSelectors/markerLayout";
import { verticalMarkerFootprint } from "../pixi/renderers/VerticalConnectionRenderer";
import { layoutExportMarkers } from "../pixi/imageExport/exportStyleBuilders";
import { layoutEditorMarkers } from "../pixi/editorMarkerLayout";
import { DEFAULT_MARKER_SCALE } from "../pixi/selectors/mazeSelectors/markerLayout";
import type { MarkerData, TeleportEdge, VerticalConnectionMarker, VerticalConnectionStyle } from "../pixi/renderers/types";
import type { NodeDto } from "../wasm/types";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";

import { fieldOf } from "./fieldConfigFixtures";
import { bridgeSplitNodes, bridgeSplitEdges } from "./splitTopologyFixtures";

vi.mock("../wasm/mazeService", async (importActual) => ({
  ...(await importActual<typeof import("../wasm/mazeService")>()),
  getCartesianCoords: (c: { points: [number, number][] }) => c.points.map(([x, y]) => [x, y]),
}));

// The early-exit paths under test never read the tessellation config.
const cfg = {} as TessellationConfig;

const mk = (pos: [number, number], radius = 4): MarkerData => ({ pos, radius, color: 0 });
const vert = (pos: [number, number], kind: "vertical_passage" | "elevator" = "vertical_passage"): VerticalConnectionMarker =>
  ({ pos, fromNode: 1, kind, filled: true, arrowFilled: true });
const opts = { mode: "auto" as const, spacing: 2 };
const dist = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]);

describe("footprints", () => {
  it("markerFootprint adds border and gap", () => {
    expect(markerFootprint({ radius: 4, borderWidth: 1, gapWidth: 2 })).toBe(7);
    expect(markerFootprint({ radius: 4 })).toBe(4);
  });

  it("verticalMarkerFootprint: regular style adds border and gap, decorative uses half the size", () => {
    const ms = { size: 10, borderWidth: 1, gapWidth: 2 };
    const style = {
      style: "regular", elevatorMarker: ms, twoWayPassageMarker: ms, oneWayPassageMarker: { ...ms, size: 20 },
    } as unknown as VerticalConnectionStyle;
    expect(verticalMarkerFootprint(style, vert([0, 0]))).toBe(8);
    expect(verticalMarkerFootprint(style, { ...vert([0, 0]), filled: false })).toBe(13);
    const deco = {
      style: "decorative", decorativeElevator: { size: 12 }, decorativeStairsTwoWay: { size: 8 }, decorativeStairsOneWay: { size: 6 },
    } as unknown as VerticalConnectionStyle;
    expect(verticalMarkerFootprint(deco, vert([0, 0], "elevator"))).toBe(6);
    expect(verticalMarkerFootprint(deco, vert([0, 0]))).toBe(4);
  });
});

describe("buildSplitHostKeys", () => {
  const node = (id: number, x: number, y: number, level = 0) => ({ id, x, y, level }) as NodeDto;

  it("is empty when every cell holds one node", () => {
    const nodes = new Map([[1, node(1, 0, 0)], [2, node(2, 1, 0)]]);
    expect(buildSplitHostKeys(nodes, [], cfg).size).toBe(0);
  });

  it("different floors of the same x,y are not a split cell", () => {
    const nodes = new Map([[1, node(1, 0, 0, 0)], [2, node(2, 0, 0, 1)]]);
    expect(buildSplitHostKeys(nodes, [], cfg).size).toBe(0);
  });
});

describe("shiftMarkerIndexLabels", () => {
  const label = (pos: [number, number], kind: "teleport" | "vertical" | "elevator") =>
    ({ pos, kind, label: "1", markerOuterRadius: 4, markerBorderWidth: 0, borderMatchColor: 0 });

  it("moves and scales only labels with a matching shift", () => {
    const shifts = new Map([[shiftKey("teleport", [5, 5]), [3, -2] as [number, number]]]);
    const scales = new Map([[shiftKey("teleport", [5, 5]), 0.5]]);
    const labels = [label([5, 5], "teleport"), label([5, 5], "vertical")];
    const out = shiftMarkerIndexLabels(labels, shifts, scales);
    expect(out[0].pos).toEqual([8, 3]);
    expect(out[0].scale).toBe(0.5);
    expect(out[1]).toBe(labels[1]);
  });

  it("returns the same array when there are no shifts", () => {
    const labels = [label([0, 0], "elevator")];
    expect(shiftMarkerIndexLabels(labels, new Map())).toBe(labels);
  });
});

describe("resolveLayoutMode", () => {
  it("auto picks by count", () => {
    expect(resolveLayoutMode("auto", 2)).toBe("row");
    expect(resolveLayoutMode("auto", 3)).toBe("radial");
    expect(resolveLayoutMode("auto", 4)).toBe("radial");
    expect(resolveLayoutMode("auto", 5)).toBe("grid");
    expect(resolveLayoutMode("grid", 2)).toBe("grid");
  });
});

describe("computeLayoutOffsets", () => {
  it("leaves a single marker in place", () => {
    expect(computeLayoutOffsets([4], "auto", 2)).toEqual([[0, 0]]);
  });

  it("row: centered, neighbors exactly one pitch apart", () => {
    const o = computeLayoutOffsets([4, 4, 4], "row", 2);
    expect(o[1]).toEqual([0, 0]);
    expect(o[0][0]).toBeCloseTo(-10);
    expect(o[2][0]).toBeCloseTo(10);
  });

  it("radial: all markers equidistant from the center, neighbors a pitch apart", () => {
    const o = computeLayoutOffsets([4, 4, 4, 4], "radial", 2);
    const r = Math.hypot(...o[0]);
    for (const p of o) expect(Math.hypot(...p)).toBeCloseTo(r);
    expect(dist(o[0], o[1])).toBeCloseTo(10);
  });

  it("grid: no two markers closer than a pitch, bounding box centered on the host", () => {
    const o = computeLayoutOffsets(Array(5).fill(4), "grid", 2);
    for (let i = 0; i < o.length; i++) for (let j = i + 1; j < o.length; j++) expect(dist(o[i], o[j])).toBeGreaterThanOrEqual(10 - 1e-9);
    const ys = o.map((p) => p[1]);
    expect(Math.min(...ys)).toBeCloseTo(-Math.max(...ys));
  });

  it("scales offsets down so the group stays within maxExtent", () => {
    const o = computeLayoutOffsets([4, 4, 4, 4], "radial", 2, 8);
    for (const p of o) expect(Math.hypot(...p) + 4).toBeLessThanOrEqual(8 + 1e-9);
  });
});

describe("applyMarkerLayout", () => {
  it("returns inputs untouched when no host has 2+ markers", () => {
    const markers = [mk([0, 0]), mk([100, 0])];
    const r = applyMarkerLayout({ markers, teleportEdges: [], verticalMarkers: [], teleportRadius: 4, verticalRadius: () => 4 }, opts);
    expect(r.markers).toEqual(markers);
    expect(r.groups).toEqual([]);
    expect(r.shifts.size).toBe(0);
  });

  it("separates start and finish sharing a node, without mutating the input", () => {
    const markers = [mk([50, 50]), mk([50, 50])];
    const r = applyMarkerLayout({ markers, teleportEdges: [], verticalMarkers: [], teleportRadius: 4, verticalRadius: () => 4 }, opts);
    expect(r.markers[0].pos).not.toEqual(r.markers[1].pos);
    expect(markers[0].pos).toEqual([50, 50]);
    expect(r.groups).toHaveLength(1);
  });

  it("moves a shared teleport point (several edges) as one slot, keeping edges joined", () => {
    const edges: TeleportEdge[] = [
      { from: [10, 10], to: [200, 0], oneWay: false },
      { from: [10, 10], to: [0, 200], oneWay: false },
    ];
    const r = applyMarkerLayout({ markers: [mk([10, 10])], teleportEdges: edges, verticalMarkers: [], teleportRadius: 4, verticalRadius: () => 4 }, opts);
    expect(r.teleportEdges[0].from).toEqual(r.teleportEdges[1].from);
    expect(r.teleportEdges[0].from).not.toEqual(r.markers[0].pos);
    expect(r.teleportEdges[0].to).toEqual([200, 0]);
    expect(edges[0].from).toEqual([10, 10]);
  });

  it("leaves cross-floor badge ends in place", () => {
    const edges: TeleportEdge[] = [{ from: [10, 10], to: [30, 30], oneWay: false, toFloor: 2 }];
    const r = applyMarkerLayout({ markers: [mk([30, 30])], teleportEdges: edges, verticalMarkers: [], teleportRadius: 4, verticalRadius: () => 4 }, opts);
    expect(r.teleportEdges[0].to).toEqual([30, 30]);
    expect(r.markers[0].pos).toEqual([30, 30]);
  });

  it("lays out vertical markers and records label shifts", () => {
    const r = applyMarkerLayout({ markers: [mk([5, 5])], teleportEdges: [], verticalMarkers: [vert([5, 5], "elevator")], teleportRadius: 4, verticalRadius: () => 4 }, opts);
    expect(r.verticalMarkers[0].pos).not.toEqual([5, 5]);
    const labels = shiftMarkerIndexLabels(
      [{ pos: [5, 5], kind: "elevator", label: "1", markerOuterRadius: 4, markerBorderWidth: 0, borderMatchColor: 0 }],
      r.shifts,
    );
    expect(labels[0].pos).toEqual(r.verticalMarkers[0].pos);
  });

  it("passes the shrink factor to the index label of a scaled marker", () => {
    const r = applyMarkerLayout({ markers: [mk([5, 5])], teleportEdges: [], verticalMarkers: [vert([5, 5], "elevator")], teleportRadius: 4, verticalRadius: () => 4 }, { ...opts, scale: 0.5 });
    const label = { pos: [5, 5] as [number, number], kind: "elevator" as const, label: "1", markerOuterRadius: 4, markerBorderWidth: 0, borderMatchColor: 0 };
    expect(shiftMarkerIndexLabels([label], r.shifts, r.scales)[0].scale).toBe(0.5);
    expect(shiftMarkerIndexLabels([label], r.shifts)[0].scale).toBeUndefined();
  });

  it("shrinks markers on a tight split host instead of piling them up", () => {
    const markers = [mk([0, 0], 8), mk([0, 0], 8), mk([0, 0], 8)];
    const r = applyMarkerLayout(
      { markers, teleportEdges: [], verticalMarkers: [], teleportRadius: 4, verticalRadius: () => 4, splitHostKeys: new Set([hostKey([0, 0])]) },
      { mode: "radial", spacing: 2 },
    );
    expect(r.markers[0].radius).toBeLessThan(8);
    expect(dist(r.markers[0].pos, r.markers[1].pos)).toBeGreaterThanOrEqual(r.markers[0].radius + r.markers[1].radius - 1e-9);
  });

  it("bounds a split-tile node's group to the smaller split extent", () => {
    const markers = [mk([0, 0], 3), mk([0, 0], 3), mk([0, 0], 3), mk([0, 0], 3)];
    const r = applyMarkerLayout(
      { markers, teleportEdges: [], verticalMarkers: [], teleportRadius: 4, verticalRadius: () => 4, splitHostKeys: new Set([hostKey([0, 0])]) },
      { mode: "radial", spacing: 10 },
    );
    for (const m of r.markers) expect(Math.hypot(...m.pos) + 3).toBeLessThanOrEqual(HOST_EXTENT_SPLIT_NODE + 1e-9);
  });
});

describe("applyMarkerLayout scale", () => {
  const input = () => ({
    markers: [{ ...mk([50, 50], 8), borderWidth: 2, gapWidth: 2, textSize: 10 }, mk([50, 50], 8)],
    teleportEdges: [{ from: [50, 50], to: [200, 0], oneWay: false }] as TeleportEdge[],
    verticalMarkers: [vert([50, 50])],
    teleportRadius: 8,
    verticalRadius: () => 8,
  });

  it("shrinks every component of grouped markers, tags teleport and vertical markers", () => {
    const r = applyMarkerLayout(input(), { ...opts, scale: 0.5 });
    expect(r.markers[0]).toMatchObject({ radius: 4, borderWidth: 1, gapWidth: 1, textSize: 5 });
    expect(r.teleportEdges[0].fromScale).toBe(0.5);
    expect(r.teleportEdges[0].toScale).toBeUndefined();
    expect(r.verticalMarkers[0].scale).toBe(0.5);
  });

  it("packs shrunken markers closer together", () => {
    const two = { ...input(), teleportEdges: [], verticalMarkers: [] };
    const full = applyMarkerLayout(two, opts);
    const half = applyMarkerLayout(two, { ...opts, scale: 0.5 });
    expect(dist(half.markers[0].pos, half.markers[1].pos)).toBeLessThan(dist(full.markers[0].pos, full.markers[1].pos));
  });

  it("leaves a lone marker unscaled", () => {
    const r = applyMarkerLayout({ ...input(), markers: [mk([0, 0], 8)], teleportEdges: [], verticalMarkers: [] }, { ...opts, scale: 0.5 });
    expect(r.markers[0].radius).toBe(8);
  });
});

describe("overlap mode", () => {
  it("computeLayoutOffsets stacks everything at the center", () => {
    expect(computeLayoutOffsets([4, 4, 4], "overlap", 2)).toEqual([[0, 0], [0, 0], [0, 0]]);
  });

  it("applyMarkerLayout leaves positions, sizes and groups untouched, even with a scale", () => {
    const markers = [mk([50, 50], 8), mk([50, 50], 8)];
    const r = applyMarkerLayout(
      { markers, teleportEdges: [], verticalMarkers: [vert([50, 50])], teleportRadius: 4, verticalRadius: () => 4 },
      { mode: "overlap", spacing: 2, scale: 0.5 },
    );
    expect(r.markers).toEqual(markers);
    expect(r.verticalMarkers[0].scale).toBeUndefined();
    expect(r.groups).toEqual([]);
  });
});

describe("buildGroupBridgeMarkers", () => {
  it("emits one bridge per neighboring pair, at the midpoint", () => {
    const bridges = buildGroupBridgeMarkers([{ host: [0, 0], items: [{ pos: [-5, 0], radius: 4 }, { pos: [5, 0], radius: 4 }] }]);
    expect(bridges).toHaveLength(1);
    expect(bridges[0].pos).toEqual([0, 0]);
    expect(bridges[0].radius).toBe(4);
  });
});

describe("same-kind vertical markers on one host", () => {
  it("each keeps its own label shift", () => {
    const r = applyMarkerLayout(
      { markers: [], teleportEdges: [], verticalMarkers: [vert([10, 10]), vert([10, 10])], teleportRadius: 4, verticalRadius: () => 4 },
      { mode: "row", spacing: 2 },
    );
    const label = { pos: [10, 10] as [number, number], kind: "vertical" as const, label: "1", markerOuterRadius: 4, markerBorderWidth: 0, borderMatchColor: 0 };
    const [a, b] = shiftMarkerIndexLabels([label, label], r.shifts);
    expect(a.pos).toEqual(r.verticalMarkers[0].pos);
    expect(b.pos).toEqual(r.verticalMarkers[1].pos);
    expect(a.pos).not.toEqual(b.pos);
  });
});

describe("buildSplitHostKeys with a split cell", () => {
  it("marks the hub of a cell holding two nodes", () => {
    const sq: TessellationConfig = fieldOf("square", { shape: "rect", cols: 6, rows: 6 });
    const nodes = new Map(bridgeSplitNodes.map((nd) => [nd.id, nd]));
    expect(buildSplitHostKeys(nodes, bridgeSplitEdges, sq).size).toBeGreaterThan(0);
  });
});

describe("layout wrappers", () => {
  it("layoutExportMarkers applies the settings' mode and scale", () => {
    const settings = { markerLayout: "row", markerScale: 0.5, teleportMarker: { size: 8, borderWidth: 1, gapWidth: 1 } } as unknown as Parameters<typeof layoutExportMarkers>[0]["settings"];
    const r = layoutExportMarkers({
      markers: [mk([5, 5], 6), mk([5, 5], 6)], teleportEdges: [], verticalMarkers: [], settings,
      verticalStyle: {} as VerticalConnectionStyle, splitHostKeys: new Set(),
    });
    expect(r.markers[0].radius).toBeCloseTo(3);
    expect(r.markers[0].pos[1]).toBe(5);
    expect(r.markers[0].pos[0]).not.toBe(r.markers[1].pos[0]);
  });

  it("layoutEditorMarkers separates stacked markers with the default look", () => {
    const r = layoutEditorMarkers({ markers: [mk([5, 5], 6), mk([5, 5], 6)], teleportEdges: [], nodeById: new Map(), edges: [], cfg });
    expect(r.markers[0].pos).not.toEqual(r.markers[1].pos);
    expect(r.markers[0].radius).toBeCloseTo(6 * DEFAULT_MARKER_SCALE);
  });
});
