import {
  type MarkerSettings, type WaypointOpeningSettings, DirectionIndicatorGeometry, type WaypointOpeningMode, WAYPOINT_OPENING_MODES, type MarkerAppearance, type BadgeSettings, type DecorativeLineStyle, type ElevatorBadgeSettings, type ElevatorBadgeLabelType, type ElevatorBadgePlacement, type ElevatorBadgeBacking, type MarkerIndexSettings, type VectorByWallsSettings, type VectorByCorridorsSettings, type TeleportSettingsFields, type VerticalSettingsFields, type VerticalDecorativeFields, type MarkerWidenShape, type PngExportSettings, type CutExportSettings, type CutLineSetting, type CutLineStyleFields, type CreaseExportStyle, type GlueTabStyle, type EdgeMarkerStyle, type EdgeMarkerOverride,
  type PngExportOutputMode, type PngCanvasMode, type PrintDensity, type PaperSize, type PaperOrientation, type PrintAnchor,
  type DigitalExportSettings, type PrintExportSettings, type FloorLabelSettings, type FloorLabelAnchor, type TextHorizontalAlignment, FLOOR_LABEL_ANCHORS,
} from "../storeTypes";
import type { MarkerShape, CornerStyle, TeleportGroupOverride } from "../../pixi/renderers/types";
import { CSS_FONT_WEIGHTS, DEFAULT_LABEL_FONT, type LabelFont } from "../../pixi/renderers/fontChoice";
import { TELEPORT_GROUP_ROLES } from "../teleportGroupLinks";
import { sanitizeMarkerGlyph } from "../../pixi/renderers/markerGlyph";
import { DEFAULT_MARKER_TEXT_SIZE, DEFAULT_TEXT_MARGIN, TEXT_SIZE_RANGE, TEXT_MARGIN_RANGE, CREASE_LINE_WIDTH_RANGE, CREASE_MARK_SIZE_RANGE, CREASE_MARK_TIP_LENGTH_RANGE, GLUE_TAB_INSET_RANGE, GLUE_TAB_LINE_WIDTH_RANGE, GLUE_TAB_WIDTH_RANGE, EDGE_MARKER_SIZE_RANGE, MARKER_INDEX_MIN_HEIGHT, MARKER_INDEX_WIDTH_RANGE, FLOOR_LABEL_TEXT_SIZE_RANGE, FLOOR_LABEL_WIDTH_RANGE } from "../../pixi/renderConstants";
import type { RenderModeId, LinkIconVisibility } from "../mazeStore";
import type { ProjectFileImageExport } from "./types";
import { DEFAULT_VECTOR_BY_WALLS_SETTINGS, DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS, DEFAULT_PNG_EXPORT_SETTINGS } from "../slices/imageExportSlice";
import { DEFAULT_VECTOR_BY_WALLS_LINKS, DEFAULT_VECTOR_BY_CORRIDORS_LINKS } from "../slices/parameterLinksDefaults";
import type { ParamLink, ParamModifier, ColorModifier, ColorModel, ColorChannel, ParamDescriptor } from "../parameterLinks";
import { validateLinkGraph, linksMatchDefaults } from "../slices/parameterLinksEngine";
import { VECTOR_BY_WALLS_PARAM_REGISTRY, VECTOR_BY_CORRIDORS_PARAM_REGISTRY, type VectorByWallsParamPath, type VectorByCorridorsParamPath } from "../parameterLinksRegistry";
import { MARKER_LAYOUT_MODES, type MarkerLayoutMode } from "../../pixi/selectors/mazeSelectors/markerLayout";
import { assertObject, assertArray, assertBoolRecord, optBool, optNumber, optEnum } from "./validatePrimitives";

// ─── Image Export (GitHub issue #295) ────────────────────────────────────────

export const MARKER_SHAPES = ["circle", "triangle", "square", "diamond", "pentagon", "star", "hexagon", "cross"] as const;
export function optMarkerShape(obj: Record<string, unknown> | null, key: string, fallback: MarkerSettings["shape"]): MarkerSettings["shape"] {
  const v = obj?.[key];
  return typeof v === "string" && (MARKER_SHAPES as readonly string[]).includes(v) ? (v as MarkerSettings["shape"]) : fallback;
}

export function optMarkerWidenShape(obj: Record<string, unknown> | null, key: string, fallback: MarkerWidenShape): MarkerWidenShape {
  const v = obj?.[key];
  return v === "circle" || v === "square" || v === "match_marker" ? v : fallback;
}

export function optMarkerLayout(obj: Record<string, unknown> | null, key: string, fallback: MarkerLayoutMode): MarkerLayoutMode {
  const v = obj?.[key];
  return typeof v === "string" && (MARKER_LAYOUT_MODES as readonly string[]).includes(v) ? (v as MarkerLayoutMode) : fallback;
}

export function optCornerStyle(obj: Record<string, unknown> | null, key: string, fallback: CornerStyle): CornerStyle {
  const v = obj?.[key];
  return v === "round" || v === "miter" ? v : fallback;
}

/** GitHub issue #510 — recovery for `VectorByCorridorsSettings.renderStyle`. An old project file
 *  predating this field (or carrying only the removed `roundJunctions` boolean) recovers to the
 *  default `"contour"`. */
export function optRenderStyle(obj: Record<string, unknown> | null, key: string, fallback: "contour" | "legacy_line"): "contour" | "legacy_line" {
  const v = obj?.[key];
  return v === "contour" || v === "legacy_line" ? v : fallback;
}

export function optOneWayPattern(obj: Record<string, unknown> | null, key: string, fallback: "triangle" | "chevron" | "arrow"): "triangle" | "chevron" | "arrow" {
  const v = obj?.[key];
  return v === "triangle" || v === "chevron" || v === "arrow" ? v : fallback;
}

export function optVerticalArrowStyle(obj: Record<string, unknown> | null, key: string, fallback: "triangle" | "chevron" | "arrow" | "sign"): "triangle" | "chevron" | "arrow" | "sign" {
  const v = obj?.[key];
  return v === "triangle" || v === "chevron" || v === "arrow" || v === "sign" ? v : fallback;
}

export function optTeleportConnectorStyle(obj: Record<string, unknown> | null, key: string, fallback: "none" | "straight" | "orthogonal" | "curved"): "none" | "straight" | "orthogonal" | "curved" {
  const v = obj?.[key];
  return v === "none" || v === "straight" || v === "orthogonal" || v === "curved" ? v : fallback;
}

function optTeleportCurveDirection(obj: Record<string, unknown> | null, key: string, fallback: "inward" | "outward"): "inward" | "outward" {
  const v = obj?.[key];
  return v === "inward" || v === "outward" ? v : fallback;
}

export function optTeleportArrowMode(obj: Record<string, unknown> | null, key: string, fallback: "none" | "center" | "double" | "periodic"): "none" | "center" | "double" | "periodic" {
  const v = obj?.[key];
  return v === "none" || v === "center" || v === "double" || v === "periodic" ? v : fallback;
}

/** The shared `MarkerAppearance` fields (GitHub issue #701), read leniently off an already-asserted
 *  object — reused by every marker-like validator (start/finish markers, teleport edge marker,
 *  elevator and teleport floor badges). */
function readMarkerAppearance(obj: Record<string, unknown> | null, fallback: MarkerAppearance): MarkerAppearance {
  return {
    shape: optMarkerShape(obj, "shape", fallback.shape),
    cornerStyle: optCornerStyle(obj, "cornerStyle", fallback.cornerStyle),
    fillColor: optNumber(obj, "fillColor", fallback.fillColor),
    borderColor: optNumber(obj, "borderColor", fallback.borderColor),
    borderWidth: optNumber(obj, "borderWidth", fallback.borderWidth),
    gapWidth: optNumber(obj, "gapWidth", fallback.gapWidth),
    size: optNumber(obj, "size", fallback.size),
  };
}

/** A marker size adaptation fraction (GitHub issue #819) — clamped into [0, 1]. */
function optSizeAdaptation(obj: Record<string, unknown> | null, key: string, fallback: number): number {
  return Math.min(1, Math.max(0, optNumber(obj, key, fallback)));
}

function clampTextMargin(value: number): number {
  return Math.min(TEXT_MARGIN_RANGE.max, Math.max(TEXT_MARGIN_RANGE.min, value));
}

/** Canvas labels are rasterized; integer CSS pixels avoid soft sampling at common DPR/zoom pairs. */
function clampTextSize(value: number, range = TEXT_SIZE_RANGE): number {
  return Math.min(range.max, Math.max(range.min, Math.round(value)));
}

function readTextMargin(obj: Record<string, unknown> | null, fallback: number): number {
  return clampTextMargin(optNumber(obj, "textMargin", fallback));
}

function readTextAlignment(obj: Record<string, unknown> | null, fallback: TextHorizontalAlignment = "center"): TextHorizontalAlignment {
  return optEnum(obj, "textAlignment", ["left", "center", "right"] as const, fallback);
}

/** `BadgeSettings` fields (GitHub issue #701): the shared marker look plus label type and the
 *  required text style — shared by the elevator and teleport floor badge validators. */
function readBadgeSettings(obj: Record<string, unknown> | null, fallback: BadgeSettings): BadgeSettings {
  return {
    ...readMarkerAppearance(obj, fallback),
    labelType: optElevatorBadgeLabelType(obj, "labelType", fallback.labelType),
    textColor: optNumber(obj, "textColor", fallback.textColor),
    textFont: optLabelFont(obj, "textFont", fallback.textFont),
    textSize: clampTextSize(optNumber(obj, "textSize", fallback.textSize)),
    textMargin: readTextMargin(obj, fallback.textMargin),
  };
}

export function validateMarkerSettings(v: unknown, path: string, fallback: MarkerSettings): MarkerSettings {
  if (v == null) return fallback;
  let obj: Record<string, unknown> | null;
  try {
    obj = assertObject(v, path);
  } catch {
    return fallback;
  }
  return {
    ...readMarkerAppearance(obj, fallback),
    sizeAdaptation: optSizeAdaptation(obj, "sizeAdaptation", fallback.sizeAdaptation),
    // No fallback here: a file without the field predates the toggle, so its marker stays drawn (`undefined`).
    markerEnabled: obj?.markerEnabled === undefined ? undefined : optBool(obj, "markerEnabled", true),
    text: typeof obj?.text === "string" ? sanitizeMarkerGlyph(obj.text) : fallback.text,
    textEnabled: obj?.textEnabled === undefined ? fallback.textEnabled : optBool(obj, "textEnabled", fallback.textEnabled ?? true),
    textFont: obj?.textFont === undefined ? fallback.textFont : optLabelFont(obj, "textFont", fallback.textFont ?? DEFAULT_LABEL_FONT),
    textSize: obj?.textSize === undefined ? fallback.textSize : clampTextSize(optNumber(obj, "textSize", fallback.textSize ?? DEFAULT_MARKER_TEXT_SIZE)),
    textMargin: obj?.textMargin === undefined ? fallback.textMargin : readTextMargin(obj, fallback.textMargin ?? DEFAULT_TEXT_MARGIN),
    textColor: obj?.textColor === undefined ? fallback.textColor : optNumber(obj, "textColor", fallback.textColor ?? fallback.fillColor),
  };
}

/** A start/finish external passage (GitHub issue #330), read leniently: absent fields keep the default, an
 *  unusable `face` (not a non-negative integer) is dropped so the cell's first outer face is used. */
export function validateWaypointOpening(v: unknown, path: string, fallback: WaypointOpeningSettings): WaypointOpeningSettings {
  if (v == null) return fallback;
  let obj: Record<string, unknown> | null;
  try {
    obj = assertObject(v, path);
  } catch {
    return fallback;
  }
  const face = obj?.face;
  const mode = obj?.mode;
  return {
    // A file saved while the passage was a plain on/off toggle: on meant the wall cut plus the pointer.
    mode: WAYPOINT_OPENING_MODES.includes(mode as WaypointOpeningMode) ? (mode as WaypointOpeningMode)
      : typeof obj?.enabled === "boolean" ? (obj.enabled ? "both" : "none") : fallback.mode,
    ...(typeof face === "number" && Number.isInteger(face) && face >= 0 ? { face } : {}),
    pattern: optOneWayPattern(obj, "pattern", fallback.pattern),
    color: optNumber(obj, "color", fallback.color),
    geometry: validateIndicatorGeometry(obj?.geometry, fallback.geometry),
    gapWidth: optNumber(obj, "gapWidth", fallback.gapWidth),
    join: optCornerStyle(obj, "join", fallback.join),
  };
}

/** The per-pattern indicator parameters (GitHub issue #993), read leniently: a missing record or a
 *  non-numeric parameter keeps its default, so no pattern's set can be lost to another's. */
export function validateIndicatorGeometry(v: unknown, fallback: DirectionIndicatorGeometry): DirectionIndicatorGeometry {
  const read = (key: keyof DirectionIndicatorGeometry): Record<string, unknown> | null =>
    typeof v === "object" && v !== null && typeof (v as Record<string, unknown>)[key] === "object"
      ? ((v as Record<string, unknown>)[key] as Record<string, unknown> | null)
      : null;
  const triangle = read("triangle");
  const chevron = read("chevron");
  const arrow = read("arrow");
  return {
    triangle: { size: optNumber(triangle, "size", fallback.triangle.size) },
    chevron: { size: optNumber(chevron, "size", fallback.chevron.size), thickness: optNumber(chevron, "thickness", fallback.chevron.thickness) },
    arrow: {
      length: optNumber(arrow, "length", fallback.arrow.length),
      headWidth: optNumber(arrow, "headWidth", fallback.arrow.headWidth),
      thickness: optNumber(arrow, "thickness", fallback.arrow.thickness),
    },
  };
}

/** Format-only validation of one group's override — an unresolvable `shape` just falls back to
 * the base style at render time (same "never throw" convention as `resolveRenderMode`), so a
 * malformed entry is dropped rather than failing the whole file. */
export function tryValidateTeleportGroupOverride(v: unknown): TeleportGroupOverride | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const obj = v as Record<string, unknown>;
  const result: TeleportGroupOverride = {};
  if (typeof obj.fillColor === "number") result.fillColor = obj.fillColor;
  if (typeof obj.borderColor === "number") result.borderColor = obj.borderColor;
  if (typeof obj.shape === "string" && (MARKER_SHAPES as readonly string[]).includes(obj.shape)) result.shape = obj.shape as MarkerShape;
  if (typeof obj.linkBroken === "object" && obj.linkBroken !== null && !Array.isArray(obj.linkBroken)) {
    const raw = obj.linkBroken as Record<string, unknown>;
    const broken: NonNullable<TeleportGroupOverride["linkBroken"]> = {};
    for (const role of TELEPORT_GROUP_ROLES) if (raw[role] === true) broken[role] = true;
    if (Object.keys(broken).length > 0) result.linkBroken = broken;
  }
  return result;
}

/** Recovery for #301's free-form connector paths. Coordinates are deliberately not clamped:
 * authored display-space points may sit outside the field to create a readable detour. */
function validateManualTeleportConnectorPaths(v: unknown): NonNullable<TeleportSettingsFields["manualTeleportConnectorPaths"]> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return {};
  const result: NonNullable<TeleportSettingsFields["manualTeleportConnectorPaths"]> = {};
  for (const [key, raw] of Object.entries(v as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
    // `points` is the pre-controls #301 format and migrates to nodes on load.
    const nodes = (raw as Record<string, unknown>).nodes ?? (raw as Record<string, unknown>).points;
    if (!Array.isArray(nodes) || nodes.length < 2) continue;
    const parsed: [number, number][] = [];
    for (const point of nodes) {
      if (!Array.isArray(point) || point.length !== 2 || typeof point[0] !== "number" || typeof point[1] !== "number" || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) { parsed.length = 0; break; }
      parsed.push([point[0], point[1]]);
    }
    const rawControls = (raw as Record<string, unknown>).controls;
    const controls: [number, number][] = [];
    if (Array.isArray(rawControls)) for (const point of rawControls) {
      if (!Array.isArray(point) || point.length !== 2 || typeof point[0] !== "number" || typeof point[1] !== "number" || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) { controls.length = 0; break; }
      controls.push([point[0], point[1]]);
    }
    if (parsed.length >= 2) result[key] = {
      nodes: parsed,
      ...(controls.length === (parsed.length - 1) * 2 ? { controls } : {}),
      mode: (raw as Record<string, unknown>).mode === "curve" ? "curve" : "polyline",
    };
  }
  return result;
}

/** Shared by `validateVectorByWallsSettings`/`validateVectorByCorridorsSettings` (GitHub issue
 * #313) — `TeleportSettingsFields` is `extends`-ed identically by both settings interfaces, so the
 * two never need their own separate recovery logic for it. */
export function validateTeleportSettingsFields(obj: Record<string, unknown> | null, path: string, d: TeleportSettingsFields): TeleportSettingsFields {
  return {
    manualTeleportConnectorPaths: validateManualTeleportConnectorPaths(obj?.manualTeleportConnectorPaths),
    teleportMarker: validateMarkerSettings(obj?.teleportMarker, `${path}.teleportMarker`, d.teleportMarker),
    teleportConnectorColor: optNumber(obj, "teleportConnectorColor", d.teleportConnectorColor),
    teleportConnectorWidth: optNumber(obj, "teleportConnectorWidth", d.teleportConnectorWidth),
    teleportConnectorCornerStyle: optCornerStyle(
      obj,
      "teleportConnectorCornerStyle",
      optCornerStyle(obj, "cornerStyle", d.teleportConnectorCornerStyle ?? d.teleportMarker.cornerStyle),
    ),
    teleportConnectorStyle: optTeleportConnectorStyle(obj, "teleportConnectorStyle", d.teleportConnectorStyle),
    teleportCurveDirection: optTeleportCurveDirection(obj, "teleportCurveDirection", d.teleportCurveDirection ?? "inward"),
    teleportCurveStrength: Math.min(1, Math.max(0, optNumber(obj, "teleportCurveStrength", d.teleportCurveStrength ?? 0.25))),
    teleportAvoidFieldExit: optBool(obj, "teleportAvoidFieldExit", d.teleportAvoidFieldExit),
    teleportThroughSeams: optBool(obj, "teleportThroughSeams", d.teleportThroughSeams ?? true),
    teleportArrowMode: optTeleportArrowMode(obj, "teleportArrowMode", d.teleportArrowMode),
    teleportArrowPeriod: optNumber(obj, "teleportArrowPeriod", d.teleportArrowPeriod),
    teleportArrowSize: optNumber(obj, "teleportArrowSize", d.teleportArrowSize),
    teleportConnectorGapWidth: optNumber(obj, "teleportConnectorGapWidth", d.teleportConnectorGapWidth),
    teleportFloorBadge: validateTeleportFloorBadgeSettings(obj?.teleportFloorBadge, `${path}.teleportFloorBadge`, d.teleportFloorBadge),
    teleportMergeMode: optBool(obj, "teleportMergeMode", d.teleportMergeMode),
    teleportGroupCustomization: optBool(obj, "teleportGroupCustomization", d.teleportGroupCustomization),
    teleportGroupOverrides: validateTeleportGroupOverrides(obj?.teleportGroupOverrides, `${path}.teleportGroupOverrides`),
  };
}

/** `TeleportFloorBadgeSettings` validation (GitHub issue #485) — same lenient-recovery convention
 * as `validateElevatorBadgeSettings`. `labelType` reuses the elevator-badge label-type validator
 * (both are `IndexLabelStyle`). */
export function validateTeleportFloorBadgeSettings(v: unknown, path: string, fallback: TeleportSettingsFields["teleportFloorBadge"]): TeleportSettingsFields["teleportFloorBadge"] {
  if (v == null) return fallback;
  let obj: Record<string, unknown> | null;
  try {
    obj = assertObject(v, path);
  } catch {
    return fallback;
  }
  return { ...readBadgeSettings(obj, fallback), sizeAdaptation: optSizeAdaptation(obj, "sizeAdaptation", fallback.sizeAdaptation) };
}

/** `DecorativeLineStyle` validation (GitHub issue #428) — same lenient-recovery convention as
 * `validateMarkerSettings`. */
export function validateDecorativeLineStyle(v: unknown, path: string, fallback: DecorativeLineStyle): DecorativeLineStyle {
  if (v == null) return fallback;
  let obj: Record<string, unknown> | null;
  try {
    obj = assertObject(v, path);
  } catch {
    return fallback;
  }
  return {
    lineColor: optNumber(obj, "lineColor", fallback.lineColor),
    lineWidth: optNumber(obj, "lineWidth", fallback.lineWidth),
    size: optNumber(obj, "size", fallback.size),
    sizeAdaptation: optSizeAdaptation(obj, "sizeAdaptation", fallback.sizeAdaptation),
  };
}

export function optElevatorBadgeLabelType(obj: Record<string, unknown> | null, key: string, fallback: ElevatorBadgeLabelType): ElevatorBadgeLabelType {
  const v = obj?.[key];
  return v === "arabic" || v === "roman" || v === "letters" ? v : fallback;
}

export function optElevatorBadgePlacement(obj: Record<string, unknown> | null, key: string, fallback: ElevatorBadgePlacement): ElevatorBadgePlacement {
  const v = obj?.[key];
  return v === "left_right" || v === "right_left" || v === "top_bottom" || v === "bottom_top" || v === "full_circle" ? v : fallback;
}

export function optElevatorBadgeBacking(obj: Record<string, unknown> | null, key: string, fallback: ElevatorBadgeBacking): ElevatorBadgeBacking {
  const v = obj?.[key];
  return v === "individual" || v === "shared" ? v : fallback;
}

/** A saved `LabelFont` (GitHub issue #973): a family string and a weight on the CSS 100..900 scale. A
 *  missing or malformed part falls back to `fallback`'s; a value that is not an object (such as the
 *  pre-#973 family string) is ignored as a whole. */
export function optLabelFont(obj: Record<string, unknown> | null, key: string, fallback: LabelFont): LabelFont {
  const v = obj?.[key];
  if (v === null || typeof v !== "object" || Array.isArray(v)) return fallback;
  const saved = v as Record<string, unknown>;
  const weight = typeof saved.weight === "number" && Number.isFinite(saved.weight)
    ? Math.min(CSS_FONT_WEIGHTS[CSS_FONT_WEIGHTS.length - 1], Math.max(CSS_FONT_WEIGHTS[0], Math.round(saved.weight)))
    : fallback.weight;
  const family = typeof saved.family === "string" ? saved.family.trim() : fallback.family;
  return saved.msdf === false ? { family, weight, msdf: false } : { family, weight };
}

/** `ElevatorBadgeSettings` validation (GitHub issue #430) — same lenient-recovery convention as
 * `validateMarkerSettings`/`validateDecorativeLineStyle`. */
export function validateElevatorBadgeSettings(v: unknown, path: string, fallback: ElevatorBadgeSettings): ElevatorBadgeSettings {
  if (v == null) return fallback;
  let obj: Record<string, unknown> | null;
  try {
    obj = assertObject(v, path);
  } catch {
    return fallback;
  }
  return {
    ...readBadgeSettings(obj, fallback),
    enabled: optBool(obj, "enabled", fallback.enabled),
    placement: optElevatorBadgePlacement(obj, "placement", fallback.placement),
    distance: Math.max(0, optNumber(obj, "distance", fallback.distance)),
    gap: optNumber(obj, "gap", fallback.gap),
    evenDistribution: optBool(obj, "evenDistribution", fallback.evenDistribution),
    backing: optElevatorBadgeBacking(obj, "backing", fallback.backing ?? "individual"),
    startAngle: Math.max(0, Math.min(359, optNumber(obj, "startAngle", fallback.startAngle ?? 0))),
  };
}

/** `MarkerIndexSettings` validation (GitHub issue #471) — same lenient-recovery convention as
 * `validateElevatorBadgeSettings`. `labelStyle` reuses the elevator-badge validator (its type is an
 * alias); `textFont` goes through `optLabelFont`. */
export function validateMarkerIndexSettings(v: unknown, path: string, fallback: MarkerIndexSettings): MarkerIndexSettings {
  if (v == null) return fallback;
  let obj: Record<string, unknown> | null;
  try {
    obj = assertObject(v, path);
  } catch {
    return fallback;
  }
  return {
    enabled: optBool(obj, "enabled", fallback.enabled),
    labelStyle: optElevatorBadgeLabelType(obj, "labelStyle", fallback.labelStyle),
    height: Math.max(MARKER_INDEX_MIN_HEIGHT, optNumber(obj, "height", fallback.height)),
    offset: optNumber(obj, "offset", fallback.offset),
    cornerRadius: optNumber(obj, "cornerRadius", fallback.cornerRadius),
    width: Math.min(MARKER_INDEX_WIDTH_RANGE.max, Math.max(MARKER_INDEX_WIDTH_RANGE.min, optNumber(obj, "width", fallback.width))),
    textSize: clampTextSize(optNumber(obj, "textSize", fallback.textSize)),
    textMargin: readTextMargin(obj, fallback.textMargin),
    gap: optNumber(obj, "gap", fallback.gap),
    fillColor: optNumber(obj, "fillColor", fallback.fillColor),
    textColor: optNumber(obj, "textColor", fallback.textColor),
    textFont: optLabelFont(obj, "textFont", fallback.textFont),
    borderColor: optNumber(obj, "borderColor", fallback.borderColor),
    borderColorFromMarker: optBool(obj, "borderColorFromMarker", fallback.borderColorFromMarker),
    borderWidthFromMarker: optBool(obj, "borderWidthFromMarker", fallback.borderWidthFromMarker),
    borderWidth: optNumber(obj, "borderWidth", fallback.borderWidth),
    coverage: validateMarkerIndexCoverage(obj.coverage, `${path}.coverage`, fallback.coverage),
  };
}

export function validateFloorLabelSettings(v: unknown, path: string, fallback: FloorLabelSettings): FloorLabelSettings {
  if (v == null) return fallback;
  let obj: Record<string, unknown> | null;
  try { obj = assertObject(v, path); } catch { return fallback; }
  return {
    enabled: optBool(obj, "enabled", fallback.enabled),
    // Floor labels predate label modes (GitHub issue #747): keep index-based output for saved
    // settings without a mode.
    labelMode: obj.labelMode === undefined
      ? "index"
      : optEnum(obj, "labelMode", ["index", "title"] as const, fallback.labelMode),
    prefix: typeof obj.prefix === "string" ? obj.prefix : fallback.prefix,
    labelType: optElevatorBadgeLabelType(obj, "labelType", fallback.labelType),
    textFont: optLabelFont(obj, "textFont", fallback.textFont),
    textAlignment: readTextAlignment(obj, fallback.textAlignment),
    textSize: clampTextSize(optNumber(obj, "textSize", fallback.textSize), FLOOR_LABEL_TEXT_SIZE_RANGE),
    textMargin: readTextMargin(obj, fallback.textMargin),
    textColor: optNumber(obj, "textColor", fallback.textColor),
    backgroundShape: optEnum(obj, "backgroundShape", ["none", "rectangle", "parallelogram"] as const, fallback.backgroundShape),
    width: Math.min(FLOOR_LABEL_WIDTH_RANGE.max, Math.max(FLOOR_LABEL_WIDTH_RANGE.min, optNumber(obj, "width", fallback.width))),
    height: optNumber(obj, "height", fallback.height),
    cornerRadius: optNumber(obj, "cornerRadius", fallback.cornerRadius),
    gap: optNumber(obj, "gap", fallback.gap),
    borderWidth: optNumber(obj, "borderWidth", fallback.borderWidth),
    fillColor: optNumber(obj, "fillColor", fallback.fillColor),
    borderColor: optNumber(obj, "borderColor", fallback.borderColor),
    positionsByFloorId: validateFloorLabelPositions(obj.positionsByFloorId, fallback.positionsByFloorId),
  };
}

function validateFloorLabelPositions(v: unknown, fallback: FloorLabelSettings["positionsByFloorId"]): FloorLabelSettings["positionsByFloorId"] {
  if (v == null) return fallback;
  if (typeof v !== "object" || Array.isArray(v)) return fallback;
  const result: FloorLabelSettings["positionsByFloorId"] = {};
  const anchors = new Set<FloorLabelAnchor>(FLOOR_LABEL_ANCHORS);
  for (const [floorId, raw] of Object.entries(v)) {
    if (raw == null || typeof raw !== "object" || Array.isArray(raw)) continue;
    const value = raw as Record<string, unknown>;
    if (value.mode === "anchored" && typeof value.anchor === "string" && anchors.has(value.anchor as FloorLabelAnchor)) {
      result[floorId] = { mode: "anchored", anchor: value.anchor as FloorLabelAnchor };
    } else if (value.mode === "cell" && Array.isArray(value.cell) && value.cell.length === 2
      && value.cell.every((n) => typeof n === "number" && Number.isInteger(n))) {
      result[floorId] = { mode: "cell", cell: [value.cell[0] as number, value.cell[1] as number] };
    } else if (value.mode === "free" && typeof value.x === "number" && Number.isFinite(value.x)
      && typeof value.y === "number" && Number.isFinite(value.y)) {
      result[floorId] = { mode: "free", x: value.x, y: value.y };
    }
  }
  return result;
}

function validateMarkerIndexCoverage(v: unknown, path: string, fallback: MarkerIndexSettings["coverage"]): MarkerIndexSettings["coverage"] {
  if (v == null) return fallback;
  let obj: Record<string, unknown> | null;
  try {
    obj = assertObject(v, path);
  } catch {
    return fallback;
  }
  return {
    singleFloorTeleport: optBool(obj, "singleFloorTeleport", fallback.singleFloorTeleport),
    crossFloorTeleport: optBool(obj, "crossFloorTeleport", fallback.crossFloorTeleport),
    verticalPassage: optBool(obj, "verticalPassage", fallback.verticalPassage),
    elevator: optBool(obj, "elevator", fallback.elevator),
  };
}

/** "Vertical connections" fields shared by both vector modes (GitHub issue #347, three-style
 * follow-up, three-section split follow-up; GitHub issue #348 "Vector by corridors" parity) — same
 * lenient-recovery convention as `validateTeleportSettingsFields`. `twoWayPassageMarker`/
 * `oneWayPassageMarker` (split from one shared `verticalPassageMarker`, GitHub issue #347
 * three-section follow-up) both fall back to the legacy single field when their own current field is
 * absent, so a pre-split project file's one style seeds both new sections identically on first load
 * (matching how it actually rendered before the split — same marker for every `VerticalPassage`,
 * one-way or not). */
export function validateVerticalSettingsFields(obj: Record<string, unknown> | null, path: string, d: VerticalSettingsFields): VerticalSettingsFields {
  const legacyMarker = obj?.["verticalPassageMarker"];
  return {
    replaceTwoFloorElevatorsWithStairs: optBool(obj, "replaceTwoFloorElevatorsWithStairs", d.replaceTwoFloorElevatorsWithStairs),
    twoWayPassageMarker: validateMarkerSettings(obj?.twoWayPassageMarker ?? legacyMarker, `${path}.twoWayPassageMarker`, d.twoWayPassageMarker),
    oneWayPassageMarker: validateMarkerSettings(obj?.oneWayPassageMarker ?? legacyMarker, `${path}.oneWayPassageMarker`, d.oneWayPassageMarker),
    elevatorMarker: validateMarkerSettings(obj?.elevatorMarker, `${path}.elevatorMarker`, d.elevatorMarker),
    twoWayArrowColor: optNumber(obj, "twoWayArrowColor", d.twoWayArrowColor),
    twoWayArrowSize: optNumber(obj, "twoWayArrowSize", d.twoWayArrowSize),
    twoWayArrowStyle: optVerticalArrowStyle(obj, "twoWayArrowStyle", d.twoWayArrowStyle),
    twoWayArrowCornerStyle: optCornerStyle(obj, "twoWayArrowCornerStyle", d.twoWayArrowCornerStyle),
    oneWayArrowColor: optNumber(obj, "oneWayArrowColor", d.oneWayArrowColor),
    oneWayArrowSize: optNumber(obj, "oneWayArrowSize", d.oneWayArrowSize),
    oneWayArrowStyle: optVerticalArrowStyle(obj, "oneWayArrowStyle", d.oneWayArrowStyle),
    oneWayArrowCornerStyle: optCornerStyle(obj, "oneWayArrowCornerStyle", d.oneWayArrowCornerStyle),
    elevatorArrowColor: optNumber(obj, "elevatorArrowColor", d.elevatorArrowColor),
    elevatorArrowSize: optNumber(obj, "elevatorArrowSize", d.elevatorArrowSize),
    elevatorArrowStyle: optVerticalArrowStyle(obj, "elevatorArrowStyle", d.elevatorArrowStyle),
    elevatorArrowCornerStyle: optCornerStyle(obj, "elevatorArrowCornerStyle", d.elevatorArrowCornerStyle),
    elevatorBadges: validateElevatorBadgeSettings(obj?.elevatorBadges, `${path}.elevatorBadges`, d.elevatorBadges),
  };
}

/** `VectorByWallsSettings`' own extra "Vertical connections" fields (GitHub issue #428) — the
 * "decorative" pictogram treatment, "Vector by walls"-only (GitHub issue #348: "Vector by
 * corridors" has no decorative treatment). `verticalStyle` reads the current field name first; a
 * project file saved before the three-style follow-up (`verticalPassageDisplayStyle: "marker" |
 * "decorative"`) still loads correctly via the fallback, with `"marker"` mapped onto its renamed
 * equivalent, `"abstract"`. */
export function validateVerticalDecorativeFields(obj: Record<string, unknown> | null, path: string, d: VerticalDecorativeFields): VerticalDecorativeFields {
  const style = obj?.["verticalStyle"];
  const legacyStyle = obj?.["verticalPassageDisplayStyle"];
  return {
    verticalStyle:
      style === "abstract" || style === "decorative"
        ? style
        : legacyStyle === "marker"
          ? "abstract"
          : legacyStyle === "decorative"
            ? "decorative"
            : d.verticalStyle,
    decorativeStairsTwoWay: validateDecorativeLineStyle(obj?.decorativeStairsTwoWay, `${path}.decorativeStairsTwoWay`, d.decorativeStairsTwoWay),
    decorativeStairsOneWay: validateDecorativeLineStyle(obj?.decorativeStairsOneWay, `${path}.decorativeStairsOneWay`, d.decorativeStairsOneWay),
    decorativeElevator: validateDecorativeLineStyle(obj?.decorativeElevator, `${path}.decorativeElevator`, d.decorativeElevator),
    decorativeStairsArrowColor: optNumber(obj, "decorativeStairsArrowColor", d.decorativeStairsArrowColor),
    decorativeStairsArrowSize: optNumber(obj, "decorativeStairsArrowSize", d.decorativeStairsArrowSize),
    decorativeStairsOneWayArrowColor: optNumber(obj, "decorativeStairsOneWayArrowColor", d.decorativeStairsOneWayArrowColor),
    decorativeStairsOneWayArrowSize: optNumber(obj, "decorativeStairsOneWayArrowSize", d.decorativeStairsOneWayArrowSize),
  };
}

export function validateTeleportGroupOverrides(v: unknown, path: string): Record<string, TeleportGroupOverride> {
  if (v == null) return {};
  let obj: Record<string, unknown>;
  try {
    obj = assertObject(v, path);
  } catch {
    return {};
  }
  const result: Record<string, TeleportGroupOverride> = {};
  for (const [key, raw] of Object.entries(obj)) {
    const override = tryValidateTeleportGroupOverride(raw);
    if (override) result[key] = override;
  }
  return result;
}

function tryValidateParamModifier(v: unknown): ParamModifier | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const obj = v as Record<string, unknown>;
  if (obj.op !== "add" && obj.op !== "sub" && obj.op !== "mul" && obj.op !== "div") return null;
  if (typeof obj.value !== "number") return null;
  return { op: obj.op, value: obj.value };
}

const COLOR_MODELS: ColorModel[] = ["rgb", "hsl", "oklch"];
const COLOR_CHANNELS: ColorChannel[] = ["r", "g", "b", "hsl-h", "s", "l", "oklch-h", "c", "oklch-l"];

function tryValidateColorModifier(v: unknown): ColorModifier | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const obj = v as Record<string, unknown>;
  if (obj.op !== "add" && obj.op !== "sub" && obj.op !== "mul" && obj.op !== "div") return null;
  if (typeof obj.value !== "number") return null;
  if (typeof obj.model !== "string" || !COLOR_MODELS.includes(obj.model as ColorModel)) return null;
  if (typeof obj.channel !== "string" || !COLOR_CHANNELS.includes(obj.channel as ColorChannel)) return null;
  return { model: obj.model as ColorModel, channel: obj.channel as ColorChannel, op: obj.op, value: obj.value };
}

function tryValidateParamLink<P extends string>(v: unknown): ParamLink<P> | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const obj = v as Record<string, unknown>;
  if (typeof obj.id !== "string" || typeof obj.source !== "string" || typeof obj.target !== "string" || typeof obj.enabled !== "boolean") return null;
  const modifiers = Array.isArray(obj.modifiers)
    ? obj.modifiers.map(tryValidateParamModifier).filter((m): m is ParamModifier => m !== null)
    : undefined;
  const colorModifiers = Array.isArray(obj.colorModifiers)
    ? obj.colorModifiers.map(tryValidateColorModifier).filter((m): m is ColorModifier => m !== null)
    : undefined;
  return {
    id: obj.id,
    source: obj.source as P,
    target: obj.target as P,
    enabled: obj.enabled,
    modifiers: modifiers && modifiers.length > 0 ? modifiers : undefined,
    colorModifiers: colorModifiers && colorModifiers.length > 0 ? colorModifiers : undefined,
  };
}

/** Validates a persisted `links` array (GitHub issue #651) — `null`/absent means "untouched since
 *  load (or saved before this issue existed)", read back as `fallback` (the mode's current
 *  `DEFAULT_*_LINKS`) so a project file always picks up a later change to that default set rather
 *  than freezing today's defaults into the file. A malformed individual entry is dropped (same
 *  "degrade gracefully" leniency as the rest of this file); the whole array falls back to
 *  `fallback` if it fails `validateLinkGraph` (duplicate target, cross-type pair, cycle, unknown
 *  path against `registry`) — a hand-edited or corrupted link graph only degrades this one section,
 *  never fails the whole file load. */
export function validateLinks<P extends string>(v: unknown, path: string, fallback: ParamLink<P>[], registry: Record<string, ParamDescriptor>): ParamLink<P>[] {
  if (v == null) return fallback;
  let arr: unknown[];
  try {
    arr = assertArray(v, path);
  } catch {
    return fallback;
  }
  const links = arr.map(tryValidateParamLink<P>).filter((l): l is ParamLink<P> => l !== null);
  try {
    validateLinkGraph(links, registry);
  } catch {
    return fallback;
  }
  return links;
}

/** Extends a persisted custom graph with a newly introduced default target without changing an
 * existing user link. Projects using the current defaults already carry the target. */
function ensureDefaultLink<P extends string>(links: ParamLink<P>[], defaults: ParamLink<P>[], target: P): ParamLink<P>[] {
  if (links.some((link) => link.target === target)) return links;
  const defaultLink = defaults.find((link) => link.target === target);
  return defaultLink ? [...links, defaultLink] : links;
}

/** Lenient — every field falls back to its own default when absent or malformed, same recovery
 * pattern `validateSplitGeneration` uses, since this whole section is optional (absent entirely
 * for project files saved before GitHub issue #295). */
function cutLineStyle(obj: Record<string, unknown> | null, d: CutLineStyleFields): CutLineStyleFields {
  return {
    showCutLines: optBool(obj, "showCutLines", d.showCutLines),
    cutLinesGlueColor: optBool(obj, "cutLinesGlueColor", d.cutLinesGlueColor),
    trimWallsAtFaceBoundaries: optBool(obj, "trimWallsAtFaceBoundaries", d.trimWallsAtFaceBoundaries ?? true),
    cutLinesColor: optNumber(obj, "cutLinesColor", d.cutLinesColor),
  };
}

function clampTo(range: { min: number; max: number }, value: number): number {
  return Math.min(range.max, Math.max(range.min, value));
}

/** Lenient like `cutLineStyle`: the section is absent from files saved before GitHub issue #900. */
function creaseStyle(obj: Record<string, unknown> | null, d: CreaseExportStyle): CreaseExportStyle {
  let o: Record<string, unknown> | null = null;
  try {
    o = obj && obj.creases != null ? assertObject(obj.creases, "creases") : null;
  } catch {
    o = null;
  }
  return {
    showCreases: optBool(o, "showCreases", d.showCreases),
    mode: optEnum(o, "mode", ["lines", "marks"] as const, d.mode),
    lineStyle: optEnum(o, "lineStyle", ["dashed", "solid"] as const, d.lineStyle),
    lineWidth: clampTo(CREASE_LINE_WIDTH_RANGE, optNumber(o, "lineWidth", d.lineWidth)),
    markSize: clampTo(CREASE_MARK_SIZE_RANGE, optNumber(o, "markSize", d.markSize)),
    markTipLength: clampTo(CREASE_MARK_TIP_LENGTH_RANGE, optNumber(o, "markTipLength", d.markTipLength)),
    color: optNumber(o, "color", d.color),
    markColor: optNumber(o, "markColor", d.markColor),
  };
}

/** Lenient like `creaseStyle`: the section is absent from files saved before GitHub issue #901. */
function glueTabStyle(obj: Record<string, unknown> | null, d: GlueTabStyle): GlueTabStyle {
  let o: Record<string, unknown> | null = null;
  try {
    o = obj && obj.glueTabs != null ? assertObject(obj.glueTabs, "glueTabs") : null;
  } catch {
    o = null;
  }
  return {
    showTabs: optBool(o, "showTabs", d.showTabs),
    inset: clampTo(GLUE_TAB_INSET_RANGE, optNumber(o, "inset", d.inset)),
    width: clampTo(GLUE_TAB_WIDTH_RANGE, optNumber(o, "width", d.width)),
    alternate: optBool(o, "alternate", d.alternate),
    fillColor: optNumber(o, "fillColor", d.fillColor),
    lineColor: optNumber(o, "lineColor", d.lineColor),
    lineStyle: optEnum(o, "lineStyle", ["dashed", "solid"] as const, d.lineStyle),
    lineWidth: clampTo(GLUE_TAB_LINE_WIDTH_RANGE, optNumber(o, "lineWidth", d.lineWidth)),
  };
}

/** Lenient like `glueTabStyle`: the section is absent from files saved before GitHub issue #902. A malformed override is dropped. */
function edgeMarkerOverrides(raw: unknown): Record<string, EdgeMarkerOverride> {
  const overrides: Record<string, EdgeMarkerOverride> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return overrides;
  for (const [key, value] of Object.entries(raw)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    const override: EdgeMarkerOverride = {};
    if (typeof entry.shape === "string" && (MARKER_SHAPES as readonly string[]).includes(entry.shape)) override.shape = entry.shape as MarkerShape;
    if (typeof entry.color === "number" && Number.isFinite(entry.color)) override.color = entry.color;
    if (entry.linkBroken && typeof entry.linkBroken === "object" && !Array.isArray(entry.linkBroken)) {
      const rawBroken = entry.linkBroken as Record<string, unknown>;
      const broken: NonNullable<EdgeMarkerOverride["linkBroken"]> = {};
      if (rawBroken.color === true) broken.color = true;
      if (rawBroken.shape === true) broken.shape = true;
      if (Object.keys(broken).length > 0) override.linkBroken = broken;
    }
    if (Object.keys(override).length > 0) overrides[key] = override;
  }
  return overrides;
}

function edgeMarkerStyle(obj: Record<string, unknown> | null, d: EdgeMarkerStyle): EdgeMarkerStyle {
  let o: Record<string, unknown> | null = null;
  try {
    o = obj && obj.edgeMarkers != null ? assertObject(obj.edgeMarkers, "edgeMarkers") : null;
  } catch {
    o = null;
  }
  const overrides: EdgeMarkerStyle["overrides"] = {};
  const raw = o?.overrides;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [floorId, floorRaw] of Object.entries(raw)) {
      const floor = edgeMarkerOverrides(floorRaw);
      if (Object.keys(floor).length > 0) overrides[floorId] = floor;
    }
  }
  return {
    mode: optEnum(o, "mode", ["hidden", "ambiguous", "gluings", "all"] as const, d.mode),
    size: clampTo(EDGE_MARKER_SIZE_RANGE, optNumber(o, "size", d.size)),
    shape: optMarkerShape(o, "shape", d.shape),
    color: optNumber(o, "color", d.color),
    overrides,
  };
}

export function validateVectorByWallsSettings(v: unknown, path: string, links: ParamLink<VectorByWallsParamPath>[]): VectorByWallsSettings {
  const d = DEFAULT_VECTOR_BY_WALLS_SETTINGS;
  if (v == null) return { ...d, links };
  let obj: Record<string, unknown> | null;
  try {
    obj = assertObject(v, path);
  } catch {
    return { ...d, links };
  }
  return {
    labelFont: optLabelFont(obj, "labelFont", d.labelFont ?? DEFAULT_LABEL_FONT),
    background: optNumber(obj, "background", d.background),
    showGrid: optBool(obj, "showGrid", d.showGrid),
    gridColor: optNumber(obj, "gridColor", d.gridColor),
    showInnerGrid: optBool(obj, "showInnerGrid", d.showInnerGrid),
    innerGridColor: optNumber(obj, "innerGridColor", d.innerGridColor),
    ...cutLineStyle(obj, d),
    creases: creaseStyle(obj, d.creases),
    glueTabs: glueTabStyle(obj, d.glueTabs),
    edgeMarkers: edgeMarkerStyle(obj, d.edgeMarkers),
    floorColor: optNumber(obj, "floorColor", d.floorColor),
    wallColor: optNumber(obj, "wallColor", d.wallColor),
    randomWallColorMode: optEnum(obj, "randomWallColorMode", ["off", "per_pass", "per_segment"] as const, d.randomWallColorMode),
    wallJoin: optCornerStyle(obj, "wallJoin", d.wallJoin),
    wallThickness: optNumber(obj, "wallThickness", d.wallThickness),
    oneWayPattern: optOneWayPattern(obj, "oneWayPattern", d.oneWayPattern),
    oneWayColor: optNumber(obj, "oneWayColor", d.oneWayColor),
    oneWayGapWidth: optNumber(obj, "oneWayGapWidth", d.oneWayGapWidth),
    oneWayGeometry: validateIndicatorGeometry(obj.oneWayGeometry, d.oneWayGeometry),
    oneWayJoin: optCornerStyle(obj, "oneWayJoin", d.oneWayJoin),
    startMarker: validateMarkerSettings(obj.startMarker, `${path}.startMarker`, d.startMarker),
    finishMarker: validateMarkerSettings(obj.finishMarker, `${path}.finishMarker`, d.finishMarker),
    startOpening: validateWaypointOpening(obj.startOpening, `${path}.startOpening`, d.startOpening),
    finishOpening: validateWaypointOpening(obj.finishOpening, `${path}.finishOpening`, d.finishOpening),
    ...validateTeleportSettingsFields(obj, path, d),
    ...validateVerticalSettingsFields(obj, path, d),
    ...validateVerticalDecorativeFields(obj, path, d),
    splitNodeColors: Array.isArray(obj.splitNodeColors) ? obj.splitNodeColors.filter((n): n is number => typeof n === "number") : d.splitNodeColors,
    splitSpecialShapes: optBool(obj, "splitSpecialShapes", d.splitSpecialShapes),
    markerShape: optMarkerShape(obj, "markerShape", d.markerShape),
    cornerStyle: optCornerStyle(obj, "cornerStyle", d.cornerStyle),
    markerSize: optNumber(obj, "markerSize", d.markerSize),
    markerSizeAdaptation: optSizeAdaptation(obj, "markerSizeAdaptation", d.markerSizeAdaptation),
    markerFillColor: optNumber(obj, "markerFillColor", d.markerFillColor),
    markerBorderColor: optNumber(obj, "markerBorderColor", d.markerBorderColor),
    markerBorderWidth: optNumber(obj, "markerBorderWidth", d.markerBorderWidth),
    gapWidth: optNumber(obj, "gapWidth", d.gapWidth),
    markerTextSize: optNumber(obj, "markerTextSize", d.markerTextSize),
    markerTextMargin: clampTextMargin(optNumber(obj, "markerTextMargin", d.markerTextMargin)),
    floorLabelType: optElevatorBadgeLabelType(obj, "floorLabelType", d.floorLabelType),
    floorLabel: validateFloorLabelSettings(obj.floorLabel, `${path}.floorLabel`, d.floorLabel),
    verticalCornerStyle: optCornerStyle(obj, "verticalCornerStyle", d.verticalCornerStyle),
    verticalShape: optMarkerShape(obj, "verticalShape", d.verticalShape),
    verticalSize: optNumber(obj, "verticalSize", d.verticalSize),
    verticalSizeAdaptation: optSizeAdaptation(obj, "verticalSizeAdaptation", d.verticalSizeAdaptation),
    verticalBorderWidth: optNumber(obj, "verticalBorderWidth", d.verticalBorderWidth),
    verticalGapWidth: optNumber(obj, "verticalGapWidth", d.verticalGapWidth),
    verticalFillColor: optNumber(obj, "verticalFillColor", d.verticalFillColor),
    verticalBorderColor: optNumber(obj, "verticalBorderColor", d.verticalBorderColor),
    verticalArrowColor: optNumber(obj, "verticalArrowColor", d.verticalArrowColor),
    verticalArrowSize: optNumber(obj, "verticalArrowSize", d.verticalArrowSize),
    verticalArrowStyle: optVerticalArrowStyle(obj, "verticalArrowStyle", d.verticalArrowStyle),
    verticalArrowCornerStyle: optCornerStyle(obj, "verticalArrowCornerStyle", d.verticalArrowCornerStyle),
    verticalDecorativeLineColor: optNumber(obj, "verticalDecorativeLineColor", d.verticalDecorativeLineColor),
    verticalDecorativeLineWidth: optNumber(obj, "verticalDecorativeLineWidth", d.verticalDecorativeLineWidth),
    verticalDecorativeSize: optNumber(obj, "verticalDecorativeSize", d.verticalDecorativeSize),
    verticalDecorativeSizeAdaptation: optSizeAdaptation(obj, "verticalDecorativeSizeAdaptation", d.verticalDecorativeSizeAdaptation),
    verticalDecorativeArrowSize: optNumber(obj, "verticalDecorativeArrowSize", d.verticalDecorativeArrowSize),
    links,
    markerIndex: validateMarkerIndexSettings(obj.markerIndex, `${path}.markerIndex`, d.markerIndex),
    markerLayout: optMarkerLayout(obj, "markerLayout", d.markerLayout),
    markerScale: optNumber(obj, "markerScale", d.markerScale),
  };
}

export const KNOWN_RENDER_MODE_IDS: RenderModeId[] = ["vector_by_walls", "vector_by_corridors"];

/** Degrades to `null` for an unknown/future `RenderModeId` — same "never throw" convention
 * `resolveRenderMode` itself uses, so a project file naming a since-removed/renamed mode loads
 * as "no mode selected" rather than failing the whole file. */
export function optRenderModeId(obj: Record<string, unknown> | null, key: string): RenderModeId | null {
  const v = obj?.[key];
  return typeof v === "string" && (KNOWN_RENDER_MODE_IDS as readonly string[]).includes(v) ? (v as RenderModeId) : null;
}

export const KNOWN_LINK_ICON_VISIBILITIES: LinkIconVisibility[] = ["always", "linked", "never"];

/** Degrades to `fallback` for an unknown/future `LinkIconVisibility` (GitHub issue #652 follow-up)
 * — same "never throw" convention `optRenderModeId` itself uses. */
export function optLinkIconVisibility(obj: Record<string, unknown> | null, key: string, fallback: LinkIconVisibility): LinkIconVisibility {
  const v = obj?.[key];
  return typeof v === "string" && (KNOWN_LINK_ICON_VISIBILITIES as readonly string[]).includes(v) ? (v as LinkIconVisibility) : fallback;
}

export const KNOWN_OUTPUT_MODES: PngExportOutputMode[] = ["digital", "print"];
export const KNOWN_CANVAS_MODES: PngCanvasMode[] = ["edge_to_edge", "margin_px", "margin_cells", "fixed_size"];
export const KNOWN_PRINT_DENSITIES: PrintDensity[] = ["screen_96", "draft_150", "print_300", "high_600"];
export const KNOWN_PAPER_SIZES: PaperSize[] = ["a4", "a3", "a5", "a2", "a1", "a0", "letter", "legal", "tabloid", "custom"];
export const KNOWN_ORIENTATIONS: PaperOrientation[] = ["portrait", "landscape"];
export const KNOWN_ANCHORS: PrintAnchor[] = [
  "top_left", "top_center", "top_right",
  "center_left", "center", "center_right",
  "bottom_left", "bottom_center", "bottom_right",
  "custom",
];

export function validateDigitalExportSettings(v: unknown, path: string): DigitalExportSettings {
  const d = DEFAULT_PNG_EXPORT_SETTINGS.digital;
  let obj: Record<string, unknown> | null = null;
  if (v != null) {
    try {
      obj = assertObject(v, path);
    } catch {
      obj = null;
    }
  }
  return {
    scale: optNumber(obj, "scale", d.scale),
    canvasMode: optEnum(obj, "canvasMode", KNOWN_CANVAS_MODES, d.canvasMode),
    marginValue: optNumber(obj, "marginValue", d.marginValue),
    fixedWidth: optNumber(obj, "fixedWidth", d.fixedWidth),
    fixedHeight: optNumber(obj, "fixedHeight", d.fixedHeight),
  };
}

export function validatePrintExportSettings(v: unknown, path: string): PrintExportSettings {
  const d = DEFAULT_PNG_EXPORT_SETTINGS.print;
  let obj: Record<string, unknown> | null = null;
  if (v != null) {
    try {
      obj = assertObject(v, path);
    } catch {
      obj = null;
    }
  }
  return {
    density: optEnum(obj, "density", KNOWN_PRINT_DENSITIES, d.density),
    paperSize: optEnum(obj, "paperSize", KNOWN_PAPER_SIZES, d.paperSize),
    customWidthMm: optNumber(obj, "customWidthMm", d.customWidthMm),
    customHeightMm: optNumber(obj, "customHeightMm", d.customHeightMm),
    orientation: optEnum(obj, "orientation", KNOWN_ORIENTATIONS, d.orientation),
    marginHMm: optNumber(obj, "marginHMm", d.marginHMm),
    marginVMm: optNumber(obj, "marginVMm", d.marginVMm),
    scale: optNumber(obj, "scale", d.scale),
    // Retained in the file format only for backward compatibility. Print auto-fit is now a
    // one-shot panel action, so old persistent-auto-fit projects load as manual scale settings.
    scaleAutoFit: false,
    anchor: optEnum(obj, "anchor", KNOWN_ANCHORS, d.anchor),
    offsetXMm: optNumber(obj, "offsetXMm", d.offsetXMm),
    offsetYMm: optNumber(obj, "offsetYMm", d.offsetYMm),
  };
}

const KNOWN_CUT_MODES = ["none", "auto", "manual"] as const;

/** `v` as a plain object, or an empty one when it is anything else (an array included). */
function asRecord(v: unknown): Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** Lenient like its siblings: a project predating cut lines, or an entry that does not parse, falls
 * back to the default (no cuts); a malformed entry is dropped, the others are kept. */
export function validateCutExportSettings(v: unknown, path: string): CutExportSettings {

  let obj: Record<string, unknown> | null = null;
  if (v != null) {
    try {
      obj = assertObject(v, path);
    } catch {
      obj = null;
    }
  }
  const lines: Record<string, Record<number, CutLineSetting>> = {};
  for (const [floorId, rawFloor] of Object.entries(asRecord(obj?.lines))) {
    const floor: Record<number, CutLineSetting> = {};
    for (const [group, raw] of Object.entries(asRecord(rawFloor))) {
      if (!/^\d+$/.test(group)) continue;
      const entry = asRecord(raw);
      const mode = optEnum(entry, "mode", KNOWN_CUT_MODES, "none");
      if (mode === "none") continue;
      floor[Number(group)] = { mode, offset: Math.min(Math.max(optNumber(entry, "offset", 0), -1), 1) };
    }
    if (Object.keys(floor).length > 0) lines[floorId] = floor;
  }
  return { lines };
}

export function validatePngExportSettings(v: unknown, path: string): PngExportSettings {
  let obj: Record<string, unknown> | null = null;
  if (v != null) {
    try {
      obj = assertObject(v, path);
    } catch {
      obj = null;
    }
  }
  return {
    outputMode: optEnum(obj, "outputMode", KNOWN_OUTPUT_MODES, DEFAULT_PNG_EXPORT_SETTINGS.outputMode),
    digital: validateDigitalExportSettings(obj?.digital, `${path}.digital`),
    print: validatePrintExportSettings(obj?.print, `${path}.print`),
    cuts: validateCutExportSettings(obj?.cuts, `${path}.cuts`),
  };
}

/** Same recovery-default convention as `validateVectorByWallsSettings` (GitHub issue #310). */
export function validateVectorByCorridorsSettings(v: unknown, path: string, links: ParamLink<VectorByCorridorsParamPath>[]): VectorByCorridorsSettings {
  let obj: Record<string, unknown> | null = null;
  if (v != null) {
    try {
      obj = assertObject(v, path);
    } catch {
      obj = null;
    }
  }
  const d = DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS;
  return {
    labelFont: optLabelFont(obj, "labelFont", d.labelFont ?? DEFAULT_LABEL_FONT),
    background: optNumber(obj, "background", d.background),
    showGrid: optBool(obj, "showGrid", d.showGrid),
    gridColor: optNumber(obj, "gridColor", d.gridColor),
    ...cutLineStyle(obj, d),
    creases: creaseStyle(obj, d.creases),
    glueTabs: glueTabStyle(obj, d.glueTabs),
    edgeMarkers: edgeMarkerStyle(obj, d.edgeMarkers),
    color: optNumber(obj, "color", d.color),
    thickness: optNumber(obj, "thickness", d.thickness),
    junctionRadius: optNumber(obj, "junctionRadius", d.junctionRadius),
    join: optCornerStyle(obj, "join", d.join),
    renderStyle: optRenderStyle(obj, "renderStyle", d.renderStyle),
    startMarker: validateMarkerSettings(obj?.startMarker, `${path}.startMarker`, d.startMarker),
    finishMarker: validateMarkerSettings(obj?.finishMarker, `${path}.finishMarker`, d.finishMarker),
    markerWidenPadding: optNumber(obj, "markerWidenPadding", d.markerWidenPadding),
    markerWidenShape: optMarkerWidenShape(obj, "markerWidenShape", d.markerWidenShape),
    oneWayColor: optNumber(obj, "oneWayColor", d.oneWayColor),
    oneWayCount: optNumber(obj, "oneWayCount", d.oneWayCount),
    oneWayThickness: optNumber(obj, "oneWayThickness", d.oneWayThickness),
    oneWayGap: optNumber(obj, "oneWayGap", d.oneWayGap),
    oneWayWidth: optNumber(obj, "oneWayWidth", d.oneWayWidth),
    oneWayLength: optNumber(obj, "oneWayLength", d.oneWayLength),
    oneWayJoin: optCornerStyle(obj, "oneWayJoin", d.oneWayJoin),
    ...validateTeleportSettingsFields(obj, path, d),
    ...validateVerticalSettingsFields(obj, path, d),
    splitNodeColors: Array.isArray(obj?.splitNodeColors) ? obj.splitNodeColors.filter((n): n is number => typeof n === "number") : d.splitNodeColors,
    splitSpecialShapes: optBool(obj, "splitSpecialShapes", d.splitSpecialShapes),
    splitGapWidth: optNumber(obj, "splitGapWidth", d.splitGapWidth),
    splitDiagonalBowAmount: optNumber(obj, "splitDiagonalBowAmount", d.splitDiagonalBowAmount),
    markerShape: optMarkerShape(obj, "markerShape", d.markerShape),
    cornerStyle: optCornerStyle(obj, "cornerStyle", d.cornerStyle),
    markerSize: optNumber(obj, "markerSize", d.markerSize),
    markerSizeAdaptation: optSizeAdaptation(obj, "markerSizeAdaptation", d.markerSizeAdaptation),
    markerFillColor: optNumber(obj, "markerFillColor", d.markerFillColor),
    markerBorderColor: optNumber(obj, "markerBorderColor", d.markerBorderColor),
    markerBorderWidth: optNumber(obj, "markerBorderWidth", d.markerBorderWidth),
    gapWidth: optNumber(obj, "gapWidth", d.gapWidth),
    markerTextSize: optNumber(obj, "markerTextSize", d.markerTextSize),
    markerTextMargin: clampTextMargin(optNumber(obj, "markerTextMargin", d.markerTextMargin)),
    floorLabelType: optElevatorBadgeLabelType(obj, "floorLabelType", d.floorLabelType),
    floorLabel: validateFloorLabelSettings(obj?.floorLabel, `${path}.floorLabel`, d.floorLabel),
    verticalCornerStyle: optCornerStyle(obj, "verticalCornerStyle", d.verticalCornerStyle),
    verticalShape: optMarkerShape(obj, "verticalShape", d.verticalShape),
    verticalSize: optNumber(obj, "verticalSize", d.verticalSize),
    verticalSizeAdaptation: optSizeAdaptation(obj, "verticalSizeAdaptation", d.verticalSizeAdaptation),
    verticalBorderWidth: optNumber(obj, "verticalBorderWidth", d.verticalBorderWidth),
    verticalGapWidth: optNumber(obj, "verticalGapWidth", d.verticalGapWidth),
    verticalFillColor: optNumber(obj, "verticalFillColor", d.verticalFillColor),
    verticalBorderColor: optNumber(obj, "verticalBorderColor", d.verticalBorderColor),
    verticalArrowColor: optNumber(obj, "verticalArrowColor", d.verticalArrowColor),
    verticalArrowSize: optNumber(obj, "verticalArrowSize", d.verticalArrowSize),
    verticalArrowStyle: optVerticalArrowStyle(obj, "verticalArrowStyle", d.verticalArrowStyle),
    verticalArrowCornerStyle: optCornerStyle(obj, "verticalArrowCornerStyle", d.verticalArrowCornerStyle),
    links,
    markerIndex: validateMarkerIndexSettings(obj?.markerIndex, `${path}.markerIndex`, d.markerIndex),
    markerLayout: optMarkerLayout(obj, "markerLayout", d.markerLayout),
    markerScale: optNumber(obj, "markerScale", d.markerScale),
  };
}

function hasFloorLabelSettings(obj: Record<string, unknown> | null): boolean {
  return [obj?.vectorByWallsSettings, obj?.vectorByCorridorsSettings].some((settings) =>
    settings != null && typeof settings === "object" && (settings as Record<string, unknown>).floorLabel != null);
}

export function validateImageExport(v: unknown, path: string): ProjectFileImageExport {
  let obj: Record<string, unknown> | null = null;
  if (v != null) {
    try {
      obj = assertObject(v, path);
    } catch {
      obj = null;
    }
  }
  const vectorByWallsLinks = ensureDefaultLink(
    validateLinks<VectorByWallsParamPath>(obj?.vectorByWallsLinks, `${path}.vectorByWallsLinks`, DEFAULT_VECTOR_BY_WALLS_LINKS, VECTOR_BY_WALLS_PARAM_REGISTRY),
    DEFAULT_VECTOR_BY_WALLS_LINKS,
    "teleportConnectorCornerStyle",
  );
  const vectorByCorridorsLinks = ensureDefaultLink(
    validateLinks<VectorByCorridorsParamPath>(obj?.vectorByCorridorsLinks, `${path}.vectorByCorridorsLinks`, DEFAULT_VECTOR_BY_CORRIDORS_LINKS, VECTOR_BY_CORRIDORS_PARAM_REGISTRY),
    DEFAULT_VECTOR_BY_CORRIDORS_LINKS,
    "teleportConnectorCornerStyle",
  );
  return {
    activeRenderMode: optRenderModeId(obj, "activeRenderMode"),
    openRenderModeSettings: optRenderModeId(obj, "openRenderModeSettings"),
    vectorByWallsSettings: validateVectorByWallsSettings(obj?.vectorByWallsSettings, `${path}.vectorByWallsSettings`, vectorByWallsLinks),
    vectorByWallsSectionsExpanded: obj?.vectorByWallsSectionsExpanded != null
      ? assertBoolRecord(obj.vectorByWallsSectionsExpanded, `${path}.vectorByWallsSectionsExpanded`)
      : {},
    showColorWarnings: optBool(obj, "showColorWarnings", true),
    linkIconVisibility: optLinkIconVisibility(obj, "linkIconVisibility", "linked"),
    vectorByCorridorsSettings: validateVectorByCorridorsSettings(obj?.vectorByCorridorsSettings, `${path}.vectorByCorridorsSettings`, vectorByCorridorsLinks),
    vectorByCorridorsSectionsExpanded: obj?.vectorByCorridorsSectionsExpanded != null
      ? assertBoolRecord(obj.vectorByCorridorsSectionsExpanded, `${path}.vectorByCorridorsSectionsExpanded`)
      : {},
    pngExportSettings: validatePngExportSettings(obj?.pngExportSettings, `${path}.pngExportSettings`),
    // A file saved before GitHub issue #747 that already carries floor-label settings keeps them
    // as-is; one without them gets the mode chosen on the next first open of Image Export.
    floorLabelModeChosen: optBool(obj, "floorLabelModeChosen", hasFloorLabelSettings(obj)),
    vectorByWallsLinks: linksMatchDefaults(vectorByWallsLinks, DEFAULT_VECTOR_BY_WALLS_LINKS) ? null : vectorByWallsLinks,
    vectorByCorridorsLinks: linksMatchDefaults(vectorByCorridorsLinks, DEFAULT_VECTOR_BY_CORRIDORS_LINKS) ? null : vectorByCorridorsLinks,
  };
}
