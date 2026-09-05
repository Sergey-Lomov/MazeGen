import { describe, it, expect, vi } from "vitest";
import { computeVectorByWallsWarnings, computeVectorByCorridorsWarnings } from "../pixi/selectors/exportWarnings";
import type { NodeDto, EdgeDto } from "../wasm/types";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";
import type { VectorByWallsSettings, VectorByCorridorsSettings, MarkerSettings } from "../store/storeTypes";
import { canvas } from "../pixi/colorTokens";
import { DEFAULT_VECTOR_BY_WALLS_SHARED_STYLE, DEFAULT_VECTOR_BY_CORRIDORS_SHARED_STYLE, DEFAULT_VERTICAL_SETTINGS, DEFAULT_VERTICAL_DECORATIVE_SETTINGS, DEFAULT_MARKER_INDEX_SETTINGS } from "../store/slices/imageExportSlice";

vi.mock("../wasm/mazeService", () => ({
  getCartesianCoords: (cfg: { points: [number, number][] }) => cfg.points.map(([x, y]) => [x, y]),
}));

const n = (id: number, x: number, y: number, level?: number): NodeDto => ({ id, x, y, i: 0, level });
const e = (from: number, to: number): EdgeDto => ({ from, to, kind: "basic" });
const teleport = (from: number, to: number): EdgeDto => ({ from, to, kind: "teleport" });
const squareCfg: TessellationConfig = { type: "square", width: 6, height: 6 };

// Point (0,0) split into node 0 (slot 0: east+west) and node 4 (slot 1: north+south) — a
// recognized "bridge" special shape (see `mazeSelectors.test.ts`'s own bridge-topology test for
// the geometry this produces). Node 6 sits on a plain, non-split, non-special cell.
const bridgeSplitNodes = [
  n(0, 0, 0), n(1, 1, 0), n(2, -1, 0),
  n(3, 0, 1), n(4, 0, 0), n(5, 0, -1),
  n(6, 5, 5),
];
const bridgeSplitEdges: EdgeDto[] = [e(0, 1), e(1, 0), e(0, 2), e(2, 0), e(4, 3), e(3, 4), e(4, 5), e(5, 4)];

// A plain (non-special) 2-node split point at (1,1) — no recognized bridge/diagonal topology.
const plainSplitNodes = [n(0, 1, 1), n(1, 1, 1), n(2, 5, 5)];

const defaultMarker: MarkerSettings = {
  shape: "circle", cornerStyle: "sharp", fillColor: canvas.node.start, borderColor: canvas.node.start,
  borderWidth: 0, gapWidth: 0, size: 0.3,
};

function baseSettings(overrides: Partial<VectorByWallsSettings> = {}): VectorByWallsSettings {
  return {
    background: 0, showGrid: true, gridColor: 0, floorColor: 0, wallColor: 0, randomWallColorMode: "off", wallJoin: "round", wallThickness: 4,
    oneWayPattern: "triangle", oneWayColor: 0, oneWayGapWidth: 3, oneWaySize: 0.3, oneWayThickness: 4, oneWayJoin: "round",
    startMarker: defaultMarker, finishMarker: defaultMarker,
    teleportLineCornerStyle: "round", teleportLineShape: "diamond", teleportLineSize: 0.16,
    teleportEdgeColor: 0xff0000, teleportEdgeBorderColor: 0xff0000, teleportEdgeBorderWidth: 3, teleportEdgeGapWidth: 3,
    teleportConnectorColor: 0xff0000, teleportConnectorWidth: 3, teleportConnectorStyle: "orthogonal",
    teleportAvoidFieldExit: false, teleportArrowMode: "periodic", teleportArrowPeriod: 5, teleportArrowSize: 10,
    teleportConnectorGapWidth: 3, teleportFloorBadge: { shape: "circle", labelType: "arabic", size: 0.16, textColor: 0x123456, textPadding: 0 }, teleportGroupCustomization: false, teleportGroupOverrides: {},
    ...DEFAULT_VERTICAL_SETTINGS,
    ...DEFAULT_VERTICAL_DECORATIVE_SETTINGS,
    splitNodeColors: [], splitSpecialShapes: true,
    sharedStyle: DEFAULT_VECTOR_BY_WALLS_SHARED_STYLE,
    markerIndex: DEFAULT_MARKER_INDEX_SETTINGS,
    ...overrides,
  };
}

function baseCorridorsSettings(overrides: Partial<VectorByCorridorsSettings> = {}): VectorByCorridorsSettings {
  return {
    background: 0, showGrid: true, gridColor: 0,
    color: 0, thickness: 4, join: "round", renderStyle: "contour",
    startMarker: defaultMarker, finishMarker: defaultMarker,
    markerWidenPadding: 0, markerWidenShape: "match_marker",
    oneWayColor: 0, oneWayCount: 1, oneWayThickness: 4, oneWayGap: 4, oneWayWidth: 1, oneWayLength: 1, oneWayJoin: "round",
    teleportLineCornerStyle: "round", teleportLineShape: "diamond", teleportLineSize: 0.16,
    teleportEdgeColor: 0xff0000, teleportEdgeBorderColor: 0xff0000, teleportEdgeBorderWidth: 3, teleportEdgeGapWidth: 3,
    teleportConnectorColor: 0xff0000, teleportConnectorWidth: 3, teleportConnectorStyle: "orthogonal",
    teleportAvoidFieldExit: false, teleportArrowMode: "periodic", teleportArrowPeriod: 5, teleportArrowSize: 10,
    teleportConnectorGapWidth: 3, teleportFloorBadge: { shape: "circle", labelType: "arabic", size: 0.16, textColor: 0x123456, textPadding: 0 }, teleportGroupCustomization: false, teleportGroupOverrides: {},
    ...DEFAULT_VERTICAL_SETTINGS,
    splitNodeColors: [], splitSpecialShapes: true, splitGapWidth: 3, splitDiagonalBowAmount: 0.15,
    sharedStyle: DEFAULT_VECTOR_BY_CORRIDORS_SHARED_STYLE,
    markerIndex: DEFAULT_MARKER_INDEX_SETTINGS,
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
  describe("teleport_marker_invisible", () => {
    it("flags a one-way teleport's exit endpoint when border width is 0 (its fill mirrors floor color)", () => {
      const nodes = [n(0, 0, 0), n(1, 3, 3)];
      const edges = [teleport(0, 1)]; // one-way: node 1 is the exit-only ("outline") endpoint
      const settings = baseSettings({ teleportEdgeBorderWidth: 0 });
      const warnings = computeVectorByWallsWarnings(nodes, edges, squareCfg, settings, null, null);
      const w = warnings.filter((w) => w.id === "teleport_marker_invisible");
      expect(w).toHaveLength(1);
      expect(w[0].nodes).toEqual([1]);
    });

    it("does not flag a two-way teleport (both endpoints always filled, regardless of border)", () => {
      const nodes = [n(0, 0, 0), n(1, 3, 3)];
      const edges = [teleport(0, 1), teleport(1, 0)];
      const settings = baseSettings({ teleportEdgeBorderWidth: 0 });
      const warnings = computeVectorByWallsWarnings(nodes, edges, squareCfg, settings, null, null);
      expect(warnings.filter((w) => w.id === "teleport_marker_invisible")).toHaveLength(0);
    });

    it("does not flag when border width keeps the exit marker's outline visible", () => {
      const nodes = [n(0, 0, 0), n(1, 3, 3)];
      const edges = [teleport(0, 1)];
      const settings = baseSettings({ teleportEdgeBorderWidth: 3 });
      const warnings = computeVectorByWallsWarnings(nodes, edges, squareCfg, settings, null, null);
      expect(warnings.filter((w) => w.id === "teleport_marker_invisible")).toHaveLength(0);
    });

    it("no teleports present -> no warning even with border at 0", () => {
      const nodes = [n(0, 0, 0), n(1, 3, 3)];
      const settings = baseSettings({ teleportEdgeBorderWidth: 0 });
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
      const settings = baseSettings({ teleportLineSize: 0.3, teleportEdgeBorderWidth: 2 });
      const warnings = computeVectorByWallsWarnings(nodes, edges, squareCfg, settings, 0, null);
      const matches = warnings.filter((w) => w.id === "teleport_waypoint_overlap");
      expect(matches).toHaveLength(1);
      expect(matches[0].nodes.sort()).toEqual([0]);
    });

    it("collapses overlaps with both start and finish into one warning", () => {
      const nodes = [n(0, 0, 0), n(1, 5, 5)];
      const edges = [teleport(0, 1)];
      const settings = baseSettings({ teleportLineSize: 0.3, teleportEdgeBorderWidth: 2 });
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
      const settings = baseSettings({ teleportLineSize: 0.3, teleportEdgeBorderWidth: 2 });
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
        elevatorBadges: { enabled: true, labelType: "arabic", size: 20, placement: "full_circle", distance: 0, gap: 0, gapWidth: 0, cornerStyle: "round", evenDistribution: true, shape: "circle", fillColor: 0, textColor: 0, fontWeight: "bold" },
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
        elevatorBadges: { enabled: false, labelType: "arabic", size: 1, placement: "full_circle", distance: 0, gap: 0, gapWidth: 0, cornerStyle: "round", evenDistribution: true, shape: "circle", fillColor: 0, textColor: 0, fontWeight: "bold" },
      });
      const warnings = computeVectorByWallsWarnings(elevatorNodes, elevatorEdges, squareCfg, settings, null, null, elevatorNodes);
      expect(warnings.filter((w) => w.id === "elevator_badges_overlap")).toHaveLength(0);
    });

    it("does not flag when badges have enough room (large distance, small size)", () => {
      const settings = baseSettings({
        elevatorBadges: { enabled: true, labelType: "arabic", size: 0.1, placement: "full_circle", distance: 20, gap: 0, gapWidth: 0, cornerStyle: "round", evenDistribution: true, shape: "circle", fillColor: 0, textColor: 0, fontWeight: "bold" },
      });
      const warnings = computeVectorByWallsWarnings(elevatorNodes, elevatorEdges, squareCfg, settings, null, null, elevatorNodes);
      expect(warnings.filter((w) => w.id === "elevator_badges_overlap")).toHaveLength(0);
    });

    it("when only the floor-scoped source node is visible (targets' floors unresolvable), no overlap can be detected", () => {
      // Mirrors a real floor-scoped `nodes` list: only node 0 (the elevator's own `from`, on the
      // active floor) is present — the fan's targets on other floors are structurally absent, so
      // without a separate unscoped node list their floors can't resolve at all.
      const settings = baseSettings({
        elevatorBadges: { enabled: true, labelType: "arabic", size: 1, placement: "left_right", distance: 0, gap: 0, gapWidth: 0, cornerStyle: "round", evenDistribution: true, shape: "circle", fillColor: 0, textColor: 0, fontWeight: "bold" },
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
        elevatorBadges: { enabled: true, labelType: "arabic", size: 20, placement: "left_right", distance: 0, gap: 0, gapWidth: 0, cornerStyle: "round", evenDistribution: true, shape: "circle", fillColor: 0, textColor: 0, fontWeight: "bold" },
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
        elevatorBadges: { enabled: true, labelType: "arabic", size: 20, placement: "full_circle", distance: 0, gap: 0, gapWidth: 0, cornerStyle: "round", evenDistribution: true, shape: "circle", fillColor: 0, textColor: 0, fontWeight: "bold" },
      });
      const warnings = computeVectorByWallsWarnings(elevatorNodes, elevatorEdges, squareCfg, settings, null, null, elevatorNodes);
      expect(warnings.filter((w) => w.id === "elevator_badges_too_many")).toHaveLength(0);
    });

    it("does not flag when badges fit within one row per side", () => {
      const settings = baseSettings({
        elevatorBadges: { enabled: true, labelType: "arabic", size: 0.1, placement: "left_right", distance: 0, gap: 0, gapWidth: 0, cornerStyle: "round", evenDistribution: true, shape: "circle", fillColor: 0, textColor: 0, fontWeight: "bold" },
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
      const settings = baseCorridorsSettings({ teleportEdgeBorderWidth: 0 });
      const warnings = computeVectorByCorridorsWarnings(nodes, edges, squareCfg, settings, null, null);
      expect(warnings.filter((w) => w.id === "teleport_marker_invisible")).toHaveLength(1);
    });

    it("flags a teleport marker overlapping the start marker's footprint", () => {
      const nodes = [n(0, 0, 0), n(1, 0, 0), n(2, 3, 3)];
      const edges = [teleport(1, 2)];
      const settings = baseCorridorsSettings({ teleportLineSize: 0.4 });
      const warnings = computeVectorByCorridorsWarnings(nodes, edges, squareCfg, settings, 0, null);
      expect(warnings.filter((w) => w.id === "teleport_waypoint_overlap")).toHaveLength(1);
    });
  });
});
