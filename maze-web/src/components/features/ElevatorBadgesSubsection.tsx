import type * as React from "react";
import type { ElevatorBadgeSettings } from "../../store/storeTypes";
import type { ParamLink } from "../../store/parameterLinks";
import type { ProjectColorEntry } from "../../pixi/selectors/projectColorsSelector";
import { indent, spacing, typography } from "../../styles/theme";
import { ToggleRow } from "../ToggleRow";
import { ColorRow } from "../ColorRow";
import { SelectRow } from "../SelectRow";
import { SliderRow } from "../SliderRow";
import { MARKER_SHAPE_OPTIONS } from "./MarkerSettingsGroup";
import { sharedStyleFieldReset } from "./SharedStyleSection";
import * as m from "~/paraglide/messages";

/** "Badges" sub-subsection of the Elevator sub-group (GitHub issue #430) — plain-weight label, not
 *  collapsible, same convention as "Marker"/"Arrow" (`VectorByWallsSettingsPanel`). Independent of
 *  `verticalStyle`: rendered under both the abstract and decorative elevator sub-groups, since a
 *  floor-number badge ring is its own decorative layer on top of whichever elevator look is active
 *  (`VerticalConnectionRenderer.drawElevatorBadges`). `cornerStyle` is "Shared style"-linked
 *  (GitHub issue #430 follow-up, generalized by #643 — its own `"elevatorBadges.cornerStyle"` link,
 *  same as `elevatorMarker.cornerStyle`'s own), so it needs `links`/`cornerStyleTarget` + its own
 *  change handler instead of going through the plain `onChange` patch used by every other field
 *  here. Shared by both render modes, so `P` is generic over each mode's own `ParamPath` union. */
export function ElevatorBadgesSubsection<P extends string>({ settings, links, cornerStyleTarget, onChange, onCornerStyleChange, onResetCornerStyle, fillColorPriority, textColorPriority, fillColorDefault, textColorDefault, fillColorFieldName, textColorFieldName }: {
  settings: ElevatorBadgeSettings;
  links: ParamLink<P>[];
  cornerStyleTarget: P;
  onChange: (patch: Partial<ElevatorBadgeSettings>) => void;
  onCornerStyleChange: (style: ElevatorBadgeSettings["cornerStyle"]) => void;
  onResetCornerStyle: () => void;
  /** "Priority" project colors (GitHub issue #503) for the badge fill / text color rows. */
  fillColorPriority?: ProjectColorEntry[];
  textColorPriority?: ProjectColorEntry[];
  /** Factory defaults (GitHub issue #503) — pinned as each row's first "Default" project color. */
  fillColorDefault?: number;
  textColorDefault?: number;
  /** Composite field names (GitHub issue #503) — the rows carry the generic "Fill color" /
   *  "Text color" labels, so an explicit name isolates the row in the "Project colors" list. */
  fillColorFieldName?: string;
  textColorFieldName?: string;
}) {
  return (
    <div style={styles.wrap}>
      <div style={typography.body}>{m["image_export.vector_by_walls.elevator_badges"]()}</div>
      <div style={styles.group}>
        <ToggleRow
          label={m["image_export.vector_by_walls.elevator_badges_enabled"]()}
          checked={settings.enabled}
          onChange={(enabled) => onChange({ enabled })}
        />
        {settings.enabled && (
          <>
            <SelectRow
              label={m["image_export.vector_by_walls.elevator_badges_label_type"]()}
              value={settings.labelType}
              options={[
                { value: "arabic", label: m["image_export.vector_by_walls.elevator_badges_label_type_arabic"]() },
                { value: "roman", label: m["image_export.vector_by_walls.elevator_badges_label_type_roman"]() },
                { value: "letters", label: m["image_export.vector_by_walls.elevator_badges_label_type_letters"]() },
              ]}
              onChange={(labelType) => onChange({ labelType })}
            />
            <SelectRow
              label={m["image_export.vector_by_walls.elevator_badges_font_weight"]()}
              value={settings.fontWeight}
              options={[
                { value: "regular", label: m["image_export.vector_by_walls.elevator_badges_font_weight_regular"]() },
                { value: "bold", label: m["image_export.vector_by_walls.elevator_badges_font_weight_bold"]() },
              ]}
              onChange={(fontWeight) => onChange({ fontWeight })}
            />
            <SelectRow
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
            />
            <SelectRow
              label={m["image_export.vector_by_walls.elevator_badges_shape"]()}
              value={settings.shape}
              options={MARKER_SHAPE_OPTIONS.map((o) => ({ value: o.value, label: o.label() }))}
              onChange={(shape) => onChange({ shape })}
            />
            <SelectRow
              label={m["image_export.vector_by_walls.marker_corner_style"]()}
              value={settings.cornerStyle}
              options={[
                { value: "miter", label: m["image_export.vector_by_walls.corner_style_sharp"]() },
                { value: "round", label: m["image_export.vector_by_walls.corner_style_round"]() },
              ]}
              onChange={onCornerStyleChange}
              resetButton={sharedStyleFieldReset(links, cornerStyleTarget, onResetCornerStyle)}
            />
            <SliderRow
              label={m["image_export.vector_by_walls.elevator_badges_size"]()}
              value={settings.size}
              onChange={(size) => onChange({ size })}
              min={0.1}
              max={1}
              step={0.05}
              format={(v) => v.toFixed(2)}
            />
            <SliderRow
              label={m["image_export.vector_by_walls.elevator_badges_distance"]()}
              value={settings.distance}
              onChange={(distance) => onChange({ distance })}
              min={0}
              max={30}
              step={1}
              format={(v) => String(v)}
            />
            <ToggleRow
              label={m["image_export.vector_by_walls.elevator_badges_even_distribution"]()}
              checked={settings.evenDistribution}
              onChange={(evenDistribution) => onChange({ evenDistribution })}
            />
            <SliderRow
              label={m["image_export.vector_by_walls.elevator_badges_gap"]()}
              value={settings.gap}
              onChange={(gap) => onChange({ gap })}
              min={0}
              max={20}
              step={1}
              format={(v) => String(v)}
              disabled={settings.placement === "full_circle" && settings.evenDistribution}
            />
            <SliderRow
              label={m["image_export.vector_by_walls.elevator_badges_gap_width"]()}
              value={settings.gapWidth}
              onChange={(gapWidth) => onChange({ gapWidth })}
              min={0}
              max={10}
              step={1}
              format={(v) => String(v)}
            />
            <ColorRow
              label={m["image_export.vector_by_walls.elevator_badges_fill_color"]()}
              color={settings.fillColor}
              onChange={(fillColor) => onChange({ fillColor })}
              priorityColors={fillColorPriority}
              defaultColor={fillColorDefault}
              fieldName={fillColorFieldName}
            />
            <ColorRow
              label={m["image_export.vector_by_walls.elevator_badges_text_color"]()}
              color={settings.textColor}
              onChange={(textColor) => onChange({ textColor })}
              priorityColors={textColorPriority}
              defaultColor={textColorDefault}
              fieldName={textColorFieldName}
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
