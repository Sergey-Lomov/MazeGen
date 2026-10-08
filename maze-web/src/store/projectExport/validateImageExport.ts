import {
  type MarkerSettings, type DecorativeLineStyle, type ElevatorBadgeSettings, type ElevatorBadgeLabelType, type ElevatorBadgePlacement, type MarkerIndexSettings, type VectorByWallsSettings, type VectorByCorridorsSettings, type TeleportSettingsFields, type VerticalSettingsFields, type VerticalDecorativeFields, type MarkerWidenShape, type PngExportSettings,
  type PngExportOutputMode, type PngCanvasMode, type PrintDensity, type PaperSize, type PaperOrientation, type PrintAnchor,
  type DigitalExportSettings, type PrintExportSettings,
} from "../storeTypes";
import type { MarkerShape, ElevatorBadgeFontWeight, CornerStyle } from "../../pixi/renderers/types";
import { sanitizeMarkerGlyph } from "../../pixi/renderers/markerGlyph";
import type { RenderModeId, LinkIconVisibility } from "../mazeStore";
import type { ProjectFileImageExport } from "./types";
import { DEFAULT_VECTOR_BY_WALLS_SETTINGS, DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS, DEFAULT_PNG_EXPORT_SETTINGS } from "../slices/imageExportSlice";
import { DEFAULT_VECTOR_BY_WALLS_LINKS, DEFAULT_VECTOR_BY_CORRIDORS_LINKS } from "../slices/parameterLinksDefaults";
import type { ParamLink, ParamModifier, ColorModifier, ColorModel, ColorChannel, ParamDescriptor } from "../parameterLinks";
import { validateLinkGraph, linksMatchDefaults } from "../slices/parameterLinksEngine";
import { VECTOR_BY_WALLS_PARAM_REGISTRY, VECTOR_BY_CORRIDORS_PARAM_REGISTRY, type VectorByWallsParamPath, type VectorByCorridorsParamPath } from "../parameterLinksRegistry";
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

export function optTeleportConnectorStyle(obj: Record<string, unknown> | null, key: string, fallback: "none" | "straight" | "orthogonal"): "none" | "straight" | "orthogonal" {
  const v = obj?.[key];
  return v === "none" || v === "straight" || v === "orthogonal" ? v : fallback;
}

export function optTeleportArrowMode(obj: Record<string, unknown> | null, key: string, fallback: "none" | "center" | "double" | "periodic"): "none" | "center" | "double" | "periodic" {
  const v = obj?.[key];
  return v === "none" || v === "center" || v === "double" || v === "periodic" ? v : fallback;
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
    shape: optMarkerShape(obj, "shape", fallback.shape),
    cornerStyle: optCornerStyle(obj, "cornerStyle", fallback.cornerStyle),
    fillColor: optNumber(obj, "fillColor", fallback.fillColor),
    borderColor: optNumber(obj, "borderColor", fallback.borderColor),
    borderWidth: optNumber(obj, "borderWidth", fallback.borderWidth),
    gapWidth: optNumber(obj, "gapWidth", fallback.gapWidth),
    size: optNumber(obj, "size", fallback.size),
    text: typeof obj?.text === "string" ? sanitizeMarkerGlyph(obj.text) : fallback.text,
    textEnabled: obj?.textEnabled === undefined ? fallback.textEnabled : optBool(obj, "textEnabled", fallback.textEnabled ?? true),
    textFontWeight: obj?.textFontWeight === undefined
      ? fallback.textFontWeight
      : optElevatorBadgeFontWeight(obj, "textFontWeight", fallback.textFontWeight ?? "bold"),
    textSize: obj?.textSize === undefined ? fallback.textSize : optNumber(obj, "textSize", fallback.textSize ?? 0.55),
    textColor: obj?.textColor === undefined ? fallback.textColor : optNumber(obj, "textColor", fallback.textColor ?? fallback.fillColor),
  };
}

/** Format-only validation of one group's override — an unresolvable `shape` just falls back to
 * the base style at render time (same "never throw" convention as `resolveRenderMode`), so a
 * malformed entry is dropped rather than failing the whole file. */
export function tryValidateTeleportGroupOverride(v: unknown): { fillColor?: number; borderColor?: number; shape?: MarkerShape } | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const obj = v as Record<string, unknown>;
  const result: { fillColor?: number; borderColor?: number; shape?: MarkerShape } = {};
  if (typeof obj.fillColor === "number") result.fillColor = obj.fillColor;
  if (typeof obj.borderColor === "number") result.borderColor = obj.borderColor;
  if (typeof obj.shape === "string" && (MARKER_SHAPES as readonly string[]).includes(obj.shape)) result.shape = obj.shape as MarkerShape;
  return result;
}

/** Shared by `validateVectorByWallsSettings`/`validateVectorByCorridorsSettings` (GitHub issue
 * #313) — `TeleportSettingsFields` is `extends`-ed identically by both settings interfaces, so the
 * two never need their own separate recovery logic for it. */
export function validateTeleportSettingsFields(obj: Record<string, unknown> | null, path: string, d: TeleportSettingsFields): TeleportSettingsFields {
  return {
    teleportLineCornerStyle: optCornerStyle(obj, "teleportLineCornerStyle", d.teleportLineCornerStyle),
    teleportLineShape: optMarkerShape(obj, "teleportLineShape", d.teleportLineShape),
    teleportLineSize: optNumber(obj, "teleportLineSize", d.teleportLineSize),
    teleportEdgeColor: optNumber(obj, "teleportEdgeColor", d.teleportEdgeColor),
    teleportEdgeBorderColor: optNumber(obj, "teleportEdgeBorderColor", d.teleportEdgeBorderColor),
    teleportEdgeBorderWidth: optNumber(obj, "teleportEdgeBorderWidth", d.teleportEdgeBorderWidth),
    teleportEdgeGapWidth: optNumber(obj, "teleportEdgeGapWidth", d.teleportEdgeGapWidth),
    teleportConnectorColor: optNumber(obj, "teleportConnectorColor", d.teleportConnectorColor),
    teleportConnectorWidth: optNumber(obj, "teleportConnectorWidth", d.teleportConnectorWidth),
    teleportConnectorStyle: optTeleportConnectorStyle(obj, "teleportConnectorStyle", d.teleportConnectorStyle),
    teleportAvoidFieldExit: optBool(obj, "teleportAvoidFieldExit", d.teleportAvoidFieldExit),
    teleportArrowMode: optTeleportArrowMode(obj, "teleportArrowMode", d.teleportArrowMode),
    teleportArrowPeriod: optNumber(obj, "teleportArrowPeriod", d.teleportArrowPeriod),
    teleportArrowSize: optNumber(obj, "teleportArrowSize", d.teleportArrowSize),
    teleportConnectorGapWidth: optNumber(obj, "teleportConnectorGapWidth", d.teleportConnectorGapWidth),
    teleportFloorBadge: validateTeleportFloorBadgeSettings(obj?.teleportFloorBadge, `${path}.teleportFloorBadge`, d.teleportFloorBadge),
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
  return {
    shape: optMarkerShape(obj, "shape", fallback.shape),
    labelType: optElevatorBadgeLabelType(obj, "labelType", fallback.labelType),
    size: optNumber(obj, "size", fallback.size),
    fillColor: optNumber(obj, "fillColor", fallback.fillColor),
    borderColor: optNumber(obj, "borderColor", fallback.borderColor),
    borderWidth: optNumber(obj, "borderWidth", fallback.borderWidth ?? 3),
    textColor: optNumber(obj, "textColor", fallback.textColor),
    textPadding: optNumber(obj, "textPadding", fallback.textPadding),
  };
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

export function optElevatorBadgeFontWeight(obj: Record<string, unknown> | null, key: string, fallback: ElevatorBadgeFontWeight): ElevatorBadgeFontWeight {
  const v = obj?.[key];
  return v === "regular" || v === "bold" ? v : fallback;
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
    enabled: optBool(obj, "enabled", fallback.enabled),
    labelType: optElevatorBadgeLabelType(obj, "labelType", fallback.labelType),
    size: optNumber(obj, "size", fallback.size),
    placement: optElevatorBadgePlacement(obj, "placement", fallback.placement),
    distance: optNumber(obj, "distance", fallback.distance),
    gap: optNumber(obj, "gap", fallback.gap),
    gapWidth: optNumber(obj, "gapWidth", fallback.gapWidth),
    cornerStyle: optCornerStyle(obj, "cornerStyle", fallback.cornerStyle),
    evenDistribution: optBool(obj, "evenDistribution", fallback.evenDistribution),
    shape: optMarkerShape(obj, "shape", fallback.shape),
    fillColor: optNumber(obj, "fillColor", fallback.fillColor),
    textColor: optNumber(obj, "textColor", fallback.textColor),
    fontWeight: optElevatorBadgeFontWeight(obj, "fontWeight", fallback.fontWeight),
  };
}

/** `MarkerIndexSettings` validation (GitHub issue #471) — same lenient-recovery convention as
 * `validateElevatorBadgeSettings`. `labelStyle`/`fontWeight` reuse the elevator-badge validators
 * (their types are aliases). */
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
    height: optNumber(obj, "height", fallback.height),
    offset: optNumber(obj, "offset", fallback.offset),
    cornerRadius: optNumber(obj, "cornerRadius", fallback.cornerRadius),
    paddingX: optNumber(obj, "paddingX", fallback.paddingX),
    gap: optNumber(obj, "gap", fallback.gap),
    fillColor: optNumber(obj, "fillColor", fallback.fillColor),
    textColor: optNumber(obj, "textColor", fallback.textColor),
    borderColor: optNumber(obj, "borderColor", fallback.borderColor),
    borderColorFromMarker: optBool(obj, "borderColorFromMarker", fallback.borderColorFromMarker),
    borderWidthFromMarker: optBool(obj, "borderWidthFromMarker", fallback.borderWidthFromMarker),
    borderWidth: optNumber(obj, "borderWidth", fallback.borderWidth),
    fontWeight: optElevatorBadgeFontWeight(obj, "fontWeight", fallback.fontWeight),
    coverage: validateMarkerIndexCoverage(obj.coverage, `${path}.coverage`, fallback.coverage),
  };
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

export function validateTeleportGroupOverrides(v: unknown, path: string): Record<string, { fillColor?: number; borderColor?: number; shape?: MarkerShape }> {
  if (v == null) return {};
  let obj: Record<string, unknown>;
  try {
    obj = assertObject(v, path);
  } catch {
    return {};
  }
  const result: Record<string, { fillColor?: number; borderColor?: number; shape?: MarkerShape }> = {};
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

/** Lenient — every field falls back to its own default when absent or malformed, same recovery
 * pattern `validateSplitGeneration` uses, since this whole section is optional (absent entirely
 * for project files saved before GitHub issue #295). */
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
    background: optNumber(obj, "background", d.background),
    showGrid: optBool(obj, "showGrid", d.showGrid),
    gridColor: optNumber(obj, "gridColor", d.gridColor),
    showInnerGrid: optBool(obj, "showInnerGrid", d.showInnerGrid),
    innerGridColor: optNumber(obj, "innerGridColor", d.innerGridColor),
    floorColor: optNumber(obj, "floorColor", d.floorColor),
    wallColor: optNumber(obj, "wallColor", d.wallColor),
    randomWallColorMode: optEnum(obj, "randomWallColorMode", ["off", "per_pass", "per_segment"] as const, d.randomWallColorMode),
    wallJoin: optCornerStyle(obj, "wallJoin", d.wallJoin),
    wallThickness: optNumber(obj, "wallThickness", d.wallThickness),
    oneWayPattern: optOneWayPattern(obj, "oneWayPattern", d.oneWayPattern),
    oneWayColor: optNumber(obj, "oneWayColor", d.oneWayColor),
    oneWayGapWidth: optNumber(obj, "oneWayGapWidth", d.oneWayGapWidth),
    oneWaySize: optNumber(obj, "oneWaySize", d.oneWaySize),
    oneWayThickness: optNumber(obj, "oneWayThickness", d.oneWayThickness),
    oneWayJoin: optCornerStyle(obj, "oneWayJoin", d.oneWayJoin),
    startMarker: validateMarkerSettings(obj.startMarker, `${path}.startMarker`, d.startMarker),
    finishMarker: validateMarkerSettings(obj.finishMarker, `${path}.finishMarker`, d.finishMarker),
    ...validateTeleportSettingsFields(obj, path, d),
    ...validateVerticalSettingsFields(obj, path, d),
    ...validateVerticalDecorativeFields(obj, path, d),
    splitNodeColors: Array.isArray(obj.splitNodeColors) ? obj.splitNodeColors.filter((n): n is number => typeof n === "number") : d.splitNodeColors,
    splitSpecialShapes: optBool(obj, "splitSpecialShapes", d.splitSpecialShapes),
    cornerStyle: optCornerStyle(obj, "cornerStyle", d.cornerStyle),
    markerSize: optNumber(obj, "markerSize", d.markerSize),
    markerBorderWidth: optNumber(obj, "markerBorderWidth", d.markerBorderWidth),
    gapWidth: optNumber(obj, "gapWidth", d.gapWidth),
    verticalCornerStyle: optCornerStyle(obj, "verticalCornerStyle", d.verticalCornerStyle),
    verticalShape: optMarkerShape(obj, "verticalShape", d.verticalShape),
    verticalSize: optNumber(obj, "verticalSize", d.verticalSize),
    verticalBorderWidth: optNumber(obj, "verticalBorderWidth", d.verticalBorderWidth),
    verticalGapWidth: optNumber(obj, "verticalGapWidth", d.verticalGapWidth),
    verticalFillColor: optNumber(obj, "verticalFillColor", d.verticalFillColor),
    verticalArrowColor: optNumber(obj, "verticalArrowColor", d.verticalArrowColor),
    verticalArrowSize: optNumber(obj, "verticalArrowSize", d.verticalArrowSize),
    verticalArrowStyle: optVerticalArrowStyle(obj, "verticalArrowStyle", d.verticalArrowStyle),
    verticalArrowCornerStyle: optCornerStyle(obj, "verticalArrowCornerStyle", d.verticalArrowCornerStyle),
    verticalDecorativeLineColor: optNumber(obj, "verticalDecorativeLineColor", d.verticalDecorativeLineColor),
    verticalDecorativeLineWidth: optNumber(obj, "verticalDecorativeLineWidth", d.verticalDecorativeLineWidth),
    verticalDecorativeSize: optNumber(obj, "verticalDecorativeSize", d.verticalDecorativeSize),
    verticalDecorativeArrowSize: optNumber(obj, "verticalDecorativeArrowSize", d.verticalDecorativeArrowSize),
    links,
    markerIndex: validateMarkerIndexSettings(obj.markerIndex, `${path}.markerIndex`, d.markerIndex),
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
    scaleAutoFit: optBool(obj, "scaleAutoFit", d.scaleAutoFit),
    anchor: optEnum(obj, "anchor", KNOWN_ANCHORS, d.anchor),
    offsetXMm: optNumber(obj, "offsetXMm", d.offsetXMm),
    offsetYMm: optNumber(obj, "offsetYMm", d.offsetYMm),
  };
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
    background: optNumber(obj, "background", d.background),
    showGrid: optBool(obj, "showGrid", d.showGrid),
    gridColor: optNumber(obj, "gridColor", d.gridColor),
    color: optNumber(obj, "color", d.color),
    thickness: optNumber(obj, "thickness", d.thickness),
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
    cornerStyle: optCornerStyle(obj, "cornerStyle", d.cornerStyle),
    markerSize: optNumber(obj, "markerSize", d.markerSize),
    markerBorderWidth: optNumber(obj, "markerBorderWidth", d.markerBorderWidth),
    gapWidth: optNumber(obj, "gapWidth", d.gapWidth),
    verticalCornerStyle: optCornerStyle(obj, "verticalCornerStyle", d.verticalCornerStyle),
    verticalShape: optMarkerShape(obj, "verticalShape", d.verticalShape),
    verticalSize: optNumber(obj, "verticalSize", d.verticalSize),
    verticalBorderWidth: optNumber(obj, "verticalBorderWidth", d.verticalBorderWidth),
    verticalGapWidth: optNumber(obj, "verticalGapWidth", d.verticalGapWidth),
    verticalFillColor: optNumber(obj, "verticalFillColor", d.verticalFillColor),
    verticalArrowColor: optNumber(obj, "verticalArrowColor", d.verticalArrowColor),
    verticalArrowSize: optNumber(obj, "verticalArrowSize", d.verticalArrowSize),
    verticalArrowStyle: optVerticalArrowStyle(obj, "verticalArrowStyle", d.verticalArrowStyle),
    verticalArrowCornerStyle: optCornerStyle(obj, "verticalArrowCornerStyle", d.verticalArrowCornerStyle),
    links,
    markerIndex: validateMarkerIndexSettings(obj?.markerIndex, `${path}.markerIndex`, d.markerIndex),
  };
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
  const vectorByWallsLinks = validateLinks<VectorByWallsParamPath>(obj?.vectorByWallsLinks, `${path}.vectorByWallsLinks`, DEFAULT_VECTOR_BY_WALLS_LINKS, VECTOR_BY_WALLS_PARAM_REGISTRY);
  const vectorByCorridorsLinks = validateLinks<VectorByCorridorsParamPath>(obj?.vectorByCorridorsLinks, `${path}.vectorByCorridorsLinks`, DEFAULT_VECTOR_BY_CORRIDORS_LINKS, VECTOR_BY_CORRIDORS_PARAM_REGISTRY);
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
    vectorByWallsLinks: linksMatchDefaults(vectorByWallsLinks, DEFAULT_VECTOR_BY_WALLS_LINKS) ? null : vectorByWallsLinks,
    vectorByCorridorsLinks: linksMatchDefaults(vectorByCorridorsLinks, DEFAULT_VECTOR_BY_CORRIDORS_LINKS) ? null : vectorByCorridorsLinks,
  };
}
