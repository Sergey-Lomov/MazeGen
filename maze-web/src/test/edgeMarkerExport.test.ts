import { describe, expect, it } from "vitest";
import { Graphics } from "pixi.js";
import { clipToHalfPlane, drawExportEdgeMarkers, edgeMarkerKeys, edgeMarkerLook, edgeMarkerLooksAlike, selectExportEdgeMarkers, shiftEdgeMarkers } from "../pixi/imageExport/edgeMarkerExport";
import { computeEdgeMarkerWarnings, frameAround } from "../pixi/selectors/edgeMarkerWarnings";
import { DEFAULT_EDGE_MARKER_STYLE } from "../store/slices/imageExportDefaults";
import { validateVectorByCorridorsSettings, validateVectorByWallsSettings } from "../store/projectExport/validateImageExport";
import { useMazeStore } from "../store/mazeStore";
import type { EdgeMarkerStyle, FloorEdgeMarkerStyle } from "../store/imageExportTypes";
import type { WireTopology } from "../wasm/types";
import { warmCartesianCache } from "../pixi/cartesianCache";
import { fieldOf } from "./fieldConfigFixtures";
import { getSeamModel, pointOnHalfEdge } from "../pixi/selectors/seams";
import { displayTransform } from "../pixi/tessellationGeometry";
import { applyTransform } from "../pixi/geometry/worldTransform";

const style = (patch: Partial<EdgeMarkerStyle> = {}): EdgeMarkerStyle => ({ ...DEFAULT_EDGE_MARKER_STYLE, mode: "gluings", ...patch });
const floorStyle = (patch: Partial<FloorEdgeMarkerStyle> = {}): FloorEdgeMarkerStyle => ({ ...DEFAULT_EDGE_MARKER_STYLE, mode: "gluings", overrides: {}, ...patch });

describe("clipToHalfPlane", () => {
  const square = [-1, -1, 1, -1, 1, 1, -1, 1];

  it("keeps the half of a polygon on the inward side", () => {
    const half = clipToHalfPlane(square, [0, 0], [1, 0]);
    const xs = half.filter((_, i) => i % 2 === 0);
    expect(Math.min(...xs)).toBeCloseTo(0);
    expect(Math.max(...xs)).toBeCloseTo(1);
  });

  it("keeps everything on one side and nothing on the other", () => {
    expect(clipToHalfPlane(square, [-5, 0], [1, 0])).toEqual(square);
    expect(clipToHalfPlane(square, [5, 0], [1, 0])).toEqual([]);
  });
});

describe("edgeMarkerLook", () => {
  it("falls back to the shared look field by field", () => {
    const s = floorStyle({ shape: "square", color: 0x112233, overrides: { a: { color: 0xff0000 }, b: { shape: "star" } } });
    expect(edgeMarkerLook(s, "none")).toEqual({ shape: "square", color: 0x112233 });
    expect(edgeMarkerLook(s, "a")).toEqual({ shape: "square", color: 0xff0000 });
    expect(edgeMarkerLook(s, "b")).toEqual({ shape: "star", color: 0x112233 });
  });
});

describe("selectExportEdgeMarkers", () => {
  const state = { activeFloorId: "f", activeFieldConfig: {}, floorTopology: {}, floorCreases: { f: [{ id: 7, a: [0, 0] as const, b: [1, 0] as const }] }, pngExportSettings: { cuts: { lines: {} } }, nodes: [], floors: [] };

  it("returns nothing while hidden", () => {
    expect(selectExportEdgeMarkers(state as never, style({ mode: "hidden" }))).toEqual([]);
  });

  it("shows no crease marker in the gluings mode", () => {
    expect(selectExportEdgeMarkers(state as never, style({ mode: "gluings" }))).toEqual([]);
  });
});

describe("markers", () => {
  const halves = [
    { key: "g1", center: [0, 0] as const, inward: [1, 0] as const, tangent: [0, -1] as const, side: 1 as const },
    { key: "g1", center: [50, 0] as const, inward: [-1, 0] as const, tangent: [0, -1] as const, side: -1 as const },
    { key: "c3", center: [0, 50] as const, inward: null, tangent: [1, 0] as const, side: 1 as const },
  ];

  it("lists each key once", () => {
    expect(edgeMarkerKeys(halves as never)).toEqual(["g1", "c3"]);
  });

  it("shifts the centres and keeps the rest", () => {
    const shifted = shiftEdgeMarkers(halves as never, [10, 20]);
    expect(shifted[0]).toMatchObject({ key: "g1", center: [10, 20], inward: [1, 0] });
    expect(shifted[2].center).toEqual([10, 70]);
  });

  it("draws a glue half as half a marker and a crease marker whole", () => {
    const half = new Graphics();
    drawExportEdgeMarkers(half, [halves[0]] as never, style({ size: 10 }));
    const whole = new Graphics();
    drawExportEdgeMarkers(whole, [halves[2]] as never, style({ size: 10 }));
    const b = half.getLocalBounds();
    expect(b.minX).toBeCloseTo(0);
    expect(b.maxX).toBeCloseTo(5, 0);
    const w = whole.getLocalBounds();
    expect(w.maxX - w.minX).toBeCloseTo(10, 0);
  });

  it("assembles the two halves of a glue into the whole shape", () => {
    // Folding side B onto side A (a translation here) puts both halves at one centre: they must fill the shape's own outline.
    const joined = new Graphics();
    const folded = [halves[0], { ...halves[1], center: [0, 0] as const }];
    drawExportEdgeMarkers(joined, folded as never, style({ size: 20, shape: "triangle" }));
    const whole = new Graphics();
    drawExportEdgeMarkers(whole, [{ ...halves[2], center: [0, 0] as const, tangent: [0, -1] as const }] as never, style({ size: 20, shape: "triangle" }));
    const a = joined.getLocalBounds();
    const b = whole.getLocalBounds();
    for (const key of ["minX", "maxX", "minY", "maxY"] as const) expect(a[key]).toBeCloseTo(b[key], 5);
  });
});

describe("computeEdgeMarkerWarnings", () => {
  const state = { activeFloorId: "f", activeFieldConfig: {}, floorTopology: {}, floorCreases: {}, pngExportSettings: { cuts: { lines: {} } }, nodes: [], floors: [] };

  it("is empty with no markers", () => {
    expect(computeEdgeMarkerWarnings(state as never, floorStyle(), 0xffffff)).toEqual([]);
  });

  it("flags same shape and close colours, with a frame around each marker; a different shape is enough to avoid it", () => {
    const cfg = fieldOf("square", { shape: "rect", cols: 3, rows: 3 });
    const creases = [{ id: 0, a: [0, 0] as const, b: [2, 0] as const }, { id: 1, a: [0, 2] as const, b: [2, 2] as const }];
    const withCreases = { ...state, activeFieldConfig: cfg, floorCreases: { f: creases } };
    const same = computeEdgeMarkerWarnings(withCreases as never, floorStyle({ mode: "all", color: 0x808080 }), 0xffffff);
    const alike = same.find((w) => w.id === "edge_marker_colors_similar");
    expect(alike?.polygons).toHaveLength(2);
    const radius = DEFAULT_EDGE_MARKER_STYLE.size / 2;
    const xs = alike!.polygons![0].map((p) => p[0]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(2 * (radius + 4));
    const distinct = computeEdgeMarkerWarnings(withCreases as never, floorStyle({ mode: "all", color: 0x808080, overrides: { c1: { shape: "star" } } }), 0xffffff);
    expect(distinct.find((w) => w.id === "edge_marker_colors_similar")).toBeUndefined();
  });

  it("frames a half marker with the half of the square on its face's side, and a whole one fully", () => {
    const half = frameAround({ key: "g", center: [0, 0], inward: [1, 0], tangent: [0, -1], side: 1 }, 10);
    const xs = half.map((p) => p[0]);
    const ys = half.map((p) => p[1]);
    expect(Math.min(...xs)).toBeCloseTo(0);
    expect(Math.max(...xs)).toBeCloseTo(9);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(18);
    const whole = frameAround({ key: "c", center: [0, 0], inward: null, tangent: [1, 0], side: 1 }, 10);
    expect(Math.min(...whole.map((p) => p[0]))).toBeCloseTo(-9);
  });

  it("frames a side B half on the same side as the drawn half, toward its inward", () => {
    for (const side of [1, -1] as const) {
      const marker = { key: "g", center: [0, 0] as [number, number], inward: [1, 0] as [number, number], tangent: [0, 1] as [number, number], side };
      const g = new Graphics();
      drawExportEdgeMarkers(g, [marker], floorStyle({ size: 10 }));
      const drawn = g.bounds;
      const frame = frameAround(marker, 10);
      expect(Math.min(...frame.map((p) => p[0]))).toBeGreaterThanOrEqual(drawn.minX - 1e-6);
      expect(Math.min(...frame.map((p) => p[0]))).toBeCloseTo(0);
      expect(Math.max(...frame.map((p) => p[0]))).toBeGreaterThan(drawn.maxX);
    }
  });

  it("looksAlike needs the same shape", () => {
    expect(edgeMarkerLooksAlike({ shape: "circle", color: 1 }, { shape: "circle", color: 1 })).toBe(true);
    expect(edgeMarkerLooksAlike({ shape: "circle", color: 1 }, { shape: "star", color: 1 })).toBe(false);
  });
});

describe("persistence", () => {
  it("defaults when absent", () => {
    expect(validateVectorByWallsSettings({}, "x", []).edgeMarkers).toEqual(DEFAULT_EDGE_MARKER_STYLE);
    expect(validateVectorByCorridorsSettings({}, "x", []).edgeMarkers).toEqual(DEFAULT_EDGE_MARKER_STYLE);
  });

  it("clamps the size and drops malformed overrides", () => {
    const saved = { mode: "all", size: 999, shape: "star", color: 5, overrides: { f1: { a: { shape: "star", color: 1 }, b: { shape: "nope" }, c: 3 } } };
    const result = validateVectorByWallsSettings({ edgeMarkers: saved }, "x", []).edgeMarkers;
    expect(result).toMatchObject({ mode: "all", shape: "star", color: 5 });
    expect(result.size).toBeLessThan(999);
    expect(result.overrides).toEqual({ f1: { a: { shape: "star", color: 1 } } });
  });
});

describe("store setters", () => {
  it("merges and drops one marker's override", () => {
    // The marker must exist, or the store's cleanup (`edgeMarkerSync`) drops its override at once.
    const floor = useMazeStore.getState().activeFloorId;
    useMazeStore.setState({ floorCreases: { [floor]: [{ id: 0, a: [0, 0], b: [2, 0] }] } } as never);
    const store = useMazeStore.getState();
    store.setVectorByWallsEdgeMarkerOverride(floor, "c0", { color: 1 });
    store.setVectorByWallsEdgeMarkerOverride(floor, "c0", { shape: "star" });
    expect(useMazeStore.getState().vectorByWallsSettings.edgeMarkers.overrides[floor]?.c0).toEqual({ color: 1, shape: "star", linkBroken: { color: true, shape: true } });
    store.setVectorByWallsEdgeMarkerOverride(floor, "c0", { shape: undefined });
    expect(useMazeStore.getState().vectorByWallsSettings.edgeMarkers.overrides[floor]?.c0).toEqual({ color: 1, linkBroken: { color: true } });
    store.setVectorByWallsEdgeMarkerOverride(floor, "c0", null);
    expect(useMazeStore.getState().vectorByWallsSettings.edgeMarkers.overrides[floor]?.c0).toBeUndefined();
    store.setVectorByWallsEdgeMarkers({ mode: "all" });
    expect(useMazeStore.getState().vectorByWallsSettings.edgeMarkers.mode).toBe("all");
    store.setVectorByWallsEdgeMarkers({ mode: "hidden" });
    useMazeStore.setState({ floorCreases: {} });
  });
});

describe("selectExportEdgeMarkers on a glue", () => {
  const cells: [number, number][] = [];
  for (let x = 0; x < 6; x++) for (let y = 0; y < 5; y++) cells.push([x, y]);
  const cfg = fieldOf("square", { shape: "custom", points: cells });
  // Side A bends at the corner of cell (5,4): two stretches. Side B is three west faces.
  const topology: WireTopology = {
    fingerprint: "square{}",
    folds: [
      { a: { cell: [5, 3], face_idx: 0 }, b: { cell: [0, 0], face_idx: 2 }, twist: false, group: 0 },
      { a: { cell: [5, 4], face_idx: 0 }, b: { cell: [0, 1], face_idx: 2 }, twist: false, group: 0 },
      { a: { cell: [5, 4], face_idx: 1 }, b: { cell: [0, 2], face_idx: 2 }, twist: false, group: 0 },
    ],
    groups: [{ id: 0, folds: [0, 1, 2] }],
  };
  const nodes = cells.map(([x, y], id) => ({ id, x, y, i: 0 }));
  const state = { activeFloorId: "f", activeFieldConfig: cfg, floorTopology: { f: topology }, floorCreases: { f: [] }, pngExportSettings: { cuts: { lines: {} } }, nodes, floors: [{ id: "f" }] } as unknown as Parameters<typeof selectExportEdgeMarkers>[0];

  it("gives one marker per glue, as a half on each of its two faces", () => {
    warmCartesianCache(cfg, topology);
    const markers = selectExportEdgeMarkers(state, style());
    expect(edgeMarkerKeys(markers)).toEqual(["g0"]);
    expect(markers).toHaveLength(2);
    for (const marker of markers) expect(Math.hypot(marker.inward![0], marker.inward![1])).toBeCloseTo(1);
  });

  it("puts each half on the side of its own cell", () => {
    warmCartesianCache(cfg, topology);
    const [a, b] = selectExportEdgeMarkers(state, style()).filter((marker) => marker.key === "g0");
    // The A face of cell (5,3) looks west into the field's cell, the B face of cell (0,0) looks east.
    expect(a.inward![0]).toBeLessThan(-0.5);
    expect(b.inward![0]).toBeGreaterThan(0.5);
  });
});

describe("marker position on a glue", () => {
  const cells: [number, number][] = [];
  for (let x = 0; x < 6; x++) for (let y = 0; y < 5; y++) cells.push([x, y]);
  const cfg = fieldOf("square", { shape: "custom", points: cells });
  // Two equal faces meeting at a corner: the centre of the side is the corner itself.
  const topology: WireTopology = {
    fingerprint: "square{}",
    folds: [
      { a: { cell: [5, 4], face_idx: 0 }, b: { cell: [0, 1], face_idx: 2 }, twist: false, group: 0 },
      { a: { cell: [5, 4], face_idx: 1 }, b: { cell: [0, 2], face_idx: 2 }, twist: false, group: 0 },
    ],
    groups: [{ id: 0, folds: [0, 1] }],
  };
  const nodes = cells.map(([x, y], id) => ({ id, x, y, i: 0 }));
  const state = { activeFloorId: "f", activeFieldConfig: cfg, floorTopology: { f: topology }, floorCreases: { f: [] }, pngExportSettings: { cuts: { lines: {} } }, nodes, floors: [{ id: "f" }] } as unknown as Parameters<typeof selectExportEdgeMarkers>[0];

  it("moves a marker whose centre is a corner to the middle of the nearest face, whatever its size", () => {
    warmCartesianCache(cfg, topology);
    const small = selectExportEdgeMarkers(state, style({ size: 2 }))[0];
    const big = selectExportEdgeMarkers(state, style({ size: 20 }))[0];
    expect(big.center).toEqual(small.center);
    const half = getSeamModel(cfg).halfEdgeAt([5, 4], 0)!;
    const middle = applyTransform(displayTransform(cfg), [...pointOnHalfEdge(half, 0.5)]);
    expect(small.center[0]).toBeCloseTo(middle[0]);
    expect(small.center[1]).toBeCloseTo(middle[1]);
  });
});

describe("computeEdgeMarkerWarningsOf", () => {
  it("resolves the style through the links and is empty with no markers", async () => {
    const { computeEdgeMarkerWarningsOf } = await import("../pixi/selectors/edgeMarkerWarnings");
    const state = { activeFloorId: "f", activeFieldConfig: {}, floorTopology: {}, floorCreases: {}, pngExportSettings: { cuts: { lines: {} } }, nodes: [], floors: [] };
    expect(computeEdgeMarkerWarningsOf(state as never, { edgeMarkers: style({ overrides: { f: { a: { shape: "star" } } } }), links: [], background: 0xffffff })).toEqual([]);
  });
});

describe("computeTopologyWarnings", () => {
  it("lists the glue tab and the edge mark warnings of the active floor together", async () => {
    const { computeTopologyWarnings } = await import("../pixi/selectors/topologyWarnings");
    const { DEFAULT_GLUE_TAB_STYLE } = await import("../store/slices/imageExportDefaults");
    const cfg = fieldOf("square", { shape: "rect", cols: 3, rows: 3 });
    const creases = [{ id: 0, a: [0, 0] as const, b: [2, 0] as const }, { id: 1, a: [0, 2] as const, b: [2, 2] as const }];
    const state = { activeFloorId: "f", activeFieldConfig: cfg, floorTopology: {}, floorCreases: { f: creases }, pngExportSettings: { cuts: { lines: {} } }, nodes: [], floors: [] };
    const settings = { glueTabs: DEFAULT_GLUE_TAB_STYLE, edgeMarkers: style({ mode: "all", color: 0x808080 }), links: [], background: 0xffffff };
    expect(computeTopologyWarnings(state as never, settings).map((w) => w.id)).toContain("edge_marker_colors_similar");
  });
});

describe("persistence of link flags", () => {
  it("round-trips linkBroken and drops unknown flags", () => {
    const saved = { mode: "gluings", size: 12, shape: "circle", color: 1, overrides: { f1: { a: { shape: "star", linkBroken: { shape: true, color: false, other: true } } } } };
    expect(validateVectorByWallsSettings({ edgeMarkers: saved }, "x", []).edgeMarkers.overrides.f1?.a).toEqual({ shape: "star", linkBroken: { shape: true } });
  });
});

describe("setVectorBy*EdgeMarkerOverrides", () => {
  it("sets and drops the overrides of several markers in one settings update", () => {
    // The markers must exist, or the store's cleanup (`edgeMarkerSync`) drops their overrides at once.
    const floor = useMazeStore.getState().activeFloorId;
    useMazeStore.setState({ floorCreases: { [floor]: [{ id: 0, a: [0, 0], b: [2, 0] }, { id: 1, a: [0, 1], b: [2, 1] }] } } as never);
    useMazeStore.getState().setVectorByWallsEdgeMarkers({ mode: "all" });
    let updates = 0;
    const unsubscribe = useMazeStore.subscribe((state, prev) => { if (state.vectorByWallsSettings !== prev.vectorByWallsSettings) updates++; });
    useMazeStore.getState().setVectorByWallsEdgeMarkerOverrides(floor, { c0: { color: 1 }, c1: { color: 2 } });
    unsubscribe();
    expect(updates).toBe(1);
    expect(useMazeStore.getState().vectorByWallsSettings.edgeMarkers.overrides[floor]).toMatchObject({ c0: { color: 1 }, c1: { color: 2 } });
    useMazeStore.getState().setVectorByWallsEdgeMarkerOverrides(floor, { c0: null, c1: null });
    expect(useMazeStore.getState().vectorByWallsSettings.edgeMarkers.overrides[floor]).toBeUndefined();
    useMazeStore.getState().setVectorByWallsEdgeMarkers({ mode: "hidden" });
    useMazeStore.setState({ floorCreases: {} });
  });
});
