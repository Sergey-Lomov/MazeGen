import type {
  VectorByWallsSettings,
  VectorByCorridorsSettings,
  SharedStyleSourceFields,
  VerticalSharedStyleFields,
  TeleportSettingsFields,
  OneWaySettingsFields,
  VerticalSettingsFields,
  VerticalDecorativeFields,
  PngExportSettings,
  MarkerSettings,
  MarkerIndexSettings,
} from "../storeTypes";
import { canvas } from "../../pixi/colorTokens";
import { TILE_SIZE } from "../../pixi/constants";
import { DEFAULT_MAZE_RENDER_STYLE, type MazeRenderStyle } from "../../pixi/defaultMazeRenderStyle";
import { propagate } from "./parameterLinksEngine";
import { DEFAULT_VECTOR_BY_WALLS_LINKS, DEFAULT_VECTOR_BY_CORRIDORS_LINKS } from "./parameterLinksDefaults";

function markerSettings(style: MazeRenderStyle["startMarker"]): MarkerSettings {
  return {
    shape: style.shape,
    cornerStyle: style.cornerStyle,
    fillColor: style.fillColor,
    borderColor: style.borderColor,
    borderWidth: style.borderWidth,
    gapWidth: style.gapWidth,
    size: style.size,
  };
}

/** Shared defaults for the four "Shared style" source values (GitHub issue #322, generalized by
 * #643) — the single source of truth every dependent field's own default is derived from below
 * (via `propagate` over `DEFAULT_VECTOR_BY_*_LINKS`), rather than each field separately
 * hardcoding the same number. Changing a value here changes every dependent field's default in
 * lockstep. `twoWayPassageMarker`/`oneWayPassageMarker`/`elevatorMarker`/`elevatorBadges` links
 * start disabled (GitHub issue #347 follow-up, see `parameterLinksDefaults.ts`) — unlike
 * `startMarker`/`finishMarker` (which intentionally start out following the shared value), the
 * three vertical-connection markers' own defaults (`DEFAULT_VERTICAL_SETTINGS`) are pinned to
 * match `GenerationRenderer`'s fixed `DEFAULT_VERTICAL_STYLE` look instead, so `propagate` below
 * (which only follows enabled links) leaves them alone. The user is still free to pull them onto
 * the shared value via the panel's own per-field reset button. */
export const DEFAULT_SHARED_STYLE_SOURCE: SharedStyleSourceFields = {
  cornerStyle: DEFAULT_MAZE_RENDER_STYLE.startMarker.cornerStyle,
  markerSize: DEFAULT_MAZE_RENDER_STYLE.startMarker.size,
  markerBorderWidth: DEFAULT_MAZE_RENDER_STYLE.startMarker.borderWidth,
  gapWidth: DEFAULT_MAZE_RENDER_STYLE.startMarker.gapWidth,
};

/** Defaults for the "Vertical connections" section's own "Shared style" source values (GitHub
 *  issue #668) — every link out of these starts disabled (`parameterLinksDefaults.ts`), so these
 *  values only take effect once the user links a vertical-marker field to one. Seeded from the
 *  two-way passage marker's own defaults (the "primary" vertical-connection look) for structural
 *  fields/fill color/arrow, and from `canvas.vertical.default` for the decorative line color
 *  (matching `DEFAULT_VERTICAL_DECORATIVE_SETTINGS`'s own per-section line color default). */
export const DEFAULT_VERTICAL_SHARED_STYLE: VerticalSharedStyleFields = {
  verticalCornerStyle: DEFAULT_MAZE_RENDER_STYLE.verticalConnections.twoWayPassageMarker.cornerStyle,
  verticalShape: DEFAULT_MAZE_RENDER_STYLE.verticalConnections.twoWayPassageMarker.shape,
  verticalSize: DEFAULT_MAZE_RENDER_STYLE.verticalConnections.twoWayPassageMarker.size,
  verticalBorderWidth: DEFAULT_MAZE_RENDER_STYLE.verticalConnections.twoWayPassageMarker.borderWidth,
  verticalGapWidth: DEFAULT_MAZE_RENDER_STYLE.verticalConnections.twoWayPassageMarker.gapWidth,
  verticalFillColor: DEFAULT_MAZE_RENDER_STYLE.verticalConnections.twoWayPassageMarker.fillColor,
  verticalArrowColor: DEFAULT_MAZE_RENDER_STYLE.verticalConnections.twoWayArrowColor,
  verticalArrowSize: DEFAULT_MAZE_RENDER_STYLE.verticalConnections.twoWayArrowSize,
  verticalArrowStyle: DEFAULT_MAZE_RENDER_STYLE.verticalConnections.twoWayArrowStyle,
  verticalArrowCornerStyle: DEFAULT_MAZE_RENDER_STYLE.verticalConnections.twoWayArrowCornerStyle,
};

/** Shared by both `VectorByWallsSettings` and `VectorByCorridorsSettings` — GitHub issue #313
 * extracted this out so the two modes' Teleports section defaults never drift apart, mirroring
 * `TeleportSettingsFields` itself being shared at the type level. The four fields driven by
 * "Shared style" (GitHub issue #322: `teleportLineCornerStyle`, `teleportLineSize`,
 * `teleportEdgeBorderWidth`, `teleportEdgeGapWidth`/`teleportConnectorGapWidth`) start from the
 * canonical runtime values here and are reconciled once assembled into a full settings object. */
export const DEFAULT_TELEPORT_SETTINGS: TeleportSettingsFields = {
  teleportLineCornerStyle: DEFAULT_MAZE_RENDER_STYLE.teleport.cornerStyle,
  teleportLineShape: DEFAULT_MAZE_RENDER_STYLE.teleport.shape,
  teleportLineSize: DEFAULT_MAZE_RENDER_STYLE.teleport.size,
  teleportEdgeColor: DEFAULT_MAZE_RENDER_STYLE.teleport.edgeColor,
  teleportEdgeBorderColor: DEFAULT_MAZE_RENDER_STYLE.teleport.edgeBorderColor,
  teleportEdgeBorderWidth: DEFAULT_MAZE_RENDER_STYLE.teleport.borderWidth,
  teleportEdgeGapWidth: DEFAULT_MAZE_RENDER_STYLE.teleport.edgeGapWidth,
  teleportConnectorColor: DEFAULT_MAZE_RENDER_STYLE.teleport.connectorColor,
  teleportConnectorWidth: DEFAULT_MAZE_RENDER_STYLE.teleport.connectorWidth,
  teleportConnectorStyle: DEFAULT_MAZE_RENDER_STYLE.teleport.connectorStyle,
  teleportAvoidFieldExit: false,
  teleportArrowMode: DEFAULT_MAZE_RENDER_STYLE.teleport.arrowMode,
  teleportArrowPeriod: DEFAULT_MAZE_RENDER_STYLE.teleport.arrowPeriod,
  teleportArrowSize: DEFAULT_MAZE_RENDER_STYLE.teleport.arrowSize,
  teleportConnectorGapWidth: DEFAULT_MAZE_RENDER_STYLE.teleport.connectorGapWidth,
  teleportFloorBadge: { ...DEFAULT_MAZE_RENDER_STYLE.teleport.floorBadge },
  teleportGroupCustomization: false,
  teleportGroupOverrides: {},
};

/** Shared by `VectorByWallsSettings` and `projectExport/validate.ts`'s recovery defaults, same
 * extraction rationale as `DEFAULT_TELEPORT_SETTINGS`/`DEFAULT_ONE_WAY_SETTINGS` (GitHub issue
 * #347, three-section split GitHub issue #347 follow-up). Defaults match `GenerationRenderer`'s
 * canonical vertical style (circle for `VerticalPassage`, diamond for `Elevator`, border width 3,
 * size 0.22), the same "exported image looks identical to the editor view until changed"
 * rationale every other "Vector by walls" section's own defaults follow. `verticalStyle` defaults
 * to `"abstract"` (not `"decorative"`) — a plain opening marker is the one style that's also
 * correct for a physical single-sheet two-floor build, per the issue's own rationale;
 * `"decorative"` is an opt-in choice for a purely visual/print export. A two-way passage/elevator
 * marker draws solid (`filled: true`), so its own `fillColor` defaults to `canvas.vertical.default`
 * same as its border; a one-way passage marker draws the same ordinary fill/border at both ends
 * (GitHub issue #693 removed the earlier accent-tinted redesign in favor of a wall-tick indicator
 * on the direction arrow itself, see `VerticalConnectionRenderer`).
 * Every section's own `*ArrowColor` defaults to `canvas.floor.default` (GitHub issue #347 fifth
 * follow-up — `oneWayArrowColor` moved off `canvas.vertical.default` to match the other two
 * sections), so the arrow reads as a floor-colored cutout against the marker's own fill. */
const DECORATIVE_STAIRS_ONE_WAY_ARROW_DARK = DEFAULT_MAZE_RENDER_STYLE.verticalConnections.decorativeStairsOneWayArrowColor;

export const DEFAULT_VERTICAL_SETTINGS: VerticalSettingsFields = {
  replaceTwoFloorElevatorsWithStairs: true,
  twoWayPassageMarker: markerSettings(DEFAULT_MAZE_RENDER_STYLE.verticalConnections.twoWayPassageMarker),
  oneWayPassageMarker: markerSettings(DEFAULT_MAZE_RENDER_STYLE.verticalConnections.oneWayPassageMarker),
  elevatorMarker: markerSettings(DEFAULT_MAZE_RENDER_STYLE.verticalConnections.elevatorMarker),
  twoWayArrowColor: DEFAULT_MAZE_RENDER_STYLE.verticalConnections.twoWayArrowColor,
  twoWayArrowSize: DEFAULT_MAZE_RENDER_STYLE.verticalConnections.twoWayArrowSize,
  twoWayArrowStyle: DEFAULT_MAZE_RENDER_STYLE.verticalConnections.twoWayArrowStyle,
  twoWayArrowCornerStyle: DEFAULT_MAZE_RENDER_STYLE.verticalConnections.twoWayArrowCornerStyle,
  oneWayArrowColor: DEFAULT_MAZE_RENDER_STYLE.verticalConnections.oneWayArrowColor,
  oneWayArrowSize: DEFAULT_MAZE_RENDER_STYLE.verticalConnections.oneWayArrowSize,
  oneWayArrowStyle: DEFAULT_MAZE_RENDER_STYLE.verticalConnections.oneWayArrowStyle,
  oneWayArrowCornerStyle: DEFAULT_MAZE_RENDER_STYLE.verticalConnections.oneWayArrowCornerStyle,
  elevatorArrowColor: DEFAULT_MAZE_RENDER_STYLE.verticalConnections.elevatorArrowColor,
  elevatorArrowSize: DEFAULT_MAZE_RENDER_STYLE.verticalConnections.elevatorArrowSize,
  elevatorArrowStyle: DEFAULT_MAZE_RENDER_STYLE.verticalConnections.elevatorArrowStyle,
  elevatorArrowCornerStyle: DEFAULT_MAZE_RENDER_STYLE.verticalConnections.elevatorArrowCornerStyle,
  // "Floor-number badges" (GitHub issue #430) — enabled by default, Arabic numerals, a small
  // fraction of the elevator marker's own radius, laid out above/below the marker
  // (`placement: "top_bottom"`). `fillColor`/`textColor` are an independently visible fill+text
  // pair (not a knockout/cutout like `drawFloorBadge`'s off-floor navigation stand-in), with
  // `fillColor` a dedicated accent yellow rather than `canvas.vertical.default`, so a badge ring
  // reads clearly against the marker it surrounds.
  elevatorBadges: {
    enabled: true,
    labelType: "arabic",
    size: 0.7,
    placement: "top_bottom",
    distance: 4,
    gap: 2,
    gapWidth: 2,
    cornerStyle: "round",
    evenDistribution: false,
    shape: "circle",
    fillColor: 0xf0c900,
    textColor: canvas.floor.default,
    fontWeight: "bold",
  },
};

/** "Marker indices" defaults (GitHub issue #471) — shared by both vector modes and
 * `projectExport/validateImageExport.ts`'s recovery defaults, same single-const convention as
 * `DEFAULT_TELEPORT_SETTINGS` etc. Disabled by default (opt-in decorative layer). Roman numerals
 * by default (stay legible at small font sizes). `height`/`offset`/`cornerRadius`/`paddingX` are
 * all in px (GitHub issue #681 — previously TILE_SIZE fractions); `borderWidth` and `gap` are also
 * whole pixels. A plate ~0.35 * TILE_SIZE tall whose center sits on the marker's bottom edge,
 * lightly rounded corners, a 3px gap ring (follows "Shared style"'s `gapWidth` — not
 * pre-overridden), border color taken from the connection marker, a yellow accent plate with dark
 * text matching the elevator-badge palette. */
export const DEFAULT_MARKER_INDEX_SETTINGS: MarkerIndexSettings = {
  enabled: false,
  labelStyle: "roman",
  height: 0.35 * TILE_SIZE,
  offset: 0,
  cornerRadius: 0.03 * TILE_SIZE,
  paddingX: 0.04 * TILE_SIZE,
  gap: 3,
  fillColor: 0xf0c900,
  textColor: canvas.floor.default,
  borderColor: canvas.vertical.default,
  borderColorFromMarker: true,
  borderWidthFromMarker: true,
  borderWidth: 2,
  fontWeight: "bold",
  coverage: {
    singleFloorTeleport: false,
    crossFloorTeleport: true,
    verticalPassage: true,
    elevator: true,
  },
};

/** "Vector by walls"-only — see `VerticalDecorativeFields`'s own doc comment. `verticalStyle`
 * defaults to `"abstract"` (not `"decorative"`) — a plain opening marker is the one style that's
 * also correct for a physical single-sheet two-floor build, per the issue's own rationale;
 * `"decorative"` is an opt-in choice for a purely visual/print export. */
export const DEFAULT_VERTICAL_DECORATIVE_SETTINGS: VerticalDecorativeFields = {
  verticalStyle: "abstract",
  // `decorative*` fields (GitHub issue #428) — the "decorative" style's own line-only pictogram
  // settings, independent of the marker-shaped fields above. Same `canvas.vertical.default` line
  // color for the two stairs sections and the elevator, same "matches the editor's own default look
  // until changed" rationale as every other section's own defaults.
  // Line width 2 (GitHub issue #428 fifth follow-up, lowered from 3) — a thinner default reads
  // better for a stroke-only pictogram than the marker-shape sub-groups' own default border width.
  decorativeStairsTwoWay: { lineColor: canvas.vertical.default, lineWidth: 2, size: TILE_SIZE * 0.44 },
  decorativeStairsOneWay: { lineColor: canvas.vertical.default, lineWidth: 2, size: TILE_SIZE * 0.44 },
  decorativeElevator: { lineColor: canvas.vertical.default, lineWidth: 2, size: TILE_SIZE * 0.44 },
  // Two-way arrow defaults to the same color as the stairs line itself (GitHub issue #428 fourth
  // follow-up: "two-way arrow should default to the stairs' own color", not a separate gray) — the
  // one-way arrow still uses its own dedicated color (`decorativeStairsOneWayArrowColor`) below,
  // since that distinction is the whole point of the one-way from/to treatment.
  decorativeStairsArrowColor: canvas.vertical.default,
  decorativeStairsArrowSize: 0.75,
  decorativeStairsOneWayArrowColor: DECORATIVE_STAIRS_ONE_WAY_ARROW_DARK,
  decorativeStairsOneWayArrowSize: 0.75,
};

/** Shared with `projectExport/validate.ts`'s recovery defaults for old/malformed project files
 * (GitHub issue #295) — kept as a single exported const so the two never drift apart.
 * `startMarker`/`finishMarker`/`wallJoin`/`oneWayJoin`/every `teleportLine*`/`teleportEdge*`/
 * `teleportConnectorGapWidth` field driven by "Shared style" (GitHub issue #322, generalized by
 * #643) holds a placeholder value below, overwritten by the `propagate` call right after — see
 * `DEFAULT_VECTOR_BY_WALLS_LINKS`'s own doc comment for exactly which fields it touches. */
export const DEFAULT_VECTOR_BY_WALLS_SETTINGS: VectorByWallsSettings = propagate(
  {
    background: DEFAULT_MAZE_RENDER_STYLE.backgroundColor,
    showGrid: DEFAULT_MAZE_RENDER_STYLE.grid.visible,
    gridColor: DEFAULT_MAZE_RENDER_STYLE.grid.color,
    showInnerGrid: false,
    innerGridColor: 0x3a3a3a,
    floorColor: DEFAULT_MAZE_RENDER_STYLE.floorColor,
    wallColor: DEFAULT_MAZE_RENDER_STYLE.wall.color,
    randomWallColorMode: "off",
    wallJoin: DEFAULT_MAZE_RENDER_STYLE.wall.join,
    wallThickness: DEFAULT_MAZE_RENDER_STYLE.wall.width,
    oneWayPattern: DEFAULT_MAZE_RENDER_STYLE.oneWay.pattern,
    oneWayColor: DEFAULT_MAZE_RENDER_STYLE.oneWay.color,
    oneWayGapWidth: DEFAULT_MAZE_RENDER_STYLE.oneWay.gapWidth,
    oneWaySize: DEFAULT_MAZE_RENDER_STYLE.oneWay.size,
    oneWayThickness: DEFAULT_MAZE_RENDER_STYLE.oneWay.thickness,
    oneWayJoin: DEFAULT_MAZE_RENDER_STYLE.oneWay.join,
    startMarker: markerSettings(DEFAULT_MAZE_RENDER_STYLE.startMarker),
    finishMarker: markerSettings(DEFAULT_MAZE_RENDER_STYLE.finishMarker),
    ...DEFAULT_TELEPORT_SETTINGS,
    ...DEFAULT_VERTICAL_SETTINGS,
    ...DEFAULT_VERTICAL_DECORATIVE_SETTINGS,
    splitNodeColors: [...DEFAULT_MAZE_RENDER_STYLE.split.nodeColors],
    splitSpecialShapes: DEFAULT_MAZE_RENDER_STYLE.split.specialShapes,
    ...DEFAULT_SHARED_STYLE_SOURCE,
    ...DEFAULT_VERTICAL_SHARED_STYLE,
    verticalDecorativeLineColor: canvas.vertical.default,
    verticalDecorativeLineWidth: 2,
    verticalDecorativeSize: DEFAULT_VERTICAL_DECORATIVE_SETTINGS.decorativeStairsTwoWay.size,
    verticalDecorativeArrowSize: DEFAULT_VERTICAL_DECORATIVE_SETTINGS.decorativeStairsArrowSize,
    links: DEFAULT_VECTOR_BY_WALLS_LINKS,
    markerIndex: DEFAULT_MARKER_INDEX_SETTINGS,
  } as unknown as Record<string, unknown>,
  DEFAULT_VECTOR_BY_WALLS_LINKS,
  [
    "cornerStyle", "markerSize", "markerBorderWidth", "gapWidth",
    "verticalCornerStyle", "verticalShape", "verticalSize", "verticalBorderWidth", "verticalGapWidth", "verticalFillColor",
    "verticalArrowColor", "verticalArrowSize", "verticalArrowStyle", "verticalArrowCornerStyle",
    "verticalDecorativeLineColor", "verticalDecorativeLineWidth", "verticalDecorativeSize", "verticalDecorativeArrowSize",
  ],
) as unknown as VectorByWallsSettings;

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
 * `DEFAULT_VECTOR_BY_CORRIDORS_LINKS`). */
export const DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS: VectorByCorridorsSettings = propagate(
  {
    background: canvas.stage.background,
    showGrid: false,
    gridColor: canvas.grid.line,
    color: 0x2d2d2d,
    thickness: TILE_SIZE / 2,
    join: "round",
    renderStyle: "contour",
    startMarker: { shape: "circle", cornerStyle: "round", fillColor: canvas.node.start, borderColor: canvas.node.start, borderWidth: 0, gapWidth: 0, size: 0 },
    finishMarker: { shape: "circle", cornerStyle: "round", fillColor: canvas.node.finish, borderColor: canvas.node.finish, borderWidth: 0, gapWidth: 0, size: 0 },
    markerWidenPadding: 4,
    markerWidenShape: "match_marker",
    ...DEFAULT_ONE_WAY_SETTINGS,
    ...DEFAULT_TELEPORT_SETTINGS,
    ...DEFAULT_VERTICAL_SETTINGS,
    splitNodeColors: [],
    splitSpecialShapes: true,
    splitGapWidth: 0,
    splitDiagonalBowAmount: 0.5,
    ...DEFAULT_SHARED_STYLE_SOURCE,
    ...DEFAULT_VERTICAL_SHARED_STYLE,
    links: DEFAULT_VECTOR_BY_CORRIDORS_LINKS,
    markerIndex: DEFAULT_MARKER_INDEX_SETTINGS,
  } as unknown as Record<string, unknown>,
  DEFAULT_VECTOR_BY_CORRIDORS_LINKS,
  [
    "cornerStyle", "markerSize", "markerBorderWidth", "gapWidth",
    "verticalCornerStyle", "verticalShape", "verticalSize", "verticalBorderWidth", "verticalGapWidth", "verticalFillColor",
    "verticalArrowColor", "verticalArrowSize", "verticalArrowStyle", "verticalArrowCornerStyle",
  ],
) as unknown as VectorByCorridorsSettings;

/** Shared with `projectExport/validate.ts`'s recovery defaults, same convention as
 * `DEFAULT_VECTOR_BY_WALLS_SETTINGS`. */
export const DEFAULT_PNG_EXPORT_SETTINGS: PngExportSettings = {
  outputMode: "digital",
  digital: { scale: 1, canvasMode: "edge_to_edge", marginValue: 20, fixedWidth: 1920, fixedHeight: 1080 },
  print: { density: "print_300", paperSize: "a4", customWidthMm: 210, customHeightMm: 297, orientation: "landscape", marginHMm: 5, marginVMm: 5, scale: 1, scaleAutoFit: true, anchor: "center", offsetXMm: 0, offsetYMm: 0 },
};
