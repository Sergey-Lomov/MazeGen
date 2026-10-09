import type * as React from "react";
import type { ColorField } from "../../pixi/selectors/projectColorsSelector";
import type { MarkerSettings } from "../../store/storeTypes";
import type { ProjectColorEntry } from "../../pixi/selectors/projectColorsSelector";
import { indent, spacing } from "../../styles/theme";
import { SectionHeader, SubsectionHeader } from "../SectionHeader";
import { LinkedTextFieldRow, LinkedToggleRow } from "./LinkedRows";
import { MarkerAppearanceRows, TextStyleRows } from "./MarkerFieldRows";
import { DEFAULT_MARKER_TEXT_SIZE } from "../../pixi/renderConstants";
import { normalizeMarkerGlyphInput, isValidMarkerGlyph } from "../../pixi/renderers/markerGlyph";
import * as m from "~/paraglide/messages";

export { MARKER_SHAPE_OPTIONS, markerShapeSelectOptions } from "./MarkerFieldRows";

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
export function MarkerSettingsGroup<P extends string>({ title, sectionId, settings, onChange, linkTargets, priorityColors, defaultColors, fields, isExpanded, onToggle, showTextSection, textFitKind }: {
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
  fields: { fillColor: ColorField; borderColor: ColorField; textColor?: ColorField };
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
  /** Which label set this group's text-size "Auto-fit" button fits (GitHub issue #707). */
  textFitKind?: "start" | "finish";
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
          {showTextSection && fields.textColor && (
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
                  <TextStyleRows
                    settings={{
                      textFontWeight: settings.textFontWeight ?? "bold",
                      textColor: settings.textColor ?? 0x000000,
                      textSize: settings.textSize ?? DEFAULT_MARKER_TEXT_SIZE,
                    }}
                    onChange={onChange}
                    linkTargets={{ textFontWeight: linkTargets.textFontWeight, textColor: linkTargets.textColor, textSize: linkTargets.textSize }}
                    priorityColors={priorityColors?.textColor}
                    defaultColor={defaultColors?.textColor}
                    field={fields.textColor}
                    autoFitKind={textFitKind}
                  />
                </div>
              )}
            </>
          )}
          {sectionId && <SubsectionHeader label={m["image_export.vector_by_walls.markers_marker_subsection"]()} expanded={subExpanded(markerId)} onToggle={() => toggle(markerId)} />}
          {subExpanded(markerId) && (
            <div style={sectionId ? styles.subsectionGroup : styles.markerGroupNoIndent}>
              <MarkerAppearanceRows
                settings={settings}
                onChange={onChange}
                linkTargets={linkTargets}
                priorityColors={priorityColors}
                defaultColors={defaultColors}
                fields={fields}
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
