import type { OneWayStyleOverride, TeleportLineStyle, WallStyleOverride } from "./renderers/types";
import type { VerticalConnectionStyle } from "./renderers/VerticalConnectionRenderer";
import type { MarkerStyle } from "./selectors/mazeSelectors";
import { canvas } from "./colorTokens";
import { TILE_SIZE } from "./constants";
import { WALL_THICKNESS } from "./renderConstants";

export interface MazeRenderStyle {
  backgroundColor: number;
  floorColor: number;
  grid: { visible: boolean; color: number };
  wall: Required<WallStyleOverride>;
  oneWay: Required<OneWayStyleOverride>;
  startMarker: MarkerStyle;
  finishMarker: MarkerStyle;
  teleport: TeleportLineStyle;
  verticalConnections: VerticalConnectionStyle;
  split: { nodeColors: readonly number[]; specialShapes: boolean };
}

const ONE_WAY_ACCENT_DARK = 0x196c64;

/** Canonical live-canvas style and source for matching image-export defaults. */
export const DEFAULT_MAZE_RENDER_STYLE: MazeRenderStyle = {
  backgroundColor: canvas.stage.background,
  floorColor: canvas.floor.default,
  grid: { visible: true, color: canvas.grid.line },
  wall: { color: canvas.wall.default, width: WALL_THICKNESS, join: "round", cap: "round" },
  oneWay: {
    pattern: "triangle", color: 0xffaa00, gapColor: canvas.floor.default, gapWidth: 3,
    size: TILE_SIZE * 0.3, thickness: 4, join: "round", cap: "round",
  },
  startMarker: { shape: "circle", fillColor: canvas.node.start, borderColor: canvas.node.start, borderWidth: 3, size: 0.16, cornerStyle: "round", gapWidth: 3, gapColor: canvas.floor.default },
  finishMarker: { shape: "circle", fillColor: canvas.node.finish, borderColor: canvas.node.finish, borderWidth: 3, size: 0.16, cornerStyle: "round", gapWidth: 3, gapColor: canvas.floor.default },
  teleport: {
    shape: "diamond", cornerStyle: "round", size: 0.16,
    edgeColor: canvas.teleport.default, edgeBorderColor: canvas.teleport.default,
    borderWidth: 3, edgeGapWidth: 3,
    connectorColor: canvas.teleport.default, connectorWidth: 3, connectorStyle: "orthogonal",
    arrowMode: "periodic", arrowPeriod: 5, arrowSize: 10, connectorGapWidth: 3,
    floorColor: canvas.floor.default,
  },
  verticalConnections: {
    style: "abstract",
    twoWayPassageMarker: { shape: "circle", cornerStyle: "round", fillColor: canvas.vertical.default, borderColor: canvas.vertical.default, borderWidth: 3, gapWidth: 3, gapColor: canvas.floor.default, size: 0.22 },
    oneWayPassageMarker: { shape: "circle", cornerStyle: "round", fillColor: canvas.vertical.default, borderColor: canvas.vertical.default, borderWidth: 3, gapWidth: 3, gapColor: canvas.floor.default, size: 0.22 },
    elevatorMarker: { shape: "diamond", cornerStyle: "round", fillColor: canvas.vertical.default, borderColor: canvas.vertical.default, borderWidth: 3, gapWidth: 3, gapColor: canvas.floor.default, size: 0.22 },
    twoWayArrowColor: canvas.floor.default, twoWayArrowSize: 0.75, twoWayArrowStyle: "triangle", twoWayArrowCornerStyle: "round",
    oneWayArrowColor: canvas.floor.default, oneWayArrowSize: 0.75, oneWayArrowStyle: "triangle", oneWayArrowCornerStyle: "round", oneWayAccentColor: ONE_WAY_ACCENT_DARK,
    elevatorArrowColor: canvas.floor.default, elevatorArrowSize: 0.75, elevatorArrowStyle: "triangle", elevatorArrowCornerStyle: "round",
    decorativeStairsTwoWay: { lineColor: canvas.vertical.default, lineWidth: 3, size: 0.22 },
    decorativeStairsOneWay: { lineColor: canvas.vertical.default, lineWidth: 3, size: 0.22 },
    decorativeElevator: { lineColor: canvas.vertical.default, lineWidth: 3, size: 0.22 },
    decorativeStairsArrowColor: canvas.floor.default, decorativeStairsArrowSize: 0.75, decorativeStairsAccentColor: ONE_WAY_ACCENT_DARK,
    elevatorBadges: { enabled: false, labelType: "arabic", size: 0.7, placement: "top_bottom", distance: 4, gap: 2, gapWidth: 2, cornerStyle: "round", evenDistribution: false, shape: "circle", fillColor: 0xf0c900, textColor: canvas.floor.default, fontWeight: "bold" },
  },
  split: { nodeColors: [], specialShapes: true },
};
