import type { OneWayStyleOverride, TeleportLineStyle, WallStyleOverride } from "./renderers/types";
import type { VerticalConnectionStyle } from "./renderers/VerticalConnectionRenderer";
import type { MarkerStyle } from "./selectors/mazeSelectors";
import { canvas } from "./colorTokens";
import { TILE_SIZE } from "./constants";
import { WALL_THICKNESS, DEFAULT_ELEVATOR_BADGE_TEXT_SIZE, DEFAULT_TELEPORT_BADGE_TEXT_SIZE, DEFAULT_TEXT_MARGIN } from "./renderConstants";

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

const DECORATIVE_STAIRS_ONE_WAY_ARROW_DARK = 0x196c64;

// Shared marker standard (GitHub issue #681 follow-up) — every bordered marker (start, finish,
// teleport edge/floor badge, vertical passage, elevator) defaults to the same size/border so they
// read as one visual system regardless of type.
const MARKER_SIZE = 17;
const MARKER_BORDER_WIDTH = 3;
const DEFAULT_TELEPORT_BADGE_SIZE = 12;
const DEFAULT_ELEVATOR_BADGE_SIZE = 12;

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
  startMarker: { shape: "circle", fillColor: canvas.node.start, borderColor: canvas.node.start, borderWidth: MARKER_BORDER_WIDTH, size: MARKER_SIZE, cornerStyle: "round", gapWidth: 3, gapColor: canvas.floor.default, text: "" },
  finishMarker: { shape: "circle", fillColor: canvas.node.finish, borderColor: canvas.node.finish, borderWidth: MARKER_BORDER_WIDTH, size: MARKER_SIZE, cornerStyle: "round", gapWidth: 3, gapColor: canvas.floor.default, text: "" },
  teleport: {
    shape: "diamond", cornerStyle: "round", size: MARKER_SIZE,
    edgeColor: canvas.teleport.default, edgeBorderColor: canvas.teleport.default,
    borderWidth: MARKER_BORDER_WIDTH, edgeGapWidth: 3,
    connectorColor: canvas.teleport.default, connectorWidth: 3, connectorStyle: "orthogonal",
    arrowMode: "periodic", arrowPeriod: 5, arrowSize: 10, connectorGapWidth: 3,
    floorColor: canvas.floor.default,
    // GitHub issue #485 — defaults reproduce the pre-#485 hardcoded look exactly: a circle at the
    // edge marker's own default `size` (now a diameter — GitHub issue #681 follow-up), an Arabic
    // digit in a floor-colored knockout, a 3px border (the shared `borderWidth` above).
    // `fillColor`/`borderColor` default to the connector color, matching the pre-#503 locked look.
    floorBadge: { shape: "circle", cornerStyle: "round", gapWidth: 3, labelType: "arabic", size: DEFAULT_TELEPORT_BADGE_SIZE, fillColor: canvas.teleport.default, borderColor: canvas.teleport.default, borderWidth: MARKER_BORDER_WIDTH, textColor: canvas.floor.default, textFontWeight: "bold", textSize: DEFAULT_TELEPORT_BADGE_TEXT_SIZE, textMargin: DEFAULT_TEXT_MARGIN },
  },
  verticalConnections: {
    style: "abstract",
    twoWayPassageMarker: { shape: "circle", cornerStyle: "round", fillColor: canvas.vertical.default, borderColor: canvas.vertical.default, borderWidth: MARKER_BORDER_WIDTH, gapWidth: 3, gapColor: canvas.floor.default, size: MARKER_SIZE },
    oneWayPassageMarker: { shape: "circle", cornerStyle: "round", fillColor: canvas.vertical.default, borderColor: canvas.vertical.default, borderWidth: MARKER_BORDER_WIDTH, gapWidth: 3, gapColor: canvas.floor.default, size: MARKER_SIZE },
    elevatorMarker: { shape: "diamond", cornerStyle: "round", fillColor: canvas.vertical.default, borderColor: canvas.vertical.default, borderWidth: MARKER_BORDER_WIDTH, gapWidth: 3, gapColor: canvas.floor.default, size: MARKER_SIZE },
    twoWayArrowColor: canvas.floor.default, twoWayArrowSize: 0.75, twoWayArrowStyle: "triangle", twoWayArrowCornerStyle: "round",
    oneWayArrowColor: canvas.floor.default, oneWayArrowSize: 0.75, oneWayArrowStyle: "triangle", oneWayArrowCornerStyle: "round",
    elevatorArrowColor: canvas.floor.default, elevatorArrowSize: 0.75, elevatorArrowStyle: "triangle", elevatorArrowCornerStyle: "round",
    decorativeStairsTwoWay: { lineColor: canvas.vertical.default, lineWidth: 3, size: TILE_SIZE * 0.44 },
    decorativeStairsOneWay: { lineColor: canvas.vertical.default, lineWidth: 3, size: TILE_SIZE * 0.44 },
    decorativeElevator: { lineColor: canvas.vertical.default, lineWidth: 3, size: TILE_SIZE * 0.44 },
    decorativeStairsArrowColor: canvas.floor.default, decorativeStairsArrowSize: 0.75,
    decorativeStairsOneWayArrowColor: DECORATIVE_STAIRS_ONE_WAY_ARROW_DARK, decorativeStairsOneWayArrowSize: 0.75,
    elevatorBadges: { enabled: false, labelType: "arabic", size: DEFAULT_ELEVATOR_BADGE_SIZE, placement: "top_bottom", distance: 4, gap: 2, gapWidth: 2, cornerStyle: "round", evenDistribution: false, shape: "circle", fillColor: 0xf0c900, borderColor: 0xf0c900, borderWidth: 0, textColor: canvas.floor.default, textFontWeight: "bold", textSize: DEFAULT_ELEVATOR_BADGE_TEXT_SIZE, textMargin: DEFAULT_TEXT_MARGIN },
  },
  split: { nodeColors: [], specialShapes: true },
};
