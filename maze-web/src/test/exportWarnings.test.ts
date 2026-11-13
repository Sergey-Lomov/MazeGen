import { DEFAULT_CREASE_STYLE, DEFAULT_GLUE_TAB_STYLE, DEFAULT_EDGE_MARKER_STYLE } from "../store/slices/imageExportDefaults";
import { describe, it, expect, vi } from "vitest";
import { computeVectorByWallsWarnings, computeVectorByWallsWarningsAcrossFloors, computeVectorByCorridorsWarnings, computeTextFitItemsAcrossFloors, computeTextOverflowWarningsAcrossFloors, TEXT_OVERFLOW_WARNING_ID } from "../pixi/selectors/exportWarnings";
import { selectNodeLevelResolver } from "../pixi/selectors/mazeSelectors/state";
import type { NodeDto, EdgeDto } from "../wasm/types";
import type { FieldConfig } from "../fieldConfig";
import type { VectorByWallsSettings, VectorByCorridorsSettings, MarkerSettings } from "../store/storeTypes";
import { canvas } from "../pixi/colorTokens";
import { hasLowContrast, perceptualColorDistance } from "../pixi/colorContrast";
import { DEFAULT_SHARED_STYLE_SOURCE, DEFAULT_VERTICAL_SETTINGS, DEFAULT_VERTICAL_DECORATIVE_SETTINGS, DEFAULT_VERTICAL_SHARED_STYLE, DEFAULT_MARKER_INDEX_SETTINGS, DEFAULT_FLOOR_LABEL_SETTINGS } from "../store/slices/imageExportSlice";
import { DEFAULT_VECTOR_BY_WALLS_LINKS, DEFAULT_VECTOR_BY_CORRIDORS_LINKS } from "../store/slices/parameterLinksDefaults";
import { bridgeSplitNodes, bridgeSplitEdges } from "./splitTopologyFixtures";
import { fieldOf } from "./fieldConfigFixtures";

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
const e = (from: number, to: number): EdgeDto => ({ from, to, kind: "basic" });
const teleport = (from: number, to: number): EdgeDto => ({ from, to, kind: "teleport" });
const squareCfg: FieldConfig = fieldOf("square", { shape: "rect", cols: 6, rows: 6 });

const defaultMarker: MarkerSettings = {
  shape: "circle", cornerStyle: "miter", fillColor: canvas.node.start, borderColor: canvas.node.start,
  borderWidth: 0, gapWidth: 0, size: 12, sizeAdaptation: 0, text: "",
};

function baseSettings(overrides: Partial<VectorByWallsSettings> = {}): VectorByWallsSettings {
  return {
    background: 0, showGrid: true, gridColor: 0x808080, showCutLines: true, cutLinesGlueColor: true, cutLinesColor: 0x808080, creases: DEFAULT_CREASE_STYLE, glueTabs: DEFAULT_GLUE_TAB_STYLE, edgeMarkers: DEFAULT_EDGE_MARKER_STYLE, showInnerGrid: false, innerGridColor: 0x808080, floorColor: 0, wallColor: 0, randomWallColorMode: "off", wallJoin: "round", wallThickness: 4,
    oneWayPattern: "triangle", oneWayColor: 0, oneWayGapWidth: 3, oneWaySize: 12, oneWayThickness: 4, oneWayJoin: "round",
    markerLayout: "auto", markerScale: 1,
    startMarker: defaultMarker, finishMarker: defaultMarker,
    startOpening: { mode: "none", pattern: "triangle", color: 0, size: 12, thickness: 4, gapWidth: 3, join: "round" }, finishOpening: { mode: "none", pattern: "triangle", color: 0, size: 12, thickness: 4, gapWidth: 3, join: "round" },
    teleportMarker: { sizeAdaptation: 0, cornerStyle: "round", shape: "diamond", size: 6.4, fillColor: 0xff0000, borderColor: 0xff0000, borderWidth: 3, gapWidth: 3 },
    teleportConnectorColor: 0xff0000, teleportConnectorWidth: 3, teleportConnectorStyle: "orthogonal",
    teleportAvoidFieldExit: false, teleportMergeMode: true, teleportArrowMode: "periodic", teleportArrowPeriod: 5, teleportArrowSize: 10,
    teleportConnectorGapWidth: 3, teleportFloorBadge: { sizeAdaptation: 0, shape: "circle", labelType: "arabic", cornerStyle: "round", gapWidth: 3, size: 6.4, fillColor: 0x123456, borderColor: 0x123456, borderWidth: 3, textColor: 0x123456, textFont: { family: "", weight: 700 }, textSize: 12, textMargin: 1 }, teleportGroupCustomization: false, teleportGroupOverrides: {},
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
    background: 0, showGrid: true, gridColor: 0x808080, showCutLines: true, cutLinesGlueColor: true, cutLinesColor: 0x808080, creases: DEFAULT_CREASE_STYLE, glueTabs: DEFAULT_GLUE_TAB_STYLE, edgeMarkers: DEFAULT_EDGE_MARKER_STYLE,
    color: 0, thickness: 4, junctionRadius: 4, join: "round", renderStyle: "contour",
    markerLayout: "auto", markerScale: 1,
    startMarker: defaultMarker, finishMarker: defaultMarker,
    markerWidenPadding: 0, markerWidenShape: "match_marker",
    oneWayColor: 0, oneWayCount: 1, oneWayThickness: 4, oneWayGap: 4, oneWayWidth: 1, oneWayLength: 1, oneWayJoin: "round",
    teleportMarker: { sizeAdaptation: 0, cornerStyle: "round", shape: "diamond", size: 6.4, fillColor: 0xff0000, borderColor: 0xff0000, borderWidth: 3, gapWidth: 3 },
    teleportConnectorColor: 0xff0000, teleportConnectorWidth: 3, teleportConnectorStyle: "orthogonal",
    teleportAvoidFieldExit: false, teleportMergeMode: true, teleportArrowMode: "periodic", teleportArrowPeriod: 5, teleportArrowSize: 10,
    teleportConnectorGapWidth: 3, teleportFloorBadge: { sizeAdaptation: 0, shape: "circle", labelType: "arabic", cornerStyle: "round", gapWidth: 3, size: 6.4, fillColor: 0x123456, borderColor: 0x123456, borderWidth: 3, textColor: 0x123456, textFont: { family: "", weight: 700 }, textSize: 12, textMargin: 1 }, teleportGroupCustomization: false, teleportGroupOverrides: {},
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

const elevatorEdge = (from: number, to: number): EdgeDto => ({ from, to, kind: "elevator" });
const offBadges = { enabled: false } as const;

describe("elevator_indistinguishable (GitHub issue #471)", () => {
  // Two distinct elevator nodes sharing a cell on the drawn floor (already floor-scoped input).
  // Floor-scoped input (what the panel passes): only the drawn floor's nodes. Two distinct
  // elevator shafts land in cell (2,2) here.
  const nodes = [n(0, 2, 2, 0), n(1, 2, 2, 0)];
  const edges = [elevatorEdge(0, 2), elevatorEdge(1, 3)];

  it("fires when marker indices and elevator badges are both off", () => {
    const settings = baseSettings({ elevatorBadges: { ...DEFAULT_VERTICAL_SETTINGS.elevatorBadges, ...offBadges }, markerIndex: { ...DEFAULT_MARKER_INDEX_SETTINGS, enabled: false } });
    const warnings = computeVectorByWallsWarnings(nodes, edges, squareCfg, settings, null, null);
    const w = warnings.filter((x) => x.id === "elevator_indistinguishable");
    expect(w).toHaveLength(1);
    expect(w[0].nodes).toEqual([0, 1]);
  });

  it("does not fire when marker indices are enabled", () => {
    const settings = baseSettings({ elevatorBadges: { ...DEFAULT_VERTICAL_SETTINGS.elevatorBadges, ...offBadges }, markerIndex: { ...DEFAULT_MARKER_INDEX_SETTINGS, enabled: true } });
    const warnings = computeVectorByWallsWarnings(nodes, edges, squareCfg, settings, null, null);
    expect(warnings.filter((x) => x.id === "elevator_indistinguishable")).toHaveLength(0);
  });

  it("still fires when marker indices are enabled but elevator coverage is off", () => {
    const settings = baseSettings({
      elevatorBadges: { ...DEFAULT_VERTICAL_SETTINGS.elevatorBadges, ...offBadges },
      markerIndex: { ...DEFAULT_MARKER_INDEX_SETTINGS, enabled: true, coverage: { ...DEFAULT_MARKER_INDEX_SETTINGS.coverage, elevator: false } },
    });
    const warnings = computeVectorByWallsWarnings(nodes, edges, squareCfg, settings, null, null);
    expect(warnings.filter((x) => x.id === "elevator_indistinguishable")).toHaveLength(1);
  });

  it("does not fire when elevator badges are enabled", () => {
    const settings = baseSettings({ markerIndex: { ...DEFAULT_MARKER_INDEX_SETTINGS, enabled: false } });
    const warnings = computeVectorByWallsWarnings(nodes, edges, squareCfg, settings, null, null);
    expect(warnings.filter((x) => x.id === "elevator_indistinguishable")).toHaveLength(0);
  });

  it("does not fire for a single elevator node in a cell", () => {
    const single = [n(0, 2, 2, 0)];
    const settings = baseSettings({ elevatorBadges: { ...DEFAULT_VERTICAL_SETTINGS.elevatorBadges, ...offBadges }, markerIndex: { ...DEFAULT_MARKER_INDEX_SETTINGS, enabled: false } });
    const warnings = computeVectorByWallsWarnings(single, [elevatorEdge(0, 2)], squareCfg, settings, null, null);
    expect(warnings.filter((x) => x.id === "elevator_indistinguishable")).toHaveLength(0);
  });

  it("is also emitted by computeVectorByCorridorsWarnings", () => {
    const settings = baseCorridorsSettings({ elevatorBadges: { ...DEFAULT_VERTICAL_SETTINGS.elevatorBadges, ...offBadges }, markerIndex: { ...DEFAULT_MARKER_INDEX_SETTINGS, enabled: false } });
    const warnings = computeVectorByCorridorsWarnings(nodes, edges, squareCfg, settings, null, null);
    expect(warnings.filter((x) => x.id === "elevator_indistinguishable")).toHaveLength(1);
  });
});

describe("computeVectorByWallsWarnings", () => {
  describe("glue tab contrast", () => {
    const tabs = (patch: Partial<typeof DEFAULT_GLUE_TAB_STYLE>) => baseSettings({ background: 0xffffff, glueTabs: { ...DEFAULT_GLUE_TAB_STYLE, showTabs: true, fillColor: 0x202020, lineColor: 0x202020, lineWidth: 1, ...patch } });
    const ids = (settings: VectorByWallsSettings) => computeVectorByWallsWarnings([n(0, 0, 0)], [], squareCfg, settings, null, null).map((warning) => warning.id);

    it("warns when the outline matches the fill, but not about the background", () => {
      expect(ids(tabs({}))).toContain("glue_tab_outline_low_contrast_fill");
      expect(ids(tabs({ fillColor: 0xffffff }))).not.toContain("glue_tab_fill_low_contrast_background");
    });

    it("warns about a fill matching the background only without an outline", () => {
      const noLine = ids(tabs({ lineWidth: 0, fillColor: 0xffffff }));
      expect(noLine).toContain("glue_tab_fill_low_contrast_background");
      expect(noLine).not.toContain("glue_tab_outline_low_contrast_fill");
      expect(ids(tabs({ lineWidth: 1, lineColor: 0, fillColor: 0xffffff }))).not.toContain("glue_tab_fill_low_contrast_background");
    });

    it("stays silent when no floor has a glue", () => {
      const settings = tabs({ lineWidth: 0, fillColor: 0xffffff });
      const withoutGlues = computeVectorByWallsWarnings([n(0, 0, 0)], [], squareCfg, settings, null, null, undefined, undefined, undefined, true, [], false);
      expect(withoutGlues.some((warning) => warning.id.startsWith("glue_tab"))).toBe(false);
      expect(ids(settings)).toContain("glue_tab_fill_low_contrast_background");
    });

    it("stays silent while the tabs are hidden", () => {
      expect(ids(tabs({ showTabs: false, lineWidth: 0, fillColor: 0xffffff })).some((id) => id.startsWith("glue_tab"))).toBe(false);
    });
  });

  describe("inner grid contrast", () => {
    it("checks the independent inner-grid color against both floor and wall surfaces", () => {
      const settings = baseSettings({ showInnerGrid: true, innerGridColor: 0, floorColor: 0, wallColor: 0 });
      const warnings = computeVectorByWallsWarnings([n(0, 0, 0)], [], squareCfg, settings, null, null);
      expect(warnings.map((warning) => warning.id)).toEqual(expect.arrayContaining([
        "inner_grid_low_contrast_floor", "inner_grid_low_contrast_wall",
      ]));
    });

    it("does not check the inner-grid color when its independent toggle is off", () => {
      const settings = baseSettings({ showInnerGrid: false, innerGridColor: 0, floorColor: 0, wallColor: 0 });
      const warnings = computeVectorByWallsWarnings([n(0, 0, 0)], [], squareCfg, settings, null, null);
      expect(warnings.some((warning) => warning.id.startsWith("inner_grid_low_contrast"))).toBe(false);
    });
  });

  describe("teleport_marker_invisible", () => {
    it("flags a one-way teleport's exit endpoint when border width is 0 (its fill mirrors floor color)", () => {
      const nodes = [n(0, 0, 0), n(1, 3, 3)];
      const edges = [teleport(0, 1)]; // one-way: node 1 is the exit-only ("outline") endpoint
      const settings = baseSettings({ teleportMarker: { ...baseSettings().teleportMarker, borderWidth: 0 } });
      const warnings = computeVectorByWallsWarnings(nodes, edges, squareCfg, settings, null, null);
      const w = warnings.filter((w) => w.id === "teleport_marker_invisible");
      expect(w).toHaveLength(1);
      expect(w[0].nodes).toEqual([1]);
    });

    it("does not flag a two-way teleport (both endpoints always filled, regardless of border)", () => {
      const nodes = [n(0, 0, 0), n(1, 3, 3)];
      const edges = [teleport(0, 1), teleport(1, 0)];
      const settings = baseSettings({ teleportMarker: { ...baseSettings().teleportMarker, borderWidth: 0 } });
      const warnings = computeVectorByWallsWarnings(nodes, edges, squareCfg, settings, null, null);
      expect(warnings.filter((w) => w.id === "teleport_marker_invisible")).toHaveLength(0);
    });

    it("does not flag when border width keeps the exit marker's outline visible", () => {
      const nodes = [n(0, 0, 0), n(1, 3, 3)];
      const edges = [teleport(0, 1)];
      const settings = baseSettings({ teleportMarker: { ...baseSettings().teleportMarker, borderWidth: 3 } });
      const warnings = computeVectorByWallsWarnings(nodes, edges, squareCfg, settings, null, null);
      expect(warnings.filter((w) => w.id === "teleport_marker_invisible")).toHaveLength(0);
    });

    it("no teleports present -> no warning even with border at 0", () => {
      const nodes = [n(0, 0, 0), n(1, 3, 3)];
      const settings = baseSettings({ teleportMarker: { ...baseSettings().teleportMarker, borderWidth: 0 } });
      const warnings = computeVectorByWallsWarnings(nodes, [], squareCfg, settings, null, null);
      expect(warnings.filter((w) => w.id === "teleport_marker_invisible")).toHaveLength(0);
    });
  });

  describe("teleport_group_ambiguous", () => {
    it("collapses two colliding groups into a single warning covering both", () => {
      const nodes = [n(0, 0, 0), n(1, 1, 1), n(2, 4, 4), n(3, 5, 5)];
      const edges = [teleport(0, 1), teleport(2, 3)];
      const settings = baseSettings({ teleportConnectorStyle: "none" });
      const warnings = computeVectorByWallsWarnings(nodes, edges, squareCfg, settings, null, null);
      const matches = warnings.filter((w) => w.id === "teleport_group_ambiguous");
      expect(matches).toHaveLength(1);
      expect(matches[0].nodes.sort()).toEqual([0, 1, 2, 3]);
    });

    it("does not flag when a connector is drawn (groups distinguishable by link)", () => {
      const nodes = [n(0, 0, 0), n(1, 1, 1), n(2, 4, 4), n(3, 5, 5)];
      const edges = [teleport(0, 1), teleport(2, 3)];
      const settings = baseSettings({ teleportConnectorStyle: "orthogonal" });
      const warnings = computeVectorByWallsWarnings(nodes, edges, squareCfg, settings, null, null);
      expect(warnings.filter((w) => w.id === "teleport_group_ambiguous")).toHaveLength(0);
    });

    it("does not flag distinct-looking groups", () => {
      const nodes = [n(0, 0, 0), n(1, 1, 1), n(2, 4, 4), n(3, 5, 5)];
      const edges = [teleport(0, 1), teleport(2, 3)];
      const settings = baseSettings({
        teleportConnectorStyle: "none",
        teleportGroupOverrides: { [`0-1`]: { fillColor: 0x00ff00 } },
      });
      const warnings = computeVectorByWallsWarnings(nodes, edges, squareCfg, settings, null, null);
      expect(warnings.filter((w) => w.id === "teleport_group_ambiguous")).toHaveLength(0);
    });
  });

  describe("teleport_merged_without_connectors", () => {
    const nodes = [n(0, 0, 0), n(1, 1, 1), n(2, 4, 4)];
    const sharing = [teleport(0, 1), teleport(0, 2)];
    const run = (edges: ReturnType<typeof teleport>[], over: Parameters<typeof baseSettings>[0]) =>
      computeVectorByWallsWarnings(nodes, edges, squareCfg, baseSettings(over), null, null)
        .filter((w) => w.id === "teleport_merged_without_connectors");

    it("flags merged teleports when connectors are disabled", () => {
      const matches = run(sharing, { teleportConnectorStyle: "none", teleportMergeMode: true });
      expect(matches).toHaveLength(1);
      expect(matches[0].nodes.sort()).toEqual([0]);
    });

    it("does not flag with merge mode off, connectors on, or no shared cell", () => {
      expect(run(sharing, { teleportConnectorStyle: "none", teleportMergeMode: false })).toHaveLength(0);
      expect(run(sharing, { teleportConnectorStyle: "straight", teleportMergeMode: true })).toHaveLength(0);
      expect(run([teleport(0, 1)], { teleportConnectorStyle: "none", teleportMergeMode: true })).toHaveLength(0);
    });
  });

  describe("teleport_waypoint_overlap", () => {
    it("flags when a teleport marker's footprint overlaps the start marker", () => {
      const nodes = [n(0, 0, 0), n(1, 5, 5)];
      const edges = [teleport(0, 1)];
      // start sits at node 0's own position; the markers are so big the layout can't fit them in the cell,
      // so they stay stacked (distance 0) and definitely overlap.
      const settings = baseSettings({ teleportMarker: { ...baseSettings().teleportMarker, size: 200, borderWidth: 2 } });
      const warnings = computeVectorByWallsWarnings(nodes, edges, squareCfg, settings, 0, null);
      const matches = warnings.filter((w) => w.id === "teleport_waypoint_overlap");
      expect(matches).toHaveLength(1);
      expect(matches[0].nodes.sort()).toEqual([0]);
    });

    it("collapses overlaps with both start and finish into one warning", () => {
      const nodes = [n(0, 0, 0), n(1, 5, 5)];
      const edges = [teleport(0, 1)];
      const settings = baseSettings({ teleportMarker: { ...baseSettings().teleportMarker, size: 200, borderWidth: 2 } });
      // Both start and finish sit exactly on the teleport's two endpoints -> two overlaps, one warning.
      const warnings = computeVectorByWallsWarnings(nodes, edges, squareCfg, settings, 0, 1);
      const matches = warnings.filter((w) => w.id === "teleport_waypoint_overlap");
      expect(matches).toHaveLength(1);
      expect(matches[0].nodes.sort()).toEqual([0, 1]);
    });

    it("does not flag when the marker layout separates a start stacked on a teleport point (GitHub issue #735)", () => {
      const nodes = [n(0, 0, 0), n(1, 5, 5)];
      const edges = [teleport(0, 1)];
      const settings = baseSettings({ teleportMarker: { ...baseSettings().teleportMarker, size: 12, borderWidth: 2 } });
      const warnings = computeVectorByWallsWarnings(nodes, edges, squareCfg, settings, 0, null);
      expect(warnings.filter((w) => w.id === "teleport_waypoint_overlap")).toHaveLength(0);
    });

    it("does not flag when start/finish are far from any teleport endpoint", () => {
      const nodes = [n(0, 0, 0), n(1, 1, 1), n(2, 5, 5)];
      const edges = [teleport(0, 1)];
      const settings = baseSettings();
      const warnings = computeVectorByWallsWarnings(nodes, edges, squareCfg, settings, 2, null);
      expect(warnings.filter((w) => w.id === "teleport_waypoint_overlap")).toHaveLength(0);
    });

    it("does not flag (and does not throw) when start/finish is a stale id absent from nodes", () => {
      const nodes = [n(0, 0, 0), n(1, 5, 5)];
      const edges = [teleport(0, 1)];
      const settings = baseSettings({ teleportMarker: { ...baseSettings().teleportMarker, size: 12, borderWidth: 2 } });
      const warnings = computeVectorByWallsWarnings(nodes, edges, squareCfg, settings, 99, null);
      expect(warnings.filter((w) => w.id === "teleport_waypoint_overlap")).toHaveLength(0);
    });
  });

  it("does not add warnings when waypoint, teleport and vertical markers use special split anchors", () => {
    const nodes = [...bridgeSplitNodes, n(7, 8, 8, 1)];
    const edges: EdgeDto[] = [
      ...bridgeSplitEdges,
      teleport(0, 7),
      { from: 0, to: 7, kind: "vertical_passage" },
    ];
    const wallsSettings = baseSettings({
      background: 0x111111, gridColor: 0x777777, floorColor: 0x000000,
      splitNodeColors: [0xffffff, 0x00ff00], splitSpecialShapes: true,
    });
    const corridorsSettings = baseCorridorsSettings({
      background: 0x111111, gridColor: 0x777777, color: 0x000000,
      splitNodeColors: [0xffffff, 0x00ff00], splitSpecialShapes: true,
    });
    const wallWarnings = computeVectorByWallsWarnings(nodes, edges, squareCfg, wallsSettings, 0, null);
    const wallWarningsWithoutSpecialShapes = computeVectorByWallsWarnings(
      nodes, edges, squareCfg, { ...wallsSettings, splitSpecialShapes: false }, 0, null,
    );
    const corridorWarnings = computeVectorByCorridorsWarnings(nodes, edges, squareCfg, corridorsSettings, 0, null);
    const corridorWarningsWithoutSpecialShapes = computeVectorByCorridorsWarnings(
      nodes, edges, squareCfg, { ...corridorsSettings, splitSpecialShapes: false }, 0, null,
    );

    expect(wallWarnings).toEqual(wallWarningsWithoutSpecialShapes);
    expect(corridorWarnings).toEqual(corridorWarningsWithoutSpecialShapes);
  });

  describe("elevator_badges_overlap", () => {
    // Elevator at node 0 (floor 0) reaching 3 other floors — with a large badge size and zero
    // distance, the "left_right" row's badges necessarily overlap (row step = 2*badgeRadius,
    // touching by construction; a larger radius than the default step forces real overlap).
    const elevatorNodes = [n(0, 0, 0, 0), n(1, 1, 0, 1), n(2, 2, 0, 2), n(3, 3, 0, 3)];
    const elevatorEdges: EdgeDto[] = [
      { from: 0, to: 1, kind: "elevator" },
      { from: 0, to: 2, kind: "elevator" },
      { from: 0, to: 3, kind: "elevator" },
    ];

    it("flags an elevator whose badge ring overlaps itself", () => {
      // "full_circle" is the only placement where the layout math itself doesn't guarantee
      // touching-not-overlapping spacing (left_right/top_bottom always space consecutive badges
      // exactly 2*radius apart by construction). As badge size grows past the marker's own
      // radius, the ring radius converges on the badge radius itself, so the chord between
      // adjacent badges (2*ring*sin(pi/count)) falls below 2*radius for count=3 — `size` isn't
      // clamped to the settings-panel slider's 0.1-1 UI range, so a large value here isolates the
      // geometry from the marker radius entirely.
      const settings = baseSettings({
        elevatorBadges: { enabled: true, labelType: "arabic", size: 400, placement: "full_circle", distance: 0, gap: 0, gapWidth: 0, cornerStyle: "round", evenDistribution: true, shape: "circle", fillColor: 0, borderColor: 0x555555, borderWidth: 0, textColor: 0, textFont: { family: "", weight: 700 }, textSize: 16.66, textMargin: 1 },
      });
      const warnings = computeVectorByWallsWarnings(elevatorNodes, elevatorEdges, squareCfg, settings, null, null, elevatorNodes);
      const matches = warnings.filter((w) => w.id === "elevator_badges_overlap");
      expect(matches).toHaveLength(1);
      expect(matches[0].nodes).toEqual([0]);
      // The overlap is rendered around node 0 itself, so the warning lists only that floor;
      // reaching other floors does not make their elevator marker invalid.
      expect(matches[0].crossFloorTargets).toEqual([{ nodeId: 0, targetFloorIndex: 0 }]);
    });

    it("does not flag when badges is disabled", () => {
      const settings = baseSettings({
        elevatorBadges: { enabled: false, labelType: "arabic", size: 1, placement: "full_circle", distance: 0, gap: 0, gapWidth: 0, cornerStyle: "round", evenDistribution: true, shape: "circle", fillColor: 0, borderColor: 0x555555, borderWidth: 0, textColor: 0, textFont: { family: "", weight: 700 }, textSize: 16.66, textMargin: 1 },
      });
      const warnings = computeVectorByWallsWarnings(elevatorNodes, elevatorEdges, squareCfg, settings, null, null, elevatorNodes);
      expect(warnings.filter((w) => w.id === "elevator_badges_overlap")).toHaveLength(0);
    });

    it("does not flag when badges have enough room (large distance, small size)", () => {
      const settings = baseSettings({
        elevatorBadges: { enabled: true, labelType: "arabic", size: 0.1, placement: "full_circle", distance: 20, gap: 0, gapWidth: 0, cornerStyle: "round", evenDistribution: true, shape: "circle", fillColor: 0, borderColor: 0x555555, borderWidth: 0, textColor: 0, textFont: { family: "", weight: 700 }, textSize: 16.66, textMargin: 1 },
      });
      const warnings = computeVectorByWallsWarnings(elevatorNodes, elevatorEdges, squareCfg, settings, null, null, elevatorNodes);
      expect(warnings.filter((w) => w.id === "elevator_badges_overlap")).toHaveLength(0);
    });

    it("flags a merged uneven ring when its closing gap is tighter than its ordinary badge gaps", () => {
      // Ring radius 8.5 (marker) + 0.5 (badge) = 9; a 17px chord steps ~144 degrees, so 3 badges leave a closing gap tighter than the others.
      const settings = baseSettings({
        elevatorBadges: { enabled: true, labelType: "arabic", size: 1, backing: "shared", placement: "full_circle", distance: 0, gap: 16, gapWidth: 0, cornerStyle: "round", evenDistribution: false, shape: "circle", fillColor: 0, borderColor: 0x555555, borderWidth: 0, textColor: 0, textFont: { family: "", weight: 700 }, textSize: 16.66, textMargin: 1 },
      });
      const warnings = computeVectorByWallsWarnings(elevatorNodes, elevatorEdges, squareCfg, settings, null, null, elevatorNodes);
      const matches = warnings.filter((w) => w.id === "elevator_badges_merged_end_gap_too_small");
      expect(matches).toHaveLength(1);
      expect(matches[0].nodes).toEqual([0]);
    });

    it("warns when an uneven circular layout must fall back to even distribution", () => {
      // A 21px chord on a ring of radius 9 needs a step of 180+ degrees, so 3 badges cannot sit in one arc.
      const settings = baseSettings({
        elevatorBadges: { enabled: true, labelType: "arabic", size: 1, placement: "full_circle", distance: 0, gap: 20, gapWidth: 0, cornerStyle: "round", evenDistribution: false, shape: "circle", fillColor: 0, borderColor: 0x555555, borderWidth: 0, textColor: 0, textFont: { family: "", weight: 700 }, textSize: 16.66, textMargin: 1 },
      });
      const warnings = computeVectorByWallsWarnings(elevatorNodes, elevatorEdges, squareCfg, settings, null, null, elevatorNodes);
      const matches = warnings.filter((w) => w.id === "elevator_badges_gap_falls_back_to_even_distribution");
      expect(matches).toHaveLength(1);
      expect(matches[0].nodes).toEqual([0]);
    });

    it("when only the floor-scoped source node is visible (targets' floors unresolvable), no overlap can be detected", () => {
      // Mirrors a real floor-scoped `nodes` list: only node 0 (the elevator's own `from`, on the
      // active floor) is present — the fan's targets on other floors are structurally absent, so
      // without a separate unscoped node list their floors can't resolve at all.
      const settings = baseSettings({
        elevatorBadges: { enabled: true, labelType: "arabic", size: 1, placement: "left_right", distance: 0, gap: 0, gapWidth: 0, cornerStyle: "round", evenDistribution: true, shape: "circle", fillColor: 0, borderColor: 0x555555, borderWidth: 0, textColor: 0, textFont: { family: "", weight: 700 }, textSize: 16.66, textMargin: 1 },
      });
      const warnings = computeVectorByWallsWarnings([elevatorNodes[0]], elevatorEdges, squareCfg, settings, null, null);
      expect(warnings.filter((w) => w.id === "elevator_badges_overlap")).toHaveLength(0);
    });
  });

  describe("elevator_badges_too_many", () => {
    const elevatorNodes = [n(0, 0, 0, 0), n(1, 1, 0, 1), n(2, 2, 0, 2), n(3, 3, 0, 3)];
    const elevatorEdges: EdgeDto[] = [
      { from: 0, to: 1, kind: "elevator" },
      { from: 0, to: 2, kind: "elevator" },
      { from: 0, to: 3, kind: "elevator" },
    ];

    it("flags a left_right elevator whose one side exceeds slotsPerRow capacity", () => {
      // Large size -> huge badgeRadius -> slotsPerRow capacity 1; 3 floors split 2/1 between
      // sides, so the 2-badge side overflows.
      const settings = baseSettings({
        elevatorBadges: { enabled: true, labelType: "arabic", size: 400, placement: "left_right", distance: 0, gap: 0, gapWidth: 0, cornerStyle: "round", evenDistribution: true, shape: "circle", fillColor: 0, borderColor: 0x555555, borderWidth: 0, textColor: 0, textFont: { family: "", weight: 700 }, textSize: 16.66, textMargin: 1 },
      });
      const warnings = computeVectorByWallsWarnings(elevatorNodes, elevatorEdges, squareCfg, settings, null, null, elevatorNodes);
      const matches = warnings.filter((w) => w.id === "elevator_badges_too_many");
      expect(matches).toHaveLength(1);
      expect(matches[0].nodes).toEqual([0]);
      expect(matches[0].crossFloorTargets).toEqual([{ nodeId: 0, targetFloorIndex: 0 }]);
    });

    it("never fires for full_circle", () => {
      const settings = baseSettings({
        elevatorBadges: { enabled: true, labelType: "arabic", size: 400, placement: "full_circle", distance: 0, gap: 0, gapWidth: 0, cornerStyle: "round", evenDistribution: true, shape: "circle", fillColor: 0, borderColor: 0x555555, borderWidth: 0, textColor: 0, textFont: { family: "", weight: 700 }, textSize: 16.66, textMargin: 1 },
      });
      const warnings = computeVectorByWallsWarnings(elevatorNodes, elevatorEdges, squareCfg, settings, null, null, elevatorNodes);
      expect(warnings.filter((w) => w.id === "elevator_badges_too_many")).toHaveLength(0);
    });

    it("does not flag when badges fit within one row per side", () => {
      const settings = baseSettings({
        elevatorBadges: { enabled: true, labelType: "arabic", size: 0.1, placement: "left_right", distance: 0, gap: 0, gapWidth: 0, cornerStyle: "round", evenDistribution: true, shape: "circle", fillColor: 0, borderColor: 0x555555, borderWidth: 0, textColor: 0, textFont: { family: "", weight: 700 }, textSize: 16.66, textMargin: 1 },
      });
      const warnings = computeVectorByWallsWarnings(elevatorNodes, elevatorEdges, squareCfg, settings, null, null, elevatorNodes);
      expect(warnings.filter((w) => w.id === "elevator_badges_too_many")).toHaveLength(0);
    });
  });
});

describe("computeVectorByCorridorsWarnings", () => {
  describe("split_gap_may_shrink", () => {
    it("flags when corridor width plus both gap sides exceeds 40px", () => {
      const settings = baseCorridorsSettings({ thickness: 35, splitGapWidth: 3 });
      const warnings = computeVectorByCorridorsWarnings([], [], squareCfg, settings, null, null);
      expect(warnings.filter((w) => w.id === "split_gap_may_shrink")).toHaveLength(1);
    });

    it("does not flag exactly 40px", () => {
      const settings = baseCorridorsSettings({ thickness: 34, splitGapWidth: 3 });
      const warnings = computeVectorByCorridorsWarnings([], [], squareCfg, settings, null, null);
      expect(warnings.filter((w) => w.id === "split_gap_may_shrink")).toHaveLength(0);
    });

    it("does not attach maze entities to the settings warning", () => {
      const settings = baseCorridorsSettings({ thickness: 35, splitGapWidth: 3 });
      const warning = computeVectorByCorridorsWarnings([], [], squareCfg, settings, null, null)
        .find((w) => w.id === "split_gap_may_shrink");
      expect(warning?.nodes).toEqual([]);
      expect(warning?.edges).toEqual([]);
    });
  });

  describe("one_way_arrows_overflow_corridor", () => {
    it("flags a one-way passage when the chevron row's length exceeds TILE_SIZE", () => {
      const nodes = [n(0, 0, 0), n(1, 1, 0)];
      const edges = [e(0, 1)]; // one-way: no reverse edge
      // fullWidth = 1*10 = 10, lengthPx = 5*10 = 50; rowStep = 50+5+10 = 65;
      // rowLength = 9*65 + 50+10 = 645 > TILE_SIZE
      const settings = baseCorridorsSettings({ oneWayCount: 10, oneWayLength: 5, oneWayGap: 5, oneWayThickness: 10, oneWayWidth: 1 });
      const warnings = computeVectorByCorridorsWarnings(nodes, edges, squareCfg, settings, null, null);
      const matches = warnings.filter((w) => w.id === "one_way_arrows_overflow_corridor");
      expect(matches).toHaveLength(1);
      expect(matches[0].nodes.sort()).toEqual([0, 1]);
      expect(matches[0].edges).toEqual([[0, 1]]);
    });

    it("flags a one-way passage when oneWayWidth exceeds 1", () => {
      const nodes = [n(0, 0, 0), n(1, 1, 0)];
      const edges = [e(0, 1)];
      const settings = baseCorridorsSettings({ oneWayWidth: 1.5 });
      const warnings = computeVectorByCorridorsWarnings(nodes, edges, squareCfg, settings, null, null);
      expect(warnings.filter((w) => w.id === "one_way_arrows_overflow_corridor")).toHaveLength(1);
    });

    it("does not flag when the row fits within a cell", () => {
      const nodes = [n(0, 0, 0), n(1, 1, 0)];
      const edges = [e(0, 1)];
      // fullWidth = 1*4 = 4, lengthPx = 1*4 = 4; rowLength (count=1) = 4+4 = 8 < TILE_SIZE
      const settings = baseCorridorsSettings({ oneWayCount: 1, oneWayLength: 1, oneWayGap: 4, oneWayWidth: 1 });
      const warnings = computeVectorByCorridorsWarnings(nodes, edges, squareCfg, settings, null, null);
      expect(warnings.filter((w) => w.id === "one_way_arrows_overflow_corridor")).toHaveLength(0);
    });

    it("does not flag a bidirectional passage even with overflowing settings", () => {
      const nodes = [n(0, 0, 0), n(1, 1, 0)];
      const edges = [e(0, 1), e(1, 0)];
      const settings = baseCorridorsSettings({ oneWayCount: 10, oneWayLength: 20, oneWayGap: 5 });
      const warnings = computeVectorByCorridorsWarnings(nodes, edges, squareCfg, settings, null, null);
      expect(warnings.filter((w) => w.id === "one_way_arrows_overflow_corridor")).toHaveLength(0);
    });
  });

  // GitHub issue #313 follow-up bugfix: this mode reuses `TeleportRenderer` as-is, so it can hit
  // the same teleport caveats "Vector by walls" already flags — previously not detected at all.
  describe("teleport warnings (shared with computeVectorByWallsWarnings)", () => {
    it("flags ambiguous teleport groups when there is no connector to tell them apart", () => {
      const nodes = [n(0, 0, 0), n(1, 1, 1), n(2, 3, 3), n(3, 4, 4)];
      const edges = [teleport(0, 1), teleport(2, 3)];
      const settings = baseCorridorsSettings({ teleportConnectorStyle: "none" });
      const warnings = computeVectorByCorridorsWarnings(nodes, edges, squareCfg, settings, null, null);
      expect(warnings.filter((w) => w.id === "teleport_group_ambiguous")).toHaveLength(1);
    });

    it("flags an invisible one-way teleport exit marker when border width is 0", () => {
      const nodes = [n(0, 0, 0), n(1, 3, 3)];
      const edges = [teleport(0, 1)];
      const settings = baseCorridorsSettings({ teleportMarker: { ...baseCorridorsSettings().teleportMarker, borderWidth: 0 } });
      const warnings = computeVectorByCorridorsWarnings(nodes, edges, squareCfg, settings, null, null);
      expect(warnings.filter((w) => w.id === "teleport_marker_invisible")).toHaveLength(1);
    });

    it("flags a teleport marker overlapping the start marker's footprint", () => {
      const nodes = [n(0, 0, 0), n(1, 0, 0), n(2, 3, 3)];
      const edges = [teleport(1, 2)];
      const settings = baseCorridorsSettings({ teleportMarker: { ...baseCorridorsSettings().teleportMarker, size: 32 } });
      const warnings = computeVectorByCorridorsWarnings(nodes, edges, squareCfg, settings, 0, null);
      expect(warnings.filter((w) => w.id === "teleport_waypoint_overlap")).toHaveLength(1);
    });
  });

  describe("marker extension warnings (GitHub issue #802)", () => {
    it("flags a start marker extension that reaches another corridor", () => {
      const nodes = [n(0, 0, 0), n(1, 0, 1), n(2, 1, 1)];
      const settings = baseCorridorsSettings({ markerWidenPadding: 34 });
      const warnings = computeVectorByCorridorsWarnings(nodes, [e(1, 2), e(2, 1)], squareCfg, settings, 0, null);
      const warning = warnings.find((item) => item.id === "marker_extension_hits_corridor");

      expect(warning?.nodes).toEqual([0]);
      expect(warning?.edges).toEqual([]);
    });

    it("does not flag a hidden start marker, which has no extension (GitHub issue #963)", () => {
      const nodes = [n(0, 0, 0), n(1, 0, 1), n(2, 1, 1)];
      const settings = baseCorridorsSettings({ markerWidenPadding: 34, startMarker: { ...defaultMarker, markerEnabled: false } });
      const warnings = computeVectorByCorridorsWarnings(nodes, [e(1, 2), e(2, 1)], squareCfg, settings, 0, null);

      expect(warnings.some((item) => item.id === "marker_extension_hits_corridor")).toBe(false);
    });

    it("uses the rendered contour instead of the requested corridor thickness", () => {
      const nodes = [n(0, 0, 0), n(1, 0, 1), n(2, 1, 1)];
      const settings = baseCorridorsSettings({ thickness: 10, markerWidenPadding: 28 });
      const warnings = computeVectorByCorridorsWarnings(nodes, [e(1, 2), e(2, 1)], squareCfg, settings, 0, null);

      expect(warnings.some((item) => item.id === "marker_extension_hits_corridor")).toBe(false);
    });

    it("uses the rendered stroke width in legacy-line mode", () => {
      const nodes = [n(0, 0, 0), n(1, 0, 1), n(2, 1, 1)];
      const settings = baseCorridorsSettings({ renderStyle: "legacy_line", thickness: 10, markerWidenPadding: 29 });
      const warnings = computeVectorByCorridorsWarnings(nodes, [e(1, 2), e(2, 1)], squareCfg, settings, 0, null);

      expect(warnings.some((item) => item.id === "marker_extension_hits_corridor")).toBe(true);
    });

    it("does not flag the corridor attached to the marker itself", () => {
      const nodes = [n(0, 0, 0), n(1, 1, 0)];
      const settings = baseCorridorsSettings({ markerWidenPadding: 34 });
      const warnings = computeVectorByCorridorsWarnings(nodes, [e(0, 1), e(1, 0)], squareCfg, settings, 0, null);

      expect(warnings.some((item) => item.id === "marker_extension_hits_corridor")).toBe(false);
    });
  });

  describe("color contrast warnings", () => {
    it("does not flag colors with a clearly visible luminance difference", () => {
      expect(hasLowContrast(0x666666, 0x333333)).toBe(false);
    });

    it("does not confuse different hues with near-identical colors", () => {
      expect(perceptualColorDistance(0xff0000, 0x0000ff)).toBeGreaterThan(0.04);
      expect(hasLowContrast(0xff0000, 0x0000ff)).toBe(false);
    });

    it("collapses multiple close split-color pairs into one warning", () => {
      const nodes = [
        n(0, 0, 0), n(1, 0, 0), n(2, 0, 0),
        n(3, 1, 0), n(4, -1, 0), n(5, 0, 1),
      ];
      const edges = [e(0, 3), e(3, 0), e(1, 4), e(4, 1), e(2, 5), e(5, 2)];
      const settings = baseCorridorsSettings({ splitNodeColors: [0x101010, 0x111111, 0x121212] });
      const warnings = computeVectorByCorridorsWarnings(nodes, edges, squareCfg, settings, null, null);

      expect(warnings.filter((w) => w.id === "split_colors_low_contrast_each_other")).toHaveLength(1);
    });

    it("does not compare the same default slot color across split points", () => {
      const nodes = [
        n(0, 0, 0), n(1, 0, 0), n(2, 1, 0), n(3, -1, 0),
        n(4, 5, 5), n(5, 5, 5), n(6, 6, 5), n(7, 4, 5),
      ];
      const edges = [
        e(0, 2), e(2, 0), e(1, 3), e(3, 1),
        e(4, 6), e(6, 4), e(5, 7), e(7, 5),
      ];
      const warnings = computeVectorByCorridorsWarnings(nodes, edges, squareCfg, baseCorridorsSettings(), null, null);

      expect(warnings.filter((w) => w.id === "split_colors_low_contrast_each_other")).toHaveLength(0);
    });

    it("flags corridor and one-way colors only when a drawable corridor exists", () => {
      const nodes = [n(0, 0, 0), n(1, 1, 0)];
      const settings = baseCorridorsSettings({ color: 0, oneWayColor: 0, background: 0 });
      const warnings = computeVectorByCorridorsWarnings(nodes, [e(0, 1)], squareCfg, settings, null, null);
      expect(warnings.map((w) => w.id)).toEqual(expect.arrayContaining([
        "one_way_low_contrast_corridor", "corridor_low_contrast_background",
      ]));
      const corridorWarning = warnings.find((w) => w.id === "corridor_low_contrast_background");
      expect(corridorWarning?.nodes).toEqual([]);
      expect(corridorWarning?.edges).toEqual([]);
    });

    it("does not flag the grid when it is disabled", () => {
      const settings = baseCorridorsSettings({ showGrid: false, background: 0, gridColor: 0 });
      const warnings = computeVectorByCorridorsWarnings([], [], squareCfg, settings, null, null);
      expect(warnings.filter((w) => w.id === "grid_low_contrast_background")).toHaveLength(0);
    });

    it("flags corridor teleport connector against the background only without a connector gap", () => {
      const nodes = [n(0, 0, 0), n(1, 2, 2)];
      const edges = [teleport(0, 1)];
      const settings = baseCorridorsSettings({ background: 0, color: 0, teleportConnectorColor: 0 });
      const withGap = computeVectorByCorridorsWarnings(nodes, edges, squareCfg, settings, null, null);
      expect(withGap.filter((w) => w.id === "teleport_connector_low_contrast_background")).toHaveLength(0);
      const noGap = computeVectorByCorridorsWarnings(nodes, edges, squareCfg, { ...settings, teleportConnectorGapWidth: 0 }, null, null);
      expect(noGap.filter((w) => w.id === "teleport_connector_low_contrast_background")).toHaveLength(1);
    });

    it("flags wall-mode teleport connector against the floor and wall under the requested gap rule", () => {
      const nodes = [n(0, 0, 0), n(1, 2, 2)];
      const edges = [teleport(0, 1)];
      const settings = baseSettings({ background: 0, floorColor: 0, wallColor: 0, teleportConnectorColor: 0, teleportConnectorGapWidth: 0 });
      const warnings = computeVectorByWallsWarnings(nodes, edges, squareCfg, settings, null, null);
      expect(warnings.map((w) => w.id)).toEqual(expect.arrayContaining([
        "teleport_connector_low_contrast_floor", "teleport_connector_low_contrast_wall",
      ]));
    });

    it("flags marker fill and label contrast using the immediate surface", () => {
      const nodes = [n(0, 0, 0), n(1, 1, 0)];
      const marker = { ...defaultMarker, fillColor: 0, borderColor: 0, borderWidth: 0 };
      const settings = baseCorridorsSettings({
        color: 0,
        markerLayout: "auto", markerScale: 1,
        startMarker: marker,
        elevatorBadges: { ...DEFAULT_VERTICAL_SETTINGS.elevatorBadges, enabled: true, fillColor: 0, textColor: 0 },
      });
      const warnings = computeVectorByCorridorsWarnings(nodes, [elevatorEdge(0, 1)], squareCfg, settings, 0, null);
      expect(warnings.filter((w) => w.id === "marker_fill_low_contrast_corridor")).toHaveLength(1);
      expect(warnings.filter((w) => w.id === "label_low_contrast")).toHaveLength(1);
      expect(warnings.filter((w) => w.id === "elevator_badge_fill_low_contrast_corridor")).toHaveLength(1);
    });

    it("flags teleport floor badge fill when its border is disabled", () => {
      const nodes = [n(0, 0, 0, 0), n(1, 2, 2, 1)];
      const settings = baseCorridorsSettings({
        color: 0,
        teleportFloorBadge: { ...baseCorridorsSettings().teleportFloorBadge, fillColor: 0, borderColor: 0xffffff, borderWidth: 0 },
      });
      const warnings = computeVectorByCorridorsWarnings(nodes, [teleport(0, 1)], squareCfg, settings, null, null);
      expect(warnings.filter((w) => w.id === "teleport_badge_fill_low_contrast_corridor")).toHaveLength(1);
    });

    it("does not flag teleport floor badge border when its border is disabled", () => {
      const nodes = [n(0, 0, 0, 0), n(1, 2, 2, 1)];
      const settings = baseCorridorsSettings({
        color: 0,
        teleportFloorBadge: { ...baseCorridorsSettings().teleportFloorBadge, fillColor: 0xffffff, borderColor: 0, borderWidth: 0 },
      });
      const warnings = computeVectorByCorridorsWarnings(nodes, [teleport(0, 1)], squareCfg, settings, null, null);
      expect(warnings.filter((w) => w.id.startsWith("teleport_badge_border_low_contrast"))).toHaveLength(0);
    });

    it("keeps separate alerts for different color pairs of one warning kind", () => {
      const settings = baseCorridorsSettings({
        color: 0,
        markerLayout: "auto", markerScale: 1,
        startMarker: { ...defaultMarker, fillColor: 0, borderColor: 0, borderWidth: 0 },
        finishMarker: { ...defaultMarker, fillColor: 0x000001, borderColor: 0x000001, borderWidth: 0 },
      });
      const warnings = computeVectorByCorridorsWarnings([n(0, 0, 0), n(1, 1, 0)], [], squareCfg, settings, 0, 1);
      const markerWarnings = warnings.filter((warning) => warning.id === "marker_fill_low_contrast_corridor");
      expect(markerWarnings).toHaveLength(2);
      expect(new Set(markerWarnings.map((warning) => warning.key)).size).toBe(2);
      expect(markerWarnings.every((warning) => warning.colorValues)).toBe(true);
    });

    it("flags an abstract two-way vertical arrow against its marker fill", () => {
      const nodes = [n(0, 0, 0, 0), n(1, 0, 0, 1)];
      const settings = baseSettings({
        twoWayArrowColor: 0,
        twoWayPassageMarker: { ...DEFAULT_VERTICAL_SETTINGS.twoWayPassageMarker, fillColor: 0 },
      });
      const warnings = computeVectorByWallsWarnings(
        nodes,
        [{ from: 0, to: 1, kind: "vertical_passage" }, { from: 1, to: 0, kind: "vertical_passage" }],
        squareCfg,
        settings,
        null,
        null,
      );
      expect(warnings.filter((w) => w.id === "vertical_arrow_low_contrast")).toHaveLength(1);
    });
  });
});

describe("text overflow warnings (GitHub issue #707)", () => {
  const nodes = [n(0, 0, 0, 0), n(1, 1, 0, 0)];
  const edges = [e(0, 1), e(1, 0)];
  const marker = (overrides: Partial<MarkerSettings>): MarkerSettings => ({ ...defaultMarker, size: 20, text: "S", ...overrides });
  const overflow = (settings: VectorByWallsSettings, start: number | null = 0, finish: number | null = 1) =>
    computeVectorByWallsWarnings(nodes, edges, squareCfg, settings, start, finish).filter((w) => w.id === "marker_text_overflow");

  it("flags a start/finish caption larger than its marker and highlights that node", () => {
    const settings = baseSettings({ startMarker: marker({ textSize: 32, textMargin: 1 }), finishMarker: marker({ textSize: 6, textMargin: 1 }) });
    const w = overflow(settings);
    expect(w).toHaveLength(1);
    expect(w[0].nodes).toEqual([0]);
  });

  it("does not flag a small caption, a hidden caption or an off-floor endpoint", () => {
    expect(overflow(baseSettings({ startMarker: marker({ textSize: 6, textMargin: 1 }), finishMarker: marker({ textSize: 6, textMargin: 1 }) }))).toHaveLength(0);
    expect(overflow(baseSettings({ startMarker: marker({ textSize: 32, textMargin: 1, textEnabled: false }), finishMarker: marker({ text: "" }) }))).toHaveLength(0);
    expect(overflow(baseSettings({ startMarker: marker({ textSize: 32, textMargin: 1 }) }), null, null)).toHaveLength(0);
  });

  it("skips captions on hidden start and finish markers in warnings and auto-fit (GitHub issue #977)", () => {
    const hiddenMarkers = {
      startMarker: marker({ markerEnabled: false, textSize: 32, textMargin: 1 }),
      finishMarker: marker({ markerEnabled: false, textSize: 32, textMargin: 1 }),
    };
    const settings = baseSettings(hiddenMarkers);
    expect(overflow(settings)).toHaveLength(0);
    expect(computeVectorByCorridorsWarnings(nodes, edges, squareCfg, baseCorridorsSettings(hiddenMarkers), 0, 1)
      .filter((warning) => warning.id === "marker_text_overflow")).toHaveLength(0);
    const items = computeTextFitItemsAcrossFloors(nodes, edges, [{ id: "f0" }], squareCfg, settings, 0, 1);
    expect(items.start).toEqual([]);
    expect(items.finish).toEqual([]);
  });

  it("auto-fit items of a caption with its own font hold a plain copy, not a tracked settings view", () => {
    const textFont = { family: "Georgia", weight: 700 };
    const settings = baseSettings({ startMarker: marker({ textFont, textSize: 20 }) });
    const [item] = computeTextFitItemsAcrossFloors(nodes, edges, [{ id: "f0" }], squareCfg, settings, 0, 1).start;
    expect(item.font).toEqual(textFont);
    expect(item.font).not.toBe(textFont);
  });

  it("text-only pass (GitHub issue #971) reports the text overflow warnings of the full pass and nothing else, in both modes", () => {
    const floors = [{ id: "f0" }];
    const startMarker = marker({ textSize: 32, textMargin: 1 });
    const textIds = new Set(Object.values(TEXT_OVERFLOW_WARNING_ID));
    const walls = baseSettings({ startMarker });
    const corridors = baseCorridorsSettings({ startMarker });
    const fullWalls = computeVectorByWallsWarningsAcrossFloors(nodes, edges, floors, squareCfg, walls, 0, 1).filter((w) => textIds.has(w.id));
    const onlyWalls = computeTextOverflowWarningsAcrossFloors("walls", nodes, edges, floors, squareCfg, walls, 0, 1);
    expect(onlyWalls.map((w) => w.id)).toEqual(["marker_text_overflow"]);
    expect(onlyWalls).toEqual(fullWalls);
    const onlyCorridors = computeTextOverflowWarningsAcrossFloors("corridors", nodes, edges, floors, squareCfg, corridors, 0, 1);
    expect(onlyCorridors.map((w) => w.id)).toEqual(["marker_text_overflow"]);
  });

  it("reports the same caveat in corridors mode", () => {
    const settings = baseCorridorsSettings({ startMarker: marker({ textSize: 32, textMargin: 1 }) });
    const w = computeVectorByCorridorsWarnings(nodes, edges, squareCfg, settings, 0, null).filter((x) => x.id === "marker_text_overflow");
    expect(w).toHaveLength(1);
  });

  it("flags oversized elevator floor badges once per target and highlights the elevator", () => {
    const elevatorNodes = [n(0, 0, 0, 0), n(1, 1, 0, 1), n(2, 2, 0, 2), n(3, 3, 0, 3)];
    const elevatorEdges: EdgeDto[] = [
      { from: 0, to: 1, kind: "elevator" },
      { from: 0, to: 2, kind: "elevator" },
      { from: 0, to: 3, kind: "elevator" },
    ];
    const badges = baseSettings().elevatorBadges;
    const run = (textSize: number) => computeVectorByWallsWarnings(
      elevatorNodes, elevatorEdges, squareCfg, baseSettings({ elevatorBadges: { ...badges, enabled: true, size: 10, textSize } }), null, null, elevatorNodes,
    ).filter((w) => w.id === "elevator_badge_text_overflow");
    expect(run(6)).toHaveLength(0);
    const w = run(40);
    expect(w).toHaveLength(1);
    expect(w[0].nodes.every((id) => id === 0)).toBe(true);
    expect(w[0].crossFloorTargets).toEqual([
      { nodeId: 0, targetFloorIndex: 1 },
      { nodeId: 0, targetFloorIndex: 2 },
      { nodeId: 0, targetFloorIndex: 3 },
    ]);
  });

  it("flags marker index labels that overflow their fixed plate and highlights the cell", () => {
    const crossNodes = [n(0, 0, 0, 0), n(1, 1, 0, 1)];
    const crossEdges: EdgeDto[] = [teleport(0, 1), teleport(1, 0)];
    const index = baseSettings().markerIndex;
    const run = (patch: Partial<typeof index>) => computeVectorByWallsWarnings(
      crossNodes.filter((x) => x.level === 0), [], squareCfg,
      baseSettings({ markerIndex: { ...index, enabled: true, labelStyle: "arabic", ...patch } }), null, null, crossNodes,
      { resolveNodeLevel: selectNodeLevelResolver(crossNodes), unscopedNodeById: new Map(crossNodes.map((x) => [x.id, x])), unscopedEdges: crossEdges, activeFloorIndex: 0 },
    ).filter((w) => w.id === "marker_index_text_overflow");
    expect(run({ width: 20, height: 20, textSize: 6, textMargin: 1 })).toHaveLength(0);
    const w = run({ width: 8, height: 8, textSize: 32, textMargin: 1 });
    expect(w).toHaveLength(1);
    expect(w[0].cells).toHaveLength(1);
    expect(run({ enabled: false, width: 8, height: 8, textSize: 32, textMargin: 1 })).toHaveLength(0);
  });

  it("keeps the cells of every floor when merging marker index overflow warnings across floors", () => {
    const crossNodes = [n(0, 0, 0, 0), n(1, 1, 0, 1)];
    const crossEdges: EdgeDto[] = [teleport(0, 1), teleport(1, 0)];
    const index = baseSettings().markerIndex;
    const settings = baseSettings({ markerIndex: { ...index, enabled: true, labelStyle: "arabic", width: 8, height: 8, textSize: 32, textMargin: 1 } });
    const merged = computeVectorByWallsWarningsAcrossFloors(crossNodes, crossEdges, [{ id: "f0" }, { id: "f1" }], squareCfg, settings, null, null)
      .filter((w) => w.id === "marker_index_text_overflow");
    expect(merged).toHaveLength(1);
    expect(new Set(merged[0].cells?.map((c) => c.floorIndex))).toEqual(new Set([0, 1]));
  });

  it("feeds the project teleport groups into marker index text-fit: a group shares one index (GitHub issue #871)", () => {
    // Teleports 0->1 and 0->2 share the endpoint node 0, so merged they form one group.
    const groupNodes = [n(0, 0, 0, 0), n(1, 3, 3, 0), n(2, 5, 5, 0)];
    const groupEdges: EdgeDto[] = [teleport(0, 1), teleport(1, 0), teleport(0, 2), teleport(2, 0)];
    const index = baseSettings().markerIndex;
    const markerIndex = { ...index, enabled: true, labelStyle: "arabic" as const, coverage: { ...index.coverage, singleFloorTeleport: true } };
    const texts = (teleportMergeMode: boolean) => computeTextFitItemsAcrossFloors(
      groupNodes, groupEdges, [{ id: "f0" }], squareCfg, baseSettings({ teleportMergeMode, markerIndex }), null, null,
    ).markerIndex.map((item) => item.text);
    expect(new Set(texts(true))).toEqual(new Set(["1"]));
    expect(new Set(texts(false))).toEqual(new Set(["1", "2"]));
  });

  it("collects labels across floors per size control for auto-fit", () => {
    const settings = baseSettings({ startMarker: marker({}), finishMarker: marker({ text: "" }) });
    const items = computeTextFitItemsAcrossFloors(nodes, edges, [{ id: "f0" }], squareCfg, settings, 0, 1);
    expect(items.start).toEqual([{ text: "S", font: { family: "", weight: 700 }, shape: "circle", plateSize: 20, margin: 1 }]);
    expect(items.finish).toEqual([]);
    expect(items.elevator).toEqual([]);
    expect(items.teleport).toEqual([]);
  });
});

describe("warnings reference color fields by key (GitHub issue #717)", () => {
  it("attaches a contrast warning to the keys of both compared fields", () => {
    const settings = baseSettings({ background: 0x000000, gridColor: 0x000000 });
    const warning = computeVectorByWallsWarnings([n(0, 0, 0), n(1, 1, 0)], [e(0, 1)], squareCfg, settings, null, null)
      .find((w) => w.id === "grid_low_contrast_background");
    expect(warning?.colorFields).toEqual(["bgGrid", "bgFill"]);
    expect(warning?.fields).toEqual(["bgGrid", "bgFill"]);
  });

  it("keeps one warning per field pair even when two fields share a color value", () => {
    // Start and finish markers have identical colors, but they are distinct fields.
    const marker = { ...defaultMarker, fillColor: 0, borderColor: 0, borderWidth: 0 };
    const settings = baseSettings({ startMarker: marker, finishMarker: marker });
    const warnings = computeVectorByWallsWarnings([n(0, 0, 0), n(1, 1, 0)], [], squareCfg, settings, 0, 1)
      .filter((w) => w.id === "marker_fill_low_contrast_floor");
    expect(warnings.map((w) => w.colorFields).sort()).toEqual([["finishFill", "tilesFloor"], ["startFill", "tilesFloor"]]);
    expect(new Set(warnings.map((w) => w.key)).size).toBe(2);
  });

  it("attaches the label warning to the caption color and the marker fill it sits on", () => {
    const settings = baseSettings({
      background: 0xffffff, gridColor: 0x808080, floorColor: 0xffffff,
      markerLayout: "auto", markerScale: 1,
      startMarker: { ...defaultMarker, fillColor: 0x00ff00, borderColor: 0x00ff00, textColor: 0x00ff00, text: "S" },
    });
    const warning = computeVectorByWallsWarnings([n(0, 0, 0)], [], squareCfg, settings, 0, null).find((w) => w.id === "label_low_contrast");
    expect(warning?.fields).toEqual(["startText", "startFill"]);
  });

  it("attaches a split warning to the slot's own split-node field", () => {
    const settings = baseSettings({ floorColor: 0x123456, splitNodeColors: [0x123456, 0xffffff], background: 0xffffff, gridColor: 0xaaaaaa, splitSpecialShapes: false });
    const warning = computeVectorByWallsWarnings(bridgeSplitNodes, bridgeSplitEdges, squareCfg, settings, null, null)
      .find((w) => w.id === "split_low_contrast_floor");
    expect(warning?.colorFields).toEqual(["splitNode:0", "tilesFloor"]);
  });

  it("skips special-shape splits in the split/floor contrast check unless special shapes are off (issue #893)", () => {
    const base = { floorColor: 0x123456, splitNodeColors: [0x123456, 0xffffff], background: 0xffffff, gridColor: 0xaaaaaa };
    const on = computeVectorByWallsWarnings(bridgeSplitNodes, bridgeSplitEdges, squareCfg, baseSettings({ ...base, splitSpecialShapes: true }), null, null)
      .find((w) => w.id === "split_low_contrast_floor");
    expect(on).toBeUndefined();
    const off = computeVectorByWallsWarnings(bridgeSplitNodes, bridgeSplitEdges, squareCfg, baseSettings({ ...base, splitSpecialShapes: false }), null, null)
      .find((w) => w.id === "split_low_contrast_floor");
    expect(off).toBeDefined();
  });

  it("flags only the split points whose own slot color clashes (GitHub issue #893)", () => {
    // Point A (1,1) connects through slot 0 (clashing with the floor), point B (3,3) through slot 1.
    const nodes = [n(0, 1, 1), n(1, 1, 1), n(2, 2, 1), n(3, 3, 3), n(4, 3, 3), n(5, 4, 3)];
    const edges = [e(0, 2), e(2, 0), e(4, 5), e(5, 4)];
    const settings = baseSettings({ floorColor: 0x123456, splitNodeColors: [0x123456, 0xffffff], background: 0xffffff, gridColor: 0xaaaaaa, splitSpecialShapes: false });
    const warning = computeVectorByWallsWarnings(nodes, edges, squareCfg, settings, null, null).find((w) => w.id === "split_low_contrast_floor");
    expect(warning?.nodes).toEqual(expect.arrayContaining([0, 1]));
    expect(warning?.nodes).not.toContain(3);
    expect(warning?.nodes).not.toContain(4);
  });

  it("lists every offending slot on the single pairwise split warning", () => {
    const settings = baseSettings({ floorColor: 0xffffff, splitNodeColors: [0x123456, 0x123457], background: 0xffffff, gridColor: 0xaaaaaa, splitSpecialShapes: false });
    const warnings = computeVectorByWallsWarnings(bridgeSplitNodes, bridgeSplitEdges, squareCfg, settings, null, null)
      .filter((w) => w.id === "split_colors_low_contrast_each_other");
    expect(warnings).toHaveLength(1);
    expect(warnings[0].fields).toEqual(expect.arrayContaining(["splitNode:0", "splitNode:1"]));
  });

  it("attaches a teleport connector warning to a group's override field, else the shared field", () => {
    const nodes = [n(0, 0, 0, 0), n(1, 2, 2, 0)];
    const edges = [teleport(0, 1)];
    const shared = baseSettings({ floorColor: 0xff0000, teleportConnectorColor: 0xff0000, teleportConnectorStyle: "straight" });
    const sharedWarning = computeVectorByWallsWarnings(nodes, edges, squareCfg, shared, null, null)
      .find((w) => w.id === "teleport_connector_low_contrast_floor");
    expect(sharedWarning?.colorFields).toEqual(["teleportConnector", "tilesFloor"]);
  });

  it("never warns about a hidden field, even when its colors would clash", () => {
    const clash = { floorColor: 0xffffff, background: 0xffffff, gridColor: 0xffffff };
    const hidden = computeVectorByWallsWarnings([n(0, 0, 0)], [], squareCfg, baseSettings({ ...clash, showGrid: false }), null, null);
    expect(hidden.some((w) => w.id === "grid_low_contrast_background")).toBe(false);
    const shown = computeVectorByWallsWarnings([n(0, 0, 0)], [], squareCfg, baseSettings({ ...clash, showGrid: true }), null, null);
    expect(shown.find((w) => w.id === "grid_low_contrast_background")?.colorFields).toEqual(["bgGrid", "bgFill"]);
  });

  it("skips the start caption warning when its text is disabled", () => {
    const marker = (textEnabled: boolean) => ({
      ...baseSettings().startMarker, fillColor: 0xffffff, textColor: 0xffffff, textEnabled,
    });
    const off = computeVectorByWallsWarnings([n(0, 0, 0)], [], squareCfg, baseSettings({ startMarker: marker(false) }), 0, null);
    expect(off.some((w) => w.id === "label_low_contrast")).toBe(false);
    const on = computeVectorByWallsWarnings([n(0, 0, 0)], [], squareCfg, baseSettings({ startMarker: marker(true) }), 0, null);
    expect(on.find((w) => w.id === "label_low_contrast")?.fields).toEqual(expect.arrayContaining(["startText", "startFill"]));
  });
});

describe("teleport_connector_covers_one_way (GitHub issue #862)", () => {
  // Row of four cells; the 1 -> 2 passage is one-way, so its indicator sits on the wall between
  // cells 1 and 2, exactly on the line a 0 <-> 3 teleport connector takes.
  const row = [n(0, 0, 0), n(1, 1, 0), n(2, 2, 0), n(3, 3, 0)];
  const rowEdges = [e(0, 1), e(1, 0), e(1, 2), e(2, 3), e(3, 2), teleport(0, 3), teleport(3, 0)];
  const covering = (id: string) => (w: { id: string }) => w.id === id;

  it("flags the covered one-way passage in Vector by walls", () => {
    const warnings = computeVectorByWallsWarnings(row, rowEdges, squareCfg, baseSettings(), null, null);
    const matches = warnings.filter(covering("teleport_connector_covers_one_way"));
    expect(matches).toHaveLength(1);
    expect(matches[0].nodes.sort()).toEqual([1, 2]);
    expect(matches[0].edges).toEqual([[1, 2]]);
  });

  it("does not fire when the one-way passage is off the connector's path", () => {
    const nodes = [...row, n(4, 1, 3), n(5, 2, 3)];
    const edges = [...rowEdges, e(2, 1), e(4, 5)];
    const warnings = computeVectorByWallsWarnings(nodes, edges, squareCfg, baseSettings(), null, null);
    expect(warnings.filter(covering("teleport_connector_covers_one_way"))).toHaveLength(0);
  });

  it("does not fire when connectors are disabled", () => {
    const warnings = computeVectorByWallsWarnings(row, rowEdges, squareCfg, baseSettings({ teleportConnectorStyle: "none" }), null, null);
    expect(warnings.filter(covering("teleport_connector_covers_one_way"))).toHaveLength(0);
  });

  it("flags a straight connector that crosses the indicator", () => {
    const straight = computeVectorByWallsWarnings(row, rowEdges, squareCfg, baseSettings({ teleportConnectorStyle: "straight" }), null, null);
    expect(straight.filter(covering("teleport_connector_covers_one_way"))).toHaveLength(1);
  });

  it("reports one entry per passage even when several connectors cover it", () => {
    const edges = [...rowEdges, teleport(1, 2), teleport(2, 1)];
    const warnings = computeVectorByWallsWarnings(row, edges, squareCfg, baseSettings({ teleportConnectorStyle: "straight" }), null, null);
    const matches = warnings.filter(covering("teleport_connector_covers_one_way"));
    expect(matches).toHaveLength(1);
    expect(matches[0].edges).toEqual([[1, 2]]);
  });

  it("does not fire without teleports", () => {
    const warnings = computeVectorByWallsWarnings(row, rowEdges.filter((x) => x.kind !== "teleport"), squareCfg, baseSettings(), null, null);
    expect(warnings.filter(covering("teleport_connector_covers_one_way"))).toHaveLength(0);
  });

  it("flags the covered one-way passage in Vector by corridors", () => {
    const warnings = computeVectorByCorridorsWarnings(row, rowEdges, squareCfg, baseCorridorsSettings(), null, null);
    const matches = warnings.filter(covering("teleport_connector_covers_one_way"));
    expect(matches).toHaveLength(1);
    expect(matches[0].edges).toEqual([[1, 2]]);
  });
});

describe("start_invisible / finish_invisible (GitHub issue #963)", () => {
  const nodes = [n(0, 0, 0), n(1, 5, 5)];
  const shown = baseSettings().startMarker;
  const hidden = { ...shown, markerEnabled: false, textEnabled: false, text: "S" };
  const ids = (settings: VectorByWallsSettings) => computeVectorByWallsWarnings(nodes, [e(0, 1)], squareCfg, settings, 0, 1)
    .filter((w) => w.id === "start_invisible" || w.id === "finish_invisible");

  it("flags a start with neither marker nor caption, and only the start", () => {
    const warnings = ids(baseSettings({ startMarker: hidden }));
    expect(warnings.map((w) => w.id)).toEqual(["start_invisible"]);
    expect(warnings[0].nodes).toEqual([0]);
  });

  it("flags a finish with no marker size and no caption", () => {
    const warnings = ids(baseSettings({ finishMarker: { ...shown, size: 0, borderWidth: 0, textEnabled: false } }));
    expect(warnings.map((w) => w.id)).toEqual(["finish_invisible"]);
  });

  it("does not flag while the caption or the marker is visible", () => {
    expect(ids(baseSettings({ startMarker: { ...hidden, textEnabled: true } }))).toHaveLength(0);
    expect(ids(baseSettings({ startMarker: { ...hidden, markerEnabled: true, size: 10 } }))).toHaveLength(0);
  });

  it("does not flag an empty caption as visible", () => {
    expect(ids(baseSettings({ startMarker: { ...hidden, textEnabled: true, text: " " } })).map((w) => w.id)).toEqual(["start_invisible"]);
  });
});

describe("hidden start/finish marker colors (GitHub issue #963)", () => {
  const marker = { ...baseSettings().startMarker, fillColor: 0xffffff, borderColor: 0xffffff, borderWidth: 0, textColor: 0xffffff, text: "S", textEnabled: true };
  const run = (startMarker: MarkerSettings) => computeVectorByWallsWarnings([n(0, 0, 0)], [], squareCfg, baseSettings({
    background: 0xffffff, gridColor: 0x808080, floorColor: 0xffffff, markerLayout: "auto", markerScale: 1, startMarker,
  }), 0, null);

  it("skips the marker's own contrast warnings while the marker is off", () => {
    expect(run(marker).some((w) => w.id.startsWith("marker_fill_low_contrast"))).toBe(true);
    expect(run({ ...marker, markerEnabled: false }).some((w) => w.id.startsWith("marker_fill_low_contrast") || w.id.startsWith("marker_border_low_contrast"))).toBe(false);
  });

  it("checks the caption against the surface instead of the hidden fill", () => {
    const warning = run({ ...marker, markerEnabled: false, fillColor: 0x000000, textColor: 0xffffff }).find((w) => w.id === "label_low_contrast");
    expect(warning?.fields).toEqual(["startText", "tilesFloor"]);
  });
});

describe("start marker of size 0 (saved before the toggle, GitHub issue #963)", () => {
  it("compares the caption with the surface, not with the fill that is not drawn", () => {
    const marker = { ...baseSettings().startMarker, size: 0, borderWidth: 0, fillColor: 0x545454, borderColor: 0x545454, textColor: 0x545454, text: "S", textEnabled: true };
    const warnings = computeVectorByWallsWarnings([n(0, 0, 0)], [], squareCfg, baseSettings({
      background: 0xffffff, gridColor: 0x808080, floorColor: 0xffffff, markerLayout: "auto", markerScale: 1, startMarker: marker,
    }), 0, null);
    expect(warnings.some((w) => w.id === "label_low_contrast")).toBe(false);
  });
});

describe("start_opening_no_outer_wall / finish_opening_no_outer_wall (GitHub issue #330)", () => {
  // The full 6x6 grid, id = y * 6 + x: cell 0 = (0,0) touches the outer border, cell 21 = (3,3) is interior.
  const nodes = Array.from({ length: 36 }, (_, i) => n(i, i % 6, Math.floor(i / 6)));
  const run = (settings: VectorByWallsSettings, start: number | null, finish: number | null) =>
    computeVectorByWallsWarnings(nodes, [], squareCfg, settings, start, finish)
      .filter((w) => w.id === "start_opening_no_outer_wall" || w.id === "finish_opening_no_outer_wall");
  const on = { mode: "both" as const, pattern: "triangle" as const, color: 0, size: 12, thickness: 4, gapWidth: 3, join: "round" as const };

  it("flags an enabled opening whose cell has no outer wall, and only that endpoint", () => {
    const warnings = run(baseSettings({ startOpening: on, finishOpening: on }), 21, 0);
    expect(warnings.map((w) => w.id)).toEqual(["start_opening_no_outer_wall"]);
    expect(warnings[0].nodes).toEqual([21]);
  });

  it("does not flag a border cell or a disabled opening", () => {
    expect(run(baseSettings({ startOpening: on }), 0, null)).toHaveLength(0);
    expect(run(baseSettings({ startOpening: { ...on, mode: "none" as const } }), 21, null)).toHaveLength(0);
  });

  it("flags every mode that works on the outer wall, whatever it does", () => {
    for (const mode of ["opening", "pointer", "both"] as const) {
      expect(run(baseSettings({ startOpening: { ...on, mode } }), 21, null).map((w) => w.id)).toEqual(["start_opening_no_outer_wall"]);
    }
  });

  it("flags the finish independently", () => {
    expect(run(baseSettings({ finishOpening: on }), null, 21).map((w) => w.id)).toEqual(["finish_opening_no_outer_wall"]);
  });

  it("a drawn opening keeps a marker-less endpoint visible; one that cannot be drawn does not", () => {
    const hidden = { ...baseSettings().startMarker, markerEnabled: false, textEnabled: false };
    const ids = (start: number) => computeVectorByWallsWarnings(nodes, [], squareCfg, baseSettings({ startMarker: hidden, startOpening: on }), start, null)
      .filter((w) => w.id === "start_invisible" || w.id === "start_opening_no_outer_wall").map((w) => w.id);
    expect(ids(0)).toEqual([]);
    expect(ids(21)).toEqual(["start_invisible", "start_opening_no_outer_wall"]);
    const off = computeVectorByWallsWarnings(nodes, [], squareCfg, baseSettings({ startMarker: hidden }), 0, null);
    expect(off.map((w) => w.id)).toContain("start_invisible");
  });
});
