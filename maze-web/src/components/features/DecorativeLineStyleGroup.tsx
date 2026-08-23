import type * as React from "react";
import type { DecorativeLineStyle } from "../../store/storeTypes";
import { spacing } from "../../styles/theme";
import { ColorRow } from "../ColorRow";
import { SliderRow } from "../SliderRow";
import * as m from "~/paraglide/messages";

/** One decorative-style vertical-connection pictogram's line settings (GitHub issue #428) — line
 *  color, line width and icon size, the "decorative" style's own settings surface in place of
 *  `MarkerSettingsGroup`'s fill/border/gap/shape fields (a stroke-only stairs/elevator icon has none
 *  of those). Shared by all three "decorative" sub-sections (`decorativeStairsTwoWay`/
 *  `decorativeStairsOneWay`/`decorativeElevator`) in `VectorByWallsSettingsPanel`. */
export function DecorativeLineStyleGroup({ settings, onChange }: {
  settings: DecorativeLineStyle;
  onChange: (patch: Partial<DecorativeLineStyle>) => void;
}) {
  return (
    <div style={styles.wrap}>
      <ColorRow label={m["image_export.vector_by_walls.decorative_line_color"]()} color={settings.lineColor} onChange={(lineColor) => onChange({ lineColor })} />
      <SliderRow
        label={m["image_export.vector_by_walls.decorative_line_width"]()}
        value={settings.lineWidth}
        onChange={(lineWidth) => onChange({ lineWidth })}
        min={1}
        max={10}
        step={1}
        format={(v) => String(v)}
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
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: { display: "flex", flexDirection: "column", gap: spacing.itemGap },
};
