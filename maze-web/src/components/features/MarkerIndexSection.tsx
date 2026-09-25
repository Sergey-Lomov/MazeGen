import type * as React from "react";
import type { MarkerIndexSettings } from "../../store/storeTypes";
import type { ProjectColorEntry } from "../../pixi/selectors/projectColorsSelector";
import { spacing, typography } from "../../styles/theme";
import { ToggleRow } from "../ToggleRow";
import { ColorRow } from "../ColorRow";
import { SelectRow } from "../SelectRow";
import { SliderRow } from "../SliderRow";
import * as m from "~/paraglide/messages";

/** "Marker indices" section body (GitHub issue #471) — a self-contained collapsible section,
 *  last in both vector export panels, not wired to "Shared style". Links the two endpoints of
 *  every cross-floor connection (stairs / elevator / teleport) with a shared index on a framed
 *  plate under the marker.
 *
 *  Only the master "Show marker indices" toggle sits at the section's top level. Everything else
 *  is nested one indent deep: a "Coverage" sub-group of per-connection-kind toggles, then a
 *  "Settings" sub-group with the plate's appearance. All geometric fields are fractions of
 *  `TILE_SIZE` except `borderWidth` / `gap` (whole pixels). */
export function MarkerIndexSection({ settings, onChange, gapResetButton, fillColorPriority, textColorPriority, borderColorPriority, fillColorDefault, textColorDefault, borderColorDefault, fillColorFieldName, textColorFieldName, borderColorFieldName }: {
  settings: MarkerIndexSettings;
  onChange: (patch: Partial<MarkerIndexSettings>) => void;
  /** "Shared style" `gapWidth`-group per-field reset for `gap` (the one shared-linked field). */
  gapResetButton?: React.ReactNode;
  /** "Priority" project colors (GitHub issue #503) for the plate fill / text / border color rows. */
  fillColorPriority?: ProjectColorEntry[];
  textColorPriority?: ProjectColorEntry[];
  borderColorPriority?: ProjectColorEntry[];
  /** Factory defaults (GitHub issue #503) — pinned as each row's first "Default" project color. */
  fillColorDefault?: number;
  textColorDefault?: number;
  borderColorDefault?: number;
  /** "Project colors" list names (GitHub issue #503) for the plate fill / text / border color rows —
   *  shown in the picker header and used to drop the row itself from the list. Built by the caller
   *  from the shared `PC` registry so they match `selectActiveProfileColors`. */
  fillColorFieldName?: string;
  textColorFieldName?: string;
  borderColorFieldName?: string;
}) {
  const cov = settings.coverage;
  const setCoverage = (patch: Partial<MarkerIndexSettings["coverage"]>) =>
    onChange({ coverage: { ...cov, ...patch } });

  return (
    <div style={styles.block}>
      <ToggleRow
        label={m["image_export.vector_by_walls.marker_index_enabled"]()}
        checked={settings.enabled}
        onChange={(enabled) => onChange({ enabled })}
      />
      {settings.enabled && (
        <>
          <div style={styles.subGroupWrap}>
            <div style={styles.subHeader}>{m["image_export.vector_by_walls.marker_index_subsection_coverage"]()}</div>
            <div style={styles.subGroup}>
              <ToggleRow
                label={m["image_export.vector_by_walls.marker_index_coverage_single_floor_teleport"]()}
                checked={cov.singleFloorTeleport}
                onChange={(singleFloorTeleport) => setCoverage({ singleFloorTeleport })}
              />
              <ToggleRow
                label={m["image_export.vector_by_walls.marker_index_coverage_cross_floor_teleport"]()}
                checked={cov.crossFloorTeleport}
                onChange={(crossFloorTeleport) => setCoverage({ crossFloorTeleport })}
              />
              <ToggleRow
                label={m["image_export.vector_by_walls.marker_index_coverage_vertical_passage"]()}
                checked={cov.verticalPassage}
                onChange={(verticalPassage) => setCoverage({ verticalPassage })}
              />
              <ToggleRow
                label={m["image_export.vector_by_walls.marker_index_coverage_elevator"]()}
                checked={cov.elevator}
                onChange={(elevator) => setCoverage({ elevator })}
              />
            </div>
          </div>

          <div style={styles.subGroupWrap}>
            <div style={styles.subHeader}>{m["image_export.vector_by_walls.marker_index_subsection_settings"]()}</div>
            <div style={styles.subGroup}>
              <SelectRow
                label={m["image_export.vector_by_walls.marker_index_label_style"]()}
                value={settings.labelStyle}
                options={[
                  { value: "arabic", label: m["image_export.vector_by_walls.marker_index_label_style_arabic"]() },
                  { value: "roman", label: m["image_export.vector_by_walls.marker_index_label_style_roman"]() },
                  { value: "letters", label: m["image_export.vector_by_walls.marker_index_label_style_letters"]() },
                ]}
                onChange={(labelStyle) => onChange({ labelStyle })}
              />
              <SelectRow
                label={m["image_export.vector_by_walls.marker_index_font_weight"]()}
                value={settings.fontWeight}
                options={[
                  { value: "regular", label: m["image_export.vector_by_walls.marker_index_font_weight_regular"]() },
                  { value: "bold", label: m["image_export.vector_by_walls.marker_index_font_weight_bold"]() },
                ]}
                onChange={(fontWeight) => onChange({ fontWeight })}
              />
              <SliderRow
                label={m["image_export.vector_by_walls.marker_index_padding_x"]()}
                value={settings.paddingX}
                onChange={(paddingX) => onChange({ paddingX })}
                min={0} max={0.2} step={0.01}
                format={(v) => v.toFixed(2)}
              />
              <SliderRow
                label={m["image_export.vector_by_walls.marker_index_height"]()}
                value={settings.height}
                onChange={(height) => onChange({ height })}
                min={0.05} max={0.5} step={0.01}
                format={(v) => v.toFixed(2)}
              />
              <SliderRow
                label={m["image_export.vector_by_walls.marker_index_offset"]()}
                value={settings.offset}
                onChange={(offset) => onChange({ offset })}
                min={0} max={0.3} step={0.01}
                format={(v) => v.toFixed(2)}
              />
              <SliderRow
                label={m["image_export.vector_by_walls.marker_index_corner_radius"]()}
                value={settings.cornerRadius}
                onChange={(cornerRadius) => onChange({ cornerRadius })}
                min={0} max={0.25} step={0.01}
                format={(v) => v.toFixed(2)}
              />
              <SliderRow
                label={m["image_export.vector_by_walls.marker_index_gap"]()}
                value={settings.gap}
                onChange={(gap) => onChange({ gap: Math.round(gap) })}
                min={0} max={10} step={1}
                format={(v) => String(Math.round(v))}
                resetButton={gapResetButton}
              />
              <ToggleRow
                label={m["image_export.vector_by_walls.marker_index_border_width_from_marker"]()}
                checked={settings.borderWidthFromMarker}
                onChange={(borderWidthFromMarker) => onChange({ borderWidthFromMarker })}
              />
              <SliderRow
                label={m["image_export.vector_by_walls.marker_index_border_width"]()}
                value={settings.borderWidth}
                onChange={(borderWidth) => onChange({ borderWidth: Math.round(borderWidth) })}
                min={0} max={10} step={1}
                format={(v) => String(Math.round(v))}
                disabled={settings.borderWidthFromMarker}
              />
              <ColorRow
                label={m["image_export.vector_by_walls.marker_index_fill_color"]()}
                color={settings.fillColor}
                onChange={(fillColor) => onChange({ fillColor })}
                priorityColors={fillColorPriority}
                defaultColor={fillColorDefault}
                fieldName={fillColorFieldName}
              />
              <ColorRow
                label={m["image_export.vector_by_walls.marker_index_text_color"]()}
                color={settings.textColor}
                onChange={(textColor) => onChange({ textColor })}
                priorityColors={textColorPriority}
                defaultColor={textColorDefault}
                fieldName={textColorFieldName}
              />
              <ToggleRow
                label={m["image_export.vector_by_walls.marker_index_border_color_from_marker"]()}
                checked={settings.borderColorFromMarker}
                onChange={(borderColorFromMarker) => onChange({ borderColorFromMarker })}
              />
              <ColorRow
                label={m["image_export.vector_by_walls.marker_index_border_color"]()}
                color={settings.borderColor}
                onChange={(borderColor) => onChange({ borderColor })}
                disabled={settings.borderColorFromMarker}
                priorityColors={borderColorPriority}
                defaultColor={borderColorDefault}
                fieldName={borderColorFieldName}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  block: { display: "flex", flexDirection: "column", gap: spacing.itemGap },
  subGroupWrap: { display: "flex", flexDirection: "column", gap: spacing.itemGap },
  subHeader: { ...typography.body },
  subGroup: { display: "flex", flexDirection: "column", gap: spacing.itemGap, paddingLeft: spacing.sectionGap },
};
