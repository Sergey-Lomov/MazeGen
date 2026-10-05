import type * as React from "react";
import type { MarkerSettings } from "../../store/storeTypes";
import type { MarkerShape } from "../../pixi/renderers/types";
import type { ProjectColorEntry } from "../../pixi/selectors/projectColorsSelector";
import { indent, spacing, typography } from "../../styles/theme";
import { LinkedSelectRow, LinkedSliderRow, LinkedColorRow } from "./LinkedRows";
import * as m from "~/paraglide/messages";

/** Shared shape option list (GitHub issue #293 follow-up unified `MarkerShape` for both start/
 *  finish waypoints and both teleport patterns) — used by `MarkerSettingsGroup` and both
 *  Teleports-section shape pickers (`VectorByWallsSettingsPanel`). */
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

/** One "Start"/"Finish" sub-group of a "Waypoints" section — plain-weight label (not a
 *  `SectionHeader`, always visible, no collapse) indented under the section header, per GitHub
 *  issue #296. Shape, corner style, size, fill color, border color, border width and gap width;
 *  `borderWidth: 0` draws no border and `gapWidth: 0` draws no gap, so there is no separate
 *  show-border/show-gap toggle for either. Shared by `VectorByWallsSettingsPanel` and
 *  `VectorByCorridorsSettingsPanel` (GitHub issue #311) — both modes' waypoint settings mirror
 *  each other exactly, only the underlying store setters differ. */
export function MarkerSettingsGroup<P extends string>({ title, settings, onChange, linkTargets, hideBorderColor, priorityColors, defaultColors, fieldNames }: {
  title: string;
  settings: MarkerSettings;
  onChange: (patch: Partial<MarkerSettings>) => void;
  /** "Priority" project colors (GitHub issue #503) for this group's fill/border color rows —
   *  forwarded to the picker's "Project colors" section. Omitted fields render with no priority. */
  priorityColors?: { fillColor?: ProjectColorEntry[]; borderColor?: ProjectColorEntry[] };
  /** Factory defaults (GitHub issue #503) for the fill/border color rows — the picker pins each as
   *  the first "Default" row of its priority group. */
  defaultColors?: { fillColor?: number; borderColor?: number };
  /** Composite field names (GitHub issue #503) for the fill/border color rows — shown in the
   *  picker header and used to drop the row itself from the "Project colors" list. Needed here
   *  because two marker groups (start / finish) share the generic "Fill color" row label. */
  fieldNames?: { fillColor?: string; borderColor?: string };
  /** Per-field link path for this group's `Linked*Row`s (GitHub issue #652 follow-up) — a concrete
   *  path for every field the caller's registry models (currently all seven: `shape`/`cornerStyle`/
   *  `size`/`fillColor`/`borderColor`/`borderWidth`/`gapWidth`), or `null` for one it doesn't,
   *  rendering `LinkStatusIcon`'s "unsupported" state there instead of omitting the icon — every
   *  field row gets one either way. */
  linkTargets: { shape: P | null; cornerStyle: P | null; size: P | null; fillColor: P | null; borderColor: P | null; borderWidth: P | null; gapWidth: P | null };
  /** Hides the "Border color" row (GitHub issue #347 fourth follow-up) — a one-way passage marker's
   *  own `borderColor` field is no longer read by the renderer (its border/fill colors are driven
   *  entirely by `oneWayAccentColor` instead, see `VerticalConnectionRenderer`), so showing it here
   *  would be a dead control. */
  hideBorderColor?: boolean;
}) {
  return (
    <div style={styles.markerGroupWrap}>
      {title && <div style={typography.body}>{title}</div>}
      <div style={title ? styles.markerGroup : styles.markerGroupNoIndent}>
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
          min={0}
          max={1}
          step={0.01}
          format={(v) => v.toFixed(2)}
          linkTarget={linkTargets.size}
        />
        <LinkedColorRow label={m["image_export.vector_by_walls.marker_fill_color"]()} color={settings.fillColor} onChange={(fillColor) => onChange({ fillColor })} priorityColors={priorityColors?.fillColor} defaultColor={defaultColors?.fillColor} fieldName={fieldNames?.fillColor} linkTarget={linkTargets.fillColor} />
        {!hideBorderColor && (
          <LinkedColorRow label={m["image_export.vector_by_walls.marker_border_color"]()} color={settings.borderColor} onChange={(borderColor) => onChange({ borderColor })} priorityColors={priorityColors?.borderColor} defaultColor={defaultColors?.borderColor} fieldName={fieldNames?.borderColor} linkTarget={linkTargets.borderColor} />
        )}
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
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  markerGroupWrap: { display: "flex", flexDirection: "column", gap: spacing.itemGap },
  markerGroup: { display: "flex", flexDirection: "column", gap: spacing.itemGap, paddingLeft: indent.tree },
  markerGroupNoIndent: { display: "flex", flexDirection: "column", gap: spacing.itemGap },
};
