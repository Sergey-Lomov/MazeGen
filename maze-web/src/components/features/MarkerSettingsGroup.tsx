import type React from "react";
import type { MarkerSettings } from "../../store/storeTypes";
import type { MarkerShape } from "../../pixi/renderers/types";
import { spacing, typography } from "../../styles/theme";
import { ColorRow } from "../ColorRow";
import { SelectRow } from "../SelectRow";
import { SliderRow } from "../SliderRow";
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

/** One "Start"/"Finish" sub-group of a "Waypoints" section — plain-weight label (not a
 *  `SectionHeader`, always visible, no collapse) indented under the section header, per GitHub
 *  issue #296. Shape, corner style, size, fill color, border color, border width and gap width;
 *  `borderWidth: 0` draws no border and `gapWidth: 0` draws no gap, so there is no separate
 *  show-border/show-gap toggle for either. Shared by `VectorByWallsSettingsPanel` and
 *  `VectorByCorridorsSettingsPanel` (GitHub issue #311) — both modes' waypoint settings mirror
 *  each other exactly, only the underlying store setters differ. */
export function MarkerSettingsGroup({ title, settings, onChange }: {
  title: string;
  settings: MarkerSettings;
  onChange: (patch: Partial<MarkerSettings>) => void;
}) {
  return (
    <div style={styles.markerGroupWrap}>
      <div style={typography.body}>{title}</div>
      <div style={styles.markerGroup}>
        <SelectRow
          label={m["image_export.vector_by_walls.marker_shape"]()}
          value={settings.shape}
          options={MARKER_SHAPE_OPTIONS.map((o) => ({ value: o.value, label: o.label() }))}
          onChange={(shape) => onChange({ shape })}
        />
        <SelectRow
          label={m["image_export.vector_by_walls.marker_corner_style"]()}
          value={settings.cornerStyle}
          options={[
            { value: "sharp", label: m["image_export.vector_by_walls.teleport_corner_style_sharp"]() },
            { value: "round", label: m["image_export.vector_by_walls.teleport_corner_style_round"]() },
          ]}
          onChange={(cornerStyle) => onChange({ cornerStyle })}
        />
        <SliderRow
          label={m["image_export.vector_by_walls.marker_size"]()}
          value={settings.size}
          onChange={(size) => onChange({ size })}
          min={0}
          max={1}
          step={0.01}
          format={(v) => v.toFixed(2)}
        />
        <ColorRow label={m["image_export.vector_by_walls.marker_fill_color"]()} color={settings.fillColor} onChange={(fillColor) => onChange({ fillColor })} />
        <ColorRow label={m["image_export.vector_by_walls.marker_border_color"]()} color={settings.borderColor} onChange={(borderColor) => onChange({ borderColor })} />
        <SliderRow
          label={m["image_export.vector_by_walls.marker_border_width"]()}
          value={settings.borderWidth}
          onChange={(borderWidth) => onChange({ borderWidth })}
          min={0}
          max={10}
          step={1}
          format={(v) => String(v)}
        />
        <SliderRow
          label={m["image_export.vector_by_walls.marker_gap_width"]()}
          value={settings.gapWidth}
          onChange={(gapWidth) => onChange({ gapWidth })}
          min={0}
          max={10}
          step={1}
          format={(v) => String(v)}
        />
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  markerGroupWrap: { display: "flex", flexDirection: "column", gap: spacing.itemGap },
  markerGroup: { display: "flex", flexDirection: "column", gap: spacing.itemGap, paddingLeft: spacing.sectionGap },
};
