import type { ParamDescriptor, ParamType } from "./parameterLinks";
import { colorToHex } from "./colorMath";
import { schemaEntriesFor, type LinkFieldDef, type LinkMode, type WallsLinkPath, type CorridorsLinkPath } from "./parameterLinkSchema";
import { labelFontEquals, type LabelFont } from "../pixi/renderers/fontChoice";
import { formatLabelFont } from "./fontLabels";
import * as m from "~/paraglide/messages";

/** The per-mode parameter registries are derived from `LINK_SCHEMA` (`parameterLinkSchema.ts`,
 *  GitHub issue #927) — nothing is declared here besides how a raw value is displayed. Every linkable
 *  param is a plain number/boolean, a packed-RGB color, one of a few small string enums, or a `LabelFont`
 *  object; `equals` is `Object.is` for all but the font (a color value is just a number, GitHub issue #647;
 *  a font compares by family and weight, GitHub issue #973). `cornerStyle`/`join`
 *  values ("round"/"miter") are formatted via the same labels the settings panel's own corner-style
 *  `SelectRow` uses, not the raw enum string; `markerShape`/`verticalArrowStyle` each get their own
 *  localized format function; plain numbers fall back to `formatNumber`, colors to `#rrggbb`
 *  (`formatColor`). `indexLabelStyle` uses the elevator-badge wording unless the schema field names a
 *  different one (`format: "markerIndexLabelStyle"`). */
/** Integers render bare ("5"), non-integers always to 2 decimal places ("5.10"), never the raw
 *  float string a chain of modifier steps can produce (e.g. a `×0.1` step's floating-point
 *  remainder) — GitHub issue #645 follow-up, link-row "current value" display. */
function formatNumber(value: unknown): string {
  const n = Number(value);
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

/** `"#rrggbb"`, same hex rendering the color picker's own hex field uses (`colorToHex`). */
function formatColor(value: unknown): string {
  return colorToHex(value as number);
}

function formatTeleportCurveDirection(value: unknown): string {
  if (value === "inward") return m["image_export.vector_by_walls.teleport_curve_direction_inward"]();
  if (value === "outward") return m["image_export.vector_by_walls.teleport_curve_direction_outward"]();
  return String(value);
}

function formatCornerStyle(value: unknown): string {
  if (value === "round") return m["image_export.vector_by_walls.corner_style_round"]();
  if (value === "miter") return m["image_export.vector_by_walls.corner_style_sharp"]();
  return String(value);
}

function formatMarkerShape(value: unknown): string {
  switch (value) {
    case "circle":
      return m["image_export.vector_by_walls.marker_shape_circle"]();
    case "triangle":
      return m["image_export.vector_by_walls.marker_shape_triangle"]();
    case "square":
      return m["image_export.vector_by_walls.marker_shape_square"]();
    case "diamond":
      return m["image_export.vector_by_walls.marker_shape_diamond"]();
    case "pentagon":
      return m["image_export.vector_by_walls.marker_shape_pentagon"]();
    case "star":
      return m["image_export.vector_by_walls.marker_shape_star"]();
    case "hexagon":
      return m["image_export.vector_by_walls.marker_shape_hexagon"]();
    case "cross":
      return m["image_export.vector_by_walls.marker_shape_cross"]();
    default:
      return String(value);
  }
}

function formatVerticalArrowStyle(value: unknown): string {
  switch (value) {
    case "triangle":
      return m["image_export.vector_by_walls.one_way_pattern_triangle"]();
    case "chevron":
      return m["image_export.vector_by_walls.one_way_pattern_chevron"]();
    case "arrow":
      return m["image_export.vector_by_walls.one_way_pattern_arrow"]();
    case "sign":
      return m["image_export.vector_by_walls.vertical_arrow_style_sign"]();
    default:
      return String(value);
  }
}

function formatOneWayPattern(value: unknown): string {
  if (value === "triangle") return m["image_export.vector_by_walls.one_way_pattern_triangle"]();
  if (value === "chevron") return m["image_export.vector_by_walls.one_way_pattern_chevron"]();
  if (value === "arrow") return m["image_export.vector_by_walls.one_way_pattern_arrow"]();
  return String(value);
}

function formatOpeningMode(value: unknown): string {
  if (value === "none") return m["image_export.vector_by_walls.opening_mode_none"]();
  if (value === "opening") return m["image_export.vector_by_walls.opening_mode_opening"]();
  if (value === "pointer") return m["image_export.vector_by_walls.opening_mode_pointer"]();
  if (value === "both") return m["image_export.vector_by_walls.opening_mode_both"]();
  return String(value);
}

function formatLineStyle(value: unknown): string {
  if (value === "dashed") return m["image_export.glue_tabs.line_style_dashed"]();
  if (value === "solid") return m["image_export.glue_tabs.line_style_solid"]();
  return String(value);
}

/** A stored `LabelFont` is an object, so a link compares it by family and weight; any other value (a
 *  corrupt entry) is never equal. */
function labelFontEqualsUnknown(a: unknown, b: unknown): boolean {
  return isLabelFont(a) && isLabelFont(b) && labelFontEquals(a, b);
}

function isLabelFont(value: unknown): value is LabelFont {
  return typeof value === "object" && value !== null && typeof (value as LabelFont).family === "string" && typeof (value as LabelFont).weight === "number";
}

function formatLabelFontValue(value: unknown): string {
  return isLabelFont(value) ? formatLabelFont(value) : String(value);
}

function formatElevatorBadgesLabelType(value: unknown): string {
  if (value === "arabic") return m["image_export.vector_by_walls.elevator_badges_label_type_arabic"]();
  if (value === "roman") return m["image_export.vector_by_walls.elevator_badges_label_type_roman"]();
  if (value === "letters") return m["image_export.vector_by_walls.elevator_badges_label_type_letters"]();
  return String(value);
}

function formatMarkerIndexLabelStyle(value: unknown): string {
  if (value === "arabic") return m["image_export.vector_by_walls.marker_index_label_style_arabic"]();
  if (value === "roman") return m["image_export.vector_by_walls.marker_index_label_style_roman"]();
  if (value === "letters") return m["image_export.vector_by_walls.marker_index_label_style_letters"]();
  return String(value);
}

function formatBoolean(value: unknown): string {
  return value ? m["image_export.param_links.boolean_on"]() : m["image_export.param_links.boolean_off"]();
}


const FORMAT_BY_TYPE: Record<ParamType, (value: unknown) => string> = {
  labelFont: formatLabelFontValue,
  cornerStyle: formatCornerStyle,
  markerShape: formatMarkerShape,
  verticalArrowStyle: formatVerticalArrowStyle,
  teleportCurveDirection: formatTeleportCurveDirection,
  indexLabelStyle: formatElevatorBadgesLabelType,
  elevatorBadgeBacking: (value) => value === "shared" ? m["image_export.vector_by_walls.elevator_badges_backing_shared"]() : m["image_export.vector_by_walls.elevator_badges_backing_individual"](),
  lineStyle: formatLineStyle,
  oneWayPattern: formatOneWayPattern,
  openingMode: formatOpeningMode,
  number: formatNumber,
  color: formatColor,
  boolean: formatBoolean,
};

/** Value equality per parameter type; every type absent here is a primitive and compares with `Object.is`. */
const EQUALS_BY_TYPE: Partial<Record<ParamType, (a: unknown, b: unknown) => boolean>> = {
  labelFont: labelFontEqualsUnknown,
};

const FORMAT_OVERRIDES = {
  markerIndexLabelStyle: formatMarkerIndexLabelStyle,
} as const;

/** `label`/`group` are getters resolved in the current paraglide locale on every read (GitHub issue
 *  #742): the registries are module-level constants, so resolving the messages eagerly would freeze
 *  them in the startup locale. */
function descriptorOf(def: LinkFieldDef, mode: LinkMode): ParamDescriptor {
  return {
    type: def.type,
    equals: EQUALS_BY_TYPE[def.type] ?? Object.is,
    get label() {
      return def.label(mode);
    },
    get group() {
      return def.group(mode);
    },
    format: def.format ? FORMAT_OVERRIDES[def.format] : FORMAT_BY_TYPE[def.type],
  };
}

function registryFor<P extends string>(mode: LinkMode): Record<P, ParamDescriptor> {
  return Object.fromEntries(schemaEntriesFor(mode).map(([path, def]) => [path, descriptorOf(def, mode)])) as Record<P, ParamDescriptor>;
}

/** "Vector by walls" mode's linkable parameter registry (GitHub issue #643) — one entry per schema
 *  field declared for that mode. Path spelling mirrors `VectorByWallsSettings`'s own field/sub-object
 *  structure so `getParamValue`/`setParamValue` (`parameterLinksEngine.ts`) can address it directly.
 *  Nothing marks the "Shared style" source values as sources structurally, only that
 *  `DEFAULT_VECTOR_BY_WALLS_LINKS` has no link whose `target` is one of them. */
export const VECTOR_BY_WALLS_PARAM_REGISTRY = registryFor<WallsLinkPath>("walls");

export type VectorByWallsParamPath = WallsLinkPath;

/** Same role as `VECTOR_BY_WALLS_PARAM_REGISTRY`, for "Vector by corridors". */
export const VECTOR_BY_CORRIDORS_PARAM_REGISTRY = registryFor<CorridorsLinkPath>("corridors");

export type VectorByCorridorsParamPath = CorridorsLinkPath;

