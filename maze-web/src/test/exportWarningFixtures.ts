import { DEFAULT_CREASE_STYLE, DEFAULT_GLUE_TAB_STYLE, DEFAULT_EDGE_MARKER_STYLE } from "../store/slices/imageExportDefaults";
import type { NodeDto, EdgeDto } from "../wasm/types";
import type { FieldConfig } from "../fieldConfig";
import type { VectorByWallsSettings, VectorByCorridorsSettings, MarkerSettings } from "../store/storeTypes";
import { canvas } from "../pixi/colorTokens";
import { DEFAULT_SHARED_STYLE_SOURCE, DEFAULT_VERTICAL_SETTINGS, DEFAULT_VERTICAL_DECORATIVE_SETTINGS, DEFAULT_VERTICAL_SHARED_STYLE, DEFAULT_MARKER_INDEX_SETTINGS, DEFAULT_FLOOR_LABEL_SETTINGS } from "../store/slices/imageExportSlice";
import { DEFAULT_VECTOR_BY_WALLS_LINKS, DEFAULT_VECTOR_BY_CORRIDORS_LINKS } from "../store/slices/parameterLinksDefaults";
import { fieldOf } from "./fieldConfigFixtures";
import { bridgeSplitNodes, bridgeSplitEdges } from "./splitTopologyFixtures";

/** Settings and maze fixtures shared by the export-warning cache tests (GitHub issue #928). */

export const squareCfg: FieldConfig = fieldOf("square", { shape: "rect", cols: 6, rows: 6 });

const defaultMarker: MarkerSettings = {
  shape: "circle", cornerStyle: "miter", fillColor: canvas.node.start, borderColor: canvas.node.start,
  borderWidth: 0, gapWidth: 0, size: 12, sizeAdaptation: 0, text: "",
};

const teleportMarker = { sizeAdaptation: 0, cornerStyle: "round", shape: "diamond", size: 6.4, fillColor: 0xff0000, borderColor: 0xff0000, borderWidth: 3, gapWidth: 3 } as const;
const teleportFloorBadge = { sizeAdaptation: 0, shape: "circle", labelType: "arabic", cornerStyle: "round", gapWidth: 3, size: 6.4, fillColor: 0x123456, borderColor: 0x123456, borderWidth: 3, textColor: 0x123456, textFontWeight: "bold", textSize: 12, textMargin: 1 } as const;

export function wallsSettings(overrides: Partial<VectorByWallsSettings> = {}): VectorByWallsSettings {
  return {
    background: 0, showGrid: true, gridColor: 0x808080, showCutLines: true, cutLinesGlueColor: true, cutLinesColor: 0x808080, creases: DEFAULT_CREASE_STYLE, glueTabs: DEFAULT_GLUE_TAB_STYLE, edgeMarkers: DEFAULT_EDGE_MARKER_STYLE, showInnerGrid: false, innerGridColor: 0x808080, floorColor: 0, wallColor: 0, randomWallColorMode: "off", wallJoin: "round", wallThickness: 4,
    oneWayPattern: "triangle", oneWayColor: 0, oneWayGapWidth: 3, oneWaySize: 12, oneWayThickness: 4, oneWayJoin: "round",
    markerLayout: "auto", markerScale: 1,
    startMarker: defaultMarker, finishMarker: defaultMarker,
    teleportMarker: { ...teleportMarker },
    teleportConnectorColor: 0xff0000, teleportConnectorWidth: 3, teleportConnectorStyle: "orthogonal",
    teleportAvoidFieldExit: false, teleportMergeMode: true, teleportArrowMode: "periodic", teleportArrowPeriod: 5, teleportArrowSize: 10,
    teleportConnectorGapWidth: 3, teleportFloorBadge: { ...teleportFloorBadge }, teleportGroupCustomization: false, teleportGroupOverrides: {},
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

export function corridorsSettings(overrides: Partial<VectorByCorridorsSettings> = {}): VectorByCorridorsSettings {
  return {
    background: 0, showGrid: true, gridColor: 0x808080, showCutLines: true, cutLinesGlueColor: true, cutLinesColor: 0x808080, creases: DEFAULT_CREASE_STYLE, glueTabs: DEFAULT_GLUE_TAB_STYLE, edgeMarkers: DEFAULT_EDGE_MARKER_STYLE,
    color: 0, thickness: 4, junctionRadius: 4, join: "round", renderStyle: "contour",
    markerLayout: "auto", markerScale: 1,
    startMarker: defaultMarker, finishMarker: defaultMarker,
    markerWidenPadding: 0, markerWidenShape: "match_marker",
    oneWayColor: 0, oneWayCount: 1, oneWayThickness: 4, oneWayGap: 4, oneWayWidth: 1, oneWayLength: 1, oneWayJoin: "round",
    teleportMarker: { ...teleportMarker },
    teleportConnectorColor: 0xff0000, teleportConnectorWidth: 3, teleportConnectorStyle: "orthogonal",
    teleportAvoidFieldExit: false, teleportMergeMode: true, teleportArrowMode: "periodic", teleportArrowPeriod: 5, teleportArrowSize: 10,
    teleportConnectorGapWidth: 3, teleportFloorBadge: { ...teleportFloorBadge }, teleportGroupCustomization: false, teleportGroupOverrides: {},
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

const n = (id: number, x: number, y: number, level: number): NodeDto => ({ id, x, y, i: 0, level });
const e = (from: number, to: number, kind: EdgeDto["kind"] = "basic"): EdgeDto => ({ from, to, kind });
const both = (a: number, b: number, kind: EdgeDto["kind"]): EdgeDto[] => [e(a, b, kind), e(b, a, kind)];

export type WarningMaze = { nodes: NodeDto[]; edges: EdgeDto[]; floors: { id: string; title?: string }[]; start: number | null; finish: number | null };

/** Two floors: a bridge split point (the start sits on it), a plain two-node split, a same-floor and a cross-floor teleport, an elevator, a two-way and a one-way
 *  vertical passage, two elevator shafts sharing a cell, and one-way basic edges. */
export function twoFloorMaze(): WarningMaze {
  const floor0 = bridgeSplitNodes.map((node) => ({ ...node, level: 0 }));
  return {
    nodes: [
      ...floor0,
      n(10, 2, 2, 0), n(11, 3, 2, 0), n(12, 2, 3, 0), n(13, 2, 3, 0),
      n(20, 2, 2, 1), n(21, 3, 2, 1), n(22, 5, 5, 1), n(23, 2, 3, 1), n(24, 2, 3, 1),
      n(30, 4, 1, 0), n(31, 4, 1, 0), n(32, 5, 1, 0), n(33, 4, 2, 0),
    ],
    edges: [
      ...bridgeSplitEdges,
      e(10, 11), e(11, 10), e(11, 12), e(20, 21), e(21, 20), e(21, 22),
      e(30, 32), e(32, 30), e(31, 33), e(33, 31),
      ...both(0, 10, "teleport"),
      ...both(6, 22, "teleport"),
      ...both(12, 23, "elevator"),
      ...both(13, 24, "elevator"),
      ...both(11, 21, "vertical_passage"),
      e(10, 20, "vertical_passage"),
      e(4, 24, "vertical_passage"),
    ],
    floors: [{ id: "f0", title: "Ground" }, { id: "f1", title: "Upper" }],
    start: 0,
    finish: 22,
  };
}
