import { beforeEach, expect, vi } from "vitest";
import { VectorByCorridorsRenderer } from "../pixi/imageExport/VectorByCorridorsRenderer";
import { buildCorridorSegments } from "../pixi/selectors/mazeSelectors";
import type { NodeDto, EdgeDto } from "../wasm/types";
import type { FieldConfig } from "../fieldConfig";
import type { VectorByCorridorsSettings } from "../store/storeTypes";
import { DEFAULT_VERTICAL_SETTINGS, DEFAULT_VERTICAL_SHARED_STYLE, DEFAULT_MARKER_INDEX_SETTINGS, DEFAULT_FLOOR_LABEL_SETTINGS } from "../store/slices/imageExportDefaults";
import { DEFAULT_VECTOR_BY_CORRIDORS_LINKS } from "../store/slices/parameterLinksDefaults";
import { fieldOf } from "./fieldConfigFixtures";
import { mockStore } from "./vbcMocks";

export const startMarker: VectorByCorridorsSettings["startMarker"] = { shape: "circle", cornerStyle: "miter", fillColor: 0, borderColor: 0, borderWidth: 0, gapWidth: 0, size: 0.1, sizeAdaptation: 0, text: "S" };
export const finishMarker: VectorByCorridorsSettings["finishMarker"] = { shape: "circle", cornerStyle: "miter", fillColor: 0, borderColor: 0, borderWidth: 0, gapWidth: 0, size: 0.1, sizeAdaptation: 0, text: "F" };
export const teleportDefaults: Pick<VectorByCorridorsSettings,
  "teleportMarker" | "teleportConnectorColor" | "teleportConnectorWidth" | "teleportConnectorStyle" |
  "teleportAvoidFieldExit" | "teleportMergeMode" | "teleportArrowMode" | "teleportArrowPeriod" | "teleportArrowSize" | "teleportConnectorGapWidth" |
  "teleportFloorBadge" | "teleportGroupCustomization" | "teleportGroupOverrides"
> = {
  teleportMarker: { sizeAdaptation: 0, cornerStyle: "miter", shape: "diamond", size: 0.16, fillColor: 0, borderColor: 0, borderWidth: 3, gapWidth: 3 },
  teleportConnectorColor: 0, teleportConnectorWidth: 3, teleportConnectorStyle: "orthogonal", teleportAvoidFieldExit: false, teleportMergeMode: true,
  teleportArrowMode: "periodic", teleportArrowPeriod: 5, teleportArrowSize: 10, teleportConnectorGapWidth: 3,
  teleportFloorBadge: { sizeAdaptation: 0, shape: "circle", labelType: "arabic", cornerStyle: "round", gapWidth: 3, size: 0.16, fillColor: 0x123456, borderColor: 0x123456, borderWidth: 3, textColor: 0x123456, textFontWeight: "bold", textSize: 12, textMargin: 1 },
  teleportGroupCustomization: false, teleportGroupOverrides: {},
};
export const oneWayDefaults: Pick<VectorByCorridorsSettings, "oneWayColor" | "oneWayCount" | "oneWayThickness" | "oneWayGap" | "oneWayWidth" | "oneWayLength" | "oneWayJoin"> = {
  oneWayColor: 0, oneWayCount: 1, oneWayThickness: 4, oneWayGap: 4, oneWayWidth: 1, oneWayLength: 10, oneWayJoin: "round",
};
export const splitDefaults: Pick<VectorByCorridorsSettings, "splitNodeColors" | "splitSpecialShapes" | "splitGapWidth" | "splitDiagonalBowAmount"> = {
  splitNodeColors: [], splitSpecialShapes: true, splitGapWidth: 3, splitDiagonalBowAmount: 0.15,
};
export const sharedStyleSource = { markerShape: "circle" as const, markerFillColor: 0, markerBorderColor: 0, cornerStyle: "round" as const, markerSize: 0.16, markerBorderWidth: 3, gapWidth: 3, markerTextSize: 17, markerTextMargin: 1, markerSizeAdaptation: 0, markerTextFontWeight: "bold" as const, floorLabelType: "letters" as const };
export const settingsA: VectorByCorridorsSettings = { background: 0x000000, showGrid: true, gridColor: 0x333333, color: 0x111111, thickness: 10, junctionRadius: 4, join: "round", renderStyle: "contour", markerLayout: "auto", markerScale: 1, startMarker, finishMarker, markerWidenPadding: 4, markerWidenShape: "match_marker", ...oneWayDefaults, ...teleportDefaults, ...DEFAULT_VERTICAL_SETTINGS, ...DEFAULT_VERTICAL_SHARED_STYLE, ...splitDefaults, markerIndex: DEFAULT_MARKER_INDEX_SETTINGS, floorLabel: DEFAULT_FLOOR_LABEL_SETTINGS, ...sharedStyleSource, links: DEFAULT_VECTOR_BY_CORRIDORS_LINKS };
export const settingsB: VectorByCorridorsSettings = { background: 0x000000, showGrid: true, gridColor: 0x333333, color: 0x222222, thickness: 20, junctionRadius: 4, join: "miter", renderStyle: "contour", markerLayout: "auto", markerScale: 1, startMarker, finishMarker, markerWidenPadding: 4, markerWidenShape: "match_marker", ...oneWayDefaults, ...teleportDefaults, ...DEFAULT_VERTICAL_SETTINGS, ...DEFAULT_VERTICAL_SHARED_STYLE, ...splitDefaults, markerIndex: DEFAULT_MARKER_INDEX_SETTINGS, floorLabel: DEFAULT_FLOOR_LABEL_SETTINGS, ...sharedStyleSource, links: DEFAULT_VECTOR_BY_CORRIDORS_LINKS };

// Stable references reused across `baseState()` calls — the renderer's own geometry cache keys off
// reference-equality of `nodes`/`edges`/`activeFieldConfig` (same convention as
// `VectorByWallsRenderer`'s own cache), so a fresh literal on every call would look like a data
// change even when a test means to vary only `vectorByCorridorsSettings`.
export const stableNodes: NodeDto[] = [];
export const stableEdges: EdgeDto[] = [];
export const stableCfg: FieldConfig = fieldOf("square", { shape: "rect", cols: 4, rows: 4 });

export const stableFloors = [{ id: "floor_1", title: "Floor 1" }];

export function baseState(overrides: Record<string, unknown> = {}) {
  return {
    openCard: "image_export",
    nodes: stableNodes,
    edges: stableEdges,
    activeFieldConfig: stableCfg,
    vectorByCorridorsSettings: settingsA,
    vectorByCorridorsSectionsExpanded: {},
    floors: stableFloors,
    activeFloorId: "floor_1",
    start: null,
    finish: null,
    postEditMeta: null,
    postEditDraftSplitPoints: {},
    ...overrides,
  };
}


/** Resets mocks and the store stand-in before every test. */
export function useRendererReset() {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.subscribeCallback = null;
    mockStore.current = baseState();
  });
}

export type MockFn = ReturnType<typeof vi.fn>;
export type TileContext = { moveTo: MockFn; lineTo: MockFn; closePath: MockFn; fill: MockFn; stroke: MockFn; circle: MockFn };
export type Tile = { key: string; offset: { x: number; y: number }; graphics: { tint: number; context: TileContext } };
export const tilesOf = (renderer: VectorByCorridorsRenderer): Tile[] =>
  [...(renderer as unknown as { corridorTiles: { tiles: Map<unknown, Tile> } }).corridorTiles.tiles.values()];
export const tileAt = (renderer: VectorByCorridorsRenderer, p: { x: number; y: number }): Tile => {
  const tile = tilesOf(renderer).find((t) => t.offset.x === p.x && t.offset.y === p.y);
  expect(tile, `tile at ${p.x},${p.y}`).toBeDefined();
  return tile!;
};
export const corridorsOf = (renderer: VectorByCorridorsRenderer) =>
  (renderer as unknown as { corridors: { stroke: MockFn; fill: MockFn; circle: MockFn } }).corridors;
export const turn = (a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }) => {
  vi.mocked(buildCorridorSegments).mockReturnValueOnce([
    { v0: a, v1: b, fromNode: 1, toNode: 2 },
    { v0: b, v1: c, fromNode: 2, toNode: 3 },
  ] as never);
};

export const makeRenderer = () => new VectorByCorridorsRenderer({ addChild: vi.fn() } as never);
