import type * as React from "react";
import type { ColorField } from "../../pixi/selectors/projectColorsSelector";
import type { ElevatorBadgeSettings } from "../../store/storeTypes";
import type { ProjectColorEntry } from "../../pixi/selectors/projectColorsSelector";
import { indent, spacing, typography } from "../../styles/theme";
import { LinkedToggleRow, LinkedSelectRow, LinkedSliderRow } from "./LinkedRows";
import { MarkerAppearanceRows, TextStyleRows } from "./MarkerFieldRows";
import * as m from "~/paraglide/messages";

/** "Badges" sub-subsection of the Elevator sub-group (GitHub issue #430) — plain-weight label, not
 *  collapsible, same convention as "Marker"/"Arrow" (`VectorByWallsSettingsPanel`). Independent of
 *  `verticalStyle`: rendered under both the abstract and decorative elevator sub-groups, since a
 *  floor-number badge ring is its own decorative layer on top of whichever elevator look is active
 *  (`VerticalConnectionRenderer.drawElevatorBadges`). `cornerStyle` is "Shared style"-linked
 *  (GitHub issue #430 follow-up, generalized by #643 — its own `"elevatorBadges.cornerStyle"` link,
 *  same as `elevatorMarker.cornerStyle`'s own), so it keeps its own `onCornerStyleChange` handler
 *  instead of going through the plain `onChange` patch used by every other field here. Reads
 *  `links`/`registry`/`onSetLinkEnabled`/`onAddLink` from the nearest `LinkContextProvider` via the
 *  `Linked*Row` wrappers (GitHub issue #652 follow-up) rather than taking them as props. Shared by
 *  both render modes, so `P` is generic over each mode's own `ParamPath` union. */
export function ElevatorBadgesSubsection<P extends string>({ settings, onChange, onCornerStyleChange, linkTargets, fillColorPriority, borderColorPriority, textColorPriority, fillColorDefault, borderColorDefault, textColorDefault, borderColorField, fillColorField, textColorField }: {
  settings: ElevatorBadgeSettings;
  onChange: (patch: Partial<ElevatorBadgeSettings>) => void;
  onCornerStyleChange: (style: ElevatorBadgeSettings["cornerStyle"]) => void;
  /** Per-field link paths (GitHub issue #652 follow-up) for every `Linked*Row` in this subsection. */
  linkTargets: {
    enabled: P | null;
    labelType: P | null;
    textFontWeight: P | null;
    placement: P | null;
    shape: P | null;
    cornerStyle: P | null;
    size: P | null;
    distance: P | null;
    evenDistribution: P | null;
    gap: P | null;
    gapWidth: P | null;
    fillColor: P | null;
    borderColor: P | null;
    borderWidth: P | null;
    textColor: P | null;
    textSize: P | null;
    textMargin: P | null;
  };
  /** "Priority" project colors (GitHub issue #503) for the badge fill / text color rows. */
  fillColorPriority?: ProjectColorEntry[];
  borderColorPriority?: ProjectColorEntry[];
  textColorPriority?: ProjectColorEntry[];
  /** Factory defaults (GitHub issue #503) — pinned as each row's first "Default" project color. */
  fillColorDefault?: number;
  borderColorDefault?: number;
  textColorDefault?: number;
  /** Composite field names (GitHub issue #503) — the rows carry the generic "Fill color" /
   *  "Text color" labels, so an explicit name isolates the row in the "Project colors" list. */
  fillColorField: ColorField;
  borderColorField: ColorField;
  textColorField: ColorField;
}) {
  return (
    <div style={styles.wrap}>
      <div style={typography.body}>{m["image_export.vector_by_walls.elevator_badges"]()}</div>
      <div style={styles.group}>
        <LinkedToggleRow
          label={m["image_export.vector_by_walls.elevator_badges_enabled"]()}
          checked={settings.enabled}
          onChange={(enabled) => onChange({ enabled })}
          linkTarget={linkTargets.enabled}
        />
        {settings.enabled && (
          <>
            <LinkedSelectRow
              label={m["image_export.vector_by_walls.elevator_badges_label_type"]()}
              value={settings.labelType}
              options={[
                { value: "arabic", label: m["image_export.vector_by_walls.elevator_badges_label_type_arabic"]() },
                { value: "roman", label: m["image_export.vector_by_walls.elevator_badges_label_type_roman"]() },
                { value: "letters", label: m["image_export.vector_by_walls.elevator_badges_label_type_letters"]() },
              ]}
              onChange={(labelType) => onChange({ labelType })}
              linkTarget={linkTargets.labelType}
            />
            <LinkedSelectRow
              label={m["image_export.vector_by_walls.elevator_badges_placement"]()}
              value={settings.placement}
              options={[
                { value: "full_circle", label: m["image_export.vector_by_walls.elevator_badges_placement_full_circle"]() },
                { value: "left_right", label: m["image_export.vector_by_walls.elevator_badges_placement_left_right"]() },
                { value: "right_left", label: m["image_export.vector_by_walls.elevator_badges_placement_right_left"]() },
                { value: "top_bottom", label: m["image_export.vector_by_walls.elevator_badges_placement_top_bottom"]() },
                { value: "bottom_top", label: m["image_export.vector_by_walls.elevator_badges_placement_bottom_top"]() },
              ]}
              onChange={(placement) => onChange({ placement })}
              linkTarget={linkTargets.placement}
            />
            <LinkedSliderRow
              label={m["image_export.vector_by_walls.elevator_badges_distance"]()}
              value={settings.distance}
              onChange={(distance) => onChange({ distance })}
              min={0}
              max={30}
              step={1}
              format={(v) => String(v)}
              linkTarget={linkTargets.distance}
            />
            <LinkedToggleRow
              label={m["image_export.vector_by_walls.elevator_badges_even_distribution"]()}
              checked={settings.evenDistribution}
              onChange={(evenDistribution) => onChange({ evenDistribution })}
              linkTarget={linkTargets.evenDistribution}
            />
            <LinkedSliderRow
              label={m["image_export.vector_by_walls.elevator_badges_gap"]()}
              value={settings.gap}
              onChange={(gap) => onChange({ gap })}
              min={0}
              max={20}
              step={1}
              format={(v) => String(v)}
              disabled={settings.placement === "full_circle" && settings.evenDistribution}
              linkTarget={linkTargets.gap}
            />
            <MarkerAppearanceRows
              settings={settings}
              onChange={(patch) => {
                // `cornerStyle` is "Shared style"-linked: its own handler disables that link first.
                const { cornerStyle, ...rest } = patch;
                if (cornerStyle !== undefined) onCornerStyleChange(cornerStyle);
                if (Object.keys(rest).length > 0) onChange(rest);
              }}
              linkTargets={linkTargets}
              priorityColors={{ fillColor: fillColorPriority, borderColor: borderColorPriority }}
              defaultColors={{ fillColor: fillColorDefault, borderColor: borderColorDefault }}
              fields={{ fillColor: fillColorField, borderColor: borderColorField }}
            />
            <TextStyleRows
              settings={settings}
              onChange={onChange}
              linkTargets={linkTargets}
              priorityColors={textColorPriority}
              defaultColor={textColorDefault}
              field={textColorField}
              autoFitKind="elevator"
            />
          </>
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: { display: "flex", flexDirection: "column", gap: spacing.itemGap },
  group: { display: "flex", flexDirection: "column", gap: spacing.itemGap, paddingLeft: indent.tree },
};
