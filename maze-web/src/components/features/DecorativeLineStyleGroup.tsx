import type * as React from "react";
import type { ColorField } from "../../pixi/selectors/projectColorsSelector";
import type { DecorativeLineStyle } from "../../store/storeTypes";
import type { ProjectColorEntry } from "../../pixi/selectors/projectColorsSelector";
import { spacing } from "../../styles/theme";
import { LinkedColorRow, LinkedSliderRow } from "./LinkedRows";
import { TILE_SIZE } from "../../pixi/constants";
import * as m from "~/paraglide/messages";

/** One decorative-style vertical-connection pictogram's line settings (GitHub issue #428) — line
 *  color, line width and icon size, the "decorative" style's own settings surface in place of
 *  `MarkerSettingsGroup`'s fill/border/gap/shape fields (a stroke-only stairs/elevator icon has none
 *  of those). Shared by all three "decorative" sub-sections (`decorativeStairsTwoWay`/
 *  `decorativeStairsOneWay`/`decorativeElevator`) in `VectorByWallsSettingsPanel`. */
export function DecorativeLineStyleGroup<P extends string>({ settings, onChange, linkTargets, lineColorPriority, lineColorDefault, lineColorField }: {
  settings: DecorativeLineStyle;
  onChange: (patch: Partial<DecorativeLineStyle>) => void;
  /** Per-field link paths (GitHub issue #652 follow-up) for this group's `Linked*Row`s. */
  linkTargets: { lineColor: P | null; lineWidth: P | null; size: P | null };
  /** "Priority" project colors (GitHub issue #503) for the line-color row. */
  lineColorPriority?: ProjectColorEntry[];
  /** Factory default (GitHub issue #503) — pinned as the line-color row's first "Default" color. */
  lineColorDefault?: number;
  /** Composite field name (GitHub issue #503) — the row's "Line color" label repeats across the
   *  three decorative sub-groups, so an explicit name isolates the right list row. */
  lineColorField: ColorField;
}) {
  return (
    <div style={styles.wrap}>
      <LinkedColorRow label={m["image_export.vector_by_walls.decorative_line_color"]()} color={settings.lineColor} onChange={(lineColor) => onChange({ lineColor })} priorityColors={lineColorPriority} defaultColor={lineColorDefault} field={lineColorField} linkTarget={linkTargets.lineColor} />
      <LinkedSliderRow
        label={m["image_export.vector_by_walls.decorative_line_width"]()}
        value={settings.lineWidth}
        onChange={(lineWidth) => onChange({ lineWidth })}
        min={1}
        max={10}
        step={1}
        format={(v) => String(v)}
        linkTarget={linkTargets.lineWidth}
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
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: { display: "flex", flexDirection: "column", gap: spacing.itemGap },
};
