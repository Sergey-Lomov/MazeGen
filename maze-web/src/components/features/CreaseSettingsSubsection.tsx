import type React from "react";
import type { CreaseExportStyle } from "../../store/imageExportTypes";
import { indent, spacing } from "../../styles/theme";
import { CREASE_LINE_WIDTH_RANGE, CREASE_MARK_SIZE_RANGE, CREASE_MARK_TIP_LENGTH_RANGE } from "../../pixi/renderConstants";
import { SectionHeader } from "../SectionHeader";
import { SelectRow } from "../SelectRow";
import { SliderRow } from "../SliderRow";
import { ToggleRow } from "../ToggleRow";
import { UnregisteredColorRow } from "../ColorRow";
import type { ProjectColorEntry } from "../../pixi/selectors/projectColorsSelector";
import * as m from "~/paraglide/messages";

/** The "Creases" subsection of the "Topology" section (GitHub issue #900): whether the topological crease lines show on
 * the image and how (lines or marks). The parent shows it only for a floor that has creases. Both render modes use it as is. */
export function CreaseSettingsSubsection({ expanded, onToggle, style, defaultColor, priorityColors, onChange }: {
  expanded: boolean;
  onToggle: () => void;
  style: CreaseExportStyle;
  defaultColor: number;
  priorityColors: ProjectColorEntry[];
  onChange: (patch: Partial<CreaseExportStyle>) => void;
}) {
  return (
    <>
      <SectionHeader label={m["image_export.creases.title"]()} expanded={expanded} onToggle={onToggle} />
      {expanded && (
        <div style={styles.block}>
          <ToggleRow label={m["image_export.creases.show"]()} checked={style.showCreases} onChange={(showCreases) => onChange({ showCreases })} />
          {style.showCreases && (
            <SelectRow
              label={m["image_export.creases.mode"]()}
              value={style.mode}
              options={[
                { value: "lines", label: m["image_export.creases.mode_lines"]() },
                { value: "marks", label: m["image_export.creases.mode_marks"]() },
              ]}
              onChange={(mode) => onChange({ mode })}
            />
          )}
          {style.showCreases && style.mode === "lines" && (
            <>
              <SelectRow
                label={m["image_export.creases.line_style"]()}
                value={style.lineStyle}
                options={[
                  { value: "dashed", label: m["image_export.creases.line_style_dashed"]() },
                  { value: "solid", label: m["image_export.creases.line_style_solid"]() },
                ]}
                onChange={(lineStyle) => onChange({ lineStyle })}
              />
              <SliderRow label={m["image_export.creases.line_width"]()} value={style.lineWidth} onChange={(lineWidth) => onChange({ lineWidth })} min={CREASE_LINE_WIDTH_RANGE.min} max={CREASE_LINE_WIDTH_RANGE.max} step={1} format={(v) => String(v)} />
            </>
          )}
          {style.showCreases && style.mode === "marks" && (
            <>
              <SliderRow label={m["image_export.creases.mark_size"]()} value={style.markSize} onChange={(markSize) => onChange({ markSize })} min={CREASE_MARK_SIZE_RANGE.min} max={CREASE_MARK_SIZE_RANGE.max} step={1} format={(v) => String(v)} />
              <SliderRow label={m["image_export.creases.mark_tip_length"]()} value={style.markTipLength} onChange={(markTipLength) => onChange({ markTipLength })} min={CREASE_MARK_TIP_LENGTH_RANGE.min} max={CREASE_MARK_TIP_LENGTH_RANGE.max} step={1} format={(v) => String(v)} />
            </>
          )}
          {style.showCreases && style.mode === "lines" && (
            <UnregisteredColorRow label={m["image_export.creases.color"]()} color={style.color} onChange={(color) => onChange({ color })} defaultColor={defaultColor} priorityColors={priorityColors} />
          )}
          {style.showCreases && style.mode === "marks" && (
            <UnregisteredColorRow label={m["image_export.creases.mark_color"]()} color={style.markColor} onChange={(markColor) => onChange({ markColor })} defaultColor={defaultColor} priorityColors={priorityColors} />
          )}
        </div>
      )}
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  block: { display: "flex", flexDirection: "column", gap: spacing.itemGap, paddingLeft: indent.tree },
};
