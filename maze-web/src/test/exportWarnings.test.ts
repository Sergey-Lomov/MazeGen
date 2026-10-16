import { describe, it, expect, vi } from "vitest";
import { computeVectorByWallsWarnings, computeVectorByCorridorsWarnings, computeTextFitItemsAcrossFloors } from "../pixi/selectors/exportWarnings";
import { selectNodeLevelResolver } from "../pixi/selectors/mazeSelectors/state";
import type { NodeDto, EdgeDto } from "../wasm/types";
import type { FieldConfig } from "../fieldConfig";
import type { VectorByWallsSettings, VectorByCorridorsSettings, MarkerSettings } from "../store/storeTypes";
import { canvas } from "../pixi/colorTokens";
import { hasLowContrast, perceptualColorDistance } from "../pixi/colorContrast";
import { DEFAULT_SHARED_STYLE_SOURCE, DEFAULT_VERTICAL_SETTINGS, DEFAULT_VERTICAL_DECORATIVE_SETTINGS, DEFAULT_VERTICAL_SHARED_STYLE, DEFAULT_MARKER_INDEX_SETTINGS, DEFAULT_FLOOR_LABEL_SETTINGS } from "../store/slices/imageExportSlice";
import { DEFAULT_VECTOR_BY_WALLS_LINKS, DEFAULT_VECTOR_BY_CORRIDORS_LINKS } from "../store/slices/parameterLinksDefaults";
import { bridgeSplitNodes, bridgeSplitEdges, plainSplitNodes } from "./splitTopologyFixtures";
import { fieldOf } from "./fieldConfigFixtures";
import { fakeCellCenters } from "./cellCentersFake";

vi.mock("../wasm/mazeService", () => ({
  getCellCenters: vi.fn((config: Parameters<typeof fakeCellCenters>[0]) => fakeCellCenters(config)),
}));

const n = (id: number, x: number, y: number, level?: number): NodeDto => ({ id, x, y, i: 0, level });
const e = (from: number, to: number): EdgeDto => ({ from, to, kind: "basic" });
const teleport = (from: number, to: number): EdgeDto => ({ from, to, kind: "teleport" });
const squareCfg: FieldConfig = fieldOf("square", { shape: "rect", cols: 6, rows: 6 });

const defaultMarker: MarkerSettings = {
  shape: "circle", cornerStyle: "miter", fillColor: canvas.node.start, borderColor: canvas.node.start,
  borderWidth: 0, gapWidth: 0, size: 12, text: "",
};

function baseSettings(overrides: Partial<VectorByWallsSettings> = {}): VectorByWallsSettings {
  return {
    background: 0, showGrid: true, gridColor: 0x808080, showInnerGrid: false, innerGridColor: 0x808080, floorColor: 0, wallColor: 0, randomWallColorMode: "off", wallJoin: "round", wallThickness: 4,
    oneWayPattern: "triangle", oneWayColor: 0, oneWayGapWidth: 3, oneWaySize: 12, oneWayThickness: 4, oneWayJoin: "round",
    startMarker: defaultMarker, finishMarker: defaultMarker,
    teleportMarker: { cornerStyle: "round", shape: "diamond", size: 6.4, fillColor: 0xff0000, borderColor: 0xff0000, borderWidth: 3, gapWidth: 3 },
    teleportConnectorColor: 0xff0000, teleportConnectorWidth: 3, teleportConnectorStyle: "orthogonal",
    teleportAvoidFieldExit: false, teleportArrowMode: "periodic", teleportArrowPeriod: 5, teleportArrowSize: 10,
    teleportConnectorGapWidth: 3, teleportFloorBadge: { shape: "circle", labelType: "arabic", cornerStyle: "round", gapWidth: 3, size: 6.4, fillColor: 0x123456, borderColor: 0x123456, borderWidth: 3, textColor: 0x123456, textFontWeight: "bold", textSize: 12, textMargin: 1 }, teleportGroupCustomization: false, teleportGroupOverrides: {},
    ...DEFAULT_VERTICAL_SETTINGS,
    ...DEFAULT_VERTICAL_DECORATIVE_SETTINGS,
    ...DEFAULT_VERTICAL_SHARED_STYLE,
    verticalDecorativeLineColor: 0,
    verticalDecorativeLineWidth: 2,
    verticalDecorativeSize: 8.8,
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
    oneWayColor: 0, oneWayCount: 1, oneWayThickness: 4, oneWayGap: 4, oneWayWidth: 1, oneWayLength: 1, oneWayJoin: "round",
    teleportMarker: { cornerStyle: "round", shape: "diamond", size: 6.4, fillColor: 0xff0000, borderColor: 0xff0000, borderWidth: 3, gapWidth: 3 },
    teleportConnectorColor: 0xff0000, teleportConnectorWidth: 3, teleportConnectorStyle: "orthogonal",
    teleportAvoidFieldExit: false, teleportArrowMode: "periodic", teleportArrowPeriod: 5, teleportArrowSize: 10,
    teleportConnectorGapWidth: 3, teleportFloorBadge: { shape: "circle", labelType: "arabic", cornerStyle: "round", gapWidth: 3, size: 6.4, fillColor: 0x123456, borderColor: 0x123456, borderWidth: 3, textColor: 0x123456, textFontWeight: "bold", textSize: 12, textMargin: 1 }, teleportGroupCustomization: false, teleportGroupOverrides: {},
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

  describe("teleport_waypoint_overlap", () => {
    it("flags when a teleport marker's footprint overlaps the start marker", () => {
      const nodes = [n(0, 0, 0), n(1, 5, 5)];
      const edges = [teleport(0, 1)];
      // start sits at node 0's own position -> distance 0, definitely overlapping.
      const settings = baseSettings({ teleportMarker: { ...baseSettings().teleportMarker, size: 12, borderWidth: 2 } });
      const warnings = computeVectorByWallsWarnings(nodes, edges, squareCfg, settings, 0, null);
      const matches = warnings.filter((w) => w.id === "teleport_waypoint_overlap");
      expect(matches).toHaveLength(1);
      expect(matches[0].nodes.sort()).toEqual([0]);
    });

    it("collapses overlaps with both start and finish into one warning", () => {
      const nodes = [n(0, 0, 0), n(1, 5, 5)];
      const edges = [teleport(0, 1)];
      const settings = baseSettings({ teleportMarker: { ...baseSettings().teleportMarker, size: 12, borderWidth: 2 } });
      // Both start and finish sit exactly on the teleport's two endpoints -> two overlaps, one warning.
      const warnings = computeVectorByWallsWarnings(nodes, edges, squareCfg, settings, 0, 1);
      const matches = warnings.filter((w) => w.id === "teleport_waypoint_overlap");
      expect(matches).toHaveLength(1);
      expect(matches[0].nodes.sort()).toEqual([0, 1]);
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

  describe("waypoint_on_split", () => {
    it("flags start when it sits on a specially-rendered (bridge) split point", () => {
      const settings = baseSettings({ splitSpecialShapes: true });
      const warnings = computeVectorByWallsWarnings(bridgeSplitNodes, bridgeSplitEdges, squareCfg, settings, 0, null);
      const matches = warnings.filter((w) => w.id === "waypoint_on_split");
      expect(matches).toHaveLength(1);
      expect(matches[0].nodes).toEqual([0]);
    });

    it("collapses start+finish both on special split points into one warning", () => {
      const settings = baseSettings({ splitSpecialShapes: true });
      const warnings = computeVectorByWallsWarnings(bridgeSplitNodes, bridgeSplitEdges, squareCfg, settings, 0, 4);
      const matches = warnings.filter((w) => w.id === "waypoint_on_split");
      expect(matches).toHaveLength(1);
      expect(matches[0].nodes.sort()).toEqual([0, 4]);
    });

    it("does not flag a plain (non-special) split point", () => {
      const settings = baseSettings();
      const warnings = computeVectorByWallsWarnings(plainSplitNodes, [], squareCfg, settings, 0, null);
      expect(warnings.filter((w) => w.id === "waypoint_on_split")).toHaveLength(0);
    });

    it("does not flag when splitSpecialShapes is off (special shape not actually drawn)", () => {
      const settings = baseSettings({ splitSpecialShapes: false });
      const warnings = computeVectorByWallsWarnings(bridgeSplitNodes, bridgeSplitEdges, squareCfg, settings, 0, null);
      expect(warnings.filter((w) => w.id === "waypoint_on_split")).toHaveLength(0);
    });

    it("does not flag a waypoint on an unsplit node", () => {
      const settings = baseSettings();
      const warnings = computeVectorByWallsWarnings(bridgeSplitNodes, bridgeSplitEdges, squareCfg, settings, 6, null);
      expect(warnings.filter((w) => w.id === "waypoint_on_split")).toHaveLength(0);
    });

    it("no split points in the maze at all -> no warning", () => {
      const nodes = [n(0, 0, 0), n(1, 5, 5)];
      const settings = baseSettings();
      const warnings = computeVectorByWallsWarnings(nodes, [], squareCfg, settings, 0, null);
      expect(warnings.filter((w) => w.id === "waypoint_on_split")).toHaveLength(0);
    });
  });

  describe("teleport_on_special_split", () => {
    it("flags a teleport endpoint sitting on a specially-rendered split point", () => {
      const nodes = [...bridgeSplitNodes, n(7, 8, 8)];
      const edges = [...bridgeSplitEdges, teleport(0, 7)];
      const settings = baseSettings({ splitSpecialShapes: true });
      const warnings = computeVectorByWallsWarnings(nodes, edges, squareCfg, settings, null, null);
      const matches = warnings.filter((w) => w.id === "teleport_on_special_split");
      expect(matches).toHaveLength(1);
      expect(matches[0].nodes).toContain(0);
    });

    it("does not flag when splitSpecialShapes is off", () => {
      const nodes = [...bridgeSplitNodes, n(7, 8, 8)];
      const edges = [...bridgeSplitEdges, teleport(0, 7)];
      const settings = baseSettings({ splitSpecialShapes: false });
      const warnings = computeVectorByWallsWarnings(nodes, edges, squareCfg, settings, null, null);
      expect(warnings.filter((w) => w.id === "teleport_on_special_split")).toHaveLength(0);
    });

    it("does not flag a teleport endpoint on a plain, non-special cell", () => {
      const nodes = [...bridgeSplitNodes, n(7, 8, 8)];
      const edges = [...bridgeSplitEdges, teleport(6, 7)];
      const settings = baseSettings({ splitSpecialShapes: true });
      const warnings = computeVectorByWallsWarnings(nodes, edges, squareCfg, settings, null, null);
      expect(warnings.filter((w) => w.id === "teleport_on_special_split")).toHaveLength(0);
    });
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
        elevatorBadges: { enabled: true, labelType: "arabic", size: 400, placement: "full_circle", distance: 0, gap: 0, gapWidth: 0, cornerStyle: "round", evenDistribution: true, shape: "circle", fillColor: 0, borderColor: 0x555555, borderWidth: 0, textColor: 0, textFontWeight: "bold", textSize: 16.66, textMargin: 1 },
      });
      const warnings = computeVectorByWallsWarnings(elevatorNodes, elevatorEdges, squareCfg, settings, null, null, elevatorNodes);
      const matches = warnings.filter((w) => w.id === "elevator_badges_overlap");
      expect(matches).toHaveLength(1);
      expect(matches[0].nodes).toEqual([0]);
      expect(matches[0].crossFloorTargets).toEqual([
        { nodeId: 0, targetFloorIndex: 1 },
        { nodeId: 0, targetFloorIndex: 2 },
        { nodeId: 0, targetFloorIndex: 3 },
      ]);
    });

    it("does not flag when badges is disabled", () => {
      const settings = baseSettings({
        elevatorBadges: { enabled: false, labelType: "arabic", size: 1, placement: "full_circle", distance: 0, gap: 0, gapWidth: 0, cornerStyle: "round", evenDistribution: true, shape: "circle", fillColor: 0, borderColor: 0x555555, borderWidth: 0, textColor: 0, textFontWeight: "bold", textSize: 16.66, textMargin: 1 },
      });
      const warnings = computeVectorByWallsWarnings(elevatorNodes, elevatorEdges, squareCfg, settings, null, null, elevatorNodes);
      expect(warnings.filter((w) => w.id === "elevator_badges_overlap")).toHaveLength(0);
    });

    it("does not flag when badges have enough room (large distance, small size)", () => {
      const settings = baseSettings({
        elevatorBadges: { enabled: true, labelType: "arabic", size: 0.1, placement: "full_circle", distance: 20, gap: 0, gapWidth: 0, cornerStyle: "round", evenDistribution: true, shape: "circle", fillColor: 0, borderColor: 0x555555, borderWidth: 0, textColor: 0, textFontWeight: "bold", textSize: 16.66, textMargin: 1 },
      });
      const warnings = computeVectorByWallsWarnings(elevatorNodes, elevatorEdges, squareCfg, settings, null, null, elevatorNodes);
      expect(warnings.filter((w) => w.id === "elevator_badges_overlap")).toHaveLength(0);
    });

    it("when only the floor-scoped source node is visible (targets' floors unresolvable), no overlap can be detected", () => {
      // Mirrors a real floor-scoped `nodes` list: only node 0 (the elevator's own `from`, on the
      // active floor) is present — the fan's targets on other floors are structurally absent, so
      // without a separate unscoped node list their floors can't resolve at all.
      const settings = baseSettings({
        elevatorBadges: { enabled: true, labelType: "arabic", size: 1, placement: "left_right", distance: 0, gap: 0, gapWidth: 0, cornerStyle: "round", evenDistribution: true, shape: "circle", fillColor: 0, borderColor: 0x555555, borderWidth: 0, textColor: 0, textFontWeight: "bold", textSize: 16.66, textMargin: 1 },
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
        elevatorBadges: { enabled: true, labelType: "arabic", size: 400, placement: "left_right", distance: 0, gap: 0, gapWidth: 0, cornerStyle: "round", evenDistribution: true, shape: "circle", fillColor: 0, borderColor: 0x555555, borderWidth: 0, textColor: 0, textFontWeight: "bold", textSize: 16.66, textMargin: 1 },
      });
      const warnings = computeVectorByWallsWarnings(elevatorNodes, elevatorEdges, squareCfg, settings, null, null, elevatorNodes);
      const matches = warnings.filter((w) => w.id === "elevator_badges_too_many");
      expect(matches).toHaveLength(1);
      expect(matches[0].nodes).toEqual([0]);
      expect(matches[0].crossFloorTargets).toEqual([
        { nodeId: 0, targetFloorIndex: 1 },
        { nodeId: 0, targetFloorIndex: 2 },
        { nodeId: 0, targetFloorIndex: 3 },
      ]);
    });

    it("never fires for full_circle", () => {
      const settings = baseSettings({
        elevatorBadges: { enabled: true, labelType: "arabic", size: 400, placement: "full_circle", distance: 0, gap: 0, gapWidth: 0, cornerStyle: "round", evenDistribution: true, shape: "circle", fillColor: 0, borderColor: 0x555555, borderWidth: 0, textColor: 0, textFontWeight: "bold", textSize: 16.66, textMargin: 1 },
      });
      const warnings = computeVectorByWallsWarnings(elevatorNodes, elevatorEdges, squareCfg, settings, null, null, elevatorNodes);
      expect(warnings.filter((w) => w.id === "elevator_badges_too_many")).toHaveLength(0);
    });

    it("does not flag when badges fit within one row per side", () => {
      const settings = baseSettings({
        elevatorBadges: { enabled: true, labelType: "arabic", size: 0.1, placement: "left_right", distance: 0, gap: 0, gapWidth: 0, cornerStyle: "round", evenDistribution: true, shape: "circle", fillColor: 0, borderColor: 0x555555, borderWidth: 0, textColor: 0, textFontWeight: "bold", textSize: 16.66, textMargin: 1 },
      });
      const warnings = computeVectorByWallsWarnings(elevatorNodes, elevatorEdges, squareCfg, settings, null, null, elevatorNodes);
      expect(warnings.filter((w) => w.id === "elevator_badges_too_many")).toHaveLength(0);
    });
  });
});

describe("computeVectorByCorridorsWarnings", () => {
  describe("waypoint_on_split", () => {
    it("flags start when it sits on a specially-rendered (bridge) split point", () => {
      const settings = baseCorridorsSettings({ splitSpecialShapes: true });
      const warnings = computeVectorByCorridorsWarnings(bridgeSplitNodes, bridgeSplitEdges, squareCfg, settings, 0, null);
      const matches = warnings.filter((w) => w.id === "waypoint_on_split");
      expect(matches).toHaveLength(1);
      expect(matches[0].nodes).toEqual([0]);
    });

    it("collapses start+finish both on special split points into one warning", () => {
      const settings = baseCorridorsSettings({ splitSpecialShapes: true });
      const warnings = computeVectorByCorridorsWarnings(bridgeSplitNodes, bridgeSplitEdges, squareCfg, settings, 0, 4);
      const matches = warnings.filter((w) => w.id === "waypoint_on_split");
      expect(matches).toHaveLength(1);
      expect(matches[0].nodes.sort()).toEqual([0, 4]);
    });

    it("does not flag a plain (non-special) split point", () => {
      const warnings = computeVectorByCorridorsWarnings(plainSplitNodes, [], squareCfg, baseCorridorsSettings(), 0, null);
      expect(warnings.filter((w) => w.id === "waypoint_on_split")).toHaveLength(0);
    });

    it("does not flag when splitSpecialShapes is off (special shape not actually drawn)", () => {
      const settings = baseCorridorsSettings({ splitSpecialShapes: false });
      const warnings = computeVectorByCorridorsWarnings(bridgeSplitNodes, bridgeSplitEdges, squareCfg, settings, 0, null);
      expect(warnings.filter((w) => w.id === "waypoint_on_split")).toHaveLength(0);
    });

    it("does not flag a waypoint on an unsplit node", () => {
      const settings = baseCorridorsSettings({ splitSpecialShapes: true });
      const warnings = computeVectorByCorridorsWarnings(bridgeSplitNodes, bridgeSplitEdges, squareCfg, settings, 6, null);
      expect(warnings.filter((w) => w.id === "waypoint_on_split")).toHaveLength(0);
    });

    it("no split points in the maze at all -> no warning", () => {
      const nodes = [n(0, 0, 0), n(1, 5, 5)];
      const warnings = computeVectorByCorridorsWarnings(nodes, [], squareCfg, baseCorridorsSettings(), 0, null);
      expect(warnings.filter((w) => w.id === "waypoint_on_split")).toHaveLength(0);
    });

    it("no start/finish set -> no warning", () => {
      const warnings = computeVectorByCorridorsWarnings(plainSplitNodes, [], squareCfg, baseCorridorsSettings(), null, null);
      expect(warnings).toHaveLength(0);
    });
  });

  describe("teleport_on_special_split", () => {
    it("flags a teleport endpoint sitting on a specially-rendered split point", () => {
      const nodes = [...bridgeSplitNodes, n(7, 8, 8)];
      const edges = [...bridgeSplitEdges, teleport(0, 7)];
      const settings = baseCorridorsSettings({ splitSpecialShapes: true });
      const warnings = computeVectorByCorridorsWarnings(nodes, edges, squareCfg, settings, null, null);
      const matches = warnings.filter((w) => w.id === "teleport_on_special_split");
      expect(matches).toHaveLength(1);
      expect(matches[0].nodes).toContain(0);
    });

    it("does not flag when splitSpecialShapes is off", () => {
      const nodes = [...bridgeSplitNodes, n(7, 8, 8)];
      const edges = [...bridgeSplitEdges, teleport(0, 7)];
      const settings = baseCorridorsSettings({ splitSpecialShapes: false });
      const warnings = computeVectorByCorridorsWarnings(nodes, edges, squareCfg, settings, null, null);
      expect(warnings.filter((w) => w.id === "teleport_on_special_split")).toHaveLength(0);
    });

    it("does not flag a teleport endpoint on a plain, non-special cell", () => {
      const nodes = [...bridgeSplitNodes, n(7, 8, 8)];
      const edges = [...bridgeSplitEdges, teleport(6, 7)];
      const settings = baseCorridorsSettings({ splitSpecialShapes: true });
      const warnings = computeVectorByCorridorsWarnings(nodes, edges, squareCfg, settings, null, null);
      expect(warnings.filter((w) => w.id === "teleport_on_special_split")).toHaveLength(0);
    });
  });

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

  it("collects labels across floors per size control for auto-fit", () => {
    const settings = baseSettings({ startMarker: marker({}), finishMarker: marker({ text: "" }) });
    const items = computeTextFitItemsAcrossFloors(nodes, edges, [{ id: "f0" }], squareCfg, settings, 0, 1);
    expect(items.start).toEqual([{ text: "S", fontWeight: "bold", shape: "circle", plateSize: 20, margin: 1 }]);
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
      startMarker: { ...defaultMarker, fillColor: 0x00ff00, borderColor: 0x00ff00, textColor: 0x00ff00, text: "S" },
    });
    const warning = computeVectorByWallsWarnings([n(0, 0, 0)], [], squareCfg, settings, 0, null).find((w) => w.id === "label_low_contrast");
    expect(warning?.fields).toEqual(["startText", "startFill"]);
  });

  it("attaches a split warning to the slot's own split-node field", () => {
    const settings = baseSettings({ floorColor: 0x123456, splitNodeColors: [0x123456, 0xffffff], background: 0xffffff, gridColor: 0xaaaaaa });
    const warning = computeVectorByWallsWarnings(bridgeSplitNodes, bridgeSplitEdges, squareCfg, settings, null, null)
      .find((w) => w.id === "split_low_contrast_floor");
    expect(warning?.colorFields).toEqual(["splitNode:0", "tilesFloor"]);
  });

  it("lists every offending slot on the single pairwise split warning", () => {
    const settings = baseSettings({ floorColor: 0xffffff, splitNodeColors: [0x123456, 0x123457], background: 0xffffff, gridColor: 0xaaaaaa });
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
