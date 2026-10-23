import { describe, it, expect, vi } from "vitest";
import { computeVectorByWallsWarnings, computeVectorByCorridorsWarnings, computeVectorByWallsWarningsAcrossFloors } from "../pixi/selectors/exportWarnings";
import { selectNodeLevelResolver } from "../pixi/selectors/mazeSelectors/state";
import { stopLineOverlapsRoundedRect } from "../pixi/renderers/verticalConnectionGeometry";
import type { NodeDto, EdgeDto } from "../wasm/types";
import type { FieldConfig } from "../fieldConfig";
import type { VectorByWallsSettings, VectorByCorridorsSettings, MarkerSettings } from "../store/storeTypes";
import type { MarkerIndexSettings } from "../store/imageExportTypes";
import { canvas } from "../pixi/colorTokens";
import { DEFAULT_SHARED_STYLE_SOURCE, DEFAULT_VERTICAL_SETTINGS, DEFAULT_VERTICAL_DECORATIVE_SETTINGS, DEFAULT_VERTICAL_SHARED_STYLE, DEFAULT_MARKER_INDEX_SETTINGS, DEFAULT_FLOOR_LABEL_SETTINGS } from "../store/slices/imageExportSlice";
import { DEFAULT_VECTOR_BY_WALLS_LINKS, DEFAULT_VECTOR_BY_CORRIDORS_LINKS } from "../store/slices/parameterLinksDefaults";
import { fieldOf } from "./fieldConfigFixtures";

// GitHub issue #744 — `marker_index_covers_stop_line`.

vi.mock("../wasm/mazeService", async (importActual) => ({
  getFieldPreset: (await importActual<typeof import("../wasm/mazeService")>()).getFieldPreset,
  getFieldCapabilities: (await importActual<typeof import("../wasm/mazeService")>()).getFieldCapabilities,
  translateFieldCells: (await importActual<typeof import("../wasm/mazeService")>()).translateFieldCells,
  reflectFieldCells: (await importActual<typeof import("../wasm/mazeService")>()).reflectFieldCells,
  getGeometrySnapshot: (await importActual<typeof import("../wasm/mazeService")>()).getGeometrySnapshot,
  getCellAt: (await importActual<typeof import("../wasm/mazeService")>()).getCellAt,
  getCellsInRegion: (await importActual<typeof import("../wasm/mazeService")>()).getCellsInRegion,
}));

const n = (id: number, x: number, y: number, level?: number): NodeDto => ({ id, x, y, i: 0, level });
const squareCfg: FieldConfig = fieldOf("square", { shape: "rect", cols: 6, rows: 6 });

const defaultMarker: MarkerSettings = {
  shape: "circle", cornerStyle: "miter", fillColor: canvas.node.start, borderColor: canvas.node.start,
  borderWidth: 0, gapWidth: 0, size: 12, sizeAdaptation: 0, text: "",
};

function baseSettings(overrides: Partial<VectorByWallsSettings> = {}): VectorByWallsSettings {
  return {
    background: 0, showGrid: true, gridColor: 0x808080, showInnerGrid: false, innerGridColor: 0x808080, floorColor: 0, wallColor: 0, randomWallColorMode: "off", wallJoin: "round", wallThickness: 4,
    oneWayPattern: "triangle", oneWayColor: 0, oneWayGapWidth: 3, oneWaySize: 12, oneWayThickness: 4, oneWayJoin: "round", markerLayout: "auto", markerScale: 1,
    startMarker: defaultMarker, finishMarker: defaultMarker,
    teleportMarker: { sizeAdaptation: 0, cornerStyle: "round", shape: "diamond", size: 6.4, fillColor: 0xff0000, borderColor: 0xff0000, borderWidth: 3, gapWidth: 3 },
    teleportConnectorColor: 0xff0000, teleportConnectorWidth: 3, teleportConnectorStyle: "orthogonal",
    teleportAvoidFieldExit: false, teleportArrowMode: "periodic", teleportArrowPeriod: 5, teleportArrowSize: 10,
    teleportConnectorGapWidth: 3, teleportFloorBadge: { sizeAdaptation: 0, shape: "circle", labelType: "arabic", cornerStyle: "round", gapWidth: 3, size: 6.4, fillColor: 0x123456, borderColor: 0x123456, borderWidth: 3, textColor: 0x123456, textFontWeight: "bold", textSize: 12, textMargin: 1 }, teleportGroupCustomization: false, teleportGroupOverrides: {},
    ...DEFAULT_VERTICAL_SETTINGS,
    ...DEFAULT_VERTICAL_DECORATIVE_SETTINGS,
    ...DEFAULT_VERTICAL_SHARED_STYLE,
    verticalDecorativeLineColor: 0,
    verticalDecorativeLineWidth: 2,
    verticalDecorativeSize: 8.8, verticalDecorativeSizeAdaptation: 0, verticalSizeAdaptation: 0,
    verticalDecorativeArrowSize: 0.75,
    splitNodeColors: [], splitSpecialShapes: true,
    ...DEFAULT_SHARED_STYLE_SOURCE,
    links: DEFAULT_VECTOR_BY_WALLS_LINKS,
    markerIndex: DEFAULT_MARKER_INDEX_SETTINGS,
    floorLabel: DEFAULT_FLOOR_LABEL_SETTINGS,
    ...overrides,
  };
}

function baseCorridorsSettings(overrides: Partial<VectorByCorridorsSettings> = {}): VectorByCorridorsSettings {
  return {
    background: 0, showGrid: true, gridColor: 0x808080,
    color: 0, thickness: 4, junctionRadius: 4, join: "round", renderStyle: "contour",
    startMarker: defaultMarker, finishMarker: defaultMarker,
    markerWidenPadding: 0, markerWidenShape: "match_marker",
    oneWayColor: 0, oneWayCount: 1, oneWayThickness: 4, oneWayGap: 4, oneWayWidth: 1, oneWayLength: 1, oneWayJoin: "round", markerLayout: "auto", markerScale: 1,
    teleportMarker: { sizeAdaptation: 0, cornerStyle: "round", shape: "diamond", size: 6.4, fillColor: 0xff0000, borderColor: 0xff0000, borderWidth: 3, gapWidth: 3 },
    teleportConnectorColor: 0xff0000, teleportConnectorWidth: 3, teleportConnectorStyle: "orthogonal",
    teleportAvoidFieldExit: false, teleportArrowMode: "periodic", teleportArrowPeriod: 5, teleportArrowSize: 10,
    teleportConnectorGapWidth: 3, teleportFloorBadge: { sizeAdaptation: 0, shape: "circle", labelType: "arabic", cornerStyle: "round", gapWidth: 3, size: 6.4, fillColor: 0x123456, borderColor: 0x123456, borderWidth: 3, textColor: 0x123456, textFontWeight: "bold", textSize: 12, textMargin: 1 }, teleportGroupCustomization: false, teleportGroupOverrides: {},
    ...DEFAULT_VERTICAL_SETTINGS,
    ...DEFAULT_VERTICAL_SHARED_STYLE,
    splitNodeColors: [], splitSpecialShapes: true, splitGapWidth: 3, splitDiagonalBowAmount: 0.15,
    ...DEFAULT_SHARED_STYLE_SOURCE,
    links: DEFAULT_VECTOR_BY_CORRIDORS_LINKS,
    markerIndex: DEFAULT_MARKER_INDEX_SETTINGS,
    floorLabel: DEFAULT_FLOOR_LABEL_SETTINGS,
    ...overrides,
  };
}


const ID = "marker_index_covers_stop_line";
const vertical = (from: number, to: number): EdgeDto => ({ from, to, kind: "vertical_passage" });

/** A one-way passage 0 (floor 0) -> 1 (floor 1): floor 0 shows the departure end, floor 1 the
 *  arrival end — both draw a stop line below the arrow, on the side the index plate hangs. */
const crossNodes = [n(0, 0, 0, 0), n(1, 0, 0, 1)];
const oneWayEdges = [vertical(0, 1)];
const twoWayEdges = [vertical(0, 1), vertical(1, 0)];

function floorContext(edges: EdgeDto[], activeFloorIndex: number) {
  return {
    resolveNodeLevel: selectNodeLevelResolver(crossNodes),
    unscopedNodeById: new Map(crossNodes.map((x) => [x.id, x])),
    unscopedEdges: edges,
    activeFloorIndex,
    floorCount: 2,
  };
}

const index = (patch: Partial<MarkerIndexSettings>): MarkerIndexSettings => ({
  ...DEFAULT_MARKER_INDEX_SETTINGS, enabled: true, borderWidthFromMarker: false, borderWidth: 0, ...patch,
});

function wallsRun(settings: VectorByWallsSettings, edges = oneWayEdges, floor = 0) {
  const scopedNodes = crossNodes.filter((x) => x.level === floor);
  const scopedEdges = edges.filter((x) => scopedNodes.some((node) => node.id === x.from));
  return computeVectorByWallsWarnings(scopedNodes, scopedEdges, squareCfg, settings, null, null, crossNodes, floorContext(edges, floor))
    .filter((w) => w.id === ID);
}

function corridorsRun(settings: VectorByCorridorsSettings, edges = oneWayEdges, floor = 0) {
  const scopedNodes = crossNodes.filter((x) => x.level === floor);
  const scopedEdges = edges.filter((x) => scopedNodes.some((node) => node.id === x.from));
  return computeVectorByCorridorsWarnings(scopedNodes, scopedEdges, squareCfg, settings, null, null, floorContext(edges, floor), crossNodes)
    .filter((w) => w.id === ID);
}

describe("marker_index_covers_stop_line", () => {
  it("flags the departure end when the plate itself covers the stop line, and clears it when raised", () => {
    const w = wallsRun(baseSettings({ markerIndex: index({ offset: 0 }) }));
    expect(w).toHaveLength(1);
    expect(w[0].nodes).toEqual([0]);
    expect(wallsRun(baseSettings({ markerIndex: index({ offset: 20 }) }))).toHaveLength(0);
  });

  it("flags the arrival end on its own floor", () => {
    const w = wallsRun(baseSettings({ markerIndex: index({ offset: 0 }) }), oneWayEdges, 1);
    expect(w).toHaveLength(1);
    expect(w[0].nodes).toEqual([1]);
  });

  it("counts the plate border: a position clear of the body alone is flagged once a border reaches the line", () => {
    const offset = clearOffset((patch) => wallsRun(baseSettings({ markerIndex: index(patch) })).length > 0);
    expect(wallsRun(baseSettings({ markerIndex: index({ offset }) }))).toHaveLength(0);
    expect(wallsRun(baseSettings({ markerIndex: index({ offset, borderWidth: 3 }) }))).toHaveLength(1);
  });

  it("is silent when indices are off and for two-way passages", () => {
    expect(wallsRun(baseSettings({ markerIndex: index({ offset: 0, enabled: false }) }))).toHaveLength(0);
    expect(wallsRun(baseSettings({ markerIndex: index({ offset: 0 }) }), twoWayEdges)).toHaveLength(0);
  });

  it("is computed per floor by the across-floors entry point and merges both passage ends", () => {
    const run = (offset: number) => computeVectorByWallsWarningsAcrossFloors(
      crossNodes, oneWayEdges, [{ id: "f0" }, { id: "f1" }], squareCfg, baseSettings({ markerIndex: index({ offset }) }), null, null,
    ).filter((w) => w.id === ID);
    const w = run(0);
    expect(w).toHaveLength(1);
    expect([...w[0].nodes].sort()).toEqual([0, 1]);
    expect(run(20)).toHaveLength(0);
  });

  it("counts a plate of another link in the same cell, not only the passage's own", () => {
    // The passage itself is not indexed; a cross-floor teleport sharing its cell is.
    const nodes = [...crossNodes, n(2, 0, 0, 0), n(3, 1, 0, 1)];
    const edges: EdgeDto[] = [...oneWayEdges, { from: 2, to: 3, kind: "teleport" }, { from: 3, to: 2, kind: "teleport" }];
    const coverage = { ...DEFAULT_MARKER_INDEX_SETTINGS.coverage, verticalPassage: false };
    const run = (crossFloorTeleport: boolean) => computeVectorByWallsWarningsAcrossFloors(
      nodes, edges, [{ id: "f0" }, { id: "f1" }], squareCfg,
      baseSettings({ markerIndex: index({ offset: 0, coverage: { ...coverage, crossFloorTeleport } }) }), null, null,
    ).filter((w) => w.id === ID);
    expect(run(true).flatMap((w) => w.nodes)).toContain(0);
    expect(run(false)).toHaveLength(0);
  });

  it("checks the decorative stairs' stop line", () => {
    // The stairs arrow runs above-left of the icon: only a wide, tall, bordered plate reaches its stop line.
    const decorative = (patch: Partial<MarkerIndexSettings>) => baseSettings({ verticalStyle: "decorative", markerIndex: index({ width: 20, height: 30, borderWidth: 3, ...patch }) });
    expect(wallsRun(decorative({ offset: 0 }), oneWayEdges, 1)).toHaveLength(1);
    expect(wallsRun(decorative({ offset: 20 }), oneWayEdges, 1)).toHaveLength(0);
    expect(wallsRun(decorative({ offset: 0 }), twoWayEdges, 1)).toHaveLength(0);
  });

  it("is reported by Vector by corridors too", () => {
    expect(corridorsRun(baseCorridorsSettings({ markerIndex: index({ offset: 0 }) }))).toHaveLength(1);
    expect(corridorsRun(baseCorridorsSettings({ markerIndex: index({ offset: 20 }) }))).toHaveLength(0);
  });
});

/** The smallest whole-pixel position at which the borderless plate no longer covers the line. */
function clearOffset(covers: (patch: Partial<MarkerIndexSettings>) => boolean): number {
  for (let offset = 0; offset <= 40; offset++) {
    if (!covers({ offset })) return offset;
  }
  throw new Error("plate never clears the stop line");
}

describe("stopLineOverlapsRoundedRect", () => {
  const rect = { x: 0, y: 0, w: 10, h: 10, radius: 0 };

  it("needs a strict overlap — touching edges do not count", () => {
    expect(stopLineOverlapsRoundedRect({ kind: "roundedRect", x: 10, y: 0, w: 4, h: 2, radius: 0 }, rect)).toBe(false);
    expect(stopLineOverlapsRoundedRect({ kind: "roundedRect", x: 9.5, y: 0, w: 4, h: 2, radius: 0 }, rect)).toBe(true);
  });

  it("respects rounded corners", () => {
    const tick = { kind: "roundedRect" as const, x: 10.5, y: 10.5, w: 2, h: 2, radius: 0 };
    expect(stopLineOverlapsRoundedRect(tick, { ...rect, w: 11, h: 11 })).toBe(true);
    expect(stopLineOverlapsRoundedRect(tick, { ...rect, w: 11, h: 11, radius: 4 })).toBe(false);
  });

  it("treats a segment as a round-capped stroke", () => {
    const segment = { kind: "segment" as const, x0: -5, y0: 12, x1: 15, y1: 12, halfWidth: 1 };
    expect(stopLineOverlapsRoundedRect(segment, rect)).toBe(false);
    expect(stopLineOverlapsRoundedRect({ ...segment, halfWidth: 2.5 }, rect)).toBe(true);
    expect(stopLineOverlapsRoundedRect({ ...segment, x0: 5, y0: -5, x1: 5, y1: 15 }, rect)).toBe(true);
  });
});
