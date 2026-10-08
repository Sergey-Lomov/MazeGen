import type * as React from "react";
import type { MarkerSettings } from "../../store/storeTypes";
import type { MarkerShape } from "../../pixi/renderers/types";
import type { ProjectColorEntry } from "../../pixi/selectors/projectColorsSelector";
import { indent, spacing } from "../../styles/theme";
import { SectionHeader, SubsectionHeader } from "../SectionHeader";
import { LinkedSelectRow, LinkedSliderRow, LinkedColorRow, LinkedTextFieldRow, LinkedToggleRow } from "./LinkedRows";
import { TILE_SIZE } from "../../pixi/constants";
import { normalizeMarkerGlyphInput, isValidMarkerGlyph } from "../../pixi/renderers/markerGlyph";
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

/** One "Start"/"Finish" collapsible sub-section of a "Waypoints" section (GitHub issue #296,
 *  upgraded from a plain always-visible sub-group to its own collapsible `SectionHeader` plus two
 *  `SubsectionHeader`s — "Marker" and "Caption" — by GitHub issue #697 follow-up, since the caption
 *  controls would otherwise clutter the marker's own shape/color/border settings). "Marker" holds
 *  shape, corner style, size, fill color, border color, border width and gap width —
 *  `borderWidth: 0` draws no border and `gapWidth: 0` draws no gap, so there is no separate
 *  show-border/show-gap toggle for either. "Caption" (rendered only when the caller passes
 *  `showTextSection`, i.e. start/finish markers — every other `MarkerSettingsGroup` caller, the
 *  three vertical-connection markers, passes `false`) holds the "Show caption" toggle,
 *  text input, font weight and size — the last three stay visible even with the toggle off,
 *  same "value persists while the feature itself is disabled" convention as any other settings
 *  toggle in this codebase, so turning the caption back on restores exactly what was there before.
 *  Shared by `VectorByWallsSettingsPanel` and `VectorByCorridorsSettingsPanel` (GitHub issue
 *  #311) — both modes' waypoint settings mirror each other exactly, only the underlying store
 *  setters differ. Expand state is owned by the caller's own generic `vectorByWalls`/
 *  `vectorByCorridorsSectionsExpanded` store record (`isExpanded`/`toggleSection`), same convention
 *  as every other collapsible section/subsection in these two panels — `sectionId` is this group's
 *  own key prefix (e.g. `"markers_start"`), `${sectionId}_marker`/`${sectionId}_text` the two
 *  subsections'. */
export function MarkerSettingsGroup<P extends string>({ title, sectionId, settings, onChange, linkTargets, priorityColors, defaultColors, fieldNames, isExpanded, onToggle, showTextSection }: {
  title: string;
  /** Required when `title` is set (own collapsible `SectionHeader`/"Marker" subsection need an id
   *  to track). Omitted by the three vertical-connection-marker callers, which pass `title=""` and
   *  render uncollapsible (own `SectionHeader` and "Marker"/"Caption" split skipped entirely — they
   *  already sit inside their own caller-owned collapsible subsection). */
  sectionId?: string;
  settings: MarkerSettings;
  onChange: (patch: Partial<MarkerSettings>) => void;
  /** Whether to render the "Caption" subsection at all — an explicit per-caller choice (GitHub issue
   *  #697 follow-up: previously inferred from `settings.text !== undefined`, which broke
   *  whenever a caller's own default happened to set `text` to anything, even `""`). Pass
   *  `true` only for callers whose `MarkerSettings` actually models a user-facing text (start/
   *  finish); every other caller passes `false`. */
  showTextSection: boolean;
  /** "Priority" project colors (GitHub issue #503) for this group's fill/border/text color
   *  rows — forwarded to the picker's "Project colors" section. Omitted fields render with no
   *  priority. */
  priorityColors?: { fillColor?: ProjectColorEntry[]; borderColor?: ProjectColorEntry[]; textColor?: ProjectColorEntry[] };
  /** Factory defaults (GitHub issue #503) for the fill/border/text color rows — the picker
   *  pins each as the first "Default" row of its priority group. */
  defaultColors?: { fillColor?: number; borderColor?: number; textColor?: number };
  /** Composite field names (GitHub issue #503) for the fill/border/text color rows — shown in
   *  the picker header and used to drop the row itself from the "Project colors" list. Needed here
   *  because two marker groups (start / finish) share the generic "Fill color" row label. */
  fieldNames?: { fillColor?: string; borderColor?: string; textColor?: string };
  /** Per-field link path for this group's `Linked*Row`s (GitHub issue #652 follow-up) — a concrete
   *  path for every field the caller's registry models (the seven "Marker" fields: `shape`/
   *  `cornerStyle`/`size`/`fillColor`/`borderColor`/`borderWidth`/`gapWidth`, plus the four
   *  "Caption" fields `textEnabled`/`textFontWeight`/`textSize`/`textColor`,
   *  GitHub issue #697 second follow-up — `text` itself has no registry entry, free text has
   *  no `ParamType`), or `null` for one it doesn't, rendering `LinkStatusIcon`'s "unsupported" state
   *  there instead of omitting the icon — every field row gets one either way. The four Caption
   *  targets are only meaningful (non-`null`) for callers that also pass `showTextSection`; every
   *  other `MarkerSettingsGroup` caller passes `null` for them, same as it already must for every
   *  other field its registry doesn't model. */
  linkTargets: { shape: P | null; cornerStyle: P | null; size: P | null; fillColor: P | null; borderColor: P | null; borderWidth: P | null; gapWidth: P | null; textEnabled: P | null; textFontWeight: P | null; textSize: P | null; textColor: P | null };
  /** Reads the caller's own generic sections-expanded record by id (GitHub issue #670 follow-up's
   *  `isExpanded`/`toggleSection` convention), scoped under this group's own `sectionId`. */
  isExpanded?: (id: string) => boolean;
  onToggle?: (id: string) => void;
}) {
  const markerId = sectionId ? `${sectionId}_marker` : "";
  const textId = sectionId ? `${sectionId}_text` : "";
  const sectionExpanded = !title || !sectionId || !isExpanded || isExpanded(sectionId);
  const subExpanded = (id: string) => !isExpanded || isExpanded(id);
  const toggle = (id: string) => onToggle?.(id);
  return (
    <div style={styles.markerGroupWrap}>
      {title && sectionId && <SectionHeader label={title} expanded={sectionExpanded} onToggle={() => toggle(sectionId)} />}
      {sectionExpanded && (
        <div style={title ? styles.markerGroup : styles.markerGroupNoIndent}>
          {showTextSection && (
            <>
              <SubsectionHeader label={m["image_export.vector_by_walls.markers_text_subsection"]()} expanded={subExpanded(textId)} onToggle={() => toggle(textId)} />
              {subExpanded(textId) && (
                <div style={styles.subsectionGroup}>
                  <LinkedToggleRow
                    label={m["image_export.vector_by_walls.marker_text_show"]()}
                    checked={settings.textEnabled ?? true}
                    onChange={(textEnabled) => onChange({ textEnabled })}
                    linkTarget={linkTargets.textEnabled}
                  />
                  <LinkedTextFieldRow
                    label={m["image_export.vector_by_walls.marker_text"]()}
                    value={settings.text ?? ""}
                    onChange={(text) => onChange({ text })}
                    normalize={normalizeMarkerGlyphInput}
                    isValid={isValidMarkerGlyph}
                    inputWidth={40}
                    linkTarget={null}
                  />
                  <LinkedSelectRow
                    label={m["image_export.vector_by_walls.marker_text_font_weight"]()}
                    value={settings.textFontWeight ?? "bold"}
                    options={[
                      { value: "regular", label: m["image_export.vector_by_walls.elevator_badges_font_weight_regular"]() },
                      { value: "bold", label: m["image_export.vector_by_walls.elevator_badges_font_weight_bold"]() },
                    ]}
                    onChange={(textFontWeight) => onChange({ textFontWeight })}
                    linkTarget={linkTargets.textFontWeight}
                  />
                  <LinkedColorRow
                    label={m["image_export.vector_by_walls.marker_text_color"]()}
                    color={settings.textColor ?? 0x000000}
                    onChange={(textColor) => onChange({ textColor })}
                    priorityColors={priorityColors?.textColor}
                    defaultColor={defaultColors?.textColor}
                    fieldName={fieldNames?.textColor}
                    linkTarget={linkTargets.textColor}
                  />
                  <LinkedSliderRow
                    label={m["image_export.vector_by_walls.marker_text_size"]()}
                    value={settings.textSize ?? 0.55}
                    onChange={(textSize) => onChange({ textSize })}
                    min={0.15}
                    max={1}
                    step={0.05}
                    format={(v) => v.toFixed(2)}
                    linkTarget={linkTargets.textSize}
                  />
                </div>
              )}
            </>
          )}
          {sectionId && <SubsectionHeader label={m["image_export.vector_by_walls.markers_marker_subsection"]()} expanded={subExpanded(markerId)} onToggle={() => toggle(markerId)} />}
          {subExpanded(markerId) && (
            <div style={sectionId ? styles.subsectionGroup : styles.markerGroupNoIndent}>
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
              <LinkedColorRow label={m["image_export.vector_by_walls.marker_fill_color"]()} color={settings.fillColor} onChange={(fillColor) => onChange({ fillColor })} priorityColors={priorityColors?.fillColor} defaultColor={defaultColors?.fillColor} fieldName={fieldNames?.fillColor} linkTarget={linkTargets.fillColor} />
              <LinkedColorRow label={m["image_export.vector_by_walls.marker_border_color"]()} color={settings.borderColor} onChange={(borderColor) => onChange({ borderColor })} priorityColors={priorityColors?.borderColor} defaultColor={defaultColors?.borderColor} fieldName={fieldNames?.borderColor} linkTarget={linkTargets.borderColor} />
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
          )}
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  markerGroupWrap: { display: "flex", flexDirection: "column", gap: spacing.itemGap },
  markerGroup: { display: "flex", flexDirection: "column", gap: spacing.itemGap, paddingLeft: indent.tree },
  markerGroupNoIndent: { display: "flex", flexDirection: "column", gap: spacing.itemGap },
  subsectionGroup: { display: "flex", flexDirection: "column", gap: spacing.itemGap, paddingLeft: indent.tree },
};
