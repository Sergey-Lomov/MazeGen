import {
  type MarkerSettings, type DecorativeLineStyle, type ElevatorBadgeSettings, type ElevatorBadgeLabelType, type ElevatorBadgePlacement, type MarkerIndexSettings, type VectorByWallsSettings, type VectorByCorridorsSettings, type VectorByWallsSharedStyle, type VectorByCorridorsSharedStyle, type TeleportSettingsFields, type VerticalSettingsFields, type VerticalDecorativeFields, type MarkerWidenShape, type PngExportSettings,
  type PngExportOutputMode, type PngCanvasMode, type PrintDensity, type PaperSize, type PaperOrientation, type PrintAnchor,
  type DigitalExportSettings, type PrintExportSettings,
} from "../storeTypes";
import type { MarkerShape, ElevatorBadgeFontWeight } from "../../pixi/renderers/types";
import type { RenderModeId } from "../mazeStore";
import type { ProjectFileImageExport } from "./types";
import { DEFAULT_VECTOR_BY_WALLS_SETTINGS, DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS, DEFAULT_PNG_EXPORT_SETTINGS } from "../slices/imageExportSlice";
import { reconcileVectorByWallsSharedStyle, reconcileVectorByCorridorsSharedStyle } from "../slices/imageExportSliceHelpers";
import { assertObject, assertBoolRecord, optBool, optNumber, optEnum } from "./validatePrimitives";

// ─── Image Export (GitHub issue #295) ────────────────────────────────────────

export const MARKER_SHAPES = ["circle", "triangle", "square", "diamond", "pentagon", "star", "hexagon", "cross"] as const;
export function optMarkerShape(obj: Record<string, unknown> | null, key: string, fallback: MarkerSettings["shape"]): MarkerSettings["shape"] {
  const v = obj?.[key];
  return typeof v === "string" && (MARKER_SHAPES as readonly string[]).includes(v) ? (v as MarkerSettings["shape"]) : fallback;
}

export function optTeleportCornerStyle(obj: Record<string, unknown> | null, key: string, fallback: "sharp" | "round"): "sharp" | "round" {
  const v = obj?.[key];
  return v === "sharp" || v === "round" ? v : fallback;
}

export function optMarkerWidenShape(obj: Record<string, unknown> | null, key: string, fallback: MarkerWidenShape): MarkerWidenShape {
  const v = obj?.[key];
  return v === "circle" || v === "square" || v === "match_marker" ? v : fallback;
}

export function optJoin(obj: Record<string, unknown> | null, key: string, fallback: "round" | "miter"): "round" | "miter" {
  const v = obj?.[key];
  return v === "round" || v === "miter" ? v : fallback;
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
    cornerStyle: optTeleportCornerStyle(obj, "cornerStyle", fallback.cornerStyle),
    fillColor: optNumber(obj, "fillColor", fallback.fillColor),
    borderColor: optNumber(obj, "borderColor", fallback.borderColor),
    borderWidth: optNumber(obj, "borderWidth", fallback.borderWidth),
    gapWidth: optNumber(obj, "gapWidth", fallback.gapWidth),
    size: optNumber(obj, "size", fallback.size),
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
    teleportLineCornerStyle: optTeleportCornerStyle(obj, "teleportLineCornerStyle", d.teleportLineCornerStyle),
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
    cornerStyle: optTeleportCornerStyle(obj, "cornerStyle", fallback.cornerStyle),
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
    twoWayArrowCornerStyle: optJoin(obj, "twoWayArrowCornerStyle", d.twoWayArrowCornerStyle),
    oneWayArrowColor: optNumber(obj, "oneWayArrowColor", d.oneWayArrowColor),
    oneWayArrowSize: optNumber(obj, "oneWayArrowSize", d.oneWayArrowSize),
    oneWayArrowStyle: optVerticalArrowStyle(obj, "oneWayArrowStyle", d.oneWayArrowStyle),
    oneWayArrowCornerStyle: optJoin(obj, "oneWayArrowCornerStyle", d.oneWayArrowCornerStyle),
    oneWayAccentColor: optNumber(obj, "oneWayAccentColor", d.oneWayAccentColor),
    elevatorArrowColor: optNumber(obj, "elevatorArrowColor", d.elevatorArrowColor),
    elevatorArrowSize: optNumber(obj, "elevatorArrowSize", d.elevatorArrowSize),
    elevatorArrowStyle: optVerticalArrowStyle(obj, "elevatorArrowStyle", d.elevatorArrowStyle),
    elevatorArrowCornerStyle: optJoin(obj, "elevatorArrowCornerStyle", d.elevatorArrowCornerStyle),
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
    decorativeStairsAccentColor: optNumber(obj, "decorativeStairsAccentColor", d.decorativeStairsAccentColor),
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

/** Format-only validation of a shared-style overrides record — same "drop malformed entries rather
 * than fail the whole file" convention as `tryValidateTeleportGroupOverride`. Every group/field
 * pairing is accepted as-is (`true`) regardless of whether it names a field the current build
 * actually has — an unknown pairing is simply never looked up, same as a stale `teleportGroupOverrides`
 * entry for a group that no longer exists. */
export function validateSharedStyleOverrides<G extends string>(v: unknown): Partial<Record<G, Partial<Record<string, true>>>> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return {};
  const result: Partial<Record<G, Partial<Record<string, true>>>> = {};
  for (const [group, raw] of Object.entries(v as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
    const fields: Partial<Record<string, true>> = {};
    for (const field of Object.keys(raw as Record<string, unknown>)) fields[field] = true;
    result[group as G] = fields;
  }
  return result;
}

export function validateVectorByWallsSharedStyle(v: unknown, d: VectorByWallsSharedStyle): VectorByWallsSharedStyle {
  if (v == null) return d;
  let obj: Record<string, unknown> | null;
  try {
    obj = assertObject(v, "sharedStyle");
  } catch {
    return d;
  }
  return {
    cornerStyle: optTeleportCornerStyle(obj, "cornerStyle", d.cornerStyle),
    markerSize: optNumber(obj, "markerSize", d.markerSize),
    markerBorderWidth: optNumber(obj, "markerBorderWidth", d.markerBorderWidth),
    gapWidth: optNumber(obj, "gapWidth", d.gapWidth),
    overrides: validateSharedStyleOverrides(obj.overrides),
  };
}

export function validateVectorByCorridorsSharedStyle(v: unknown, d: VectorByCorridorsSharedStyle): VectorByCorridorsSharedStyle {
  if (v == null) return d;
  let obj: Record<string, unknown> | null;
  try {
    obj = assertObject(v, "sharedStyle");
  } catch {
    return d;
  }
  return {
    cornerStyle: optTeleportCornerStyle(obj, "cornerStyle", d.cornerStyle),
    markerSize: optNumber(obj, "markerSize", d.markerSize),
    markerBorderWidth: optNumber(obj, "markerBorderWidth", d.markerBorderWidth),
    gapWidth: optNumber(obj, "gapWidth", d.gapWidth),
    overrides: validateSharedStyleOverrides(obj.overrides),
  };
}

/** Lenient — every field falls back to its own default when absent or malformed, same recovery
 * pattern `validateSplitGeneration` uses, since this whole section is optional (absent entirely
 * for project files saved before GitHub issue #295). */
export function validateVectorByWallsSettings(v: unknown, path: string): VectorByWallsSettings {
  const d = DEFAULT_VECTOR_BY_WALLS_SETTINGS;
  if (v == null) return d;
  let obj: Record<string, unknown> | null;
  try {
    obj = assertObject(v, path);
  } catch {
    return d;
  }
  // `reconcileVectorByWallsSharedStyle` marks any dependent field whose restored value disagrees
  // with `sharedStyle`'s own restored value as overridden (GitHub issue #322 follow-up) — covers
  // both a pre-#322 file (no `sharedStyle` key, so it defaults while dependent fields keep their
  // real saved values) and a hand-edited file, so a later shared-style edit never silently
  // overwrites a loaded value that was never marked as following it.
  return reconcileVectorByWallsSharedStyle({
    background: optNumber(obj, "background", d.background),
    showGrid: optBool(obj, "showGrid", d.showGrid),
    gridColor: optNumber(obj, "gridColor", d.gridColor),
    floorColor: optNumber(obj, "floorColor", d.floorColor),
    wallColor: optNumber(obj, "wallColor", d.wallColor),
    randomWallColorMode: optEnum(obj, "randomWallColorMode", ["off", "per_pass", "per_segment"] as const, d.randomWallColorMode),
    wallJoin: optJoin(obj, "wallJoin", d.wallJoin),
    wallThickness: optNumber(obj, "wallThickness", d.wallThickness),
    oneWayPattern: optOneWayPattern(obj, "oneWayPattern", d.oneWayPattern),
    oneWayColor: optNumber(obj, "oneWayColor", d.oneWayColor),
    oneWayGapWidth: optNumber(obj, "oneWayGapWidth", d.oneWayGapWidth),
    oneWaySize: optNumber(obj, "oneWaySize", d.oneWaySize),
    oneWayThickness: optNumber(obj, "oneWayThickness", d.oneWayThickness),
    oneWayJoin: optJoin(obj, "oneWayJoin", d.oneWayJoin),
    startMarker: validateMarkerSettings(obj.startMarker, `${path}.startMarker`, d.startMarker),
    finishMarker: validateMarkerSettings(obj.finishMarker, `${path}.finishMarker`, d.finishMarker),
    ...validateTeleportSettingsFields(obj, path, d),
    ...validateVerticalSettingsFields(obj, path, d),
    ...validateVerticalDecorativeFields(obj, path, d),
    splitNodeColors: Array.isArray(obj.splitNodeColors) ? obj.splitNodeColors.filter((n): n is number => typeof n === "number") : d.splitNodeColors,
    splitSpecialShapes: optBool(obj, "splitSpecialShapes", d.splitSpecialShapes),
    sharedStyle: validateVectorByWallsSharedStyle(obj.sharedStyle, d.sharedStyle),
    markerIndex: validateMarkerIndexSettings(obj.markerIndex, `${path}.markerIndex`, d.markerIndex),
  });
}

export const KNOWN_RENDER_MODE_IDS: RenderModeId[] = ["vector_by_walls", "vector_by_corridors"];

/** Degrades to `null` for an unknown/future `RenderModeId` — same "never throw" convention
 * `resolveRenderMode` itself uses, so a project file naming a since-removed/renamed mode loads
 * as "no mode selected" rather than failing the whole file. */
export function optRenderModeId(obj: Record<string, unknown> | null, key: string): RenderModeId | null {
  const v = obj?.[key];
  return typeof v === "string" && (KNOWN_RENDER_MODE_IDS as readonly string[]).includes(v) ? (v as RenderModeId) : null;
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
export function validateVectorByCorridorsSettings(v: unknown, path: string): VectorByCorridorsSettings {
  let obj: Record<string, unknown> | null = null;
  if (v != null) {
    try {
      obj = assertObject(v, path);
    } catch {
      obj = null;
    }
  }
  const d = DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS;
  // See `validateVectorByWallsSettings`'s own comment on `reconcileVectorByWallsSharedStyle` — same
  // rationale, mirrored for this mode's own dependent-field set.
  return reconcileVectorByCorridorsSharedStyle({
    background: optNumber(obj, "background", d.background),
    showGrid: optBool(obj, "showGrid", d.showGrid),
    gridColor: optNumber(obj, "gridColor", d.gridColor),
    color: optNumber(obj, "color", d.color),
    thickness: optNumber(obj, "thickness", d.thickness),
    join: optJoin(obj, "join", d.join),
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
    oneWayJoin: optJoin(obj, "oneWayJoin", d.oneWayJoin),
    ...validateTeleportSettingsFields(obj, path, d),
    ...validateVerticalSettingsFields(obj, path, d),
    splitNodeColors: Array.isArray(obj?.splitNodeColors) ? obj.splitNodeColors.filter((n): n is number => typeof n === "number") : d.splitNodeColors,
    splitSpecialShapes: optBool(obj, "splitSpecialShapes", d.splitSpecialShapes),
    splitGapWidth: optNumber(obj, "splitGapWidth", d.splitGapWidth),
    splitDiagonalBowAmount: optNumber(obj, "splitDiagonalBowAmount", d.splitDiagonalBowAmount),
    sharedStyle: validateVectorByCorridorsSharedStyle(obj?.sharedStyle, d.sharedStyle),
    markerIndex: validateMarkerIndexSettings(obj?.markerIndex, `${path}.markerIndex`, d.markerIndex),
  });
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
  return {
    activeRenderMode: optRenderModeId(obj, "activeRenderMode"),
    openRenderModeSettings: optRenderModeId(obj, "openRenderModeSettings"),
    vectorByWallsSettings: validateVectorByWallsSettings(obj?.vectorByWallsSettings, `${path}.vectorByWallsSettings`),
    vectorByWallsSectionsExpanded: obj?.vectorByWallsSectionsExpanded != null
      ? assertBoolRecord(obj.vectorByWallsSectionsExpanded, `${path}.vectorByWallsSectionsExpanded`)
      : {},
    vectorByCorridorsSettings: validateVectorByCorridorsSettings(obj?.vectorByCorridorsSettings, `${path}.vectorByCorridorsSettings`),
    vectorByCorridorsSectionsExpanded: obj?.vectorByCorridorsSectionsExpanded != null
      ? assertBoolRecord(obj.vectorByCorridorsSectionsExpanded, `${path}.vectorByCorridorsSectionsExpanded`)
      : {},
    pngExportSettings: validatePngExportSettings(obj?.pngExportSettings, `${path}.pngExportSettings`),
  };
}
