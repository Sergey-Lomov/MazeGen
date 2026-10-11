import type * as React from "react";
import type { ColorField } from "../../pixi/selectors/projectColorsSelector";
import type { MarkerIndexSettings } from "../../store/storeTypes";
import type { ProjectColorEntry } from "../../pixi/selectors/projectColorsSelector";
import { indent, spacing } from "../../styles/theme";
import { SectionHeader } from "../SectionHeader";
import { LinkedToggleRow, LinkedColorRow, LinkedSelectRow, LinkedSliderRow } from "./LinkedRows";
import { TILE_SIZE } from "../../pixi/constants";
import { MARKER_INDEX_MIN_HEIGHT, MARKER_INDEX_WIDTH_RANGE } from "../../pixi/renderConstants";
import { TextStyleRows } from "./MarkerFieldRows";
import * as m from "~/paraglide/messages";

/** "Marker indices" section body (GitHub issue #471) — a self-contained collapsible section,
 *  last in both vector export panels, not wired to "Shared style". Links the two endpoints of
 *  every cross-floor connection (stairs / elevator / teleport) with a shared index on a framed
 *  plate under the marker.
 *
 *  Only the master "Show marker indices" toggle sits at the section's top level. Everything else
 *  is nested one indent deep in three collapsible sub-groups ("Coverage" per-connection-kind
 *  toggles, "Caption" text style, "Backplate" plate appearance). All geometric fields are in px
 *  (GitHub issue #681 — `height`/`offset`/`cornerRadius`/`paddingX` were previously fractions of `TILE_SIZE`). */
export function MarkerIndexSection<P extends string>({ settings, onChange, linkTargets, fillColorPriority, textColorPriority, borderColorPriority, fillColorDefault, textColorDefault, borderColorDefault, fillColorField, textColorField, borderColorField, isExpanded, onToggle }: {
  settings: MarkerIndexSettings;
  onChange: (patch: Partial<MarkerIndexSettings>) => void;
  /** Per-field link paths (GitHub issue #652 follow-up) for every `Linked*Row` in this section — a
   *  concrete path where the registry models the field, `null` where it doesn't (every field row
   *  gets an icon either way, see `LinkStatusIcon`'s doc comment). */
  linkTargets: {
    enabled: P | null;
    coverageSingleFloorTeleport: P | null;
    coverageCrossFloorTeleport: P | null;
    coverageVerticalPassage: P | null;
    coverageElevator: P | null;
    labelStyle: P | null;
    textFontWeight: P | null;
    width: P | null;
    textSize: P | null;
    textMargin: P | null;
    height: P | null;
    offset: P | null;
    cornerRadius: P | null;
    gap: P | null;
    borderWidthFromMarker: P | null;
    borderWidth: P | null;
    fillColor: P | null;
    textColor: P | null;
    borderColorFromMarker: P | null;
    borderColor: P | null;
  };
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
  fillColorField: ColorField;
  textColorField: ColorField;
  borderColorField: ColorField;
  /** Reads/toggles the caller's own generic sections-expanded record by id (same convention as
   *  `MarkerSettingsGroup`) — ids `marker_index_coverage`/`marker_index_caption`/
   *  `marker_index_backplate`. */
  isExpanded: (id: string) => boolean;
  onToggle: (id: string) => void;
}) {
  const cov = settings.coverage;
  const setCoverage = (patch: Partial<MarkerIndexSettings["coverage"]>) =>
    onChange({ coverage: { ...cov, ...patch } });

  return (
    <div style={styles.block}>
      <LinkedToggleRow
        label={m["image_export.vector_by_walls.marker_index_enabled"]()}
        checked={settings.enabled}
        onChange={(enabled) => onChange({ enabled })}
        linkTarget={linkTargets.enabled}
      />
      {settings.enabled && (
        <>
          <SubGroup id="marker_index_coverage" label={m["image_export.vector_by_walls.marker_index_subsection_coverage"]()} isExpanded={isExpanded} onToggle={onToggle}>
              <LinkedToggleRow
                label={m["image_export.vector_by_walls.marker_index_coverage_single_floor_teleport"]()}
                checked={cov.singleFloorTeleport}
                onChange={(singleFloorTeleport) => setCoverage({ singleFloorTeleport })}
                linkTarget={linkTargets.coverageSingleFloorTeleport}
              />
              <LinkedToggleRow
                label={m["image_export.vector_by_walls.marker_index_coverage_cross_floor_teleport"]()}
                checked={cov.crossFloorTeleport}
                onChange={(crossFloorTeleport) => setCoverage({ crossFloorTeleport })}
                linkTarget={linkTargets.coverageCrossFloorTeleport}
              />
              <LinkedToggleRow
                label={m["image_export.vector_by_walls.marker_index_coverage_vertical_passage"]()}
                checked={cov.verticalPassage}
                onChange={(verticalPassage) => setCoverage({ verticalPassage })}
                linkTarget={linkTargets.coverageVerticalPassage}
              />
              <LinkedToggleRow
                label={m["image_export.vector_by_walls.marker_index_coverage_elevator"]()}
                checked={cov.elevator}
                onChange={(elevator) => setCoverage({ elevator })}
                linkTarget={linkTargets.coverageElevator}
              />
          </SubGroup>

          <SubGroup id="marker_index_caption" label={m["image_export.vector_by_walls.marker_index_subsection_caption"]()} isExpanded={isExpanded} onToggle={onToggle}>
              <LinkedSelectRow
                label={m["image_export.vector_by_walls.marker_index_label_style"]()}
                value={settings.labelStyle}
                options={[
                  { value: "arabic", label: m["image_export.vector_by_walls.marker_index_label_style_arabic"]() },
                  { value: "roman", label: m["image_export.vector_by_walls.marker_index_label_style_roman"]() },
                  { value: "letters", label: m["image_export.vector_by_walls.marker_index_label_style_letters"]() },
                ]}
                onChange={(labelStyle) => onChange({ labelStyle })}
                linkTarget={linkTargets.labelStyle}
              />
              <TextStyleRows
                settings={settings}
                onChange={onChange}
                linkTargets={{ textFontWeight: linkTargets.textFontWeight, textSize: linkTargets.textSize, textMargin: linkTargets.textMargin, textColor: linkTargets.textColor }}
                priorityColors={textColorPriority}
                defaultColor={textColorDefault}
                field={textColorField}
                autoFitKind="markerIndex"
              />
          </SubGroup>

          <SubGroup id="marker_index_backplate" label={m["image_export.vector_by_walls.marker_index_subsection_backplate"]()} isExpanded={isExpanded} onToggle={onToggle}>
              <LinkedSliderRow
                label={m["image_export.vector_by_walls.marker_index_width"]()}
                value={settings.width}
                onChange={(width) => onChange({ width: Math.round(width) })}
                min={MARKER_INDEX_WIDTH_RANGE.min} max={MARKER_INDEX_WIDTH_RANGE.max} step={1}
                format={(v) => String(Math.round(v))}
                linkTarget={linkTargets.width}
              />
              <LinkedSliderRow
                label={m["image_export.vector_by_walls.marker_index_height"]()}
                value={settings.height}
                onChange={(height) => onChange({ height })}
                min={MARKER_INDEX_MIN_HEIGHT} max={0.5 * TILE_SIZE} step={1}
                format={(v) => String(Math.round(v))}
                linkTarget={linkTargets.height}
              />
              <LinkedSliderRow
                label={m["image_export.vector_by_walls.marker_index_offset"]()}
                value={settings.offset}
                onChange={(offset) => onChange({ offset })}
                min={0} max={0.3 * TILE_SIZE} step={1}
                format={(v) => String(Math.round(v))}
                linkTarget={linkTargets.offset}
              />
              <LinkedSliderRow
                label={m["image_export.vector_by_walls.marker_index_corner_radius"]()}
                value={settings.cornerRadius}
                onChange={(cornerRadius) => onChange({ cornerRadius })}
                min={0} max={0.25 * TILE_SIZE} step={1}
                format={(v) => String(Math.round(v))}
                linkTarget={linkTargets.cornerRadius}
              />
              <LinkedSliderRow
                label={m["image_export.vector_by_walls.marker_index_gap"]()}
                value={settings.gap}
                onChange={(gap) => onChange({ gap: Math.round(gap) })}
                min={0} max={10} step={1}
                format={(v) => String(Math.round(v))}
                linkTarget={linkTargets.gap}
              />
              <LinkedToggleRow
                label={m["image_export.vector_by_walls.marker_index_border_width_from_marker"]()}
                checked={settings.borderWidthFromMarker}
                onChange={(borderWidthFromMarker) => onChange({ borderWidthFromMarker })}
                linkTarget={linkTargets.borderWidthFromMarker}
              />
              <LinkedSliderRow
                label={m["image_export.vector_by_walls.marker_index_border_width"]()}
                value={settings.borderWidth}
                onChange={(borderWidth) => onChange({ borderWidth: Math.round(borderWidth) })}
                min={0} max={10} step={1}
                format={(v) => String(Math.round(v))}
                disabled={settings.borderWidthFromMarker}
                linkTarget={linkTargets.borderWidth}
              />
              <LinkedColorRow
                label={m["image_export.vector_by_walls.marker_index_fill_color"]()}
                color={settings.fillColor}
                onChange={(fillColor) => onChange({ fillColor })}
                priorityColors={fillColorPriority}
                defaultColor={fillColorDefault}
                field={fillColorField}
                linkTarget={linkTargets.fillColor}
              />
              <LinkedToggleRow
                label={m["image_export.vector_by_walls.marker_index_border_color_from_marker"]()}
                checked={settings.borderColorFromMarker}
                onChange={(borderColorFromMarker) => onChange({ borderColorFromMarker })}
                linkTarget={linkTargets.borderColorFromMarker}
              />
              <LinkedColorRow
                label={m["image_export.vector_by_walls.marker_index_border_color"]()}
                color={settings.borderColor}
                onChange={(borderColor) => onChange({ borderColor })}
                disabled={settings.borderColorFromMarker}
                priorityColors={borderColorPriority}
                defaultColor={borderColorDefault}
                field={borderColorField}
                linkTarget={linkTargets.borderColor}
              />
          </SubGroup>
        </>
      )}
    </div>
  );
}

/** One collapsible sub-group: header plus an indented body shown only while `id` is expanded. */
function SubGroup({ id, label, isExpanded, onToggle, children }: {
  id: string;
  label: string;
  isExpanded: (id: string) => boolean;
  onToggle: (id: string) => void;
  children: React.ReactNode;
}) {
  return (
    <div style={styles.subGroupWrap}>
      <SectionHeader label={label} expanded={isExpanded(id)} onToggle={() => onToggle(id)} />
      {isExpanded(id) && <div style={styles.subGroup}>{children}</div>}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  block: { display: "flex", flexDirection: "column", gap: spacing.itemGap, paddingLeft: indent.tree },
  subGroupWrap: { display: "flex", flexDirection: "column", gap: spacing.itemGap },
  subGroup: { display: "flex", flexDirection: "column", gap: spacing.itemGap, paddingLeft: indent.tree },
};
