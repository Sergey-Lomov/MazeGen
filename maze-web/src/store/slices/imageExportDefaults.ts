import type {
  VectorByWallsSettings,
  VectorByCorridorsSettings,
  VectorByWallsSharedStyle,
  VectorByCorridorsSharedStyle,
  TeleportSettingsFields,
  OneWaySettingsFields,
  VerticalSettingsFields,
  PngExportSettings,
} from "../storeTypes";
import { canvas } from "../../pixi/colorTokens";
import { WALL_THICKNESS } from "../../pixi/renderConstants";
import { TILE_SIZE } from "../../pixi/constants";
import {
  applyVectorByWallsSharedStyle,
  applyVectorByCorridorsSharedStyle,
} from "./imageExportSliceHelpers";

/** Shared defaults for the centralized "Shared style" section (GitHub issue #322) — the single
 * source of truth every dependent field's own default is derived from below (`applyVectorBy*
 * SharedStyle`), rather than each field separately hardcoding the same number. Changing a value
 * here changes every dependent field's default in lockstep. */
/** `twoWayPassage`/`oneWayPassage`/`elevator` start pre-overridden in every group (GitHub issue
 * #347 follow-up) — unlike `startMarker`/`finishMarker` (which intentionally start out following
 * the shared style), the three vertical-connection markers' own defaults (`DEFAULT_VERTICAL_
 * SETTINGS`) are pinned to match `GenerationRenderer`'s fixed `DEFAULT_VERTICAL_STYLE` look
 * instead, so they must not be silently overwritten by `applyVectorByWallsSharedStyle` right
 * after. The user is still free to pull them back onto the shared value via the panel's own
 * per-field reset button. */
export const DEFAULT_VECTOR_BY_WALLS_SHARED_STYLE: VectorByWallsSharedStyle = {
  cornerStyle: "round",
  markerSize: 0.16,
  markerBorderWidth: 3,
  gapWidth: 3,
  overrides: {
    cornerStyle: { twoWayPassage: true, oneWayPassage: true, elevator: true },
    markerSize: { twoWayPassage: true, oneWayPassage: true, elevator: true },
    markerBorderWidth: { twoWayPassage: true, oneWayPassage: true, elevator: true },
    gapWidth: { twoWayPassage: true, oneWayPassage: true, elevator: true },
  },
};

export const DEFAULT_VECTOR_BY_CORRIDORS_SHARED_STYLE: VectorByCorridorsSharedStyle = {
  cornerStyle: "round",
  markerSize: 0.16,
  markerBorderWidth: 3,
  gapWidth: 3,
  overrides: {},
};

/** Shared by both `VectorByWallsSettings` and `VectorByCorridorsSettings` — GitHub issue #313
 * extracted this out so the two modes' Teleports section defaults never drift apart, mirroring
 * `TeleportSettingsFields` itself being shared at the type level. The four fields driven by
 * "Shared style" (GitHub issue #322: `teleportLineCornerStyle`, `teleportLineSize`,
 * `teleportEdgeBorderWidth`, `teleportEdgeGapWidth`/`teleportConnectorGapWidth`) hold placeholder
 * values here — `applyVectorBy*SharedStyle` overwrites them from `DEFAULT_VECTOR_BY_*_SHARED_STYLE`
 * once assembled into a full settings object below, so this const is never used directly as a
 * finished default on its own. */
export const DEFAULT_TELEPORT_SETTINGS: TeleportSettingsFields = {
  teleportLineCornerStyle: "round",
  teleportLineShape: "diamond",
  teleportLineSize: 0,
  teleportEdgeColor: canvas.teleport.default,
  teleportEdgeBorderColor: canvas.teleport.default,
  teleportEdgeBorderWidth: 0,
  teleportEdgeGapWidth: 0,
  teleportConnectorColor: canvas.teleport.default,
  teleportConnectorWidth: 3,
  teleportConnectorStyle: "orthogonal",
  teleportAvoidFieldExit: false,
  teleportArrowMode: "periodic",
  teleportArrowPeriod: 5,
  teleportArrowSize: 10,
  teleportConnectorGapWidth: 0,
  teleportGroupCustomization: false,
  teleportGroupOverrides: {},
};

/** Shared by `VectorByWallsSettings` and `projectExport/validate.ts`'s recovery defaults, same
 * extraction rationale as `DEFAULT_TELEPORT_SETTINGS`/`DEFAULT_ONE_WAY_SETTINGS` (GitHub issue
 * #347, three-section split GitHub issue #347 follow-up). Defaults match `GenerationRenderer`'s
 * own fixed `DEFAULT_VERTICAL_STYLE` (circle for `VerticalPassage`, diamond for `Elevator`, border
 * width 2, size 0.22), the same "exported image looks identical to the editor view until changed"
 * rationale every other "Vector by walls" section's own defaults follow. `verticalStyle` defaults
 * to `"abstract"` (not `"decorative"`) — a plain opening marker is the one style that's also
 * correct for a physical single-sheet two-floor build, per the issue's own rationale;
 * `"decorative"` is an opt-in choice for a purely visual/print export. A two-way passage/elevator
 * marker draws solid (`filled: true`), so its own `fillColor` defaults to `canvas.vertical.default`
 * same as its border; a one-way passage marker (GitHub issue #347 fourth follow-up redesign) reads
 * as a dark-accented variant of that same look at both ends — its own `fillColor` defaults to
 * `canvas.vertical.default` too (the "primary" color, the arrival end's ordinary fill), while
 * `oneWayAccentColor` (the "secondary" color) defaults to a fixed dark accent
 * (`ONE_WAY_ACCENT_DARK`) driving both the arrival-end border and the departure-end's entire fill.
 * Every section's own `*ArrowColor` defaults to `canvas.floor.default` (GitHub issue #347 fifth
 * follow-up — `oneWayArrowColor` moved off `canvas.vertical.default` to match the other two
 * sections), so the arrow reads as a floor-colored cutout against the marker's own fill. */
const ONE_WAY_ACCENT_DARK = 0x196c64;

export const DEFAULT_VERTICAL_SETTINGS: VerticalSettingsFields = {
  verticalStyle: "abstract",
  twoWayPassageMarker: { shape: "circle", cornerStyle: "round", fillColor: canvas.vertical.default, borderColor: canvas.vertical.default, borderWidth: 3, gapWidth: 3, size: 0.22 },
  oneWayPassageMarker: { shape: "circle", cornerStyle: "round", fillColor: canvas.vertical.default, borderColor: canvas.vertical.default, borderWidth: 3, gapWidth: 3, size: 0.22 },
  elevatorMarker: { shape: "diamond", cornerStyle: "round", fillColor: canvas.vertical.default, borderColor: canvas.vertical.default, borderWidth: 3, gapWidth: 3, size: 0.22 },
  twoWayArrowColor: canvas.floor.default,
  twoWayArrowSize: 0.75,
  twoWayArrowStyle: "triangle",
  twoWayArrowCornerStyle: "round",
  oneWayArrowColor: canvas.floor.default,
  oneWayArrowSize: 0.75,
  oneWayArrowStyle: "triangle",
  oneWayArrowCornerStyle: "round",
  oneWayAccentColor: ONE_WAY_ACCENT_DARK,
  elevatorArrowColor: canvas.floor.default,
  elevatorArrowSize: 0.75,
  elevatorArrowStyle: "triangle",
  elevatorArrowCornerStyle: "round",
};

/** Shared with `projectExport/validate.ts`'s recovery defaults for old/malformed project files
 * (GitHub issue #295) — kept as a single exported const so the two never drift apart.
 * `startMarker`/`finishMarker`/`wallJoin`/`oneWayJoin`/every `teleportLine*`/`teleportEdge*`/
 * `teleportConnectorGapWidth` field driven by "Shared style" (GitHub issue #322) holds a
 * placeholder value below, overwritten by `applyVectorByWallsSharedStyle` right after — see that
 * function's own doc comment for exactly which fields it touches. */
export const DEFAULT_VECTOR_BY_WALLS_SETTINGS: VectorByWallsSettings = applyVectorByWallsSharedStyle(
  {
    background: canvas.stage.background,
    showGrid: true,
    gridColor: canvas.grid.line,
    floorColor: canvas.floor.default,
    wallColor: canvas.wall.default,
    wallJoin: "round",
    wallThickness: WALL_THICKNESS,
    oneWayPattern: "triangle",
    oneWayColor: 0xffaa00,
    oneWayGapWidth: 3,
    oneWaySize: 0.3,
    oneWayThickness: 4,
    oneWayJoin: "round",
    startMarker: { shape: "circle", cornerStyle: "round", fillColor: canvas.node.start, borderColor: canvas.node.start, borderWidth: 0, gapWidth: 0, size: 0 },
    finishMarker: { shape: "circle", cornerStyle: "round", fillColor: canvas.node.finish, borderColor: canvas.node.finish, borderWidth: 0, gapWidth: 0, size: 0 },
    ...DEFAULT_TELEPORT_SETTINGS,
    ...DEFAULT_VERTICAL_SETTINGS,
    splitNodeColors: [],
    splitSpecialShapes: true,
    sharedStyle: DEFAULT_VECTOR_BY_WALLS_SHARED_STYLE,
  },
  ["cornerStyle", "markerSize", "markerBorderWidth", "gapWidth"],
);

/** Shared by `VectorByCorridorsSettings` and `projectExport/validate.ts`'s recovery defaults, same
 * extraction rationale as `DEFAULT_TELEPORT_SETTINGS` (GitHub issue #312). `oneWayColor` defaults
 * to the canvas background per the issue's own spec (a break in the corridor stroke, not an
 * indicator drawn on top of it). `oneWayThickness` defaults to half of the settings panel's own
 * max (`TILE_SIZE / 4`), same "half of the panel's own cap" convention
 * `DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS.thickness` uses for the corridor stroke itself. */
export const DEFAULT_ONE_WAY_SETTINGS: OneWaySettingsFields = {
  oneWayColor: canvas.stage.background,
  oneWayCount: 2,
  oneWayThickness: TILE_SIZE / 8,
  oneWayGap: 2,
  oneWayWidth: 0.5,
  oneWayLength: 0.3,
  oneWayJoin: "round",
};

/** Shared with `projectExport/validate.ts`'s recovery defaults, same convention as
 * `DEFAULT_VECTOR_BY_WALLS_SETTINGS`. `thickness` defaults to half of the settings panel's own max
 * (`TILE_SIZE`, GitHub issue #310's follow-up) rather than the fixed `WALL_THICKNESS` "Vector by
 * walls" uses — a corridor's meaningful range scales with the cell size, so its default should too.
 * Same "Shared style" placeholder-then-overwrite convention as `DEFAULT_VECTOR_BY_WALLS_SETTINGS`
 * (`join`/`oneWayJoin`/markers/teleport fields/`splitGapWidth` — see
 * `applyVectorByCorridorsSharedStyle`). */
export const DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS: VectorByCorridorsSettings = applyVectorByCorridorsSharedStyle(
  {
    background: canvas.stage.background,
    showGrid: true,
    gridColor: canvas.grid.line,
    color: canvas.wall.default,
    thickness: TILE_SIZE / 2,
    join: "round",
    startMarker: { shape: "circle", cornerStyle: "round", fillColor: canvas.node.start, borderColor: canvas.node.start, borderWidth: 0, gapWidth: 0, size: 0 },
    finishMarker: { shape: "circle", cornerStyle: "round", fillColor: canvas.node.finish, borderColor: canvas.node.finish, borderWidth: 0, gapWidth: 0, size: 0 },
    markerWidenPadding: 4,
    markerWidenShape: "match_marker",
    ...DEFAULT_ONE_WAY_SETTINGS,
    ...DEFAULT_TELEPORT_SETTINGS,
    splitNodeColors: [],
    splitSpecialShapes: true,
    splitGapWidth: 0,
    splitDiagonalBowAmount: 0.15,
    sharedStyle: DEFAULT_VECTOR_BY_CORRIDORS_SHARED_STYLE,
  },
  ["cornerStyle", "markerSize", "markerBorderWidth", "gapWidth"],
);

/** Shared with `projectExport/validate.ts`'s recovery defaults, same convention as
 * `DEFAULT_VECTOR_BY_WALLS_SETTINGS`. */
export const DEFAULT_PNG_EXPORT_SETTINGS: PngExportSettings = {
  outputMode: "digital",
  digital: { scale: 1, canvasMode: "edge_to_edge", marginValue: 20, fixedWidth: 1920, fixedHeight: 1080 },
  print: { density: "print_300", paperSize: "a4", customWidthMm: 210, customHeightMm: 297, orientation: "landscape", marginHMm: 5, marginVMm: 5, scale: 1, scaleAutoFit: true, anchor: "center", offsetXMm: 0, offsetYMm: 0 },
};
