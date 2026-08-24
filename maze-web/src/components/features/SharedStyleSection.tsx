import type React from "react";
import { spacing } from "../../styles/theme";
import { buttonStyle } from "../../styles/shared";
import { SelectRow } from "../SelectRow";
import { SliderRow } from "../SliderRow";
import { OverrideResetButton } from "../OverrideResetButton";
import type { TeleportCornerStyle } from "../../pixi/renderers/types";
import * as m from "~/paraglide/messages";

/** Which dependent-field groups a "Shared style" section drives — both render modes' `overrides`
 *  records share this shape (`Partial<Record<group, Partial<Record<field, true>>>>`), see
 *  `VectorByWallsSharedStyleOverrides`/`VectorByCorridorsSharedStyleOverrides` (`storeTypes.ts`). */
type SharedStyleGroup = "cornerStyle" | "markerSize" | "markerBorderWidth" | "gapWidth";
type SharedStyleOverrides = Partial<Record<SharedStyleGroup, Partial<Record<string, true>>>>;

/** The "Shared style" section (GitHub issue #322) — one collapsible section, always first, shared
 *  by `VectorByWallsSettingsPanel`/`VectorByCorridorsSettingsPanel` (only the underlying store
 *  setters differ, same per-mode-setters-only-differ reuse convention as `MarkerSettingsGroup`/
 *  `TeleportSettingsSection`). Four rows (corner style, marker size, marker border, gap) each set
 *  a shared value that every non-overridden dependent field across the panel follows; "Synchronize"
 *  clears every override (snapping every dependent field back to the shared value), "Reset all
 *  settings" restores the whole render mode's settings object. Per-field reset buttons live on the
 *  *dependent* field's own row elsewhere in the panel (e.g. the "Waypoints" section's marker size
 *  slider), not here — this section only owns the four shared values themselves. */
export function SharedStyleSection({
  cornerStyle,
  markerSize,
  markerBorderWidth,
  gapWidth,
  onCornerStyleChange,
  onMarkerSizeChange,
  onMarkerBorderWidthChange,
  onGapWidthChange,
  onForce,
  onResetAll,
}: {
  cornerStyle: TeleportCornerStyle;
  markerSize: number;
  markerBorderWidth: number;
  gapWidth: number;
  onCornerStyleChange: (v: TeleportCornerStyle) => void;
  onMarkerSizeChange: (v: number) => void;
  onMarkerBorderWidthChange: (v: number) => void;
  onGapWidthChange: (v: number) => void;
  onForce: () => void;
  onResetAll: () => void;
}) {
  return (
    <div style={styles.block}>
      <SelectRow
        label={m["image_export.vector_by_walls.shared_style_corner_style"]()}
        value={cornerStyle}
        options={[
          { value: "sharp" as TeleportCornerStyle, label: m["image_export.vector_by_walls.corner_style_sharp"]() },
          { value: "round" as TeleportCornerStyle, label: m["image_export.vector_by_walls.corner_style_round"]() },
        ]}
        onChange={onCornerStyleChange}
      />
      <SliderRow
        label={m["image_export.vector_by_walls.shared_style_marker_size"]()}
        value={markerSize}
        onChange={onMarkerSizeChange}
        min={0}
        max={1}
        step={0.01}
        format={(v) => v.toFixed(2)}
      />
      <SliderRow
        label={m["image_export.vector_by_walls.shared_style_marker_border_width"]()}
        value={markerBorderWidth}
        onChange={onMarkerBorderWidthChange}
        min={0}
        max={10}
        step={1}
        format={(v) => String(v)}
      />
      <SliderRow
        label={m["image_export.vector_by_walls.shared_style_gap_width"]()}
        value={gapWidth}
        onChange={onGapWidthChange}
        min={0}
        max={10}
        step={1}
        format={(v) => String(v)}
      />
      <button type="button" className="hoverable" style={buttonStyle("toggle")} onClick={onForce}>
        {m["image_export.vector_by_walls.shared_style_force"]()}
      </button>
      <button type="button" className="hoverable" style={buttonStyle("destructive")} onClick={onResetAll}>
        {m["image_export.vector_by_walls.shared_style_reset_all"]()}
      </button>
    </div>
  );
}

/** Per-field reset button for a dependent field driven by a `SharedStyleSection` group — the
 *  settings panel's own field rows pass this as `SliderRow`/`SelectRow`'s `resetButton` prop. */
export function sharedStyleFieldReset(overrides: SharedStyleOverrides, group: SharedStyleGroup, field: string, onReset: () => void) {
  const overridden = overrides[group]?.[field] === true;
  return <OverrideResetButton overridden={overridden} onReset={onReset} title={m["image_export.vector_by_walls.shared_style_field_reset"]()} />;
}

const styles: Record<string, React.CSSProperties> = {
  block: { display: "flex", flexDirection: "column", gap: spacing.itemGap },
};
