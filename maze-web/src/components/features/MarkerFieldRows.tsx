import type * as React from "react";
import type { ColorField } from "../../pixi/selectors/projectColorsSelector";
import type { MarkerAppearance, SizeAdaptationField, TextStyleFields } from "../../store/storeTypes";
import type { MarkerShape } from "../../pixi/renderers/types";
import type { ProjectColorEntry } from "../../pixi/selectors/projectColorsSelector";
import { LinkedSelectRow, LinkedSliderRow, LinkedColorRow } from "./LinkedRows";
import { TILE_SIZE } from "../../pixi/constants";
import { TEXT_SIZE_RANGE, TEXT_MARGIN_RANGE } from "../../pixi/renderConstants";
import type { TextFitKind } from "../../pixi/selectors/exportWarnings";
import { AutoFitButton } from "./TextFitContext";
import { SizeAdaptationRow } from "./SizeAdaptationRow";
import * as m from "~/paraglide/messages";

/** Shared shape option list (GitHub issue #293 follow-up unified `MarkerShape` for both start/
 *  finish waypoints and both teleport patterns) — used by `MarkerAppearanceRows` and every other
 *  marker-shape picker. */
export const MARKER_SHAPE_OPTIONS: { value: MarkerShape; label: () => string }[] = [
  { value: "circle", label: m["image_export.vector_by_walls.marker_shape_circle"] },
  { value: "triangle", label: m["image_export.vector_by_walls.marker_shape_triangle"] },
  { value: "square", label: m["image_export.vector_by_walls.marker_shape_square"] },
  { value: "diamond", label: m["image_export.vector_by_walls.marker_shape_diamond"] },
  { value: "pentagon", label: m["image_export.vector_by_walls.marker_shape_pentagon"] },
  { value: "star", label: m["image_export.vector_by_walls.marker_shape_star"] },
  { value: "hexagon", label: m["image_export.vector_by_walls.marker_shape_hexagon"] },
  { value: "cross", label: m["image_export.vector_by_walls.marker_shape_cross"] },
];

/** `MARKER_SHAPE_OPTIONS` with labels resolved — the shape `Linked*Row`s all need, since
 *  `LinkedSelectRow`'s `options` takes string labels, not label factories. */
export function markerShapeSelectOptions(): { value: MarkerShape; label: string }[] {
  return MARKER_SHAPE_OPTIONS.map((o) => ({ value: o.value, label: o.label() }));
}

/** Shared "Marker" field rows (GitHub issue #701) — the seven `MarkerAppearance` fields (shape,
 *  corner style, size, fill color, border color, border width, gap width) rendered the same way for
 *  every marker-like consumer: start/finish markers, vertical-connection markers, the teleport edge
 *  marker, and the elevator / teleport floor-number badges. Renders bare rows (no wrapper) so each
 *  caller places them inside its own group. `linkTargets` is a concrete path per field the caller's
 *  registry models, `null` otherwise. */
export function MarkerAppearanceRows<P extends string>({ settings, onChange, linkTargets, priorityColors, defaultColors, fields, colorsDisabledHint }: {
  settings: MarkerAppearance & Partial<SizeAdaptationField>;
  onChange: (patch: Partial<MarkerAppearance & SizeAdaptationField>) => void;
  /** `sizeAdaptation` (GitHub issue #819) is opt-in: the "Size adaptation" row is rendered only by
   *  callers whose marker kind scales with its cell (omitted for the elevator floor badges). */
  linkTargets: { [K in keyof MarkerAppearance]: P | null } & { sizeAdaptation?: P | null };
  /** "Priority" project colors (GitHub issue #503) for the fill / border color rows. */
  priorityColors?: { fillColor?: ProjectColorEntry[]; borderColor?: ProjectColorEntry[] };
  /** Factory defaults (GitHub issue #503) — pinned as each color row's first "Default" project color. */
  defaultColors?: { fillColor?: number; borderColor?: number };
  /** Composite field names (GitHub issue #503) — isolate the row in the "Project colors" list. */
  fields: { fillColor: ColorField; borderColor: ColorField };
  /** When set, the fill and border color rows are disabled and show this tooltip (their values are
   *  overridden elsewhere, e.g. by the teleport group customization). */
  colorsDisabledHint?: string;
}): React.ReactElement {
  return (
    <>
      <LinkedSelectRow
        label={m["image_export.vector_by_walls.marker_shape"]()}
        value={settings.shape}
        options={markerShapeSelectOptions()}
        onChange={(shape) => onChange({ shape })}
        linkTarget={linkTargets.shape}
      />
      <LinkedSelectRow
        label={m["image_export.vector_by_walls.marker_corner_style"]()}
        value={settings.cornerStyle}
        options={[
          { value: "miter", label: m["image_export.vector_by_walls.corner_style_sharp"]() },
          { value: "round", label: m["image_export.vector_by_walls.corner_style_round"]() },
        ]}
        onChange={(cornerStyle) => onChange({ cornerStyle })}
        linkTarget={linkTargets.cornerStyle}
      />
      <LinkedSliderRow
        label={m["image_export.vector_by_walls.marker_size"]()}
        value={settings.size}
        onChange={(size) => onChange({ size })}
        min={0.1 * TILE_SIZE}
        max={TILE_SIZE}
        step={1}
        format={(v) => String(Math.round(v))}
        linkTarget={linkTargets.size}
      />
      {linkTargets.sizeAdaptation !== undefined && (
        <SizeAdaptationRow value={settings.sizeAdaptation ?? 0} onChange={(sizeAdaptation) => onChange({ sizeAdaptation })} linkTarget={linkTargets.sizeAdaptation} />
      )}
      <LinkedColorRow label={m["image_export.vector_by_walls.marker_fill_color"]()} color={settings.fillColor} onChange={(fillColor) => onChange({ fillColor })} priorityColors={priorityColors?.fillColor} defaultColor={defaultColors?.fillColor} field={fields.fillColor} linkTarget={linkTargets.fillColor} disabled={colorsDisabledHint !== undefined} disabledHint={colorsDisabledHint} />
      <LinkedColorRow label={m["image_export.vector_by_walls.marker_border_color"]()} color={settings.borderColor} onChange={(borderColor) => onChange({ borderColor })} priorityColors={priorityColors?.borderColor} defaultColor={defaultColors?.borderColor} field={fields.borderColor} linkTarget={linkTargets.borderColor} disabled={colorsDisabledHint !== undefined} disabledHint={colorsDisabledHint} />
      <LinkedSliderRow
        label={m["image_export.vector_by_walls.marker_border_width"]()}
        value={settings.borderWidth}
        onChange={(borderWidth) => onChange({ borderWidth })}
        min={0}
        max={10}
        step={1}
        format={(v) => String(v)}
        linkTarget={linkTargets.borderWidth}
      />
      <LinkedSliderRow
        label={m["image_export.vector_by_walls.marker_gap_width"]()}
        value={settings.gapWidth}
        onChange={(gapWidth) => onChange({ gapWidth })}
        min={0}
        max={10}
        step={1}
        format={(v) => String(v)}
        linkTarget={linkTargets.gapWidth}
      />
    </>
  );
}

/** Shared text-style rows (GitHub issue #701) — font weight, absolute font size, margin and text color
 *  (`TextStyleFields`, px within `TEXT_SIZE_RANGE`) for every label-bearing consumer: start/finish
 *  captions, elevator badges and teleport floor badges. Horizontal alignment stays centered for
 *  these consumers and is exposed separately only by `FloorLabelSection`. */
export function TextStyleRows<P extends string>({ settings, onChange, linkTargets, priorityColors, defaultColor, field, autoFitKind }: {
  settings: TextStyleFields;
  onChange: (patch: Partial<TextStyleFields>) => void;
  linkTargets: { [K in Exclude<keyof TextStyleFields, "textAlignment">]: P | null };
  priorityColors?: ProjectColorEntry[];
  defaultColor?: number;
  field: ColorField;
  /** Which label set the size row's "Auto-fit" button fits (GitHub issue #707); omitted = no button. */
  autoFitKind?: TextFitKind;
}): React.ReactElement {
  return (
    <>
      <LinkedSelectRow
        label={m["image_export.vector_by_walls.marker_text_font_weight"]()}
        value={settings.textFontWeight}
        options={[
          { value: "regular", label: m["image_export.vector_by_walls.elevator_badges_font_weight_regular"]() },
          { value: "bold", label: m["image_export.vector_by_walls.elevator_badges_font_weight_bold"]() },
        ]}
        onChange={(textFontWeight) => onChange({ textFontWeight })}
        linkTarget={linkTargets.textFontWeight}
      />
      <LinkedSliderRow
        label={m["image_export.vector_by_walls.marker_text_size"]()}
        value={settings.textSize}
        onChange={(textSize) => onChange({ textSize })}
        min={TEXT_SIZE_RANGE.min}
        max={TEXT_SIZE_RANGE.max}
        step={TEXT_SIZE_RANGE.step}
        format={(v) => String(Math.round(v * 10) / 10)}
        linkTarget={linkTargets.textSize}
        trailingAction={autoFitKind && <AutoFitButton resolve={(ctx) => ctx.fitFor(autoFitKind)} onApply={(textSize) => onChange({ textSize })} />}
      />
      <LinkedSliderRow
        label={m["image_export.vector_by_walls.marker_text_margin"]()}
        value={settings.textMargin}
        onChange={(textMargin) => onChange({ textMargin })}
        min={TEXT_MARGIN_RANGE.min}
        max={TEXT_MARGIN_RANGE.max}
        step={TEXT_MARGIN_RANGE.step}
        format={(v) => String(v)}
        linkTarget={linkTargets.textMargin}
      />
      <LinkedColorRow
        label={m["image_export.vector_by_walls.marker_text_color"]()}
        color={settings.textColor}
        onChange={(textColor) => onChange({ textColor })}
        priorityColors={priorityColors}
        defaultColor={defaultColor}
        field={field}
        linkTarget={linkTargets.textColor}
      />
    </>
  );
}
